import { marketauxQualificationDeadline, marketauxRequestUrl, parseMarketauxNewsConfig, type MarketauxRequest, type ResearchSource } from "@ikbr/shared/instrument-research";
import { fetchBoundedResearchUrl, RESEARCH_SOURCE_MAX_BYTES, type ResearchFetchResult } from "./research-fetch.js";

export type MarketauxFetch = (source: ResearchSource, descriptor: MarketauxRequest, deadlineAt: string, maxBytes?: number) => Promise<ResearchFetchResult>;
const SAFE_CODES = new Set([
  ...["SCHEMA_INVALID", "LIMIT_INVALID", "TEXT_INVALID", "QUALIFICATION_INVALID", "SOURCE_INVALID", "ENTITY_INVALID", "IDENTITY_MISMATCH", "BUDGET_INVALID", "URL_INVALID", "TIME_INVALID", "QUALIFICATION_UNAVAILABLE", "REQUEST_INVALID", "RECEIPT_INVALID", "KEY_MISSING", "CONTENT_TYPE_INVALID", "ACQUISITION_FAILED", "PAYLOAD_INVALID", "RESULT_LIMIT", "DUPLICATE_UUID", "ENTITY_MISMATCH", "PUBLICATION_OUTSIDE_QUERY", "DEADLINE_EXPIRED", "BYTES_EXCEEDED", "RESULT_CHANGED"].map(code => "RESEARCH_MARKETAUX_" + code),
  ...["TIMEOUT", "TOO_LARGE", "REDIRECT", "DNS_NOT_PUBLIC", "DEADLINE_INVALID"].map(code => "RESEARCH_SOURCE_" + code),
  "RESEARCH_CALL_ALREADY_RESERVED", "RESEARCH_BUDGET_EXHAUSTED", "RESEARCH_CALL_DEADLINE_INVALID", "RESEARCH_SNAPSHOT_TOO_LARGE",
]);
export function sanitizeMarketauxError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return SAFE_CODES.has(code) || /^RESEARCH_SOURCE_HTTP_[1-5]\d{2}$/.test(code)
    ? code : "RESEARCH_MARKETAUX_ACQUISITION_FAILED";
}

export function createMarketauxFetch(apiKey: string | undefined,
  deps: Parameters<typeof fetchBoundedResearchUrl>[3] = {}): MarketauxFetch {
  return async (source, descriptor, deadlineAt, maxBytes = RESEARCH_SOURCE_MAX_BYTES) => {
    try {
      if (!apiKey?.trim()) throw new Error("RESEARCH_MARKETAUX_KEY_MISSING");
      const config = parseMarketauxNewsConfig(source), now = Date.now();
      const expiry = marketauxQualificationDeadline(config, now);
      if (Date.parse(deadlineAt) > expiry || Date.parse(deadlineAt) <= now) throw new Error("RESEARCH_SOURCE_DEADLINE_INVALID");
      const url = new URL(marketauxRequestUrl(source, descriptor));
      url.searchParams.set("api_token", apiKey);
      const result = await fetchBoundedResearchUrl(url, deadlineAt, "application/json", deps, maxBytes);
      if (result.contentType.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("RESEARCH_MARKETAUX_CONTENT_TYPE_INVALID");
      return result;
    } catch (error) { throw new Error(sanitizeMarketauxError(error)); }
  };
}
