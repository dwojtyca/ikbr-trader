import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseResearchSnapshot, researchHash, type ResearchManifestV1 } from "@ikbr/shared/instrument-research";
import { issuerPdfFixture } from "./research-pdf-fixture.js";
import { normalizeIssuerPdf, parseIssuerPdfMapping, type IssuerPdfMapping } from "./research-pdf-mapping.js";
import type { PdfTextItem } from "./research-pdf-types.js";

type Fixture = ReturnType<typeof issuerPdfFixture>;
const run = (f: Fixture) => normalizeIssuerPdf(f.document, f.mapping, f.policy, f.source, f.fetchedAt, f.source.urls[0], f.mapping.documentSha256);
const find = (f: Fixture, text: string): PdfTextItem => f.document.pages.flatMap(page => page.items).find(item => item.text === text)!;

test("PDF mapping extracts arbitrary values, exact H1/current columns, wrapped parent profit, and single monetary scale", () => {
  const f = issuerPdfFixture(), result = run(f);
  assert.deepEqual(result.facts.map(fact => [fact.metric, fact.value]), [["net_interest_income", 23456], ["net_profit", -7654], ["loans", 123456], ["deposits", 987654], ["tier1_ratio", 18.25]]);
  assert.equal(result.reports.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.ok(result.facts.slice(0, 4).every(fact => fact.unit === "currency" && fact.currency === "PLN" && fact.scale === 1_000_000));
  assert.equal(result.facts[0].value * result.facts[0].scale, 23_456_000_000);
  assert.ok(result.facts.slice(2).every(fact => fact.periodStart === null && fact.periodType === "instant"));
  assert.ok(result.facts.slice(0, 2).every(fact => fact.periodStart === "2026-01-01" && fact.periodEnd === "2026-06-30"));
  assert.equal(result.facts[4].sourcePointer, f.mapping.authorityDecisions[0].selected.pointer);
  assert.equal(result.evidence[0].contentHash, f.mapping.documentSha256);
  assert.equal(result.evidence[0].automation, "UNVERIFIED");
  assert.deepEqual(result.evidence[0].published, { precision: "instant", at: "2026-08-12T22:03:00.000Z" });
  const again = run(f);
  assert.deepEqual(again, result);
  const manifest: ResearchManifestV1 = { ...JSON.parse(readFileSync(new URL("../../../config/research/paper.example.json", import.meta.url), "utf8")), instruments: [f.policy] };
  assert.doesNotThrow(() => parseResearchSnapshot({ schemaVersion: 1, configHash: manifest.configHash, manifestHash: researchHash(manifest), instrumentId: f.policy.instrumentId,
    mappingHash: researchHash(f.policy), createdAt: f.fetchedAt, evidence: result.evidence, reports: result.reports, facts: result.facts, coverage: [], news: [], events: [] }, manifest));
});

for (const [description, update] of [
  ["issuer", (f: Fixture) => { find(f, f.mapping.pages[0].markers.issuer.text).text = "OTHER BANK"; }],
  ["report period", (f: Fixture) => { find(f, f.mapping.pages[0].markers.period.text).text = "FOR THE SIX-MONTH PERIOD ENDED 30 JUNE 2025"; }],
  ["unit", (f: Fixture) => { find(f, "(IN PLN MILLION)").text = "(IN USD THOUSAND)"; }],
  ["table title", (f: Fixture) => { find(f, "Consolidated income statement").text = "Separate income statement"; }],
  ["quarter heading", (f: Fixture) => { find(f, "H1 2026").text = "Q2 2026"; }],
  ["prior-year heading", (f: Fixture) => { find(f, "H1 2025").text = "H1 2024"; }],
  ["restated heading", (f: Fixture) => { find(f, "31.12.2025 restated").text = "31.12.2025 published"; }],
  ["row label", (f: Fixture) => { find(f, "Loans and advances").text = "Amounts due from banks"; }],
  ["wrapped row suffix", (f: Fixture) => { find(f, "parent company").text = "other shareholders"; }],
] as const) test(`PDF mapping rejects wrong ${description}`, () => {
  const f = issuerPdfFixture(); update(f); assert.throws(() => run(f), /RESEARCH_PDF_MARKER_MISMATCH/);
});

test("PDF mapper accepts whitespace-only variations without fuzzy label matching", () => {
  const f = issuerPdfFixture(); find(f, "Loans and advances").text = "  Loans  and\tadvances  ";
  assert.equal(run(f).facts.find(fact => fact.metric === "loans")?.value, 123456);
});

for (const value of ["", "-", "NaN", "12,34", "1.234,56", "1 23", "1,234 567", "(1,234", "1,234)", "-1,234", "1e5", "12.3.4", "1,234%", "9007199254740992"]) {
  test(`PDF mapping rejects ambiguous numeric cell ${JSON.stringify(value)}`, () => {
    const f = issuerPdfFixture(); find(f, "23,456").text = value;
    assert.throws(() => run(f), /RESEARCH_PDF_(NUMBER|CELL)/);
  });
}

test("PDF mapping rejects duplicate, split, overlapping and boundary-crossing numeric cells", () => {
  const duplicate = issuerPdfFixture(); duplicate.document.pages[0].items.push({ ...find(duplicate, "23,456") });
  assert.throws(() => run(duplicate), /OVERLAPPING_TEXT/);
  const split = issuerPdfFixture(), item = find(split, "23,456"), right = item.right;
  item.right = item.left + 10; item.text = "23";
  split.document.pages[0].items.push({ ...item, left: item.right + 1, right, text: "456" });
  assert.throws(() => run(split), /AMBIGUOUS_VALUE/);
  const crossing = issuerPdfFixture(); find(crossing, "23,456").left = 345;
  assert.throws(() => run(crossing), /TEXT_CROSSES_CELL/);
  const missing = issuerPdfFixture(); missing.document.pages[0].items = missing.document.pages[0].items.filter(item => item.text !== "23,456");
  assert.throws(() => run(missing), /CELL_MISSING/);
});

for (const [description, update] of [
  ["unknown field", (m: IssuerPdfMapping) => Object.assign(m, { unchecked: true })],
  ["malformed date", (m: IssuerPdfMapping) => { m.report.periodStart = "2026-02-30"; }],
  ["date ordering", (m: IssuerPdfMapping) => { m.report.periodStart = "2026-07-01"; }],
  ["duplicate page", (m: IssuerPdfMapping) => { m.pages.push(structuredClone(m.pages[0])); }],
  ["duplicate table", (m: IssuerPdfMapping) => { m.pages[1].tables[0].id = m.pages[0].tables[0].id; }],
  ["duplicate column", (m: IssuerPdfMapping) => { m.pages[0].tables[0].columns[1].id = m.pages[0].tables[0].columns[0].id; }],
  ["duplicate metric", (m: IssuerPdfMapping) => { m.pages[0].tables[0].facts[1].metric = "net_interest_income"; }],
  ["overlapping columns", (m: IssuerPdfMapping) => { m.pages[0].tables[0].columns[1].left = 344; }],
  ["overlapping row regions", (m: IssuerPdfMapping) => { m.pages[0].tables[0].facts[1].row.rect = m.pages[0].tables[0].facts[0].row.rect; }],
  ["out-of-bounds region", (m: IssuerPdfMapping) => { m.pages[0].markers.issuer.rect.right = 700; }],
  ["inverted rectangle", (m: IssuerPdfMapping) => { m.pages[0].markers.issuer.rect.right = 20; }],
  ["nonfinite coordinate", (m: IssuerPdfMapping) => { m.pages[0].markers.issuer.rect.right = Infinity; }],
  ["quarterly selection", (m: IssuerPdfMapping) => { m.pages[0].tables[0].facts[0].columnId = "q2_2026"; }],
  ["prior-year selection", (m: IssuerPdfMapping) => { m.pages[0].tables[0].facts[0].columnId = "h1_2025"; }],
  ["wrong scale", (m: IssuerPdfMapping) => { m.pages[0].tables[0].facts[0].scale = 1; }],
  ["wrong currency", (m: IssuerPdfMapping) => { m.pages[0].tables[0].facts[0].currency = "USD"; }],
  ["unknown column", (m: IssuerPdfMapping) => { m.pages[0].tables[0].facts[0].columnId = "absent"; }],
  ["missing authority", (m: IssuerPdfMapping) => { m.authorityDecisions = []; }],
  ["authority pointer", (m: IssuerPdfMapping) => { m.authorityDecisions[0].selected.pointer = "wrong"; }],
  ["authority metric", (m: IssuerPdfMapping) => { m.authorityDecisions[0].metric = "cet1_ratio"; }],
  ["authority source class", (m: IssuerPdfMapping) => { m.authorityDecisions[0].selected.sourceClass = "derivative-workbook"; }],
  ["authority digest", (m: IssuerPdfMapping) => { m.authorityDecisions[0].selected.documentSha256 = "b".repeat(64); }],
] as const) test(`PDF mapping configuration rejects ${description}`, () => {
  const f = issuerPdfFixture(); update(f.mapping); assert.throws(() => parseIssuerPdfMapping(f.mapping), /RESEARCH_PDF_/);
});

test("PDF normalizer rejects detached mappings, foreign sources/issuers, wrong pin and invalid publication", () => {
  const f = issuerPdfFixture();
  assert.throws(() => normalizeIssuerPdf(f.document, f.mapping, f.policy, { ...f.source, id: "unconfigured" }, f.fetchedAt, f.source.urls[0], f.mapping.documentSha256), /SOURCE_IDENTITY/);
  assert.throws(() => normalizeIssuerPdf(f.document, f.mapping, { ...f.policy, legalName: "Other" }, f.source, f.fetchedAt, f.source.urls[0], f.mapping.documentSha256), /ISSUER_IDENTITY/);
  assert.throws(() => normalizeIssuerPdf(f.document, f.mapping, f.policy, f.source, f.fetchedAt, f.source.urls[0], "b".repeat(64)), /DOCUMENT_HASH/);
  assert.throws(() => normalizeIssuerPdf(f.document, f.mapping, f.policy, f.source, "2026-08-01T00:00:00Z", f.source.urls[0], f.mapping.documentSha256), /PUBLICATION/);
  assert.throws(() => normalizeIssuerPdf(f.document, f.mapping, f.policy, f.source, "2026-02-30T00:00:00Z", f.source.urls[0], f.mapping.documentSha256), /PUBLICATION/);
  const detached = structuredClone(f.mapping); detached.legalName = "Other";
  assert.throws(() => normalizeIssuerPdf(f.document, detached, f.policy, f.source, f.fetchedAt, f.source.urls[0], f.mapping.documentSha256), /SOURCE_IDENTITY/);
  const dates = issuerPdfFixture(); dates.policy.periodic.periodEnd = "2026-09-30";
  assert.throws(() => run(dates), /REPORT_POLICY/);
  const metric = issuerPdfFixture(); metric.policy.bankCapitalMetric = "cet1_ratio";
  assert.throws(() => run(metric), /METRIC_POLICY/);
});

test("PDF authority checks equivalent percent/decimal units against the extracted value and retains only current primary evidence", () => {
  const f = issuerPdfFixture(); f.mapping.authorityDecisions[0].corroborating.unit = "decimal"; f.mapping.authorityDecisions[0].corroborating.value = 0.1825;
  assert.equal(run(f).facts[4].value, 18.25);
  for (const update of [
    (f: Fixture) => { f.mapping.authorityDecisions[0].corroborating.unit = "decimal"; },
    (f: Fixture) => { f.mapping.authorityDecisions[0].corroborating.value = 18.24; },
    (f: Fixture) => { f.mapping.authorityDecisions[0].conflicting.value = 0.1825; },
    (f: Fixture) => { f.mapping.authorityDecisions[0].selected.url = "https://www.pkobp.pl/other.pdf"; },
    (f: Fixture) => { f.mapping.authorityDecisions[0].observedAt = "2026-10-07T00:00:00Z"; },
    (f: Fixture) => { find(f, "18.25").text = "18.26"; },
  ]) {
    const changed = issuerPdfFixture(); update(changed); assert.throws(() => run(changed), /AUTHORITY_FACT_MISMATCH/);
  }
  const result = run(f);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].url, f.source.urls[0]);
});

test("PDF extracted DTO rejects page/geometry/count/text bounds", () => {
  for (const update of [
    (f: Fixture) => { f.document.pageCount--; },
    (f: Fixture) => { f.document.pages.pop(); },
    (f: Fixture) => { f.document.pages[0].width++; },
    (f: Fixture) => { f.document.pages[0].items[0].left = NaN; },
    (f: Fixture) => { f.document.pages[0].items[0].left = -1; },
    (f: Fixture) => { f.document.pages[0].items[0].text = "x".repeat(1024 * 1024 + 1); },
    (f: Fixture) => { f.document.pages[0].items = Array.from({ length: 100001 }, () => ({ text: "", left: 0, right: 0, top: 0, bottom: 0 })); },
  ]) {
    const f = issuerPdfFixture(); update(f); assert.throws(() => run(f), /RESEARCH_PDF_(DOCUMENT|PAGE|TEXT)/);
  }
});

test("shipped PKO example keeps refresh, permissions and budgets disabled and authority data bound to its manifest hash", () => {
  const config: ResearchManifestV1 = JSON.parse(readFileSync(new URL("../../../config/research/paper.example.json", import.meta.url), "utf8"));
  assert.equal(config.refreshEnabled, false);
  assert.equal(config.model.maxRequestsPerDay, 0);
  for (const source of config.instruments.flatMap(item => item.sources)) {
    assert.equal(source.automation, "UNVERIFIED"); assert.equal(source.retention, "UNVERIFIED"); assert.equal(source.maxRequestsPerDay, 0); assert.equal(source.maxCostMicrosPerDay, 0);
  }
  const source = config.instruments[0].sources.find(item => item.id === "latest_periodic")!;
  const mapping = parseIssuerPdfMapping(source.parserConfig);
  assert.equal(mapping.authorityDecisions[0].conflicting.value, 0.1553);
  assert.equal(mapping.authorityDecisions[0].corroborating.value, 15.55);
  const hash = researchHash(config);
  source.parserConfig = { ...mapping, authorityDecisions: [] };
  assert.notEqual(researchHash(config), hash);
});
