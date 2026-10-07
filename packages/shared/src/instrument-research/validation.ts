import { parseWshConfig, validateWshEvidence, validateWshEvent, validateWshCoverage } from "./wsh.js";
import { parseMarketauxNewsConfig, validateMarketauxAcquisition } from "./marketaux.js";
import { isIP } from "node:net";
import { canonicalJson, computeTradingConfigurationHash, sha256 } from "../trading-configuration/identity.js";
import type { TradingConfigurationV1 } from "../trading-configuration/types.js";
import type { ResearchSnapshot, ResearchManifest, ResearchPublication } from "./types.js";

export const researchHash = (value: unknown): string => sha256(canonicalJson(value));
export function researchAssert(condition: unknown, code = "RESEARCH_SCHEMA_INVALID"): asserts condition { if (!condition) throw new Error(code); }
export const isResearchHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function obj(v: unknown, keys: string): Record<string, unknown> {
  researchAssert(v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype);
  const r = v as Record<string, unknown>;
  researchAssert(Reflect.ownKeys(r).length === Object.keys(r).length && Object.keys(r).sort().join(",") === keys.split(" ").sort().join(",") && Object.keys(r).every(k => "value" in Object.getOwnPropertyDescriptor(r, k)!));
  return r;
}
function txt(v: unknown, max = 200): asserts v is string { researchAssert(typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)); }
function choice(v: unknown, choices: string): void { researchAssert(typeof v === "string" && choices.split(" ").includes(v)); }
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts v is number { researchAssert(typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max); }
function arr(v: unknown, max = 1000): asserts v is unknown[] { researchAssert(Array.isArray(v) && v.length <= max); }
function unique(rows: unknown[], field: string): void { const values = rows.map(v => (v as Record<string, unknown>)[field]); researchAssert(new Set(values).size === values.length, "RESEARCH_DUPLICATE_IDENTITY"); }
function jsonValue(value: unknown, depth = 0): void {
  researchAssert(depth <= 30, "RESEARCH_JSON_DEPTH_EXCEEDED");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { researchAssert(Number.isFinite(value) && !Object.is(value, -0)); return; }
  researchAssert(value && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype));
  researchAssert(Reflect.ownKeys(value).length === Object.keys(value).length + (Array.isArray(value) ? 1 : 0));
  for (const key of Object.keys(value)) { const d = Object.getOwnPropertyDescriptor(value, key)!; researchAssert("value" in d); jsonValue(d.value, depth + 1); }
}
export function researchTime(v: unknown): number {
  researchAssert(typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v));
  const t = Date.parse(v); researchAssert(Number.isFinite(t) && new Date(t).toISOString().replace(".000Z", "Z") === v.replace(".000Z", "Z")); return t;
}
function date(v: unknown): asserts v is string {
  researchAssert(typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
}
export function safeResearchUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2000) return false;
  try {
    const u = new URL(v), h = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && !u.hash && (!u.port || u.port === "443") &&
      !isIP(h.replace(/^\[|\]$/g, "")) && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(h) &&
      !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(h) && !h.endsWith(".localhost");
  } catch { return false; }
}
function identifier(v: unknown): void {
  const r = obj(v, "scheme value"); choice(r.scheme, "CIK LEI ISIN"); txt(r.value, 30);
  const re = r.scheme === "CIK" ? /^\d{10}$/ : r.scheme === "LEI" ? /^[A-Z0-9]{20}$/ : /^[A-Z]{2}[A-Z0-9]{9}\d$/;
  researchAssert(re.test(r.value));
}
export function publicationRange(v: ResearchPublication): { start: number; end: number } {
  if (v.precision === "instant") { obj(v, "precision at"); const t = researchTime(v.at); return { start: t, end: t }; }
  obj(v, "precision date timeZone"); researchAssert(v.precision === "date"); date(v.date); txt(v.timeZone, 80);
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: v.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { throw new Error("RESEARCH_TIMEZONE_INVALID"); }
  const dayAt = (t: number) => { const p = formatter.formatToParts(t); return ["year", "month", "day"].map(k => p.find(x => x.type === k)!.value).join("-"); };
  const midnight = Date.parse(v.date);
  const boundary = (after: boolean) => {
    let lo = midnight - 36 * 3600000, hi = midnight + 60 * 3600000;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2), d = dayAt(mid); if (after ? d <= v.date : d < v.date) lo = mid; else hi = mid; }
    return hi;
  };
  const start = boundary(false), end = boundary(true); researchAssert(dayAt(start) === v.date && end > start, "RESEARCH_DATE_INVALID"); return { start, end };
}
function reportRequirement(v: unknown): void { const r = obj(v, "periodStart periodEnd nextPublicationDeadline scope"); date(r.periodStart); date(r.periodEnd); researchAssert(r.periodStart <= r.periodEnd); choice(r.scope, "consolidated separate"); researchTime(r.nextPublicationDeadline); }

export function parseResearchManifest(raw: unknown, configuration: TradingConfigurationV1, expectedConfigHash: string): ResearchManifest {
  const m = validateResearchManifest(raw);
  researchAssert(computeTradingConfigurationHash(configuration) === expectedConfigHash && m.configHash === expectedConfigHash, "RESEARCH_CONFIG_MISMATCH");
  for (const policy of m.instruments) {
    const instrument = configuration.instruments.find(i => i.id === policy.instrumentId);
    researchAssert(instrument && instrument.assetClass === policy.assetClass && canonicalJson(instrument.contract) === canonicalJson(policy.listing), "RESEARCH_LISTING_MISMATCH");
    const issuer = configuration.issuerMappings.find(i => i.id === instrument.issuerMappingId);
    researchAssert(issuer && issuer.issuerId === policy.issuerId, "RESEARCH_ISSUER_MISMATCH");
  }
  for (const instrument of configuration.instruments.filter(i => i.entryEnabled)) researchAssert(m.instruments.some(i => i.instrumentId === instrument.id), "RESEARCH_MAPPING_MISSING");
  return m;
}
export function validateResearchManifest(raw: unknown): ResearchManifest {
  const m = obj(raw, "schemaVersion configHash instruments refreshEnabled model"); researchAssert((m.schemaVersion === 1 || m.schemaVersion === 2) && isResearchHash(m.configHash) && typeof m.refreshEnabled === "boolean");
  const model = obj(m.model, "provider model promptVersion outputSchemaVersion maxInputChars maxOutputTokens maxCostMicrosPerCall maxRequestsPerDay maxCostMicrosPerDay");
  for (const k of ["provider", "model", "promptVersion", "outputSchemaVersion"]) txt(model[k]);
  researchAssert(model.provider === "openai", "RESEARCH_MODEL_PROVIDER_UNSUPPORTED");
  integer(model.maxInputChars, 1, 200000); integer(model.maxOutputTokens, 1, 10000);
  for (const k of ["maxCostMicrosPerCall", "maxRequestsPerDay", "maxCostMicrosPerDay"]) integer(model[k]);
  arr(m.instruments, 100); researchAssert(m.instruments.length > 0); unique(m.instruments, "instrumentId");
  const listings = new Set<string>(), sourceIdentities = new Map<string, string>(), marketauxEntities = new Map<string, string>();
  for (const value of m.instruments) {
    const p = obj(value, "instrumentId assetClass listing issuerId legalName country sector business identifiers verification profile reportingCurrency annual periodic bankCapitalMetric sources");
    for (const k of ["instrumentId", "issuerId", "legalName", "country", "sector"]) txt(p[k]); txt(p.business, 4000); txt(p.reportingCurrency, 3); researchAssert(/^[A-Z]{3}$/.test(p.reportingCurrency));
    choice(p.assetClass, "stock etf"); choice(p.profile, "bank industrial etf"); researchAssert((p.assetClass === "etf") === (p.profile === "etf"));
    const listing = obj(p.listing, "broker symbol conId exchange primaryExchange currency localSymbol tradingClass expectedMinTick");
    researchAssert(listing.broker === "ibkr"); for (const k of ["symbol", "exchange", "primaryExchange", "currency", "localSymbol", "tradingClass"]) txt(listing[k]); integer(listing.conId, 1);
    researchAssert(typeof listing.expectedMinTick === "number" && Number.isFinite(listing.expectedMinTick) && listing.expectedMinTick > 0);
    const key = `${listing.broker}:${listing.conId}`; researchAssert(!listings.has(key), "RESEARCH_DUPLICATE_LISTING"); listings.add(key);
    arr(p.identifiers, 20); researchAssert(p.identifiers.length > 0); for (const id of p.identifiers) identifier(id); unique(p.identifiers, "scheme");
    const verification = obj(p.verification, "url verifiedAt outcome"); researchAssert(safeResearchUrl(verification.url)); researchTime(verification.verifiedAt); choice(verification.outcome, "VERIFIED UNVERIFIED");
    reportRequirement(p.annual); reportRequirement(p.periodic);
    researchAssert(p.profile === "bank" ? p.bankCapitalMetric === "cet1_ratio" || p.bankCapitalMetric === "tier1_ratio" : p.bankCapitalMetric === null);
    arr(p.sources, 20); unique(p.sources, "id");
    for (const source of p.sources) {
      const s = obj(source, "id provider adapter parserConfig roles urls issuerIdentifier automation retention permissionEvidenceUrl maxRequestsPerDay maxCostMicrosPerDay costMicrosPerCall");
      txt(s.id); txt(s.provider); choice(s.adapter, m.schemaVersion === 2 ? "sec-json issuer-document marketaux-news ibkr-wsh" : "sec-json issuer-document marketaux-news"); arr(s.roles, 3); researchAssert(s.roles.length > 0 && new Set(s.roles).size === s.roles.length); for (const role of s.roles) choice(role, "reports news calendar");
      researchAssert(s.parserConfig && typeof s.parserConfig === "object" && !Array.isArray(s.parserConfig) && Object.getPrototypeOf(s.parserConfig) === Object.prototype && canonicalJson(s.parserConfig).length <= 50000, "RESEARCH_PARSER_CONFIG_INVALID");
      jsonValue(s.parserConfig);
      arr(s.urls, 100); researchAssert((s.adapter === "ibkr-wsh" ? s.urls.length === 0 : s.urls.length > 0) && new Set(s.urls).size === s.urls.length); for (const url of s.urls) researchAssert(safeResearchUrl(url), "RESEARCH_SOURCE_URL_INVALID");
      researchAssert(s.urls.every(url => new URL(String(url)).origin === s.provider), "RESEARCH_PROVIDER_ORIGIN_MISMATCH");
      identifier(s.issuerIdentifier); researchAssert(p.identifiers.some(i => canonicalJson(i) === canonicalJson(s.issuerIdentifier)), "RESEARCH_SOURCE_IDENTITY_MISMATCH");
      choice(s.automation, "PERMITTED UNVERIFIED DENIED"); choice(s.retention, "FACTS_AND_REFERENCES FULL_DOCUMENT UNVERIFIED DENIED"); researchAssert(safeResearchUrl(s.permissionEvidenceUrl));
      for (const k of ["maxRequestsPerDay", "maxCostMicrosPerDay", "costMicrosPerCall"]) integer(s[k]);
      if (s.adapter === "ibkr-wsh") parseWshConfig(s as unknown as import("./types.js").ResearchSource, p as unknown as import("./types.js").ResearchInstrumentPolicy);
      if (s.adapter === "marketaux-news" || (s.parserConfig as Record<string, unknown>).kind === "marketaux-news-v1") {
        const config = parseMarketauxNewsConfig(s as unknown as import("./types.js").ResearchSource, p as unknown as import("./types.js").ResearchInstrumentPolicy);
        researchAssert(!marketauxEntities.has(config.entity.symbol) || marketauxEntities.get(config.entity.symbol) === p.issuerId, "RESEARCH_AMBIGUOUS_PROVIDER_IDENTITY");
        marketauxEntities.set(config.entity.symbol, String(p.issuerId));
      }
      const sourceKey = `${s.provider}:${canonicalJson(s.issuerIdentifier)}`, issuerId = String(p.issuerId);
      researchAssert(!sourceIdentities.has(sourceKey) || sourceIdentities.get(sourceKey) === issuerId, "RESEARCH_AMBIGUOUS_PROVIDER_IDENTITY"); sourceIdentities.set(sourceKey, issuerId);
    }
    researchAssert((p.sources as import("./types.js").ResearchSource[]).filter(s => s.adapter === "ibkr-wsh").length <= 1, "RESEARCH_WSH_DUPLICATE_SOURCE");
    if ((p.sources as import("./types.js").ResearchSource[]).some(s => s.adapter === "ibkr-wsh")) researchAssert((p.sources as import("./types.js").ResearchSource[]).filter(s => s.roles.includes("calendar")).length === 1, "RESEARCH_WSH_CALENDAR_SOURCE_CONFLICT");
  }
  return structuredClone(raw) as ResearchManifest;
}

export function parseResearchSnapshot(raw: unknown, manifest: ResearchManifest): ResearchSnapshot {
  const s = obj(raw, "schemaVersion configHash manifestHash instrumentId mappingHash createdAt evidence coverage reports facts news events");
  researchAssert(s.schemaVersion === manifest.schemaVersion && s.configHash === manifest.configHash && s.manifestHash === researchHash(manifest), "RESEARCH_SNAPSHOT_IDENTITY_INVALID");
  const policy = manifest.instruments.find(i => i.instrumentId === s.instrumentId); researchAssert(policy && s.mappingHash === researchHash(policy), "RESEARCH_MAPPING_MISMATCH"); researchTime(s.createdAt);
  for (const k of ["evidence", "coverage", "reports", "facts", "news", "events"]) arr(s[k]);
  const evidence = s.evidence as unknown[], reports = s.reports as unknown[];
  unique(evidence, "ref"); unique(reports, "id"); unique(s.facts as unknown[], "id"); unique(s.news as unknown[], "id"); unique(s.events as unknown[], "id");
  const refs = new Set<string>(), reportIds = new Set<string>();
  for (const value of evidence) {
    if (value && typeof value === "object" && "kind" in value && value.kind === "wsh-calendar") {
      researchAssert(s.schemaVersion === 2, "RESEARCH_WSH_VERSION_INVALID");
      validateWshEvidence(value, policy, String(s.createdAt)); refs.add((value as import("./wsh.js").WshEvidence).ref); continue;
    }
    const e = obj(value, "ref sourceId documentId url contentHash issuerId issuerIdentifier published fetchedAt observedAt automation retention");
    for (const k of ["ref", "sourceId", "documentId"]) txt(e[k]); researchAssert(isResearchHash(e.contentHash));
    const source = policy.sources.find(x => x.id === e.sourceId); researchAssert(source && e.issuerId === policy.issuerId && canonicalJson(e.issuerIdentifier) === canonicalJson(source.issuerIdentifier), "RESEARCH_EVIDENCE_ISSUER_MISMATCH");
    researchAssert(source.adapter !== "ibkr-wsh", "RESEARCH_WSH_EVIDENCE_INVALID");
    researchAssert(safeResearchUrl(e.url) && source.urls.includes(e.url), "RESEARCH_EVIDENCE_URL_MISMATCH");
    publicationRange(e.published as ResearchPublication); researchTime(e.fetchedAt); researchTime(e.observedAt);
    choice(e.automation, "PERMITTED UNVERIFIED DENIED"); choice(e.retention, "FACTS_AND_REFERENCES FULL_DOCUMENT UNVERIFIED DENIED"); refs.add(e.ref as string);
  }
  const coverageKeys = new Set<string>();
  for (const value of s.coverage as unknown[]) {
    if (value && typeof value === "object" && "wshAcquisition" in value) {
      researchAssert(s.schemaVersion === 2); validateWshCoverage(value, policy, evidence, String(s.createdAt));
      const c = value as import("./wsh.js").WshSourceResult;
      const key = `${c.sourceId}:${c.role}`; researchAssert(!coverageKeys.has(key), "RESEARCH_DUPLICATE_COVERAGE"); coverageKeys.add(key); continue;
    }
    const hasOccurrenceRange = value !== null && typeof value === "object" &&
      (Object.hasOwn(value, "occurrenceWindowStart") || Object.hasOwn(value, "occurrenceWindowEnd"));
    const hasAcquisition = value !== null && typeof value === "object" && Object.hasOwn(value, "acquisition");
    const c = obj(value, "sourceId role status checkedAt windowStart windowEnd complete evidenceRefs reason" +
      (hasOccurrenceRange ? " occurrenceWindowStart occurrenceWindowEnd" : "") + (hasAcquisition ? " acquisition" : ""));
    const source = policy.sources.find(x => x.id === c.sourceId); researchAssert(source && (source.adapter !== "ibkr-wsh" || c.complete === false && !["AVAILABLE", "EMPTY"].includes(String(c.status))) && source.roles.includes(c.role as "reports"), "RESEARCH_COVERAGE_SOURCE_INVALID");
    const key = `${c.sourceId}:${c.role}`; researchAssert(!coverageKeys.has(key), "RESEARCH_DUPLICATE_COVERAGE"); coverageKeys.add(key);
    choice(c.status, "AVAILABLE EMPTY MISSING STALE UNVERIFIED ERROR NOT_APPLICABLE"); researchTime(c.checkedAt); const start = researchTime(c.windowStart), end = researchTime(c.windowEnd); researchAssert(start <= end && typeof c.complete === "boolean");
    if (hasOccurrenceRange) researchAssert(c.role === "calendar" && researchTime(c.occurrenceWindowStart) <= researchTime(c.occurrenceWindowEnd), "RESEARCH_CALENDAR_RANGE_INVALID");
    researchAssert(typeof c.reason === "string" && c.reason.length <= 1000); arr(c.evidenceRefs); researchAssert(new Set(c.evidenceRefs).size === c.evidenceRefs.length);
    if (source.adapter === "marketaux-news") validateMarketauxAcquisition(c as unknown as import("./types.js").ResearchSourceResult, source, policy, String(s.manifestHash), String(s.createdAt));
    else researchAssert(!hasAcquisition, "RESEARCH_MARKETAUX_RECEIPT_INVALID");
    for (const ref of c.evidenceRefs) researchAssert(typeof ref === "string" && refs.has(ref) && evidence.some(e => (e as Record<string, unknown>).ref === ref && (e as Record<string, unknown>).sourceId === c.sourceId));
  }
  const httpRefs = new Set((evidence as (import("./types.js").ResearchEvidence | import("./wsh.js").WshEvidence)[]).filter(e => e.published !== null).map(e => e.ref));
  for (const value of reports) {
    const r = obj(value, "id kind periodStart periodEnd scope evidenceRef supersedes"); txt(r.id); choice(r.kind, "annual periodic"); date(r.periodStart); date(r.periodEnd); researchAssert(r.periodStart <= r.periodEnd); choice(r.scope, "consolidated separate"); researchAssert(httpRefs.has(r.evidenceRef as string)); researchAssert(r.supersedes === null || typeof r.supersedes === "string"); reportIds.add(r.id as string);
  }
  for (const value of s.facts as unknown[]) {
    const f = obj(value, "id reportId metric value unit currency scale periodStart periodEnd periodType scope evidenceRef sourcePointer supersedes"); txt(f.id); researchAssert(reportIds.has(f.reportId as string) && httpRefs.has(f.evidenceRef as string)); txt(f.sourcePointer, 1000);
    choice(f.metric, "net_interest_income net_profit loans deposits cet1_ratio tier1_ratio revenue net_income operating_cash_flow total_debt"); researchAssert(typeof f.value === "number" && Number.isFinite(f.value) && !Object.is(f.value, -0));
    choice(f.unit, "currency percent decimal"); researchAssert(f.currency === null || typeof f.currency === "string" && /^[A-Z]{3}$/.test(f.currency));
    researchAssert(typeof f.scale === "number" && [1, 1000, 1000000, 1000000000].includes(f.scale)); date(f.periodEnd); choice(f.periodType, "instant duration"); choice(f.scope, "consolidated separate");
    if (f.periodType === "duration") { date(f.periodStart); researchAssert(f.periodStart <= f.periodEnd); } else researchAssert(f.periodStart === null);
    researchAssert(f.supersedes === null || typeof f.supersedes === "string");
  }
  for (const value of s.news as unknown[]) { const n = obj(value, "id evidenceRef title" + (s.schemaVersion === 2 ? " description snippet providerSentiment" : "")); if (s.schemaVersion === 2) { for (const field of [n.description, n.snippet]) researchAssert(field === null || typeof field === "string" && field.length <= 8000); const sentiment = n.providerSentiment as Record<string, unknown>; researchAssert(sentiment && (sentiment.status === "NOT_PROVIDED" && Object.keys(sentiment).length === 1 || sentiment.status === "PROVIDED" && Object.keys(sentiment).sort().join(",") === "score,status" && (sentiment.score === null || typeof sentiment.score === "number" && Number.isFinite(sentiment.score) && sentiment.score >= -1 && sentiment.score <= 1))); } txt(n.id); txt(n.title, 1000); researchAssert(httpRefs.has(n.evidenceRef as string)); }
  for (const value of s.events as unknown[]) { if (value && typeof value === "object" && "kind" in value && value.kind === "wsh-calendar") { researchAssert(s.schemaVersion === 2); validateWshEvent(value, policy, evidence); continue; } const e = obj(value, "id kind occurs evidenceRef title"); txt(e.id); txt(e.title, 1000); choice(e.kind, "earnings material other"); publicationRange(e.occurs as ResearchPublication); researchAssert(httpRefs.has(e.evidenceRef as string)); }
  for (const source of policy.sources.filter(source => source.adapter === "ibkr-wsh")) {
    const own = (evidence as import("./wsh.js").WshEvidence[]).filter(e => e.sourceId === source.id);
    const events = s.events as (import("./types.js").ResearchEvent | import("./wsh.js").WshEvent)[];
    researchAssert(own.every(e => events.filter(event => event.kind === "wsh-calendar" && event.evidenceRef === e.ref).length === 1), "RESEARCH_WSH_EVENT_COUNT_MISMATCH");
  }
  for (const source of policy.sources.filter(source => source.adapter === "marketaux-news")) {
    const coverage = (s.coverage as import("./types.js").ResearchSourceResult[]).find(c => c.sourceId === source.id);
    const sourceEvidence = (evidence as import("./types.js").ResearchEvidence[]).filter(e => e.sourceId === source.id);
    if (!coverage?.complete) { researchAssert(sourceEvidence.length === 0, "RESEARCH_MARKETAUX_RECEIPT_INVALID"); continue; }
    researchAssert(sourceEvidence.length === coverage.acquisition!.emitted && sourceEvidence.every(e => coverage.evidenceRefs.includes(e.ref)), "RESEARCH_MARKETAUX_RECEIPT_INVALID");
    unique(sourceEvidence, "documentId");
    for (const e of sourceEvidence) {
      researchAssert(/^marketaux:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(e.documentId) && e.published.precision === "instant" &&
        researchTime(e.published.at) >= researchTime(coverage.windowStart) && researchTime(e.published.at) <= researchTime(coverage.windowEnd) && e.observedAt === e.fetchedAt &&
        coverage.acquisition!.pages.some(page => page.pass === 1 && page.contentHash === e.contentHash && page.fetchedAt === e.fetchedAt) &&
        (s.news as { evidenceRef: string }[]).filter(n => n.evidenceRef === e.ref).length === 1, "RESEARCH_MARKETAUX_RECEIPT_INVALID");
    }
  }
  researchAssert(canonicalJson(raw).length <= 2000000, "RESEARCH_SNAPSHOT_TOO_LARGE");
  return structuredClone(raw) as ResearchSnapshot;
}
