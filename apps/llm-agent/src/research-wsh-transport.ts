import { randomUUID } from "node:crypto";
import { type DiagnosticPrivacy } from "@ikbr/shared/diagnostics";
import { captureResearchSourceError, sanitizeResearchProviderError, type ResearchProviderError, type ResearchSourceError, type WshCleanupResult } from "@ikbr/shared/instrument-research";
import { IBApi } from "@stoqey/ib";
import { inspectWshRequest } from "./research-wsh-inspection.js";

export interface WshEventRequest {
  conId: number; filter: ""; fillWatchlist: false; fillPortfolio: false; fillCompetitors: false;
  startDate: string; endDate: string; totalLimit: 100;
}
export interface WshSocket {
  readonly serverVersion: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  connect(clientId: number): unknown;
  disconnect(): unknown;
  reqCancelWshMetaData(requestId: number): unknown;
  reqCancelWshEventData(requestId: number): unknown;
  reqWshMetaData(requestId: number): unknown;
  reqWshEventData(requestId: number, request: WshEventRequest): unknown;
  localSocket?(): WshLocalSocket | null;
}
export interface WshLocalSocket {
  readonly closed: boolean;
  readonly destroyed: boolean;
  once(event: "close", listener: () => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
  destroy(): unknown;
}
export function adaptWshSdkSocket(api: IBApi): WshSocket {
  // Pinned @stoqey/ib 1.6.10: public disconnected also means peer end.
  const internals = api as unknown as { controller: { socket: { client?: WshLocalSocket } } };
  return Object.assign(api, { localSocket: () => internals.controller.socket.client ?? null }) as unknown as WshSocket;
}
export interface WshRuntimeConfiguration { enabled: boolean; endpointId: string; host: string; port: number; clientId: number }
export function loadWshRuntimeConfiguration(env: Readonly<Record<string, string | undefined>>): WshRuntimeConfiguration {
  const enabled = env.RESEARCH_WSH_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new Error("RESEARCH_WSH_RUNTIME_INVALID");
  if (enabled === "false") return { enabled: false, endpointId: "", host: "127.0.0.1", port: 7497, clientId: 0 };
  const endpointId = env.RESEARCH_WSH_ENDPOINT_ID ?? "", host = env.RESEARCH_WSH_HOST?.trim() || env.IB_SOCKET_HOST || "127.0.0.1";
  const port = Number(env.RESEARCH_WSH_PORT?.trim() || env.IB_SOCKET_PORT), clientId = Number(env.RESEARCH_WSH_CLIENT_ID);
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(endpointId) || !host || host.length > 253 || /[\s/]/.test(host) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(clientId) || clientId < 1 || clientId > 2147483647)
    throw new Error("RESEARCH_WSH_RUNTIME_INVALID");
  return { enabled: true, endpointId, host, port, clientId };
}
export interface WshTransport {
  readonly sessionId: string;
  readonly serverVersion: number;
  readonly sdkVersion: string;
  connect(deadlineAt: string): Promise<void>;
  metadata(requestId: number, deadlineAt: string, maximumBytes: number): Promise<string>;
  events(requestId: number, request: WshEventRequest, deadlineAt: string, maximumBytes: number): Promise<string>;
  close(): Promise<WshCleanupResult>;
}
export function wshProviderError(error: unknown, code: unknown, privacy: DiagnosticPrivacy = {}): Error & { providerError?: ResearchProviderError; sourceError?: ResearchSourceError } {
  const number = typeof code === "number" && Number.isSafeInteger(code) ? code : null;
  const result = new Error(`RESEARCH_WSH_ERROR_${number ?? "UNKNOWN"}`);
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  return text === null ? result : Object.assign(result, {
    providerError: sanitizeResearchProviderError(number, text, privacy),
    sourceError: captureResearchSourceError(error, privacy),
  });
}
const INFO_CODES = new Set([2104, 2106, 2107, 2108, 2158]);

export class WshSocketTransport implements WshTransport {
  readonly sessionId = randomUUID();
  readonly sdkVersion = "1.6.10";
  private readonly socket: WshSocket;
  private closed = false;
  private terminalError: Error | null = null;
  private connected = false;
  private pending: ((error: Error) => void) | null = null;
  private metadataReady = false;
  private readonly usedRequestIds = new Set<number>();
  private readonly owned = new Map<number, string>();
  private closing: Promise<WshCleanupResult> | null = null;
  private local: WshLocalSocket | null = null;
  private localInspected = false;
  private localUncertain = false;
  private localIdentityUncertain = false;
  private localClosedAt: string | null = null;
  private closeObserved: (() => void) | null = null;
  private readonly localClosed = () => { this.localClosedAt ??= new Date().toISOString(); this.closeObserved?.(); };
  private readonly aborted = () => { void this.closeWith(new Error("RESEARCH_WSH_ABORTED")); };
  private readonly disconnected = () => { void this.closeWith(new Error("RESEARCH_WSH_DISCONNECTED")); };
  private readonly errored = (_error: unknown, code: number, requestId: number) => {
    if (this.closed || INFO_CODES.has(code)) return;
    if (requestId === -1 || requestId === undefined) void this.closeWith(wshProviderError(_error, code, this.privacy));
  };
  constructor(private readonly options: WshRuntimeConfiguration & { accountId: string; signal?: AbortSignal; secrets?: readonly string[] }, factory?: () => WshSocket) {
    this.socket = factory ? factory() : adaptWshSdkSocket(new IBApi({ host: options.host, port: options.port }));
    this.socket.on("disconnected", this.disconnected);
    this.socket.on("error", this.errored);
    options.signal?.addEventListener("abort", this.aborted, { once: true });
    if (options.signal?.aborted) this.aborted();
  }
  private get privacy(): DiagnosticPrivacy { return { accountIds: [this.options.accountId], secrets: this.options.secrets }; }
  get serverVersion(): number { return this.socket.serverVersion; }
  private inspectLocal(): void {
    try {
      if (!this.socket.localSocket) { this.localUncertain = true; this.localIdentityUncertain = true; return; }
      const local = this.socket.localSocket();
      this.localInspected = true;
      if (this.local && this.local !== local) { this.localUncertain = true; this.localIdentityUncertain = true; return; }
      if (local && !this.local) {
        if (typeof local.closed !== "boolean" || typeof local.destroyed !== "boolean" || typeof local.once !== "function"
          || typeof local.removeListener !== "function" || typeof local.destroy !== "function") { this.localUncertain = true; this.localIdentityUncertain = true; return; }
        this.local = local; local.once("close", this.localClosed);
      }
      if (local?.closed) this.localClosed();
    } catch { this.localUncertain = true; this.localIdentityUncertain = true; }
  }

  async connect(deadlineAt: string): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (!this.options.enabled || this.closed || this.connected || this.pending) throw new Error("RESEARCH_WSH_TRANSPORT_UNAVAILABLE");
    let nextIdSeen = false, accountSeen = false;
    await this.bounded(deadlineAt, 'connect', (resolve, reject) => {
      const ready = () => {
        if (!nextIdSeen || !accountSeen) return;
        if (!Number.isInteger(this.serverVersion) || this.serverVersion < 173) reject(new Error("RESEARCH_WSH_PROTOCOL_UNSUPPORTED"));
        else { this.connected = true; resolve(""); }
      };
      const next = () => { nextIdSeen = true; ready(); };
      const accounts = (csv: unknown) => {
        if (typeof csv !== "string" || !csv.split(",").map(value => value.trim()).includes(this.options.accountId)) {
          reject(new Error("RESEARCH_WSH_ACCOUNT_MISMATCH")); return;
        }
        accountSeen = true; ready();
      };
      this.socket.on("nextValidId", next); this.socket.on("managedAccounts", accounts);
      const cleanup = () => { this.socket.removeListener("nextValidId", next); this.socket.removeListener("managedAccounts", accounts); };
      try { this.socket.connect(this.options.clientId); } catch (error) { cleanup(); throw Object.assign(new Error("RESEARCH_WSH_CONNECT_FAILED"), { providerError: wshProviderError(error, null, this.privacy).providerError, sourceError: captureResearchSourceError(error, this.privacy) }); }
      finally { this.inspectLocal(); }
      return cleanup;
    });
  }

  async metadata(requestId: number, deadlineAt: string, maximumBytes: number): Promise<string> {
    if (this.terminalError) throw this.terminalError;
    if (this.metadataReady) throw new Error("RESEARCH_WSH_METADATA_ALREADY_RECEIVED");
    const result = await this.query("wshMetaData", requestId, deadlineAt, maximumBytes, () => this.socket.reqWshMetaData(requestId));
    this.metadataReady = true;
    return result;
  }
  events(requestId: number, request: WshEventRequest, deadlineAt: string, maximumBytes: number): Promise<string> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!this.metadataReady || !inspectWshRequest(request).shapeValid) return Promise.reject(new Error("RESEARCH_WSH_REQUEST_INVALID"));
    return this.query("wshEventData", requestId, deadlineAt, maximumBytes, () => this.socket.reqWshEventData(requestId, request));
  }
  private query(event: string, requestId: number, deadlineAt: string, maximumBytes: number, send: () => unknown): Promise<string> {
    if (!this.connected || this.closed || this.pending || !Number.isSafeInteger(requestId) || requestId <= 0 || this.usedRequestIds.has(requestId))
      return Promise.reject(new Error("RESEARCH_WSH_TRANSPORT_UNAVAILABLE"));
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return Promise.reject(new Error("RESEARCH_WSH_BYTES_INVALID"));
    return this.bounded(deadlineAt, event === 'wshMetaData' ? 'metadata' : 'events', (resolve, reject) => {
      const received = (id: unknown, json: unknown) => {
        if (id !== requestId) return;
        if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maximumBytes) reject(new Error("RESEARCH_WSH_PAYLOAD_LIMIT"));
        else resolve(json);
      };
      const error = (_error: unknown, code: number, id: number) => {
        if (id === requestId && !INFO_CODES.has(code)) reject(wshProviderError(_error, code, this.privacy));
      };
      this.socket.on(event, received); this.socket.on("error", error);
      const cleanup = () => { this.socket.removeListener(event, received); this.socket.removeListener("error", error); };
      try { this.usedRequestIds.add(requestId); this.owned.set(requestId, event); send(); } catch (error) { cleanup(); throw Object.assign(new Error("RESEARCH_WSH_SEND_FAILED"), { providerError: wshProviderError(error, null, this.privacy).providerError, sourceError: captureResearchSourceError(error, this.privacy) }); }
      return cleanup;
    });
  }
  private bounded(deadlineAt: string, stage: 'connect' | 'metadata' | 'events', start: (resolve: (json: string) => void, reject: (error: Error) => void) => () => void): Promise<string> {
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 10000) return Promise.reject(new Error("RESEARCH_WSH_DEADLINE_INVALID"));
    return new Promise((resolve, reject) => {
      let settled = false, cleanup = () => {};
      const finish = (error: Error | null, json = "") => {
        if (settled) return;
        settled = true; clearTimeout(timer); cleanup(); this.pending = null;
        if (error) { void this.closeWith(error); reject(error); } else resolve(json);
      };
      const timeoutError = () => Object.assign(new Error('RESEARCH_WSH_TIMEOUT'), { sourceError: captureResearchSourceError(
        Object.assign(new Error(`Local WSH ${stage} deadline expired`), { name: 'WshTimeoutError', code: 'RESEARCH_WSH_TIMEOUT' }), this.privacy) });
      const timer = setTimeout(() => finish(timeoutError()), remaining);
      this.pending = error => finish(error);
      try {
        cleanup = start(json => Date.now() >= Date.parse(deadlineAt) ? finish(timeoutError()) : finish(null, json), error => finish(error));
        if (settled) cleanup();
      } catch (error) { finish(error instanceof Error ? error : new Error("RESEARCH_WSH_TRANSPORT_FAILED")); }
    });
  }
  private closeWith(error: Error): Promise<WshCleanupResult> {
    if (this.closing) return this.closing;
    this.terminalError = error;
    this.closed = true; this.connected = false;
    this.options.signal?.removeEventListener("abort", this.aborted);
    // Defer cleanup one microtask so synchronous SDK callbacks see the same close promise.
    this.closing = Promise.resolve().then(async () => {
      this.inspectLocal();
      if (this.localInspected && !this.local && !this.localUncertain && !this.owned.size) {
        this.socket.removeListener('disconnected', this.disconnected);
        return { sessionId: this.sessionId, state: 'NOT_NEEDED' as const, completedAt: new Date().toISOString(), cancellationAttemptedAt: null,
          disconnectRequestedAt: null, localClosedAt: null, verifiedLocalClosure: false };
      }
      let cleanupError: ResearchSourceError | undefined;
      const failed = (cause: unknown) => { this.localUncertain = true; cleanupError ??= captureResearchSourceError(cause, this.privacy); };
      const cancellationAttemptedAt = this.owned.size ? new Date().toISOString() : null;
      let disconnectRequestedAt: string | null = null;
      const expected = new Set([...this.owned].map(([id, event]) => `${event === "wshEventData" ? 103 : 101}:${id}`));
      let finish!: () => void;
      const sent = new Promise<void>(resolve => { finish = resolve; });
      const observed = (tokens: unknown) => {
        if (!Array.isArray(tokens)) return;
        expected.delete(`${tokens[0]}:${tokens[1]}`);
        if (!expected.size) finish();
      };
      this.socket.on("sent", observed);
      const timeout = setTimeout(finish, 750);
      try {
        for (const event of ["wshEventData", "wshMetaData"]) for (const [id, kind] of this.owned) {
          if (kind !== event) continue;
          try {
            if (event === "wshEventData") this.socket.reqCancelWshEventData(id);
            else this.socket.reqCancelWshMetaData(id);
          } catch (cause) { failed(cause); }
        }
        if (expected.size) await sent;
        if (expected.size) this.localUncertain = true;
        // The SDK's sent event follows socket.write, not its flush callback.
        if (this.owned.size) await new Promise<void>(resolve => setTimeout(resolve, 25));
      } finally {
        clearTimeout(timeout); this.socket.removeListener("sent", observed);
        disconnectRequestedAt = new Date().toISOString();
        try { this.socket.disconnect(); } catch (cause) { failed(cause); }
        this.inspectLocal();
      }
      if (this.local && !this.localClosedAt) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 1000);
          this.closeObserved = () => { clearTimeout(timer); resolve(); };
          try {
            if (this.local!.closed) this.localClosed();
            else this.local!.destroy();
          } catch (cause) { failed(cause); }
        });
      }
      this.closeObserved = null;
      this.inspectLocal();
      this.local?.removeListener("close", this.localClosed);
      this.socket.removeListener("disconnected", this.disconnected);
      // Keep the closed error listener to absorb delayed SDK/network errors.
      return { sessionId: this.sessionId, state: this.localUncertain || !this.localInspected ? "UNKNOWN" : this.local
        ? this.localClosedAt ? "CONFIRMED" : "UNKNOWN" : "NOT_NEEDED", completedAt: new Date().toISOString(),
      cancellationAttemptedAt, disconnectRequestedAt, localClosedAt: this.localClosedAt,
      verifiedLocalClosure: !!this.local && !!this.localClosedAt && this.localInspected && !this.localIdentityUncertain,
      ...(cleanupError ? { sourceError: cleanupError } : {}) };
    });
    const pending = this.pending; this.pending = null; pending?.(error);
    return this.closing;
  }
  close(): Promise<WshCleanupResult> { return this.closeWith(new Error("RESEARCH_WSH_CLOSED")); }
}
