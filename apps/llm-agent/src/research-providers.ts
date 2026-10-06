import { SaxesParser } from "saxes";
import type { ResearchEvidence, ResearchFact, ResearchInstrumentPolicy, ResearchMetric, ResearchReport, ResearchSource, ResearchSourceResult } from "@ikbr/shared/instrument-research";
import { researchHash, publicationRange } from "@ikbr/shared/instrument-research";

type SecConcept = { concept: string; metric: ResearchMetric; unit: "currency" | "percent" | "decimal"; currency?: string; scale: number; periodType: "instant" | "duration" };
export interface SecMapping {
  sourceId: string; sourceUrl: string; contentHash: string; expectedCik: string; legalName: string;
  listingSymbol: string; exchange: string; reportingCurrency: string;
  concepts: SecConcept[]; debtComponents?: string[];
}
export interface ProviderExclusion { code: "OUTSIDE_CONFIGURED_REPORT_PERIOD" | "UNMAPPED_DURATION" | "UNMAPPED_PERIOD" | "UNKNOWN_ACCESSION" | "INCOMPLETE_DEBT_COMPONENTS"; accession: string; count: number }
export interface NormalizedReports { evidence: ResearchEvidence[]; reports: ResearchReport[]; facts: ResearchFact[]; excludedAccessions: string[]; exclusions: ProviderExclusion[] }
export class ResearchProviderMappingError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ResearchProviderMappingError"; } }
const iso = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(s) || !Number.isFinite(Date.parse(s))) return false;
  const localDate = s.slice(0, 10), midnight = Date.parse(localDate + "T00:00:00Z");
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === localDate;
};
const canonicalPublication = (p: ResearchEvidence["published"]): ResearchEvidence["published"] => {
  if (p.precision !== "instant") return p;
  if (!iso(p.at)) throw new Error("invalid publication timestamp");
  return { precision: "instant", at: new Date(p.at).toISOString() };
};
const date = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s + "T00:00:00Z"));
const obj = (v: unknown): Record<string, any> => { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("malformed provider JSON"); return v as Record<string, any>; };
const numberValue = (v: unknown): number => {
  if (typeof v !== "number" && (typeof v !== "string" || !/^-?\d+(?:\.\d+)?$/.test(v))) throw new Error("invalid numeric fact");
  const n = Number(v); if (!Number.isFinite(n)) throw new Error("invalid numeric fact"); return n;
};
const idPart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

export function normalizeSecReports(submissionsInput: unknown, companyfactsInput: unknown, mapping: SecMapping, fetchedAt: string, policy: ResearchInstrumentPolicy): NormalizedReports {
  if (!iso(fetchedAt) || !/^\d{10}$/.test(mapping.expectedCik) || !/^https:\/\//.test(mapping.sourceUrl)) throw new Error("invalid SEC mapping or fetch time");
  const configuredSource = policy.sources.find(s => s.id === mapping.sourceId);
  if (!configuredSource || !configuredSource.urls.includes(mapping.sourceUrl) || !configuredSource.roles.includes("reports") || configuredSource.issuerIdentifier.scheme !== "CIK" || configuredSource.issuerIdentifier.value !== mapping.expectedCik) throw new Error("SEC source is not configured for this issuer and role");
  const sub = obj(submissionsInput), factsRoot = obj(companyfactsInput);
  if (String(sub.cik).padStart(10, "0") !== mapping.expectedCik || String(factsRoot.cik).padStart(10, "0") !== mapping.expectedCik || sub.name !== mapping.legalName || factsRoot.entityName !== mapping.legalName) throw new Error("SEC issuer identity mismatch");
  if (mapping.listingSymbol !== policy.listing.symbol || !Array.isArray(sub.tickers) || !Array.isArray(sub.exchanges) ||
    sub.tickers.length !== sub.exchanges.length || !sub.tickers.some((ticker: unknown, index: number) => ticker === mapping.listingSymbol && sub.exchanges[index] === mapping.exchange))
    throw new Error("SEC listing identity mismatch");
  const recent = sub.filings?.recent;
  if (!recent || !Array.isArray(recent.accessionNumber)) throw new Error("SEC submissions malformed");
  const filings = new Map<string, { form: string; reportDate: string; accepted: string }>();
  for (let i = 0; i < recent.accessionNumber.length; i++) {
    const acc = recent.accessionNumber[i], form = recent.form?.[i], rd = recent.reportDate?.[i], accepted = recent.acceptanceDateTime?.[i];
    if (typeof acc === "string" && typeof form === "string" && date(rd) && iso(accepted)) filings.set(acc, { form, reportDate: rd, accepted });
  }
  const allowed = new Set(["10-K", "10-Q", "10-K/A", "10-Q/A"]);
  const requiredPeriods = new Map([[policy.annual.periodEnd, policy.annual], [policy.periodic.periodEnd, policy.periodic]]);
  const exclusions = new Map<string, number>();
  const noteExclusion = (code: ProviderExclusion["code"], accession: string) => exclusions.set(code + "|" + accession, (exclusions.get(code + "|" + accession) ?? 0) + 1);
  const supported = new Map<string, { form: string; reportDate: string; accepted: string }>();
  for (const [acc, filing] of filings) {
    if (!allowed.has(filing.form)) continue;
    const annual = filing.form.startsWith("10-K"), req = annual ? policy.annual : policy.periodic;
    if (filing.reportDate > req.periodEnd) throw new ResearchProviderMappingError("RESEARCH_REPORT_MAPPING_OUTDATED", filing.form + " " + filing.reportDate + " is newer than " + req.periodEnd);
    if (filing.reportDate === req.periodEnd) supported.set(acc, filing);
    else noteExclusion("OUTSIDE_CONFIGURED_REPORT_PERIOD", acc);
  }
  const evidence: ResearchEvidence[] = [], reports: ResearchReport[] = [], facts: ResearchFact[] = [], excluded = new Set<string>();
  const componentFactIds = new Set<string>();
  const evByAcc = new Map<string, ResearchEvidence>();
  const ensure = (acc: string, filing: { form: string; reportDate: string; accepted: string }) => {
    let ev = evByAcc.get(acc); if (ev) return ev;
    const docId = "sec:" + mapping.expectedCik + ":" + acc;
    ev = { ref: "ev_" + idPart(docId), sourceId: mapping.sourceId, documentId: docId, url: mapping.sourceUrl, contentHash: mapping.contentHash, issuerId: policy.issuerId, issuerIdentifier: { scheme: "CIK", value: mapping.expectedCik }, published: { precision: "instant", at: new Date(filing.accepted).toISOString() }, fetchedAt: new Date(fetchedAt).toISOString(), observedAt: new Date(fetchedAt).toISOString(), automation: configuredSource.automation, retention: configuredSource.retention };
    evidence.push(ev); evByAcc.set(acc, ev);
    const annual = filing.form.startsWith("10-K"), req = annual ? policy.annual : policy.periodic;
    if (filing.reportDate !== req.periodEnd) throw new Error("unexplained SEC report period " + filing.reportDate);
    reports.push({ id: "report_" + idPart(acc), kind: annual ? "annual" : "periodic", periodStart: req.periodStart, periodEnd: filing.reportDate, scope: req.scope, evidenceRef: ev.ref, supersedes: null });
    return ev;
  };
  const gaap = factsRoot.facts?.["us-gaap"];
  if (!gaap || typeof gaap !== "object") throw new Error("SEC facts lack us-gaap namespace");
  const parseConcepts: SecConcept[] = [...mapping.concepts, ...(mapping.debtComponents ?? []).map(concept => ({ concept, metric: "total_debt" as const, unit: "currency" as const, currency: mapping.reportingCurrency, scale: 1, periodType: "instant" as const }))];
  for (const spec of parseConcepts) {
    const conceptName = spec.concept.includes(":") ? spec.concept.split(":")[1] : spec.concept;
    const units = gaap[conceptName]?.units ?? {};
    const expected = spec.unit === "currency" ? mapping.reportingCurrency : spec.unit === "percent" ? "%" : "pure";
    for (const [unitName, entries] of Object.entries(units) as [string, any[]][]) {
      if (unitName !== expected) continue;
      for (const item of entries) {
        const acc = item.accn; if (typeof acc !== "string") continue;
        const filing = supported.get(acc);
        if (!filing) {
          if (filings.has(acc)) continue;
          excluded.add(acc); noteExclusion("UNKNOWN_ACCESSION", acc); continue;
        }
        if (!date(item.end) || (item.start !== undefined && !date(item.start))) throw new Error("invalid SEC fact period " + acc);
        const req = filing.form.startsWith("10-K") ? policy.annual : policy.periodic;
        const instant = item.start === undefined;
        if (spec.periodType === "instant" && !instant) { noteExclusion("UNMAPPED_DURATION", acc); continue; }
        if (spec.periodType === "instant" && item.end !== req.periodEnd) { noteExclusion("UNMAPPED_PERIOD", acc); continue; }
        if (spec.periodType === "duration" && (instant || item.start !== req.periodStart || item.end !== req.periodEnd)) { noteExclusion("UNMAPPED_DURATION", acc); continue; }
        const ev = ensure(acc, filing), report = reports.find(r => r.evidenceRef === ev.ref)!;
        const factId = "fact_" + idPart(acc) + "_" + spec.metric + "_" + (item.start ?? item.end);
        if (mapping.debtComponents?.includes(conceptName)) componentFactIds.add(factId);
        facts.push({ id: factId, reportId: report.id, metric: spec.metric, value: numberValue(item.val), unit: spec.unit, currency: spec.unit === "currency" ? spec.currency ?? mapping.reportingCurrency : null, scale: spec.scale, periodStart: item.start ?? null, periodEnd: item.end, periodType: spec.periodType, scope: report.scope, evidenceRef: ev.ref, sourcePointer: "companyfacts.facts.us-gaap." + conceptName + ".units." + unitName + "[accn=" + acc + ",end=" + item.end + ",start=" + (item.start ?? "instant") + "]", supersedes: null });
      }
    }
  }
  if (mapping.debtComponents?.length) {
    const parts = facts.filter(f => mapping.debtComponents!.some(c => f.sourcePointer.includes("." + c + ".")));
    const keys = new Set(parts.map(f => [f.reportId, f.periodEnd, f.periodStart ?? "instant", f.scope, f.currency, f.unit].join("|")));
    for (const key of keys) {
      const group = parts.filter(f => [f.reportId, f.periodEnd, f.periodStart ?? "instant", f.scope, f.currency, f.unit].join("|") === key);
      const found = new Set(group.map(f => mapping.debtComponents!.find(c => f.sourcePointer.includes("." + c + "."))));
      if (group.length !== mapping.debtComponents.length || found.size !== mapping.debtComponents.length) { noteExclusion("INCOMPLETE_DEBT_COMPONENTS", group[0]?.sourcePointer.match(/accn=([^,]+)/)?.[1] ?? group[0]?.reportId ?? "unknown"); continue; }
      facts.push({ ...group[0], id: "fact_" + group[0].reportId + "_total_debt_" + group[0].periodEnd, metric: "total_debt", value: group.reduce((n, f) => n + f.value, 0), sourcePointer: "derived=sum(" + group.map(f => f.sourcePointer).join(";") + ")" });
    }
    for (const report of reports) if (!parts.some(f => f.reportId === report.id)) noteExclusion("INCOMPLETE_DEBT_COMPONENTS", [...evByAcc].find(([, ev]) => ev.ref === report.evidenceRef)?.[0] ?? report.id);
  }
  const chronological = [...reports].sort((a, b) => {
    const time = (report: ResearchReport) => Date.parse((evidence.find(e => e.ref === report.evidenceRef)!.published as { at: string }).at);
    return time(a) - time(b);
  });
  for (let i = 0; i < chronological.length; i++) {
    const report = chronological[i];
    const accession = [...evByAcc].find(([, ev]) => ev.ref === report.evidenceRef)?.[0];
    const filing = accession ? supported.get(accession) : undefined;
    if (!filing?.form.endsWith("/A")) continue;
    const previous = chronological.slice(0, i).filter(r => r.kind === report.kind && r.periodStart === report.periodStart && r.periodEnd === report.periodEnd && r.scope === report.scope).at(-1);
    if (previous) {
      const priorAt = (evidence.find(e => e.ref === previous.evidenceRef)!.published as { at: string }).at;
      if (Date.parse(priorAt) < Date.parse(filing.accepted)) report.supersedes = previous.id;
    }
  }
  for (const fact of facts) {
    if (componentFactIds.has(fact.id)) continue;
    const matchingReport = reports.find(r => r.id === fact.reportId);
    if (!matchingReport?.supersedes) continue;
    const base = facts.find(f => f.reportId === matchingReport.supersedes && f.metric === fact.metric && f.periodEnd === fact.periodEnd && f.periodStart === fact.periodStart);
    if (base) fact.supersedes = base.id;
  }
  const normalizedFacts = facts.filter(f => !componentFactIds.has(f.id));
  const diagnostics = [...exclusions].map(([key, count]) => { const [code, accession] = key.split("|") as [ProviderExclusion["code"], string]; return { code, accession, count }; }).sort((a, b) => a.code.localeCompare(b.code) || a.accession.localeCompare(b.accession));
  return { evidence, reports, facts: normalizedFacts, excludedAccessions: [...excluded].sort(), exclusions: diagnostics };
}

export interface XhtmlFactMapping { metric: ResearchMetric; kind: "annual" | "periodic"; tableHeaders: string[]; rowLabel: string; columnHeader: string; unit: "currency" | "percent" | "decimal"; currency?: string; scale: number; decimalSeparator: "." | ","; periodStart: string | null; periodEnd: string; periodType: "instant" | "duration"; scope: "consolidated" | "separate"; publicationAt: string }
export interface XhtmlMapping { sourceId: string; sourceUrl: string; contentHash: string; issuerIdentifier: { scheme: "CIK" | "LEI" | "ISIN"; value: string }; reportPublicationAt: string; issuerMarkers: string[]; documentPeriodMarkers: string[]; sourceUnitMarkers: string[]; facts: XhtmlFactMapping[] }
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function normalizeIssuerXhtml(xml: string, mapping: XhtmlMapping, policy: ResearchInstrumentPolicy, fetchedAt: string): NormalizedReports {
  if (Buffer.byteLength(xml, "utf8") > 10 * 1024 * 1024 || !iso(fetchedAt)) throw new Error("XHTML exceeds bound or has invalid fetch time");
  const tables: { rows: string[][] }[] = [];
  const stack: { rows: string[][]; row: string[] | null; cell: string | null }[] = [];
  let depth = 0, hidden = 0, rowCount = 0, visible = "";
  const parser = new SaxesParser();
  parser.on("doctype", () => { throw new Error("DOCTYPE forbidden"); });
  parser.on("error", e => { throw e; });
  parser.on("opentag", tag => {
    depth++; if (depth > 128) throw new Error("XHTML depth limit");
    const n = tag.name.toLowerCase();
    if (n === "table") stack.push({ rows: [], row: null, cell: null });
    const table = stack.at(-1);
    if (n === "tr" && table) { table.row = []; if (++rowCount > 10000) throw new Error("XHTML row limit"); }
    else if ((n === "td" || n === "th") && table?.row) { if (table.row.length >= 100) throw new Error("XHTML cell limit"); table.cell = ""; }
    if (n === "script" || n === "style") hidden++;
  });
  parser.on("text", t => {
    if (hidden) return;
    visible += " " + t;
    const table = stack.at(-1);
    if (table && table.cell !== null) { table.cell += t; if (table.cell.length > 20000) throw new Error("XHTML cell text limit"); }
  });
  parser.on("closetag", tag => {
    const n = (typeof tag === "string" ? tag : tag.name).toLowerCase(), table = stack.at(-1);
    if (n === "script" || n === "style") hidden--;
    if ((n === "td" || n === "th") && table && table.cell !== null && table.row) { table.row.push(norm(table.cell)); table.cell = null; }
    if (n === "tr" && table?.row) { table.rows.push(table.row); table.row = null; }
    if (n === "table" && table) { tables.push({ rows: table.rows }); stack.pop(); }
    depth--;
  });
  parser.write(xml).close();
  const text = norm(visible);
  for (const marker of [...mapping.issuerMarkers, ...mapping.documentPeriodMarkers, ...mapping.sourceUnitMarkers]) if (!text.includes(marker)) throw new Error("XHTML marker missing: " + marker);
  const configuredSource = policy.sources.find(s => s.id === mapping.sourceId);
  if (!/^https:\/\//.test(mapping.sourceUrl) || !configuredSource || !configuredSource.urls.includes(mapping.sourceUrl) || !configuredSource.roles.includes("reports") || !policy.identifiers.some(i => i.scheme === mapping.issuerIdentifier.scheme && i.value === mapping.issuerIdentifier.value) || configuredSource.issuerIdentifier.scheme !== mapping.issuerIdentifier.scheme || configuredSource.issuerIdentifier.value !== mapping.issuerIdentifier.value) throw new Error("XHTML source identity or URL is not configured");
  const evidence: ResearchEvidence[] = [], evidenceByPublication = new Map<string, ResearchEvidence>();
  const evidenceFor = (publishedAt: string): ResearchEvidence => {
    if (!iso(publishedAt) || Date.parse(publishedAt) > Date.parse(fetchedAt)) throw new Error("invalid or future XHTML publication time");
    let ev = evidenceByPublication.get(publishedAt); if (ev) return ev;
    ev = { ref: "ev_" + idPart(mapping.sourceId) + "_" + mapping.contentHash.slice(0, 12) + "_" + idPart(publishedAt), sourceId: mapping.sourceId, documentId: mapping.sourceId + ":" + mapping.contentHash, url: mapping.sourceUrl, contentHash: mapping.contentHash, issuerId: policy.issuerId, issuerIdentifier: mapping.issuerIdentifier, published: { precision: "instant", at: new Date(publishedAt).toISOString() }, fetchedAt: new Date(fetchedAt).toISOString(), observedAt: new Date(fetchedAt).toISOString(), automation: configuredSource.automation, retention: configuredSource.retention };
    evidence.push(ev); evidenceByPublication.set(publishedAt, ev); return ev;
  };
  if (!iso(mapping.reportPublicationAt)) throw new Error("invalid XHTML report publication mapping");
  const reports: ResearchReport[] = [], facts: ResearchFact[] = [];
  for (const spec of mapping.facts) {
    const required = spec.kind === "annual" ? policy.annual : policy.periodic;
    if (!date(spec.periodEnd) || (spec.periodStart !== null && !date(spec.periodStart)) || !iso(spec.publicationAt) || !Number.isFinite(spec.scale) || spec.periodEnd !== required.periodEnd || (spec.periodType === "duration" && spec.periodStart !== required.periodStart)) throw new Error("invalid or out-of-policy XHTML fact mapping");
    const hits: { row: string[]; col: number }[] = [];
    for (const t of tables) {
      if (JSON.stringify(t.rows[0]) !== JSON.stringify(spec.tableHeaders)) continue;
      const cols = t.rows[0].flatMap((v, i) => v === spec.columnHeader ? [i] : []);
      for (const r of t.rows.slice(1)) if (r[0] === spec.rowLabel) for (const col of cols) hits.push({ row: r, col });
    }
    if (hits.length !== 1) throw new Error("XHTML mapping ambiguous or absent for " + spec.metric);
    let raw = hits[0].row[hits[0].col].replace(/[\s\u00a0]/g, "").replace(/%$/, "");
    const negative = /^\(.*\)$/.test(raw); if (negative) raw = raw.slice(1, -1);
    if (spec.decimalSeparator === ",") raw = raw.replace(/\./g, "").replace(",", ".");
    else raw = raw.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error("ambiguous numeric format for " + spec.metric);
    const value = numberValue(raw) * (negative ? -1 : 1), reportId = idPart(mapping.sourceId) + "_" + spec.scope + "_" + spec.periodEnd;
    if (!reports.some(r => r.id === reportId)) reports.push({ id: reportId, kind: spec.kind, periodStart: policy[spec.kind].periodStart, periodEnd: spec.periodEnd, scope: spec.scope, evidenceRef: evidenceFor(mapping.reportPublicationAt).ref, supersedes: null });
    facts.push({ id: "fact_" + reportId + "_" + spec.metric + "_" + idPart(spec.columnHeader), reportId, metric: spec.metric, value, unit: spec.unit, currency: spec.unit === "currency" ? spec.currency ?? policy.reportingCurrency : null, scale: spec.scale, periodStart: spec.periodStart, periodEnd: spec.periodEnd, periodType: spec.periodType, scope: spec.scope, evidenceRef: evidenceFor(spec.publicationAt).ref, sourcePointer: "table row=" + spec.rowLabel + "; column=" + spec.columnHeader + "; headers=" + JSON.stringify(spec.tableHeaders), supersedes: null });
  }
  return { evidence, reports, facts, excludedAccessions: [], exclusions: [] };
}

export interface DeclaredItem { id: string; documentId: string; issuerId: string; identifier: { scheme: "CIK" | "LEI" | "ISIN"; value: string }; url: string; contentHash: string; published: ResearchEvidence["published"]; title: string; occurs?: ResearchEvidence["published"]; kind?: "earnings" | "material" | "other" }
export interface DeclaredEvidenceInput { sourceId: string; sourceUrl: string; fetchedAt: string; contentHash: string; role: "news" | "calendar"; complete: boolean; windowStart: string; windowEnd: string; occurrenceWindowStart?: string; occurrenceWindowEnd?: string; items: DeclaredItem[] }
export function normalizeDeclaredEvidence(input: DeclaredEvidenceInput, policy: ResearchInstrumentPolicy): { evidence: ResearchEvidence[]; news: { id: string; evidenceRef: string; title: string }[]; events: { id: string; kind: "earnings" | "material" | "other"; occurs: ResearchEvidence["published"]; evidenceRef: string; title: string }[]; coverage: ResearchSourceResult } {
  if (!iso(input.fetchedAt) || !iso(input.windowStart) || !iso(input.windowEnd) || Date.parse(input.windowStart) > Date.parse(input.windowEnd) || Date.parse(input.windowEnd) > Date.parse(input.fetchedAt) || !/^https:\/\//.test(input.sourceUrl) || !/^[a-f0-9]{64}$/i.test(input.contentHash)) throw new Error("invalid declared evidence window");
  const hasOccurrenceRange = input.occurrenceWindowStart !== undefined || input.occurrenceWindowEnd !== undefined;
  if (hasOccurrenceRange && (input.role !== "calendar" || !iso(input.occurrenceWindowStart) || !iso(input.occurrenceWindowEnd) || Date.parse(input.occurrenceWindowStart) > Date.parse(input.occurrenceWindowEnd))) throw new Error("invalid calendar occurrence window");
  const source = policy.sources.find(s => s.id === input.sourceId); if (!source || source.parserConfig.kind !== "declared-evidence" || !source.urls.includes(input.sourceUrl) || !source.roles.includes(input.role) || !policy.identifiers.some(i => i.scheme === source.issuerIdentifier.scheme && i.value === source.issuerIdentifier.value)) throw new Error("undeclared evidence source");
  const evidence: ResearchEvidence[] = [], news: { id: string; evidenceRef: string; title: string }[] = [], events: { id: string; kind: "earnings" | "material" | "other"; occurs: ResearchEvidence["published"]; evidenceRef: string; title: string }[] = [];
  const seen = new Map<string, string>();
  for (const item of input.items) {
    if (input.role === "calendar") {
      if (!item.occurs) throw new Error("calendar occurrence missing");
      const range = publicationRange(canonicalPublication(item.occurs));
      if (hasOccurrenceRange && (range.start < Date.parse(input.occurrenceWindowStart!) || range.end > Date.parse(input.occurrenceWindowEnd!))) throw new Error("calendar occurrence outside window");
      if (!["earnings", "material", "other"].includes(item.kind ?? "")) throw new Error("calendar kind invalid");
    }
    const pub = item.published;
    let validZone = false; if (pub.precision === "date" && typeof pub.timeZone === "string") { try { new Intl.DateTimeFormat("en", { timeZone: pub.timeZone }); validZone = true; } catch { validZone = false; } }
    if (item.issuerId !== policy.issuerId || !policy.identifiers.some(i => i.scheme === item.identifier.scheme && i.value === item.identifier.value) || !/^https:\/\//.test(item.url) || !source.urls.includes(item.url) || !item.documentId || !item.id || !item.title || item.title.length > 500 || !/^[a-f0-9]{64}$/i.test(item.contentHash) || (pub.precision === "instant" ? !iso(pub.at) || Date.parse(pub.at) > Date.parse(input.fetchedAt) || Date.parse(pub.at) < Date.parse(input.windowStart) || Date.parse(pub.at) > Date.parse(input.windowEnd) : !date(pub.date) || Date.parse(pub.date + "T00:00:00Z") > Date.parse(input.fetchedAt) || !validZone) || (input.role === "calendar" && !item.kind)) throw new Error("invalid or foreign declared evidence item");
    const sig = JSON.stringify(item), prior = seen.get(item.documentId); if (prior && prior !== sig) throw new Error("conflicting duplicate document ID"); if (prior) continue; seen.set(item.documentId, sig);
    const ref = "ev_" + idPart(input.sourceId) + "_" + idPart(item.id), title = item.title.replace(/[\u0000-\u001f]/g, " ").slice(0, 500);
    evidence.push({ ref, sourceId: input.sourceId, documentId: item.documentId, url: item.url, contentHash: item.contentHash, issuerId: policy.issuerId, issuerIdentifier: item.identifier, published: canonicalPublication(pub), fetchedAt: new Date(input.fetchedAt).toISOString(), observedAt: new Date(input.fetchedAt).toISOString(), automation: source.automation, retention: source.retention });
    if (input.role === "news") news.push({ id: item.id, evidenceRef: ref, title }); else events.push({ id: item.id, kind: item.kind!, occurs: canonicalPublication(item.occurs!), evidenceRef: ref, title });
  }
  const complete = input.complete && (input.role !== "calendar" || hasOccurrenceRange);
  const coverage: ResearchSourceResult = { sourceId: input.sourceId, role: input.role, status: !complete ? "UNVERIFIED" : input.items.length === 0 ? "EMPTY" : "AVAILABLE", checkedAt: new Date(input.windowEnd).toISOString(), windowStart: new Date(input.windowStart).toISOString(), windowEnd: new Date(input.windowEnd).toISOString(),
    ...(hasOccurrenceRange ? { occurrenceWindowStart: new Date(input.occurrenceWindowStart!).toISOString(), occurrenceWindowEnd: new Date(input.occurrenceWindowEnd!).toISOString() } : {}),
    complete, evidenceRefs: evidence.map(e => e.ref), reason: "declared-evidence fixture; not provider or permission verification" };
  return { evidence, news, events, coverage };
}

export type NormalizedResearchSource = NormalizedReports | ReturnType<typeof normalizeDeclaredEvidence>;
/** Dispatch using the source's immutable, code-reviewed parserConfig; this function performs no I/O. */
export function normalizeResearchSource(policy: ResearchInstrumentPolicy, source: ResearchSource, payload: unknown, fetchedAt: string, sourceUrl: string, contentHash: string): NormalizedResearchSource {
  const configured = policy.sources.find(s => s.id === source.id);
  let sourceMatches = false;
  try { sourceMatches = Boolean(configured) && researchHash(source) === researchHash(configured); } catch { sourceMatches = false; }
  if (!sourceMatches || !source.urls.includes(sourceUrl) || !/^https:\/\//.test(sourceUrl) || !/^[a-f0-9]{64}$/i.test(contentHash)) throw new Error("source request does not match configured identity");
  const config = source.parserConfig as Record<string, unknown>;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("parserConfig malformed");
  if (config.kind === "sec-json") {
    if (source.adapter !== "sec-json" || source.issuerIdentifier.scheme !== "CIK") throw new Error("SEC parser configuration mismatch");
    const body = obj(payload);
    return normalizeSecReports(body.submissions, body.companyfacts, {
      ...(config as unknown as Omit<SecMapping, "sourceId" | "sourceUrl" | "contentHash" | "expectedCik" | "legalName" | "reportingCurrency">),
      sourceId: source.id, sourceUrl, contentHash, expectedCik: source.issuerIdentifier.value, legalName: policy.legalName, reportingCurrency: policy.reportingCurrency
    }, fetchedAt, policy);
  }
  if (config.kind === "issuer-xhtml") {
    if (source.adapter !== "issuer-document") throw new Error("issuer document parser configuration mismatch");
    if (typeof payload !== "string") throw new Error("issuer XHTML payload must be text");
    return normalizeIssuerXhtml(payload, {
      ...(config as unknown as Omit<XhtmlMapping, "sourceId" | "sourceUrl" | "contentHash" | "issuerIdentifier">),
      sourceId: source.id, sourceUrl, contentHash, issuerIdentifier: source.issuerIdentifier
    }, policy, fetchedAt);
  }
  if (config.kind === "declared-evidence") {
    if (source.adapter !== "issuer-document") throw new Error("declared evidence parser configuration mismatch");
    return normalizeDeclaredEvidence({ ...obj(payload), sourceId: source.id, sourceUrl, fetchedAt, contentHash } as unknown as DeclaredEvidenceInput, policy);
  }
  throw new Error("unsupported configured research parser");
}
