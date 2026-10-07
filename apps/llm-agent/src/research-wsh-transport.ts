import { randomUUID } from "node:crypto";
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
  reqWshMetaData(requestId: number): unknown;
  reqWshEventData(requestId: number, request: WshEventRequest): unknown;
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
  close(): void;
}
const INFO_CODES = new Set([2104, 2106, 2107, 2108, 2158]);

export class WshSocketTransport implements WshTransport {
  readonly sessionId = randomUUID();
  readonly sdkVersion = "1.6.10";
  private readonly socket: WshSocket;
  private closed = false;
  private connected = false;
  private pending: ((error: Error) => void) | null = null;
  private metadataReady = false;
  private readonly usedRequestIds = new Set<number>();
  private readonly disconnected = () => this.closeWith(new Error("RESEARCH_WSH_DISCONNECTED"));
  private readonly errored = (_error: unknown, code: number, requestId: number) => {
    if (INFO_CODES.has(code)) return;
    if (requestId === -1 || requestId === undefined) this.closeWith(new Error(`RESEARCH_WSH_ERROR_${Number.isInteger(code) ? code : "UNKNOWN"}`));
  };
  constructor(private readonly options: WshRuntimeConfiguration & { accountId: string }, factory?: () => WshSocket) {
    this.socket = factory ? factory() : new IBApi({ host: options.host, port: options.port }) as unknown as WshSocket;
    this.socket.on("disconnected", this.disconnected);
    this.socket.on("error", this.errored);
  }
  get serverVersion(): number { return this.socket.serverVersion; }

  async connect(deadlineAt: string): Promise<void> {
    if (!this.options.enabled || this.closed || this.connected || this.pending) throw new Error("RESEARCH_WSH_TRANSPORT_UNAVAILABLE");
    let nextIdSeen = false, accountSeen = false;
    await this.bounded(deadlineAt, (resolve, reject) => {
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
      try { this.socket.connect(this.options.clientId); } catch { cleanup(); throw new Error("RESEARCH_WSH_CONNECT_FAILED"); }
      return cleanup;
    });
  }

  async metadata(requestId: number, deadlineAt: string, maximumBytes: number): Promise<string> {
    if (this.metadataReady) throw new Error("RESEARCH_WSH_METADATA_ALREADY_RECEIVED");
    const result = await this.query("wshMetaData", requestId, deadlineAt, maximumBytes, () => this.socket.reqWshMetaData(requestId));
    this.metadataReady = true;
    return result;
  }
  events(requestId: number, request: WshEventRequest, deadlineAt: string, maximumBytes: number): Promise<string> {
    if (!this.metadataReady || !inspectWshRequest(request).shapeValid) return Promise.reject(new Error("RESEARCH_WSH_REQUEST_INVALID"));
    return this.query("wshEventData", requestId, deadlineAt, maximumBytes, () => this.socket.reqWshEventData(requestId, request));
  }
  private query(event: string, requestId: number, deadlineAt: string, maximumBytes: number, send: () => unknown): Promise<string> {
    if (!this.connected || this.closed || this.pending || !Number.isSafeInteger(requestId) || requestId <= 0 || this.usedRequestIds.has(requestId))
      return Promise.reject(new Error("RESEARCH_WSH_TRANSPORT_UNAVAILABLE"));
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) return Promise.reject(new Error("RESEARCH_WSH_BYTES_INVALID"));
    this.usedRequestIds.add(requestId);
    return this.bounded(deadlineAt, (resolve, reject) => {
      const received = (id: unknown, json: unknown) => {
        if (id !== requestId) return;
        if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maximumBytes) reject(new Error("RESEARCH_WSH_PAYLOAD_LIMIT"));
        else resolve(json);
      };
      const error = (_error: unknown, code: number, id: number) => {
        if (id === requestId && !INFO_CODES.has(code)) reject(new Error(`RESEARCH_WSH_ERROR_${Number.isInteger(code) ? code : "UNKNOWN"}`));
      };
      this.socket.on(event, received); this.socket.on("error", error);
      const cleanup = () => { this.socket.removeListener(event, received); this.socket.removeListener("error", error); };
      try { send(); } catch { cleanup(); throw new Error("RESEARCH_WSH_SEND_FAILED"); }
      return cleanup;
    });
  }
  private bounded(deadlineAt: string, start: (resolve: (json: string) => void, reject: (error: Error) => void) => () => void): Promise<string> {
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 10000) return Promise.reject(new Error("RESEARCH_WSH_DEADLINE_INVALID"));
    return new Promise((resolve, reject) => {
      let settled = false, cleanup = () => {};
      const finish = (error: Error | null, json = "") => {
        if (settled) return;
        settled = true; clearTimeout(timer); cleanup(); this.pending = null;
        if (error) { this.closeWith(error); reject(error); } else resolve(json);
      };
      const timer = setTimeout(() => finish(new Error("RESEARCH_WSH_TIMEOUT")), remaining);
      this.pending = error => finish(error);
      try {
        cleanup = start(json => Date.now() >= Date.parse(deadlineAt) ? finish(new Error("RESEARCH_WSH_TIMEOUT")) : finish(null, json), error => finish(error));
        if (settled) cleanup();
      } catch (error) { finish(error instanceof Error ? error : new Error("RESEARCH_WSH_TRANSPORT_FAILED")); }
    });
  }
  private closeWith(error: Error): void {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    const pending = this.pending; this.pending = null; pending?.(error);
    this.socket.removeListener("disconnected", this.disconnected); this.socket.removeListener("error", this.errored);
    this.socket.disconnect();
  }
  close(): void { this.closeWith(new Error("RESEARCH_WSH_CLOSED")); }
}
