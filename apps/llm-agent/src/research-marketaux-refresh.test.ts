import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { marketauxSourceUrl, inspectResearch, parseResearchSnapshot, researchHash, type InstrumentResearchSnapshotV1, type ResearchSnapshot, type MarketauxRequest, type ResearchCallReservation, type StoredResearchSnapshot } from "@ikbr/shared/instrument-research";
import { ResearchRefreshScheduler, researchSourceSlot } from "./research-refresh.js";
import { marketauxFixture, marketauxResponse } from "./research-marketaux.testfixture.js";
import type { ResearchFetchResult } from "./research-fetch.js";
import { createMarketauxFetch, type MarketauxFetch } from "./research-marketaux-fetch.js";

function setup(now?: number) {
  const f = marketauxFixture(now); f.manifest.instruments = [f.policy]; f.manifestHash = researchHash(f.manifest);
  f.snapshot.manifestHash = f.manifestHash;
  const state = { now: f.now, requests: [] as MarketauxRequest[], reservations: [] as ResearchCallReservation[], reservationDays: new Map<string, string>(), outcomes: [] as string[], snapshots: [] as InstrumentResearchSnapshotV1[], slots: new Set<string>(),
    prior: { id: "prior", hash: researchHash(f.snapshot), sequence: 1, snapshot: f.snapshot } as StoredResearchSnapshot,
    onReserve: (_reservation: ResearchCallReservation) => {},
    onStore: (_snapshot: InstrumentResearchSnapshotV1, _deadline: string | undefined) => {},
    response: (request: MarketauxRequest): ResearchFetchResult => marketauxResponse([f.article(1), f.article(2), f.article(3)].slice((request.page - 1) * 2, request.page * 2), request.page, 3),
  };
  const unsupportedWshCall = async (): Promise<never> => { throw new Error("unexpected WSH call in HTTP-only fixture"); };
  const store = {
    readSnapshot: unsupportedWshCall,
    withWshEndpointLock: unsupportedWshCall,
    claimWshAttempt: unsupportedWshCall, confirmWshPreflight: unsupportedWshCall, finishWshAttempt: unsupportedWshCall, readWshAttempt: unsupportedWshCall, dueWshAttempts: unsupportedWshCall,
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
      const budgetDay = new Date(state.now).toISOString().slice(0, 10);
      const used = state.reservations.filter(prior => prior.accountId === r.accountId && prior.provider === r.provider && state.reservationDays.get(prior.callKey) === budgetDay);
      if (used.length >= r.maxRequestsPerDay || used.reduce((sum, row) => sum + row.reservedCostMicros, 0) + r.reservedCostMicros > r.maxCostMicrosPerDay) throw new Error("RESEARCH_BUDGET_EXHAUSTED");
      state.reservations.push(r); state.onReserve(r);
      state.reservationDays.set(r.callKey, budgetDay);
      return { callKey: r.callKey, reservedAt: new Date(state.now).toISOString(), budgetDay };
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
  const make = (key: string | undefined = "synthetic-secret", fetch?: MarketauxFetch, marketauxOnDemand?: boolean) => new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash, accountId: "DU_TEST", store, marketauxOnDemand,
    marketauxApiKey: key, now: () => state.now, marketauxFetch: fetch ?? (async (_source, descriptor) => { state.requests.push(descriptor); return state.response(descriptor); }) });
  const coverage = () => state.snapshots.at(-1)!.coverage.find(c => c.sourceId === f.source.id)!;
  const rehash = () => { f.manifestHash = researchHash(f.manifest); state.prior.snapshot.manifestHash = f.manifestHash; state.prior.snapshot.mappingHash = researchHash(f.policy); };
  return { f, state, store, make, coverage, rehash };
}

function enableRepairs(s: ReturnType<typeof setup>) {
  let queued = false, inspections = 0;
  const inspect = async () => {
    inspections++;
    const result = inspectResearch(s.f.manifest, s.f.policy.instrumentId, s.state.prior, s.state.now);
    queued = result.state === "WAITING";
    return result;
  };
  Object.assign(s.store, {
    dueRepairs: async () => queued ? [{ instrumentId: s.f.policy.instrumentId, sourceId: s.f.source.id, role: "news" }] : [],
    prepareRepair: inspect,
  });
  return { enqueue: inspect, get inspections() { return inspections; } };
}

test("on-demand Marketaux makes no calls or inspections without a queued candidate, including after restart", async () => {
  const s = setup(), repairs = enableRepairs(s);
  for (let i = 0; i < 3; i++) {
    const scheduler = s.make(undefined, undefined, true);
    await Promise.all([scheduler.tick(), scheduler.tickRepairs()]);
    s.state.now += 900000;
  }
  assert.equal(repairs.inspections, 0);
  assert.equal(s.state.requests.length, 0); assert.equal(s.state.reservations.length, 0); assert.equal(s.state.snapshots.length, 0);
});

test("on-demand queued repair completes both passes, becomes READY and does not rearm when news becomes stale", async () => {
  const s = setup(), repairs = enableRepairs(s);
  assert.equal((await repairs.enqueue()).state, "WAITING");
  await s.make(undefined, undefined, true).tickRepairs();
  assert.equal(s.coverage().complete, true); assert.equal(s.state.requests.length, 4);
  const final = inspectResearch(s.f.manifest, s.f.policy.instrumentId, s.state.prior, s.state.now);
  assert.equal(final.state, "READY", JSON.stringify(final));
  const inspections = repairs.inspections;
  s.state.now += 1800001;
  assert.equal(inspectResearch(s.f.manifest, s.f.policy.instrumentId, s.state.prior, s.state.now).state, "WAITING");
  const restarted = s.make(undefined, undefined, true);
  await Promise.all([restarted.tick(), restarted.tickRepairs()]);
  assert.equal(s.state.requests.length, 4); assert.equal(repairs.inspections, inspections);
  assert.equal((await repairs.enqueue()).state, "WAITING");
  await restarted.tickRepairs();
  assert.equal(s.state.requests.length, 8); assert.equal(s.coverage().complete, true);
});

test("default periodic preparation and on-demand repair share locks and slots across racing workers and restart", async () => {
  for (const repairFirst of [true, false]) {
    const s = setup(), repairs = enableRepairs(s);
    assert.equal((await repairs.enqueue()).state, "WAITING");
    const periodic = s.make(), repair = s.make(undefined, undefined, true);
    await Promise.all(repairFirst ? [repair.tickRepairs(), periodic.tick()] : [periodic.tick(), repair.tickRepairs()]);
    await s.make(undefined, undefined, true).tickRepairs();
    await s.make().tick();
    assert.equal(s.state.requests.length, 4); assert.equal(s.state.reservations.length, 4); assert.equal(s.state.snapshots.length, 1);
  }
});

test("on-demand repair retains budget exhaustion and unknown outcome holds without replay after restart", async () => {
  for (const mode of ["budget", "unknown"] as const) {
    const s = setup();
    if (mode === "budget") s.f.source.maxRequestsPerDay = 3;
    else s.state.response = () => { throw new Error("unknown transport outcome"); };
    s.rehash(); const repairs = enableRepairs(s);
    assert.equal((await repairs.enqueue()).state, "WAITING");
    await s.make(undefined, undefined, true).tickRepairs();
    assert.equal(s.coverage().complete, false);
    assert.equal(inspectResearch(s.f.manifest, s.f.policy.instrumentId, s.state.prior, s.state.now).state, "HOLD");
    const calls = s.state.requests.length; assert.equal(calls, mode === "budget" ? 3 : 1);
    if (mode === "unknown") assert.ok(s.state.outcomes[0].endsWith(":UNKNOWN"));
    await s.make(undefined, undefined, true).tickRepairs();
    assert.equal(s.state.requests.length, calls);
  }
});

test("renewed local budget repairs in a fresh slot with two passes before news becomes READY", async () => {
  const day = Date.parse("2026-10-13T17:45:10.000Z");
  const s = setup(day);
  s.f.source.maxRequestsPerDay = 4;
  s.f.newsConfig.qualification.expiresAt = new Date(day + 2 * 86400000).toISOString();
  s.f.newsConfig.entitlement.expiresAt = new Date(day + 2 * 86400000).toISOString();
  s.rehash();
  const earlier = { accountId: "DU_TEST", provider: s.f.source.provider, callKey: "other-instrument-earlier-call", reservedCostMicros: 1 } as ResearchCallReservation;
  s.state.reservations.push(earlier);
  s.state.reservationDays.set(earlier.callKey, new Date(day).toISOString().slice(0, 10));
  await s.make().tick();
  assert.equal(s.coverage().reason, "RESEARCH_BUDGET_EXHAUSTED");
  assert.equal(s.state.requests.length, 3);
  const original = structuredClone(s.state.snapshots[0]);
  const originalKeys = s.state.reservations.map(row => row.callKey);
  const renewedDay = day + 86400000;
  Object.assign(s.store, {
    dueRepairs: async () => [{ instrumentId: s.f.policy.instrumentId, sourceId: s.f.source.id, role: "news" }],
    prepareRepair: async () => s.state.now < renewedDay ? { state: "HOLD", reasons: ["RESEARCH_NEWS_ERROR"], sources: [] }
      : s.state.snapshots.length === 1 ? { state: "WAITING", reasons: ["RESEARCH_MARKETAUX_BUDGET_RENEWED"], sources: [{
        sourceId: s.f.source.id, role: "news", state: "WAITING", reasons: ["RESEARCH_MARKETAUX_BUDGET_RENEWED"], nextCheckAt: new Date(s.state.now).toISOString(),
      }] } : inspectResearch(s.f.manifest, s.f.policy.instrumentId, s.state.prior, s.state.now),
  });
  await s.make(undefined, undefined, true).tickRepairs();
  assert.equal(s.state.requests.length, 3);
  s.state.now = renewedDay;
  s.state.response = request => marketauxResponse([1, 2, 3].map(n => s.f.article(n, new Date(Date.parse(request.asOf) - 60000).toISOString()))
    .slice((request.page - 1) * 2, request.page * 2), request.page, 3);
  await s.make(undefined, undefined, true).tickRepairs();
  assert.equal(s.state.requests.length, 7);
  assert.deepEqual(s.state.snapshots[0], original);
  assert.deepEqual(s.state.reservations.slice(0, originalKeys.length).map(row => row.callKey), originalKeys);
  assert.equal(new Set(s.state.reservations.map(row => row.callKey)).size, s.state.reservations.length);
  assert.deepEqual(s.state.reservations.slice(originalKeys.length).map(row => s.state.reservationDays.get(row.callKey)), Array(4).fill("2026-10-14"));
  assert.equal(s.coverage().complete, true);
  const final = inspectResearch(s.f.manifest, s.f.policy.instrumentId, s.state.prior, s.state.now);
  assert.equal(final.sources.find(row => row.sourceId === s.f.source.id)?.state, "READY");
  assert.equal(final.state, "HOLD");
  assert.ok(final.reasons.includes("RESEARCH_SOURCE_MAPPING_UNSUPPORTED"));
});

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
  assert.equal(large.state.prior.snapshot.schemaVersion, 1);
  if (large.state.prior.snapshot.schemaVersion !== 1) throw new Error("V1 fixture required");
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

test('transient on-demand failure retains original diagnostics and recovers only in a fresh slot after restart',async()=>{
 const {ResearchSourceFailure}=await import('@ikbr/shared/instrument-research');
 const s=setup(), repairs=enableRepairs(s);await repairs.enqueue();
 s.state.response=()=>{throw new ResearchSourceFailure('RESEARCH_SOURCE_TIMEOUT',Object.assign(new Error('The operation was aborted synthetic-secret'),{name:'AbortError',code:'ABORT_ERR'}));};
 await s.make(undefined,undefined,true).tickRepairs();

 const failed=s.coverage(), initialCalls=s.state.reservations.map(r=>r.callKey);
 assert.equal(failed.sourceError?.code,'ABORT_ERR');assert.ok(!failed.sourceError?.message.includes('synthetic-secret'));
 const waiting=await repairs.enqueue();assert.equal(waiting.state,'WAITING');assert.equal(waiting.sources.find(r=>r.sourceId===s.f.source.id)?.failureReason,'RESEARCH_SOURCE_TIMEOUT');
 assert.ok(Date.parse(waiting.nextCheckAt!)>s.state.now);
 await s.make(undefined,undefined,true).tickRepairs();assert.equal(s.state.reservations.length,1);
 s.state.now=(s.f.slot+1)*900000+1000;s.state.response=r=>marketauxResponse([],r.page,0);
 await s.make(undefined,undefined,true).tickRepairs();
 assert.equal(s.coverage().status,'EMPTY');assert.equal(s.coverage().sourceError,undefined);assert.equal(s.state.reservations.length,3);
 assert.equal(new Set(s.state.reservations.map(r=>r.callKey)).size,3);assert.ok(s.state.outcomes.some(row=>row===initialCalls[0]+':UNKNOWN'));
 assert.equal((await repairs.enqueue()).state,'READY');
});
test('hard provider status and semantic failures remain holds even when diagnostics contain retry wording',async()=>{
 const {ResearchSourceFailure}=await import('@ikbr/shared/instrument-research');
 for(const [reason,httpStatus] of [['RESEARCH_SOURCE_HTTP_401',401],['RESEARCH_MARKETAUX_PAYLOAD_INVALID',undefined],['RESEARCH_SOURCE_TIMEOUT',403]] as const){
  const s=setup(),repairs=enableRepairs(s);await repairs.enqueue();
  s.state.response=()=>{throw new ResearchSourceFailure(reason,Object.assign(new Error('please retry timeout'),{code:'TLS_CERT_INVALID'}),{},httpStatus===undefined?undefined:{httpStatus});};
  await s.make(undefined,undefined,true).tickRepairs();assert.equal((await repairs.enqueue()).state,'HOLD');
  s.state.now+=900000;await s.make(undefined,undefined,true).tickRepairs();assert.equal(s.state.reservations.length,1);
 }
});

test('another due source never makes a future Marketaux repair run early',async()=>{
 const s=setup();
 Object.assign(s.store,{dueRepairs:async()=>[{instrumentId:s.f.policy.instrumentId,sourceId:s.f.source.id,role:'news'}],prepareRepair:async()=>({state:'WAITING',reasons:['RESEARCH_SOURCE_TRANSIENT_FAILURE'],sources:[{sourceId:s.f.source.id,role:'news',state:'WAITING',reasons:['RESEARCH_SOURCE_TRANSIENT_FAILURE'],nextCheckAt:new Date(s.state.now+900000).toISOString()}]})});
 await s.make(undefined,undefined,true).tickRepairs();assert.equal(s.state.reservations.length,0);
});

test('JSON syntax diagnostics preserve error identity without storing payload excerpts',async()=>{
 const s=setup();s.state.response=()=>({payload:Buffer.from('CONFIDENTIAL EARNINGS TEXT'),contentHash:'a'.repeat(64),contentType:'application/json'});
 await s.make().tick();assert.equal(s.coverage().sourceError?.name,'SyntaxError');
 assert.ok(!JSON.stringify(s.state.snapshots).includes('CONFIDENTIAL EARNINGS TEXT'));
 assert.match(s.coverage().sourceError!.message,/source excerpt omitted/);assert.equal(inspectResearch(s.f.manifest,s.f.policy.instrumentId,s.state.prior,s.state.now).state,'HOLD');
});


test("ordinary first-page capacity failure keeps one charged successful call and a diagnostic HOLD", async () => {
  const s = setup();
  Object.assign(s.f.newsConfig, { pageSize: 3, maxPagesPerPass: 10, maxArticles: 30 });
  s.f.source.urls = [marketauxSourceUrl(s.f.newsConfig)]; s.rehash();
  s.state.response = request => marketauxResponse([
    { ...s.f.article(1), title: "synthetic-secret DU_TEST private payload must not persist" }, s.f.article(2), s.f.article(3),
  ], request.page, 31, 3);
  const repairs = enableRepairs(s);
  assert.equal((await repairs.enqueue()).state, "WAITING");
  await s.make(undefined, undefined, true).tickRepairs();
  const coverage = s.coverage();
  assert.equal(s.state.requests.length, 1); assert.equal(s.state.reservations.length, 1);
  assert.deepEqual(s.state.outcomes, [s.state.reservations[0].callKey + ":SUCCEEDED"]);
  assert.equal(coverage.status, "ERROR"); assert.equal(coverage.complete, false);
  assert.equal(coverage.reason, "RESEARCH_MARKETAUX_RESULT_LIMIT");
  assert.deepEqual(coverage.evidenceRefs, []); assert.equal(coverage.acquisition, undefined);
  assert.equal(s.state.snapshots[0].news.length, 0);
  assert.deepEqual(coverage.sourceError, { name: "MarketauxCapacityLimitError", code: null,
    message: "Local Marketaux capacity validation; providerReportedFound=31; pageSize=3; requiredPages=11; maxPagesPerPass=10; maxArticles=30; pass=1; page=1; exceeded=maxArticles,maxPagesPerPass" });
  const preparation = await repairs.enqueue();
  assert.equal(preparation.state, "HOLD"); assert.ok(preparation.reasons.includes("RESEARCH_MARKETAUX_RESULT_LIMIT"));
  const serialized = JSON.stringify(coverage);
  for (const privateText of ["synthetic-secret", "DU_TEST", "private payload"]) assert.equal(serialized.includes(privateText), false);
  s.state.now += 900000;
  const restarted = s.make(undefined, undefined, true);
  await Promise.all([restarted.tick(), restarted.tickRepairs()]);
  assert.equal(s.state.requests.length, 1); assert.equal(s.state.reservations.length, 1);
});


test("ongoing Marketaux retains two-pass acquisition, finite budgets and on-demand scheduling", async () => {
  const s = setup();
  for (const name of ["qualification", "entitlement"]) Object.assign(s.f.source.parserConfig[name] as object, { expiresAt: null,
    validity: { mode: "OPERATOR_CONFIRMED_ONGOING", confirmedAt: new Date(s.state.now - 1000).toISOString(), confirmationRef: "fixture-confirmation", confirmationHash: "a".repeat(64) } });
  s.rehash();
  await s.make(undefined, undefined, true).tick(); assert.equal(s.state.requests.length, 0);
  await s.make().tick();
  assert.equal(s.coverage().status, "AVAILABLE"); assert.equal(s.state.requests.length, 4);
  assert.deepEqual(s.state.requests.map(r => r.pass), [1, 1, 2, 2]);
  for (const r of s.state.reservations) assert.ok(Date.parse(r.deadlineAt) > s.state.now && Date.parse(r.deadlineAt) <= s.state.now + 10000);
  assert.equal(s.coverage().acquisition?.entityQualificationHash, researchHash(s.f.source.parserConfig.qualification));
  assert.equal(s.coverage().acquisition?.entitlementHash, researchHash(s.f.source.parserConfig.entitlement));
});


test("mixed Marketaux policy expiry after first page prevents the next send", async () => {
  const s = setup();
  Object.assign(s.f.newsConfig.qualification, { expiresAt: null,
    validity: { mode: "OPERATOR_CONFIRMED_ONGOING", confirmedAt: new Date(s.state.now - 1000).toISOString(), confirmationRef: "fixture-confirmation", confirmationHash: "a".repeat(64) } });
  s.f.newsConfig.entitlement.expiresAt = new Date(s.state.now + 50).toISOString(); s.rehash();
  s.state.onReserve = () => { if (s.state.reservations.length === 2) s.state.now += 100; };
  await s.make().tick();
  assert.equal(s.state.requests.length, 1); assert.equal(s.state.reservations.length, 2);
  assert.equal(s.coverage().status, "ERROR"); assert.equal(s.coverage().reason, "RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE");
});

test("future ongoing Marketaux confirmation sends no provider request", async () => {
  const s = setup();
  Object.assign(s.f.newsConfig.qualification, { expiresAt: null,
    validity: { mode: "OPERATOR_CONFIRMED_ONGOING", confirmedAt: new Date(s.state.now + 1).toISOString(), confirmationRef: "fixture-confirmation", confirmationHash: "a".repeat(64) } });
  s.rehash(); await s.make().tick();
  assert.equal(s.state.requests.length, 0); assert.equal(s.state.reservations.length, 0);
  assert.equal(s.coverage().status, "UNVERIFIED");
});
