import test from "node:test";
import assert from "node:assert/strict";
import { researchFixture, twoSourceResearchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { marketauxCallIdentity, marketauxWindow, parseResearchSnapshot, researchHash, ResearchSourceFailure,
  type MarketauxRequest, type ResearchSnapshot, type StoredResearchSnapshot } from "@ikbr/shared/instrument-research";
import { ResearchRefreshScheduler } from "./research-refresh.js";
import { marketauxResponse } from "./research-marketaux.testfixture.js";
import { emptyResearchSnapshot } from "./research-empty-snapshot.js";

function harness() {
  const f = twoSourceResearchFixture(Date.parse("2026-10-15T12:35:00.000Z"));
  f.manifest.instruments = [f.policy]; f.manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = f.manifestHash;
  let head: StoredResearchSnapshot = { id: "initial", hash: researchHash(f.snapshot), sequence: 1, snapshot: f.snapshot };
  const state = { dbNow: f.now, hostNow: f.now + 3 * 86400000, nextRegular: 0, claims: 0, attempts: 0, active: false,
    requests: [] as MarketauxRequest[], outcomes: [] as { callKey: string; outcome: string; recordedAt: string; contentHash?: string }[],
    successes: [] as ResearchSnapshot[], failures: [] as { failure: any; snapshot: ResearchSnapshot }[],
    response: (request: MarketauxRequest) => marketauxResponse([], request.page, 0), terminalError: false, negativeError: false,
  };
  const unexpected = async (): Promise<never> => { throw new Error("unexpected legacy or WSH provider operation"); };
  const store: any = {
    withRefreshLock: async (_identity: unknown, run: () => Promise<void>) => { await run(); return true; },
    hasRefreshSlot: async () => true,
    latestSnapshot: unexpected, reserveCall: unexpected, recordCallOutcome: unexpected, storeSnapshot: unexpected,
    withWshEndpointLock: unexpected,
    claimMarketauxAttempt: async (identity: any) => {
      state.claims++;
      if (state.active || state.dbNow < state.nextRegular) return { claimed: false, reason: "not-due", nextCheckAt: new Date(state.nextRegular).toISOString() };
      state.active = true; state.attempts++; state.nextRegular = state.dbNow + 3600000;
      const slot = Math.floor(state.dbNow / 3600000);
      return { claimed: true, ticket: { ...identity, attemptId: `00000000-0000-4000-8000-${String(state.attempts).padStart(12, "0")}`,
        sourceHash: researchHash(f.source), slot, startedAt: new Date(state.dbNow).toISOString(), deadlineAt: new Date(state.dbNow + 120000).toISOString(),
        ...marketauxWindow(slot, f.newsConfig), monotonicDeadlineMs: performance.now() + 120000 } };
    },
    reserveMarketauxCall: async (ticket: any, request: MarketauxRequest, reservation: any) => {
      assert.equal(reservation.callKey, marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, request).callKey);
      assert.equal("deadlineAt" in reservation, false);
      assert.ok(ticket.monotonicDeadlineMs > performance.now());
      return { deadlineAt: new Date(state.dbNow + 10000).toISOString(), monotonicDeadlineMs: performance.now() + 9000 };
    },
    recordMarketauxCallOutcome: async (_ticket: unknown, callKey: string, result: any) => {
      state.dbNow += 100;
      const recordedAt = new Date(state.dbNow).toISOString(); state.outcomes.push({ callKey, ...result, recordedAt });
      return { recordedAt };
    },
    finalizeMarketauxSuccess: async (_ticket: unknown, build: (at: string) => ResearchSnapshot) => {
      if (state.terminalError) throw new Error("synthetic uncertain finalization");
      state.dbNow += 100;
      const snapshot = build(new Date(state.dbNow).toISOString());
      parseResearchSnapshot(snapshot, f.manifest); state.successes.push(structuredClone(snapshot));
      assert.equal("reports" in snapshot, false); assert.equal("facts" in snapshot, false);
      assert.equal(snapshot.coverage.some(c => c.role !== "news"), false);
      state.active = false;
      head = { id: "published", hash: researchHash(snapshot), sequence: head.sequence + 1, snapshot };
      return head;
    },
    finishMarketauxFailure: async (_ticket: unknown, failure: any, build: (at: string) => ResearchSnapshot) => {
      if (state.negativeError) throw new Error("synthetic uncertain negative finalization");
      const snapshot = build(new Date(state.dbNow).toISOString()); parseResearchSnapshot(snapshot, f.manifest);
      state.failures.push({ failure, snapshot }); state.active = false;
      return { retained: false, snapshot: null };
    },
  };
  const make = (marketauxOnDemand: boolean | undefined = false) => new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash,
    accountId: "DU_SYNTHETIC", store, now: () => state.hostNow, marketauxOnDemand, marketauxApiKey: "synthetic-secret",
    marketauxFetch: async (_source, request, deadlineAt, _maxBytes, monotonicDeadlineMs) => {
      assert.ok(monotonicDeadlineMs! > performance.now());
      assert.ok(Date.parse(deadlineAt) <= Date.now() + 10000);
      assert.ok(Date.parse(deadlineAt) > Date.now());
      state.requests.push(request); return state.response(request);
    } });
  return { f, state, store, make };
}

test("two-source scheduler rejects contradictory on-demand and missing attempt capability", () => {
  const s = harness();
  assert.throws(() => s.make(true), /RESEARCH_MARKETAUX_ON_DEMAND_POLICY_MISMATCH/);
  delete s.store.finishMarketauxFailure;
  assert.throws(() => s.make(), /RESEARCH_MARKETAUX_ATTEMPT_STORE_REQUIRED/);
});

test("hourly scheduler takes database query, page and completion times despite host skew and keeps one cycle across restart", async () => {
  const s = harness();
  await s.make().tick();
  assert.equal(s.state.requests.length, 2); assert.equal(s.state.successes.length, 1);
  const coverage = s.state.successes[0].coverage[0];
  assert.ok("acquisition" in coverage && coverage.acquisition?.kind === "marketaux-news-v2");
  assert.equal(coverage.checkedAt, new Date(s.state.dbNow).toISOString());
  assert.equal(coverage.acquisition.completedAt, coverage.checkedAt);
  assert.notEqual(coverage.windowEnd, coverage.checkedAt);
  assert.deepEqual(coverage.acquisition.pages.map(p => p.fetchedAt), s.state.outcomes.map(o => o.recordedAt));
  assert.deepEqual(coverage.acquisition.pages.map(p => p.contentHash), s.state.outcomes.map(o => o.contentHash));
  assert.equal(coverage.acquisition.slot, Math.floor(s.f.now / 3600000));
  assert.equal(coverage.status, "EMPTY");
  await s.make().tick();
  s.state.dbNow = s.state.nextRegular - 1; await s.make().tick();
  assert.equal(s.state.requests.length, 2);
  s.state.dbNow = s.state.nextRegular; await s.make().tick();
  assert.equal(s.state.requests.length, 4); assert.equal(s.state.successes.length, 2);
});

test("new acquisitions retain enrichment and use only the news source projection", async () => {
  const s = harness();
  s.state.response = request => marketauxResponse([{ uuid: "00000000-0000-0000-0000-000000000099", title: "Synthetic news", url: "https://news.example.org/fixture",
    published_at: new Date(Date.parse(request.asOf) - 60000).toISOString(), entities: [{ ...s.f.newsConfig.entity, sentiment_score: 0.3 }],
    description: "Synthetic description", snippet: "Synthetic snippet", similar: [] }], request.page, 1);
  await s.make().tick();
  const snapshot = s.state.successes[0];
  assert.equal(snapshot.schemaVersion, 2);
  if (snapshot.schemaVersion !== 2) throw new Error("schema2 required");
  assert.deepEqual(snapshot.news[0].providerSentiment, { status: "PROVIDED", score: 0.3 });
  assert.equal(snapshot.news[0].snippet, "Synthetic snippet");
  assert.equal(snapshot.evidence.length, 1); assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.coverage[0].status, "AVAILABLE");
});

test("known HTTP failures, unknown transport and malformed payload preserve distinct durable outcomes with no second pass", async () => {
  for (const mode of ["http", "unknown", "malformed"] as const) {
    const s = harness();
    s.state.response = request => {
      if (mode === "http") throw new ResearchSourceFailure("RESEARCH_SOURCE_HTTP_429", Object.assign(new Error("synthetic-secret limited"), { code: "rate_limit" }));
      if (mode === "unknown") throw new Error("transport lost");
      return marketauxResponse([], request.page, 1);
    };
    await s.make().tick();
    assert.equal(s.state.requests.length, 1); assert.equal(s.state.successes.length, 0); assert.equal(s.state.failures.length, 1);
    assert.equal(s.state.outcomes[0].outcome, mode === "http" ? "FAILED" : mode === "unknown" ? "UNKNOWN" : "SUCCEEDED");
    const { failure, snapshot } = s.state.failures[0];
    assert.equal(failure.outcome, mode === "unknown" ? "UNKNOWN" : "FAILED");
    assert.equal(snapshot.coverage[0].complete, false); assert.equal(snapshot.coverage[0].checkedAt, new Date(s.state.dbNow).toISOString());
    assert.equal("reports" in snapshot, false); assert.equal("facts" in snapshot, false);
    assert.equal(JSON.stringify(failure).includes("synthetic-secret"), false);
    await s.make().tick(); assert.equal(s.state.requests.length, 1);
  }
});

test("uncertain finalization is propagated and never rewritten as negative publication or retried acquisition", async () => {
  for (const negative of [false, true]) {
    const s = harness();
    if (negative) { s.state.negativeError = true; s.state.response = () => { throw new Error("transport lost"); }; }
    else s.state.terminalError = true;
    await assert.rejects(s.make().tick(), /synthetic uncertain/);
    assert.equal(s.state.failures.length, 0); assert.equal(s.state.successes.length, 0);
    const sent = s.state.requests.length;
    s.state.dbNow += 3600000; await s.make().tick(); assert.equal(s.state.requests.length, sent);
  }
});

test("outcome bookkeeping failures before or after commit remain UNKNOWN and prevent another provider call", async () => {
  for (const afterCommit of [false, true]) {
    const s = harness(), record = s.store.recordMarketauxCallOutcome;
    s.store.recordMarketauxCallOutcome = async (...args: unknown[]) => {
      if (afterCommit) await record(...args);
      throw new Error("synthetic unknown outcome commit");
    };
    await s.make().tick();
    assert.equal(s.state.requests.length, 1); assert.equal(s.state.successes.length, 0);
    assert.equal(s.state.failures[0].failure.outcome, "UNKNOWN");
    assert.equal(s.state.failures[0].snapshot.coverage[0].complete, false);
    assert.equal(s.state.outcomes.length, afterCommit ? 1 : 0);
    await s.make().tick(); assert.equal(s.state.requests.length, 1);
  }
});

test("empty snapshots preserve exact legacy shape and omit financial arrays only for the explicit policy", () => {
  const s = harness();
  const fresh = emptyResearchSnapshot(s.f.manifest, s.f.manifestHash, s.f.policy, new Date(s.f.now).toISOString());
  assert.equal("reports" in fresh, false); assert.equal("facts" in fresh, false);
  assert.equal("researchPolicy" in fresh && fresh.researchPolicy, "TWO_SOURCE_HOURLY_V1");
  parseResearchSnapshot(fresh, s.f.manifest);
  const legacy = researchFixture(s.f.now), createdAt = new Date(s.f.now).toISOString();
  assert.deepEqual(emptyResearchSnapshot(legacy.manifest, legacy.manifestHash, legacy.policy, createdAt), {
    schemaVersion: 1, configHash: legacy.configHash, manifestHash: legacy.manifestHash, instrumentId: legacy.policy.instrumentId,
    mappingHash: researchHash(legacy.policy), createdAt, evidence: [], coverage: [], reports: [], facts: [], news: [], events: [],
  });
});

test("WSH first acquisition builds truthful two-source success and hard-negative snapshots without financial fields", async () => {
  const { createHash } = await import("node:crypto");
  const { refreshWsh } = await import("./research-wsh-refresh.js");
  for (const failed of [false, true]) {
    const f = twoSourceResearchFixture(Date.parse("2026-10-15T12:35:00.000Z"));
    const metadata = JSON.stringify({ meta_data: { event_types: [{ tag: "wshe_ed", name: "Earnings", columns: [] }] } });
    (f.wshSource.parserConfig.qualification as any).metadataHash = createHash("sha256").update(metadata).digest("hex");
    const manifestHash = researchHash(f.manifest), stamp = new Date(f.now).toISOString();
    const identity = { configHash: f.manifest.configHash, manifestHash, instrumentId: f.policy.instrumentId };
    const lease = { endpointId: "fixture-endpoint", assertHeld: async () => {} };
    const published: ResearchSnapshot[] = [];
    let terminal: any;
    const store: any = {
      latestSnapshot: async () => null,
      withWshEndpointLock: async (_id: string, work: (l: typeof lease) => Promise<void>) => { await work(lease); return true; },
      pendingWshAcquisition: async () => null,
      claimWshAttempt: async (_lease: unknown, input: object) => ({ state: "CLAIMED", ticket: { ...input, id: "attempt", cycleId: "cycle", ordinal: 0,
        endpointId: lease.endpointId, startedAt: stamp, deadlineAt: new Date(f.now + 35000).toISOString(), nextRegularAt: new Date(f.now + 3600000).toISOString() } }),
      confirmWshPreflight: async () => {},
      beginWshAcquisition: async (_lease: unknown, input: object) => ({ ...input, ...identity, id: "00000000-0000-4000-8000-000000000001",
        endpointId: lease.endpointId, generation: 1, startedAt: stamp }),
      assertWshAcquisition: async () => {}, reserveWshCall: async () => {}, recordCallOutcome: async () => {},
      publishWshSnapshot: async (_lease: unknown, _acquisition: unknown, snapshot: ResearchSnapshot) => {
        parseResearchSnapshot(snapshot, f.manifest); published.push(snapshot);
      },
      finishWshAttempt: async (_lease: unknown, _ticket: unknown, result: any) => { terminal = result; },
    };
    await refreshWsh({ manifest: f.manifest, manifestHash, policy: f.policy, source: f.wshSource, accountId: "DU_SYNTHETIC", store, slotKey: "synthetic-slot",
      now: () => f.now, wsh: { runtime: { enabled: true, endpointId: lease.endpointId, host: "127.0.0.1", port: 4002, clientId: 77 },
        createTransport: () => ({ sessionId: "fixture-session", serverVersion: 180, sdkVersion: "1.6.10", connect: async () => {}, metadata: async () => metadata,
          events: async () => { if (failed) throw new Error("RESEARCH_WSH_PAYLOAD_INVALID"); return "[]"; },
          close: async () => ({ sessionId: "fixture-session", state: "CONFIRMED", completedAt: stamp, cancellationAttemptedAt: stamp,
            disconnectRequestedAt: stamp, localClosedAt: stamp, verifiedLocalClosure: true }) }) } });
    const snapshot = failed ? terminal.snapshot : published[0];
    parseResearchSnapshot(snapshot, f.manifest);
    assert.equal("reports" in snapshot, false); assert.equal("facts" in snapshot, false);
    assert.equal(snapshot.coverage.length, 1); assert.equal(snapshot.coverage[0].role, "calendar");
    assert.equal(snapshot.coverage[0].status, failed ? "ERROR" : "EMPTY");
    assert.equal(terminal.outcome, failed ? "FAILED" : "SUCCEEDED");
  }
});
