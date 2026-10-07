import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { researchFixture } from "./research.fixture.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { parseResearchSnapshot, researchHash, validateResearchManifest } from "./validation.js";
import { marketauxCallIdentity, marketauxRequestUrl, marketauxSourceUrl, marketauxWindow, parseMarketauxNewsConfig, type MarketauxNewsConfig } from "./marketaux.js";
import type { ResearchSource } from "./types.js";

function fixture() {
  const now = Date.parse("2026-10-07T12:01:00Z"), f = researchFixture(now);
  const config: MarketauxNewsConfig = { kind: "marketaux-news-v1", entity: { symbol: "SYNTHETIC", name: "Synthetic Issuer", type: "equity", country: "us", exchange: null },
    qualification: { outcome: "VERIFIED", verifiedAt: "2026-10-07T11:00:00Z", expiresAt: "2026-10-07T12:10:00Z", evidenceUrl: "https://api.marketaux.com/v1/entity/search?symbols=SYNTHETIC", receiptHash: "a".repeat(64), issuerIdentifier: f.policy.identifiers[0], conId: f.policy.listing.conId },
    entitlement: { outcome: "VERIFIED", verifiedAt: "2026-10-07T11:00:00Z", expiresAt: "2026-10-07T12:20:00Z", evidenceUrl: "https://www.marketaux.com/pricing", receiptHash: "b".repeat(64), maxArticlesPerRequest: 20, maxRequestsPerDay: 100, maxCostMicrosPerDay: 0 },
    pageSize: 20, maxPagesPerPass: 10, maxArticles: 100 };
  const source: ResearchSource = { id: "news", adapter: "marketaux-news", provider: "https://api.marketaux.com", roles: ["news"], parserConfig: config as unknown as Record<string, unknown>, urls: [marketauxSourceUrl(config)], issuerIdentifier: f.policy.identifiers[0], automation: "PERMITTED", retention: "FACTS_AND_REFERENCES", permissionEvidenceUrl: "https://www.marketaux.com/documentation", maxRequestsPerDay: 100, maxCostMicrosPerDay: 0, costMicrosPerCall: 0 };
  f.policy.sources[0].roles = ["reports", "calendar"]; f.policy.sources.push(source);
  f.manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = f.manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  f.snapshot.coverage = f.snapshot.coverage.filter(c => c.role !== "news"); f.snapshot.createdAt = new Date(now).toISOString();
  const window = marketauxWindow(Math.floor(now / 900000));
  f.snapshot.coverage.push({ sourceId: source.id, role: "news", status: "EMPTY", checkedAt: window.asOf, windowStart: window.windowStart, windowEnd: window.asOf, complete: true, evidenceRefs: [], reason: "synthetic fixture",
    acquisition: { kind: "marketaux-news-v1", queryStart: new Date(Date.parse(window.windowStart) - 1000).toISOString(), queryEnd: new Date(Date.parse(window.asOf) + 1000).toISOString(), asOf: window.asOf,
      entityQualificationHash: researchHash(config.qualification), entitlementHash: researchHash(config.entitlement), found: 0, emitted: 0, recordSetHash: researchHash([]),
      pages: ([1, 2] as const).map(pass => ({ pass, page: 1, ...marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, source, { sourceUrl: source.urls[0], ...window, pass, page: 1 }), fetchedAt: new Date(now).toISOString(), contentHash: "c".repeat(64), found: 0, returned: 0, limit: config.pageSize })) } });
  return { ...f, source, newsConfig: config, now, window };
}

test("strict provider contract binds entity, listing, limits and canonical query without auth", () => {
  const f = fixture(); validateResearchManifest(f.manifest);
  assert.deepEqual(parseMarketauxNewsConfig(f.source, f.policy), f.newsConfig);
  const mutations: ((s: ResearchSource) => void)[] = [s => s.urls[0] += "&api_token=secret", s => s.roles.push("calendar"), s => s.provider = "https://other.example.org",
    s => (s.parserConfig as any).qualification.conId++, s => (s.parserConfig as any).qualification.issuerIdentifier.value = "0000000001",
    s => (s.parserConfig as any).pageSize = 21, s => (s.parserConfig as any).maxArticles = 901, s => (s.parserConfig as any).maxPagesPerPass = 101,
    s => (s.parserConfig as any).qualification.evidenceUrl += "&api_token=secret", s => s.maxRequestsPerDay = 101, s => (s.parserConfig as any).extra = true];
  for (const mutate of mutations) { const source = structuredClone(f.source); mutate(source); assert.throws(() => parseMarketauxNewsConfig(source, f.policy), /RESEARCH_MARKETAUX/); }
});

test("request and call identities are stable across restart and distinguish every pass/page", () => {
  const f = fixture(), descriptor = { sourceUrl: f.source.urls[0], ...f.window, pass: 1 as const, page: 1 };
  const first = marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, descriptor);
  assert.deepEqual(first, marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, structuredClone(descriptor)));
  assert.notEqual(first.callKey, marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, { ...descriptor, pass: 2 }).callKey);
  assert.notEqual(first.callKey, marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, { ...descriptor, page: 2 }).callKey);
  assert.equal(first.canonicalRequestUrl, marketauxRequestUrl(f.source, descriptor));
  for (const patch of [{ page: 0 }, { page: 11 }, { pass: 3 }, { sourceUrl: f.source.urls[0] + "&page=1" }, { asOf: "2026-10-07T12:00:00Z" }, { api_token: "secret" }])
    assert.throws(() => marketauxRequestUrl(f.source, { ...descriptor, ...patch } as any), /RESEARCH_MARKETAUX/);
});

test("receipts reject identity/count/bounds tampering and expiry is enforced by eligibility, not historic read time", () => {
  const f = fixture(); parseResearchSnapshot(f.snapshot, f.manifest);
  const eligible = evaluateResearchEligibility(f.snapshot, f.manifest, f.now);
  assert.equal(eligible.eligible, true, eligible.reasons.join());
  assert.equal(eligible.expiresAt, "2026-10-07T12:10:00.000Z");
  const expired = evaluateResearchEligibility(f.snapshot, f.manifest, Date.parse(f.newsConfig.qualification.expiresAt));
  assert.ok(expired.reasons.includes("RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE"));
  assert.doesNotThrow(() => parseResearchSnapshot(f.snapshot, f.manifest));
  const later = structuredClone(f.snapshot); later.createdAt = "2026-10-07T13:00:00Z";
  assert.doesNotThrow(() => parseResearchSnapshot(later, f.manifest));
  const mutations: ((a: any) => void)[] = [a => a.pages.pop(), a => a.pages[1].pass = 1, a => a.pages[0].canonicalRequestUrl += "&api_token=x", a => a.pages[0].requestHash = "f".repeat(64),
    a => a.pages[0].callKey += "x", a => a.pages[0].found = 1, a => a.pages[0].fetchedAt = "2026-10-07T12:15:00Z", a => a.emitted = 1, a => a.queryEnd = a.queryStart, a => a.entitlementHash = "f".repeat(64)];
  for (const mutate of mutations) { const changed = structuredClone(f.snapshot); mutate(changed.coverage.at(-1)!.acquisition); assert.throws(() => parseResearchSnapshot(changed, f.manifest)); }
});

test("entitlement expiry also caps stored eligibility and future or unverified qualification is denied", () => {
  for (const mode of ["entitlement", "future", "unverified"] as const) {
    const f = fixture();
    if (mode === "entitlement") f.newsConfig.entitlement.expiresAt = "2026-10-07T12:05:00Z";
    if (mode === "future") f.newsConfig.qualification.verifiedAt = "2026-10-07T12:02:00Z";
    if (mode === "unverified") f.newsConfig.qualification.outcome = "UNVERIFIED";
    f.snapshot.manifestHash = researchHash(f.manifest); f.snapshot.mappingHash = researchHash(f.policy);
    const c = f.snapshot.coverage.at(-1)!; c.status = "UNVERIFIED"; c.complete = false; delete c.acquisition;
    const result = evaluateResearchEligibility(f.snapshot, f.manifest, mode === "entitlement" ? Date.parse("2026-10-07T12:05:00Z") : f.now);
    assert.ok(result.reasons.includes("RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE"));
    if (mode === "entitlement") assert.equal(result.expiresAt, "2026-10-07T12:05:00.000Z");
  }
});

test("shipped PKO/AAPL research example has actual adapter wiring but no qualification, budget or activation claim", () => {
  const example = validateResearchManifest(JSON.parse(readFileSync(new URL("../../../../config/research/paper.example.json", import.meta.url), "utf8")));
  assert.equal(example.refreshEnabled, false); assert.equal(example.model.maxRequestsPerDay, 0); assert.equal(example.model.maxCostMicrosPerDay, 0);
  for (const policy of example.instruments) {
    const source = policy.sources.find(source => source.adapter === "marketaux-news")!, config = parseMarketauxNewsConfig(source, policy);
    assert.equal(config.qualification.outcome, "UNVERIFIED"); assert.equal(config.entitlement.outcome, "UNVERIFIED");
    assert.equal(source.automation, "UNVERIFIED"); assert.equal(source.retention, "UNVERIFIED");
    assert.equal(source.maxRequestsPerDay, 0); assert.equal(source.maxCostMicrosPerDay, 0);
    assert.ok(policy.sources.some(source => source.roles.includes("calendar") && source.automation === "UNVERIFIED"));
  }
});
