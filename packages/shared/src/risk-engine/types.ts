/**
 * Risk Engine — type definitions.
 *
 * The Risk Engine is a **deterministic**, rule-based gate that
 * decides whether a `DecisionResult` from the Decision Engine may
 * proceed toward execution. It is not an executor — it never places,
 * modifies, or cancels orders and never talks to a broker.
 *
 * Boundaries:
 *   - Rules MUST be pure functions of `RiskInput` (decision +
 *     snapshot + instrument). No I/O, no side effects, no randomness.
 *   - Rules MUST NOT talk to `execution-engine` or place orders.
 *   - The engine MUST NOT throw for rule failures — a rule that
 *     throws is isolated into an `UNKNOWN` blocker with the rule id
 *     attached.
 */

import type { DecisionResult } from "../decision-engine/types.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";

/**
 * Enumerated blocker codes. Any blocker forces `approved = false`.
 * `UNKNOWN` is a catch-all for rule-level exceptions and other
 * unclassified conditions.
 */
export type RiskBlockerCode =
  | "LOW_CONFIDENCE"
  | "HIGH_IMPACT_EVENT"
  | "STALE_SNAPSHOT"
  | "UNAVAILABLE_SNAPSHOT"
  | "INSTRUMENT_DISABLED"
  | "OVERNIGHT_NOT_ALLOWED"
  | "OUT_OF_SESSION"
  | "BROKER_ENVIRONMENT_MISMATCH"
  | "HIGH_RISK_SCORE"
  | "UNKNOWN";

export interface RiskBlocker {
  readonly code: RiskBlockerCode;
  readonly message: string;
  readonly ruleId?: string;
}

export interface RiskWarning {
  readonly code: string;
  readonly message: string;
  readonly ruleId?: string;
}

/**
 * Inputs consumed by every rule + by the engine. Grouped so future
 * additions (e.g. current portfolio, per-strategy configuration) can
 * be added without breaking the `RiskRule` signature — see
 * `RuleContext` TODO on the decision-engine `Rule` interface for the
 * planned longer-term shape.
 */
export interface RiskInput {
  readonly decision: DecisionResult;
  readonly snapshot: MarketContextSnapshot;
  readonly instrument: Instrument;
}

/**
 * A rule's per-input output. `scoreContribution` is a NON-NEGATIVE
 * number in `[0, 100]` denoting "risk points" the rule wants to
 * charge against the trade. The aggregator sums and clamps.
 *
 * Unlike the Decision Engine, risk is unipolar — there is no
 * "bullish" cancellation. A rule that has nothing to say returns
 * `scoreContribution: 0` with empty arrays.
 */
export interface RiskRuleEvaluation {
  readonly scoreContribution: number;
  readonly warnings: readonly RiskWarning[];
  readonly blockers: readonly RiskBlocker[];
}

/**
 * Rule contract. Pure function of `RiskInput`; `supports()` lets a
 * rule opt out of inputs it cannot meaningfully evaluate.
 *
 * TODO(async): mirror the decision-engine TODO — once a rule needs
 * to consult I/O-bound risk services (e.g. broker margin snapshot,
 * portfolio manager), `evaluate()` will become
 * `Promise<RiskRuleEvaluation>` and the engine will gain a per-rule
 * timeout. Not implemented in this PR: every current rule is a pure
 * snapshot/instrument/decision inspector.
 *
 * TODO(context): also mirror the decision-engine TODO — a future
 * `RiskContext` parameter will carry `{ config, clock, logger,
 * featureFlags, portfolio, sessionCalendar }` so rules can drop
 * ad-hoc option bags in favour of one injected object.
 */
export interface RiskRule {
  readonly id: string;
  supports(input: RiskInput): boolean;
  evaluate(input: RiskInput): RiskRuleEvaluation;
}

export interface RiskMetadata {
  readonly engineVersion: string;
  /** Wall-clock cost, via injected `performanceNow`. Informational only. */
  readonly evaluationTimeMs: number;
}

/**
 * Final, immutable risk verdict. Deep-frozen by the engine before
 * being returned.
 */
export interface RiskEvaluation {
  readonly approved: boolean;
  /** Aggregated risk score in `[0, 100]`. 0 = no risk, 100 = maximum. */
  readonly riskScore: number;
  readonly warnings: readonly RiskWarning[];
  readonly blockers: readonly RiskBlocker[];
  readonly metadata: RiskMetadata;
}

/**
 * Internal per-rule outcome. Not part of `RiskEvaluation` — exposed
 * on the engine class for tests / diagnostics only if ever needed.
 */
export interface RiskRuleOutcome {
  readonly ruleId: string;
  readonly evaluation: RiskRuleEvaluation;
}
