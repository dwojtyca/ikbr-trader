/**
 * Execution Runtime — orchestration.
 *
 * Composes the PR12 dry-run flow with the paper guard and submitter
 * into one write-edge entry point. The client supplies only
 * `{ instrumentId, policy, idempotencyKey }` — the runtime runs the
 * pipeline itself and can ONLY submit a ticket built inside the
 * same call.
 *
 * PR13 semantics:
 *   - `TradingPipeline.NO_TRADE`  → `NOT_SUBMITTED / NO_TRADE`
 *   - `TradingPipeline.FAILURE`   → `NOT_SUBMITTED / PIPELINE_FAILURE`
 *   - `TradingPipeline.SUCCESS` + paper guard rejects
 *                                → `NOT_SUBMITTED / PAPER_GUARD_FAILED`
 *   - `TradingPipeline.SUCCESS` + guard OK
 *                                → single call to the submitter
 *                                  and one of SUBMITTED / DUPLICATE /
 *                                  PENDING / CONFLICT / NOT_SUBMITTED /
 *                                  UNKNOWN.
 *
 * `DUPLICATE` vs `PENDING` distinction:
 *   - `DUPLICATE` — execution-engine confirmed the prior attempt
 *     reached a TERMINAL state. Sub-status carried on `previousOrder.status`:
 *       - `SUBMITTED` / `FILLED` — a prior submission succeeded.
 *       - `REJECTED` / `CANCELLED` / `SUPERSEDED` / `EXPIRED` — a
 *         prior submission ended in a terminal-non-successful state;
 *         a caller wanting to try again MUST mint a fresh
 *         `idempotencyKey`.
 *   - `PENDING`   — execution-engine cannot yet confirm the
 *     terminal state. Sub-reason:
 *       - `ambiguous_attempt` — the prior process reached
 *         `markExecutionAttempt` and died before the broker
 *         confirmed. Reconciliation will resolve.
 *       - `claim_held_by_other` — another request currently holds
 *         the atomic resume claim. Retry AFTER the current attempt
 *         finishes to observe the terminal outcome.
 *   In BOTH `PENDING` sub-cases the caller MUST NOT re-submit
 *   with a new key and MUST NOT interpret the outcome as SUCCESS.
 *
 * Retry policy: none at this layer. Any ambiguous outcome from the
 * submitter surfaces as `UNKNOWN` or `PENDING` — a later
 * reconciliation PR is responsible for resolving broker state.
 */

import type {
  ExecutionTicketPolicy,
  TradingPipelineResult,
} from "@ikbr/shared";

import type { DryRunResult, MarketDataRuntime } from "../runtime.js";
import type { PaperGuard } from "./paper-guard.js";
import type {
  DuplicateResponseBody,
  ExecutionTicketSubmitter,
  SubmittedResponseBody,
} from "./submitter.js";
import { computeClientOrderHash } from "./client-order-hash.js";
import { toLegacySignalTicket } from "./ticket-mapper.js";

export type NotSubmittedReason =
  | "NO_TRADE"
  | "PIPELINE_FAILURE"
  | "PAPER_GUARD_FAILED"
  | "UNSUPPORTED_TICKET_SHAPE"
  | "ACTIVE_INTENT_EXISTS"
  | "OPEN_POSITION_EXISTS"
  | "POSITION_STATE_UNAVAILABLE";

export type PendingReason = "ambiguous_attempt" | "claim_held_by_other";

export type ExecutionRuntimeOutcome =
  | {
      readonly outcome: "SUBMITTED";
      readonly pipeline: TradingPipelineResult;
      readonly execution: SubmittedResponseBody["execution"];
      readonly idempotencyKey: string;
      readonly resumed?: boolean;
    }
  | {
      readonly outcome: "NOT_SUBMITTED";
      readonly pipeline: TradingPipelineResult;
      readonly reason: NotSubmittedReason;
      readonly message?: string;
    }
  | {
      readonly outcome: "DUPLICATE";
      readonly previousExecution: DuplicateResponseBody["order"];
      readonly idempotencyKey: string;
    }
  | {
      readonly outcome: "PENDING";
      readonly previousOrder: DuplicateResponseBody["order"];
      readonly reason: PendingReason;
      readonly idempotencyKey: string;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly idempotencyKey: string;
      readonly message?: string;
    }
  | {
      readonly outcome: "UNKNOWN";
      readonly idempotencyKey: string;
      readonly reason: string;
    };

export interface ExecutionRuntimeOptions {
  readonly dryRun: MarketDataRuntime;
  readonly paperGuard: PaperGuard;
  readonly submitter: ExecutionTicketSubmitter;
  /**
   * `strategy` label persisted on the `proposed_orders` row.
   * Defaults to `"execution-runtime"` — distinguishes rows created
   * by PR13 from the legacy `signal-engine` pipeline.
   */
  readonly strategyLabel?: string;
}

export interface ExecuteInput {
  readonly instrumentId: string;
  readonly policy: ExecutionTicketPolicy;
  readonly idempotencyKey: string;
}

export class ExecutionRuntime {
  readonly #dryRun: MarketDataRuntime;
  readonly #paperGuard: PaperGuard;
  readonly #submitter: ExecutionTicketSubmitter;
  readonly #strategy: string;

  constructor(options: ExecutionRuntimeOptions) {
    if (!options?.dryRun) {
      throw new Error("ExecutionRuntime: dryRun is required");
    }
    if (!options.paperGuard) {
      throw new Error("ExecutionRuntime: paperGuard is required");
    }
    if (!options.submitter) {
      throw new Error("ExecutionRuntime: submitter is required");
    }
    this.#dryRun = options.dryRun;
    this.#paperGuard = options.paperGuard;
    this.#submitter = options.submitter;
    this.#strategy = options.strategyLabel ?? "execution-runtime";
  }

  async execute(input: ExecuteInput): Promise<ExecutionRuntimeOutcome> {
    const dryRunResult = await this.#dryRun.dryRun(
      input.instrumentId,
      input.policy,
    );
    return this.#submitFromDryRun(dryRunResult, input.idempotencyKey);
  }

  /**
   * PR14 seam — submit against a PRE-COMPUTED `DryRunResult` so the
   * caller (e.g. the trading loop) can derive a stable trigger
   * identity from `dryRunResult.snapshot` and pass it back as
   * `idempotencyKey` WITHOUT running the pipeline twice.
   *
   * The `clientOrderHash` is ALWAYS re-derived from the ticket
   * inside the submission path — this method intentionally does
   * NOT accept a pre-computed hash. Trusting a caller-supplied
   * hash would allow a swapped ticket to slip past the
   * conflict-detection layer while the caller's stale hash
   * matches the previously-submitted intent. Round-5 blocker fix.
   */
  async executePrepared(input: {
    readonly dryRunResult: DryRunResult;
    readonly idempotencyKey: string;
  }): Promise<ExecutionRuntimeOutcome> {
    return this.#submitFromDryRun(input.dryRunResult, input.idempotencyKey);
  }

  async #submitFromDryRun(
    dryRunResult: DryRunResult,
    idempotencyKey: string,
  ): Promise<ExecutionRuntimeOutcome> {
    const pipeline = dryRunResult.pipeline;

    if (pipeline.outcome === "NO_TRADE") {
      return {
        outcome: "NOT_SUBMITTED",
        pipeline,
        reason: "NO_TRADE",
      };
    }
    if (pipeline.outcome !== "SUCCESS") {
      return {
        outcome: "NOT_SUBMITTED",
        pipeline,
        reason: "PIPELINE_FAILURE",
      };
    }

    const guard = await this.#paperGuard.check();
    if (!guard.ok) {
      return {
        outcome: "NOT_SUBMITTED",
        pipeline,
        reason: "PAPER_GUARD_FAILED",
        ...(guard.reason !== undefined ? { message: guard.reason } : {}),
      };
    }

    const ticket = pipeline.ticket;
    let legacyTicket;
    try {
      legacyTicket = toLegacySignalTicket(ticket);
    } catch (err) {
      // The mapper rejects tickets that cannot be represented on
      // the legacy wire (STP_LMT, STP+bracket). These are deterministic
      // shape violations, not runtime failures — surface as a
      // dedicated NOT_SUBMITTED reason so callers/tests can
      // distinguish them from ambiguous pipeline errors.
      return {
        outcome: "NOT_SUBMITTED",
        pipeline,
        reason: "UNSUPPORTED_TICKET_SHAPE",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const clientOrderHash = computeClientOrderHash(ticket);

    const submission = await this.#submitter.submit({
      ticket: legacyTicket,
      strategy: this.#strategy,
      clientOrderId: idempotencyKey,
      clientOrderHash,
    });

    switch (submission.kind) {
      case "submitted":
        return {
          outcome: "SUBMITTED",
          pipeline,
          execution: submission.response.execution,
          idempotencyKey,
        };
      case "resumed":
        return {
          outcome: "SUBMITTED",
          pipeline,
          execution: submission.response.execution,
          idempotencyKey,
          resumed: true,
        };
      case "duplicate_submitted":
      case "duplicate_terminal":
        // Terminal outcomes reach the caller through
        // `previousExecution.order.status`. `duplicate_terminal`
        // is NOT a success — clients that want to retry after a
        // REJECTED/CANCELLED prior attempt must mint a fresh
        // idempotency key.
        return {
          outcome: "DUPLICATE",
          previousExecution: submission.response.order,
          idempotencyKey,
        };
      case "duplicate_pending_ambiguous":
        return {
          outcome: "PENDING",
          previousOrder: submission.response.order,
          reason: "ambiguous_attempt",
          idempotencyKey,
        };
      case "pending_claimed":
        return {
          outcome: "PENDING",
          previousOrder: submission.response.order,
          reason: "claim_held_by_other",
          idempotencyKey,
        };
      case "conflict":
        return {
          outcome: "CONFLICT",
          idempotencyKey,
          message: submission.message,
        };
      case "active_intent_exists":
        // Execution-engine's atomic instrument-level guard refused
        // the INSERT. Retrying with a fresh key will produce the
        // same outcome until the pre-existing intent finishes.
        return {
          outcome: "NOT_SUBMITTED",
          pipeline,
          reason: "ACTIVE_INTENT_EXISTS",
          message: submission.message,
        };
      case "open_position_exists":
        // Broker reports a non-zero position for the instrument —
        // PR14 round-4 authoritative open-position guard. Retrying
        // will fail until the position is closed.
        return {
          outcome: "NOT_SUBMITTED",
          pipeline,
          reason: "OPEN_POSITION_EXISTS",
          message: submission.message,
        };
      case "position_state_unavailable":
        // Execution-engine has no fresh / complete broker snapshot.
        // Fail-closed — the loop must skip, NOT auto-retry.
        return {
          outcome: "NOT_SUBMITTED",
          pipeline,
          reason: "POSITION_STATE_UNAVAILABLE",
          message: submission.message,
        };
      case "not_submitted":
        return {
          outcome: "NOT_SUBMITTED",
          pipeline,
          reason: "PIPELINE_FAILURE",
          message: `execution-engine rejected the submission (${submission.statusCode}): ${submission.message}`,
        };
      case "unknown":
        return {
          outcome: "UNKNOWN",
          idempotencyKey,
          reason: submission.reason,
        };
    }
  }
}
