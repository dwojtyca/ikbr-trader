import assert from "node:assert/strict";
import { test } from "node:test";
import { researchFixture } from "./research.fixture.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { parseResearchManifest, parseResearchSnapshot, publicationRange, researchHash, safeResearchUrl } from "./validation.js";

const now = Date.parse("2026-10-04T12:00:00Z");
test("bank, industrial and third configured stock use the same eligibility contract", () => {
  for (const id of ["pko_wse", "aapl_smart", "xyz_nyse"]) {
    const f = researchFixture(now, id); parseResearchManifest(f.manifest, f.config, f.configHash);
    assert.equal(evaluateResearchEligibility(f.snapshot, f.manifest, now).eligible, true);
  }
});
test("strict manifest binds full listing and rejects hidden fields, duplicate issuer mappings and untrusted URLs", () => {
  const f = researchFixture(now);
  assert.throws(() => parseResearchManifest({ ...f.manifest, surprise: true }, f.config, f.configHash));
  const wrong = structuredClone(f.manifest); wrong.instruments[0].listing.tradingClass = "OTHER";
  assert.throws(() => parseResearchManifest(wrong, f.config, f.configHash), /LISTING/);
  const duplicate = structuredClone(f.manifest); duplicate.instruments[1].identifiers = duplicate.instruments[0].identifiers; duplicate.instruments[1].sources[0].issuerIdentifier = duplicate.instruments[0].identifiers[0];
  assert.throws(() => parseResearchManifest(duplicate, f.config, f.configHash), /AMBIGUOUS/);
  for (const url of ["http://sec.gov/x", "https://localhost/x", "https://127.0.0.1/x", "https://[::1]/x", "https://a:b@sec.gov/x", "https://sec.gov/x#y"]) assert.equal(safeResearchUrl(url), false);
});
test("source failures, incomplete news queries, unknown permissions and stale checks fail closed", () => {
  const f = researchFixture(now);
  for (const status of ["MISSING", "ERROR", "UNVERIFIED", "STALE", "NOT_APPLICABLE"] as const) {
    const s = structuredClone(f.snapshot); s.coverage[1].status = status; assert.equal(evaluateResearchEligibility(s, f.manifest, now).eligible, false);
  }
  const incomplete = structuredClone(f.snapshot); incomplete.coverage[1].windowStart = new Date(now - 10000).toISOString();
  assert.ok(evaluateResearchEligibility(incomplete, f.manifest, now).reasons.includes("RESEARCH_NEWS_WINDOW_INCOMPLETE"));
  assert.equal(evaluateResearchEligibility(f.snapshot, f.manifest, now + 1800000).eligible, false);
  const unverified = structuredClone(f.snapshot); unverified.evidence[0].retention = "UNVERIFIED";
  assert.equal(evaluateResearchEligibility(unverified, f.manifest, now).eligible, false);
});
test("legacy calendar snapshots remain readable and byte-identical without occurrence admission policy", () => {
  const f = researchFixture(now), calendar = f.snapshot.coverage[2];
  delete calendar.occurrenceWindowStart; delete calendar.occurrenceWindowEnd;
  calendar.windowStart = "2020-01-01T00:00:00Z"; calendar.windowEnd = "2020-01-02T00:00:00Z";
  const before = JSON.stringify(f.snapshot), hash = researchHash(f.snapshot);
  assert.deepEqual(parseResearchSnapshot(f.snapshot, f.manifest), f.snapshot);
  assert.equal(evaluateResearchEligibility(f.snapshot, f.manifest, now).eligible, true);
  assert.equal(JSON.stringify(f.snapshot), before); assert.equal(researchHash(f.snapshot), hash);
});
test("event horizon never caps eligibility or imposes proximity admission", () => {
  const f = researchFixture(now), calendar = f.snapshot.coverage[2];
  const original = evaluateResearchEligibility(f.snapshot, f.manifest, now);
  for (const offset of [-1000, 0, 1000, 86400000]) {
    calendar.occurrenceWindowStart = new Date(now - 86400000).toISOString();
    calendar.occurrenceWindowEnd = new Date(now + offset).toISOString();
    const evaluated = evaluateResearchEligibility(f.snapshot, f.manifest, now);
    assert.equal(evaluated.eligible, true); assert.equal(evaluated.expiresAt, original.expiresAt);
  }
});
test("calendar range is paired, role-specific, ordered and not a substitute for source as-of time", () => {
  const f = researchFixture(now);
  for (const mutate of [
    (s: typeof f.snapshot) => { delete s.coverage[2].occurrenceWindowEnd; },
    (s: typeof f.snapshot) => { s.coverage[2].occurrenceWindowStart = "invalid"; },
    (s: typeof f.snapshot) => { s.coverage[2].occurrenceWindowStart = s.coverage[2].occurrenceWindowEnd; s.coverage[2].occurrenceWindowEnd = new Date(now).toISOString(); },
    (s: typeof f.snapshot) => { s.coverage[1].occurrenceWindowStart = new Date(now).toISOString(); s.coverage[1].occurrenceWindowEnd = new Date(now + 86400000).toISOString(); },
  ]) { const snapshot = structuredClone(f.snapshot); mutate(snapshot); assert.throws(() => parseResearchSnapshot(snapshot, f.manifest)); }
  f.snapshot.coverage[2].checkedAt = new Date(now + 1).toISOString();
  assert.ok(evaluateResearchEligibility(f.snapshot, f.manifest, now).reasons.includes("RESEARCH_SOURCE_STALE_OR_FUTURE"));
});
test("event occurrence is context while future publication still denies", () => {
  const f = researchFixture(now), calendar = f.snapshot.coverage[2];
  calendar.status = "AVAILABLE"; calendar.evidenceRefs = ["reports"];
  f.snapshot.events.push({ id: "event", kind: "earnings", occurs: { precision: "instant", at: new Date(now + 2 * 86400000).toISOString() }, evidenceRef: "reports", title: "Known future earnings" });
  assert.equal(evaluateResearchEligibility(f.snapshot, f.manifest, now).eligible, true);
  f.snapshot.events[0].occurs = { precision: "instant", at: new Date(now + 4 * 86400000).toISOString() };
  assert.equal(evaluateResearchEligibility(f.snapshot, f.manifest, now).eligible, true);
  f.snapshot.events[0].occurs = { precision: "instant", at: new Date(now + 2 * 86400000).toISOString() };
  f.snapshot.evidence[0].published = { precision: "instant", at: new Date(now + 1).toISOString() };
  assert.ok(evaluateResearchEligibility(f.snapshot, f.manifest, now).reasons.includes("RESEARCH_FUTURE_EVIDENCE"));
});
test("units, reporting periods, revisions, identity and future evidence cannot fabricate available facts", () => {
  const f = researchFixture(now);
  const mutations = [
    (s: typeof f.snapshot) => { s.facts[0].currency = "PLN"; },
    (s: typeof f.snapshot) => { s.facts[0].periodStart = "2025-10-01"; },
    (s: typeof f.snapshot) => { s.facts[0].scope = "separate"; },
    (s: typeof f.snapshot) => { s.facts[0].supersedes = "missing"; },
    (s: typeof f.snapshot) => { s.facts.push({ ...s.facts[0], id: "conflict", value: 7 }); },
    (s: typeof f.snapshot) => { s.evidence[0].published = { precision: "instant", at: new Date(now + 1).toISOString() }; },
    (s: typeof f.snapshot) => { s.evidence[0].issuerIdentifier.value = "9999999999"; },
    (s: typeof f.snapshot) => { s.createdAt = new Date(now + 1).toISOString(); },
  ];
  for (const mutate of mutations) { const s = structuredClone(f.snapshot); mutate(s); assert.equal(evaluateResearchEligibility(s, f.manifest, now).eligible, false); }
  const bank = researchFixture(now, "pko_wse"); bank.snapshot.facts.find(f => f.metric === "tier1_ratio")!.metric = "cet1_ratio";
  assert.equal(evaluateResearchEligibility(bank.snapshot, bank.manifest, now).eligible, false);
});
test("date-only publication waits for source-local day end and nearby events remain context", () => {
  const spring = publicationRange({ precision: "date", date: "2026-03-29", timeZone: "Europe/Warsaw" });
  assert.equal(spring.end - spring.start, 23 * 3600000);
  const f = researchFixture(now); f.snapshot.evidence[0].published = { precision: "date", date: "2026-10-04", timeZone: "America/New_York" };
  assert.equal(evaluateResearchEligibility(f.snapshot, f.manifest, now).eligible, false);
  const event = researchFixture(now); event.snapshot.coverage[2].status = "AVAILABLE"; event.snapshot.coverage[2].evidenceRefs = ["reports"];
  event.snapshot.events.push({ id: "earnings", kind: "earnings", occurs: { precision: "date", date: "2026-10-05", timeZone: "Europe/Warsaw" }, evidenceRef: "reports", title: "Earnings" });
  assert.equal(evaluateResearchEligibility(event.snapshot, event.manifest, now).eligible, true);
});
test("immutable canonical identity changes on policy/permission changes and unsupported ETF denies", () => {
  const f = researchFixture(now), hash = researchHash(f.manifest); f.manifest.model.model = "other";
  assert.notEqual(researchHash(f.manifest), hash); assert.throws(() => parseResearchSnapshot(f.snapshot, f.manifest), /IDENTITY/);
  const etf = researchFixture(now); etf.policy.assetClass = "etf"; etf.policy.profile = "etf";
  etf.snapshot.manifestHash = researchHash(etf.manifest); etf.snapshot.mappingHash = researchHash(etf.policy);
  assert.ok(evaluateResearchEligibility(etf.snapshot, etf.manifest, now).reasons.includes("RESEARCH_NOT_SUPPORTED"));
});
test("explicit later restatement selects revised facts without changing original replay", () => {
  const f = researchFixture(now), original = structuredClone(f.snapshot), revised = structuredClone(original);
  revised.createdAt = new Date(now).toISOString();
  revised.evidence.push({ ...revised.evidence[0], ref: "revision", documentId: "annual-revision", published: { precision: "instant", at: new Date(now - 1800000).toISOString() } });
  revised.coverage[0].evidenceRefs.push("revision");
  revised.reports.push({ ...revised.reports[0], id: "annual-revised", evidenceRef: "revision", supersedes: "annual" });
  revised.facts.push(...original.facts.filter(f => f.reportId === "annual").map(f => ({ ...f, id: `${f.id}:revised`, reportId: "annual-revised", value: 999, evidenceRef: "revision", supersedes: f.id })));
  assert.equal(evaluateResearchEligibility(revised, f.manifest, now).eligible, true);
  assert.equal(evaluateResearchEligibility(original, f.manifest, now).eligible, true);
  assert.equal(evaluateResearchEligibility(revised, f.manifest, now - 1).eligible, false);
  revised.reports.at(-1)!.supersedes = null;
  assert.ok(evaluateResearchEligibility(revised, f.manifest, now).reasons.includes("RESEARCH_ANNUAL_REPORT_MISSING_OR_CONFLICTING"));
});
