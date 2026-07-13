import type { MarketContextSnapshot } from "../market-context/types.js";
import { computeConfidence } from "./confidence.js";
import { aggregateOverallScore } from "./score.js";
import type {
  DecisionAction,
  DecisionBlocker,
  DecisionMetadata,
  DecisionReason,
  DecisionResult,
  Rule,
  RuleOutcome,
} from "./types.js";

export const DECISION_ENGINE_VERSION = "0.1.0";

export interface DecisionEngineOptions {
  readonly rules: readonly Rule[];
  /** Deterministic clock. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Deterministic id factory. Default `crypto.randomUUID`. */
  readonly idFactory?: () => string;
  /** Reported in `DecisionMetadata`. Default `DECISION_ENGINE_VERSION`. */
  readonly version?: string;
  /**
   * Below this confidence, the action is forced to `HOLD` and an
   * `INSUFFICIENT_CONFIDENCE` blocker is attached. Default: 25.
   */
  readonly minConfidenceForAction?: number;
  /**
   * Absolute score threshold to enter a directional action. Below
   * this, the action is `HOLD`. Default: 15.
   */
  readonly scoreThreshold?: number;
  /**
   * Number of rules the engine expects for "full coverage" in the
   * confidence formula. Default: number of registered rules (capped
   * to 1).
   */
  readonly expectedRuleCount?: number;
  /** Confidence penalty per blocker. Default: 25. */
  readonly blockerPenalty?: number;
  /**
   * Monotonic clock used only for `metadata.evaluationTimeMs`.
   * Injectable so tests can produce deterministic durations. Default:
   * `() => performance.now()`.
   */
  readonly performanceNow?: () => number;
}

/**
 * Deterministic rule-based decision engine.
 *
 * Pipeline (single evaluate call):
 *   1. Filter rules by `supports(snapshot)`.
 *   2. Run each `evaluate()` under try/catch — a throw is isolated
 *      into an `UNKNOWN` blocker and a warning.
 *   3. Aggregate score via `aggregateOverallScore`.
 *   4. Compute confidence via `computeConfidence`.
 *   5. Choose action:
 *        - any pre-existing blocker → HOLD
 *        - confidence < minConfidenceForAction → HOLD + INSUFFICIENT_CONFIDENCE
 *        - score >  +scoreThreshold → LONG
 *        - score <  -scoreThreshold → SHORT
 *        - else → HOLD
 *   6. Deep-freeze the result (cycle-safe) and return.
 *
 * TODO(architecture): once a second decision consumer appears, split
 * this class into:
 *   - `RuleRunner`         — rule invocation + error isolation
 *   - `DecisionAggregator` — score / confidence / action selection
 *   - freeze utilities     — shared with `MarketContextBuilder`.
 * Not done in this PR — no second consumer yet.
 */
export class DecisionEngine {
  readonly #rules: readonly Rule[];
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #version: string;
  readonly #minConfidence: number;
  readonly #scoreThreshold: number;
  readonly #expectedRuleCount: number;
  readonly #blockerPenalty: number;
  readonly #performanceNow: () => number;

  constructor(options: DecisionEngineOptions) {
    if (!options.rules) {
      throw new Error("DecisionEngine: rules is required");
    }
    this.#rules = [...options.rules];
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.#version = options.version ?? DECISION_ENGINE_VERSION;
    this.#minConfidence = options.minConfidenceForAction ?? 25;
    this.#scoreThreshold = options.scoreThreshold ?? 15;
    this.#expectedRuleCount = Math.max(
      1,
      options.expectedRuleCount ?? this.#rules.length,
    );
    this.#blockerPenalty = options.blockerPenalty ?? 25;
    this.#performanceNow =
      options.performanceNow ?? (() => performance.now());
  }

  evaluate(snapshot: MarketContextSnapshot): DecisionResult {
    const start = this.#performanceNow();
    const generatedAt = this.#now();

    const eligible = this.#rules.filter((rule) => rule.supports(snapshot));
    const outcomes: RuleOutcome[] = [];
    const engineWarnings: string[] = [];

    for (const rule of eligible) {
      try {
        const evaluation = rule.evaluate(snapshot);
        outcomes.push({
          ruleId: rule.id,
          category: rule.category,
          evaluation,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const warning = `rule "${rule.id}" threw: ${message}`;
        engineWarnings.push(warning);
        outcomes.push({
          ruleId: rule.id,
          category: rule.category,
          evaluation: {
            scoreContribution: 0,
            reasons: [],
            warnings: [warning],
            blockers: [
              {
                code: "UNKNOWN",
                message: warning,
                ruleId: rule.id,
              },
            ],
          },
        });
      }
    }

    const reasons: DecisionReason[] = [];
    const warnings: string[] = [...engineWarnings];
    const blockedBy: DecisionBlocker[] = [];
    for (const outcome of outcomes) {
      reasons.push(...outcome.evaluation.reasons);
      warnings.push(...outcome.evaluation.warnings);
      blockedBy.push(...outcome.evaluation.blockers);
    }

    const overallScore = aggregateOverallScore(outcomes);
    const confidence = computeConfidence({
      outcomes,
      snapshot,
      expectedRuleCount: this.#expectedRuleCount,
      blockerPenalty: this.#blockerPenalty,
    });

    const action = this.#chooseAction({
      overallScore,
      confidence,
      blockers: blockedBy,
    });
    if (
      action === "HOLD" &&
      blockedBy.length === 0 &&
      confidence < this.#minConfidence
    ) {
      blockedBy.push({
        code: "INSUFFICIENT_CONFIDENCE",
        message: `confidence ${confidence} below threshold ${this.#minConfidence}`,
      });
    }

    const metadata: DecisionMetadata = {
      engineVersion: this.#version,
      evaluationTimeMs: this.#performanceNow() - start,
    };

    const result: DecisionResult = {
      decisionId: this.#idFactory(),
      generatedAt,
      instrumentId: snapshot.instrumentId,
      action,
      confidence,
      overallScore,
      reasons,
      warnings,
      blockedBy,
      metadata,
    };
    return deepFreeze(result);
  }

  evaluateMany(
    snapshots: readonly MarketContextSnapshot[],
  ): readonly DecisionResult[] {
    return snapshots.map((snapshot) => this.evaluate(snapshot));
  }

  #chooseAction(inputs: {
    overallScore: number;
    confidence: number;
    blockers: readonly DecisionBlocker[];
  }): DecisionAction {
    if (inputs.blockers.length > 0) {
      return "HOLD";
    }
    if (inputs.confidence < this.#minConfidence) {
      return "HOLD";
    }
    if (inputs.overallScore > this.#scoreThreshold) {
      return "LONG";
    }
    if (inputs.overallScore < -this.#scoreThreshold) {
      return "SHORT";
    }
    return "HOLD";
  }
}

// ---------------------------------------------------------------------------
// Cycle-safe deep freeze
// ---------------------------------------------------------------------------
// Duplicated from `market-context/builder.ts` on purpose — the
// architectural TODO in that file already flags a shared freeze
// utility as future work. Keeping the duplication local for now
// avoids exporting a private helper across module boundaries just to
// share five lines.
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
