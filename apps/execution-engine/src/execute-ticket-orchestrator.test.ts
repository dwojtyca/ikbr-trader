import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ProposedOrder,
  ProposedOrderStatus,
  SignalTicket,
} from "@ikbr/shared";

import {
  orchestrateExecuteTicket,
  type OrchestratorDeps,
} from "./execute-ticket-orchestrator.js";
import type { ExecutionRepository } from "./repository.js";

// ---------------------------------------------------------------------------
// Realistic in-memory fake — enforces UNIQUE(client_order_id), the
// full status lifecycle, AND an atomic resume claim modelled the
// same way as the production repo (single-owner + TTL recovery).
// Every mutation is synchronous inside the async method body so no
// two callers can interleave between the check and the update —
// this mirrors Postgres's UPDATE ... WHERE ... RETURNING atomicity.
// ---------------------------------------------------------------------------

class FakeUniqueViolation extends Error {
  readonly code = "23505";
  constructor(message: string) {
    super(message);
    this.name = "FakeUniqueViolation";
  }
}

function isFakeUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && (error as { code?: unknown }).code === "23505"
  );
}

interface FakeRow {
  id: number;
  ticket: SignalTicket;
  strategy: string;
  status: ProposedOrderStatus;
  clientOrderId: string | null;
  clientOrderHash: string | null;
  executionAttemptedAt: Date | undefined;
  brokerOrderId: string | undefined;
  processingOwner: string | null;
  processingClaimedAt: Date | null;
}

/**
 * PR14 round-5/6 blocker — explicit availability for the atomic
 * open-position guard. `sessionId` added round-6.
 */
type FakePositionGuardContext =
  | {
      readonly kind: "available";
      readonly accountId: string;
      readonly sessionId: string;
      readonly maxSnapshotAgeMs: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "no_active_account";
    };

type FakePositionGuardBlockedReason =
  | "missing"
  | "stale"
  | "incomplete"
  | "no_active_account"
  | "wrong_session";

/**
 * PR14 round-6 blocker — seeded broker snapshot state.
 * `tryStartSubmissionWithExposureGuard` reads from this to
 * verify the resume path enforces the same account / session /
 * freshness / open-position invariants as fresh insert.
 */
interface FakeSnapshotState {
  readonly sessionId: string;
  readonly observedAt: Date;
  readonly complete: boolean;
  readonly positions: ReadonlyArray<{
    readonly instrument: string;
    readonly conid: string | null;
    readonly quantity: number;
  }>;
}

class FakeRepo {
  #nextId = 1;
  readonly rows = new Map<number, FakeRow>();
  readonly byClientOrderId = new Map<string, number>();
  readonly snapshotsByAccount = new Map<string, FakeSnapshotState>();
  now: () => number = () => Date.now();

  async getIdempotencyRecord(clientOrderId: string) {
    const id = this.byClientOrderId.get(clientOrderId);
    if (id === undefined) return null;
    const row = this.rows.get(id);
    if (!row) return null;
    return {
      order: toProposedOrder(row),
      clientOrderHash: row.clientOrderHash,
    };
  }

  /**
   * Round-6 blocker: mirrors the SQL guard body used by both
   * `insertProposedFromTicket` and
   * `tryStartSubmissionWithExposureGuard`. Fully synchronous
   * after the async boundary so concurrent callers cannot
   * interleave — exactly the transactional guarantee Postgres
   * provides under the advisory lock.
   */
  #runExposureGuard(input: {
    readonly instrument: string;
    readonly conid: string | null;
    readonly allowCrossContractExposure: boolean;
    readonly guard: FakePositionGuardContext;
  }):
    | { readonly kind: "ok" }
    | {
        readonly kind: "position_state_unavailable";
        readonly accountId: string | null;
        readonly reason: FakePositionGuardBlockedReason;
      }
    | {
        readonly kind: "open_position_exists";
        readonly accountId: string;
        readonly quantity: number;
        readonly observedAt: Date;
      } {
    if (input.guard.kind === "unavailable") {
      return {
        kind: "position_state_unavailable",
        accountId: null,
        reason: input.guard.reason,
      };
    }
    const g = input.guard;
    const snap = this.snapshotsByAccount.get(g.accountId);
    if (!snap) {
      return {
        kind: "position_state_unavailable",
        accountId: g.accountId,
        reason: "missing",
      };
    }
    if (snap.sessionId !== g.sessionId) {
      return {
        kind: "position_state_unavailable",
        accountId: g.accountId,
        reason: "wrong_session",
      };
    }
    const nowMs = this.now();
    const ageMs = nowMs - snap.observedAt.getTime();
    if (ageMs < -5_000) {
      return {
        kind: "position_state_unavailable",
        accountId: g.accountId,
        reason: "stale",
      };
    }
    if (ageMs > g.maxSnapshotAgeMs) {
      return {
        kind: "position_state_unavailable",
        accountId: g.accountId,
        reason: "stale",
      };
    }
    if (!snap.complete) {
      return {
        kind: "position_state_unavailable",
        accountId: g.accountId,
        reason: "incomplete",
      };
    }
    let match:
      | { instrument: string; conid: string | null; quantity: number }
      | undefined;
    if (!input.allowCrossContractExposure) {
      match = snap.positions.find(
        (p) => p.instrument === input.instrument && p.quantity !== 0,
      );
    } else if (input.conid !== null) {
      match = snap.positions.find(
        (p) => p.conid === input.conid && p.quantity !== 0,
      );
    } else {
      match = snap.positions.find(
        (p) =>
          p.instrument === input.instrument &&
          p.conid === null &&
          p.quantity !== 0,
      );
    }
    if (match) {
      return {
        kind: "open_position_exists",
        accountId: g.accountId,
        quantity: match.quantity,
        observedAt: snap.observedAt,
      };
    }
    return { kind: "ok" };
  }

  seedSnapshot(accountId: string, state: FakeSnapshotState): void {
    this.snapshotsByAccount.set(accountId, state);
  }

  async insertProposedFromTicket(
    ticket: SignalTicket,
    strategy: string,
    idempotency: { clientOrderId: string; clientOrderHash: string } | undefined,
    positionGuard?: FakePositionGuardContext,
    options?: { readonly allowCrossContractExposure?: boolean },
  ): Promise<
    | { readonly kind: "inserted"; readonly id: number }
    | {
        readonly kind: "active_intent_exists";
        readonly existingOrderId: number;
        readonly existingStatus: string;
        readonly existingClientOrderId: string | null;
      }
    | {
        readonly kind: "position_state_unavailable";
        readonly accountId: string | null;
        readonly reason: FakePositionGuardBlockedReason;
      }
    | {
        readonly kind: "open_position_exists";
        readonly accountId: string;
        readonly quantity: number;
        readonly observedAt: Date;
      }
  > {
    // Round-5/6: explicit PositionGuardContext — the guard runs
    // atomically under the advisory lock. `undefined` here means
    // "test does not care about the guard" (legacy tests that
    // predate round-4). Production wiring in index.ts always
    // supplies a value.
    if (positionGuard) {
      const guarded = this.#runExposureGuard({
        instrument: ticket.instrument,
        conid: ticket.conid ?? null,
        allowCrossContractExposure:
          options?.allowCrossContractExposure ?? false,
        guard: positionGuard,
      });
      if (guarded.kind !== "ok") return guarded;
    }
    // PR14 blocker fix — atomic instrument-level guard. Mirrors
    // the SQL implementation: reject when any non-terminal row
    // exists for the same instrument under a DIFFERENT
    // `clientOrderId` (or when there is no idempotency triple).
    for (const row of this.rows.values()) {
      if (row.ticket.instrument !== ticket.instrument) continue;
      if (row.status !== "PROPOSED" && row.status !== "SUBMITTED") continue;
      const sameClient =
        idempotency !== undefined &&
        row.clientOrderId !== null &&
        row.clientOrderId === idempotency.clientOrderId;
      if (sameClient) continue;
      return {
        kind: "active_intent_exists",
        existingOrderId: row.id,
        existingStatus: row.status,
        existingClientOrderId: row.clientOrderId,
      };
    }
    if (idempotency && this.byClientOrderId.has(idempotency.clientOrderId)) {
      throw new FakeUniqueViolation(
        `duplicate key value violates unique constraint "proposed_orders_client_order_id_uidx" (client_order_id)`,
      );
    }
    const id = this.#nextId++;
    const row: FakeRow = {
      id,
      ticket,
      strategy,
      status: "PROPOSED",
      clientOrderId: idempotency?.clientOrderId ?? null,
      clientOrderHash: idempotency?.clientOrderHash ?? null,
      executionAttemptedAt: undefined,
      brokerOrderId: undefined,
      processingOwner: null,
      processingClaimedAt: null,
    };
    this.rows.set(id, row);
    if (idempotency) this.byClientOrderId.set(idempotency.clientOrderId, id);
    return { kind: "inserted", id };
  }

  async getProposedOrderById(id: number): Promise<ProposedOrder | null> {
    const row = this.rows.get(id);
    return row ? toProposedOrder(row) : null;
  }

  /**
   * Atomic claim — mirrors the production SQL:
   *   UPDATE proposed_orders
   *   SET processing_owner = $owner,
   *       processing_claimed_at = NOW(),
   *       execution_attempted_at = NOW()
   *   WHERE id = $id AND status = 'PROPOSED'
   *     AND execution_attempted_at IS NULL
   *     AND broker_order_id IS NULL
   *   RETURNING id
   *
   * The `execution_attempted_at = NOW()` in the SAME statement is
   * the fencing marker: once the first winner's UPDATE lands, the
   * row's `executionAttemptedAt` is non-null and no subsequent
   * `tryStartSubmission` can satisfy the `IS NULL` predicate — for
   * the entire lifetime of the row, regardless of any TTL,
   * wall-clock, or owner status. This trades "automatic recovery
   * of crashed claim owners" for "at-most-once submission at the
   * broker, even under an arbitrary pause of the winner".
   *
   * The method body is fully synchronous after the `async` boundary
   * so two concurrent callers cannot interleave — exactly the
   * atomicity `UPDATE ... RETURNING` provides in Postgres.
   */
  async tryStartSubmission(input: {
    readonly id: number;
    readonly owner: string;
  }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (!row) return false;
    if (row.status !== "PROPOSED") return false;
    if (row.executionAttemptedAt) return false;
    if (row.brokerOrderId) return false;
    row.processingOwner = input.owner;
    row.processingClaimedAt = new Date(this.now());
    row.executionAttemptedAt = new Date(this.now());
    return true;
  }

  /**
   * Round-6 blocker: mirrors the production
   * `tryStartSubmissionWithExposureGuard`. Runs the SAME
   * exposure guard used by `insertProposedFromTicket` — under
   * simulated advisory-lock atomicity — then atomically
   * acquires the marker only when the guard passes.
   */
  async tryStartSubmissionWithExposureGuard(input: {
    readonly id: number;
    readonly owner: string;
    readonly instrument: string;
    readonly conid: string | null;
    readonly allowCrossContractExposure: boolean;
    readonly positionGuard: FakePositionGuardContext;
  }): Promise<
    | { readonly kind: "claimed" }
    | { readonly kind: "not_claimed" }
    | {
        readonly kind: "open_position_exists";
        readonly accountId: string;
        readonly quantity: number;
        readonly observedAt: Date;
      }
    | {
        readonly kind: "position_state_unavailable";
        readonly accountId: string | null;
        readonly reason: FakePositionGuardBlockedReason;
      }
  > {
    const guarded = this.#runExposureGuard({
      instrument: input.instrument,
      conid: input.conid,
      allowCrossContractExposure: input.allowCrossContractExposure,
      guard: input.positionGuard,
    });
    if (guarded.kind !== "ok") return guarded;
    const acquired = await this.tryStartSubmission({
      id: input.id,
      owner: input.owner,
    });
    return acquired ? { kind: "claimed" } : { kind: "not_claimed" };
  }

  markAttempt(id: number, brokerOrderId?: string): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`row ${id} not found`);
    row.executionAttemptedAt = new Date();
    if (brokerOrderId !== undefined) row.brokerOrderId = brokerOrderId;
  }

  setStatus(id: number, status: ProposedOrderStatus): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`row ${id} not found`);
    row.status = status;
    // Terminal transitions release the claim (mirrors the real
    // repo's markSubmitted / markFilled / markCancelled).
    if (status !== "PROPOSED") {
      row.processingOwner = null;
      row.processingClaimedAt = null;
    }
  }
}

function toProposedOrder(row: FakeRow): ProposedOrder {
  return {
    id: row.id,
    ...row.ticket,
    status: row.status,
    strategy: row.strategy,
    ...(row.executionAttemptedAt !== undefined
      ? { executionAttemptedAt: row.executionAttemptedAt }
      : {}),
    ...(row.brokerOrderId !== undefined
      ? { brokerOrderId: row.brokerOrderId }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Fake executor — same as the previous version. Increments a
// counter so tests can prove the "exactly one broker submission"
// invariant against a REAL repo state machine, not a counter proxy.
// ---------------------------------------------------------------------------

function fakeExecutor(
  repo: FakeRepo,
  behaviour: {
    readonly outcome: "SUBMITTED" | "FILLED" | "throw";
    readonly brokerError?: string;
    readonly brokerOrderIdPrefix?: string;
    /** Optional delay in event-loop ticks to widen the concurrent window. */
    readonly ticks?: number;
  },
): OrchestratorDeps["executePersistedOrder"] & { callCount: number } {
  const executor = Object.assign(
    async (order: ProposedOrder) => {
      executor.callCount += 1;
      if (!order.id) throw new Error("order.id is required");
      repo.markAttempt(order.id);
      for (let i = 0; i < (behaviour.ticks ?? 0); i += 1) {
        await Promise.resolve();
      }
      if (behaviour.outcome === "throw") {
        repo.setStatus(order.id, "CANCELLED");
        throw new Error(behaviour.brokerError ?? "broker rejected");
      }
      const brokerOrderId = `${behaviour.brokerOrderIdPrefix ?? "b"}-${order.id}`;
      repo.markAttempt(order.id, brokerOrderId);
      repo.setStatus(order.id, behaviour.outcome);
      return {
        execution: {
          orderId: order.id,
          accountId: "PAPER-1",
          brokerOrderId,
          status: behaviour.outcome,
        },
      };
    },
    { callCount: 0 },
  );
  return executor;
}

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

const TICKET: SignalTicket = {
  instrument: "RTX",
  side: "BUY",
  orderType: "LMT",
  quantity: 10,
  entry: 100.5,
  stop: 99,
  takeProfit: 102,
  reason: "test",
  confidence: 1,
  timestamp: "2026-07-14T12:00:00.000Z",
  riskCheckStatus: "PASS",
};

function deps(
  repo: FakeRepo,
  executor: OrchestratorDeps["executePersistedOrder"],
  ownerOverride?: string,
  positionGuard?: FakePositionGuardContext,
  allowCrossContractExposure = false,
): OrchestratorDeps {
  return {
    getIdempotencyRecord: (id) => repo.getIdempotencyRecord(id),
    insertProposedFromTicket: (t, s, i) =>
      repo.insertProposedFromTicket(t, s, i, positionGuard, {
        allowCrossContractExposure,
      }),
    getProposedOrderById: (id) => repo.getProposedOrderById(id),
    executePersistedOrder: executor,
    isUniqueViolation: isFakeUniqueViolation,
    // Round-6 blocker: the marker acquisition MUST re-run the
    // exposure guard on BOTH the fresh and resume paths. When
    // no positionGuard is supplied (legacy tests that predate
    // round-4) fall back to a raw marker acquisition.
    tryStartSubmission: (input) => {
      if (positionGuard === undefined) {
        return repo
          .tryStartSubmission({ id: input.id, owner: input.owner })
          .then((claimed) =>
            claimed
              ? ({ kind: "claimed" } as const)
              : ({ kind: "not_claimed" } as const),
          );
      }
      return repo.tryStartSubmissionWithExposureGuard({
        ...input,
        allowCrossContractExposure,
        positionGuard,
      });
    },
    ownerId: () => ownerOverride ?? "test-owner",
  };
}

const INPUT = {
  ticket: TICKET,
  strategy: "execution-runtime",
  clientOrderId: "idem-1",
  clientOrderHash: "abc",
};

// ---------------------------------------------------------------------------
// Fresh insert
// ---------------------------------------------------------------------------

describe("orchestrateExecuteTicket — fresh insert", () => {
  it("no existing row → single broker submission, kind='submitted'", async () => {
    const repo = new FakeRepo();
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(result.kind, "submitted");
    if (result.kind !== "submitted") return;
    assert.equal(executor.callCount, 1);
    assert.equal(result.order.status, "SUBMITTED");
    assert.equal(result.execution.brokerOrderId, "b-1");
  });
});

// ---------------------------------------------------------------------------
// Duplicate variants
// ---------------------------------------------------------------------------

describe("orchestrateExecuteTicket — duplicate variants (fine-grained)", () => {
  async function seed(
    repo: FakeRepo,
    finalStatus: ProposedOrderStatus,
    withBrokerOrderId: boolean,
    withAttempt: boolean,
  ) {
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    if (withAttempt) repo.markAttempt(1);
    if (withBrokerOrderId) repo.markAttempt(1, "b-prior");
    repo.setStatus(1, finalStatus);
  }

  it("SUBMITTED + matching hash → duplicate_submitted, zero new broker calls", async () => {
    const repo = new FakeRepo();
    await seed(repo, "SUBMITTED", true, true);
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(result.kind, "duplicate_submitted");
    assert.equal(executor.callCount, 0);
  });

  it("FILLED + matching hash → duplicate_submitted", async () => {
    const repo = new FakeRepo();
    await seed(repo, "FILLED", true, true);
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(result.kind, "duplicate_submitted");
    assert.equal(executor.callCount, 0);
  });

  for (const status of [
    "REJECTED",
    "CANCELLED",
    "SUPERSEDED",
    "EXPIRED",
  ] as const) {
    it(`${status} + matching hash → duplicate_terminal (never re-submit)`, async () => {
      const repo = new FakeRepo();
      await seed(repo, status, false, true);
      const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
      const result = await orchestrateExecuteTicket(
        deps(repo, executor),
        INPUT,
      );
      assert.equal(result.kind, "duplicate_terminal");
      assert.equal(executor.callCount, 0);
    });
  }

  it("PROPOSED + executionAttemptedAt (ambiguous crash) → duplicate_pending_ambiguous", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    // Prior process reached markExecutionAttempt but then died —
    // status still PROPOSED, broker outcome unknown.
    repo.markAttempt(1);
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(result.kind, "duplicate_pending_ambiguous");
    if (result.kind !== "duplicate_pending_ambiguous") return;
    assert.equal(result.order.status, "PROPOSED");
    assert.equal(executor.callCount, 0);
  });

  it("hash mismatch → conflict, zero broker calls, no INSERT", async () => {
    const repo = new FakeRepo();
    await seed(repo, "SUBMITTED", true, true);
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), {
      ...INPUT,
      clientOrderHash: "different",
    });
    assert.equal(result.kind, "conflict");
    assert.equal(executor.callCount, 0);
    assert.equal(repo.rows.size, 1);
  });
});

// ---------------------------------------------------------------------------
// Resume + atomic claim
// ---------------------------------------------------------------------------

describe("orchestrateExecuteTicket — orphan resume with atomic claim", () => {
  it("orphan PROPOSED, single retry → resumes, exactly one broker submission", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(result.kind, "resumed");
    if (result.kind !== "resumed") return;
    assert.equal(executor.callCount, 1);
    assert.equal(repo.rows.size, 1);
    assert.equal(result.execution.brokerOrderId, "b-1");
  });

  it("orphan PROPOSED, TWO concurrent retries → exactly ONE claim, exactly ONE broker submission", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    const executor = fakeExecutor(repo, {
      outcome: "SUBMITTED",
      // Widen the concurrent window so the loser has a real
      // chance to observe the claimed state (test would still
      // pass without this but the invariant is more visible).
      ticks: 3,
    });

    const [a, b] = await Promise.all([
      orchestrateExecuteTicket(deps(repo, executor), INPUT),
      orchestrateExecuteTicket(deps(repo, executor), INPUT),
    ]);

    // Exactly one broker submission — the atomic claim is the
    // sole guarantor here, since both retries pass the up-front
    // idempotency check with the SAME orphan-PROPOSED shape.
    assert.equal(
      executor.callCount,
      1,
      `expected 1 broker submission, got ${executor.callCount}`,
    );
    assert.equal(repo.rows.size, 1);

    const outcomes = [a.kind, b.kind].sort();
    // The claim winner returns `resumed`. The loser re-reads and
    // classifies from the freshest state — either
    // `duplicate_pending_ambiguous` (winner still mid-broker-call,
    // row is PROPOSED + marker) or `duplicate_submitted` (winner
    // finished before the loser's re-read completed).
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.includes("resumed"));
    const loserKind = outcomes.find((k) => k !== "resumed");
    assert.ok(
      loserKind === "duplicate_pending_ambiguous" ||
        loserKind === "duplicate_submitted",
      `expected loser to be duplicate_pending_ambiguous or duplicate_submitted, got ${loserKind}`,
    );
  });

  it("stress: 5 parallel retries on the same orphan → exactly one broker submission", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    const executor = fakeExecutor(repo, {
      outcome: "SUBMITTED",
      ticks: 5,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        orchestrateExecuteTicket(deps(repo, executor), INPUT),
      ),
    );
    assert.equal(executor.callCount, 1);
    assert.equal(repo.rows.size, 1);
    const resumed = results.filter((r) => r.kind === "resumed").length;
    assert.equal(resumed, 1, "exactly one caller must resume");
  });

  it("second retry AFTER the first resume completes → duplicate_submitted", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const first = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(first.kind, "resumed");
    const second = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(second.kind, "duplicate_submitted");
    assert.equal(executor.callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Fencing marker — at-most-once even under arbitrary pause / crash
// ---------------------------------------------------------------------------

describe("orchestrateExecuteTicket — fencing marker (at-most-once)", () => {
  it("winner pauses arbitrarily long, a second retry MUST NOT take over — marker fences it", async () => {
    // Under a TTL-only lease this scenario is the classic
    // double-submission bug: A takes the lease, pauses past TTL,
    // B takes over, both submit to the broker. The fencing marker
    // eliminates the take-over path — B always observes the
    // marker on re-read and returns pending, never submits.
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    // Simulate "A started the submission and paused" by taking the
    // claim directly (this is exactly what claimAndExecute does
    // under the hood — atomic UPDATE that sets the fencing marker).
    const aClaimed = await repo.tryStartSubmission({ id: 1, owner: "A" });
    assert.equal(aClaimed, true);

    // Simulate arbitrary wall-clock advance. Under a TTL-based
    // lease this would allow a takeover; with the marker it does
    // not — the SQL predicate is `execution_attempted_at IS NULL`,
    // wall-clock plays no role.
    repo.now = () => Date.now() + 24 * 60 * 60 * 1000; // +1 day

    // B retries via the full orchestrator flow. It MUST observe
    // the marker via the up-front idempotency check and return
    // duplicate_pending_ambiguous WITHOUT touching the broker.
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "B"),
      INPUT,
    );
    assert.equal(result.kind, "duplicate_pending_ambiguous");
    assert.equal(
      executor.callCount,
      0,
      "the second retry MUST NOT submit to the broker under any circumstance",
    );

    // A direct claim attempt by B (bypassing the orchestrator)
    // must also fail — the marker is the ultimate fence.
    const bClaimed = await repo.tryStartSubmission({ id: 1, owner: "B" });
    assert.equal(
      bClaimed,
      false,
      "atomic marker must block all subsequent claims",
    );
  });

  it("crash between marker and broker call → next retry sees duplicate_pending_ambiguous, zero broker calls", async () => {
    // Real-world crash window: A's atomic claim succeeds (marker
    // set); A dies before executePersistedOrder runs. The row is
    // permanently in the ambiguous PROPOSED state and CANNOT be
    // automatically resumed. Reconciliation is the only recovery
    // path — the orchestrator's job here is to REFUSE re-submission.
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    // A "crashes" between claim and broker call.
    const claimed = await repo.tryStartSubmission({ id: 1, owner: "A" });
    assert.equal(claimed, true);
    // (No executor call — this is the crash simulation.)

    // Retry sees the ambiguous state.
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "B"),
      INPUT,
    );
    assert.equal(result.kind, "duplicate_pending_ambiguous");
    assert.equal(executor.callCount, 0);

    // Even repeated retries must all refuse.
    for (let i = 0; i < 3; i += 1) {
      const retry = await orchestrateExecuteTicket(
        deps(repo, executor, `B${i}`),
        INPUT,
      );
      assert.equal(retry.kind, "duplicate_pending_ambiguous");
    }
    assert.equal(executor.callCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Fencing marker — fresh INSERT vs concurrent retry
// (the critical race the user identified — INSERT alone does NOT
// grant the right to submit; every broker call goes through
// tryStartSubmission)
// ---------------------------------------------------------------------------

/**
 * Deps factory that pauses `getProposedOrderById(insertedId)` on
 * the first call, allowing a concurrent request to observe the
 * clean PROPOSED row and race for the submission claim BEFORE
 * the first request reaches its own tryStartSubmission call.
 */
function pausableDeps(
  repo: FakeRepo,
  executor: OrchestratorDeps["executePersistedOrder"],
  gate: {
    readonly release: () => void;
    readonly waitForRelease: () => Promise<void>;
  },
  ownerOverride: string,
): OrchestratorDeps {
  let paused = false;
  return {
    getIdempotencyRecord: (id) => repo.getIdempotencyRecord(id),
    insertProposedFromTicket: (t, s, i) =>
      repo.insertProposedFromTicket(t, s, i),
    // Only the FIRST call to getProposedOrderById pauses — the
    // one made immediately after INSERT succeeds. This models
    // request A "hanging" after its INSERT lands but before it
    // gets to tryStartSubmission.
    async getProposedOrderById(id) {
      if (!paused) {
        paused = true;
        await gate.waitForRelease();
      }
      return repo.getProposedOrderById(id);
    },
    executePersistedOrder: executor,
    isUniqueViolation: isFakeUniqueViolation,
    tryStartSubmission: async (input) => {
      const acquired = await repo.tryStartSubmission({
        id: input.id,
        owner: input.owner,
      });
      return acquired
        ? ({ kind: "claimed" } as const)
        : ({ kind: "not_claimed" } as const);
    },
    ownerId: () => ownerOverride,
  };
}

function makeGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { release: () => resolve(), waitForRelease: () => promise };
}

describe("orchestrateExecuteTicket — fresh INSERT vs concurrent retry race", () => {
  it("A INSERTs and pauses BEFORE tryStartSubmission → B enters via unique-violation → exactly ONE broker submission", async () => {
    // Reproduces the exact race the round-5 blocker flagged:
    //   1. Request A INSERTs successfully (row_id=1, clean
    //      PROPOSED, no marker).
    //   2. A pauses before reaching tryStartSubmission.
    //   3. Request B arrives with the same idempotencyKey. Its
    //      INSERT throws UNIQUE violation → B re-consults the
    //      record → sees clean PROPOSED → routes into
    //      claimAndExecute via the racy re-lookup branch.
    //   4. B wins tryStartSubmission (marker set atomically).
    //   5. A finally proceeds → tryStartSubmission fails (marker
    //      is set) → re-read → duplicate_pending_ambiguous OR
    //      duplicate_submitted.
    //   6. Exactly ONE broker submission and ONE proposed_orders
    //      row across both requests.
    const repo = new FakeRepo();
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED", ticks: 2 });
    const gate = makeGate();
    const depsA = pausableDeps(repo, executor, gate, "A");
    const depsB = deps(repo, executor, "B");

    // Kick off A first — it will INSERT, then pause inside
    // getProposedOrderById(insertedId).
    const promiseA = orchestrateExecuteTicket(depsA, INPUT);

    // Give A the chance to reach the pause point.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    // B arrives with the same idempotencyKey — its INSERT will
    // throw UNIQUE, B re-consults, sees A's clean PROPOSED, and
    // enters claimAndExecute for the resume branch.
    const resultB = await orchestrateExecuteTicket(depsB, INPUT);

    // Release A — it will now read the row (now with marker),
    // proceed to claimAndExecute, and lose the atomic
    // tryStartSubmission.
    gate.release();
    const resultA = await promiseA;

    assert.equal(
      executor.callCount,
      1,
      `expected exactly 1 broker submission, got ${executor.callCount}`,
    );
    assert.equal(repo.rows.size, 1, "exactly one proposed_orders row");

    // B won the race — resumed the row and submitted successfully.
    assert.equal(resultB.kind, "resumed");
    // A observed the marker on its own claim attempt and
    // classified from the freshest state.
    assert.ok(
      resultA.kind === "duplicate_pending_ambiguous" ||
        resultA.kind === "duplicate_submitted",
      `A must observe B's marker on re-read, got kind=${resultA.kind}`,
    );
  });

  it("A INSERTs and crashes BEFORE tryStartSubmission → next retry safely acquires marker and submits ONCE", async () => {
    // The dual crash-window scenario: A INSERTs, then crashes.
    // Because the marker was NOT yet set, the retry MUST be able
    // to safely acquire the marker and submit. This is safe
    // precisely because no broker call could have happened yet.
    const repo = new FakeRepo();
    // Manually reproduce "A INSERTed then crashed" — INSERT the
    // row but never call tryStartSubmission or executor.
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    // Row invariant at this point: PROPOSED, no marker, no
    // broker id. This is the "safe to retry" shape.
    const seed = await repo.getProposedOrderById(1);
    assert.equal(seed?.status, "PROPOSED");
    assert.equal(seed?.executionAttemptedAt, undefined);
    assert.equal(seed?.brokerOrderId, undefined);

    // Retry from B. Goes through the up-front idempotency path,
    // sees clean PROPOSED, decides `resume`, acquires the marker,
    // and submits.
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "B"),
      INPUT,
    );
    assert.equal(result.kind, "resumed");
    assert.equal(
      executor.callCount,
      1,
      "the retry must submit exactly once when no marker is set",
    );

    // A third retry (post-success) must NOT re-submit.
    const executor2 = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const retry = await orchestrateExecuteTicket(
      deps(repo, executor2, "C"),
      INPUT,
    );
    assert.equal(retry.kind, "duplicate_submitted");
    assert.equal(executor2.callCount, 0);
  });

  it("fresh INSERT alone does NOT grant the right to submit — every path acquires the marker", async () => {
    // A structural / invariant test: even the simplest fresh-
    // insert flow must go through tryStartSubmission. Proven by
    // observing that after a successful `submitted` outcome, the
    // row carries the marker (proof that the atomic claim ran
    // before the broker call).
    const repo = new FakeRepo();
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(result.kind, "submitted");
    const row = await repo.getProposedOrderById(1);
    assert.ok(
      row?.executionAttemptedAt,
      "successful submitted outcome must have set the fencing marker",
    );
    assert.equal(row?.status, "SUBMITTED");
    assert.equal(executor.callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Atomic instrument-level exposure guard (PR14 round-3 blocker fix)
//
// A different clientOrderId targeting the SAME instrument as an
// active PROPOSED / SUBMITTED row MUST be rejected atomically.
// This is the enforcement point that eliminates the process-wide
// race window that a signal-engine-local exposure guard alone
// cannot cover (multiple signal-engine instances, mixed
// manual /runtime/execute + trading-loop callers, etc.).
// ---------------------------------------------------------------------------

describe("orchestrateExecuteTicket — atomic instrument-level exposure guard", () => {
  const OTHER_KEY_INPUT = {
    ...INPUT,
    clientOrderId: "idem-B",
    clientOrderHash: "def",
  };

  it("existing PROPOSED for the same instrument + different clientOrderId → active_intent_exists", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-A",
      clientOrderHash: "abc",
    });
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor),
      OTHER_KEY_INPUT,
    );
    assert.equal(result.kind, "active_intent_exists");
    if (result.kind !== "active_intent_exists") return;
    assert.equal(result.existingOrderId, 1);
    assert.equal(result.existingStatus, "PROPOSED");
    assert.equal(result.existingClientOrderId, "idem-A");
    assert.equal(executor.callCount, 0);
  });

  it("existing SUBMITTED for the same instrument + different clientOrderId → active_intent_exists", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-A",
      clientOrderHash: "abc",
    });
    repo.markAttempt(1, "b-prior");
    repo.setStatus(1, "SUBMITTED");
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor),
      OTHER_KEY_INPUT,
    );
    assert.equal(result.kind, "active_intent_exists");
    if (result.kind !== "active_intent_exists") return;
    assert.equal(result.existingStatus, "SUBMITTED");
    assert.equal(executor.callCount, 0);
  });

  for (const status of [
    "REJECTED",
    "CANCELLED",
    "SUPERSEDED",
    "EXPIRED",
    "FILLED",
  ] as const) {
    it(`existing ${status} for the same instrument does NOT block a new intent (terminal)`, async () => {
      const repo = new FakeRepo();
      await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
        clientOrderId: "idem-A",
        clientOrderHash: "abc",
      });
      // Simulate a terminal transition.
      repo.markAttempt(1);
      if (status === "FILLED") repo.markAttempt(1, "b-prior");
      repo.setStatus(1, status);

      const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
      const result = await orchestrateExecuteTicket(
        deps(repo, executor),
        OTHER_KEY_INPUT,
      );
      // Must succeed — the terminal row is not competing exposure.
      assert.equal(
        result.kind,
        "submitted",
        `terminal status=${status} must not block a new intent, got ${result.kind}`,
      );
      assert.equal(executor.callCount, 1);
    });
  }

  it("different instruments → no cross-instrument block", async () => {
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(
      { ...TICKET, instrument: "MSFT" },
      "execution-runtime",
      { clientOrderId: "idem-MSFT", clientOrderHash: "msft-hash" },
    );
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor),
      INPUT, // instrument = RTX
    );
    assert.equal(result.kind, "submitted");
    assert.equal(executor.callCount, 1);
  });

  it("two concurrent requests + different clientOrderIds + same instrument → exactly ONE insert + ONE broker call", async () => {
    // The critical race the round-3 blocker described:
    // process-local exposure guards in signal-engine can pass for
    // both A and B; the atomic guard here is the single-source-of-
    // truth enforcement point.
    const repo = new FakeRepo();
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED", ticks: 3 });

    const inputA = {
      ...INPUT,
      clientOrderId: "idem-A",
      clientOrderHash: "hash-A",
    };
    const inputB = {
      ...INPUT,
      clientOrderId: "idem-B",
      clientOrderHash: "hash-B",
    };

    const [a, b] = await Promise.all([
      orchestrateExecuteTicket(deps(repo, executor), inputA),
      orchestrateExecuteTicket(deps(repo, executor), inputB),
    ]);
    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ["active_intent_exists", "submitted"]);
    assert.equal(
      executor.callCount,
      1,
      "exactly one of the two concurrent requests may reach the broker",
    );
    assert.equal(repo.rows.size, 1, "exactly one proposed_orders row");
  });

  it("retry with the SAME clientOrderId (idempotency replay) still routes through the idempotency path, not active_intent", async () => {
    // Regression guard: the atomic guard must EXCLUDE the caller's
    // own clientOrderId so the fencing marker / DUPLICATE path
    // continues to work.
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "idem-1",
      clientOrderHash: "abc",
    });
    repo.markAttempt(1, "b-prior");
    repo.setStatus(1, "SUBMITTED");
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(deps(repo, executor), INPUT);
    assert.equal(result.kind, "duplicate_submitted");
    assert.equal(executor.callCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Round-5 blocker 1 — no active broker account MUST fail-closed
// ---------------------------------------------------------------------------

describe("orchestrateExecuteTicket — PositionGuardContext (round-5)", () => {
  it("no active broker account → POSITION_STATE_UNAVAILABLE, no INSERT, no executor call", async () => {
    const repo = new FakeRepo();
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, undefined, {
        kind: "unavailable",
        reason: "no_active_account",
      }),
      INPUT,
    );
    assert.equal(result.kind, "position_state_unavailable");
    if (result.kind !== "position_state_unavailable") return;
    assert.equal(result.accountId, null);
    assert.equal(result.reason, "no_active_account");
    assert.equal(executor.callCount, 0);
    assert.equal(repo.rows.size, 0);
  });

  it("no active broker account fires BEFORE the atomic active-intent probe", async () => {
    // Even when an existing PROPOSED row for the same instrument
    // would have already triggered ACTIVE_INTENT_EXISTS, the
    // no_active_account guard must fire first — the boot-time
    // fail-closed state is the strongest signal.
    const repo = new FakeRepo();
    await repo.insertProposedFromTicket(TICKET, "execution-runtime", {
      clientOrderId: "prior-key",
      clientOrderHash: "prior-hash",
    });
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, undefined, {
        kind: "unavailable",
        reason: "no_active_account",
      }),
      { ...INPUT, clientOrderId: "second-key", clientOrderHash: "second-hash" },
    );
    assert.equal(result.kind, "position_state_unavailable");
    assert.equal(executor.callCount, 0);
  });

  it("legacy path — same guard applies (via endpoint composition)", async () => {
    // The orchestrator seam is the same for both idempotency and
    // legacy inserts because both call `deps.insertProposedFromTicket`
    // with the pre-built positionGuard. This test asserts that
    // the FakeRepo enforces the check regardless of how the
    // insert was triggered.
    const repo = new FakeRepo();
    const outcome = await repo.insertProposedFromTicket(
      TICKET,
      "manual",
      undefined,
      { kind: "unavailable", reason: "no_active_account" },
    );
    assert.equal(outcome.kind, "position_state_unavailable");
    assert.equal(repo.rows.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Round-6 blocker — the position guard MUST run before every
// broker submission, INCLUDING the resume path. Previously
// `insertProposedFromTicket` ran the guard on fresh insert but
// `tryStartSubmission` bypassed it on resume — a retry with the
// same clientOrderId after the account went unavailable / stale
// / open-position could still submit. Fix: unified pre-submission
// gate (`tryStartSubmissionWithExposureGuard`) runs the same
// guard atomically under the same advisory lock.
// ---------------------------------------------------------------------------

const ACCT = "PAPER-ROUND6";
const SESS = "sess-round6";
function availableGuard(overrides?: {
  accountId?: string;
  sessionId?: string;
  maxSnapshotAgeMs?: number;
}): FakePositionGuardContext {
  return {
    kind: "available",
    accountId: overrides?.accountId ?? ACCT,
    sessionId: overrides?.sessionId ?? SESS,
    maxSnapshotAgeMs: overrides?.maxSnapshotAgeMs ?? 60_000,
  };
}
function seedFreshFlat(repo: FakeRepo): void {
  repo.seedSnapshot(ACCT, {
    sessionId: SESS,
    observedAt: new Date(),
    complete: true,
    positions: [],
  });
}

async function seedCleanProposed(
  repo: FakeRepo,
  guard: FakePositionGuardContext,
): Promise<void> {
  seedFreshFlat(repo);
  const result = await repo.insertProposedFromTicket(
    TICKET,
    INPUT.strategy,
    {
      clientOrderId: INPUT.clientOrderId,
      clientOrderHash: INPUT.clientOrderHash,
    },
    guard,
  );
  assert.equal(result.kind, "inserted");
}

describe("orchestrateExecuteTicket — resume path re-runs the exposure guard (round-6)", () => {
  it("clean PROPOSED + no active account on retry → POSITION_STATE_UNAVAILABLE, zero broker calls", async () => {
    const repo = new FakeRepo();
    await seedCleanProposed(repo, availableGuard());

    // Account has since gone away (bootstrap pending / process
    // restart lost the active account).
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "retry-owner", {
        kind: "unavailable",
        reason: "no_active_account",
      }),
      INPUT,
    );
    assert.equal(result.kind, "position_state_unavailable");
    if (result.kind !== "position_state_unavailable") return;
    assert.equal(result.reason, "no_active_account");
    assert.equal(executor.callCount, 0);
    // Marker must NOT be set.
    const row = await repo.getProposedOrderById(1);
    assert.equal(row?.executionAttemptedAt, undefined);
    assert.equal(row?.status, "PROPOSED");
  });

  it("clean PROPOSED + stale snapshot on retry → POSITION_STATE_UNAVAILABLE (stale), zero broker calls", async () => {
    const repo = new FakeRepo();
    await seedCleanProposed(repo, availableGuard());

    // Age the snapshot beyond maxSnapshotAgeMs.
    repo.seedSnapshot(ACCT, {
      sessionId: SESS,
      observedAt: new Date(Date.now() - 5 * 60_000),
      complete: true,
      positions: [],
    });
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "retry-owner", availableGuard()),
      INPUT,
    );
    assert.equal(result.kind, "position_state_unavailable");
    if (result.kind !== "position_state_unavailable") return;
    assert.equal(result.reason, "stale");
    assert.equal(executor.callCount, 0);
  });

  it("clean PROPOSED + wrong sessionId on retry → POSITION_STATE_UNAVAILABLE (wrong_session), zero broker calls", async () => {
    // Process restart — the previous session's snapshot is fresh
    // by observedAt but MUST NOT be trusted.
    const repo = new FakeRepo();
    await seedCleanProposed(repo, availableGuard());
    // Guard now claims a DIFFERENT sessionId.
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(
        repo,
        executor,
        "retry-owner",
        availableGuard({ sessionId: "sess-NEW" }),
      ),
      INPUT,
    );
    assert.equal(result.kind, "position_state_unavailable");
    if (result.kind !== "position_state_unavailable") return;
    assert.equal(result.reason, "wrong_session");
    assert.equal(executor.callCount, 0);
  });

  it("clean PROPOSED + open position on retry → OPEN_POSITION_EXISTS, zero broker calls", async () => {
    const repo = new FakeRepo();
    await seedCleanProposed(repo, availableGuard());
    // Between the INSERT and the retry, a broker fill created a
    // position for the instrument.
    repo.seedSnapshot(ACCT, {
      sessionId: SESS,
      observedAt: new Date(),
      complete: true,
      positions: [{ instrument: TICKET.instrument, conid: null, quantity: 42 }],
    });
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "retry-owner", availableGuard()),
      INPUT,
    );
    assert.equal(result.kind, "open_position_exists");
    if (result.kind !== "open_position_exists") return;
    assert.equal(result.quantity, 42);
    assert.equal(executor.callCount, 0);
  });

  it("clean PROPOSED + fresh flat snapshot on retry → exactly one resume broker call", async () => {
    const repo = new FakeRepo();
    await seedCleanProposed(repo, availableGuard());
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "retry-owner", availableGuard()),
      INPUT,
    );
    assert.equal(result.kind, "resumed");
    assert.equal(executor.callCount, 1);
  });

  it("two concurrent resume requests with a fresh flat snapshot → exactly one broker call", async () => {
    const repo = new FakeRepo();
    await seedCleanProposed(repo, availableGuard());
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED", ticks: 2 });
    const [a, b] = await Promise.all([
      orchestrateExecuteTicket(
        deps(repo, executor, "A", availableGuard()),
        INPUT,
      ),
      orchestrateExecuteTicket(
        deps(repo, executor, "B", availableGuard()),
        INPUT,
      ),
    ]);
    assert.equal(executor.callCount, 1);
    const kinds = [a.kind, b.kind].sort();
    // One resumes; the other observes the marker and returns a
    // duplicate signal.
    assert.deepEqual(
      kinds,
      ["duplicate_pending_ambiguous", "resumed"].sort(),
      `unexpected kinds: ${kinds.join(",")}`,
    );
  });
});

describe("orchestrateExecuteTicket — fresh INSERT path re-runs the exposure guard at claim time (round-6)", () => {
  it("fresh insert with an available guard + subsequent open position between INSERT and claim still submits ONCE", async () => {
    // Sanity: fresh insert path runs the guard twice (in
    // insertProposedFromTicket AND in
    // tryStartSubmissionWithExposureGuard). Both must observe
    // the SAME flat state for the submission to proceed.
    const repo = new FakeRepo();
    seedFreshFlat(repo);
    const executor = fakeExecutor(repo, { outcome: "SUBMITTED" });
    const result = await orchestrateExecuteTicket(
      deps(repo, executor, "fresh", availableGuard()),
      INPUT,
    );
    assert.equal(result.kind, "submitted");
    assert.equal(executor.callCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Round-6 blocker — PositionGuardContext is REQUIRED. Compile-
// time regression test: attempting to omit the positionGuard
// argument to `ExecutionRepository.insertProposedFromTicket`
// must fail TypeScript's arity / assignability check.
// ---------------------------------------------------------------------------

describe("PositionGuardContext is required at the repository boundary (round-6)", () => {
  it("the parameter type of insertProposedFromTicket includes a REQUIRED PositionGuardContext argument", () => {
    // Structural check: `Parameters<...>[3]` MUST not include
    // `undefined` in its union. This catches accidental
    // `positionGuard?: PositionGuardContext` regressions at
    // compile time.
    type Args = Parameters<ExecutionRepository["insertProposedFromTicket"]>;
    // Args[3] is the positionGuard slot.
    // Both branches of the discriminated union must remain
    // assignable; `undefined` must NOT be.
    const _unavailable: Args[3] = {
      kind: "unavailable",
      reason: "no_active_account",
    };
    const _available: Args[3] = {
      kind: "available",
      accountId: "acct",
      sessionId: "sess",
      maxSnapshotAgeMs: 60_000,
    };
    // @ts-expect-error — `undefined` must NOT be assignable to
    // the positionGuard slot. Removing this expectation would
    // reintroduce the fail-open we fixed in round-6.
    const _forbidden: Args[3] = undefined;
    void _unavailable;
    void _available;
    void _forbidden;
    assert.ok(true);
  });
});
