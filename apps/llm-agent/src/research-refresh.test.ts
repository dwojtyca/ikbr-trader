import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:https";
import { researchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { parseResearchSnapshot, researchHash } from "@ikbr/shared/instrument-research";
import { ResearchRefreshScheduler, researchBudgetAccountId, researchCallKey, researchSourceSlot } from "./research-refresh.js";
import { isPublicResearchAddress, assertResearchSourceUrl, fetchResearchSource } from "./research-fetch.js";

test("refresh account is explicit and belongs to the environment allowlist", () => {
  assert.equal(researchBudgetAccountId({}, false), null);
  assert.equal(researchBudgetAccountId({ IBKR_ENVIRONMENT: "paper", ALLOWED_PAPER_ACCOUNTS: "DU1,DU2", RESEARCH_BUDGET_ACCOUNT_ID: "DU2" }, true), "DU2");
  for (const env of [{}, { IBKR_ENVIRONMENT: "live", ALLOWED_PAPER_ACCOUNTS: "DU2", RESEARCH_BUDGET_ACCOUNT_ID: "DU2" }, { IBKR_ENVIRONMENT: "paper", ALLOWED_PAPER_ACCOUNTS: "DU2", RESEARCH_BUDGET_ACCOUNT_ID: "DU3" }]) assert.throws(() => researchBudgetAccountId(env, true), /RESEARCH_BUDGET_ACCOUNT_NOT_ALLOWED/);
});

test("source slots and reservation identities are stable across process restarts", () => {
  const fixture = researchFixture(); const source = fixture.policy.sources[0];
  assert.equal(researchSourceSlot(900000, "news"), 1);
  assert.equal(researchSourceSlot(899999, "news"), 0);
  assert.equal(researchCallKey(fixture.manifestHash, fixture.policy, source, "reports", 3, source.urls[0], 1), researchCallKey(fixture.manifestHash, fixture.policy, source, "reports", 3, source.urls[0], 1));
  assert.notEqual(researchCallKey(fixture.manifestHash, fixture.policy, source, "reports", 3, source.urls[0], 1), researchCallKey(fixture.manifestHash, fixture.policy, source, "reports", 3, source.urls[0], 2));
});

test("source URL and DNS policy excludes private, link-local and redirect targets", () => {
  const fixture = researchFixture(); const source = fixture.policy.sources[0];
  assert.equal(assertResearchSourceUrl(source, source.urls[0]).href, source.urls[0]);
  for (const bad of ["http://www.sec.gov/fixture", "https://www.sec.gov/other", "https://127.0.0.1/fixture", "https://user@www.sec.gov/fixture"]) assert.throws(() => assertResearchSourceUrl(source, bad));
  for (const bad of ["127.0.0.1", "10.1.2.3", "169.254.1.1", "172.20.1.2", "192.168.1.1", "100.64.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1"]) assert.equal(isPublicResearchAddress(bad), false, bad);
  assert.equal(isPublicResearchAddress("8.8.8.8"), true);
  assert.equal(isPublicResearchAddress("2606:4700:4700::1111"), true);
});

test("absolute deadline stops a hanging DNS lookup before any HTTPS request", async () => {
  const source = researchFixture().policy.sources[0]; let requests = 0;
  await assert.rejects(fetchResearchSource(source, source.urls[0], new Date(Date.now() + 25).toISOString(), {
    resolveAddress: async () => new Promise(() => {}),
    httpsRequest: ((..._args: unknown[]) => { requests++; throw new Error("must not connect"); }) as unknown as typeof request,
  }), /RESEARCH_SOURCE_TIMEOUT/);
  assert.equal(requests, 0);
});

test("absolute deadline destroys a response that drips forever", async () => {
  const source = researchFixture().policy.sources[0]; let destroyed = false;
  const fakeRequest = ((_url: unknown, _options: unknown, onResponse: (res: any) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error: Error) => void };
    let interval: NodeJS.Timeout;
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; resume: () => void; destroy: () => void };
      res.statusCode = 200; res.headers = { "content-type": "text/plain" }; res.resume = () => {};
      res.destroy = () => { clearInterval(interval); };
      onResponse(res);
      interval = setInterval(() => res.emit("data", Buffer.from("x")), 5);
    };
    req.destroy = error => { destroyed = true; clearInterval(interval); req.emit("error", error); };
    return req;
  }) as unknown as typeof request;
  await assert.rejects(fetchResearchSource(source, source.urls[0], new Date(Date.now() + 30).toISOString(), {
    resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: fakeRequest,
  }), /RESEARCH_SOURCE_TIMEOUT/);
  assert.equal(destroyed, true);
});

test("HTTP failure destroys an infinite response body before retry can begin", async () => {
  const source = researchFixture().policy.sources[0]; let responseDestroyed = false;
  const fakeRequest = ((_url: unknown, _options: unknown, onResponse: (res: any) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      res.statusCode = 503; res.headers = {};
      const interval = setInterval(() => res.emit("data", Buffer.from("x")), 5);
      res.destroy = () => { responseDestroyed = true; clearInterval(interval); };
      onResponse(res);
    };
    req.destroy = () => {};
    return req;
  }) as unknown as typeof request;
  await assert.rejects(fetchResearchSource(source, source.urls[0], new Date(Date.now() + 100).toISOString(), {
    resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest: fakeRequest,
  }), /RESEARCH_SOURCE_HTTP_503/);
  assert.equal(responseDestroyed, true);
});

function setup(budget: number, successfulNews = false, calendar?: { occurrenceWindowStart?: string; occurrenceWindowEnd?: string }) {
  const fixture = researchFixture();
  const manifest = structuredClone(fixture.manifest);
  manifest.refreshEnabled = true; manifest.instruments = [structuredClone(fixture.policy)];
  const source = manifest.instruments[0].sources[0];
  const declared = successfulNews || calendar !== undefined;
  source.roles = [calendar !== undefined ? "calendar" : successfulNews ? "news" : "reports"]; source.adapter = "issuer-document"; source.parserConfig = { kind: declared ? "declared-evidence" : "issuer-xhtml" };
  source.maxRequestsPerDay = budget; source.maxCostMicrosPerDay = budget; source.costMicrosPerCall = 1;
  const manifestHash = researchHash(manifest);
  let fetches = 0; const reserved = new Set<string>(); const slots = new Set<string>(); const snapshots: unknown[] = [];
  let locked = false;
  const store = {
    latestSnapshot: async () => null,
    withRefreshLock: async (_identity: unknown, run: () => Promise<void>) => { if (locked) return false; locked = true; try { await run(); return true; } finally { locked = false; } },
    hasRefreshSlot: async (slotKey: string) => slots.has(slotKey),
    storeSnapshot: async (snapshot: any, slotKey: string) => { parseResearchSnapshot(snapshot, manifest); if (slots.has(slotKey)) throw new Error("duplicate slot"); slots.add(slotKey); snapshots.push(snapshot); return { id: "fixture", hash: researchHash(snapshot), sequence: snapshots.length, snapshot }; },
    reserveCall: async (reservation: any) => { if (reserved.has(reservation.callKey)) throw new Error("RESEARCH_CALL_ALREADY_RESERVED"); reserved.add(reservation.callKey); return { callKey: reservation.callKey, reservedAt: new Date().toISOString(), budgetDay: "2026-10-04" }; },
    recordCallOutcome: async () => {},
  };
  const make = () => new ResearchRefreshScheduler({ manifest, manifestHash, accountId: "DU1", store: store as any,
    fetch: async () => { fetches++; const end = new Date(Date.now() - 60000).toISOString();
      return { payload: Buffer.from(declared ? JSON.stringify({ role: source.roles[0], complete: true, windowStart: new Date(Date.parse(end) - 86400000).toISOString(), windowEnd: end, ...calendar, items: [] }) : "malformed"), contentHash: "a".repeat(64), contentType: declared ? "application/json" : "application/xhtml+xml" }; } });
  return { make, snapshots, reserved, slots, get fetches() { return fetches; } };
}

test("zero budget makes no request and publishes unverified coverage", async () => {
  const setupResult = setup(0); await setupResult.make().tick();
  assert.equal(setupResult.fetches, 0);
  assert.equal((setupResult.snapshots[0] as any).coverage[0].status, "UNVERIFIED");
});

test("malformed source makes an immutable error snapshot, published slot after restart is skipped", async () => {
  const state = setup(2); await state.make().tick();
  assert.equal(state.fetches, 1);
  assert.equal((state.snapshots[0] as any).coverage[0].status, "ERROR");
  await state.make().tick();
  assert.equal(state.fetches, 1);
  assert.equal(state.snapshots.length, 1);
});

test("a successful empty news slot survives restart without a duplicate call or false failure", async () => {
  const state = setup(2, true); await state.make().tick();
  assert.equal(state.fetches, 1);
  assert.equal((state.snapshots[0] as any).coverage[0].status, "EMPTY");
  await state.make().tick();
  assert.equal(state.fetches, 1);
  assert.equal(state.snapshots.length, 1);
});
test("refresh preserves historical calendar ranges without requiring an event blackout horizon", async () => {
  const now = Date.now();
  for (const calendar of [{}, { occurrenceWindowStart: new Date(now - 2 * 86400000).toISOString(), occurrenceWindowEnd: new Date(now - 86400000).toISOString() }]) {
    const state = setup(2, false, calendar); await state.make().tick();
    const coverage = (state.snapshots[0] as any).coverage[0];
    assert.equal(coverage.status, "occurrenceWindowStart" in calendar ? "EMPTY" : "UNVERIFIED");
    assert.equal(coverage.complete, "occurrenceWindowStart" in calendar);
    await state.make().tick(); assert.equal(state.fetches, 1);
  }
  const range = { occurrenceWindowStart: new Date(now - 2 * 86400000).toISOString(), occurrenceWindowEnd: new Date(now + 3 * 86400000).toISOString() };
  const state = setup(2, false, range); await state.make().tick();
  const coverage = (state.snapshots[0] as any).coverage[0];
  assert.equal(coverage.status, "EMPTY"); assert.equal(coverage.complete, true);
  assert.equal(coverage.occurrenceWindowStart, range.occurrenceWindowStart); assert.equal(coverage.occurrenceWindowEnd, range.occurrenceWindowEnd);
  assert.ok(Date.parse(coverage.checkedAt) < now); assert.ok(Date.parse(coverage.occurrenceWindowEnd) > now);
});

test("concurrent ticks never fetch the same source twice", async () => {
  const state = setup(2); const scheduler = state.make();
  await Promise.all([scheduler.tick(), scheduler.tick()]);
  assert.equal(state.fetches, 1);
  assert.equal(state.snapshots.length, 1);
  const other = state.make();
  await Promise.all([scheduler.tick(), other.tick()]);
  assert.equal(state.fetches, 1);
  assert.equal(state.snapshots.length, 1);
});

test("V2 Marketaux enrichment reaches the merged snapshot while WSH evidence remains immutable", async () => {
  const { wshSnapshotFixture } = await import("@ikbr/shared/instrument-research-testfixture");
  const { marketauxFixture, marketauxResponse } = await import("./research-marketaux.testfixture.js");
  const f = wshSnapshotFixture(), news = marketauxFixture();
  f.policy.sources[0].roles = ["reports"];
  f.policy.sources.push(news.source); f.manifest.instruments = [f.policy];
  const manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  f.snapshot.coverage = f.snapshot.coverage.filter(c => c.role !== "news");
  const originalWsh = structuredClone(f.snapshot.evidence.filter(e => e.published === null));
  let saved = f.snapshot, calls = 0;
  const article = { ...news.article(1), description: "Issuer description", snippet: "Available excerpt", entities: [{ ...news.newsConfig.entity, sentiment_score: -0.35 }] };
  const slots = new Set<string>();
  const store: any = {
    latestSnapshot: async () => ({ id: "prior", hash: researchHash(saved), sequence: 1, snapshot: saved }),
    withRefreshLock: async (_id: unknown, run: () => Promise<void>) => { await run(); return true; },
    hasRefreshSlot: async (key: string) => slots.has(key) || f.policy.sources.filter(s => s.adapter !== "marketaux-news").some(s => key === "research_slot_" + researchHash({ manifestHash, instrumentId: f.policy.instrumentId, sourceId: s.id, role: s.roles[0], slot: researchSourceSlot(news.now, s.adapter === "ibkr-wsh" ? "news" : "reports") })),
    reserveCall: async () => {}, recordCallOutcome: async () => {},
    storeSnapshot: async (snapshot: typeof saved, slot: string) => { parseResearchSnapshot(snapshot, f.manifest); saved = snapshot; slots.add(slot); },
  };
  await new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash, accountId: "DU1", store, now: () => news.now, marketauxApiKey: "fixture-only", marketauxFetch: async (_source, request) => { calls++; return marketauxResponse([article], request.page, 1); } }).tick();
  assert.equal(calls, 2);
  assert.equal(saved.news[0].description, article.description); assert.equal(saved.news[0].snippet, article.snippet);
  assert.deepEqual(saved.news[0].providerSentiment, { status: "PROVIDED", score: -0.35 });
  assert.deepEqual(saved.evidence.filter(e => e.published === null), originalWsh);
  assert.deepEqual(saved.reports, f.snapshot.reports);
});
