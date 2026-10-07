import type { ResearchInstrumentPolicy, ResearchSource, ResearchSourceResult } from "./types.js";
import { isResearchHash, researchAssert, researchHash, researchTime, safeResearchUrl } from "./validation.js";

export const MARKETAUX_ORIGIN = "https://api.marketaux.com";
export const MARKETAUX_SLOT_MS = 900_000;
export const MARKETAUX_MAX_ACQUISITION_MS = 120_000;
export const MARKETAUX_MAX_ACQUISITION_BYTES = 20 * 1024 * 1024;
export interface MarketauxEntity { symbol: string; name: string; type: "equity"; country: string; exchange: string | null }
interface Qualification { outcome: "VERIFIED" | "UNVERIFIED"; verifiedAt: string; expiresAt: string; evidenceUrl: string; receiptHash: string }
export interface MarketauxNewsConfig {
  kind: "marketaux-news-v1";
  entity: MarketauxEntity;
  qualification: Qualification & { issuerIdentifier: ResearchSource["issuerIdentifier"]; conId: number };
  entitlement: Qualification & { maxArticlesPerRequest: number; maxRequestsPerDay: number; maxCostMicrosPerDay: number };
  pageSize: number;
  maxPagesPerPass: number;
  maxArticles: number;
}
export interface MarketauxRequest { sourceUrl: string; windowStart: string; asOf: string; pass: 1 | 2; page: number }
export interface MarketauxPageReceipt {
  pass: 1 | 2; page: number; canonicalRequestUrl: string; requestHash: string; callKey: string;
  fetchedAt: string; contentHash: string; found: number; returned: number; limit: number;
}
export interface MarketauxAcquisition {
  kind: "marketaux-news-v1"; queryStart: string; queryEnd: string; asOf: string;
  entityQualificationHash: string; entitlementHash: string; found: number; emitted: number;
  recordSetHash: string; pages: MarketauxPageReceipt[];
}

function exact(value: unknown, keys: string): Record<string, unknown> {
  researchAssert(value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, "RESEARCH_MARKETAUX_SCHEMA_INVALID");
  researchAssert(Object.keys(value).sort().join(" ") === keys.split(" ").sort().join(" ") && Reflect.ownKeys(value).length === Object.keys(value).length, "RESEARCH_MARKETAUX_SCHEMA_INVALID");
  for (const key of Object.keys(value)) researchAssert("value" in Object.getOwnPropertyDescriptor(value, key)!, "RESEARCH_MARKETAUX_SCHEMA_INVALID");
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  researchAssert(Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max, "RESEARCH_MARKETAUX_LIMIT_INVALID");
}
function text(value: unknown, max = 200): asserts value is string {
  researchAssert(typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), "RESEARCH_MARKETAUX_TEXT_INVALID");
}
function qualification(value: Record<string, unknown>): void {
  researchAssert(value.outcome === "VERIFIED" || value.outcome === "UNVERIFIED", "RESEARCH_MARKETAUX_QUALIFICATION_INVALID");
  researchAssert(researchTime(value.verifiedAt) < researchTime(value.expiresAt) && safeResearchUrl(value.evidenceUrl) && isResearchHash(value.receiptHash), "RESEARCH_MARKETAUX_QUALIFICATION_INVALID");
  researchAssert(![...new URL(value.evidenceUrl as string).searchParams.keys()].some(key => key.toLowerCase() === "api_token"), "RESEARCH_MARKETAUX_QUALIFICATION_INVALID");
}

export function parseMarketauxNewsConfig(source: ResearchSource, policy?: ResearchInstrumentPolicy): MarketauxNewsConfig {
  researchAssert(source.adapter === "marketaux-news" && source.provider === MARKETAUX_ORIGIN && source.roles.length === 1 && source.roles[0] === "news", "RESEARCH_MARKETAUX_SOURCE_INVALID");
  researchAssert(safeResearchUrl(source.permissionEvidenceUrl) && ![...new URL(source.permissionEvidenceUrl).searchParams.keys()].some(key => key.toLowerCase() === "api_token"), "RESEARCH_MARKETAUX_URL_INVALID");
  const c = exact(source.parserConfig, "kind entity qualification entitlement pageSize maxPagesPerPass maxArticles");
  researchAssert(c.kind === "marketaux-news-v1", "RESEARCH_MARKETAUX_SOURCE_INVALID");
  const e = exact(c.entity, "symbol name type country exchange");
  text(e.symbol, 80); researchAssert(/^[A-Za-z0-9._^-]+$/.test(e.symbol), "RESEARCH_MARKETAUX_ENTITY_INVALID");
  text(e.name); researchAssert(e.type === "equity" && typeof e.country === "string" && /^[a-z]{2}$/.test(e.country), "RESEARCH_MARKETAUX_ENTITY_INVALID");
  if (e.exchange !== null) text(e.exchange, 80);
  const q = exact(c.qualification, "outcome verifiedAt expiresAt evidenceUrl receiptHash issuerIdentifier conId"); qualification(q);
  exact(q.issuerIdentifier, "scheme value");
  researchAssert(researchHash(q.issuerIdentifier) === researchHash(source.issuerIdentifier), "RESEARCH_MARKETAUX_IDENTITY_MISMATCH");
  integer(q.conId, 1, Number.MAX_SAFE_INTEGER);
  const entityUrl = new URL(String(q.evidenceUrl));
  researchAssert(entityUrl.origin === MARKETAUX_ORIGIN && entityUrl.pathname === "/v1/entity/search", "RESEARCH_MARKETAUX_QUALIFICATION_INVALID");
  if (policy) researchAssert(q.conId === policy.listing.conId && policy.identifiers.some(id => researchHash(id) === researchHash(q.issuerIdentifier)), "RESEARCH_MARKETAUX_IDENTITY_MISMATCH");
  const entitlement = exact(c.entitlement, "outcome verifiedAt expiresAt evidenceUrl receiptHash maxArticlesPerRequest maxRequestsPerDay maxCostMicrosPerDay"); qualification(entitlement);
  integer(entitlement.maxArticlesPerRequest, 1, 100);
  integer(entitlement.maxRequestsPerDay, 0, Number.MAX_SAFE_INTEGER); integer(entitlement.maxCostMicrosPerDay, 0, Number.MAX_SAFE_INTEGER);
  integer(c.pageSize, 1, entitlement.maxArticlesPerRequest); integer(c.maxPagesPerPass, 1, 100);
  researchAssert(c.pageSize * c.maxPagesPerPass <= 20_000, "RESEARCH_MARKETAUX_LIMIT_INVALID");
  integer(c.maxArticles, 1, Math.min(900, c.pageSize * c.maxPagesPerPass));
  researchAssert(source.maxRequestsPerDay <= entitlement.maxRequestsPerDay && source.maxCostMicrosPerDay <= entitlement.maxCostMicrosPerDay, "RESEARCH_MARKETAUX_BUDGET_INVALID");
  const config = source.parserConfig as unknown as MarketauxNewsConfig;
  researchAssert(source.urls.length === 1 && source.urls[0] === marketauxSourceUrl(config), "RESEARCH_MARKETAUX_URL_INVALID");
  return config;
}

export function marketauxSourceUrl(config: MarketauxNewsConfig): string {
  const url = new URL("/v1/news/all", MARKETAUX_ORIGIN);
  for (const [key, value] of Object.entries({ symbols: config.entity.symbol, countries: config.entity.country, entity_types: "equity",
    filter_entities: "true", must_have_entities: "true", group_similar: "false", limit: String(config.pageSize) })) url.searchParams.set(key, value);
  return url.href;
}

export function marketauxWindow(slot: number): { windowStart: string; asOf: string } {
  integer(slot, 1, Math.floor(8640000000000000 / MARKETAUX_SLOT_MS));
  const asOf = slot * MARKETAUX_SLOT_MS - 1000;
  return { windowStart: new Date(asOf - 86400000).toISOString(), asOf: new Date(asOf).toISOString() };
}

export function marketauxQualificationDeadline(config: MarketauxNewsConfig, now: number): number {
  researchAssert(Number.isFinite(now), "RESEARCH_MARKETAUX_TIME_INVALID");
  for (const q of [config.qualification, config.entitlement]) researchAssert(q.outcome === "VERIFIED" && researchTime(q.verifiedAt) <= now && now < researchTime(q.expiresAt), "RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE");
  return Math.min(researchTime(config.qualification.expiresAt), researchTime(config.entitlement.expiresAt));
}

export function marketauxRequestUrl(source: ResearchSource, descriptor: MarketauxRequest): string {
  const config = parseMarketauxNewsConfig(source);
  exact(descriptor, "sourceUrl windowStart asOf pass page");
  researchAssert(descriptor.sourceUrl === source.urls[0] && (descriptor.pass === 1 || descriptor.pass === 2), "RESEARCH_MARKETAUX_REQUEST_INVALID");
  integer(descriptor.page, 1, config.maxPagesPerPass);
  const end = researchTime(descriptor.asOf), start = researchTime(descriptor.windowStart);
  researchAssert(end - start === 86400000 && (end + 1000) % MARKETAUX_SLOT_MS === 0 && descriptor.page * config.pageSize <= 20_000, "RESEARCH_MARKETAUX_REQUEST_INVALID");
  const url = new URL(descriptor.sourceUrl);
  url.searchParams.set("published_after", new Date(start - 1000).toISOString().slice(0, 19));
  url.searchParams.set("published_before", new Date(end + 1000).toISOString().slice(0, 19));
  url.searchParams.set("page", String(descriptor.page));
  return url.href;
}

export function marketauxCallIdentity(manifestHash: string, instrumentId: string, source: ResearchSource, descriptor: MarketauxRequest): { canonicalRequestUrl: string; callKey: string; requestHash: string } {
  const canonicalRequestUrl = marketauxRequestUrl(source, descriptor);
  const callKey = "research_marketaux_" + researchHash({ manifestHash, instrumentId, sourceId: source.id, role: "news", slot: (researchTime(descriptor.asOf) + 1000) / MARKETAUX_SLOT_MS, ...descriptor, attempt: 1 });
  return { canonicalRequestUrl, callKey, requestHash: researchHash({ method: "GET", url: canonicalRequestUrl, callKey }) };
}

export function validateMarketauxAcquisition(coverage: ResearchSourceResult, source: ResearchSource, policy: ResearchInstrumentPolicy, manifestHash: string, createdAt: string): void {
  const config = parseMarketauxNewsConfig(source, policy);
  researchAssert(coverage.windowEnd === coverage.checkedAt && researchTime(coverage.checkedAt) - researchTime(coverage.windowStart) === 86400000 && (researchTime(coverage.checkedAt) + 1000) % MARKETAUX_SLOT_MS === 0, "RESEARCH_MARKETAUX_RECEIPT_INVALID");
  const successful = coverage.complete && (coverage.status === "AVAILABLE" || coverage.status === "EMPTY");
  if (!successful) { researchAssert(coverage.acquisition === undefined && !coverage.complete, "RESEARCH_MARKETAUX_RECEIPT_INVALID"); return; }
  const a = exact(coverage.acquisition, "kind queryStart queryEnd asOf entityQualificationHash entitlementHash found emitted recordSetHash pages");
  researchAssert(a.kind === "marketaux-news-v1" && a.asOf === coverage.checkedAt && a.asOf === coverage.windowEnd && researchTime(a.asOf) - researchTime(coverage.windowStart) === 86400000, "RESEARCH_MARKETAUX_RECEIPT_INVALID");
  researchAssert(researchTime(a.queryStart) === researchTime(coverage.windowStart) - 1000 && researchTime(a.queryEnd) === researchTime(a.asOf) + 1000, "RESEARCH_MARKETAUX_RECEIPT_INVALID");
  researchAssert(a.entityQualificationHash === researchHash(config.qualification) && a.entitlementHash === researchHash(config.entitlement) && isResearchHash(a.recordSetHash), "RESEARCH_MARKETAUX_RECEIPT_INVALID");
  integer(a.found, 0, config.maxArticles); integer(a.emitted, 0, a.found);
  researchAssert(a.emitted === coverage.evidenceRefs.length && (coverage.status === "EMPTY") === (a.emitted === 0), "RESEARCH_MARKETAUX_RECEIPT_INVALID");
  const pageCount = Math.max(1, Math.ceil(a.found / config.pageSize));
  researchAssert(pageCount <= config.maxPagesPerPass && Array.isArray(a.pages) && a.pages.length === 2 * pageCount, "RESEARCH_MARKETAUX_RECEIPT_INVALID");
  let priorFetch = researchTime(a.queryEnd);
  for (let index = 0; index < a.pages.length; index++) {
    const p = exact(a.pages[index], "pass page canonicalRequestUrl requestHash callKey fetchedAt contentHash found returned limit");
    const pass = (index < pageCount ? 1 : 2) as 1 | 2, page = index % pageCount + 1;
    const expected = marketauxCallIdentity(manifestHash, policy.instrumentId, source, { sourceUrl: source.urls[0], windowStart: coverage.windowStart, asOf: coverage.checkedAt, pass, page });
    researchAssert(p.pass === pass && p.page === page && p.found === a.found && p.limit === config.pageSize && p.returned === Math.min(config.pageSize, Math.max(0, a.found - (page - 1) * config.pageSize)), "RESEARCH_MARKETAUX_RECEIPT_INVALID");
    researchAssert(p.canonicalRequestUrl === expected.canonicalRequestUrl && p.callKey === expected.callKey && p.requestHash === expected.requestHash && isResearchHash(p.contentHash), "RESEARCH_MARKETAUX_RECEIPT_INVALID");
    const fetched = researchTime(p.fetchedAt); researchAssert(fetched >= priorFetch && fetched <= researchTime(createdAt), "RESEARCH_MARKETAUX_RECEIPT_INVALID");
    marketauxQualificationDeadline(config, fetched); priorFetch = fetched;
  }
}
