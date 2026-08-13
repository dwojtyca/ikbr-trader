/**
 * Signal Engine — type definitions.
 *
 * The Signal Engine is a **deterministic** domain orchestrator. It
 * runs the pipeline:
 *
 *   MarketContextSnapshot
 *     → DecisionEngine.evaluate(snapshot)
 *     → RiskEngine.evaluate(decision, snapshot, instrument)
 *     → SignalEvaluation
 *
 * Boundaries:
 *   - No LLM, no HTTP, no persistence, no broker communication.
 *   - No knowledge of `execution-engine`. The engine produces a
 *     verdict, not an executable ticket.
 *   - No consumer migration in this PR: no service (signal-engine
 *     app, execution-engine, llm-agent, ui) is wired to
 *     `SignalEngine` yet. This is a shared-domain module.
 *   - Every `evaluate()` call MUST return a `SignalEvaluation` — no
 *     exception ever escapes the engine.
 */

import type { DecisionResult } from "../decision-engine/types.js";
import type { RiskEvaluation } from "../risk-engine/types.js";

/**
 * Terminal status of one signal evaluation. Mapping (see
 * `result.ts`):
 *
 *   - `GENERATED` — decision produced a directional action AND
 *                   risk approved it.
 *   - `HOLD`      — decision produced `HOLD` (with no blockers).
 *   - `BLOCKED`   — decision has at least one `blockedBy` entry, OR
 *                   the pipeline emitted at least one
 *                   `SignalBlocker` (e.g. attribution direction
 *                   mismatch).
 *   - `REJECTED`  — risk engine returned `approved = false`.
 *   - `ERROR`     — decision engine or risk engine threw, or the
 *                   instrument could not be resolved. Never leaks
 *                   the underlying exception; the message goes into
 *                   `warnings` and `reasonSummary`.
 */
export type SignalStatus =
  | "GENERATED"
  | "REJECTED"
  | "BLOCKED"
  | "HOLD"
  | "ERROR";

/**
 * Source of a warning attached to a `SignalEvaluation`. Kept
 * separate from a free-form string so downstream consumers can
 * filter without regex parsing.
 */
export type SignalWarningSource =
  | "decision-engine"
  | "risk-engine"
  | "signal-engine"
  | "instrument-registry";

export interface SignalWarning {
  readonly code: string;
  readonly message: string;
  readonly source: SignalWarningSource;
}

/**
 * PR15.4 — typed blocker code union for the pipeline-level
 * classification blockers surfaced on `SignalEvaluation.blockers`.
 * Distinct from `SignalWarning.code` (free-form string) — the two
 * types serve different purposes.
 *
 * Currently exactly one member; kept as a discriminated union so
 * future gates (e.g. instrument policy misalignment surfaced by
 * the pipeline rather than by the loop) can extend it without
 * breaking exhaustiveness at consumer sites.
 */
export type SignalBlockerCode = "STRATEGY_DIRECTION_UNCONFIRMED";

/**
 * PR15.4 — structured pipeline-level blocker. Propagated from
 * `runSignalPipeline()` onto `SignalEvaluation.blockers`.
 * `source` is a discriminator: attribution blockers surface
 * `failedStage: "ATTRIBUTION"` in the trading pipeline; other
 * sources map to their respective stages.
 */
export interface SignalBlocker {
  readonly code: SignalBlockerCode;
  readonly message: string;
  readonly source: "attribution";
}

/**
 * PR15.4 — minimal attribution carrier threaded through
 * `TradingLoopService → MarketDataRuntime → TradingPipeline →
 * SignalEngine → runSignalPipeline`. The pipeline uses
 * `intendedAction` to enforce the direction gate (fail-closed
 * before the Risk Engine) and always stamps `strategyId` onto
 * `SignalEvaluation.metadata.strategyId`.
 */
export interface SignalAttributionContext {
  readonly strategyId: string;
  readonly intendedAction: "LONG" | "SHORT";
}

/**
 * Semver-ish versions of every engine consulted for this signal.
 * `decision` / `risk` are absent iff the corresponding engine did
 * not run (or its output was discarded because it threw).
 */
export interface SignalEngineVersions {
  readonly signal: string;
  readonly decision?: string;
  readonly risk?: string;
}

export interface SignalMetadata {
  readonly engineVersions: SignalEngineVersions;
  /**
   * Wall-clock cost of the whole pipeline in milliseconds, measured
   * via the injected `performanceNow`. Informational only.
   */
  readonly evaluationTimeMs: number;
  /**
   * PR15.3 — optional identifier of the strategy that actually
   * produced the winning intent. The shared `SignalEngine` does
   * NOT populate this today (its pipeline is Decision + Risk
   * without a named strategy layer); the field is reserved so a
   * future strategy-aware pipeline can advertise its identity.
   *
   * Downstream consumers (in particular the trading-loop
   * fail-closed strategy-policy check) MUST treat `undefined`
   * as "no strategy identity reported" and MUST refuse the
   * intent when `strategyId` is defined and disagrees with
   * `Instrument.executionPolicy.strategyId`.
   */
  readonly strategyId?: string;
}

/**
 * Final, immutable output of one pipeline run. Deep-frozen by the
 * engine before being returned.
 *
 * `decision` and `risk` are `null` when the corresponding engine
 * either did not run (decision blocked → risk skipped, decision HOLD
 * → risk skipped) or threw (status becomes `ERROR`). They are never
 * partially-populated: it's either the immutable output of that
 * engine or `null`.
 */
export interface SignalEvaluation {
  readonly signalId: string;
  readonly generatedAt: Date;
  readonly instrumentId: string;
  readonly decision: DecisionResult | null;
  readonly risk: RiskEvaluation | null;
  readonly status: SignalStatus;
  readonly reasonSummary: string;
  readonly warnings: readonly SignalWarning[];
  /**
   * PR15.4 — pipeline-level blockers. Distinct from
   * `SignalWarning` and from `DecisionResult.blockedBy`.
   * Populated by `runSignalPipeline()` for classification-level
   * failures (currently only the attribution direction gate).
   * Empty array (never `undefined`) when no pipeline blocker
   * fired.
   */
  readonly blockers: readonly SignalBlocker[];
  readonly metadata: SignalMetadata;
}
