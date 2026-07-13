import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { MarketContextSnapshot } from "../market-context/types.js";
import {
  BrokerAvailabilityRule,
  FreshPriceRule,
  HighImpactCalendarRule,
  MissingPriceRule,
  NewsRiskRule,
} from "./rules.js";
import {
  buildSnapshot,
  FIXTURE_GENERATED_AT,
  FIXTURE_INSTRUMENT_ID,
  sampleBrokerData,
  sampleCalendarEvent,
  sampleNewsData,
  samplePriceData,
} from "./snapshot.testfixture.js";
import {
  DECISION_ENGINE_VERSION,
  DecisionEngine,
} from "./evaluator.js";
import type {
  DecisionBlocker,
  DecisionReason,
  DecisionResult,
  Rule,
  RuleEvaluation,
} from "./types.js";

// ---------------------------------------------------------------------------
// Local rule fixtures (isolate the evaluator from real rules where useful)
// ---------------------------------------------------------------------------

class ScoreRule implements Rule {
  readonly id: string;
  readonly category = "TECHNICAL" as const;
  readonly #contribution: number;
  readonly #direction: DecisionReason["direction"];

  constructor(id: string, contribution: number) {
    this.id = id;
    this.#contribution = contribution;
    this.#direction =
      contribution > 0 ? "BULLISH" : contribution < 0 ? "BEARISH" : "NEUTRAL";
  }
  supports(): boolean {
    return true;
  }
  evaluate(): RuleEvaluation {
    return {
      scoreContribution: this.#contribution,
      reasons: [
        {
          id: `${this.id}:reason`,
          category: this.category,
          weight: 0.5,
          direction: this.#direction,
          message: `${this.id} contribution ${this.#contribution}`,
        },
      ],
      warnings: [],
      blockers: [],
    };
  }
}

class BlockerRule implements Rule {
  readonly id: string;
  readonly category = "TECHNICAL" as const;
  readonly #blocker: DecisionBlocker;

  constructor(id: string, blocker: DecisionBlocker) {
    this.id = id;
    this.#blocker = { ...blocker, ruleId: id };
  }
  supports(): boolean {
    return true;
  }
  evaluate(): RuleEvaluation {
    return {
      scoreContribution: 0,
      reasons: [],
      warnings: [],
      blockers: [this.#blocker],
    };
  }
}

class ThrowingRule implements Rule {
  readonly id = "throwing";
  readonly category = "TECHNICAL" as const;
  supports(): boolean {
    return true;
  }
  evaluate(): RuleEvaluation {
    throw new Error("boom");
  }
}

class NonSupportingRule implements Rule {
  readonly id = "skipped";
  readonly category = "TECHNICAL" as const;
  supports(): boolean {
    return false;
  }
  evaluate(): RuleEvaluation {
    throw new Error("must not be called");
  }
}

function makeEngine(
  rules: readonly Rule[],
  overrides: Partial<{
    minConfidenceForAction: number;
    scoreThreshold: number;
    expectedRuleCount: number;
    blockerPenalty: number;
  }> = {},
): DecisionEngine {
  let counter = 0;
  // Deterministic monotonic clock: every call returns the previous
  // reading + 1ms, so evaluationTimeMs is exactly 1 regardless of
  // wall-clock jitter under CI load.
  let tick = 0;
  return new DecisionEngine({
    rules,
    now: () => FIXTURE_GENERATED_AT,
    idFactory: () => `decision-${(counter += 1)}`,
    performanceNow: () => (tick += 1),
    minConfidenceForAction: overrides.minConfidenceForAction,
    scoreThreshold: overrides.scoreThreshold,
    expectedRuleCount: overrides.expectedRuleCount,
    blockerPenalty: overrides.blockerPenalty,
  });
}

function healthySnapshot(): MarketContextSnapshot {
  return buildSnapshot({
    overallStatus: "fresh",
    price: { kind: "present", data: samplePriceData() },
    news: { kind: "present", data: sampleNewsData({ sentiment: "neutral" }) },
    brokerState: {
      kind: "present",
      data: sampleBrokerData({ buyingPower: 100_000 }),
    },
    calendar: {
      kind: "present",
      data: {
        upcomingEvents: [],
        nextHighImpactEvent: sampleCalendarEvent(240),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Action selection
// ---------------------------------------------------------------------------

describe("DecisionEngine — action selection", () => {
  it("returns LONG when score exceeds threshold and confidence passes", () => {
    const engine = makeEngine([
      new ScoreRule("a", 30),
      new ScoreRule("b", 20),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "LONG");
    assert.equal(result.overallScore, 50);
    assert.ok(result.confidence >= 25, `confidence ${result.confidence}`);
    assert.equal(result.blockedBy.length, 0);
  });

  it("returns SHORT when score is deeply negative", () => {
    const engine = makeEngine([
      new ScoreRule("a", -30),
      new ScoreRule("b", -20),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "SHORT");
    assert.equal(result.overallScore, -50);
  });

  it("returns HOLD when score is inside the deadband", () => {
    const engine = makeEngine([new ScoreRule("a", 5), new ScoreRule("b", -3)]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "HOLD");
    assert.equal(result.overallScore, 2);
  });

  it("returns HOLD (with pre-existing blocker) when any rule blocks", () => {
    const engine = makeEngine([
      new ScoreRule("bull", 50),
      new BlockerRule("stop", {
        code: "STALE_DATA",
        message: "stale",
      }),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "HOLD");
    assert.equal(result.blockedBy.length, 1);
    assert.equal(result.blockedBy[0].code, "STALE_DATA");
  });

  it("returns HOLD + INSUFFICIENT_CONFIDENCE when confidence is too low", () => {
    // Conflicting rules → consistency 0 → confidence 0.
    const engine = makeEngine([
      new ScoreRule("bull", 20),
      new ScoreRule("bear", -20),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "HOLD");
    assert.equal(result.confidence, 0);
    assert.equal(result.blockedBy.length, 1);
    assert.equal(result.blockedBy[0].code, "INSUFFICIENT_CONFIDENCE");
  });

  it("returns HOLD when the snapshot is stale (freshness factor 0.3)", () => {
    const stale = buildSnapshot({
      overallStatus: "stale",
      price: { kind: "present", data: samplePriceData() },
    });
    // 20 contribution, coverage 1, consistency 1, freshness 0.3 → confidence 30.
    // Above 25, so directional — but let's cross-check score threshold.
    const engine = makeEngine([new ScoreRule("a", 10)]);
    const result = engine.evaluate(stale);
    assert.equal(result.action, "HOLD"); // score 10 < 15 threshold.
    assert.equal(result.overallScore, 10);
  });
});

// ---------------------------------------------------------------------------
// Blocker propagation from real rules
// ---------------------------------------------------------------------------

describe("DecisionEngine — real rules", () => {
  it("propagates MISSING_PRICE from MissingPriceRule", () => {
    const engine = makeEngine([new MissingPriceRule()]);
    const snapshot = buildSnapshot({ price: { kind: "unavailable" } });
    const result = engine.evaluate(snapshot);
    assert.equal(result.action, "HOLD");
    assert.equal(result.blockedBy[0].code, "MISSING_PRICE");
  });

  it("propagates STALE_DATA from FreshPriceRule on stale price", () => {
    const engine = makeEngine([new FreshPriceRule()]);
    const snapshot = buildSnapshot({
      overallStatus: "stale",
      price: { kind: "present", status: "stale", data: samplePriceData() },
    });
    const result = engine.evaluate(snapshot);
    assert.equal(result.action, "HOLD");
    assert.equal(result.blockedBy[0].code, "STALE_DATA");
  });

  it("propagates HIGH_IMPACT_EVENT from HighImpactCalendarRule", () => {
    const engine = makeEngine([new HighImpactCalendarRule()]);
    const snapshot = buildSnapshot({
      calendar: {
        kind: "present",
        data: {
          upcomingEvents: [],
          nextHighImpactEvent: sampleCalendarEvent(10),
        },
      },
    });
    const result = engine.evaluate(snapshot);
    assert.equal(result.blockedBy[0].code, "HIGH_IMPACT_EVENT");
  });

  it("propagates BROKER_UNAVAILABLE from BrokerAvailabilityRule", () => {
    const engine = makeEngine([new BrokerAvailabilityRule()]);
    const snapshot = buildSnapshot({ brokerState: { kind: "unavailable" } });
    const result = engine.evaluate(snapshot);
    assert.equal(result.blockedBy[0].code, "BROKER_UNAVAILABLE");
  });

  it("routes news risk flags into a bearish score contribution", () => {
    const engine = makeEngine([new NewsRiskRule()], {
      // Force directional even from a lone rule.
      expectedRuleCount: 1,
      scoreThreshold: 15,
    });
    const snapshot = buildSnapshot({
      news: {
        kind: "present",
        data: sampleNewsData({ riskFlags: ["earnings"] }),
      },
    });
    const result = engine.evaluate(snapshot);
    assert.equal(result.overallScore, -20);
    assert.equal(result.action, "SHORT");
  });

  it("supports a MARKET_CLOSED blocker from a custom rule", () => {
    const engine = makeEngine([
      new BlockerRule("session-check", {
        code: "MARKET_CLOSED",
        message: "market closed",
      }),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "HOLD");
    assert.equal(result.blockedBy[0].code, "MARKET_CLOSED");
  });
});

// ---------------------------------------------------------------------------
// Aggregation / bookkeeping
// ---------------------------------------------------------------------------

describe("DecisionEngine — aggregation", () => {
  it("preserves rule ordering in reasons + blockedBy", () => {
    const engine = makeEngine([
      new ScoreRule("first", 5),
      new BlockerRule("second", {
        code: "STALE_DATA",
        message: "stale",
      }),
      new ScoreRule("third", 5),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.deepEqual(
      result.reasons.map((r) => r.id),
      ["first:reason", "third:reason"],
    );
    assert.equal(result.blockedBy[0].ruleId, "second");
  });

  it("returns HOLD with an empty rule set and no blockers", () => {
    const engine = makeEngine([]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "HOLD");
    assert.equal(result.overallScore, 0);
    assert.equal(result.confidence, 0);
    assert.equal(result.blockedBy[0].code, "INSUFFICIENT_CONFIDENCE");
    assert.equal(result.reasons.length, 0);
  });

  it("skips rules where supports() returns false", () => {
    const engine = makeEngine([
      new NonSupportingRule(),
      new ScoreRule("run", 20),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.reasons.length, 1);
    assert.equal(result.reasons[0].id, "run:reason");
  });

  it("isolates rule exceptions into an UNKNOWN blocker + warning", () => {
    const engine = makeEngine([
      new ScoreRule("ok", 20),
      new ThrowingRule(),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.action, "HOLD"); // blocker forces HOLD.
    const unknown = result.blockedBy.find((b) => b.code === "UNKNOWN");
    assert.ok(unknown, "expected UNKNOWN blocker");
    assert.match(unknown!.message, /throwing.*boom/);
    assert.ok(result.warnings.some((w) => /throwing.*boom/.test(w)));
  });

  it("aggregates multiple bullish contributions via addition + clamp", () => {
    const engine = makeEngine([
      new ScoreRule("a", 60),
      new ScoreRule("b", 60),
      new ScoreRule("c", 60),
    ]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.overallScore, 100);
    assert.equal(result.action, "LONG");
  });

  it("populates metadata with a deterministic evaluationTimeMs from the injected clock", () => {
    const engine = makeEngine([new ScoreRule("a", 20)]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.metadata.engineVersion, DECISION_ENGINE_VERSION);
    // Injected performanceNow returns 1, 2, 3, … → delta = 1.
    assert.equal(result.metadata.evaluationTimeMs, 1);
  });

  it("falls back to performance.now() when no performanceNow is injected", () => {
    // Sanity-check the default path — no fake clock here.
    const engine = new DecisionEngine({
      rules: [new ScoreRule("a", 20)],
      now: () => FIXTURE_GENERATED_AT,
      idFactory: () => "d-1",
    });
    const result = engine.evaluate(healthySnapshot());
    assert.ok(
      result.metadata.evaluationTimeMs >= 0,
      `got ${result.metadata.evaluationTimeMs}`,
    );
  });

  it("uses the injected clock and idFactory", () => {
    const engine = makeEngine([new ScoreRule("a", 20)]);
    const result = engine.evaluate(healthySnapshot());
    assert.equal(result.generatedAt.getTime(), FIXTURE_GENERATED_AT.getTime());
    assert.equal(result.decisionId, "decision-1");
    assert.equal(result.instrumentId, FIXTURE_INSTRUMENT_ID);
  });

  it("evaluateMany() returns one DecisionResult per snapshot", () => {
    const engine = makeEngine([new ScoreRule("a", 20)]);
    const results = engine.evaluateMany([
      healthySnapshot(),
      healthySnapshot(),
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0].decisionId, "decision-1");
    assert.equal(results[1].decisionId, "decision-2");
  });
});

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

describe("DecisionEngine — deep freeze", () => {
  function build(): DecisionResult {
    const engine = makeEngine([
      new ScoreRule("a", 20),
      new BlockerRule("b", {
        code: "STALE_DATA",
        message: "x",
      }),
    ]);
    return engine.evaluate(healthySnapshot());
  }

  it("freezes the top-level result", () => {
    const result = build();
    assert.equal(Object.isFrozen(result), true);
    assert.throws(() => {
      (result as { action: string }).action = "LONG";
    });
  });

  it("freezes reasons / warnings / blockedBy arrays", () => {
    const result = build();
    assert.equal(Object.isFrozen(result.reasons), true);
    assert.equal(Object.isFrozen(result.warnings), true);
    assert.equal(Object.isFrozen(result.blockedBy), true);
    assert.throws(() => {
      (result.blockedBy as DecisionBlocker[]).push({
        code: "UNKNOWN",
        message: "x",
      });
    });
  });

  it("freezes individual reasons and blockers", () => {
    const result = build();
    if (result.reasons.length > 0) {
      assert.equal(Object.isFrozen(result.reasons[0]), true);
      assert.throws(() => {
        (result.reasons[0] as DecisionReason).message = "mutated";
      });
    }
    assert.equal(Object.isFrozen(result.blockedBy[0]), true);
  });

  it("freezes metadata", () => {
    const result = build();
    assert.equal(Object.isFrozen(result.metadata), true);
    assert.throws(() => {
      (result.metadata as { engineVersion: string }).engineVersion = "0.0.0";
    });
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe("DecisionEngine — construction", () => {
  it("throws when rules is not provided", () => {
    assert.throws(
      () =>
        new DecisionEngine({
          rules: undefined as unknown as readonly Rule[],
        }),
      /rules is required/,
    );
  });
});
