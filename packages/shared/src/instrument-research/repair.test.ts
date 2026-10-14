import assert from "node:assert/strict";
import { test } from "node:test";
import { researchFixture } from "./research.fixture.js";
import { inspectResearch } from "./repair.js";
import { marketauxSourceUrl, type MarketauxNewsConfig } from "./marketaux.js";
import { researchHash } from "./validation.js";

const now = Date.parse("2026-10-12T12:00:00Z");
function fixture() {
  const f = researchFixture(now);
  f.manifest.refreshEnabled = true;
  f.policy.sources[0].parserConfig = { kind: "sec-json" };
  const stored = () => { f.snapshot.manifestHash = researchHash(f.manifest); f.snapshot.mappingHash = researchHash(f.policy); return { id: "fixture", hash: researchHash(f.snapshot), sequence: 1, snapshot: f.snapshot }; };
  return { ...f, inspect: () => inspectResearch(f.manifest, f.policy.instrumentId, stored(), now) };
}
test("repair inspection permits intact cached evidence without requiring provider work", () => {
  const f = fixture(); f.policy.sources[0].maxRequestsPerDay = 0;
  assert.equal(f.inspect().state, "READY");
});
test("absent known report coverage waits; successfully fetched missing content holds", () => {
  const f = fixture();
  f.snapshot.coverage = f.snapshot.coverage.filter(c => c.role !== "reports");
  f.snapshot.reports = []; f.snapshot.facts = []; f.snapshot.evidence = [];
  assert.equal(f.inspect().state, "WAITING");
  f.snapshot.coverage.push({ sourceId: "official", role: "reports", status: "MISSING", checkedAt: f.snapshot.createdAt, windowStart: f.snapshot.createdAt, windowEnd: f.snapshot.createdAt, complete: false, evidenceRefs: [], reason: "no configured reports found" });
  assert.equal(f.inspect().state, "HOLD");
});
test("stale report check is repairable but future coverage, conflicting facts and mapping deadlines hold", () => {
  const stale = fixture(); stale.snapshot.coverage[0].checkedAt = new Date(now - 86_400_001).toISOString(); stale.snapshot.coverage[0].windowEnd = stale.snapshot.coverage[0].checkedAt;
  assert.equal(stale.inspect().state, "WAITING");
  const future = fixture(); future.snapshot.coverage[0].windowEnd = new Date(now + 1000).toISOString();
  assert.equal(future.inspect().state, "HOLD");
  const conflict = fixture(); conflict.snapshot.facts.push({ ...conflict.snapshot.facts[0], id: "conflicting" });
  assert.equal(conflict.inspect().state, "HOLD");
  const expired = fixture(); expired.policy.annual.nextPublicationDeadline = new Date(now).toISOString();
  assert.ok(expired.inspect().reasons.includes("RESEARCH_EXPECTED_REPORT_OVERDUE"));
});
test("permission, disabled refresh, unsupported source and zero capacity never enqueue a repair", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.policy.sources[0].automation = "UNVERIFIED"; },
    (f: ReturnType<typeof fixture>) => { f.manifest.refreshEnabled = false; },
    (f: ReturnType<typeof fixture>) => { f.policy.sources[0].parserConfig = {}; },
    (f: ReturnType<typeof fixture>) => { f.policy.sources[0].maxRequestsPerDay = 0; },
  ]) {
    const f = fixture(); f.snapshot.coverage = f.snapshot.coverage.filter(c => c.role !== "reports"); f.snapshot.evidence = []; f.snapshot.reports = []; f.snapshot.facts = []; change(f);
    assert.equal(f.inspect().state, "HOLD");
  }
});

function budgetFixture() {
  const f = researchFixture(now);
  f.manifest.refreshEnabled = true;
  f.policy.sources[0].roles = ["reports", "calendar"];
  const source = { ...structuredClone(f.policy.sources[0]), id: "marketaux", provider: "https://api.marketaux.com", adapter: "marketaux-news" as const, roles: ["news" as const],
    urls: ["https://api.marketaux.com/v1/news/all?symbols=FIXTURE&filter_entities=true&group_similar=false&language=en&limit=2"],
    parserConfig: { kind: "marketaux-news-v1", entity: { symbol: "FIXTURE", name: "Synthetic Issuer", type: "equity", country: "us", exchange: null },
      qualification: { outcome: "VERIFIED", verifiedAt: new Date(now - 172800000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), evidenceUrl: "https://api.marketaux.com/v1/entity/search?symbols=FIXTURE", receiptHash: "a".repeat(64), issuerIdentifier: f.policy.identifiers[0], conId: f.policy.listing.conId },
      entitlement: { outcome: "VERIFIED", verifiedAt: new Date(now - 172800000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), evidenceUrl: "https://www.marketaux.com/pricing", receiptHash: "b".repeat(64), maxArticlesPerRequest: 100, maxRequestsPerDay: 1000, maxCostMicrosPerDay: 1000 }, pageSize: 2, maxPagesPerPass: 10, maxArticles: 20 } };
  source.urls = [marketauxSourceUrl(source.parserConfig as unknown as MarketauxNewsConfig)];
  f.policy.sources.push(source);
  f.snapshot.coverage = f.snapshot.coverage.filter(c => c.role !== "news");
  const slot = Math.floor((now - 86400000) / 900000), checkedAt = new Date(slot * 900000 - 1000).toISOString();
  const coverage = { sourceId: source.id, role: "news" as const, status: "ERROR" as const, checkedAt, windowStart: new Date(Date.parse(checkedAt) - 86400000).toISOString(), windowEnd: checkedAt, complete: false, evidenceRefs: [], reason: "RESEARCH_BUDGET_EXHAUSTED" };
  f.snapshot.coverage.push(coverage);
  f.snapshot.manifestHash = researchHash(f.manifest); f.snapshot.mappingHash = researchHash(f.policy);
  const stored = { id: "budget-snapshot", hash: researchHash(f.snapshot), sequence: 1, snapshot: f.snapshot };
  const assessment = { snapshotId: stored.id, sourceId: source.id, coverageHash: researchHash(coverage), slot, failedBudgetDay: "2026-10-11", failureRecordedAt: new Date(slot * 900000 + 1000).toISOString(), nextCheckAt: new Date(now).toISOString() };
  return { ...f, source, coverage, stored, assessment, inspect: () => inspectResearch(f.manifest, f.policy.instrumentId, stored, now, [], [assessment]) };
}

test("local budget error needs exact store assessment and only grants fresh research WAITING", () => {
  const f = budgetFixture();
  const held = inspectResearch(f.manifest, f.policy.instrumentId, f.stored, now);
  assert.equal(held.state, "HOLD");
  assert.equal(held.sources.find(s => s.sourceId === f.source.id)?.failureReason, "RESEARCH_BUDGET_EXHAUSTED");
  const result = f.inspect();
  assert.equal(result.state, "WAITING", JSON.stringify(result));
  assert.ok(result.reasons.includes("RESEARCH_MARKETAUX_BUDGET_RENEWED"));
  assert.equal(result.sources.find(s => s.sourceId === f.source.id)?.failureReason, "RESEARCH_BUDGET_EXHAUSTED");
  assert.equal(f.coverage.complete, false);
});

for (const change of ["snapshot", "source", "hash", "slot", "day", "recorded", "next", "http", "reason", "permission", "refresh", "zero", "qualification", "other-source"] as const) {
  test(`budget recovery does not bypass ${change}`, () => {
    const f = budgetFixture();
    if (change === "snapshot") f.assessment.snapshotId = "other";
    if (change === "source") f.assessment.sourceId = "other";
    if (change === "hash") f.assessment.coverageHash = "f".repeat(64);
    if (change === "slot") f.assessment.slot++;
    if (change === "day") f.assessment.failedBudgetDay = "2026-10-12";
    if (change === "recorded") f.assessment.failureRecordedAt = new Date(now).toISOString();
    if (change === "next") f.assessment.nextCheckAt = "not a date";
    if (change === "http") Object.assign(f.coverage, { sourceError: { httpStatus: 429 } });
    if (change === "reason") f.coverage.reason = "RESEARCH_SOURCE_HTTP_401";
    if (change === "permission") f.source.automation = "UNVERIFIED";
    if (change === "refresh") f.manifest.refreshEnabled = false;
    if (change === "zero") f.source.maxRequestsPerDay = 0;
    if (change === "qualification") f.source.parserConfig.qualification.expiresAt = new Date(now - 1000).toISOString();
    if (change === "other-source") f.snapshot.coverage[0].complete = false;
    assert.equal(f.inspect().state, "HOLD");
  });
}
