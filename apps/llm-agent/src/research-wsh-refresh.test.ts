import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { wshResearchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { parseResearchSnapshot, researchHash, type ResearchCallReservation, type StoredResearchSnapshot, type WshAcquisition, type WshEndpointLease } from "@ikbr/shared/instrument-research";
import { refreshWsh } from "./research-wsh-refresh.js";
import { ResearchRefreshScheduler } from "./research-refresh.js";
import type { WshEventRequest, WshTransport } from "./research-wsh-transport.js";

function harness(rows: unknown[] = []) {
  let clock = Date.parse("2026-10-07T10:01:00Z");
  const f = wshResearchFixture(clock);
  const metadata = JSON.stringify({ meta_data: { event_types: [{ tag: "wshe_ed", name: "Earnings", columns: [] }] } });
  (f.source.parserConfig.qualification as any).metadataHash = createHash("sha256").update(metadata).digest("hex");
  const manifestHash = researchHash(f.manifest);
  f.snapshot.manifestHash = manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  let head: StoredResearchSnapshot = { id: "prior", hash: researchHash(f.snapshot), sequence: 1, snapshot: structuredClone(f.snapshot) };
  const snapshots = new Map<string, StoredResearchSnapshot>([[head.id, head]]);
  const trace: string[] = [], outcomes = new Map<string, string>(), calls: ResearchCallReservation[] = [], slots = new Set<string>();
  let acquisition: WshAcquisition | null = null, state = "", generation = 0, lastStart = -Infinity, snapshotId: string | null = null, sessions = 0;
  let eventError: Error | null = null, metadataText = metadata, eventText: string | null = null, fenceLost = false;
  let failNegative = false, publishCommitLost = false, negativeCommitLost = false, beginCommitLost = false, retirementCommitLost = false;
  let advanceOnEvent = 0, refreshLocked = false;
  let readFailure = false;
  const lease: WshEndpointLease = { endpointId: "fixture-endpoint", assertHeld: async () => { if (fenceLost) throw new Error("RESEARCH_WSH_LOCK_LOST"); } };
  const save = (snapshot: any, slot?: string) => {
    parseResearchSnapshot(snapshot, f.manifest);
    head = { id: "snapshot-" + (snapshots.size + 1), hash: researchHash(snapshot), sequence: head.sequence + 1, snapshot: structuredClone(snapshot) };
    snapshots.set(head.id, head); if (slot) slots.add(slot); return head;
  };
  const retire = (outcome: string) => {
    for (const call of calls) if (!outcomes.has(call.callKey)) outcomes.set(call.callKey, outcome);
    state = outcome; generation++;
  };
  const store: any = {
    latestSnapshot: async () => head,
    readSnapshot: async (id: string) => snapshots.get(id) ?? null,
    storeSnapshot: async (snapshot: any, slot: string) => { trace.push("negative-without-acquisition"); return save(snapshot, slot); },
    hasRefreshSlot: async (slot: string) => slots.has(slot),
    withRefreshLock: async (_id: unknown, work: () => Promise<void>) => { if (refreshLocked) return false; refreshLocked = true; try { await work(); return true; } finally { refreshLocked = false; } },
    withWshEndpointLock: async (_endpoint: string, work: (l: WshEndpointLease) => Promise<void>) => { trace.push("lock"); await work(lease); return true; },
    pendingWshAcquisition: async () => { await lease.assertHeld(); return state === "PENDING" ? acquisition : null; },
    beginWshAcquisition: async (_lease: unknown, input: any) => {
      if (clock - lastStart < 900000) throw new Error("RESEARCH_WSH_SLOT_TOO_EARLY");
      if (calls.length >= f.source.maxRequestsPerDay) throw new Error("RESEARCH_CALL_BUDGET_EXHAUSTED");
      trace.push("reserve-metadata"); calls.push(input.reservation); lastStart = clock; snapshotId = null;
      state = "PENDING"; acquisition = { ...input, id: "00000000-0000-4000-8000-" + String(++generation).padStart(12, "0"), endpointId: lease.endpointId, generation, startedAt: new Date(clock).toISOString() };
      if (beginCommitLost) throw new Error("connection lost");
      return acquisition;
    },
    reserveWshCall: async (_lease: unknown, _acq: unknown, reservation: ResearchCallReservation) => {
      if (calls.length >= f.source.maxRequestsPerDay) throw new Error("RESEARCH_CALL_BUDGET_EXHAUSTED");
      trace.push("reserve-events"); calls.push(reservation);
    },
    assertWshAcquisition: async () => { await lease.assertHeld(); if (state !== "PENDING") throw new Error("RESEARCH_WSH_GENERATION_RETIRED"); },
    recordCallOutcome: async (key: string, outcome: string) => { trace.push("metadata-" + outcome); outcomes.set(key, outcome); },
    publishWshSnapshot: async (_lease: unknown, _acq: unknown, snapshot: any, slot: string) => {
      await lease.assertHeld(); assert.equal(state, "PENDING"); trace.push("publish");
      const saved = save(snapshot, slot); snapshotId = saved.id; state = "PUBLISHED";
      for (const call of calls) if (!outcomes.has(call.callKey)) outcomes.set(call.callKey, "SUCCEEDED");
      if (publishCommitLost) throw new Error("lost COMMIT reply");
      return saved;
    },
    finishWshFailure: async (_lease: unknown, _acq: unknown, snapshot: any, outcome: string, slot: string) => {
      await lease.assertHeld(); if (failNegative) throw new Error("negative DB unavailable");
      assert.equal(state, "PENDING"); trace.push("negative-" + outcome);
      const saved = save(snapshot, slot); snapshotId = saved.id; retire(outcome);
      if (negativeCommitLost) throw new Error("lost COMMIT reply");
      return saved;
    },
    retireWshAcquisition: async (_lease: unknown, _acq: unknown, outcome: string) => {
      trace.push("retire"); retire(outcome); if (retirementCommitLost) throw new Error("lost COMMIT reply");
    },
    readWshAcquisition: async () => {
      if (readFailure) throw new Error("readback unavailable");
      return acquisition ? { id: acquisition.id, endpoint_id: acquisition.endpointId, source_id: acquisition.sourceId, instrument_id: acquisition.instrumentId, config_hash: acquisition.configHash, manifest_hash: acquisition.manifestHash, state, snapshot_id: snapshotId, session_id: acquisition.sessionId, generation: acquisition.generation, retired_at: state === "PENDING" ? null : new Date(clock) } : null;
    },
  };
  let request: WshEventRequest | null = null;
  const createTransport = (): WshTransport => ({ sessionId: "session-" + (++sessions), serverVersion: 180, sdkVersion: "1.6.10",
    connect: async () => { trace.push("connect"); },
    metadata: async () => { assert.equal(calls.at(-1)?.requestHash.length, 64); trace.push("metadata"); return metadataText; },
    events: async (_id, req) => { assert.equal(calls.length % 2, 0); request = req; trace.push("events"); clock += advanceOnEvent; if (eventError) throw eventError; return eventText ?? JSON.stringify(rows); },
    close: () => { if (trace.at(-1) !== "close") trace.push("close"); },
  });
  const wsh = { runtime: { enabled: true, endpointId: "fixture-endpoint", host: "127.0.0.1", port: 4002, clientId: 77 }, createTransport };
  const options = { manifest: f.manifest, manifestHash, policy: f.policy, source: f.source, accountId: "DU1", store, slotKey: "slot", now: () => clock, wsh };
  return { f, options, trace, outcomes, calls, snapshots, store, wsh, get head() { return head; }, get request() { return request; }, get acquisition() { return acquisition; }, get state() { return state; },
    run: () => refreshWsh(options), advance: (ms: number) => clock += ms,
    faults: (v: { eventError?: Error; metadataText?: string; eventText?: string; fenceLost?: boolean; failNegative?: boolean; publishCommitLost?: boolean; negativeCommitLost?: boolean; beginCommitLost?: boolean; retirementCommitLost?: boolean; advanceOnEvent?: number; readFailure?: boolean }) => {
      if (v.eventError) eventError = v.eventError; if (v.metadataText !== undefined) metadataText = v.metadataText; if (v.eventText !== undefined) eventText = v.eventText;
      if (v.fenceLost !== undefined) fenceLost = v.fenceLost; if (v.failNegative !== undefined) failNegative = v.failNegative;
      if (v.publishCommitLost !== undefined) publishCommitLost = v.publishCommitLost; if (v.negativeCommitLost !== undefined) negativeCommitLost = v.negativeCommitLost;
      if (v.beginCommitLost !== undefined) beginCommitLost = v.beginCommitLost; if (v.retirementCommitLost !== undefined) retirementCommitLost = v.retirementCommitLost;
      if (v.advanceOnEvent !== undefined) advanceOnEvent = v.advanceOnEvent; if (v.readFailure !== undefined) readFailure = v.readFailure;
    } };
}
function row(h: ReturnType<typeof harness>, key = "event") { return { event_key: key, event_type: "wshe_ed", conids: [String(h.f.policy.listing.conId)], data: { company: { isin: h.f.source.issuerIdentifier.value }, earnings_date: "20261007", wshe_earnings_date_status: "Confirmed" } }; }
const calendar = (h: ReturnType<typeof harness>) => h.head.snapshot.coverage.find(c => c.sourceId === "wsh")!;

test("EMPTY is a complete bounded provider query, with committed metadata and events budgets before sends", async () => {
  const h = harness(); await h.run();
  assert.deepEqual(h.trace.filter(t => !["lock", "close"].includes(t)), ["connect", "reserve-metadata", "metadata", "metadata-SUCCEEDED", "reserve-events", "events", "publish"]);
  assert.equal(calendar(h).status, "EMPTY"); assert.equal(calendar(h).complete, true);
  assert.deepEqual(h.request, { conId: h.f.policy.listing.conId, filter: "", fillWatchlist: false, fillPortfolio: false, fillCompetitors: false, startDate: "20260928", endDate: "20261123", totalLimit: 100 });
  assert.deepEqual([...h.outcomes.values()], ["SUCCEEDED", "SUCCEEDED"]);
});

test("AVAILABLE merges report/news context, namespaces event evidence and preserves immutable prior snapshots", async () => {
  const h = harness(); h.f.snapshot.news = [];
  h.faults({ eventText: JSON.stringify([row(h), row(h)]) });
  const prior = structuredClone(h.head); await h.run();
  assert.equal(calendar(h).status, "AVAILABLE");
  assert.equal(h.head.snapshot.events.length, 1); assert.deepEqual(h.head.snapshot.reports, prior.snapshot.reports);
  assert.deepEqual(h.snapshots.get("prior"), prior);
  const event = h.head.snapshot.events[0], evidence = h.head.snapshot.evidence.find(e => e.ref === event.evidenceRef)!;
  assert.equal(evidence.published, null);
  assert.ok("knowledgeBasis" in evidence && evidence.knowledgeBasis === "FIRST_OBSERVED");
  assert.ok("wshAcquisition" in calendar(h));
  const coverage = calendar(h) as any; assert.equal(coverage.wshAcquisition.rowCount, 2); assert.equal(coverage.wshAcquisition.duplicateCount, 1);
});

test("timeouts preserve metadata success, retire only remaining call UNKNOWN, and have no immediate replay", async () => {
  const h = harness(); h.faults({ eventError: new Error("RESEARCH_WSH_TIMEOUT") }); await h.run();
  assert.deepEqual([...h.outcomes.values()], ["SUCCEEDED", "UNKNOWN"]); assert.equal(calendar(h).complete, false);
  await h.run(); assert.equal(h.trace.filter(t => t === "events").length, 1); assert.equal(h.calls.length, 2);
});

test("invalid identities, saturated rows, malformed JSON and oversized payload never publish success", async () => {
  for (const variant of ["foreign", "100", "101", "json", "oversized"] as const) {
    const h = harness(); const valid = row(h);
    const text = variant === "foreign" ? JSON.stringify([{ ...valid, conids: ["123"] }]) : variant === "json" ? "{" : variant === "oversized" ? " ".repeat(1048577) : JSON.stringify(Array.from({ length: Number(variant) }, (_, i) => ({ ...valid, event_key: String(i) })));
    h.faults({ eventText: text }); await h.run(); assert.equal(calendar(h).status, "ERROR", variant); assert.equal(h.trace.includes("publish"), false, variant);
  }
});

test("99 rows succeed without silently truncating the response", async () => {
  const h = harness(); h.faults({ eventText: JSON.stringify(Array.from({ length: 99 }, (_, i) => row(h, String(i)))) }); await h.run();
  assert.equal(h.head.snapshot.events.length, 99); assert.equal(calendar(h).complete, true);
});

test("disabled, mismatched endpoint, expired qualification and zero budgets make no socket I/O", async () => {
  for (const variant of ["disabled", "endpoint", "qualification", "budget"] as const) {
    const h = harness();
    if (variant === "disabled") h.wsh.runtime.enabled = false;
    if (variant === "endpoint") h.wsh.runtime.endpointId = "another-endpoint";
    if (variant === "qualification") h.advance(86400000);
    if (variant === "budget") h.f.source.maxRequestsPerDay = 0;
    // Keep test manifest identity consistent with changes normally made at startup.
    h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
    await h.run(); assert.equal(h.trace.includes("connect"), false, variant); assert.equal(h.calls.length, 0); assert.equal(calendar(h).status, "UNVERIFIED");
  }
});

test("metadata qualification mismatch prevents the event request", async () => {
  const h = harness(); h.faults({ metadataText: "{}" }); await h.run();
  assert.equal(h.calls.length, 1); assert.equal(h.trace.includes("events"), false); assert.equal(calendar(h).reason, "RESEARCH_WSH_METADATA_MISMATCH");
});

test("event budget exhaustion preserves the successful metadata receipt without sending events", async () => {
  const h = harness(); h.f.source.maxRequestsPerDay = 1;
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  await h.run(); assert.equal(h.trace.includes("events"), false); assert.deepEqual([...h.outcomes.values()], ["SUCCEEDED"]);
});

test("late replies cannot publish and preserve original last-good age if negative persistence fails", async () => {
  const h = harness(); const prior = structuredClone(h.head);
  h.faults({ advanceOnEvent: 10000, failNegative: true }); await assert.rejects(h.run(), /negative DB unavailable/);
  assert.deepEqual(h.head, prior); assert.equal(h.trace.includes("publish"), false); assert.equal(h.state, "PENDING");
  h.faults({ failNegative: false }); await h.run();
  assert.equal(h.trace.filter(t => t === "events").length, 1); assert.equal(calendar(h).reason, "RESEARCH_WSH_ABANDONED_ACQUISITION");
});

test("lost positive and negative COMMIT replies are resolved by exact acquisition and immutable snapshot readback", async () => {
  const positive = harness(); positive.faults({ publishCommitLost: true }); await positive.run();
  assert.equal(calendar(positive).complete, true); assert.equal(positive.trace.filter(t => t === "publish").length, 1); assert.equal(positive.trace.some(t => t.startsWith("negative")), false);
  const negative = harness(); negative.faults({ eventError: new Error("RESEARCH_WSH_TIMEOUT"), negativeCommitLost: true }); await negative.run();
  assert.equal(calendar(negative).complete, false); assert.equal(negative.trace.filter(t => t === "negative-UNKNOWN").length, 1);
});

test("uncertain begin COMMIT is retired without sending metadata and unresolved publication readback denies", async () => {
  const begin = harness(); begin.faults({ beginCommitLost: true }); await begin.run();
  assert.equal(begin.trace.includes("metadata"), false); assert.deepEqual([...begin.outcomes.values()], ["UNKNOWN"]);
  const publication = harness(); publication.faults({ publishCommitLost: true, readFailure: true });
  await assert.rejects(publication.run(), /readback unavailable/); assert.equal(publication.trace.filter(t => t === "publish").length, 1);
});

test("scheduler persists one 15-minute WSH slot across restarts and fresh sessions are used later", async () => {
  const h = harness(); h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  await new ResearchRefreshScheduler(h.options).tick(); await new ResearchRefreshScheduler(h.options).tick();
  assert.equal(h.trace.filter(t => t === "events").length, 1);
  h.advance(900000); await new ResearchRefreshScheduler(h.options).tick();
  assert.equal(h.trace.filter(t => t === "events").length, 2);
  assert.notEqual(h.calls[0].requestHash, h.calls[2].requestHash);
});

test("misaligned 15-minute backoff and endpoint lock contention do not consume a scheduler slot", async () => {
  const h = harness(); h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  const scheduler = new ResearchRefreshScheduler(h.options);
  await scheduler.tick();
  h.advance(14 * 60000); await scheduler.tick();
  assert.equal(h.trace.filter(t => t === "events").length, 1);
  h.advance(60000); await scheduler.tick();
  assert.equal(h.trace.filter(t => t === "events").length, 2);
  h.advance(900000);
  const lock = h.store.withWshEndpointLock; h.store.withWshEndpointLock = async () => false;
  await scheduler.tick(); assert.equal(h.trace.filter(t => t === "events").length, 2);
  h.store.withWshEndpointLock = lock; await scheduler.tick();
  assert.equal(h.trace.filter(t => t === "events").length, 3);
});

test("lost endpoint lease cannot send or publish from a stale generation", async () => {
  const h = harness(); h.faults({ fenceLost: true });
  await assert.rejects(h.run(), /RESEARCH_WSH_LOCK_LOST/);
  assert.equal(h.trace.includes("metadata"), false); assert.equal(h.trace.includes("publish"), false);
});
