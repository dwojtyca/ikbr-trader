import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSnapshot, sampleCalendarEvent } from "../decision-engine/snapshot.testfixture.js";
import { RISK_ENGINE_VERSION, RiskEngine } from "./evaluator.js";
import {
  BrokerEnvironmentRule,
  DecisionConfidenceRule,
  HighImpactEventRule,
  InstrumentExecutionRule,
  MarketFreshnessRule,
  OvernightRule,
} from "./rules.js";
import { buildDecision, buildInstrument } from "./risk-input.testfixture.js";
import type {
  RiskBlocker,
  RiskEvaluation,
  RiskInput,
  RiskRule,
  RiskRuleEvaluation,
  RiskWarning,
} from "./types.js";

// ---------------------------------------------------------------------------
// Local rule fixtures
// ---------------------------------------------------------------------------

class ScoreRule implements RiskRule {
  readonly id: string;
  readonly #contribution: number;
  constructor(id: string, contribution: number) {
    this.id = id;
    this.#contribution = contribution;
  }
  supports(): boolean {
    return true;
  }
  evaluate(): RiskRuleEvaluation {
    return {
      scoreContribution: this.#contribution,
      warnings: [],
      blockers: [],
    };
  }
}

class BlockerRule implements RiskRule {
  readonly id: string;
  readonly #blocker: RiskBlocker;
  readonly #contribution: number;
  constructor(id: string, blocker: RiskBlocker, contribution = 0) {
    this.id = id;
    this.#blocker = { ...blocker, ruleId: id };
    this.#contribution = contribution;
  }
  supports(): boolean {
    return true;
  }
  evaluate(): RiskRuleEvaluation {
    return {
      scoreContribution: this.#contribution,
      warnings: [],
      blockers: [this.#blocker],
    };
  }
}

class ThrowingRule implements RiskRule {
  readonly id = "throwing";
  supports(): boolean {
    return true;
  }
  evaluate(): RiskRuleEvaluation {
    throw new Error("boom");
  }
}

class SkippedRule implements RiskRule {
  readonly id = "skipped";
  supports(): boolean {
    return false;
  }
  evaluate(): RiskRuleEvaluation {
    throw new Error("must not run");
  }
}

function makeEngine(
  rules: readonly RiskRule[],
  overrides: Partial<{
    highRiskScoreThreshold: number;
  }> = {},
): RiskEngine {
  let tick = 0;
  return new RiskEngine({
    rules,
    highRiskScoreThreshold: overrides.highRiskScoreThreshold,
    performanceNow: () => (tick += 1),
  });
}

function healthyInputs(): {
  decision: ReturnType<typeof buildDecision>;
  snapshot: ReturnType<typeof buildSnapshot>;
  instrument: ReturnType<typeof buildInstrument>;
} {
  return {
    decision: buildDecision({ confidence: 80 }),
    snapshot: buildSnapshot({
      overallStatus: "fresh",
      brokerState: {
        kind: "present",
        data: { accountEnvironment: "paper", openOrders: [] },
      },
    }),
    instrument: buildInstrument(),
  };
}

function callEvaluate(engine: RiskEngine, inputs: RiskInput): RiskEvaluation {
  return engine.evaluate(inputs.decision, inputs.snapshot, inputs.instrument);
}

// ---------------------------------------------------------------------------
// Approval / rejection
// ---------------------------------------------------------------------------

describe("RiskEngine — approval / rejection", () => {
  it("approves when no rules fire", () => {
    const engine = makeEngine([]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.approved, true);
    assert.equal(result.riskScore, 0);
    assert.equal(result.blockers.length, 0);
  });

  it("approves a healthy setup with a low-risk score", () => {
    const engine = makeEngine([new ScoreRule("mild", 10)]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.approved, true);
    assert.equal(result.riskScore, 10);
  });

  it("rejects when any rule raises a blocker", () => {
    const engine = makeEngine([
      new BlockerRule(
        "b",
        { code: "STALE_SNAPSHOT", message: "stale" },
        20,
      ),
    ]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.approved, false);
    assert.equal(result.blockers[0].code, "STALE_SNAPSHOT");
  });

  it("rejects and attaches HIGH_RISK_SCORE when score alone exceeds threshold", () => {
    const engine = makeEngine(
      [new ScoreRule("a", 60), new ScoreRule("b", 20)],
      { highRiskScoreThreshold: 70 },
    );
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.approved, false);
    assert.equal(result.riskScore, 80);
    const high = result.blockers.find((b) => b.code === "HIGH_RISK_SCORE");
    assert.ok(high);
  });

  it("does not double-attach HIGH_RISK_SCORE if a rule already raised it", () => {
    const engine = makeEngine(
      [
        new ScoreRule("a", 90),
        new BlockerRule(
          "explicit",
          { code: "HIGH_RISK_SCORE", message: "already" },
          0,
        ),
      ],
      { highRiskScoreThreshold: 50 },
    );
    const result = callEvaluate(engine, healthyInputs());
    const highs = result.blockers.filter((b) => b.code === "HIGH_RISK_SCORE");
    assert.equal(highs.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Real rules
// ---------------------------------------------------------------------------

describe("RiskEngine — real rules", () => {
  it("propagates LOW_CONFIDENCE from DecisionConfidenceRule", () => {
    const engine = makeEngine([
      new DecisionConfidenceRule({ minConfidence: 50 }),
    ]);
    const inputs = healthyInputs();
    inputs.decision = buildDecision({ confidence: 20 });
    const result = callEvaluate(engine, inputs);
    assert.equal(result.approved, false);
    assert.equal(result.blockers[0].code, "LOW_CONFIDENCE");
  });

  it("propagates STALE_SNAPSHOT from MarketFreshnessRule", () => {
    const engine = makeEngine([new MarketFreshnessRule()]);
    const inputs = healthyInputs();
    inputs.snapshot = buildSnapshot({ overallStatus: "stale" });
    const result = callEvaluate(engine, inputs);
    assert.equal(result.blockers[0].code, "STALE_SNAPSHOT");
  });

  it("propagates UNAVAILABLE_SNAPSHOT from MarketFreshnessRule", () => {
    const engine = makeEngine([new MarketFreshnessRule()]);
    const inputs = healthyInputs();
    inputs.snapshot = buildSnapshot({ overallStatus: "unavailable" });
    const result = callEvaluate(engine, inputs);
    assert.equal(result.blockers[0].code, "UNAVAILABLE_SNAPSHOT");
  });

  it("propagates INSTRUMENT_DISABLED from InstrumentExecutionRule", () => {
    const engine = makeEngine([new InstrumentExecutionRule()]);
    const inputs = healthyInputs();
    inputs.instrument = buildInstrument({ executionEnabled: false });
    const result = callEvaluate(engine, inputs);
    assert.equal(result.blockers[0].code, "INSTRUMENT_DISABLED");
  });

  it("propagates OVERNIGHT_NOT_ALLOWED from OvernightRule when out of session", () => {
    const engine = makeEngine([new OvernightRule({ isInSession: () => false })]);
    const inputs = healthyInputs();
    inputs.instrument = buildInstrument({ allowOvernight: false });
    const result = callEvaluate(engine, inputs);
    assert.equal(result.blockers[0].code, "OVERNIGHT_NOT_ALLOWED");
  });

  it("propagates BROKER_ENVIRONMENT_MISMATCH from BrokerEnvironmentRule", () => {
    const engine = makeEngine([
      new BrokerEnvironmentRule({ expectedEnvironment: "paper" }),
    ]);
    const inputs = healthyInputs();
    inputs.snapshot = buildSnapshot({
      brokerState: {
        kind: "present",
        data: { accountEnvironment: "live", openOrders: [] },
      },
    });
    const result = callEvaluate(engine, inputs);
    assert.equal(result.blockers[0].code, "BROKER_ENVIRONMENT_MISMATCH");
  });

  it("propagates HIGH_IMPACT_EVENT from HighImpactEventRule", () => {
    const engine = makeEngine([
      new HighImpactEventRule({ thresholdMs: 60 * 60_000 }),
    ]);
    const inputs = healthyInputs();
    inputs.snapshot = buildSnapshot({
      calendar: {
        kind: "present",
        data: {
          upcomingEvents: [],
          nextHighImpactEvent: sampleCalendarEvent(10),
        },
      },
    });
    const result = callEvaluate(engine, inputs);
    assert.equal(result.blockers[0].code, "HIGH_IMPACT_EVENT");
  });
});

// ---------------------------------------------------------------------------
// Aggregation / bookkeeping
// ---------------------------------------------------------------------------

describe("RiskEngine — aggregation", () => {
  it("accumulates multiple blockers in registration order", () => {
    const engine = makeEngine([
      new BlockerRule("first", { code: "STALE_SNAPSHOT", message: "s" }, 30),
      new BlockerRule(
        "second",
        { code: "INSTRUMENT_DISABLED", message: "d" },
        100,
      ),
    ]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.approved, false);
    assert.deepEqual(
      result.blockers.map((b) => b.code),
      ["STALE_SNAPSHOT", "INSTRUMENT_DISABLED", "HIGH_RISK_SCORE"],
    );
  });

  it("clamps riskScore at 100", () => {
    const engine = makeEngine([
      new ScoreRule("a", 80),
      new ScoreRule("b", 80),
    ]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.riskScore, 100);
  });

  it("clamps riskScore at 0 (negative contributions are floored)", () => {
    const engine = makeEngine([new ScoreRule("a", -50)]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.riskScore, 0);
  });

  it("ignores non-finite scoreContributions defensively", () => {
    const engine = makeEngine([
      new ScoreRule("ok", 30),
      new ScoreRule("nan", Number.NaN),
      new ScoreRule("inf", Number.POSITIVE_INFINITY),
    ]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.riskScore, 30);
  });

  it("skips rules where supports() returns false", () => {
    const engine = makeEngine([new SkippedRule(), new ScoreRule("run", 10)]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.riskScore, 10);
    assert.equal(result.approved, true);
  });

  it("isolates rule exceptions into UNKNOWN blocker + warning", () => {
    const engine = makeEngine([new ScoreRule("ok", 20), new ThrowingRule()]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.approved, false);
    const unknown = result.blockers.find((b) => b.code === "UNKNOWN");
    assert.ok(unknown, "expected UNKNOWN blocker");
    assert.match(unknown!.message, /throwing.*boom/);
    // Engine-level warning is duplicated at the engine layer AND in
    // the outcome — verify both survive into result.warnings.
    const relatedWarnings = result.warnings.filter((w) =>
      /throwing.*boom/.test(w.message),
    );
    assert.ok(relatedWarnings.length >= 1);
  });

  it("populates metadata with a deterministic evaluationTimeMs", () => {
    const engine = makeEngine([new ScoreRule("a", 10)]);
    const result = callEvaluate(engine, healthyInputs());
    assert.equal(result.metadata.engineVersion, RISK_ENGINE_VERSION);
    // Injected tick returns 1, 2, 3, … → delta = 1.
    assert.equal(result.metadata.evaluationTimeMs, 1);
  });

  it("falls back to performance.now() when no performanceNow is injected", () => {
    const engine = new RiskEngine({ rules: [new ScoreRule("a", 10)] });
    const result = callEvaluate(engine, healthyInputs());
    assert.ok(
      result.metadata.evaluationTimeMs >= 0,
      `got ${result.metadata.evaluationTimeMs}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

describe("RiskEngine — deep freeze", () => {
  function build(): RiskEvaluation {
    const engine = makeEngine([
      new ScoreRule("a", 20),
      new BlockerRule("b", { code: "STALE_SNAPSHOT", message: "x" }),
    ]);
    return callEvaluate(engine, healthyInputs());
  }

  it("freezes the top-level evaluation", () => {
    const result = build();
    assert.equal(Object.isFrozen(result), true);
    assert.throws(() => {
      (result as { approved: boolean }).approved = true;
    });
  });

  it("freezes arrays and their elements", () => {
    const result = build();
    assert.equal(Object.isFrozen(result.warnings), true);
    assert.equal(Object.isFrozen(result.blockers), true);
    assert.throws(() => {
      (result.blockers as RiskBlocker[]).push({
        code: "UNKNOWN",
        message: "x",
      });
    });
    if (result.blockers.length > 0) {
      assert.equal(Object.isFrozen(result.blockers[0]), true);
    }
  });

  it("freezes metadata", () => {
    const result = build();
    assert.equal(Object.isFrozen(result.metadata), true);
    assert.throws(() => {
      (result.metadata as { engineVersion: string }).engineVersion = "x";
    });
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe("RiskEngine — construction", () => {
  it("throws when rules is not provided", () => {
    assert.throws(
      () =>
        new RiskEngine({
          rules: undefined as unknown as readonly RiskRule[],
        }),
      /rules is required/,
    );
  });
});

// touch RiskWarning to keep type surface exercised
const _w: RiskWarning = { code: "x", message: "y" };
void _w;
