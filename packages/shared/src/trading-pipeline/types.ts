/**
 * Trading Pipeline — type definitions.
 *
 * The Trading Pipeline is a **deterministic** runtime orchestrator
 * that composes two existing shared engines:
 *
 *   MarketContextSnapshot
 *     → SignalEngine.evaluate(snapshot)     [Decision + Risk inside]
 *     → ExecutionTicketBuilder.build(...)
 *     → TradingPipelineResult
 *
 * Boundaries:
 *   - No HTTP, no Redis, no Postgres, no IBKR, no OpenAI, no
 *     filesystem. The pipeline is a pure function of its inputs
 *     plus the injected engines / clocks.
 *   - No Decision or Risk logic is re-implemented — those live
 *     inside `SignalEngine`. The pipeline never inspects rules or
 *     recomputes scores; it only reads terminal statuses.
 *   - Every `run()` invocation MUST return a `TradingPipelineResult`.
 *     No exception ever leaves the pipeline; unexpected throws are
 *     mapped to `outcome: "FAILURE"` with `failedStage: "UNKNOWN"`.
 */

import type { ExecutionTicket } from "../execution-ticket/types.js";
import type { SignalEvaluation } from "../signal-engine/types.js";

/**
 * Discriminator for the three terminal outcomes of a pipeline run.
 *
 *   - `SUCCESS`  — signal was `GENERATED` and a ticket was built.
 *   - `NO_TRADE` — signal engine reached a terminal state that
 *                  intentionally means "do nothing" (currently
 *                  `HOLD`). Not a failure — no blockers, no error.
 *   - `FAILURE`  — signal was `BLOCKED` / `REJECTED` / `ERROR`,
 *                  the ticket builder returned `{ ok: false }`, or
 *                  an engine threw (mapped to `UNKNOWN`).
 */
export type TradingPipelineOutcome = "SUCCESS" | "NO_TRADE" | "FAILURE";

/**
 * Which stage of the pipeline caused a `FAILURE` outcome.
 *
 *   - `DECISION` — signal engine reports `BLOCKED`, or `ERROR`
 *                  originating from the Decision Engine.
 *   - `RISK`     — signal engine reports `REJECTED`, or `ERROR`
 *                  originating from the Risk Engine.
 *   - `SIGNAL`   — signal engine reports `ERROR` originating from
 *                  the Signal Engine itself (or from instrument
 *                  resolution).
 *   - `TICKET`   — signal was `GENERATED` but the Execution Ticket
 *                  Builder returned `{ ok: false }`.
 *   - `UNKNOWN`  — unexpected exception escaped one of the composed
 *                  engines. Should not happen in production but is
 *                  covered by defence in depth.
 */
export type TradingPipelineFailedStage =
  | "DECISION"
  | "RISK"
  | "SIGNAL"
  | "TICKET"
  | "UNKNOWN";

/**
 * Reason for a `NO_TRADE` outcome. Currently only `HOLD`; kept as a
 * dedicated union so additional non-failure terminal states can be
 * added later without breaking exhaustiveness at call sites.
 */
export type TradingPipelineNoTradeReason = "HOLD";

/**
 * Diagnostic message carried on all outcomes. The pipeline never
 * invents warnings; it forwards them from the underlying engines.
 */
export interface TradingPipelineWarning {
  readonly code: string;
  readonly message: string;
  readonly source: string;
}

/**
 * Structured explanation of a `FAILURE` produced by the pipeline
 * itself or by the ticket builder. `stage` is redundant with
 * `TradingPipelineFailure.failedStage` on purpose — it lets
 * consumers filter by stage without walking the parent result.
 *
 * IMPORTANT: The pipeline does NOT copy Decision Engine or Risk
 * Engine blockers into this list. For `DECISION`, `RISK`, and
 * `SIGNAL` failures the `blockers` array on the failure is empty;
 * the authoritative diagnostics live on `signal.decision?.blockedBy`,
 * `signal.risk?.blockers`, and `signal.warnings`. Pipeline blockers
 * exist only for `TICKET` and `UNKNOWN` failures.
 */
export interface TradingPipelineBlocker {
  readonly code: string;
  readonly message: string;
  readonly source: string;
  readonly stage: TradingPipelineFailedStage;
}

/**
 * Semver-ish versions of every engine consulted for this run, plus
 * the pipeline's own version. Individual engine versions are
 * `undefined` when the corresponding engine did not run (e.g.
 * `ticketBuilderVersion` is absent when the pipeline failed before
 * the ticket stage).
 */
export interface TradingPipelineEngineVersions {
  readonly pipeline: string;
  readonly signal?: string;
  readonly decision?: string;
  readonly risk?: string;
  readonly ticketBuilder?: string;
}

export interface TradingPipelineMetadata {
  readonly engineVersions: TradingPipelineEngineVersions;
  /** Wall-clock timestamp at which the pipeline started. */
  readonly ranAt: Date;
}

export interface TradingPipelineSuccess {
  readonly outcome: "SUCCESS";
  readonly signal: SignalEvaluation;
  readonly ticket: ExecutionTicket;
  readonly warnings: readonly TradingPipelineWarning[];
  readonly durationMs: number;
  readonly metadata: TradingPipelineMetadata;
}

/**
 * Terminal, non-failure outcome. The signal engine reached a state
 * that intentionally means "do not trade" (e.g. Decision Engine
 * returned `HOLD`). No blockers are attached: HOLD is a valid
 * business decision, not an error.
 */
export interface TradingPipelineNoTrade {
  readonly outcome: "NO_TRADE";
  readonly signal: SignalEvaluation;
  readonly ticket: null;
  readonly reason: TradingPipelineNoTradeReason;
  readonly warnings: readonly TradingPipelineWarning[];
  readonly durationMs: number;
  readonly metadata: TradingPipelineMetadata;
}

export interface TradingPipelineFailure {
  readonly outcome: "FAILURE";
  /**
   * `SignalEvaluation` produced by the signal stage. `null` only
   * when a pipeline-level exception prevented the signal engine
   * from returning (that maps to `failedStage: "UNKNOWN"`).
   *
   * For `failedStage` of `DECISION`, `RISK` or `SIGNAL`, this
   * evaluation is the authoritative source of diagnostics
   * (`decision?.blockedBy`, `risk?.blockers`, `warnings`).
   */
  readonly signal: SignalEvaluation | null;
  /** Always `null` on failure — no partial tickets are shipped. */
  readonly ticket: null;
  /**
   * Pipeline-owned blockers. Populated ONLY for `TICKET` (ticket
   * builder returned `{ ok: false }`) and `UNKNOWN` (an engine
   * threw). Empty for `DECISION` / `RISK` / `SIGNAL` — see the note
   * on `TradingPipelineBlocker`.
   */
  readonly blockers: readonly TradingPipelineBlocker[];
  readonly warnings: readonly TradingPipelineWarning[];
  readonly failedStage: TradingPipelineFailedStage;
  readonly durationMs: number;
  readonly metadata: TradingPipelineMetadata;
}

export type TradingPipelineResult =
  | TradingPipelineSuccess
  | TradingPipelineNoTrade
  | TradingPipelineFailure;
