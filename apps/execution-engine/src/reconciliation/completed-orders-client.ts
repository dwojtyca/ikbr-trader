import { IBApi } from "@stoqey/ib";
import type { BrokerOrderRow } from "./broker-adapter.js";

export interface CompletedOrdersSocket {
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  connect(): unknown;
  disconnect(): unknown;
  reqManagedAccts(): unknown;
  reqCompletedOrders(apiOnly: boolean): unknown;
}
export interface CompletedOrdersRequest { accountId: string; timeoutMs: number; abortSignal: AbortSignal }
export type CompletedOrdersResult = { ok: boolean; rows: BrokerOrderRow[]; error?: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const positiveId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const quantity = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;

export class CompletedOrdersClient {
  private queue: Promise<unknown> = Promise.resolve();
  private shutdownUncertain = false;
  constructor(private readonly config: { host: string; port: number; clientId: number },
    private readonly deps: { createSocket?: () => CompletedOrdersSocket; now?: () => Date; shutdownTimeoutMs?: number } = {}) {}

  load(req: CompletedOrdersRequest): Promise<CompletedOrdersResult> {
    const deadline = Date.now() + req.timeoutMs;
    const run = this.queue.then(() => this.read(req, deadline));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private read(req: CompletedOrdersRequest, deadline: number): Promise<CompletedOrdersResult> {
    if (this.shutdownUncertain) return Promise.resolve({ ok: false, rows: [], error: "completed_disconnect_unconfirmed" });
    if (req.abortSignal.aborted) return Promise.resolve({ ok: false, rows: [], error: "aborted" });
    if (Date.now() >= deadline) return Promise.resolve({ ok: false, rows: [], error: "timeout" });
    if (!text(req.accountId) || !Number.isInteger(this.config.clientId) || this.config.clientId <= 0) {
      return Promise.resolve({ ok: false, rows: [], error: "completed_identity_invalid" });
    }
    return new Promise(resolve => {
      const socket = this.deps.createSocket?.() ?? new IBApi(this.config) as unknown as CompletedOrdersSocket;
      const rows = new Map<string, BrokerOrderRow>();
      let done = false, settled = false, disconnected = false, ready = false, requested = false;
      let accounts: string[] | undefined, resultError: string | undefined;
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = () => {
        if (settled) return;
        settled = true; clearTimeout(shutdownTimer);
        socket.removeAllListeners();
        // The SDK can emit an error after net.Socket close. Retain no capture state.
        socket.on("error", () => undefined);
        resolve({ ok: !resultError, rows: resultError ? [] : [...rows.values()], ...(resultError ? { error: resultError } : {}) });
      };
      const finish = (error?: string) => {
        if (done) return;
        done = true; resultError = error;
        clearTimeout(timer); req.abortSignal.removeEventListener("abort", onAbort);
        if (disconnected) { settle(); return; }
        shutdownTimer = setTimeout(() => {
          this.shutdownUncertain = true;
          resultError = "completed_disconnect_unconfirmed";
          settle();
        }, this.deps.shutdownTimeoutMs ?? 1000);
        try { socket.disconnect(); } catch { resultError = "completed_disconnect_failed"; }
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), Math.max(0, deadline - Date.now()));
      req.abortSignal.addEventListener("abort", onAbort, { once: true });
      const listen = (event: string, callback: (...args: unknown[]) => void) => socket.on(event, (...args) => {
        if (done) return;
        try { callback(...args); } catch (error) { finish(error instanceof Error ? error.message : "completed_invalid"); }
      });
      const start = () => {
        if (!ready || !accounts || requested) return;
        requested = true; socket.reqCompletedOrders(false);
      };
      listen("nextValidId", id => {
        if (ready || typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) throw new Error("completed_handshake_invalid");
        ready = true; socket.reqManagedAccts(); start();
      });
      listen("managedAccounts", value => {
        if (!text(value)) throw new Error("completed_account_mismatch");
        const next = value.split(",").map(v => v.trim()).filter(Boolean).sort();
        if (!next.includes(req.accountId) || (accounts && JSON.stringify(accounts) !== JSON.stringify(next))) throw new Error("completed_account_mismatch");
        accounts = next; start();
      });
      listen("completedOrder", (contract, order, state) => {
        if (!requested || !object(contract) || !object(order) || !object(state)
          || !text(order.account) || !accounts?.includes(order.account)
          || !positiveId(contract.conId) || !text(contract.symbol) || !text(contract.secType)
          || !text(contract.currency) || !positiveId(order.permId)
          || !["BUY", "SELL"].includes(String(order.action))
          || !quantity(order.totalQuantity) || !quantity(order.filledQuantity)
          || !text(state.status)
          || !["Filled", "Cancelled", "ApiCancelled", "Inactive"].includes(state.status)
          || !text(state.completedStatus)
          || !(state.status === "Filled" && order.totalQuantity === 0 && order.filledQuantity > 0)
            && (order.totalQuantity <= 0 || order.filledQuantity > order.totalQuantity
              || (state.status === "Filled" && order.filledQuantity !== order.totalQuantity))
          || (order.orderRef !== undefined && typeof order.orderRef !== "string")) throw new Error("completed_record_invalid");
        if (order.account !== req.accountId) return;
        const row: BrokerOrderRow = {
          accountId: order.account, brokerOrderId: null, clientId: null,
          permId: String(order.permId), parentPermId: positiveId(order.parentPermId) ? String(order.parentPermId) : null,
          orderRef: typeof order.orderRef === "string" && order.orderRef ? order.orderRef : null,
          symbol: contract.symbol, conId: String(contract.conId), secType: contract.secType,
          exchange: text(contract.exchange) ? contract.exchange : null, currency: contract.currency,
          status: state.status, terminalStatus: state.completedStatus, action: String(order.action),
          filled: order.filledQuantity, remaining: state.status === "Filled" ? 0 : order.totalQuantity - order.filledQuantity,
          observedAt: this.deps.now?.() ?? new Date(),
        };
        const key = `${row.accountId}:${row.permId}`;
        const previous = rows.get(key);
        if (previous && JSON.stringify({ ...previous, observedAt: null }) !== JSON.stringify({ ...row, observedAt: null })) throw new Error("completed_conflicting_duplicate");
        if (!previous) rows.set(key, row);
      });
      listen("completedOrdersEnd", () => {
        if (!requested) throw new Error("completed_unrequested_end");
        finish();
      });
      socket.on("disconnected", () => {
        disconnected = true;
        if (done) settle(); else finish("completed_disconnected");
      });
      socket.on("error", (_error, code) => {
        if ([2104, 2106, 2107, 2108, 2158].includes(Number(code))) return;
        if (done) resultError ??= `completed_shutdown_error:${String(code)}`;
        else finish(`completed_broker_error:${String(code)}`);
      });
      try { socket.connect(); } catch { finish("completed_connect_failed"); }
    });
  }
}
