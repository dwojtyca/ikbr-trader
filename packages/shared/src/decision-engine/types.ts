/**
 * Decision Engine — type definitions.
 *
 * The Decision Engine is a **deterministic**, rule-based translator
 * from `MarketContextSnapshot` → `DecisionResult`. It contains no AI,
 * no I/O, no order submission and no dependency on the execution or
 * ingestion services. Its only inputs are a snapshot and a list of
 * `Rule`s; its only output is a deep-frozen `DecisionResult`.
 *
 * Boundaries:
 *   - Rules MUST be pure functions of the snapshot. No I/O, no side
 *     effects, no randomness.
 *   - Rules MUST NOT talk to execution-engine or place orders.
 *   - The engine MUST NOT throw for rule failures — a rule that
 *     throws is isolated, its outcome is skipped, and a warning is
 *     attached to the result.
 */

import type { MarketContextSnapshot } from "../market-context/types.js";

/** Terminal action the engine recommends. */
export type DecisionAction = "LONG" | "SHORT" | "HOLD";

/** Directional sign a reason contributes to the overall score. */
export type DecisionDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

/**
 * Domain a rule (and the reasons it emits) belongs to. Kept explicit
 * so downstream consumers can filter, weight or display reasons by
 * category without inspecting free-form strings.
 */
export type DecisionCategory =
  | "TECHNICAL"
  | "MACRO"
  | "POSITIONING"
  | "FLOW"
  | "NEWS"
  | "BROKER"
  | "RISK";

/**
 * Enumerated blocker codes. A blocker forces `action = "HOLD"`
 * regardless of the numeric score. `UNKNOWN` is a catch-all for
 * rule-level exceptions and other unclassified conditions.
 */
export type DecisionBlockerCode =
  | "STALE_DATA"
  | "MISSING_PRICE"
  | "MARKET_CLOSED"
  | "BROKER_UNAVAILABLE"
  | "HIGH_IMPACT_EVENT"
  | "INSUFFICIENT_CONFIDENCE"
  | "UNKNOWN";

export interface DecisionBlocker {
  readonly code: DecisionBlockerCode;
  readonly message: string;
  /** Id of the rule that raised the blocker, when applicable. */
  readonly ruleId?: string;
}

/**
 * Single directional argument, produced by a rule and carried into
 * the final result. `weight` and `direction` are metadata — the raw
 * numeric contribution to the score is expressed by
 * `RuleEvaluation.scoreContribution`, not by re-computing from
 * weight × direction. This keeps reasons interpretable (for humans
 * and future LLM prompting) without conflating them with math.
 */
export interface DecisionReason {
  readonly id: string;
  readonly category: DecisionCategory;
  /** Subjective importance in `[0, 1]`. */
  readonly weight: number;
  readonly direction: DecisionDirection;
  readonly message: string;
}

/**
 * A rule's per-snapshot output. Every field is optional in practice
 * — a rule that only raises a blocker can leave the rest empty.
 *
 * `scoreContribution` is the SIGNED contribution to the overall
 * score, in the same [-100, 100] band as `DecisionResult.overallScore`.
 * The aggregator sums and clamps, so a rule's contribution should be
 * sized to its intended influence (e.g. `+20` for a strong bullish
 * technical signal, `-40` for a heavy news risk).
 */
export interface RuleEvaluation {
  readonly scoreContribution: number;
  readonly reasons: readonly DecisionReason[];
  readonly warnings: readonly string[];
  readonly blockers: readonly DecisionBlocker[];
}

/**
 * Rule contract. A rule is a pure function of the snapshot; the
 * `supports()` gate lets a rule opt out of instruments it cannot
 * meaningfully evaluate (e.g. an equity-only rule against a future).
 *
 * TODO(async): `evaluate()` will become asynchronous
 * (`Promise<RuleEvaluation>`) once rules need to consult providers
 * that perform I/O (LLM enrichment, external risk services, cached
 * calendar lookups). At that point `DecisionEngine.evaluate()` will
 * also become async and rule execution will move behind a
 * `RuleRunner` with a per-rule timeout — mirroring what
 * `MarketContextBuilder` already does for providers. Not implemented
 * in this PR: every current rule is a pure snapshot inspector.
 *
 * TODO(context): `evaluate()` will gain a second argument
 * `context: RuleContext` carrying at least:
 *   - `config`         — per-rule tunables resolved by the engine,
 *   - `instrument`     — the resolved `Instrument` from the registry,
 *   - `clock`          — deterministic `now()` (today read from the snapshot),
 *   - `logger`         — structured logger scoped to `{ ruleId, decisionId }`,
 *   - `featureFlags`   — runtime feature toggles.
 * The `RuleContext` type and construction pipeline are deliberately
 * NOT introduced in this PR to avoid a breaking-change wave before
 * we have a concrete rule that needs any of these dependencies.
 */
export interface Rule {
  readonly id: string;
  readonly category: DecisionCategory;
  supports(snapshot: MarketContextSnapshot): boolean;
  evaluate(snapshot: MarketContextSnapshot): RuleEvaluation;
}

export interface DecisionMetadata {
  readonly engineVersion: string;
  /**
   * Wall-clock cost of the evaluation in milliseconds, measured via
   * `performance.now()`. Purely informational; not used by the
   * engine for any control-flow decision.
   */
  readonly evaluationTimeMs: number;
}

/**
 * Final, immutable decision. Deep-frozen by the engine before
 * returning — see `evaluator.ts`.
 */
export interface DecisionResult {
  readonly decisionId: string;
  readonly generatedAt: Date;
  readonly instrumentId: string;
  readonly action: DecisionAction;
  /** Confidence in `[0, 100]`. */
  readonly confidence: number;
  /** Net score in `[-100, 100]`. Positive = bullish, negative = bearish. */
  readonly overallScore: number;
  readonly reasons: readonly DecisionReason[];
  readonly warnings: readonly string[];
  readonly blockedBy: readonly DecisionBlocker[];
  readonly metadata: DecisionMetadata;
}

/**
 * Internal per-rule outcome, exposed on the engine only for testing
 * and diagnostics. Not part of `DecisionResult`.
 */
export interface RuleOutcome {
  readonly ruleId: string;
  readonly category: DecisionCategory;
  readonly evaluation: RuleEvaluation;
}
