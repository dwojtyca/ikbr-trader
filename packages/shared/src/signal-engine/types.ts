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
 *   - `BLOCKED`   — decision has at least one blocker.
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
  readonly metadata: SignalMetadata;
}
