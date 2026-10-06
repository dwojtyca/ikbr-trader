import { z } from "zod";
import { researchHash, type ResearchFact, type ResearchInstrumentPolicy, type ResearchSource } from "@ikbr/shared/instrument-research";
import type { NormalizedReports } from "./research-providers.js";
import { PDF_RESEARCH_LIMITS, type PdfRectangle, type PdfTextDocument, type PdfTextItem, type PdfTextPage } from "./research-pdf-types.js";

const text = z.string().min(1).max(500).refine(value => value.trim() === value && !/[\u0000-\u001f]/.test(value));
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const timestamp = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
});
const instant = z.string().datetime({ offset: true }).refine(value => date.safeParse(value.slice(0, 10)).success);
const https = z.string().max(2000).url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
});
const coordinate = z.number().finite().min(0).max(20_000);
const rectangle = z.object({ left: coordinate, top: coordinate, right: coordinate, bottom: coordinate }).strict()
  .refine(rect => rect.left < rect.right && rect.top < rect.bottom);
const marker = z.object({ text, rect: rectangle }).strict();
const metric = z.enum(["net_interest_income", "net_profit", "loans", "deposits", "cet1_ratio", "tier1_ratio", "revenue", "net_income", "operating_cash_flow", "total_debt"]);
const column = z.object({
  id, header: marker, left: coordinate, right: coordinate, periodStart: date.nullable(), periodEnd: date,
}).strict();
const fact = z.object({
  metric, row: marker, columnId: id, unit: z.enum(["currency", "percent"]), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  scale: z.number().finite().positive().max(1_000_000_000), periodType: z.enum(["instant", "duration"]),
}).strict();
const table = z.object({ id, title: marker, columns: z.array(column).min(1).max(12), facts: z.array(fact).min(1).max(10) }).strict();
const page = z.object({
  pageNumber: z.number().int().min(1).max(PDF_RESEARCH_LIMITS.maxPages), width: coordinate.positive(), height: coordinate.positive(),
  markers: z.object({ issuer: marker, period: marker, unit: marker.extend({ currency: z.string().regex(/^[A-Z]{3}$/), scale: z.number().finite().positive().max(1_000_000_000) }).strict() }).strict(), tables: z.array(table).min(1).max(10),
}).strict();
const provenance = z.object({
  url: https, documentSha256: sha, pointer: z.string().min(1).max(1000), sourceClass: z.enum(["consolidated-financial-report", "prudential-disclosure", "derivative-workbook"]),
}).strict();
const comparison = provenance.extend({ value: z.number().finite(), unit: z.enum(["percent", "decimal"]) }).strict();
const authority = z.object({
  id, version: z.literal(1), metric: z.enum(["cet1_ratio", "tier1_ratio"]), periodEnd: date, scope: z.literal("consolidated"),
  selected: provenance, conflicting: comparison, corroborating: comparison, observedAt: instant, rationale: text,
}).strict();
const mappingSchema = z.object({
  kind: z.literal("issuer-pdf-table"), documentSha256: sha, pageCount: z.number().int().min(1).max(PDF_RESEARCH_LIMITS.maxPages),
  issuerId: id, legalName: text, issuerIdentifier: z.object({ scheme: z.enum(["CIK", "LEI", "ISIN"]), value: text }).strict(),
  report: z.object({ kind: z.enum(["annual", "periodic"]), periodStart: date, periodEnd: date, scope: z.literal("consolidated"),
    publishedAt: instant, publicationEvidenceUrl: https }).strict(),
  pages: z.array(page).min(1).max(PDF_RESEARCH_LIMITS.maxSelectedPages), authorityDecisions: z.array(authority).max(1),
}).strict();

export type IssuerPdfMapping = z.infer<typeof mappingSchema>;
type PdfFactMapping = z.infer<typeof fact>;
type PdfTableMapping = z.infer<typeof table>;

function requirePdf(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error("RESEARCH_PDF_" + code);
}

const contains = (outer: PdfRectangle, inner: PdfRectangle) => inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
const overlaps = (a: PdfRectangle, b: PdfRectangle) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const unique = (values: (string | number)[]) => new Set(values).size === values.length;
const whitespace = (value: string) => value.replace(/\s+/g, " ").trim();

function cellRectangle(tableMapping: PdfTableMapping, spec: PdfFactMapping): PdfRectangle {
  const selected = tableMapping.columns.find(item => item.id === spec.columnId);
  requirePdf(selected, "COLUMN_MISSING");
  return { left: selected.left, right: selected.right, top: spec.row.rect.top, bottom: spec.row.rect.bottom };
}

function factPointer(pageNumber: number, tableMapping: PdfTableMapping, spec: PdfFactMapping): string {
  const col = tableMapping.columns.find(item => item.id === spec.columnId)!;
  const cell = cellRectangle(tableMapping, spec);
  return `pdf:page=${pageNumber};table=${tableMapping.id};row=${spec.row.text};column=${col.header.text};cell=[${cell.left},${cell.top},${cell.right},${cell.bottom}]`;
}

export function parseIssuerPdfMapping(input: unknown): IssuerPdfMapping {
  const parsed = mappingSchema.safeParse(input);
  requirePdf(parsed.success, "MAPPING_INVALID");
  const mapping = parsed.data;
  requirePdf(mapping.report.periodStart <= mapping.report.periodEnd && mapping.report.periodEnd <= mapping.report.publishedAt.slice(0, 10), "REPORT_DATES_INVALID");
  requirePdf(unique(mapping.pages.map(item => item.pageNumber)), "DUPLICATE_PAGE");
  const metrics: string[] = [];
  const tableIds: string[] = [];
  for (const spec of mapping.pages) {
    requirePdf(spec.pageNumber <= mapping.pageCount, "PAGE_OUT_OF_RANGE");
    const bounds = { left: 0, top: 0, right: spec.width, bottom: spec.height };
    const regions = Object.values(spec.markers).map(value => value.rect);
    for (const tbl of spec.tables) {
      tableIds.push(tbl.id);
      requirePdf(unique(tbl.columns.map(item => item.id)), "DUPLICATE_COLUMN");
      regions.push(tbl.title.rect, ...tbl.columns.map(item => item.header.rect));
      for (const col of tbl.columns) {
        requirePdf(col.left < col.right && col.right <= spec.width && col.header.rect.left >= col.left && col.header.rect.right <= col.right &&
          (col.periodStart === null || col.periodStart <= col.periodEnd), "COLUMN_INVALID");
        for (const other of tbl.columns) if (col !== other) requirePdf(col.left >= other.right || other.left >= col.right, "OVERLAPPING_COLUMNS");
      }
      for (const item of tbl.facts) {
        metrics.push(item.metric);
        const col = tbl.columns.find(value => value.id === item.columnId);
        requirePdf(col, "COLUMN_MISSING");
        requirePdf(col.periodEnd === mapping.report.periodEnd && (item.periodType === "duration" ? col.periodStart === mapping.report.periodStart : col.periodStart === null), "FACT_PERIOD_MISMATCH");
        requirePdf(item.unit === "currency" ? item.currency !== null : item.currency === null && item.scale === 1, "FACT_UNIT_INVALID");
        if (item.unit === "currency") requirePdf(item.currency === spec.markers.unit.currency && item.scale === spec.markers.unit.scale, "PAGE_UNIT_MISMATCH");
        regions.push(item.row.rect, cellRectangle(tbl, item));
      }
    }
    for (let i = 0; i < regions.length; i++) {
      requirePdf(contains(bounds, regions[i]), "REGION_OUT_OF_BOUNDS");
      for (let j = 0; j < i; j++) requirePdf(!overlaps(regions[i], regions[j]), "OVERLAPPING_REGIONS");
    }
  }
  requirePdf(unique(metrics) && unique(tableIds), "DUPLICATE_FACT_OR_TABLE");
  const ratioMetrics = metrics.filter(value => value === "cet1_ratio" || value === "tier1_ratio");
  requirePdf(mapping.authorityDecisions.length === ratioMetrics.length, "AUTHORITY_REQUIRED");
  for (const decision of mapping.authorityDecisions) {
    requirePdf(ratioMetrics.includes(decision.metric) && decision.periodEnd === mapping.report.periodEnd && decision.scope === mapping.report.scope &&
      decision.selected.documentSha256 === mapping.documentSha256 && decision.selected.sourceClass === "consolidated-financial-report" &&
      decision.conflicting.sourceClass === "derivative-workbook" && decision.corroborating.sourceClass === "prudential-disclosure" &&
      unique([decision.selected.documentSha256, decision.conflicting.documentSha256, decision.corroborating.documentSha256]) &&
      Date.parse(decision.observedAt) >= Date.parse(mapping.report.publishedAt), "AUTHORITY_INVALID");
    const mapped = mapping.pages.flatMap(p => p.tables.flatMap(t => t.facts.filter(f => f.metric === decision.metric).map(f => factPointer(p.pageNumber, t, f))));
    requirePdf(mapped.length === 1 && mapped[0] === decision.selected.pointer, "AUTHORITY_POINTER_MISMATCH");
  }
  return mapping;
}

function selectedItems(pageValue: PdfTextPage, rect: PdfRectangle): PdfTextItem[] {
  const selected = pageValue.items.filter(item => item.text.trim() && overlaps(item, rect));
  requirePdf(selected.length > 0 && selected.length <= 100, "CELL_MISSING_OR_UNBOUNDED");
  for (let i = 0; i < selected.length; i++) {
    requirePdf(contains(rect, selected[i]), "TEXT_CROSSES_CELL");
    for (let j = 0; j < i; j++) requirePdf(!overlaps(selected[i], selected[j]), "OVERLAPPING_TEXT");
  }
  return selected.sort((a, b) => a.top - b.top || a.left - b.left);
}

function checkMarker(pageValue: PdfTextPage, spec: z.infer<typeof marker>): void {
  requirePdf(whitespace(selectedItems(pageValue, spec.rect).map(item => item.text).join(" ")) === whitespace(spec.text), "MARKER_MISMATCH");
}

function numericCell(pageValue: PdfTextPage, rect: PdfRectangle, unit: PdfFactMapping["unit"]): number {
  const items = selectedItems(pageValue, rect);
  requirePdf(items.length === 1, "AMBIGUOUS_VALUE");
  let value = whitespace(items[0].text);
  if (unit === "percent" && value.endsWith("%")) value = value.slice(0, -1).trim();
  const negative = value.startsWith("(") && value.endsWith(")");
  if (negative) value = value.slice(1, -1);
  requirePdf(/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{0,2}(?: \d{3})+)(?:\.\d+)?$/.test(value), "NUMBER_INVALID");
  const result = Number(value.replace(/[, ]/g, "")) * (negative ? -1 : 1);
  requirePdf(Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER, "NUMBER_OUT_OF_RANGE");
  return result;
}

function validateDocument(document: PdfTextDocument, mapping: IssuerPdfMapping): void {
  requirePdf(document && document.pageCount === mapping.pageCount && Array.isArray(document.pages) && document.pages.length === mapping.pages.length &&
    unique(document.pages.map(p => p.pageNumber)), "DOCUMENT_PAGES_MISMATCH");
  let count = 0, bytes = 0;
  for (const p of document.pages) {
    const spec = mapping.pages.find(value => value.pageNumber === p.pageNumber);
    requirePdf(spec && p.width === spec.width && p.height === spec.height && Array.isArray(p.items), "PAGE_GEOMETRY_MISMATCH");
    const bounds = { left: 0, top: 0, right: p.width, bottom: p.height };
    for (const item of p.items) {
      count++;
      requirePdf(typeof item.text === "string" && [item.left, item.right, item.top, item.bottom].every(Number.isFinite), "TEXT_GEOMETRY_INVALID");
      bytes += Buffer.byteLength(item.text, "utf8");
      requirePdf(count <= PDF_RESEARCH_LIMITS.maxTextItems && bytes <= PDF_RESEARCH_LIMITS.maxTextBytes, "TEXT_LIMIT");
      if (!item.text.trim()) continue;
      requirePdf(item.left < item.right && item.top < item.bottom && contains(bounds, item), "TEXT_GEOMETRY_INVALID");
    }
  }
}

function percent(value: z.infer<typeof comparison>): number { return value.unit === "decimal" ? value.value * 100 : value.value; }

export function normalizeIssuerPdf(document: PdfTextDocument, input: IssuerPdfMapping, policy: ResearchInstrumentPolicy,
  source: ResearchSource, fetchedAt: string, sourceUrl: string, contentHash: string): NormalizedReports {
  const mapping = parseIssuerPdfMapping(input);
  const configured = policy.sources.filter(item => item.id === source.id);
  requirePdf(configured.length === 1 && researchHash(configured[0]) === researchHash(source) && researchHash(source.parserConfig) === researchHash(mapping) &&
    source.adapter === "issuer-document" && source.roles.includes("reports") && source.urls.includes(sourceUrl) && https.safeParse(sourceUrl).success &&
    new URL(sourceUrl).origin === source.provider, "SOURCE_IDENTITY_MISMATCH");
  requirePdf(mapping.issuerId === policy.issuerId && mapping.legalName === policy.legalName &&
    researchHash(mapping.issuerIdentifier) === researchHash(source.issuerIdentifier) && policy.identifiers.some(item => researchHash(item) === researchHash(source.issuerIdentifier)), "ISSUER_IDENTITY_MISMATCH");
  requirePdf(sha.safeParse(contentHash).success && contentHash === mapping.documentSha256, "DOCUMENT_HASH_MISMATCH");
  requirePdf(instant.safeParse(fetchedAt).success && Date.parse(mapping.report.publishedAt) <= Date.parse(fetchedAt), "PUBLICATION_INVALID");
  const expected = policy[mapping.report.kind];
  requirePdf(expected.periodStart === mapping.report.periodStart && expected.periodEnd === mapping.report.periodEnd && expected.scope === mapping.report.scope, "REPORT_POLICY_MISMATCH");
  const expectedMetrics = policy.profile === "bank" ? ["net_interest_income", "net_profit", "loans", "deposits", policy.bankCapitalMetric] :
    policy.profile === "industrial" ? ["revenue", "net_income", "operating_cash_flow", "total_debt"] : [];
  const specs = mapping.pages.flatMap(p => p.tables.flatMap(t => t.facts));
  requirePdf(expectedMetrics.length > 0 && specs.length === expectedMetrics.length && specs.every(spec => expectedMetrics.includes(spec.metric)), "METRIC_POLICY_MISMATCH");
  for (const spec of specs) {
    const ratio = spec.metric === "cet1_ratio" || spec.metric === "tier1_ratio";
    const isInstant = ratio || ["loans", "deposits", "total_debt"].includes(spec.metric);
    requirePdf(spec.periodType === (isInstant ? "instant" : "duration") && (ratio ? spec.unit === "percent" && spec.scale === 1 && spec.currency === null :
      spec.unit === "currency" && spec.currency === policy.reportingCurrency), "METRIC_UNIT_OR_PERIOD_MISMATCH");
  }
  validateDocument(document, mapping);
  const suffix = researchHash({ sourceId: source.id, contentHash, kind: mapping.report.kind });
  const ref = "ev_pdf_" + suffix, reportId = "report_pdf_" + suffix;
  const facts: ResearchFact[] = [];
  for (const pageSpec of mapping.pages) {
    const pageValue = document.pages.find(item => item.pageNumber === pageSpec.pageNumber)!;
    for (const mark of Object.values(pageSpec.markers)) checkMarker(pageValue, mark);
    for (const tbl of pageSpec.tables) {
      checkMarker(pageValue, tbl.title);
      for (const col of tbl.columns) checkMarker(pageValue, col.header);
      for (const spec of tbl.facts) {
        checkMarker(pageValue, spec.row);
        const value = numericCell(pageValue, cellRectangle(tbl, spec), spec.unit);
        facts.push({ id: "fact_pdf_" + suffix + "_" + spec.metric, reportId, metric: spec.metric, value, unit: spec.unit, currency: spec.currency, scale: spec.scale,
          periodStart: spec.periodType === "duration" ? mapping.report.periodStart : null, periodEnd: mapping.report.periodEnd, periodType: spec.periodType,
          scope: mapping.report.scope, evidenceRef: ref, sourcePointer: factPointer(pageSpec.pageNumber, tbl, spec), supersedes: null });
      }
    }
  }
  for (const decision of mapping.authorityDecisions) {
    const selected = facts.find(item => item.metric === decision.metric)!;
    requirePdf(decision.selected.url === sourceUrl && Date.parse(decision.observedAt) <= Date.parse(fetchedAt) &&
      Math.abs(percent(decision.corroborating) - selected.value) <= 1e-10 && Math.abs(percent(decision.conflicting) - selected.value) > 1e-10, "AUTHORITY_FACT_MISMATCH");
  }
  const canonicalFetchedAt = new Date(fetchedAt).toISOString();
  return {
    evidence: [{ ref, sourceId: source.id, documentId: source.id + ":" + contentHash, url: sourceUrl, contentHash, issuerId: policy.issuerId,
      issuerIdentifier: source.issuerIdentifier, published: { precision: "instant", at: new Date(mapping.report.publishedAt).toISOString() },
      fetchedAt: canonicalFetchedAt, observedAt: canonicalFetchedAt, automation: source.automation, retention: source.retention }],
    reports: [{ id: reportId, kind: mapping.report.kind, periodStart: mapping.report.periodStart, periodEnd: mapping.report.periodEnd,
      scope: mapping.report.scope, evidenceRef: ref, supersedes: null }], facts, excludedAccessions: [], exclusions: [],
  };
}
