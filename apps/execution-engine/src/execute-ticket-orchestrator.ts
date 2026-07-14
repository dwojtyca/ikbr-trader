/**
 * Execute-ticket orchestrator — state-aware idempotency + atomic
 * submission claim with a fencing marker + fine-grained duplicate /
 * pending outcomes.
 *
 * Single source of truth for the PR13 write flow. Both the
 * production endpoint (`POST /execution/execute-ticket` with
 * `clientOrderId` + `clientOrderHash`) AND the integration /
 * contract tests exercise this function via the same fake or
 * real port implementations.
 *
 * ## Outcome kinds
 *
 * Fresh submissions:
 *   - `submitted`  — INSERT + atomic submission marker acquired
 *                    by this request + `executePersistedOrder`
 *                    succeeded.
 *   - `resumed`    — existing orphan `PROPOSED` row + atomic
 *                    submission marker acquired by this request +
 *                    `executePersistedOrder` succeeded.
 *
 * Duplicate replays (broker involvement):
 *   - `duplicate_submitted` — matching hash, `SUBMITTED` / `FILLED`.
 *     The broker got the order in a prior request.
 *   - `duplicate_terminal`  — matching hash, `REJECTED` /
 *     `CANCELLED` / `SUPERSEDED` / `EXPIRED`. A prior attempt
 *     ended in a terminal non-successful state; the caller MUST
 *     NOT interpret this as "already succeeded".
 *
 * Pending — DO NOT interpret as SUCCESS:
 *   - `duplicate_pending_ambiguous` — matching hash, `PROPOSED`
 *     with `executionAttemptedAt` or `brokerOrderId` set. A prior
 *     process reached the atomic submission marker (or later
 *     stages) and died. The broker MAY have received the order;
 *     only reconciliation can resolve.
 *   - `pending_claimed` — matching hash, `PROPOSED`, still safe-
 *     to-submit shape (no marker), but another request currently
 *     holds the atomic claim (its `tryStartSubmission` UPDATE
 *     succeeded concurrently with ours failing, then either the
 *     row transitioned back through a terminal state and reset
 *     the marker, OR the loser observed the state before the
 *     winner's marker committed). Retry AFTER the current attempt
 *     finishes to observe the terminal outcome.
 *
 * Errors:
 *   - `conflict`         — hash mismatch (same key, different intent).
 *   - `execution_error`  — `executePersistedOrder` threw.
 *
 * ## Unified atomic submission claim with a fencing marker
 *
 * Every broker submission — fresh INSERT and resume alike — MUST
 * acquire the same repository-level atomic claim before the
 * broker is contacted. Successfully INSERTing a row does NOT
 * grant the right to submit; the UNIQUE constraint on
 * `client_order_id` prevents two ROWS, but two REQUESTS can still
 * race in the following sequence:
 *
 *   1. Request A INSERTs and pauses before submission.
 *   2. Request B with the same `clientOrderId` sees A's INSERT
 *      fail with UNIQUE and re-consults the record — B observes
 *      a clean `PROPOSED` and reaches the resume branch.
 *   3. Without a shared claim, both A and B would call
 *      `executePersistedOrder` and the broker would receive two
 *      orders.
 *
 * The orchestrator therefore calls `tryStartSubmission(id,
 * owner)` on BOTH paths — a `UPDATE ... WHERE ... RETURNING`
 * that:
 *
 *   - filters `execution_attempted_at IS NULL AND broker_order_id
 *     IS NULL` (the "still safe to submit" shape),
 *   - atomically SETS `execution_attempted_at = NOW()` in the
 *     SAME UPDATE. That timestamp acts as a fencing marker —
 *     once set, no other caller can ever satisfy the
 *     `IS NULL` predicate for this row.
 *
 * The marker is the safety guarantee, NOT a TTL lease. Even if
 * the claim winner pauses arbitrarily long (network hang, slow
 * broker) before completing `executePersistedOrder`, a second
 * caller CANNOT take over. This is the intentional trade-off:
 * "reconciliation required" is preferred over "broker gets two
 * orders".
 *
 * Consequence: a `PROPOSED` row can be SUBMITTED at most ONCE
 * across the process lifetime. If the winner crashes AFTER the
 * atomic claim but BEFORE a terminal transition, the row is
 * permanently ambiguous (`PROPOSED` + `executionAttemptedAt` set)
 * and reconciliation is the ONLY recovery path.
 *
 * Crash windows:
 *   - after INSERT, before marker  → safe to retry (any next
 *     retry will win `tryStartSubmission` and submit once).
 *   - after marker, before broker  → ambiguous, reconciliation
 *     required. Next retry returns `duplicate_pending_ambiguous`.
 *   - after broker call            → reconciliation of persisted
 *     broker state; row is already in a terminal or SUBMITTED
 *     state.
 */

import type { ProposedOrder, SignalTicket } from "@ikbr/shared";

import {
  decideIdempotency,
  type IdempotencyExistingRecord,
} from "./execute-ticket-idempotency.js";

export interface ExecutionExecutionResult {
  readonly execution: {
    readonly orderId: number;
    readonly accountId: string;
    readonly brokerOrderId: string;
    readonly status: string;
  };
}

export interface OrchestratorDeps {
  readonly getIdempotencyRecord: (
    clientOrderId: string,
  ) => Promise<{ order: ProposedOrder; clientOrderHash: string | null } | null>;
  readonly insertProposedFromTicket: (
    ticket: SignalTicket,
    strategy: string,
    idempotency: { clientOrderId: string; clientOrderHash: string } | undefined,
  ) => Promise<
    | { readonly kind: "inserted"; readonly id: number }
    | {
        readonly kind: "active_intent_exists";
        readonly existingOrderId: number;
        readonly existingStatus: string;
        readonly existingClientOrderId: string | null;
      }
    | {
        readonly kind: "open_position_exists";
        readonly accountId: string;
        readonly quantity: number;
        readonly observedAt: Date;
      }
    | {
        readonly kind: "position_state_unavailable";
        readonly accountId: string | null;
        readonly reason:
          | "missing"
          | "stale"
          | "incomplete"
          | "no_active_account"
          | "wrong_session";
      }
  >;
  readonly getProposedOrderById: (id: number) => Promise<ProposedOrder | null>;
  readonly executePersistedOrder: (
    order: ProposedOrder,
  ) => Promise<ExecutionExecutionResult>;
  readonly isUniqueViolation: (error: unknown) => boolean;
  /**
   * PR14 round-6 blocker — unified pre-submission gate. Both the
   * fresh-INSERT path AND the resume path go through this
   * function; the endpoint captures the caller's
   * `PositionGuardContext` and `allowCrossContractExposure`
   * policy inside the closure so the orchestrator itself does
   * not carry any account / session state.
   *
   * Atomically under a single Postgres transaction + advisory
   * lock on `hashtext(instrument)`:
   *
   *   1. Runs the shared exposure guard (session identity,
   *      snapshot freshness / completeness, open position).
   *   2. On block, ROLLBACK + returns a `position_state_unavailable`
   *      / `open_position_exists` outcome unchanged. NO marker,
   *      NO broker call.
   *   3. Otherwise atomically flips `execution_attempted_at`
   *      (fencing marker) via `UPDATE ... RETURNING`. Two
   *      concurrent claim attempts serialise — exactly one
   *      receives `claimed`; the other receives `not_claimed`.
   *
   * The orchestrator surfaces `open_position_exists` /
   * `position_state_unavailable` blocks to the caller and
   * routes `not_claimed` through the freshest-state
   * classifier (same code path as a losing marker race in
   * PR13).
   */
  readonly tryStartSubmission: (input: {
    readonly id: number;
    readonly owner: string;
    readonly instrument: string;
    readonly conid: string | null;
  }) => Promise<
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
        readonly reason:
          | "missing"
          | "stale"
          | "incomplete"
          | "no_active_account"
          | "wrong_session";
      }
  >;
  /**
   * Owner identity persisted on the claim. Injectable so the
   * production process can use its host id / process id and tests
   * can inject deterministic values.
   */
  readonly ownerId: () => string;
}

export interface OrchestratorInput {
  readonly ticket: SignalTicket;
  readonly strategy: string;
  readonly clientOrderId: string;
  readonly clientOrderHash: string;
}

export type OrchestratorOutcome =
  | {
      readonly kind: "submitted";
      readonly order: ProposedOrder;
      readonly execution: ExecutionExecutionResult["execution"];
    }
  | {
      readonly kind: "resumed";
      readonly order: ProposedOrder;
      readonly execution: ExecutionExecutionResult["execution"];
    }
  | {
      readonly kind: "duplicate_submitted";
      readonly order: ProposedOrder;
    }
  | {
      readonly kind: "duplicate_terminal";
      readonly order: ProposedOrder;
    }
  | {
      readonly kind: "duplicate_pending_ambiguous";
      readonly order: ProposedOrder;
    }
  | {
      readonly kind: "pending_claimed";
      readonly order: ProposedOrder;
    }
  | {
      readonly kind: "conflict";
      readonly order: ProposedOrder | null;
    }
  | {
      /**
       * PR14 blocker fix — a non-terminal order (PROPOSED or
       * SUBMITTED) already exists for this instrument under a
       * DIFFERENT `client_order_id`. The atomic advisory-lock
       * guard in `insertProposedFromTicket` refused the INSERT.
       * The caller MUST NOT retry with a new key — reconciliation
       * or the pre-existing intent has to complete first.
       */
      readonly kind: "active_intent_exists";
      readonly existingOrderId: number;
      readonly existingStatus: string;
      readonly existingClientOrderId: string | null;
    }
  | {
      /**
       * PR14 round-4 blocker — broker reports a non-zero position
       * for this instrument. Refuses even when every prior
       * `proposed_order` is terminal.
       */
      readonly kind: "open_position_exists";
      readonly accountId: string;
      readonly quantity: number;
      readonly observedAt: Date;
    }
  | {
      /**
       * PR14 round-4/5/6 blocker — the persisted broker position
       * snapshot is missing, stale, incomplete, from a different
       * session, OR the caller has no active broker account
       * (`positionGuard.kind === "unavailable"`). Fail-closed.
       */
      readonly kind: "position_state_unavailable";
      readonly accountId: string | null;
      readonly reason:
        | "missing"
        | "stale"
        | "incomplete"
        | "no_active_account"
        | "wrong_session";
    }
  | {
      readonly kind: "execution_error";
      readonly order: ProposedOrder | null;
      readonly message: string;
      readonly resumed: boolean;
    };

/**
 * Drive one execute-ticket request through the state-aware
 * idempotency + submission flow. Pure orchestration — no HTTP,
 * no timers, no side effects outside the injected deps.
 */
export async function orchestrateExecuteTicket(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
): Promise<OrchestratorOutcome> {
  // --- Up-front idempotency lookup + decision ------------------------------
  const existing = await deps.getIdempotencyRecord(input.clientOrderId);
  const upFrontDecision = decideIdempotency({
    existing: existing ? toDecisionInput(existing) : null,
    incomingHash: input.clientOrderHash,
  });

  if (upFrontDecision.kind === "conflict") {
    return { kind: "conflict", order: existing ? existing.order : null };
  }
  if (upFrontDecision.kind === "duplicate_replay") {
    // Distinguish "broker got it" from "ambiguous PROPOSED with
    // executionAttemptedAt" for the caller. The idempotency
    // helper collapses both into `duplicate_replay` (both mean
    // "do not re-submit"); the orchestrator re-classifies from
    // the persisted status so the response semantics are precise.
    return classifyDuplicateReplay(existing!.order);
  }
  if (upFrontDecision.kind === "duplicate_terminal") {
    return { kind: "duplicate_terminal", order: existing!.order };
  }
  if (upFrontDecision.kind === "resume") {
    return claimAndExecute(deps, existing!.order, { resumed: true });
  }

  // --- Fresh INSERT with UNIQUE-violation race handling --------------------
  let insertOutcome;
  try {
    insertOutcome = await deps.insertProposedFromTicket(
      input.ticket,
      input.strategy,
      {
        clientOrderId: input.clientOrderId,
        clientOrderHash: input.clientOrderHash,
      },
    );
  } catch (error) {
    if (
      deps.isUniqueViolation(error) &&
      /client_order_id/i.test((error as Error).message ?? "")
    ) {
      // Race with a concurrent writer. Re-consult the record and
      // route back through the up-front classification. If the
      // freshest state is `resume`-shaped, compete directly with
      // the concurrent writer for the atomic submission claim —
      // the fencing marker guarantees at-most-once broker call.
      const raced = await deps.getIdempotencyRecord(input.clientOrderId);
      if (raced) {
        const decision = decideIdempotency({
          existing: toDecisionInput(raced),
          incomingHash: input.clientOrderHash,
        });
        if (decision.kind === "conflict") {
          return { kind: "conflict", order: raced.order };
        }
        if (decision.kind === "duplicate_terminal") {
          return { kind: "duplicate_terminal", order: raced.order };
        }
        if (decision.kind === "resume") {
          return claimAndExecute(deps, raced.order, { resumed: true });
        }
        return classifyDuplicateReplay(raced.order);
      }
    }
    throw error;
  }

  if (insertOutcome.kind === "active_intent_exists") {
    // A non-terminal order for this instrument under a DIFFERENT
    // clientOrderId already exists — the atomic guard refused
    // the INSERT. Surface unmodified to the caller.
    return {
      kind: "active_intent_exists",
      existingOrderId: insertOutcome.existingOrderId,
      existingStatus: insertOutcome.existingStatus,
      existingClientOrderId: insertOutcome.existingClientOrderId,
    };
  }
  if (insertOutcome.kind === "open_position_exists") {
    return insertOutcome;
  }
  if (insertOutcome.kind === "position_state_unavailable") {
    return insertOutcome;
  }

  const inserted = await deps.getProposedOrderById(insertOutcome.id);
  if (!inserted) {
    return {
      kind: "execution_error",
      order: null,
      message: "failed to read inserted proposed order",
      resumed: false,
    };
  }
  // Fresh INSERT does NOT grant the right to submit. Every broker
  // call — fresh or resume — must first acquire the atomic
  // submission marker. This closes the race where request A
  // INSERTs, pauses, request B sees the clean PROPOSED via the
  // UNIQUE-violation re-lookup path above, wins the marker, and
  // submits — without the shared claim A would ALSO submit.
  return claimAndExecute(deps, inserted, { resumed: false });
}

/**
 * Shared broker-submission gate. Acquires the atomic fencing
 * marker via `tryStartSubmission` and only then invokes
 * `executePersistedOrder`. On a failed claim, re-reads the row
 * and classifies from the freshest state — never blind-returns
 * `pending_claimed` when the row already transitioned to a
 * terminal or SUBMITTED state.
 *
 * `ctx.resumed` distinguishes the outcome kind between
 * `submitted` (fresh) and `resumed` (retry that adopted an
 * existing PROPOSED row).
 */
async function claimAndExecute(
  deps: OrchestratorDeps,
  order: ProposedOrder,
  ctx: { readonly resumed: boolean },
): Promise<OrchestratorOutcome> {
  if (!order.id) {
    return {
      kind: "execution_error",
      order,
      message: "submission claim: order.id is missing",
      resumed: ctx.resumed,
    };
  }
  const claimed = await deps.tryStartSubmission({
    id: order.id,
    owner: deps.ownerId(),
    instrument: order.instrument,
    conid: typeof order.conid === "string" ? order.conid : null,
  });
  // Round-6 blocker: the unified pre-submission gate runs the
  // exposure guard atomically with the marker acquisition. A
  // blocked outcome MUST propagate up — the broker call never
  // happened and the row was left in its pre-claim state.
  if (claimed.kind === "open_position_exists") {
    return {
      kind: "open_position_exists",
      accountId: claimed.accountId,
      quantity: claimed.quantity,
      observedAt: claimed.observedAt,
    };
  }
  if (claimed.kind === "position_state_unavailable") {
    return {
      kind: "position_state_unavailable",
      accountId: claimed.accountId,
      reason: claimed.reason,
    };
  }
  if (claimed.kind === "not_claimed") {
    // Losing the atomic UPDATE means the row is no longer safe to
    // submit. Re-read for the freshest visible state and
    // classify. The row can be in any of:
    //   - PROPOSED + marker (another submitter is running, or
    //     crashed mid-submit): duplicate_pending_ambiguous
    //   - SUBMITTED / FILLED (submitter already succeeded):
    //     duplicate_submitted
    //   - REJECTED / CANCELLED / SUPERSEDED / EXPIRED (submitter
    //     completed with a terminal-failure state):
    //     duplicate_terminal
    //   - clean PROPOSED (rare — status changed back after a
    //     terminal cleared the marker, or the race read the row
    //     before the winner's marker commit): pending_claimed
    const fresh = await deps.getProposedOrderById(order.id);
    return classifyPostClaimFailure(fresh ?? order);
  }
  return runExecution(deps, order, ctx);
}

/**
 * Classify the row state observed after a losing
 * `tryStartSubmission`. Applies the same semantics as the
 * up-front idempotency classifier but sources the input from a
 * fresh SELECT rather than the initial lookup.
 */
function classifyPostClaimFailure(order: ProposedOrder): OrchestratorOutcome {
  switch (order.status) {
    case "SUBMITTED":
    case "FILLED":
      return { kind: "duplicate_submitted", order };
    case "REJECTED":
    case "CANCELLED":
    case "SUPERSEDED":
    case "EXPIRED":
      return { kind: "duplicate_terminal", order };
    case "PROPOSED":
      if (order.executionAttemptedAt || order.brokerOrderId) {
        return { kind: "duplicate_pending_ambiguous", order };
      }
      // Clean PROPOSED after a losing claim is theoretically
      // reachable only via read/write reordering that leaves the
      // marker unobserved on our re-read. The safe classification
      // is `pending_claimed` — do not submit, poll later.
      return { kind: "pending_claimed", order };
    default:
      // Defensive: an unknown status should never reach the
      // broker gate. Surface as pending to avoid a false-positive
      // SUBMITTED and let reconciliation resolve.
      return { kind: "pending_claimed", order };
  }
}

async function runExecution(
  deps: OrchestratorDeps,
  order: ProposedOrder,
  ctx: { readonly resumed: boolean },
): Promise<OrchestratorOutcome> {
  try {
    const result = await deps.executePersistedOrder(order);
    const fresh = await deps.getProposedOrderById(order.id!);
    return ctx.resumed
      ? { kind: "resumed", order: fresh ?? order, execution: result.execution }
      : {
          kind: "submitted",
          order: fresh ?? order,
          execution: result.execution,
        };
  } catch (error) {
    const fresh = await deps.getProposedOrderById(order.id!);
    return {
      kind: "execution_error",
      order: fresh ?? order,
      message: error instanceof Error ? error.message : String(error),
      resumed: ctx.resumed,
    };
  }
}

/**
 * Split a `duplicate_replay` decision into `duplicate_submitted`
 * (SUBMITTED / FILLED) vs `duplicate_pending_ambiguous` (PROPOSED
 * with `executionAttemptedAt` — attempt was made but final broker
 * status is unknown). The idempotency helper collapses these for
 * decision purposes; the orchestrator preserves the distinction
 * for caller-visible semantics.
 */
function classifyDuplicateReplay(order: ProposedOrder): OrchestratorOutcome {
  if (order.status === "SUBMITTED" || order.status === "FILLED") {
    return { kind: "duplicate_submitted", order };
  }
  // Everything else that reached `duplicate_replay` must be
  // PROPOSED with `executionAttemptedAt` (or a broker order id)
  // set — the ambiguous crash-mid-attempt case.
  return { kind: "duplicate_pending_ambiguous", order };
}

function toDecisionInput(existing: {
  readonly order: ProposedOrder;
  readonly clientOrderHash: string | null;
}): IdempotencyExistingRecord {
  return {
    clientOrderHash: existing.clientOrderHash,
    // `mapRow.normalizeStatus` guarantees the status is one of the
    // enumerated `ProposedOrderStatus` values, which is a superset
    // of `IdempotencyStatus` — the cast is safe.
    status: existing.order.status as IdempotencyExistingRecord["status"],
    executionAttemptedAt: existing.order.executionAttemptedAt,
    brokerOrderId: existing.order.brokerOrderId,
  };
}
