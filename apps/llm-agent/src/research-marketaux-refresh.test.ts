import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { parseResearchSnapshot, researchHash, type InstrumentResearchSnapshotV1, type ResearchSnapshot, type MarketauxRequest, type ResearchCallReservation, type StoredResearchSnapshot } from "@ikbr/shared/instrument-research";
import { ResearchRefreshScheduler, researchSourceSlot } from "./research-refresh.js";
import { marketauxFixture, marketauxResponse } from "./research-marketaux.testfixture.js";
import type { ResearchFetchResult } from "./research-fetch.js";
import { createMarketauxFetch, type MarketauxFetch } from "./research-marketaux-fetch.js";

function setup() {
  const f = marketauxFixture(); f.manifest.instruments = [f.policy]; f.manifestHash = researchHash(f.manifest);
  f.snapshot.manifestHash = f.manifestHash;
  const state = { now: f.now, requests: [] as MarketauxRequest[], reservations: [] as ResearchCallReservation[], outcomes: [] as string[], snapshots: [] as InstrumentResearchSnapshotV1[], slots: new Set<string>(),
    prior: { id: "prior", hash: researchHash(f.snapshot), sequence: 1, snapshot: f.snapshot } as StoredResearchSnapshot,
    onReserve: (_reservation: ResearchCallReservation) => {},
    onStore: (_snapshot: InstrumentResearchSnapshotV1, _deadline: string | undefined) => {},
    response: (request: MarketauxRequest): ResearchFetchResult => marketauxResponse([f.article(1), f.article(2), f.article(3)].slice((request.page - 1) * 2, request.page * 2), request.page, 3),
  };
  const unsupportedWshCall = async (): Promise<never> => { throw new Error("unexpected WSH call in HTTP-only fixture"); };
  const store = {
    readSnapshot: unsupportedWshCall,
    withWshEndpointLock: unsupportedWshCall,
    pendingWshAcquisition: unsupportedWshCall,
    beginWshAcquisition: unsupportedWshCall,
    reserveWshCall: unsupportedWshCall,
    assertWshAcquisition: unsupportedWshCall,
    publishWshSnapshot: unsupportedWshCall,
    finishWshFailure: unsupportedWshCall,
    retireWshAcquisition: unsupportedWshCall,
    readWshAcquisition: unsupportedWshCall,
    latestSnapshot: async () => state.prior,
    withRefreshLock: async (_identity: unknown, run: () => Promise<void>) => { if (locked) return false; locked = true; try { await run(); return true; } finally { locked = false; } },
    hasRefreshSlot: async (slotKey: string) => state.slots.has(slotKey) || ["reports", "calendar"].some(role => slotKey === "research_slot_" + researchHash({ manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId, sourceId: "official", role, slot: researchSourceSlot(state.now, role as "reports" | "calendar") })),
    reserveCall: async (r: ResearchCallReservation) => {
      if (state.reservations.some(prior => prior.callKey === r.callKey)) throw new Error("RESEARCH_CALL_ALREADY_RESERVED");
      if (state.reservations.length >= r.maxRequestsPerDay || state.reservations.reduce((sum, row) => sum + row.reservedCostMicros, 0) + r.reservedCostMicros > r.maxCostMicrosPerDay) throw new Error("RESEARCH_BUDGET_EXHAUSTED");
      state.reservations.push(r); state.onReserve(r);
      return { callKey: r.callKey, reservedAt: new Date(state.now).toISOString(), budgetDay: new Date(state.now).toISOString().slice(0, 10) };
    },
    recordCallOutcome: async (callKey: string, outcome: string) => { state.outcomes.push(callKey + ":" + outcome); },
    storeSnapshot: async (snapshot: ResearchSnapshot, slotKey?: string, deadline?: string) => {
      assert.equal(snapshot.schemaVersion, 1);
      if (snapshot.schemaVersion !== 1) throw new Error("V1 fixture received V2");
      state.onStore(snapshot, deadline);
      parseResearchSnapshot(snapshot, f.manifest);
      if (slotKey && state.slots.has(slotKey)) throw new Error("duplicate slot");
      if (slotKey) state.slots.add(slotKey);
      state.snapshots.push(structuredClone(snapshot));
      state.prior = { id: "saved", hash: researchHash(snapshot), sequence: state.snapshots.length + 1, snapshot: structuredClone(snapshot) };
      return state.prior;
    },
  };
  let locked = false;
  const make = (key: string | undefined = "synthetic-secret", fetch?: MarketauxFetch) => new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash, accountId: "DU_TEST", store,
    marketauxApiKey: key, now: () => state.now, marketauxFetch: fetch ?? (async (_source, descriptor) => { state.requests.push(descriptor); return state.response(descriptor); }) });
  const coverage = () => state.snapshots.at(-1)!.coverage.find(c => c.sourceId === f.source.id)!;
  const rehash = () => { f.manifestHash = researchHash(f.manifest); state.prior.snapshot.manifestHash = f.manifestHash; state.prior.snapshot.mappingHash = researchHash(f.policy); };
  return { f, state, store, make, coverage, rehash };
}

test("production refresh publishes complete multi-page acquisition, preserves reports, and never repeats completed slot", async () => {
  const s = setup(); await s.make().tick();
  assert.equal(s.coverage().status, "AVAILABLE"); assert.equal(s.coverage().complete, true);
  assert.equal(s.state.requests.length, 4); assert.equal(s.state.reservations.length, 4);
  assert.equal(s.state.snapshots[0].news.length, 3); assert.deepEqual(s.state.snapshots[0].reports, s.f.snapshot.reports);
  assert.equal(s.coverage().acquisition!.pages.length, 4);
  assert.ok(s.state.snapshots[0].evidence.filter(e => e.sourceId === s.f.source.id).every(e => e.url === s.f.source.urls[0]));
  assert.ok(!JSON.stringify(s.state.snapshots).includes("synthetic-secret")); assert.ok(!JSON.stringify(s.state.reservations).includes("api_token"));
  await Promise.all([s.make().tick(), s.make().tick()]); assert.equal(s.state.requests.length, 4);
});

test("scheduler, real credential transport and mapper integrate through injected HTTPS for a third configured issuer", async () => {
  const s = setup(); s.f.newsConfig.entity.symbol = "THIRD_ISSUER"; s.f.newsConfig.entity.name = "Third Synthetic Issuer";
  const { marketauxSourceUrl } = await import("@ikbr/shared/instrument-research");
  s.f.source.urls = [marketauxSourceUrl(s.f.newsConfig)]; s.rehash(); let calls = 0;
  const httpsRequest = ((url: URL, _options: unknown, callback: (res: any) => void) => {
    calls++; assert.equal(s.state.reservations.length, calls); assert.equal(url.searchParams.get("symbols"), "THIRD_ISSUER");
    assert.equal(url.searchParams.get("api_token"), "synthetic-secret");
    const req = new EventEmitter() as any; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter() as any; res.statusCode = 200; res.headers = { "content-type": "application/json" }; res.destroy = () => {};
      callback(res); const page = Number(url.searchParams.get("page"));
      res.emit("data", marketauxResponse([s.f.article(1), s.f.article(2), s.f.article(3)].slice((page - 1) * 2, page * 2), page, 3).payload); res.emit("end");
    }; return req;
  }) as typeof request;
  await s.make("synthetic-secret", createMarketauxFetch("synthetic-secret", { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest })).tick();
  assert.equal(calls, 4); assert.equal(s.coverage().status, "AVAILABLE");
});

test("zero and margin-only feeds publish EMPTY with receipts but no invented evidence", async () => {
  for (const margin of [false, true]) {
    const s = setup(); s.state.response = request => marketauxResponse(margin ? [s.f.article(1, new Date(Date.parse(request.asOf) + 1).toISOString())] : [], request.page, margin ? 1 : 0);
    await s.make().tick(); assert.equal(s.coverage().status, "EMPTY"); assert.equal(s.coverage().acquisition!.pages.length, 2);
    assert.deepEqual(s.coverage().evidenceRefs, []); assert.equal(s.state.snapshots[0].news.length, 0); assert.equal(s.state.requests.length, 2);
  }
});

test("second pass insertion, same-count substitution, content drift and cross-page duplicates fail closed", async () => {
  for (const mode of ["count", "substitution", "content", "duplicate"] as const) {
    const s = setup(); s.state.response = r => {
      const all = [s.f.article(1), s.f.article(2), s.f.article(3)];
      if (mode === "duplicate") all[2] = all[0];
      if (r.pass === 2 && mode === "count") all.push(s.f.article(4));
      if (r.pass === 2 && mode === "substitution") all[0] = s.f.article(4);
      if (r.pass === 2 && mode === "content") all[0].title = "changed";
      return marketauxResponse(all.slice((r.page - 1) * 2, r.page * 2), r.page, all.length);
    };
    await s.make().tick(); assert.equal(s.coverage().status, "ERROR", mode); assert.equal(s.coverage().complete, false);
    assert.equal(s.state.snapshots[0].news.length, 0); assert.equal(s.coverage().acquisition, undefined);
  }
});

test("budget exhaustion, HTTP quota and unknown submissions retain reservations and never retry", async () => {
  for (const mode of ["budget", "cost", "quota", "unknown"] as const) {
    const s = setup();
    if (mode === "budget") s.f.source.maxRequestsPerDay = 3;
    if (mode === "cost") s.f.source.maxCostMicrosPerDay = 3;
    if (mode === "quota" || mode === "unknown") s.state.response = () => { throw new Error(mode === "quota" ? "RESEARCH_SOURCE_HTTP_429" : "raw api_token=synthetic-secret"); };
    s.rehash(); await s.make().tick(); assert.equal(s.coverage().status, "ERROR");
    const calls = s.state.requests.length; assert.equal(calls, mode === "budget" || mode === "cost" ? 3 : 1);
    await s.make().tick(); assert.equal(s.state.requests.length, calls);
    assert.ok(!s.coverage().reason.includes("synthetic-secret"));
  }
});

test("reservation survived crash prevents replay even when current-slot wall clock changes", async () => {
  const s = setup(); let crash = true;
  s.state.onStore = () => { if (crash) throw new Error("simulated crash before publication"); };
  await assert.rejects(s.make().tick(), /simulated crash/); const calls = s.state.requests.length;
  crash = false; s.state.now += 5; await s.make().tick();
  assert.equal(s.state.requests.length, calls); assert.equal(s.coverage().status, "ERROR"); assert.equal(s.coverage().reason, "RESEARCH_CALL_ALREADY_RESERVED");
});

test("expired qualification, denied permissions and missing key perform no provider IO", async () => {
  for (const mode of ["expired", "denied", "key"] as const) {
    const s = setup();
    if (mode === "expired") s.f.newsConfig.qualification.expiresAt = new Date(s.state.now).toISOString();
    if (mode === "denied") s.f.source.automation = "DENIED";
    s.rehash(); await s.make(mode === "key" ? "" : "synthetic-secret").tick();
    assert.equal(s.state.requests.length, 0); assert.equal(s.state.reservations.length, 0);
    assert.equal(s.coverage().status, mode === "key" ? "ERROR" : "UNVERIFIED");
  }
});

test("expiry caps deadlines and is rechecked after reservation and every page", async () => {
  for (const stage of ["reservation", "page", "publication"] as const) {
    const s = setup(); const expiry = s.state.now + 100;
    s.f.newsConfig.entitlement.expiresAt = new Date(expiry).toISOString(); s.rehash();
    if (stage === "reservation") s.state.onReserve = r => { assert.equal(Date.parse(r.deadlineAt), expiry); s.state.now = expiry; };
    else {
      const response = s.state.response; s.state.response = r => { const result = response(r); if (stage === "page" || r.pass === 2 && r.page === 2) s.state.now = expiry; return result; };
    }
    await s.make().tick(); assert.equal(s.coverage().status, "ERROR");
    assert.equal(s.state.requests.length, stage === "reservation" ? 0 : stage === "page" ? 1 : 4);
    assert.ok(s.state.reservations.every(r => Date.parse(r.deadlineAt) <= expiry));
  }
});

test("only explicit transactional admission expiry publishes fallback; ordinary storage failure propagates", async () => {
  const s = setup(); let attempts = 0;
  s.state.onStore = (_snapshot, deadline) => { attempts++; if (deadline) throw new Error("RESEARCH_SNAPSHOT_ADMISSION_EXPIRED"); };
  await s.make().tick(); assert.equal(attempts, 2); assert.equal(s.state.requests.length, 4); assert.equal(s.coverage().status, "ERROR");
  const ordinary = setup(); let ordinaryAttempts = 0;
  ordinary.state.onStore = () => { ordinaryAttempts++; throw new Error("database disconnected"); };
  await assert.rejects(ordinary.make().tick(), /database disconnected/); assert.equal(ordinaryAttempts, 1); assert.equal(ordinary.state.snapshots.length, 0);
});

test("ERROR checkedAt stays slot-anchored across late completion, and large final receipts fail within fallback", async () => {
  const s = setup(); s.state.response = () => { s.state.now = (s.f.slot + 1) * 900000 + 1; throw new Error("failure"); };
  await s.make().tick(); assert.equal(s.coverage().checkedAt, s.f.descriptor.asOf);
  const large = setup(); large.f.newsConfig.pageSize = 100; large.f.newsConfig.maxPagesPerPass = 9; large.f.newsConfig.maxArticles = 900;
  const { marketauxSourceUrl } = await import("@ikbr/shared/instrument-research"); large.f.source.urls = [marketauxSourceUrl(large.f.newsConfig)];
  const first = large.state.prior.snapshot.facts[0];
  large.state.prior.snapshot.facts = Array.from({ length: 900 }, (_, i) => ({ ...first, id: "fact_" + i, sourcePointer: "x".repeat(1000) }));
  large.state.response = r => marketauxResponse(Array.from({ length: 100 }, (_, i) => ({ ...large.f.article((r.page - 1) * 100 + i + 1), title: "x".repeat(1000) })), r.page, 900, 100);
  large.rehash(); parseResearchSnapshot(large.state.prior.snapshot, large.f.manifest);
  await large.make().tick(); assert.equal(large.coverage().status, "ERROR"); assert.equal(large.coverage().reason, "RESEARCH_SNAPSHOT_TOO_LARGE");
  assert.equal(large.state.snapshots[0].news.length, 0); assert.equal(large.state.snapshots[0].facts.length, 900);
});

test("acquisition byte and time ceilings fail without truncating or claiming EMPTY", async () => {
  for (const mode of ["bytes", "time"] as const) {
    const s = setup();
    s.state.response = r => {
      const response = marketauxResponse([s.f.article(r.page * 2 - 1), s.f.article(r.page * 2)], r.page, 6);
      if (mode === "bytes") response.payload = Buffer.concat([response.payload, Buffer.alloc(8 * 1024 * 1024, 32)]);
      else s.state.now += 120001;
      return response;
    };
    await s.make().tick(); assert.equal(s.coverage().status, "ERROR"); assert.equal(s.coverage().acquisition, undefined);
    assert.equal(s.state.requests.length, mode === "bytes" ? 3 : 1);
    assert.equal(s.coverage().reason, mode === "bytes" ? "RESEARCH_MARKETAUX_BYTES_EXCEEDED" : "RESEARCH_MARKETAUX_DEADLINE_EXPIRED");
  }
});

test("real HTTPS stream uses remaining acquisition bytes and stops before buffering a third full page", async () => {
  for (const pageMiB of [8, 10]) {
    const s = setup(); let calls = 0, thirdPageChunks = 0, destroyed = false;
    const httpsRequest = ((url: URL, _options: unknown, callback: (res: any) => void) => {
      calls++; const requestNumber = calls, req = new EventEmitter() as any;
      req.destroy = () => { destroyed = true; };
      req.end = () => {
        const res = new EventEmitter() as any; res.statusCode = 200; res.headers = { "content-type": "application/json" };
        res.destroy = (error?: Error) => { destroyed = true; if (error) res.emit("error", error); };
        callback(res);
        const page = Number(url.searchParams.get("page"));
        const base = marketauxResponse([s.f.article(page * 2 - 1), s.f.article(page * 2)], page, 4).payload;
        const payload = Buffer.concat([base, Buffer.alloc(pageMiB * 1024 * 1024 - base.length, 32)]);
        for (let offset = 0; offset < payload.length && !destroyed; offset += 1024 * 1024) {
          if (requestNumber === 3) thirdPageChunks++;
          res.emit("data", payload.subarray(offset, offset + 1024 * 1024));
        }
        if (!destroyed) res.emit("end");
      }; return req;
    }) as typeof request;
    await s.make("synthetic-secret", createMarketauxFetch("synthetic-secret", { resolveAddress: async () => ({ address: "8.8.8.8", family: 4 }), httpsRequest })).tick();
    assert.equal(s.coverage().status, "ERROR"); assert.equal(s.state.snapshots[0].news.length, 0); assert.equal(s.coverage().acquisition, undefined);
    if (pageMiB === 8) {
      assert.equal(calls, 3); assert.equal(thirdPageChunks, 5); assert.equal(destroyed, true);
      assert.equal(s.coverage().reason, "RESEARCH_SOURCE_TOO_LARGE");
    } else { assert.equal(calls, 2); assert.equal(s.state.reservations.length, 2); assert.equal(s.coverage().reason, "RESEARCH_MARKETAUX_BYTES_EXCEEDED"); }
  }
});
