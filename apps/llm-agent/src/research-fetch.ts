import { createHash } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { safeResearchUrl, type ResearchSource } from "@ikbr/shared/instrument-research";

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
  if (!records.length || records.some(record => !isPublicResearchAddress(record.address))) throw new Error("RESEARCH_SOURCE_DNS_NOT_PUBLIC");
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
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > RESEARCH_SOURCE_TIMEOUT_MS) throw new Error("RESEARCH_SOURCE_DEADLINE_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  let selected: { address: string; family: 4 | 6 };
  try {
    selected = await Promise.race([
      (deps.resolveAddress ?? resolvePublicResearchAddress)(url.hostname),
      new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("RESEARCH_SOURCE_TIMEOUT")), { once: true })),
    ]);
  } catch (error) { clearTimeout(timeout); throw error; }
  if (controller.signal.aborted) { clearTimeout(timeout); throw new Error("RESEARCH_SOURCE_TIMEOUT"); }
  return new Promise<ResearchFetchResult>((resolve, reject) => {
    const options = {
      method: "GET", signal: controller.signal, agent: false, autoSelectFamily: false, maxHeaderSize: 16 * 1024,
      headers: { "Accept": source.parserConfig.kind === "issuer-pdf-table" ? "application/pdf" : "application/json, application/xhtml+xml, text/html;q=0.8", "User-Agent": "ikbr-trader-research/1.0 (contact: operator)" },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
    } satisfies RequestOptions & { autoSelectFamily: boolean };
    const req = (deps.httpsRequest ?? request)(url, options, response => {
      if (response.statusCode !== 200) { response.destroy(); req.destroy(); reject(new Error(`RESEARCH_SOURCE_HTTP_${response.statusCode ?? "UNKNOWN"}`)); return; }
      if (response.headers.location) { response.destroy(); req.destroy(); reject(new Error("RESEARCH_SOURCE_REDIRECT")); return; }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > RESEARCH_SOURCE_MAX_BYTES) { response.destroy(); req.destroy(); reject(new Error("RESEARCH_SOURCE_TOO_LARGE")); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESEARCH_SOURCE_MAX_BYTES) { response.destroy(new Error("RESEARCH_SOURCE_TOO_LARGE")); req.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const payload = Buffer.concat(chunks);
        const contentType = String(response.headers["content-type"] ?? "");
        try {
          if (source.parserConfig.kind === "issuer-pdf-table") assertResearchPdfResponse(payload, contentType);
          resolve({ payload, contentHash: createHash("sha256").update(payload).digest("hex"), contentType });
        } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    controller.signal.addEventListener("abort", () => req.destroy(new Error("RESEARCH_SOURCE_TIMEOUT")), { once: true });
    req.end();
  }).finally(() => clearTimeout(timeout));
}
