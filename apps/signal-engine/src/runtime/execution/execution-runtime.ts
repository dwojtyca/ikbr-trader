import type { IndicatorSnapshot } from "@ikbr/shared";
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
  BoundInstrument,
  ExecutionTicketPolicy,
  InstrumentBindingAuthority,
  TradingPipelineResult,
} from "@ikbr/shared";
import { tickSizesEqual } from "@ikbr/shared";

import type { DryRunResult, MarketDataRuntime } from "../runtime.js";
import type { PaperGuard } from "./paper-guard.js";
import type {
  DuplicateResponseBody,
  ExecutionTicketSubmitter,
  SubmittedResponseBody,
} from "./submitter.js";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { toLegacySignalTicket } from "./ticket-mapper.js";

export type NotSubmittedReason =
  | "NO_TRADE"
  | "PIPELINE_FAILURE"
  | "PAPER_GUARD_FAILED"
  | "UNSUPPORTED_TICKET_SHAPE"
  | "ACTIVE_INTENT_EXISTS"
  | "OPEN_POSITION_EXISTS"
  | "POSITION_STATE_UNAVAILABLE"
  /**
   * PR15.2 hostile-review fix — the runtime refused to run
   * because the requested `instrumentId` has no authoritative
   * binding in the shared `INSTRUMENT_BINDINGS_JSON`. Same
   * failure the trading loop surfaces at the pre-check gate;
   * `/runtime/execute` now emits it instead of proceeding into
   * a symbol-only pipeline that would eventually be rejected
   * downstream with `conid_missing`.
   */
  | "INSTRUMENT_BINDING_UNAVAILABLE"
  /**
   * PR15.2 hostile-review fix — the bound instrument's
   * `Instrument.executionPolicy.priceTickSize` does not match
   * the operator-configured `bound.minTick`. Fail-closed so no
   * ticket is built with an unverified tick size.
   */
  | "INSTRUMENT_TICK_MISMATCH"
  /**
   * PR15.4 — `executePrepared` was called without a canonical
   * `strategyId` (absent, empty, or whitespace-padded). The
   * trading loop refuses to submit an intent without a real
   * strategy attribution; the runtime enforces this itself so
   * that any future caller of `executePrepared` cannot bypass
   * attribution.
   */
  | "STRATEGY_ATTRIBUTION_UNAVAILABLE"
  /**
   * PR15.4 — the caller-supplied `strategyId` disagrees with
   * `dryRunResult.pipeline.signal.metadata.strategyId`. Independent
   * of the trading loop's pre-dryRun check — this is a final
   * defence-in-depth so a fabricated attribution cannot ride on
   * a mis-attributed pipeline result.
   */
  | "STRATEGY_ATTRIBUTION_MISMATCH";

export type PendingReason = "ambiguous_attempt" | "claim_held_by_other";

export type ExecutionRuntimeOutcome =
  | { readonly outcome: "AWAITING_AI"; readonly previousOrder: unknown; readonly idempotencyKey: string }
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
  /**
   * PR15.2 hostile-review fix — server-side authority mapping
   * logical `instrumentId` → exact operator-selected IBKR
   * contract. When provided (production wiring), the runtime
   * refuses to run for any unbound instrument, refuses to build
   * a ticket with a tick size that disagrees with the binding,
   * and forwards the frozen bound view through to the submitter
   * so `/runtime/execute` uses the SAME authoritative
   * mechanism as the trading loop. Optional to preserve
   * backwards compatibility for pre-existing unit tests that
   * pre-date the binding layer.
   */
  readonly bindingAuthority?: InstrumentBindingAuthority;
}

export interface ExecuteInput {
  readonly instrumentId: string;
  readonly policy: ExecutionTicketPolicy;
  readonly idempotencyKey: string;
}

/**
 * PR15.4 — canonical input for `executePrepared`. `strategyId` is
 * required at the type level AND validated at runtime (§11.3 of the
 * plan). Callers that do not have a real strategy attribution MUST
 * NOT invoke this method.
 */
export interface ExecutePreparedInput {
  readonly indicators?: IndicatorSnapshot;
  readonly dryRunResult: DryRunResult;
  readonly idempotencyKey: string;
  /**
   * PR15.2 — authoritative operator-selected contract identity
   * for the instrument. When supplied, the runtime OVERRIDES the
   * ticket's `conId`, `localSymbol`, `tradingClass`, and
   * `brokerSymbol` with the bound values before submission.
   */
  readonly bound?: BoundInstrument;
  /**
   * PR15.4 — the strategy that produced the winning signal.
   * Persisted as `proposed_orders.strategy`. Required; empty /
   * whitespace values are rejected as
   * `STRATEGY_ATTRIBUTION_UNAVAILABLE`.
   */
  readonly strategyId: string;
}

export class ExecutionRuntime {
  readonly #dryRun: MarketDataRuntime;
  readonly #paperGuard: PaperGuard;
  readonly #submitter: ExecutionTicketSubmitter;
  readonly #strategy: string;
  readonly #bindingAuthority: InstrumentBindingAuthority | null;

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
    this.#bindingAuthority = options.bindingAuthority ?? null;
  }

  async execute(input: ExecuteInput): Promise<ExecutionRuntimeOutcome> {
    // PR15.2 hostile-review fix — bound-identity gate BEFORE the
    // pipeline runs. `/runtime/execute` MUST use the same
    // authoritative binding mechanism as the trading loop; a
    // symbol-only pipeline for a futures instrument is not a
    // safe production path.
    let bound: BoundInstrument | undefined;
    if (this.#bindingAuthority) {
      const resolved = this.#bindingAuthority.getBoundInstrument(
        input.instrumentId,
      );
      if (!resolved) {
        return {
          outcome: "NOT_SUBMITTED",
          pipeline: bindingUnavailablePipeline(),
          reason: "INSTRUMENT_BINDING_UNAVAILABLE",
          message: `no binding configured for ${input.instrumentId}`,
        };
      }
      // Bound-vs-policy tick assertion. The policy came from
      // trusted source (loop / caller), but we still refuse
      // divergence so no downstream code path builds a ticket
      // using a tick size that never was broker-verified.
      if (!tickSizesEqual(resolved.minTick, input.policy.priceTickSize)) {
        return {
          outcome: "NOT_SUBMITTED",
          pipeline: bindingUnavailablePipeline(),
          reason: "INSTRUMENT_TICK_MISMATCH",
          message:
            `policy.priceTickSize=${input.policy.priceTickSize} does not ` +
            `match bound.minTick=${resolved.minTick} for ${input.instrumentId}`,
        };
      }
      bound = resolved;
    }
    const dryRunResult = await this.#dryRun.dryRun(
      input.instrumentId,
      input.policy,
    );
    return this.#submitFromDryRun(
      dryRunResult,
      input.idempotencyKey,
      bound,
      this.#strategy,
    );
  }

  /**
   * PR14 seam — submit against a PRE-COMPUTED `DryRunResult` so the
   * caller (e.g. the trading loop) can derive a stable trigger
   * identity from `dryRunResult.snapshot` and pass it back as
   * `idempotencyKey` WITHOUT running the pipeline twice.
   *
   * PR15.4 — `strategyId` is now REQUIRED. The runtime performs
   * four fail-closed checks in order:
   *   1. `strategyId` must be a non-empty, trimmed string.
   *   2. Non-SUCCESS pipelines fall through to `#submitFromDryRun`
   *      (existing NO_TRADE / PIPELINE_FAILURE handling); the
   *      attribution mismatch check is meaningless without a
   *      successful signal.
   *   3. `pipeline.signal.metadata.strategyId` must equal the
   *      caller-supplied `strategyId` (defence-in-depth against a
   *      caller that fabricates an attribution).
   *   4. All checks pass → submit with `strategyId` as the
   *      persisted `strategy` label.
   *
   * The `clientOrderHash` is ALWAYS re-derived from the ticket
   * inside the submission path — this method intentionally does
   * NOT accept a pre-computed hash. Trusting a caller-supplied
   * hash would allow a swapped ticket to slip past the
   * conflict-detection layer while the caller's stale hash
   * matches the previously-submitted intent. Round-5 blocker fix.
   */
  async executePrepared(
    input: ExecutePreparedInput,
  ): Promise<ExecutionRuntimeOutcome> {
    // 1. Canonical strategyId required. Guarded before touching the
    //    pipeline / paper guard / submitter so a bad caller cannot
    //    reach any write path.
    if (
      typeof input.strategyId !== "string" ||
      input.strategyId.length === 0 ||
      input.strategyId !== input.strategyId.trim()
    ) {
      return {
        outcome: "NOT_SUBMITTED",
        pipeline: input.dryRunResult.pipeline,
        reason: "STRATEGY_ATTRIBUTION_UNAVAILABLE",
        message: "executePrepared: canonical strategyId is required",
      };
    }

    const pipeline = input.dryRunResult.pipeline;

    // 2. Non-SUCCESS pipelines fall through to the existing
    //    NO_TRADE / PIPELINE_FAILURE handling. Attribution match
    //    is only meaningful for SUCCESS results (there is no
    //    signal to attribute otherwise).
    if (pipeline.outcome !== "SUCCESS") {
      return this.#submitFromDryRun(
        input.dryRunResult,
        input.idempotencyKey,
        input.bound,
        input.strategyId,
      );
    }

    // 3. Defence-in-depth: the caller-supplied strategyId MUST
    //    match what the pipeline attributed. The trading loop
    //    already validates this pre-dryRun; the runtime enforces
    //    it independently so any future caller of `executePrepared`
    //    cannot bypass attribution.
    if (pipeline.signal.metadata.strategyId !== input.strategyId) {
      return {
        outcome: "NOT_SUBMITTED",
        pipeline,
        reason: "STRATEGY_ATTRIBUTION_MISMATCH",
        message: "executePrepared: strategy attribution mismatch",
      };
    }

    // 4. All checks passed; delegate to the standard submission
    //    path with the validated strategyId as the persisted label.
    return this.#submitFromDryRun(
      input.dryRunResult,
      input.idempotencyKey,
      input.bound,
      input.strategyId,
      input.indicators,
    );
  }

  async #submitFromDryRun(
    dryRunResult: DryRunResult,
    idempotencyKey: string,
    bound: BoundInstrument | undefined,
    strategyLabel: string,
    indicators?: IndicatorSnapshot,
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
      legacyTicket = toLegacySignalTicket(ticket, { bound });
      if (indicators) legacyTicket.indicators = indicators;
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
    const clientOrderHash = computeClientOrderHash(legacyTicket);

    const submission = await this.#submitter.submit({
      ticket: legacyTicket,
      strategy: strategyLabel,
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
      case "awaiting_ai":
        return { outcome: "AWAITING_AI", previousOrder: submission.response.order, idempotencyKey };
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

/**
 * PR15.2 hostile-review fix — synthesize a minimal
 * `TradingPipelineResult` shell for a binding-gate rejection.
 * The runtime returns `NOT_SUBMITTED / INSTRUMENT_BINDING_UNAVAILABLE`
 * BEFORE it has a real pipeline result to attach; downstream
 * consumers (routes / trading loop) only read `outcome.reason`
 * and `outcome.message`, so a placeholder is safe.
 */
function bindingUnavailablePipeline(): TradingPipelineResult {
  return {
    outcome: "FAILURE",
    signal: null,
    ticket: null,
    blockers: [
      {
        code: "INSTRUMENT_MISMATCH",
        message: "instrument binding unavailable",
        source: "instrument",
      },
    ],
    warnings: [],
    failedStage: "SIGNAL",
    durationMs: 0,
    metadata: {
      engineVersions: {},
      ranAt: new Date(0),
    },
  } as unknown as TradingPipelineResult;
}
