import { createHash } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { safeResearchUrl, ResearchSourceFailure, type ResearchSourceHttpDetails, type ResearchSource } from "@ikbr/shared/instrument-research";

import type { DiagnosticPrivacy } from "@ikbr/shared/diagnostics";

export const RESEARCH_SOURCE_TIMEOUT_MS = 10_000;
export const RESEARCH_SOURCE_MAX_BYTES = 10 * 1024 * 1024;

export function isPublicResearchAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) &&
      !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) &&
      !(a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower.includes(".")) return false;
    const first = Number.parseInt(lower.split(":")[0], 16);
    return first >= 0x2000 && first <= 0x3fff && !lower.startsWith("2001:db8:");
  }
  return false;
}

export function assertResearchSourceUrl(source: ResearchSource, value: string): URL {
  if (!safeResearchUrl(value) || !source.urls.includes(value)) throw new Error("RESEARCH_SOURCE_URL_NOT_ALLOWED");
  const url = new URL(value);
  if (url.origin !== source.provider) throw new Error("RESEARCH_SOURCE_ORIGIN_MISMATCH");
  return url;
}

export async function resolvePublicResearchAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const records = results.flatMap((result, index) => result.status === "fulfilled" ? result.value.map(address => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 })) : []);
  if (!records.length) {
    const failed = results.find(result => result.status === "rejected");
    const original = failed?.status === "rejected" ? failed.reason : undefined;
    throw new ResearchSourceFailure(transientCode(original) ? "RESEARCH_SOURCE_TRANSPORT_TRANSIENT" : "RESEARCH_SOURCE_DNS_NOT_PUBLIC", original);
  }
  if (records.some(record => !isPublicResearchAddress(record.address))) throw new ResearchSourceFailure("RESEARCH_SOURCE_DNS_NOT_PUBLIC", undefined);
  return records[0];
}

export type ResearchFetchResult = { payload: Buffer; contentHash: string; contentType: string };
export function assertResearchPdfResponse(payload: Uint8Array, contentType: string): void {
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/pdf") throw new Error("RESEARCH_PDF_CONTENT_TYPE_INVALID");
  if (!Buffer.from(payload.subarray(0, 5)).equals(Buffer.from("%PDF-"))) throw new Error("RESEARCH_PDF_MAGIC_INVALID");
}

export async function fetchResearchSource(source: ResearchSource, sourceUrl: string, deadlineAt: string,
  deps: { resolveAddress?: typeof resolvePublicResearchAddress; httpsRequest?: typeof request } = {}): Promise<ResearchFetchResult> {
  const url = assertResearchSourceUrl(source, sourceUrl);
  const result = await fetchBoundedResearchUrl(url, deadlineAt, source.parserConfig.kind === "issuer-pdf-table" ? "application/pdf" : "application/json, application/xhtml+xml, text/html;q=0.8", deps);
  if (source.parserConfig.kind === "issuer-pdf-table") assertResearchPdfResponse(result.payload, result.contentType);
  return result;
}

const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);
function transientCode(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && TRANSIENT_CODES.has(error.code);
}
export interface ResearchDispatchGuard { assertActive(): void; signal?: AbortSignal }
type ResearchFetchDeps = {
  resolveAddress?: typeof resolvePublicResearchAddress;
  httpsRequest?: typeof request;
  readJsonError?: boolean;
  privacy?: DiagnosticPrivacy;
  monotonicDeadlineMs?: number;
  dispatchGuard?: ResearchDispatchGuard;
};

export async function fetchBoundedResearchUrl(url: URL, deadlineAt: string, accept: string,
  deps: ResearchFetchDeps = {}, maxBytes = RESEARCH_SOURCE_MAX_BYTES): Promise<ResearchFetchResult> {
  if (!safeResearchUrl(url.href)) throw new Error("RESEARCH_SOURCE_URL_NOT_ALLOWED");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > RESEARCH_SOURCE_MAX_BYTES) throw new Error("RESEARCH_SOURCE_TOO_LARGE");
  const remaining = deps.monotonicDeadlineMs === undefined ? Date.parse(deadlineAt) - Date.now() : deps.monotonicDeadlineMs - performance.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > RESEARCH_SOURCE_TIMEOUT_MS) throw new Error("RESEARCH_SOURCE_DEADLINE_INVALID");
  const controller = new AbortController();
  let timedOut = false, dispatchClosed = false;
  const shutdown = () => { dispatchClosed = true; controller.abort(); };
  deps.dispatchGuard?.signal?.addEventListener('abort', shutdown, { once: true });
  if (deps.dispatchGuard?.signal?.aborted) shutdown();
  const assertDispatch = () => {
    if (dispatchClosed || controller.signal.aborted) throw controller.signal.reason ?? new Error('RESEARCH_REFRESH_ABORTED');
    deps.dispatchGuard?.assertActive();
    const remainingNow = deps.monotonicDeadlineMs === undefined ? Date.parse(deadlineAt) - Date.now() : deps.monotonicDeadlineMs - performance.now();
    if (!Number.isFinite(remainingNow) || remainingNow <= 0) {
      timedOut = true; dispatchClosed = true; controller.abort(); throw controller.signal.reason;
    }
  };
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, remaining);
  const failure = (error: unknown) => new ResearchSourceFailure(timedOut ? "RESEARCH_SOURCE_TIMEOUT" :
    error instanceof ResearchSourceFailure ? error.message : transientCode(error) ? "RESEARCH_SOURCE_TRANSPORT_TRANSIENT" : "RESEARCH_SOURCE_ACQUISITION_FAILED", error, deps.privacy);
  try {
    assertDispatch();
    const selected = await Promise.race([
      (deps.resolveAddress ?? resolvePublicResearchAddress)(url.hostname),
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })),
    ]);
    assertDispatch();
    return await new Promise<ResearchFetchResult>((resolve, reject) => {
      let settled = false;
      let req: ReturnType<typeof request> | undefined;
      let httpDetails: ResearchSourceHttpDetails | undefined;
      const finishError = (error: unknown) => {
        if (settled) return;
        settled = true; dispatchClosed = true;
        const wrapped = httpDetails ? new ResearchSourceFailure(`RESEARCH_SOURCE_HTTP_${httpDetails.httpStatus}`, undefined, deps.privacy, httpDetails) : failure(error);
        req?.destroy();
        reject(wrapped);
      };
      const options = {
        method: "GET", signal: controller.signal, agent: false, autoSelectFamily: false, maxHeaderSize: 16 * 1024,
        headers: { "Accept": accept, "User-Agent": "ikbr-trader-research/1.0 (contact: operator)" },
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
      } satisfies RequestOptions & { autoSelectFamily: boolean };
      try {
        assertDispatch();
        req = (deps.httpsRequest ?? request)(url, options, response => {
          if (settled) { response.destroy(); return; }
          if (timedOut) { finishError(controller.signal.reason); response.destroy(); return; }
          if (response.statusCode !== 200) {
            const status = response.statusCode;
            if (!status || status < 100 || status > 599) { finishError(new Error("HTTP status unavailable")); response.destroy(); return; }
            httpDetails = { httpStatus: status, ...(response.statusMessage ? { httpStatusMessage: response.statusMessage } : {}) };
            const limit = Math.min(16 * 1024, maxBytes);
            if (!deps.readJsonError || String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json" ||
                Number(response.headers["content-length"] ?? 0) > limit || response.headers.location) {
              finishError(undefined); response.destroy(); return;
            }
            const chunks: Buffer[] = []; let size = 0;
            response.on("data", (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > limit) { finishError(undefined); response.destroy(); return; }
              chunks.push(chunk);
            });
            response.on("error", finishError);
            response.on("aborted", () => finishError(undefined));
            response.on("end", () => {
              if (settled) return;
              try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const value = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : null;
                if (value && typeof value === "object" && !Array.isArray(value)) {
                  if ("code" in value && (typeof value.code === "string" || typeof value.code === "number" && Number.isFinite(value.code) || value.code === null)) httpDetails!.providerCode = value.code;
                  if ("message" in value && typeof value.message === "string") httpDetails!.providerMessage = value.message;
                }
              } catch { /* A body that cannot be decoded does not replace the known HTTP status. */ }
              finishError(undefined);
            });
            response.on("close", () => { if (!settled) finishError(undefined); });
            return;
          }
          if (response.headers.location) { finishError(new ResearchSourceFailure("RESEARCH_SOURCE_REDIRECT", undefined)); response.destroy(); return; }
          const declared = Number(response.headers["content-length"] ?? 0);
          if (declared > maxBytes) { finishError(new ResearchSourceFailure("RESEARCH_SOURCE_TOO_LARGE", undefined)); response.destroy(); return; }
          const chunks: Buffer[] = []; let size = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) { finishError(new ResearchSourceFailure("RESEARCH_SOURCE_TOO_LARGE", undefined)); response.destroy(); return; }
            chunks.push(chunk);
          });
          response.on("error", finishError);
          response.on("aborted", () => finishError(new ResearchSourceFailure("RESEARCH_SOURCE_TRANSPORT_TRANSIENT", undefined)));
          response.on("end", () => {
            if (settled) return;
            if (timedOut) { finishError(controller.signal.reason); return; }
            const payload = Buffer.concat(chunks);
            settled = true; dispatchClosed = true;
            resolve({ payload, contentHash: createHash("sha256").update(payload).digest("hex"), contentType: String(response.headers["content-type"] ?? "") });
          });
          response.on("close", () => { if (!settled) finishError(new ResearchSourceFailure("RESEARCH_SOURCE_TRANSPORT_TRANSIENT", undefined)); });
        });
        req.on("error", finishError);
        req.on("close", () => {
          dispatchClosed = true;
          if (!settled) finishError(new ResearchSourceFailure('RESEARCH_SOURCE_TRANSPORT_TRANSIENT', undefined));
        });
        controller.signal.addEventListener("abort", () => {
          // Native request errors run first; the fallback also terminates silent transports.
          queueMicrotask(() => { if (!settled) finishError(controller.signal.reason); });
        }, { once: true });
        assertDispatch();
        req.end();
      } catch (error) { finishError(error); }
    });
  } catch (error) {
    if (error instanceof ResearchSourceFailure) throw error;
    throw failure(error);
  } finally { dispatchClosed = true; clearTimeout(timeout); deps.dispatchGuard?.signal?.removeEventListener('abort', shutdown); }
}
