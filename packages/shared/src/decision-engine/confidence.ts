import type { MarketContextSnapshot } from "../market-context/types.js";
import type { OverallStatus } from "../market-context/types.js";
import { clamp } from "./score.js";
import type { RuleOutcome } from "./types.js";

export interface ConfidenceInputs {
  readonly outcomes: readonly RuleOutcome[];
  readonly snapshot: MarketContextSnapshot;
  /**
   * Number of rules the engine expects to see for full "coverage"
   * credit. Fewer rules → coverage < 1 → lower confidence.
   */
  readonly expectedRuleCount: number;
  /** Confidence penalty (points, 0..100) applied per raised blocker. */
  readonly blockerPenalty: number;
}

/**
 * Compute confidence in `[0, 100]`.
 *
 * The formula is intentionally simple and inspectable:
 *
 *   confidence = clamp(
 *     coverage * consistency * freshness * 100
 *       - blockersPenalty,
 *     0, 100
 *   )
 *
 *   coverage    = min(rules, expected) / expected
 *   consistency = |sum(contribution)| / sum(|contribution|)
 *                 (0 if no rule produced a signed contribution)
 *   freshness   = mapping over snapshot.overallStatus:
 *                   fresh → 1.0, partial → 0.7, stale → 0.3, unavailable → 0
 *   penalty     = min(100, blockers × blockerPenalty)
 *
 * Rationale:
 *   - `coverage` prevents a single rule from producing high
 *     confidence just by being alone.
 *   - `consistency` collapses to 0 when bullish and bearish
 *     contributions cancel — mixed signals do not warrant action.
 *   - `freshness` inherits the market-context grading rather than
 *     re-deriving it.
 *   - `blockersPenalty` is additive so that stacking blockers
 *     (e.g. stale + missing price) drives confidence to zero even if
 *     the rules agreed directionally on stale data.
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  const { outcomes, snapshot, expectedRuleCount, blockerPenalty } = inputs;

  const rulesRun = outcomes.length;
  const coverage =
    expectedRuleCount <= 0
      ? 1
      : clamp(rulesRun / expectedRuleCount, 0, 1);

  let signedSum = 0;
  let absSum = 0;
  for (const outcome of outcomes) {
    const value = outcome.evaluation.scoreContribution;
    if (!Number.isFinite(value)) continue;
    signedSum += value;
    absSum += Math.abs(value);
  }
  const consistency = absSum > 0 ? Math.abs(signedSum) / absSum : 0;

  const freshnessFactor = freshnessFactorFor(snapshot.overallStatus);

  let blockerCount = 0;
  for (const outcome of outcomes) {
    blockerCount += outcome.evaluation.blockers.length;
  }
  const penalty = Math.min(100, blockerCount * blockerPenalty);

  const base = coverage * consistency * freshnessFactor * 100;
  return clamp(Math.round(base - penalty), 0, 100);
}

function freshnessFactorFor(status: OverallStatus): number {
  switch (status) {
    case "fresh":
      return 1;
    case "partial":
      return 0.7;
    case "stale":
      return 0.3;
    case "unavailable":
      return 0;
  }
}
