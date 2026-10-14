import { IBApi } from "@stoqey/ib";
import { performance } from 'node:perf_hooks';
import type { BrokerOrderRow } from "./broker-adapter.js";
import { emitBrokerPhase, type BrokerPhaseDiagnostics, type BrokerPhaseEvent } from './phase-diagnostics.js';

export interface CompletedOrdersSocket {
  on(event: string, callback: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  connect(): unknown;
  disconnect(): unknown;
  reqManagedAccts(): unknown;
  reqCompletedOrders(apiOnly: boolean): unknown;
}
export interface CompletedOrdersRequest { accountId: string; timeoutMs: number; abortSignal: AbortSignal; runId?: number | string }
export type CompletedOrdersResult = { ok: boolean; rows: BrokerOrderRow[]; error?: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const positiveId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const quantity = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
interface CaptureTrace { captureId: number; enqueuedAt: number; readAt: number; stage: string; readRecorded: boolean }

export class CompletedOrdersClient {
  private queue: Promise<unknown> = Promise.resolve();
  private shutdownUncertain = false;
  private captureSequence = 0;
  constructor(private readonly config: { host: string; port: number; clientId: number },
    private readonly deps: { createSocket?: () => CompletedOrdersSocket; now?: () => Date; shutdownTimeoutMs?: number; diagnostics?: BrokerPhaseDiagnostics } = {}) {}

  private diagnose(req: CompletedOrdersRequest, trace: CaptureTrace, phase: string, outcome: BrokerPhaseEvent['outcome'],
    reason: string, startedAt: number, error?: unknown, code?: unknown): void {
    try {
      const cause = typeof error === 'string' ? { message: error, code } : code === undefined ? error
        : { name: object(error) ? error.name : undefined, message: object(error) ? error.message : undefined, code };
      const diagnostics = this.deps.diagnostics;
      emitBrokerPhase(diagnostics && { emit: event => diagnostics.emit(event), privacy: () => {
        const privacy = diagnostics.privacy?.() ?? {};
        return { ...privacy, secrets: [...(privacy.secrets ?? []), this.config.host], accountIds: [...(privacy.accountIds ?? []), req.accountId] };
      } }, `completed.${phase}`, outcome,
        { runId: req.runId, captureId: trace.captureId, reason }, Math.max(0, performance.now() - startedAt), cause);
    } catch { /* Diagnostic data cannot change source results or cleanup. */ }
  }

  load(req: CompletedOrdersRequest): Promise<CompletedOrdersResult> {
    const deadline = Date.now() + req.timeoutMs;
    const trace: CaptureTrace = { captureId: ++this.captureSequence, enqueuedAt: performance.now(), readAt: 0, stage: 'waiting_queue', readRecorded: false };
    this.diagnose(req, trace, 'enqueue', 'milestone', trace.stage, trace.enqueuedAt);
    const run = this.queue.then(() => {
      trace.readAt = performance.now();
      this.diagnose(req, trace, 'queue', 'milestone', 'dequeued', trace.enqueuedAt);
      return this.read(req, deadline, trace);
    }).catch(error => {
      if (!trace.readRecorded) this.diagnose(req, trace, 'read', 'error', `rejected:${trace.stage}`, trace.readAt, error);
      this.diagnose(req, trace, 'settlement', 'error', `rejected:${trace.stage}`, trace.enqueuedAt, error);
      throw error;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private read(req: CompletedOrdersRequest, deadline: number, trace: CaptureTrace): Promise<CompletedOrdersResult> {
    const unavailable = (error: string, stage: string) => {
      trace.stage = stage; trace.readRecorded = true;
      this.diagnose(req, trace, 'read', 'error', `${error}:${stage}`, trace.readAt);
      this.diagnose(req, trace, 'settlement', 'error', `${error}:${stage}`, trace.enqueuedAt);
      return Promise.resolve({ ok: false, rows: [], error });
    };
    if (this.shutdownUncertain) return unavailable('completed_disconnect_unconfirmed', 'shutdown_fenced');
    if (req.abortSignal.aborted) return unavailable('aborted', 'waiting_queue');
    if (Date.now() >= deadline) return unavailable('timeout', 'waiting_queue');
    if (!text(req.accountId) || !Number.isInteger(this.config.clientId) || this.config.clientId <= 0) {
      return unavailable('completed_identity_invalid', 'identity_validation');
    }
    return new Promise(resolve => {
      trace.stage = 'socket_factory';
      const socket = this.deps.createSocket?.() ?? new IBApi(this.config) as unknown as CompletedOrdersSocket;
      trace.stage = 'listener_setup';
      const rows = new Map<string, BrokerOrderRow>();
      let done = false, settled = false, disconnected = false, ready = false, requested = false;
      let accounts: string[] | undefined, resultError: string | undefined;
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      let writeObserved = false, firstIngress = false, firstRow = false, managedObserved = false, endObserved = false;
      let shutdownAt: number | undefined, shutdownFailed = false, shutdownErrorRecorded = false;
      const waitingStage = () => !ready ? 'waiting_next_valid_id' : !accounts ? 'waiting_managed_accounts'
        : !requested ? 'waiting_completed_request' : firstRow ? 'waiting_completed_end'
          : !writeObserved ? 'request_write_unobserved' : 'waiting_first_completed_response';
      const shutdownError = (reason: string, cause?: unknown, code?: unknown) => {
        shutdownFailed = true;
        if (shutdownErrorRecorded) return;
        shutdownErrorRecorded = true;
        this.diagnose(req, trace, 'shutdown_error', 'error', `${reason}:waiting_disconnect_confirmation`, shutdownAt ?? trace.readAt, cause, code);
      };
      const settle = () => {
        if (settled) return;
        settled = true; clearTimeout(shutdownTimer);
        socket.removeAllListeners();
        // The SDK can emit an error after net.Socket close. Retain no capture state.
        socket.on("error", () => undefined);
        this.diagnose(req, trace, 'shutdown', shutdownFailed ? 'error' : 'ok', disconnected ? 'disconnect_confirmed' : 'disconnect_unconfirmed', shutdownAt ?? performance.now());
        this.diagnose(req, trace, 'settlement', resultError ? 'error' : 'ok', `${resultError ?? 'complete'}:${trace.stage}`, trace.enqueuedAt);
        resolve({ ok: !resultError, rows: resultError ? [] : [...rows.values()], ...(resultError ? { error: resultError } : {}) });
      };
      const finish = (error?: string, cause?: unknown, code?: unknown) => {
        if (done) return;
        done = true; resultError = error;
        clearTimeout(timer); req.abortSignal.removeEventListener("abort", onAbort);
        trace.stage = endObserved ? 'completed_end_observed' : waitingStage(); trace.readRecorded = true;
        if (endObserved) this.diagnose(req, trace, 'end', 'milestone', 'decoded_end', trace.readAt);
        if (disconnected) this.diagnose(req, trace, 'disconnected', 'milestone', 'disconnect_confirmed', shutdownAt ?? trace.readAt);
        if (requested && !writeObserved) this.diagnose(req, trace, 'request_write_unobserved', 'milestone', 'local_socket_write_unobserved', trace.readAt);
        this.diagnose(req, trace, 'read', error ? 'error' : 'ok', `${error ?? 'complete'}:${trace.stage}`, trace.readAt, cause, code);
        if (disconnected) { settle(); return; }
        shutdownAt = performance.now(); trace.stage = 'waiting_disconnect_confirmation';
        shutdownTimer = setTimeout(() => {
          this.shutdownUncertain = true;
          resultError = "completed_disconnect_unconfirmed";
          shutdownFailed = true;
          settle();
        }, this.deps.shutdownTimeoutMs ?? 1000);
        this.diagnose(req, trace, 'disconnect_requested', 'milestone', trace.stage, shutdownAt);
        if (settled) return;
        try { socket.disconnect(); } catch (cause) { resultError = "completed_disconnect_failed"; shutdownError(resultError, cause); }
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), Math.max(0, deadline - Date.now()));
      req.abortSignal.addEventListener("abort", onAbort, { once: true });
      const listen = (event: string, callback: (...args: unknown[]) => void) => socket.on(event, (...args) => {
        if (done) return;
        try { callback(...args); } catch (error) { finish(error instanceof Error ? error.message : "completed_invalid", error); }
      });
      const start = () => {
        if (done || !ready || !accounts || requested) return;
        requested = true;
        this.diagnose(req, trace, 'request_called', 'milestone', 'request_write_unobserved', trace.readAt);
        if (done) return;
        socket.reqCompletedOrders(false);
      };
      listen("nextValidId", id => {
        if (ready || typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) throw new Error("completed_handshake_invalid");
        ready = true;
        this.diagnose(req, trace, 'next_valid_id', 'milestone', 'validated', trace.readAt);
        if (done) return;
        this.diagnose(req, trace, 'managed_accounts_requested', 'milestone', 'waiting_managed_accounts', trace.readAt);
        if (done) return;
        socket.reqManagedAccts(); start();
      });
      listen("managedAccounts", value => {
        if (!text(value)) throw new Error("completed_account_mismatch");
        const next = value.split(",").map(v => v.trim()).filter(Boolean).sort();
        if (!next.includes(req.accountId) || (accounts && JSON.stringify(accounts) !== JSON.stringify(next))) throw new Error("completed_account_mismatch");
        accounts = next;
        if (!managedObserved) { managedObserved = true; this.diagnose(req, trace, 'managed_accounts', 'milestone', 'validated', trace.readAt); }
        start();
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
        if (!firstRow) { firstRow = true; this.diagnose(req, trace, 'first_validated_row', 'milestone', 'decoded_row_validated', trace.readAt); }
        if (done) return;
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
        endObserved = true;
        finish();
      });
      socket.on("disconnected", () => {
        if (settled) return;
        disconnected = true;
        if (done) {
          trace.stage = 'disconnect_confirmed';
          this.diagnose(req, trace, 'disconnected', 'milestone', 'disconnect_confirmed', shutdownAt ?? trace.readAt);
          settle();
        } else finish("completed_disconnected");
      });
      socket.on("error", (error, code) => {
        if ([2104, 2106, 2107, 2108, 2158].includes(Number(code))) return;
        if (done) { resultError ??= `completed_shutdown_error:${String(code)}`; shutdownError(`completed_shutdown_error:${String(code)}`, error, code); }
        else finish(`completed_broker_error:${String(code)}`, error, code);
      });
      socket.on('sent', tokens => {
        if (done || writeObserved || !requested) return;
        try {
          if (!Array.isArray(tokens) || tokens[0] !== 99 && tokens[0] !== '99') return;
          writeObserved = true;
          this.diagnose(req, trace, 'request_write', 'milestone', 'local_socket_write_attempt', trace.readAt);
        } catch { /* Raw transport metadata is never evidence or an error source. */ }
      });
      socket.on('received', () => {
        if (done || firstIngress) return;
        firstIngress = true;
        this.diagnose(req, trace, 'first_ingress', 'milestone', 'socket_ingress_only', trace.readAt);
      });
      trace.stage = 'connect_called';
      this.diagnose(req, trace, 'connect_called', 'milestone', 'waiting_next_valid_id', trace.readAt);
      if (done) return;
      try { socket.connect(); } catch (error) { finish("completed_connect_failed", error); }
    });
  }
}
