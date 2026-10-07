import { IBApi } from "@stoqey/ib";
import { parseIbExecutionTime } from "../execution-time.js";
import { accountingError, accountingNumber, type CanonicalExecution, type CanonicalCommission, type SourceSettingsV1 } from "./types.js";

export interface AccountingSocket {
  readonly serverVersion: number;
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  connect(): unknown; disconnect(): unknown; reqManagedAccts(): unknown; reqCurrentTime(): unknown;
  reqExecutions(requestId: number, filter: { clientId: number; acctCode: string; time: string; symbol: string; secType: string; exchange: string; side: string }): unknown;
}
export type CollectorObservation = { kind: "execution"; value: CanonicalExecution; raw: unknown; requestId: number }
  | { kind: "commission"; value: CanonicalCommission; raw: unknown }
  | { kind: "handshake" | "managed_accounts" | "clock" | "clock_rejected" | "replay_start" | "replay_end"; value: unknown; requestId?: number };
const obj = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== "object" || Array.isArray(v)) throw accountingError("IDENTITY_INVALID"); return v as Record<string, unknown>; };
const str = (v: unknown): string => { if (typeof v !== "string" || !v.trim() || v.length > 200) throw accountingError("IDENTITY_INVALID"); return v.trim(); };
const id = (v: unknown): string => { if (!Number.isSafeInteger(Number(v)) || Number(v) < 0) throw accountingError("IDENTITY_INVALID"); return String(v); };
export function normalizeAccountingExecution(contract: unknown, execution: unknown, settings: SourceSettingsV1): CanonicalExecution {
  const c = obj(contract), e = obj(execution);
  const when = parseIbExecutionTime(str(e.time), settings.executionTimeZone);
  const side = e.side === "BOT" || e.side === "BUY" ? "BUY" : e.side === "SLD" || e.side === "SELL" ? "SELL" : null;
  if (!when) throw accountingError("TIMESTAMP_INVALID");
  if (!Number.isSafeInteger(e.orderId)) throw accountingError("IDENTITY_INVALID");
  if (e.acctNumber !== settings.accountId || !side || !accountingNumber(e.shares) || e.shares <= 0 || !accountingNumber(e.price) || e.price <= 0
    || Number(c.conId) <= 0 || e.pendingPriceRevision !== undefined && typeof e.pendingPriceRevision !== "boolean") throw accountingError("IDENTITY_INVALID");
  return { execId: str(e.execId), accountId: settings.accountId, brokerOrderId: String(e.orderId), conId: id(c.conId), symbol: str(c.symbol),
    secType: str(c.secType), currency: str(c.currency), exchange: str(e.exchange ?? c.exchange), side, shares: e.shares, price: e.price,
    executedAt: when.toISOString(), ...(e.permId === undefined ? {} : { permId: id(e.permId) }),
    ...(typeof e.orderRef === "string" ? { orderRef: e.orderRef } : {}), ...(Number.isSafeInteger(e.clientId) ? { clientId: Number(e.clientId) } : {}), ...(e.pendingPriceRevision === true ? { pendingPriceRevision: true } : {}) };
}
export function normalizeAccountingCommission(value: unknown): CanonicalCommission {
  const r = obj(value);
  return { execId: str(r.execId), currency: str(r.currency), commission: accountingNumber(r.commission) ? r.commission : null,
    realizedPnL: accountingNumber(r.realizedPNL) ? r.realizedPNL : null };
}
export class AccountingSourceCollector {
  private socket: AccountingSocket | undefined;
  private readonly socketFactory: () => AccountingSocket;
  private readonly usedSockets = new WeakSet<AccountingSocket>();
  private ready = false; private upstream = true; private connecting = false;
  private accounts: string[] = []; private protocol = 0; private generation = 0; private requestId = 0;
  private waiters = new Set<() => void>();
  private clockRequestedAt: string | undefined;
  private active: { requestId: number; executionIds: Set<string>; ended: boolean; brokerTime?: number; clockWaiting: boolean; clockRequestedAt?: string; error?: Error } | undefined;
  constructor(readonly settings: SourceSettingsV1, private readonly callbacks: {
    observe: (value: CollectorObservation) => void; gap: (generation: number, code?: string) => void;
  }, socketFactory?: () => AccountingSocket) {
    this.socketFactory = socketFactory ?? (() => new IBApi({ ...settings.endpoint, clientId: 0 }) as unknown as AccountingSocket);
  }
  private bindSocket(socket: AccountingSocket, generation: number): void {
    const settings = this.settings;
    const listen = (event: string, fn: (...args: unknown[]) => void) => socket.on(event, (...args) => {
      if (this.socket !== socket || this.generation !== generation) return;
      try { fn(...args); } catch (error) {
        const failure = error instanceof Error && error.message.startsWith("ACCOUNTING_") ? error : accountingError("IDENTITY_INVALID");
        if (this.active) this.active.error ??= failure;
        this.callbacks.gap(generation, failure.message);
      }
      this.notify();
    });
    listen("server", (version, connectionTime) => {
      if (!Number.isSafeInteger(version) || Number(version) <= 0) throw accountingError("IDENTITY_INVALID");
      this.protocol = Number(version); this.callbacks.observe({ kind: "handshake", value: { protocolVersion: version, connectionTime } });
    });
    listen("nextValidId", () => { this.ready = true; this.connecting = false; this.protocol ||= socket.serverVersion; socket.reqManagedAccts(); });
    listen("managedAccounts", value => {
      const accounts = str(value).split(",").map(v => v.trim()).filter(Boolean).sort();
      if (!accounts.includes(settings.accountId) || this.accounts.length && JSON.stringify(accounts) !== JSON.stringify(this.accounts)) throw accountingError("IDENTITY_INVALID");
      this.accounts = accounts; this.callbacks.observe({ kind: "managed_accounts", value: accounts });
    });
    listen("execDetails", (requestId, contract, execution) => {
      const value = normalizeAccountingExecution(contract, execution, settings);
      this.callbacks.observe({ kind: "execution", value, raw: { contract, execution }, requestId: Number(requestId) });
      const active = this.active;
      if (active && active.requestId === requestId) active.executionIds.add(value.execId);
    });
    listen("commissionReport", report => this.callbacks.observe({ kind: "commission", value: normalizeAccountingCommission(report), raw: report }));
    listen("execDetailsEnd", requestId => {
      const active = this.active;
      if (!active || active.requestId !== requestId) return;
      this.callbacks.observe({ kind: "replay_end", value: { requestId }, requestId: Number(requestId) }); active.ended = true;
    });
    listen("currentTime", seconds => {
      if (!this.clockRequestedAt || this.active?.error) return;
      const received = Date.now(), milliseconds = typeof seconds === "number" ? seconds * 1000 : NaN;
      if (!Number.isSafeInteger(seconds) || !Number.isFinite(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime()) || Math.abs(received - milliseconds) > 2000) {
        if (this.active) this.active.clockWaiting = false;
        this.callbacks.observe({ kind: "clock_rejected", requestId: this.active?.requestId, value: {
          receivedAt: new Date(received).toISOString(), requestedAt: this.clockRequestedAt,
          reportedKind: seconds === null ? "null" : typeof seconds,
          reportedSeconds: ["number", "string", "boolean", "bigint"].includes(typeof seconds) ? String(seconds).slice(0, 80) : "[non-scalar]",
          ...(Number.isFinite(milliseconds) ? { skewMs: received - milliseconds } : {}),
        } });
        throw accountingError("CLOCK_INVALID");
      }
      if (!this.active?.clockWaiting) return;
      this.active.brokerTime = milliseconds; this.active.clockWaiting = false;
      this.callbacks.observe({ kind: "clock", value: { brokerTime: new Date(milliseconds).toISOString() }, requestId: this.active.requestId });
    });
    listen("disconnected", () => { this.ready = false; this.connecting = false; this.accounts = []; if (this.active) this.active.error ??= accountingError("SOURCE_GAP"); this.callbacks.gap(this.generation); });
    listen("error", (_error, code) => {
      if ([2104, 2106, 2107, 2108, 2158].includes(Number(code))) return;
      if (Number(code) === 1100) this.upstream = false;
      if ([1101, 1102].includes(Number(code))) this.upstream = true;
      this.callbacks.gap(this.generation);
    });
  }
  private notify() { for (const wake of this.waiters) wake(); }
  identity() { return { generation: this.generation, protocolVersion: this.protocol, accounts: [...this.accounts], ready: this.ready && this.upstream && this.accounts.includes(this.settings.accountId) }; }
  connect() {
    if (this.ready || this.connecting) return;
    const old = this.socket; this.socket = undefined; old?.disconnect();
    const socket = this.socketFactory();
    if (this.usedSockets.has(socket)) throw accountingError("SOCKET_REUSED");
    this.usedSockets.add(socket); this.socket = socket;
    this.generation++; this.clockRequestedAt = undefined; this.connecting = true; this.protocol = 0; this.accounts = []; this.upstream = true;
    this.bindSocket(socket, this.generation); this.callbacks.gap(this.generation);
    try { socket.connect(); } catch { this.connecting = false; this.callbacks.gap(this.generation); }
  }
  close() {
    const socket = this.socket; this.socket = undefined;
    this.ready = false; this.connecting = false; this.accounts = [];
    if (this.active) this.active.error ??= accountingError("SOURCE_GAP");
    this.callbacks.gap(this.generation); socket?.disconnect(); this.notify();
  }
  private wait(predicate: () => boolean, deadline: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.waiters.delete(check); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
      const check = () => { if (this.active?.error) finish(this.active.error); else if (predicate()) finish(); };
      const abort = () => finish(accountingError("REPLAY_INCOMPLETE"));
      const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
      this.waiters.add(check); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }
  async replay(timeoutMs: number, signal: AbortSignal): Promise<{ requestId: number; brokerTime: string; executionIds: string[]; generation: number }> {
    if (this.active) throw accountingError("SOURCE_BUSY");
    const deadline = Date.now() + Math.min(10_000, timeoutMs);
    this.active = { requestId: ++this.requestId, executionIds: new Set(), ended: false, clockWaiting: false };
    const active = this.active;
    try {
      this.connect(); await this.wait(() => this.identity().ready, deadline, signal);
      const generation = this.generation;
      if (!Number.isSafeInteger(this.protocol) || this.protocol <= 0) throw accountingError("IDENTITY_INVALID");
      active.clockRequestedAt = new Date().toISOString(); this.clockRequestedAt = active.clockRequestedAt; active.clockWaiting = true;
      this.socket!.reqCurrentTime(); await this.wait(() => active.brokerTime !== undefined, deadline, signal);
      this.callbacks.observe({ kind: "replay_start", value: { requestId: active.requestId }, requestId: active.requestId });
      this.socket!.reqExecutions(active.requestId, { clientId: 0, acctCode: this.settings.accountId, time: "", symbol: "", secType: "", exchange: "", side: "" });
      await this.wait(() => active.ended, deadline, signal);
      if (!this.identity().ready || generation !== this.generation) throw accountingError("SOURCE_GAP");
      return { requestId: active.requestId, brokerTime: new Date(active.brokerTime!).toISOString(), executionIds: [...active.executionIds], generation };
    } catch (error) {
      // A clock response has no request id: abandon this connection after an incomplete read.
      this.close(); throw error;
    } finally { this.active = undefined; }
  }
}
