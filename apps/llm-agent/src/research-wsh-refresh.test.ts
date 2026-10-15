import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { wshResearchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { ResearchStore, parseResearchSnapshot, researchHash, researchRefreshSlotKey, type ResearchCallReservation, type StoredResearchSnapshot, type WshAcquisition, type WshEndpointLease, type WshAttemptTicket, type WshAttemptResult, type WshCleanupResult } from "@ikbr/shared/instrument-research";
import { classifyWshFailure, refreshWsh } from "./research-wsh-refresh.js";
import { ResearchRefreshScheduler } from "./research-refresh.js";
import type { WshEventRequest, WshTransport } from "./research-wsh-transport.js";

function harness(rows: unknown[] = [], ongoing = false, configure?: (source: ReturnType<typeof wshResearchFixture>["source"], now: number) => void) {
  let clock = Date.parse("2026-10-07T10:01:00Z");
  const f = wshResearchFixture(clock);
  if (ongoing) {
    for (const name of ["qualification", "entitlement"]) Object.assign(f.source.parserConfig[name] as object, { expiresAt: null,
      validity: { mode: "OPERATOR_CONFIRMED_ONGOING", confirmedAt: new Date(clock - 1000).toISOString(), confirmationRef: "fixture-confirmation", confirmationHash: "a".repeat(64) } });
    f.source.parserConfig.refreshIntervalMs = 3600000; f.source.parserConfig.maxAgeMs = 86400000;
  }
  const metadata = JSON.stringify({ meta_data: { event_types: [{ tag: "wshe_ed", name: "Earnings", columns: [] }] } });
  (f.source.parserConfig.qualification as any).metadataHash = createHash("sha256").update(metadata).digest("hex");
  configure?.(f.source, clock);
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
  let cycleStart = -Infinity, nextRegularAt = -Infinity;
  const attempts: { ticket: WshAttemptTicket; preflightComplete?: boolean; result?: WshAttemptResult }[] = [];
  const cleanupReceipt = (sessionId = 'session-' + sessions): WshCleanupResult => ({ sessionId, state: 'CONFIRMED', completedAt: new Date(clock).toISOString(),
    cancellationAttemptedAt: new Date(clock).toISOString(), disconnectRequestedAt: new Date(clock).toISOString(), localClosedAt: new Date(clock).toISOString(), verifiedLocalClosure: true });
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
    claimWshAttempt: async (_lease: unknown, input: any, kind: string) => {
      const last = attempts.at(-1), ordinal = kind === 'retry' ? (last?.ticket.ordinal ?? 0) + 1 : 0;
      if (kind === 'regular' && clock < nextRegularAt || kind === 'retry' && (!last?.result || last.result.outcome !== 'FAILED'
        || last.result.failureClass !== 'TRANSIENT' || last.result.cleanup.state === 'UNKNOWN' || ordinal > 2
        || clock < Date.parse(last.result.cleanup.completedAt) + (ordinal === 1 ? 30000 : 120000) || clock >= nextRegularAt))
        return { state: 'DEFERRED', reason: 'not-due', nextCheckAt: null };
      if (kind === 'regular') { cycleStart = clock; nextRegularAt = clock + Number(f.source.parserConfig.refreshIntervalMs); }
      const ticket: WshAttemptTicket = { ...input, id: `attempt-${attempts.length + 1}`, cycleId: `cycle-${cycleStart}`, ordinal,
        endpointId: lease.endpointId, startedAt: new Date(clock).toISOString(), deadlineAt: new Date(clock + 35000).toISOString(), nextRegularAt: new Date(nextRegularAt).toISOString() };
      attempts.push({ ticket }); return { state: 'CLAIMED', ticket };
    },
    confirmWshPreflight: async (_lease: unknown, ticket: WshAttemptTicket) => { attempts.find(a => a.ticket.id === ticket.id)!.preflightComplete = true; },
    dueWshAttempts: async () => {
      const last = attempts.at(-1);
      return last?.result?.outcome === 'FAILED' && last.result.failureClass === 'TRANSIENT' && last.result.cleanup.state !== 'UNKNOWN'
        && last.ticket.ordinal < 2 && clock < nextRegularAt && clock >= Date.parse(last.result.cleanup.completedAt) + (last.ticket.ordinal === 0 ? 30000 : 120000)
        ? [{ identity: { ...last.ticket }, kind: 'retry', dueAt: new Date(clock).toISOString() }] : [];
    },
    readWshAttempt: async (ticket: WshAttemptTicket) => {
      if (readFailure) throw new Error('readback unavailable');
      const attempt = attempts.find(a => a.ticket.id === ticket.id);
      return attempt && { state: attempt.result?.outcome ?? 'STARTED', terminalResultHash: attempt.result && researchHash(attempt.result) };
    },
    finishWshAttempt: async (_lease: unknown, ticket: WshAttemptTicket, result: WshAttemptResult) => {
      await lease.assertHeld();
      if (result.outcome !== 'SUCCEEDED') {
        if (failNegative) throw new Error('negative DB unavailable');
        const good = head.snapshot.coverage.find(c => c.sourceId === f.source.id && c.complete);
        const retain = good && ['TRANSIENT', 'BUSY', 'ABORTED', 'BUDGET'].includes(result.failureClass);
        if (!retain) {
          trace.push(result.acquisition ? `negative-${result.acquisitionOutcome}` : 'negative-without-acquisition');
          snapshotId = save(result.snapshot, result.slotKey).id;
        }
        if (result.acquisition) retire(result.acquisitionOutcome ?? result.outcome);
      }
      attempts.find(a => a.ticket.id === ticket.id)!.result = result;
      if (negativeCommitLost && result.outcome !== 'SUCCEEDED') throw new Error('lost COMMIT reply');
    },
    latestSnapshot: async () => head,
    readSnapshot: async (id: string) => snapshots.get(id) ?? null,
    storeSnapshot: async (snapshot: any, slot: string) => { trace.push("negative-without-acquisition"); return save(snapshot, slot); },
    hasRefreshSlot: async (slot: string) => slots.has(slot),
    withRefreshLock: async (_id: unknown, work: () => Promise<void>) => { if (refreshLocked) return false; refreshLocked = true; try { await work(); return true; } finally { refreshLocked = false; } },
    withWshEndpointLock: async (_endpoint: string, work: (l: WshEndpointLease) => Promise<void>) => { trace.push("lock"); await work(lease); return true; },
    pendingWshAcquisition: async () => { await lease.assertHeld(); return state === "PENDING" ? acquisition : null; },
    beginWshAcquisition: async (_lease: unknown, input: any, ticket?: WshAttemptTicket) => {
      if (!ticket && clock - lastStart < 900000) throw new Error("RESEARCH_WSH_SLOT_TOO_EARLY");
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
  const createTransport = (): WshTransport => { const sessionId = "session-" + (++sessions); return { sessionId, serverVersion: 180, sdkVersion: "1.6.10",
    connect: async () => { trace.push("connect"); },
    metadata: async () => { assert.equal(calls.at(-1)?.requestHash.length, 64); trace.push("metadata"); return metadataText; },
    events: async (_id, req) => { assert.equal(calls.length % 2, 0); request = req; trace.push("events"); clock += advanceOnEvent; if (eventError) throw eventError; return eventText ?? JSON.stringify(rows); },
    close: async () => { if (trace.at(-1) !== "close") trace.push("close"); return cleanupReceipt(sessionId); },
  }; };
  const wsh = { runtime: { enabled: true, endpointId: "fixture-endpoint", host: "127.0.0.1", port: 4002, clientId: 77 }, createTransport };
  const options = { manifest: f.manifest, manifestHash, policy: f.policy, source: f.source, accountId: "DU1", store, slotKey: "slot", now: () => clock, wsh };
  return { f, options, trace, outcomes, calls, snapshots, slots, store, wsh, attempts, cleanupReceipt, get head() { return head; }, get request() { return request; }, get acquisition() { return acquisition; }, get state() { return state; },
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

test('hourly scheduler suppresses intervening 15-minute slots and retries a deferred hour boundary at the durable deadline', async () => {
  const h = harness(); h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.f.source.parserConfig.refreshIntervalMs = 3600000; h.f.source.parserConfig.maxAgeMs = 86400000;
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  const key = (hour: string) => researchRefreshSlotKey(h.options.manifestHash, h.f.policy.instrumentId, h.f.source.id, 'calendar', Math.floor(Date.parse(hour) / 3600000));
  const scheduler = new ResearchRefreshScheduler(h.options);
  const claim = h.store.claimWshAttempt; let claims = 0;
  h.store.claimWshAttempt = async (...args: any[]) => { claims++; return claim(...args); };
  await scheduler.tick();
  assert.deepEqual([...h.slots], [key('2026-10-07T10:00:00Z')]);
  assert.equal(h.attempts[0].ticket.nextRegularAt, '2026-10-07T11:01:00.000Z');
  for (const elapsed of [14, 15, 15]) {
    h.advance(elapsed * 60000); await scheduler.tick(); await new ResearchRefreshScheduler(h.options).tick();
    assert.equal(claims, 1); assert.equal(h.calls.length, 2);
  }
  h.advance(15 * 60000); await scheduler.tick(); // 11:00, before the 11:01 durable deadline.
  assert.equal(claims, 2); assert.equal(h.attempts.length, 1); assert.equal(h.slots.size, 1);
  h.advance(59999); await scheduler.tick();
  assert.equal(claims, 3); assert.equal(h.calls.length, 2); assert.equal(h.slots.size, 1);
  h.store.dueWshAttempts = async () => [{ identity: { ...h.attempts[0].ticket }, kind: 'regular', dueAt: h.attempts[0].ticket.nextRegularAt }];
  h.advance(1); await scheduler.tickRepairs();
  assert.equal(claims, 4); assert.equal(h.calls.length, 4); assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[1].ticket.startedAt, '2026-10-07T11:01:00.000Z');
  assert.equal(h.attempts[1].ticket.nextRegularAt, '2026-10-07T12:01:00.000Z');
  assert.deepEqual([...h.slots], [key('2026-10-07T10:00:00Z'), key('2026-10-07T11:00:00Z')]);
  await scheduler.tick(); await scheduler.tickRepairs(); await new ResearchRefreshScheduler(h.options).tick();
  assert.equal(claims, 4); assert.equal(h.calls.length, 4);
});

test("lost endpoint lease cannot send or publish from a stale generation", async () => {
  const h = harness(); h.faults({ fenceLost: true });
  await assert.rejects(h.run(), /RESEARCH_WSH_LOCK_LOST/);
  assert.equal(h.trace.includes("metadata"), false); assert.equal(h.trace.includes("publish"), false);
});

for (const boundary of ["lock", "begin", "reserve", "checkpoint"] as const) {
  test(`abort after awaited ${boundary} prevents the next WSH request`, async () => {
    const h = harness(), controller = new AbortController();
    if (boundary === "lock") {
      const original = h.store.withWshEndpointLock;
      h.store.withWshEndpointLock = async (...args: any[]) => { controller.abort(); return original(...args); };
    } else {
      const name = boundary === "begin" ? "beginWshAcquisition" : boundary === "reserve" ? "reserveWshCall" : "assertWshAcquisition";
      const original = h.store[name];
      h.store[name] = async (...args: any[]) => { const result = await original(...args); controller.abort(); return result; };
    }
    if (boundary === "lock") await assert.rejects(refreshWsh({ ...h.options, signal: controller.signal }), /ABORTED/);
    else await refreshWsh({ ...h.options, signal: controller.signal });
    assert.equal(h.trace.includes("events"), false);
    if (boundary !== "reserve") assert.equal(h.trace.includes("metadata"), false);
    assert.equal(h.trace.includes("publish"), false);
  });
}

test("failure publication waits for async cleanup and retains original provider diagnostics", async () => {
  const h = harness();
  h.faults({ eventError: Object.assign(new Error("RESEARCH_WSH_ERROR_10281"), { providerError: { code: 10281, message: "Duplicate WSH DU1 private-key" } }) });
  const create = h.wsh.createTransport;
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  h.wsh.createTransport = () => ({ ...create(), close: async () => { await cleanup; return h.cleanupReceipt(); } });
  const pending = refreshWsh({ ...h.options, secrets: ["private-key"] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.trace.some(t => t.startsWith("negative")), false);
  release(); await pending;
  assert.deepEqual(calendar(h).providerError, { code: 10281, message: "Duplicate WSH [UKRYTO] [UKRYTO]" });
  assert.deepEqual([...h.outcomes.values()], ["SUCCEEDED", "FAILED"]);
});

test("scheduler stop drains refresh and repair, fences a held lock and never starts later instruments", async () => {
  const h = harness();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let locks = 0, prepared = 0;
  h.store.withRefreshLock = async (_identity: unknown, work: () => Promise<void>) => { locks++; await hold; await work(); };
  h.store.dueRepairs = async () => [{ instrumentId: h.f.policy.instrumentId }];
  h.store.prepareRepair = async () => { prepared++; return { state: "WAITING", sources: [] }; };
  const scheduler = new ResearchRefreshScheduler(h.options);
  const refresh = scheduler.tick().catch(() => {}), repair = scheduler.tickRepairs().catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  scheduler.stop();
  let drained = false;
  const draining = scheduler.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); await Promise.all([refresh, repair, draining]);
  assert.equal(drained, true); assert.equal(locks, 2); assert.equal(prepared, 0);
  assert.equal(h.trace.includes("connect"), false);
  await scheduler.tick(); await scheduler.tickRepairs(); assert.equal(locks, 2);
});

test("scheduler shutdown aborts an in-flight WSH response, waits for cleanup and suppresses later sources", async () => {
  const h = harness();
  h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  let release!: () => void, received!: () => void;
  const events = new Promise<string>(resolve => { release = () => resolve("[]"); });
  const seen = new Promise<void>(resolve => { received = resolve; });
  const create = h.wsh.createTransport;
  h.wsh.createTransport = () => ({ ...create(), events: () => { received(); return events; } });
  const scheduler = new ResearchRefreshScheduler(h.options);
  const pending = scheduler.tick(); await seen; scheduler.stop(); release(); await pending; await scheduler.drain();
  assert.equal(h.trace.includes("publish"), false);
  assert.equal(calendar(h).reason, "RESEARCH_WSH_ABORTED");
  assert.deepEqual([...h.outcomes.values()], ["SUCCEEDED", "UNKNOWN"]);
});

for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTCONN', 'EPIPE', 'ETIMEDOUT']) test(`SEND_FAILED exact typed ${code} is transient only in request phases`, () => {
  const error = Object.assign(new Error('RESEARCH_WSH_SEND_FAILED'), { sourceError: { name: 'Error', code, message: 'actual connection failure' } });
  for (const stage of ['metadata', 'events'] as const) assert.equal(classifyWshFailure(error, stage), 'TRANSIENT');
  for (const stage of ['connect', 'normalize', 'publish', 'cleanup'] as const) assert.equal(classifyWshFailure(error, stage), 'HARD');
});
test('generic, message-only, unknown-code and numeric-string connection failures stay hard', () => {
  for (const error of [new Error('RESEARCH_WSH_SEND_FAILED'),
    Object.assign(new Error('RESEARCH_WSH_SEND_FAILED'), { sourceError: { name: 'ECONNRESET', code: 'OTHER', message: 'ECONNRESET' } }),
    Object.assign(new Error('RESEARCH_WSH_CONNECT_FAILED'), { sourceError: { name: 'Error', code: 'ECONNREFUSED', message: 'connection failure' } }),
    Object.assign(new Error('RESEARCH_WSH_ERROR_502'), { providerError: { code: '502', message: 'failure' } })])
    assert.equal(classifyWshFailure(error, 'metadata'), 'HARD');
  assert.equal(classifyWshFailure(Object.assign(new Error('RESEARCH_WSH_CONNECT_FAILED'), { providerError: { code: 502, message: 'failed' } }), 'connect'), 'TRANSIENT');
  assert.equal(classifyWshFailure(Object.assign(new Error('RESEARCH_WSH_ERROR_10281'), { providerError: { code: 10281, message: 'busy' } }), 'metadata'), 'BUSY');
});
test('numeric source/provider cause 502 permits SEND_FAILED only in metadata/events', () => {
  for (const representation of ['sourceError', 'providerError']) for (const code of [502, '502']) {
    const detail = representation === 'sourceError' ? { name: 'SocketError', code, message: 'connection failure' } : { code, message: 'connection failure' };
    const error = Object.assign(new Error('RESEARCH_WSH_SEND_FAILED'), { [representation]: detail });
    for (const stage of ['connect', 'metadata', 'events', 'normalize', 'publish', 'cleanup'] as const)
      assert.equal(classifyWshFailure(error, stage), code === 502 && ['metadata', 'events'].includes(stage) ? 'TRANSIENT' : 'HARD');
  }
});
for (const interval of [900000, 3600000]) test(`READY retained calendar receives only two retries without moving ${interval}ms regular cadence or publishing retry slots`, async () => {
  const h = harness(); h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.f.source.parserConfig.maxAgeMs = 86400000; h.f.source.parserConfig.refreshIntervalMs = interval;
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  const scheduler = new ResearchRefreshScheduler(h.options); await scheduler.tick();
  const good = structuredClone(h.head); h.advance(interval); h.faults({ eventError: new Error('RESEARCH_WSH_TIMEOUT') });
  await scheduler.tick(); assert.deepEqual(h.head, good);
  const regularSlots = [...h.slots];
  const nextRegular = h.attempts.at(-1)!.ticket.nextRegularAt;
  h.store.dueRepairs = async () => []; h.store.prepareRepair = async () => ({ state: 'READY', sources: [] });
  await scheduler.tickRepairs(); assert.equal(h.attempts.length, 2);
  h.advance(29999); await scheduler.tickRepairs(); assert.equal(h.attempts.length, 2);
  h.advance(1); await scheduler.tickRepairs(); assert.equal(h.attempts.length, 3);
  h.advance(119999); await scheduler.tickRepairs(); assert.equal(h.attempts.length, 3);
  h.advance(1); await new ResearchRefreshScheduler(h.options).tickRepairs(); assert.equal(h.attempts.length, 4);
  h.advance(120000); await scheduler.tickRepairs(); assert.equal(h.attempts.length, 4);
  assert.deepEqual(h.attempts.slice(1).map(a => a.ticket.ordinal), [0, 1, 2]);
  assert.ok(h.attempts.slice(1).every(a => a.ticket.nextRegularAt === nextRegular));
  assert.equal(new Set(h.attempts.map(a => a.ticket.sessionId)).size, 4);
  assert.deepEqual(h.head, good); assert.equal(h.calls.length, 8);
  assert.deepEqual([...h.slots], regularSlots);
  assert.ok(h.attempts.slice(2).every(a => a.result?.slotKey === undefined));
  for (const [index, attempt] of h.attempts.slice(2).entries()) {
    const call = h.calls[4 + index * 2];
    const slotKey = researchRefreshSlotKey(h.options.manifestHash, h.f.policy.instrumentId, h.f.source.id, 'calendar', Math.floor(Date.parse(attempt.ticket.startedAt) / interval));
    assert.equal(call.callKey, 'research_wsh_' + researchHash({ configHash: h.f.manifest.configHash, manifestHash: h.options.manifestHash,
      instrumentId: h.f.policy.instrumentId, sourceId: h.f.source.id, slotKey, requestHash: call.requestHash }));
  }
  assert.ok(h.attempts.slice(1).every(a => a.result?.outcome === 'FAILED' && a.result.acquisitionOutcome === 'UNKNOWN'));
});
test('durable admission precedes connection and deferred admission makes no socket call', async () => {
  const h = harness(); let admitted = false;
  const claim = h.store.claimWshAttempt;
  h.store.claimWshAttempt = async (...args: any[]) => { const result = await claim(...args); admitted = true; return result; };
  const create = h.wsh.createTransport;
  h.wsh.createTransport = () => { const transport = create(); return { ...transport, connect: async deadline => { assert.equal(admitted, true); await transport.connect(deadline); } }; };
  await h.run(); assert.equal(h.attempts.length, 1);
  admitted = false; await h.run(); assert.equal(h.trace.filter(t => t === 'connect').length, 1);
});
test('hard failure replaces good head and later transient failure cannot resurrect it', async () => {
  const h = harness(); await h.run(); h.advance(900000);
  h.faults({ metadataText: '{}' }); await h.run(); const hard = structuredClone(h.head);
  assert.equal(calendar(h).reason, 'RESEARCH_WSH_METADATA_MISMATCH');
  h.advance(900000); h.faults({ metadataText: JSON.stringify({ meta_data: { event_types: [{ tag: 'wshe_ed', name: 'Earnings', columns: [] }] } }), eventError: new Error('RESEARCH_WSH_TIMEOUT') });
  await h.run(); assert.equal(calendar(h).complete, false); assert.notEqual(h.head.id, hard.id);
});

test('local checkpoint timeout retains actual local cause and phase without provider attribution', async () => {
  const h = harness(); h.faults({ advanceOnEvent: 10001 }); await h.run();
  const result = h.attempts[0]!.result!; assert.notEqual(result.outcome, 'SUCCEEDED');
  if (result.outcome === 'SUCCEEDED') return;
  assert.equal(result.failureReason, 'RESEARCH_WSH_TIMEOUT'); assert.equal(result.stage, 'events');
  assert.equal(result.failureClass, 'TRANSIENT'); assert.equal(result.providerError, undefined);
  assert.deepEqual(result.sourceError, { name: 'WshTimeoutError', code: 'RESEARCH_WSH_TIMEOUT', message: 'Local WSH events admission or call deadline expired' });
});
for (const cleanup of ['UNKNOWN', 'throw'] as const) test(`cleanup ${cleanup} preserves proved success and cannot grant a retry`, async () => {
  const h = harness(), create = h.wsh.createTransport;
  h.wsh.createTransport = () => ({ ...create(), close: async () => {
    if (cleanup === 'throw') throw new Error('close failed DU1');
    return { ...h.cleanupReceipt(), state: 'UNKNOWN' };
  } });
  await h.run(); assert.equal(calendar(h).complete, true); assert.equal(h.state, 'PUBLISHED');
  assert.deepEqual([...h.outcomes.values()], ['SUCCEEDED', 'SUCCEEDED']);
  assert.equal(h.attempts[0]!.result!.outcome, 'SUCCEEDED'); assert.equal(h.attempts[0]!.result!.cleanup.state, 'UNKNOWN');
  assert.equal(h.attempts[0]!.result!.cleanup.sessionId, h.attempts[0]!.ticket.sessionId);
  if (cleanup === 'throw') assert.equal(h.attempts[0]!.result!.cleanup.sourceError?.message, 'close failed [UKRYTO]');
  h.advance(30000); assert.equal(await refreshWsh({ ...h.options, kind: 'retry' }), false); assert.equal(h.calls.length, 2);
});
test('confirmed connect 502 consumes a durable ordinal but no call budget before each bounded retry', async () => {
  const h = harness(), create = h.wsh.createTransport;
  h.wsh.createTransport = () => ({ ...create(), connect: async () => { throw Object.assign(new Error('RESEARCH_WSH_ERROR_502'), { providerError: { code: 502, message: 'connection unavailable' } }); } });
  await h.run(); h.advance(30000); await refreshWsh({ ...h.options, kind: 'retry' });
  h.advance(120000); await refreshWsh({ ...h.options, kind: 'retry' });
  h.advance(120000); assert.equal(await refreshWsh({ ...h.options, kind: 'retry' }), false);
  assert.deepEqual(h.attempts.map(a => a.ticket.ordinal), [0, 1, 2]); assert.equal(h.calls.length, 0);
});
test('busy and unconfirmed cleanup never schedule an accelerated attempt', async () => {
  for (const kind of ['busy', 'cleanup'] as const) {
    const h = harness(), create = h.wsh.createTransport;
    h.faults({ eventError: kind === 'busy' ? Object.assign(new Error('RESEARCH_WSH_ERROR_10281'), { providerError: { code: 10281, message: 'busy' } }) : new Error('RESEARCH_WSH_TIMEOUT') });
    if (kind === 'cleanup') h.wsh.createTransport = () => ({ ...create(), close: async () => ({ ...h.cleanupReceipt(), state: 'UNKNOWN' }) });
    await h.run(); h.advance(120000); assert.equal(await refreshWsh({ ...h.options, kind: 'retry' }), false);
    assert.equal(h.attempts.length, 1); assert.equal(h.calls.length, 2);
  }
});
test('terminal commit readback requires the exact result hash and never resends', async () => {
  const h = harness(), finish = h.store.finishWshAttempt;
  h.store.finishWshAttempt = async (...args: any[]) => { await finish(...args); throw new Error('lost terminal COMMIT'); };
  h.store.readWshAttempt = async () => ({ state: 'SUCCEEDED', terminalResultHash: 'wrong' });
  await assert.rejects(h.run(), /lost terminal COMMIT/); assert.equal(h.calls.length, 2); assert.equal(h.trace.at(-1), 'close');
});
test('failed begin readback still cleans up and leaves the attempt unresolved', async () => {
  const h = harness(); let reads = 0;
  h.store.beginWshAcquisition = async () => { throw new Error('begin acknowledgement lost'); };
  h.store.pendingWshAcquisition = async () => { if (++reads > 1) throw new Error('pending readback unavailable'); return null; };
  await assert.rejects(h.run(), /pending readback unavailable/);
  assert.equal(h.trace.at(-1), 'close'); assert.equal(h.attempts[0]!.result, undefined); assert.equal(h.calls.length, 0);
});

test('deferred claim never evaluates local runtime preflight or changes a valid calendar', async () => {
  const h = harness(); await h.run(); const good = structuredClone(h.head);
  let checks = 0;
  Object.defineProperty(h.wsh.runtime, 'enabled', { get() { checks++; return false; } });
  h.wsh.runtime.endpointId = 'mismatched-runtime';
  assert.equal(await h.run(), false); assert.equal(checks, 0);
  assert.deepEqual(h.head, good); assert.equal(h.attempts.length, 1); assert.equal(h.calls.length, 2);
});
test('claimed preflight failure with failed negative settlement leaves durable preflight incomplete', async () => {
  const h = harness(); await h.run(); const good = structuredClone(h.head); h.advance(900000);
  h.wsh.runtime.endpointId = 'mismatched-runtime'; h.faults({ failNegative: true });
  await assert.rejects(h.run(), /negative DB unavailable/);
  assert.deepEqual(h.head, good); assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[1]!.preflightComplete, undefined); assert.equal(h.attempts[1]!.result, undefined);
  assert.equal(h.trace.filter(t => t === 'connect').length, 1); assert.equal(h.calls.length, 2);
});
test('preflight confirmation failure cannot reach connection and shutdown still cleans up', async () => {
  const h = harness(); h.store.confirmWshPreflight = async () => { throw new Error('confirmation unavailable'); };
  await h.run(); assert.equal(h.trace.includes('connect'), false); assert.equal(h.trace.includes('close'), true);
  assert.equal(h.attempts[0]!.preflightComplete, undefined);
});

test('metadata bookkeeping and ambiguous publication readback retain the exact original attempt ticket', async () => {
  const h = harness(); h.faults({ publishCommitLost: true });
  const deadlines: unknown[] = [];
  const outcome = h.store.recordCallOutcome, acquisition = h.store.readWshAcquisition, snapshot = h.store.readSnapshot;
  h.store.recordCallOutcome = async (...args: any[]) => { deadlines.push(args[3]); return outcome(...args); };
  h.store.readWshAcquisition = async (...args: any[]) => { deadlines.push(args[1]); return acquisition(...args); };
  h.store.readSnapshot = async (...args: any[]) => { deadlines.push(args[2]); return snapshot(...args); };
  await h.run(); assert.equal(deadlines.length, 3);
  for (const ticket of deadlines) assert.equal(ticket, h.attempts[0]!.ticket);
});

test('legacy negative commit readback shares one bounded resolution deadline', async () => {
  const h = harness(); h.faults({ eventError: new Error('RESEARCH_WSH_TIMEOUT'), failNegative: true });
  await assert.rejects(h.run(), /negative DB unavailable/);
  h.faults({ failNegative: false, negativeCommitLost: true });
  const deadlines: string[] = [], acquisition = h.store.readWshAcquisition, snapshot = h.store.readSnapshot;
  h.store.readWshAcquisition = async (...args: any[]) => { deadlines.push(args[1]); return acquisition(...args); };
  h.store.readSnapshot = async (...args: any[]) => { deadlines.push(args[2]); return snapshot(...args); };
  const before = Date.now(); await h.run(); const after = Date.now();
  assert.equal(deadlines.length, 2); assert.equal(deadlines[0], deadlines[1]);
  assert.ok(Date.parse(deadlines[0]!) >= before + 3000 && Date.parse(deadlines[0]!) <= after + 3000);
  assert.equal(h.calls.length, 2);
});

for (const expired of [false, true]) test(`terminal readback ${expired ? 'expired before connection' : 'blocked connection'} respects original deadline and scheduler drain`, { timeout: 1500 }, async () => {
  const h = harness(); h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  const claim = h.store.claimWshAttempt;
  h.store.claimWshAttempt = async (...args: any[]) => {
    const result = await claim(...args);
    if (result.state === 'CLAIMED') result.ticket.deadlineAt = new Date(Date.now() + 100).toISOString();
    return result;
  };
  let connections = 0;
  const actualReadback = new ResearchStore({ query: async () => { throw new Error('unexpected unbounded query'); },
    connect: async () => { connections++; return new Promise(() => {}); } });
  h.store.readWshAttempt = actualReadback.readWshAttempt.bind(actualReadback);
  const scheduler = new ResearchRefreshScheduler(h.options);
  h.store.finishWshAttempt = async () => {
    assert.equal(h.trace.at(-1), 'close'); scheduler.stop();
    if (expired) await new Promise(resolve => setTimeout(resolve, 110));
    throw new Error('RESEARCH_WSH_BOOKKEEPING_TIMEOUT');
  };
  const started = performance.now();
  const pending = scheduler.tick();
  await Promise.all([assert.rejects(pending, /RESEARCH_WSH_BOOKKEEPING_TIMEOUT/), scheduler.drain()]);
  assert.ok(performance.now() - started < 1000);
  assert.equal(connections, expired ? 0 : 1); assert.equal(h.calls.length, 2);
  assert.equal(h.attempts[0]!.result, undefined); assert.equal(h.trace.at(-1), 'close');
  await scheduler.tick(); await scheduler.drain(); assert.equal(h.calls.length, 2);
});

for (const stage of ['acquisition', 'snapshot'] as const) test(`expired monotonic publication ${stage} readback cannot reopen a connection despite future wall deadline`, { timeout: 1500 }, async () => {
  const h = harness(); h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  h.faults({ publishCommitLost: true });
  let connections = 0;
  const readback = new ResearchStore({ query: async () => { throw new Error('unexpected unbounded query'); },
    connect: async () => { connections++; return new Promise(() => {}); } });
  const claim = h.store.claimWshAttempt;
  h.store.claimWshAttempt = async (...args: any[]) => {
    const result = await claim(...args);
    if (result.state === 'CLAIMED') {
      result.ticket.deadlineAt = new Date(Date.now() + 60000).toISOString();
      (readback as unknown as { wshTicketDeadlines: WeakMap<WshAttemptTicket, number> }).wshTicketDeadlines.set(result.ticket, performance.now() - 1);
    }
    return result;
  };
  if (stage === 'acquisition') h.store.readWshAcquisition = readback.readWshAcquisition.bind(readback);
  else h.store.readSnapshot = readback.readSnapshot.bind(readback);
  const scheduler = new ResearchRefreshScheduler(h.options), publish = h.store.publishWshSnapshot;
  h.store.publishWshSnapshot = async (...args: any[]) => { try { return await publish(...args); } finally { scheduler.stop(); } };
  const started = performance.now(), pending = scheduler.tick();
  await Promise.all([assert.rejects(pending, /RESEARCH_WSH_BOOKKEEPING_TIMEOUT/), scheduler.drain()]);
  assert.ok(performance.now() - started < 1000); assert.equal(connections, 0);
  assert.equal(h.trace.at(-1), 'close'); assert.equal(h.calls.length, 2);
  assert.equal(h.attempts[0]!.result, undefined);
  await scheduler.tick(); await scheduler.drain(); assert.equal(h.calls.length, 2);
});

for (const handoff of ['connection', 'query'] as const) test(`positive monotonic publication budget survives wall rollback at ${handoff} handoff`, { timeout: 1500 }, async () => {
  const h = harness(); h.f.policy.sources = [h.f.source]; h.f.manifest.instruments = [h.f.policy];
  h.options.manifestHash = researchHash(h.f.manifest); h.head.snapshot.manifestHash = h.options.manifestHash; h.head.snapshot.mappingHash = researchHash(h.f.policy);
  h.head.snapshot.reports = []; h.head.snapshot.facts = []; h.head.snapshot.evidence = []; h.head.snapshot.coverage = [];
  h.faults({ publishCommitLost: true });
  const originalRead = h.store.readWshAcquisition, realNow = Date.now;
  let wallReads = 0, rolledBack = false, queries = 0, destroyed = false, slowComplete = false;
  let finishSlow!: () => void;
  const slowFinished = new Promise<void>(resolve => { finishSlow = () => { slowComplete = true; resolve(); }; });
  const raw = { release: (destroy?: boolean) => { destroyed ||= destroy === true; }, query: async (sql: string) => {
    if (sql.includes('set_config')) return { rows: [] };
    queries++; rolledBack = true;
    try { await new Promise(resolve => setTimeout(resolve, 80)); return { rows: [await originalRead()] }; }
    finally { finishSlow(); }
  } };
  const readback = new ResearchStore({ query: async () => { throw new Error('unexpected unbounded query'); }, connect: async () => {
    if (handoff === 'connection') {
      rolledBack = true;
      await new Promise(resolve => setTimeout(resolve, 80)); finishSlow();
    }
    return raw;
  } });
  h.store.readWshAcquisition = async (id: string, ticket: WshAttemptTicket) => {
    ticket.deadlineAt = new Date(realNow() + 60000).toISOString();
    (readback as unknown as { wshTicketDeadlines: WeakMap<WshAttemptTicket, number> }).wshTicketDeadlines.set(ticket, performance.now() + 20);
    Date.now = () => {
      if (++wallReads >= (handoff === 'connection' ? 3 : 5)) rolledBack = true;
      return realNow() - (rolledBack ? 60000 : 0);
    };
    return readback.readWshAcquisition(id, ticket);
  };
  const scheduler = new ResearchRefreshScheduler(h.options), publish = h.store.publishWshSnapshot;
  h.store.publishWshSnapshot = async (...args: any[]) => { try { return await publish(...args); } finally { scheduler.stop(); } };
  try {
    const started = performance.now(), pending = scheduler.tick();
    await Promise.all([assert.rejects(pending, /RESEARCH_WSH_BOOKKEEPING_TIMEOUT/), scheduler.drain()]);
    assert.ok(performance.now() - started < 1000);
    assert.equal(h.trace.at(-1), 'close'); assert.equal(h.attempts[0]!.result, undefined); assert.equal(h.calls.length, 2);
    assert.equal(rolledBack, true);
    assert.equal(slowComplete, false);
    await slowFinished; await new Promise(resolve => setImmediate(resolve));
    assert.equal(destroyed, true); assert.equal(queries, handoff === 'connection' ? 0 : 1);
    await scheduler.tick(); await scheduler.drain(); assert.equal(h.calls.length, 2);
  } finally { Date.now = realNow; }
});


test("ongoing WSH publishes bound v2 evidence with finite calls and hourly pacing", async () => {
  const h = harness([], true); await h.run();
  const c = calendar(h);
  assert.equal(c.status, "EMPTY"); assert.ok("wshAcquisition" in c);
  assert.equal(c.wshAcquisition.contractVersion, "ibkr-wsh-v2");
  assert.equal(c.wshAcquisition.qualificationExpiresAt, null);
  assert.equal(c.wshAcquisition.entitlementExpiresAt, null);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    const deadline = Date.parse(call.deadlineAt), start = Date.parse(h.attempts[0].ticket.startedAt);
    assert.ok(Number.isFinite(deadline) && deadline > start && deadline <= start + 10000);
  }
  h.advance(3599999); await h.run(); assert.equal(h.calls.length, 2);
  h.advance(1); await h.run(); assert.equal(h.calls.length, 4);
});

test("ongoing paid policy does not mask a hard WSH provider failure after success", async () => {
  const h = harness([], true); await h.run(); h.advance(3600000);
  h.faults({ eventError: Object.assign(new Error("RESEARCH_WSH_ERROR_10277"), { providerError: { code: 10277, message: "WSH subscription unavailable" } }) });
  await h.run();
  assert.equal(calendar(h).status, "ERROR");
  const result = h.attempts.at(-1)?.result;
  assert.ok(result && result.outcome !== "SUCCEEDED"); assert.equal(result.failureClass, "HARD");
  assert.deepEqual(calendar(h).providerError, { code: 10277, message: "WSH subscription unavailable" });
});


test("future ongoing WSH confirmation makes no broker connection", async () => {
  const h = harness([], true, (source, now) => {
    (source.parserConfig.qualification as any).validity.confirmedAt = new Date(now + 1).toISOString();
  });
  await h.run(); assert.equal(h.calls.length, 0); assert.ok(!h.trace.includes("connect"));
  assert.equal(calendar(h).status, "UNVERIFIED");
});

test("mixed WSH policy expiry after metadata prevents sending events", async () => {
  const h = harness([], true, (source, now) => {
    const entitlement = source.parserConfig.entitlement as any;
    delete entitlement.validity; entitlement.expiresAt = new Date(now + 50).toISOString();
  });
  const create = h.wsh.createTransport;
  h.wsh.createTransport = () => { const transport = create(); return { ...transport, metadata: async (...args) => {
    const result = await transport.metadata(...args); h.advance(100); return result;
  } }; };
  await h.run(); assert.equal(h.calls.length, 1); assert.ok(!h.trace.includes("events"));
  assert.notEqual(calendar(h).status, "EMPTY"); assert.notEqual(calendar(h).status, "AVAILABLE");
});
