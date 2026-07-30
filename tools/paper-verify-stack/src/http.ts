/**
 * PR15.1 — GET-only, allowlist-bound HTTP transport.
 * The ONLY module allowed to import global `fetch`.
 * Every call is:
 *   - keyed by a stable `EndpointKey` (rejected otherwise),
 *   - `method: "GET"` (hard-coded, not a parameter),
 *   - bounded by `timeoutMs` (AbortController).
 */

import { ENDPOINTS, type EndpointKey, isEndpointKey } from "./endpoints.js";

export interface TransportRequestLog {
  readonly method: "GET";
  readonly url: string;
  readonly key: EndpointKey;
}

export interface TransportResponse {
  readonly kind: "response";
  readonly status: number;
  readonly bodyText: string;
}

export interface TransportError {
  readonly kind: "error";
  readonly reason: "timeout" | "network" | "dns" | "unknown";
  readonly detail: string;
}

export type TransportOutcome = TransportResponse | TransportError;

export interface TransportOptions {
  readonly ingestionUrl: string;
  readonly signalUrl: string;
  readonly executionUrl: string;
  readonly token: string | undefined;
  readonly timeoutMs: number;
  /** Optional per-run request log; the tool + tests inspect it. */
  readonly requestLog?: TransportRequestLog[];
  /**
   * Optional `fetch` override — the tests inject a spy that
   * records the exact `(method, url)` and returns canned
   * responses.
   */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface Transport {
  get(key: EndpointKey): Promise<TransportOutcome>;
}

function baseUrlFor(
  service: "ingestion" | "signal" | "execution",
  opts: TransportOptions,
): string {
  switch (service) {
    case "ingestion":
      return opts.ingestionUrl;
    case "signal":
      return opts.signalUrl;
    case "execution":
      return opts.executionUrl;
  }
}

function classifyFetchError(err: unknown): TransportError {
  const message = err instanceof Error ? err.message : String(err);
  if (
    err instanceof Error &&
    (err.name === "AbortError" || /aborted|timeout/i.test(message))
  ) {
    return { kind: "error", reason: "timeout", detail: message };
  }
  const causeCode =
    err instanceof Error &&
    err.cause &&
    typeof err.cause === "object" &&
    "code" in err.cause
      ? String((err.cause as { code?: unknown }).code ?? "")
      : "";
  const codeString = `${causeCode} ${message}`.toUpperCase();
  if (/EAI_AGAIN|ENOTFOUND|EAI_/.test(codeString)) {
    return { kind: "error", reason: "dns", detail: message };
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/.test(codeString)) {
    return { kind: "error", reason: "network", detail: message };
  }
  return { kind: "error", reason: "unknown", detail: message };
}

export function createTransport(opts: TransportOptions): Transport {
  const impl = opts.fetchImpl ?? globalThis.fetch;
  return {
    async get(key: EndpointKey): Promise<TransportOutcome> {
      if (!isEndpointKey(key)) {
        throw new Error(`transport: endpoint key not in allowlist: ${key}`);
      }
      const descriptor = ENDPOINTS[key];
      const base = baseUrlFor(descriptor.service, opts);
      const url = `${base.replace(/\/$/, "")}${descriptor.path}`;
      const headers: Record<string, string> = {
        accept: "application/json",
      };
      if (descriptor.bearer) {
        if (!opts.token) {
          throw new Error(
            `transport: endpoint ${key} requires a bearer token`,
          );
        }
        headers["authorization"] = `Bearer ${opts.token}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      opts.requestLog?.push({ method: "GET", url, key });
      try {
        const res = await impl(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        const bodyText = await res.text();
        return { kind: "response", status: res.status, bodyText };
      } catch (err) {
        return classifyFetchError(err);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
