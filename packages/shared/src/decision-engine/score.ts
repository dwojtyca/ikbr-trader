import type { RuleOutcome } from "./types.js";

/**
 * Overall score aggregator.
 *
 * Sums each rule's signed `scoreContribution` and clamps to
 * `[-100, 100]`. This is deliberately the simplest defensible
 * strategy: rules are expected to size their contribution to their
 * intended influence, and additive combination lets a strong
 * confluence dominate a lone dissenter without magic weighting.
 *
 * Design notes:
 *   - Empty input → `0` (neutral). Do NOT special-case this in
 *     callers; treat `0` uniformly.
 *   - `NaN` / non-finite contributions are dropped defensively so
 *     one buggy rule cannot poison the aggregate. A warning is the
 *     caller's responsibility (rules are meant to be tested).
 */
export function aggregateOverallScore(
  outcomes: readonly RuleOutcome[],
): number {
  let sum = 0;
  for (const outcome of outcomes) {
    const value = outcome.evaluation.scoreContribution;
    if (Number.isFinite(value)) {
      sum += value;
    }
  }
  return clamp(sum, -100, 100);
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
