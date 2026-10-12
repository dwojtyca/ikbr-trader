import assert from "node:assert/strict";
import { test } from "node:test";
import { researchFixture } from "./research.fixture.js";
import { inspectResearch } from "./repair.js";
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
