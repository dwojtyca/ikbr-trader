/**
 * PR14 round-9 blocker — refresh coordinator tests.
 *
 * Deterministic tests for the invalidate-during-refresh race
 * and the generation-fenced loop that resolves it. Uses fake
 * repo + broker with manual barriers so we can pin the exact
 * interleaving that the fix is required to handle.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RefreshCoordinator,
  type RefreshCoordinatorDeps,
  MAX_REFRESH_LOOP_ITERATIONS,
} from "./refresh-coordinator.js";

// ---------------------------------------------------------------------------
// Fake persistence — mirrors the SQL contract of
// beginPositionSnapshotRefresh / completePositionSnapshotRefresh
// / getPositionSnapshotStatus. Fully synchronous inside async
// method bodies so callers do not interleave — mirrors the
// serialisation Postgres provides under the account advisory
// lock.
// ---------------------------------------------------------------------------

interface FakeSnapshot {
  sessionId: string;
  observedAt: Date;
  complete: boolean;
  generation: number;
  positions: ReadonlyArray<{
    instrument: string;
    conid?: string;
    quantity: number;
  }>;
}

class FakeRepo {
  readonly snapshots = new Map<string, FakeSnapshot>();

  async beginPositionSnapshotRefresh(input: {
    accountId: string;
    sessionId: string;
    observedAt: Date;
  }): Promise<{ generation: number }> {
    const current = this.snapshots.get(input.accountId);
    const next: FakeSnapshot = current
      ? {
          ...current,
          sessionId: input.sessionId,
          observedAt: input.observedAt,
          complete: false,
          generation: current.generation + 1,
        }
      : {
          sessionId: input.sessionId,
          observedAt: input.observedAt,
          complete: false,
          generation: 1,
          positions: [],
        };
    this.snapshots.set(input.accountId, next);
    return { generation: next.generation };
  }

  async completePositionSnapshotRefresh(input: {
    accountId: string;
    sessionId: string;
    observedAt: Date;
    generation: number;
    positions: ReadonlyArray<{
      instrument: string;
      conid?: string;
      quantity: number;
    }>;
  }): Promise<
    | { kind: "completed" }
    | { kind: "stale_generation"; currentGeneration: number }
  > {
    const current = this.snapshots.get(input.accountId);
    if (!current || current.generation !== input.generation) {
      return {
        kind: "stale_generation",
        currentGeneration: current?.generation ?? 0,
      };
    }
    this.snapshots.set(input.accountId, {
      sessionId: input.sessionId,
      observedAt: input.observedAt,
      complete: true,
      generation: current.generation,
      positions: input.positions,
    });
    return { kind: "completed" };
  }

  async getPositionSnapshotStatus(accountId: string): Promise<
    | { kind: "missing" }
    | {
        kind: "present";
        sessionId: string;
        observedAt: Date;
        complete: boolean;
        generation: number;
      }
  > {
    const cur = this.snapshots.get(accountId);
    if (!cur) return { kind: "missing" };
    return {
      kind: "present",
      sessionId: cur.sessionId,
      observedAt: cur.observedAt,
      complete: cur.complete,
      generation: cur.generation,
    };
  }

  /** Test helper — external invalidation from a fill callback. */
  async invalidate(accountId: string, sessionId: string): Promise<{ generation: number }> {
    return this.beginPositionSnapshotRefresh({
      accountId,
      sessionId,
      observedAt: new Date(),
    });
  }
}

// ---------------------------------------------------------------------------
// Fake broker with a manual gate. Each `fetchBrokerSnapshot`
// call awaits a promise that the test releases explicitly.
// ---------------------------------------------------------------------------

function makeGate() {
  let release!: (value?: unknown) => void;
  const promise = new Promise((r) => {
    release = r;
  });
  return { release, promise };
}

class FakeBroker {
  readonly callLog: Array<{ accountId: string; startedAt: Date }> = [];
  #queuedGates: Array<Promise<unknown>> = [];
  #queuedResponses: Array<() => {
    retrievedAt: string;
    positions: Array<{ symbol: string; conid?: string; position: number }>;
  }> = [];
  #queuedErrors: Array<Error | null> = [];

  queue(
    response: {
      positions: Array<{ symbol: string; conid?: string; position: number }>;
    },
    opts?: { gate?: Promise<unknown>; error?: Error },
  ): void {
    this.#queuedGates.push(opts?.gate ?? Promise.resolve());
    this.#queuedErrors.push(opts?.error ?? null);
    this.#queuedResponses.push(() => ({
      retrievedAt: new Date().toISOString(),
      positions: response.positions,
    }));
  }

  async fetchBrokerSnapshot(accountId: string): Promise<{
    retrievedAt: string;
    positions: ReadonlyArray<{
      symbol: string;
      conid?: string;
      position: number;
    }>;
  }> {
    this.callLog.push({ accountId, startedAt: new Date() });
    const gate =
      this.#queuedGates.shift() ??
      Promise.reject(new Error("no queued gate"));
    const err = this.#queuedErrors.shift() ?? null;
    const respFactory = this.#queuedResponses.shift();
    await gate;
    if (err) throw err;
    if (!respFactory) throw new Error("no queued response");
    return respFactory();
  }
}

// ---------------------------------------------------------------------------
// Coordinator harness
// ---------------------------------------------------------------------------

function silentLog() {
  return { info: () => undefined, warn: () => undefined, error: () => undefined };
}

function buildDeps(overrides?: Partial<RefreshCoordinatorDeps>): {
  repo: FakeRepo;
  broker: FakeBroker;
  deps: RefreshCoordinatorDeps;
} {
  const repo = new FakeRepo();
  const broker = new FakeBroker();
  const deps: RefreshCoordinatorDeps = {
    sessionId: "sess-r9",
    now: () => new Date(),
    log: silentLog(),
    beginRefresh: (input) => repo.beginPositionSnapshotRefresh(input),
    fetchBrokerSnapshot: (accountId) => broker.fetchBrokerSnapshot(accountId),
    completeRefresh: (input) => repo.completePositionSnapshotRefresh(input),
    getStatus: (accountId) => repo.getPositionSnapshotStatus(accountId),
    ...overrides,
  };
  return { repo, broker, deps };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RefreshCoordinator — invalidate-during-refresh (round-9 critical blocker)", () => {
  it("invalidate + refresh request DURING an in-flight fetch triggers a rerun that captures the newest generation", async () => {
    // Scenario from the user's blocker:
    //   1. Refresh A starts, generation=1.
    //   2. Broker fetch A is paused at gateA.
    //   3. Fill invalidates → generation=2, complete=false.
    //   4. Fill calls refresh again → COALESCED onto A.
    //   5. gateA released → A completes → stale_generation.
    //   6. Coordinator's loop must observe complete=false and
    //      run iteration B: begin (generation=3) → fetch B →
    //      complete. Final state: healthy, generation=3,
    //      positions from B.
    const { repo, broker, deps } = buildDeps();
    const gateA = makeGate();
    // Iteration A response — stale (would set qty=0 if it won).
    broker.queue(
      { positions: [{ symbol: "AAPL", position: 0 }] },
      { gate: gateA.promise },
    );
    // Iteration B response — the winner. Non-zero position
    // proves the loop performed a SECOND broker fetch after the
    // invalidation.
    broker.queue({ positions: [{ symbol: "AAPL", position: 42 }] });

    const coord = new RefreshCoordinator(deps);
    // Kick off refresh A.
    const refreshP = coord.refresh("PAPER-1");
    // Yield so A calls begin + starts fetch.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // External invalidation from a fill callback.
    await repo.invalidate("PAPER-1", "sess-r9");
    // Fill callback then calls refresh — must coalesce cleanly
    // onto the running loop AND ensure the loop reruns.
    const secondCallerP = coord.refresh("PAPER-1");
    // Now release A's gate. A completes → stale_generation.
    // Loop must rerun (B) to observe complete=true.
    gateA.release();
    await Promise.all([refreshP, secondCallerP]);

    // Two broker fetches — the second call is the rerun.
    assert.equal(
      broker.callLog.length,
      2,
      `expected 2 broker fetches (A + rerun), got ${broker.callLog.length}`,
    );
    // Final DB state — positions from iteration B (qty=42).
    const status = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(status.kind, "present");
    if (status.kind !== "present") return;
    assert.equal(status.complete, true);
    assert.equal(status.generation, 3);
    assert.equal(repo.snapshots.get("PAPER-1")?.positions[0]?.quantity, 42);
    // Health is healthy, NOT in_flight or failed.
    const health = coord.health("PAPER-1");
    assert.equal(health.kind, "healthy");
  });

  it("three invalidations during one slow fetch → finally converges to healthy with latest generation complete", async () => {
    const { repo, broker, deps } = buildDeps();
    const gate1 = makeGate();
    broker.queue({ positions: [] }, { gate: gate1.promise });
    // Reruns respond immediately.
    broker.queue({ positions: [{ symbol: "MSFT", position: 5 }] });
    broker.queue({ positions: [{ symbol: "MSFT", position: 10 }] });
    broker.queue({ positions: [{ symbol: "MSFT", position: 15 }] });

    const coord = new RefreshCoordinator(deps);
    const p = coord.refresh("PAPER-1");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Three invalidations during the slow iteration.
    await repo.invalidate("PAPER-1", "sess-r9");
    await repo.invalidate("PAPER-1", "sess-r9");
    await repo.invalidate("PAPER-1", "sess-r9");
    gate1.release();
    await p;

    // Loop must have run at least twice (iter 1 + at least one
    // rerun). Because three invalidations happened in the same
    // window, the loop may converge in as few as 2 iterations
    // (each `begin` bumps generation, so a single rerun can
    // catch up).
    assert.ok(
      broker.callLog.length >= 2,
      `expected at least 2 fetches, got ${broker.callLog.length}`,
    );
    const status = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(status.kind, "present");
    if (status.kind !== "present") return;
    assert.equal(status.complete, true);
    assert.equal(coord.health("PAPER-1").kind, "healthy");
  });

  it("stale_generation but newer generation ALREADY complete=true → no extra fetch, health=healthy", async () => {
    // Simulates: our completeRefresh returns stale_generation
    // because a concurrent refresh completed. The coordinator
    // MUST observe the current status (complete=true) and NOT
    // run another fetch.
    const { repo, broker, deps } = buildDeps();
    // Prime the DB as if a newer refresh completed while we were
    // fetching.
    await repo.beginPositionSnapshotRefresh({
      accountId: "PAPER-1",
      sessionId: "sess-r9",
      observedAt: new Date(),
    });
    // Broker responds — our completeRefresh will race with a
    // manual complete injected before the coordinator's own
    // complete lands.
    let coordCompleteCalled = false;
    const originalComplete = deps.completeRefresh;
    const patchedDeps: RefreshCoordinatorDeps = {
      ...deps,
      completeRefresh: async (input) => {
        // Simulate a concurrent refresher completing FIRST with
        // a different generation. We bump generation past ours
        // and mark complete=true.
        if (!coordCompleteCalled) {
          coordCompleteCalled = true;
          const bumped = await repo.beginPositionSnapshotRefresh({
            accountId: input.accountId,
            sessionId: "sess-r9",
            observedAt: new Date(),
          });
          await repo.completePositionSnapshotRefresh({
            accountId: input.accountId,
            sessionId: "sess-r9",
            observedAt: new Date(),
            generation: bumped.generation,
            positions: [{ instrument: "MSFT", quantity: 99 }],
          });
        }
        // Now our own complete runs — must return stale_generation.
        return originalComplete(input);
      },
    };
    broker.queue({ positions: [{ symbol: "AAPL", position: 0 }] });
    const coord = new RefreshCoordinator(patchedDeps);
    await coord.refresh("PAPER-1");
    // Only ONE broker fetch — the coordinator saw complete=true
    // and did NOT rerun.
    assert.equal(broker.callLog.length, 1);
    assert.equal(coord.health("PAPER-1").kind, "healthy");
    const status = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(status.kind, "present");
    if (status.kind !== "present") return;
    // Verify the winning writer's data actually persisted.
    assert.equal(
      repo.snapshots.get("PAPER-1")?.positions[0]?.quantity,
      99,
    );
  });

  it("rerun fetch failure → health=failed, snapshot complete=false, write path stays blocked", async () => {
    const { repo, broker, deps } = buildDeps();
    const gate = makeGate();
    broker.queue({ positions: [] }, { gate: gate.promise });
    // Second call fails.
    broker.queue({ positions: [] }, { error: new Error("broker gone") });

    const coord = new RefreshCoordinator(deps);
    const p = coord.refresh("PAPER-1");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await repo.invalidate("PAPER-1", "sess-r9");
    gate.release();
    await p;
    // Rerun attempted (2 fetches).
    assert.equal(broker.callLog.length, 2);
    const health = coord.health("PAPER-1");
    assert.equal(health.kind, "failed");
    if (health.kind !== "failed") return;
    assert.match(health.error, /broker gone/);
    // Snapshot complete=false persists → write path blocked.
    const status = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(status.kind, "present");
    if (status.kind !== "present") return;
    assert.equal(status.complete, false);
  });

  it("manual refresh call during fill refresh — both callers await the latest generation completing", async () => {
    // Two independent triggers overlap. Both must resolve only
    // AFTER the coordinator observes complete=true for the
    // latest generation.
    const { repo, broker, deps } = buildDeps();
    const gate = makeGate();
    broker.queue({ positions: [] }, { gate: gate.promise });
    broker.queue({ positions: [{ symbol: "AAPL", position: 3 }] });

    const coord = new RefreshCoordinator(deps);
    const trigger1 = coord.refresh("PAPER-1"); // "fill" refresh
    for (let i = 0; i < 3; i++) await Promise.resolve();
    // Manual refresh call while trigger1 is still fetching —
    // must observe the same eventual outcome (healthy).
    const trigger2 = coord.refresh("PAPER-1");
    // Simulate an invalidation before the fetch resolves.
    await repo.invalidate("PAPER-1", "sess-r9");
    gate.release();
    const [r1, r2] = await Promise.all([trigger1, trigger2]);
    void r1;
    void r2;
    assert.equal(coord.health("PAPER-1").kind, "healthy");
    assert.equal(broker.callLog.length, 2);
  });

  it("MAX_REFRESH_LOOP_ITERATIONS bounds pathological invalidation churn → health=failed", async () => {
    // Every complete succeeds, but each iteration a persistent
    // invalidation flips complete=false. The loop must give up
    // after MAX_REFRESH_LOOP_ITERATIONS.
    const { repo, broker, deps } = buildDeps();
    for (let i = 0; i < MAX_REFRESH_LOOP_ITERATIONS + 2; i++) {
      broker.queue({ positions: [] });
    }
    const patched: RefreshCoordinatorDeps = {
      ...deps,
      completeRefresh: async (input) => {
        const outcome = await deps.completeRefresh(input);
        // Invalidate immediately after every complete →
        // status.complete=false forever.
        await repo.invalidate(input.accountId, deps.sessionId);
        return outcome;
      },
    };
    const coord = new RefreshCoordinator(patched);
    await coord.refresh("PAPER-1");
    const health = coord.health("PAPER-1");
    assert.equal(health.kind, "failed");
    if (health.kind !== "failed") return;
    assert.match(health.error, /did not converge/);
    // Exactly MAX_ITERATIONS attempts.
    assert.equal(broker.callLog.length, MAX_REFRESH_LOOP_ITERATIONS);
  });

  it("healthy final state — NO in_flight promise lingers after all callers resolve", async () => {
    const { broker, deps } = buildDeps();
    broker.queue({ positions: [] });
    const coord = new RefreshCoordinator(deps);
    await coord.refresh("PAPER-1");
    // Subsequent refresh must start FRESH (no coalescing with
    // a resolved promise). Second broker call proves the map
    // was cleared.
    broker.queue({ positions: [{ symbol: "NVDA", position: 1 }] });
    await coord.refresh("PAPER-1");
    assert.equal(broker.callLog.length, 2);
    assert.equal(coord.health("PAPER-1").kind, "healthy");
  });

  // ---------------------------------------------------------------------
  // Round-10 blocker — session safety + finalisation race
  // ---------------------------------------------------------------------

  it("round-10: complete=true from a FOREIGN sessionId does NOT set healthy — a rerun in our session is triggered", async () => {
    const { repo, broker, deps } = buildDeps();
    // Broker gate: our first complete will land against a
    // foreign-owned snapshot injected via a patched deps.
    const gate = makeGate();
    broker.queue({ positions: [] }, { gate: gate.promise });
    // Rerun response — this iteration owns the session.
    broker.queue({ positions: [{ symbol: "AAPL", position: 7 }] });

    let injected = false;
    const patched: RefreshCoordinatorDeps = {
      ...deps,
      completeRefresh: async (input) => {
        if (!injected) {
          injected = true;
          // Foreign session lands complete=true BEFORE our
          // complete. Our complete then returns stale_generation.
          const b = await repo.beginPositionSnapshotRefresh({
            accountId: input.accountId,
            sessionId: "foreign-sess",
            observedAt: new Date(),
          });
          await repo.completePositionSnapshotRefresh({
            accountId: input.accountId,
            sessionId: "foreign-sess",
            observedAt: new Date(),
            generation: b.generation,
            positions: [{ instrument: "AAPL", quantity: 99 }],
          });
        }
        return deps.completeRefresh(input);
      },
    };

    const coord = new RefreshCoordinator(patched);
    const p = coord.refresh("PAPER-1");
    for (let i = 0; i < 3; i++) await Promise.resolve();
    gate.release();
    await p;

    // Two broker fetches: iteration 1 landed on a foreign
    // session (rejected), iteration 2 ran under our session.
    assert.equal(broker.callLog.length, 2);
    assert.equal(coord.health("PAPER-1").kind, "healthy");
    const status = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(status.kind, "present");
    if (status.kind !== "present") return;
    assert.equal(status.sessionId, "sess-r9");
    assert.equal(status.complete, true);
    // The final persisted quantity is from our rerun, not the
    // foreign session's writer.
    assert.equal(
      repo.snapshots.get("PAPER-1")?.positions[0]?.quantity,
      7,
    );
  });

  it("round-10: invalidation between getStatus and healthy-set causes a rerun instead of resolving healthy", async () => {
    const { repo, broker, deps } = buildDeps();
    // First iteration completes successfully. The getStatus
    // hook fires the invalidation AFTER the read commits —
    // simulating the exact finalisation race.
    broker.queue({ positions: [] });
    broker.queue({ positions: [{ symbol: "MSFT", position: 5 }] });

    let statusCalls = 0;
    let coordRef: RefreshCoordinator | null = null;
    const patched: RefreshCoordinatorDeps = {
      ...deps,
      getStatus: async (accountId) => {
        const s = await deps.getStatus(accountId);
        statusCalls += 1;
        if (statusCalls === 1) {
          // Landing invalidation AFTER our read but BEFORE the
          // coordinator can set healthy. Bump generation via
          // begin + notify coordinator through markInvalidated.
          const { generation } = await repo.beginPositionSnapshotRefresh({
            accountId,
            sessionId: "sess-r9",
            observedAt: new Date(),
          });
          coordRef?.markInvalidated(accountId, generation);
        }
        return s;
      },
    };
    const coord = new RefreshCoordinator(patched);
    coordRef = coord;
    await coord.refresh("PAPER-1");
    // The invalidation forced a rerun → 2 broker fetches.
    assert.equal(broker.callLog.length, 2);
    // End state: healthy under our session, generation matches
    // the desired maximum, quantity is from iteration 2.
    assert.equal(coord.health("PAPER-1").kind, "healthy");
    const status = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(status.kind, "present");
    if (status.kind !== "present") return;
    assert.equal(status.sessionId, "sess-r9");
    assert.equal(status.complete, true);
    assert.equal(
      repo.snapshots.get("PAPER-1")?.positions[0]?.quantity,
      5,
    );
  });

  it("round-10: final state carries LATEST generation, our session, complete=true, health=healthy", async () => {
    const { repo, broker, deps } = buildDeps();
    broker.queue({ positions: [{ symbol: "IBM", position: 11 }] });
    const coord = new RefreshCoordinator(deps);
    await coord.refresh("PAPER-1");
    const status = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(status.kind, "present");
    if (status.kind !== "present") return;
    assert.ok(status.generation >= 1);
    assert.equal(status.sessionId, "sess-r9");
    assert.equal(status.complete, true);
    assert.equal(coord.health("PAPER-1").kind, "healthy");
  });

  it("round-11: production-style invalidation forwards generation to markInvalidated → coordinator's desiredGeneration updates", async () => {
    // Compile-time: markInvalidated's second argument is
    // REQUIRED. Runtime: an invalidation carrying generation=G
    // forces the loop to keep iterating until status.generation
    // >= G. Simulate: refresh iteration produces generation=G,
    // an invalidation lands with generation=G+1 while the loop
    // is finalising → loop must rerun.
    const { repo, broker, deps } = buildDeps();
    broker.queue({ positions: [] });
    broker.queue({ positions: [{ symbol: "TSLA", position: 3 }] });

    let statusCalls = 0;
    let coordRef: RefreshCoordinator | null = null;
    const patched: RefreshCoordinatorDeps = {
      ...deps,
      getStatus: async (accountId) => {
        const s = await deps.getStatus(accountId);
        statusCalls += 1;
        if (statusCalls === 1) {
          // Production-style invalidation: capture the
          // returned generation from the repo call and forward
          // it to the coordinator.
          const { generation } = await repo.invalidate(
            accountId,
            "sess-r9",
          );
          coordRef!.markInvalidated(accountId, generation);
        }
        return s;
      },
    };
    const coord = new RefreshCoordinator(patched);
    coordRef = coord;

    // Compile-time check — second arg is REQUIRED.
    type Params = Parameters<RefreshCoordinator["markInvalidated"]>;
    const _requiresGeneration: Params[1] = 1;
    void _requiresGeneration;

    await coord.refresh("PAPER-1");
    assert.equal(broker.callLog.length, 2);
    assert.equal(coord.health("PAPER-1").kind, "healthy");
    const final = await repo.getPositionSnapshotStatus("PAPER-1");
    assert.equal(final.kind, "present");
    if (final.kind !== "present") return;
    assert.equal(final.complete, true);
    assert.equal(final.sessionId, "sess-r9");
  });
});
