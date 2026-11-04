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
type RetryAfterTiming = { retryAfterMs?: number | null; retryAfterAt?: string };
export function researchRetryAfter(error: unknown): RetryAfterTiming {
  if (!(error instanceof Error)) return {};
  const timing: RetryAfterTiming = {};
  if ('retryAfterMs' in error) {
    if (error.retryAfterMs !== null && !(typeof error.retryAfterMs === 'number' && Number.isSafeInteger(error.retryAfterMs)
      && error.retryAfterMs >= 0 && error.retryAfterMs <= 8_640_000_000_000_000)) throw new Error('RESEARCH_MARKETAUX_RETRY_AFTER_INVALID');
    timing.retryAfterMs = error.retryAfterMs;
  }
  if ('retryAfterAt' in error) {
    if (!('retryAfterMs' in error) && typeof error.retryAfterAt === 'string' && Number.isFinite(Date.parse(error.retryAfterAt))
      && new Date(error.retryAfterAt).toISOString() === error.retryAfterAt) timing.retryAfterAt = error.retryAfterAt;
    else throw new Error('RESEARCH_MARKETAUX_RETRY_AFTER_INVALID');
  }
  return timing;
}
function httpDate(value: string, reference: number): number | null {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const longDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const imf = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  const parts = imf ?? rfc850 ?? (asctime ? [asctime[0], asctime[1], asctime[3].trim(), asctime[2], asctime[7], asctime[4], asctime[5], asctime[6]] : null);
  if (!parts) return null;
  let year = Number(parts[4]);
  const month = months.indexOf(parts[3]), day = Number(parts[2]), hour = Number(parts[5]), minute = Number(parts[6]), second = Number(parts[7]);
  if (month < 0 || day < 1 || hour > 23 || minute > 59 || second > 60) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day); date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (rfc850) {
    const currentYear = new Date(reference).getUTCFullYear();
    year += Math.floor(currentYear / 100) * 100;
    if (year < currentYear - 50) year += 100;
    date.setUTCFullYear(year);
    const limit = new Date(reference); limit.setUTCFullYear(currentYear + 50);
    if (date.getTime() > limit.getTime()) { year -= 100; date.setUTCFullYear(year); }
  }
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || (rfc850 ? longDays : shortDays)[date.getUTCDay()] !== parts[1]) return null;
  return date.getTime() + (second === 60 ? 1000 : 0);
}
function retryAfterTiming(value: string | string[] | undefined, serverDate: string | undefined): RetryAfterTiming {
  if (value === undefined) return {};
  if (typeof value !== 'string') return { retryAfterMs: null };
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return { retryAfterMs: Number.isSafeInteger(milliseconds) && Number.isFinite(new Date(Date.now() + milliseconds).getTime()) ? milliseconds : null };
  }
  const receivedAt = Date.now();
  const deadline = httpDate(text, (serverDate ? httpDate(serverDate, receivedAt) : null) ?? receivedAt);
  if (deadline === null) return { retryAfterMs: null };
  return { retryAfterAt: new Date(deadline).toISOString() };
}
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
      let retryAfter: RetryAfterTiming = {};
      const finishError = (error: unknown) => {
        if (settled) return;
        settled = true; dispatchClosed = true;
        const wrapped = httpDetails ? new ResearchSourceFailure(`RESEARCH_SOURCE_HTTP_${httpDetails.httpStatus}`, undefined, deps.privacy, httpDetails) : failure(error);
        req?.destroy();
        reject(Object.assign(wrapped, retryAfter));
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
            retryAfter = retryAfterTiming(response.headers['retry-after'], response.headers.date);
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
