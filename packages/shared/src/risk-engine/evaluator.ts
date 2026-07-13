import type { DecisionResult } from "../decision-engine/types.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type {
  RiskBlocker,
  RiskEvaluation,
  RiskInput,
  RiskMetadata,
  RiskRule,
  RiskRuleOutcome,
  RiskWarning,
} from "./types.js";

export const RISK_ENGINE_VERSION = "0.1.0";

export interface RiskEngineOptions {
  readonly rules: readonly RiskRule[];
  /**
   * Above (or equal to) this aggregated score the trade is rejected
   * even in the absence of blockers. Default: 70.
   */
  readonly highRiskScoreThreshold?: number;
  /** Reported in `RiskMetadata`. Default `RISK_ENGINE_VERSION`. */
  readonly version?: string;
  /**
   * Monotonic clock used only for `metadata.evaluationTimeMs`.
   * Injectable so tests can produce deterministic durations. Default:
   * `() => performance.now()`.
   */
  readonly performanceNow?: () => number;
}

/**
 * Deterministic rule-based risk engine.
 *
 * Pipeline (single evaluate call):
 *   1. Filter rules by `supports(input)`.
 *   2. Run each `evaluate()` under try/catch — a throw is isolated
 *      into an `UNKNOWN` blocker + a warning.
 *   3. Aggregate risk score as `clamp(sum(scoreContribution), 0, 100)`.
 *   4. Approval:
 *        - any blocker → `approved = false`
 *        - `riskScore >= highRiskScoreThreshold` → `approved = false`
 *          and a synthetic `HIGH_RISK_SCORE` blocker is attached
 *   5. Deep-freeze the result (cycle-safe) and return.
 *
 * TODO(architecture): once a second risk consumer appears, split
 * this class into:
 *   - `RiskRuleRunner`     — rule invocation + error isolation,
 *   - `RiskAggregator`     — score + approval decision,
 *   - freeze utilities     — shared with `MarketContextBuilder` and
 *                            `DecisionEngine`.
 * Not done in this PR — no second consumer yet.
 */
export class RiskEngine {
  readonly #rules: readonly RiskRule[];
  readonly #highRiskScoreThreshold: number;
  readonly #version: string;
  readonly #performanceNow: () => number;

  constructor(options: RiskEngineOptions) {
    if (!options.rules) {
      throw new Error("RiskEngine: rules is required");
    }
    this.#rules = [...options.rules];
    this.#highRiskScoreThreshold = options.highRiskScoreThreshold ?? 70;
    this.#version = options.version ?? RISK_ENGINE_VERSION;
    this.#performanceNow =
      options.performanceNow ?? (() => performance.now());
  }

  evaluate(
    decision: DecisionResult,
    snapshot: MarketContextSnapshot,
    instrument: Instrument,
  ): RiskEvaluation {
    const start = this.#performanceNow();
    const input: RiskInput = { decision, snapshot, instrument };

    const eligible = this.#rules.filter((rule) => rule.supports(input));
    const outcomes: RiskRuleOutcome[] = [];
    const engineWarnings: RiskWarning[] = [];

    for (const rule of eligible) {
      try {
        outcomes.push({
          ruleId: rule.id,
          evaluation: rule.evaluate(input),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const label = `rule "${rule.id}" threw: ${message}`;
        engineWarnings.push({
          code: "RULE_EXCEPTION",
          message: label,
          ruleId: rule.id,
        });
        outcomes.push({
          ruleId: rule.id,
          evaluation: {
            scoreContribution: 0,
            warnings: [
              { code: "RULE_EXCEPTION", message: label, ruleId: rule.id },
            ],
            blockers: [
              { code: "UNKNOWN", message: label, ruleId: rule.id },
            ],
          },
        });
      }
    }

    const warnings: RiskWarning[] = [...engineWarnings];
    const blockers: RiskBlocker[] = [];
    let scoreSum = 0;
    for (const outcome of outcomes) {
      warnings.push(...outcome.evaluation.warnings);
      blockers.push(...outcome.evaluation.blockers);
      if (Number.isFinite(outcome.evaluation.scoreContribution)) {
        scoreSum += Math.max(0, outcome.evaluation.scoreContribution);
      }
    }

    const riskScore = clamp(Math.round(scoreSum), 0, 100);
    const scoreTooHigh = riskScore >= this.#highRiskScoreThreshold;

    if (scoreTooHigh && blockers.every((b) => b.code !== "HIGH_RISK_SCORE")) {
      blockers.push({
        code: "HIGH_RISK_SCORE",
        message: `risk score ${riskScore} at or above threshold ${this.#highRiskScoreThreshold}`,
      });
    }

    const approved = blockers.length === 0;

    const metadata: RiskMetadata = {
      engineVersion: this.#version,
      evaluationTimeMs: this.#performanceNow() - start,
    };

    const result: RiskEvaluation = {
      approved,
      riskScore,
      warnings,
      blockers,
      metadata,
    };
    return deepFreeze(result);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ---------------------------------------------------------------------------
// Cycle-safe deep freeze
// ---------------------------------------------------------------------------
// Duplicated from `market-context/builder.ts` and
// `decision-engine/evaluator.ts` on purpose — see the architectural
// TODO above for planned extraction into a shared utility.
function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child);
    }
    if (!Object.isFrozen(node)) {
      Object.freeze(node);
    }
  };
  walk(value);
  return value;
}
