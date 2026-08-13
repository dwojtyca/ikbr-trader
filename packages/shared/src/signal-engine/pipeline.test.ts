import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { DecisionEngine } from "../decision-engine/evaluator.js";
import type { DecisionResult } from "../decision-engine/types.js";
import type { InstrumentResolver } from "./pipeline.js";
import { runSignalPipeline } from "./pipeline.js";
import type { RiskEngine } from "../risk-engine/evaluator.js";
import type { RiskEvaluation } from "../risk-engine/types.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";

// ---------------------------------------------------------------------------
// Minimal fixtures — no dependency on the larger snapshot fixture module.
// ---------------------------------------------------------------------------

function baseSnapshot(): MarketContextSnapshot {
  return {
    instrumentId: "test_i",
    generatedAt: new Date("2026-08-12T12:00:00Z"),
    validUntil: new Date("2026-08-12T12:01:00Z"),
    overallStatus: "fresh",
    warnings: [],
    sections: {} as unknown as MarketContextSnapshot["sections"],
  } as unknown as MarketContextSnapshot;
}

function fakeDecisionEngine(
  action: DecisionResult["action"],
  blocked = false,
): DecisionEngine {
  return {
    evaluate: () =>
      ({
        action,
        confidence: 80,
        overallScore: 60,
        blockedBy: blocked
          ? [{ code: "BLOCKED_TEST", message: "blocked" }]
          : [],
        signals: [],
        warnings: [],
        metadata: { engineVersion: "0.1.0", evaluationTimeMs: 1 },
      }) as unknown as DecisionResult,
  } as unknown as DecisionEngine;
}

interface RiskSpy {
  engine: RiskEngine;
  callCount: number;
}

function spyRiskEngine(): RiskSpy {
  const spy: RiskSpy = {
    callCount: 0,
    engine: undefined as unknown as RiskEngine,
  };
  spy.engine = {
    evaluate: () => {
      spy.callCount += 1;
      return {
        approved: true,
        riskScore: 10,
        warnings: [],
        blockers: [],
        metadata: { engineVersion: "0.1.0", evaluationTimeMs: 1 },
      } as RiskEvaluation;
    },
  } as unknown as RiskEngine;
  return spy;
}

const RESOLVER: InstrumentResolver = () =>
  ({ id: "test_i" }) as unknown as Instrument;

describe("runSignalPipeline — PR15.4 direction gate", () => {
  it("Decision LONG + intendedAction LONG → no blockers, Risk called once", () => {
    const risk = spyRiskEngine();
    const outcome = runSignalPipeline({
      snapshot: baseSnapshot(),
      decisionEngine: fakeDecisionEngine("LONG"),
      riskEngine: risk.engine,
      instrumentResolver: RESOLVER,
      attribution: { strategyId: "s1", intendedAction: "LONG" },
    });
    assert.deepEqual(outcome.signalBlockers, []);
    assert.equal(risk.callCount, 1);
  });

  it("Decision LONG + intendedAction SHORT → STRATEGY_DIRECTION_UNCONFIRMED, Risk NOT called", () => {
    const risk = spyRiskEngine();
    const outcome = runSignalPipeline({
      snapshot: baseSnapshot(),
      decisionEngine: fakeDecisionEngine("LONG"),
      riskEngine: risk.engine,
      instrumentResolver: RESOLVER,
      attribution: { strategyId: "s1", intendedAction: "SHORT" },
    });
    assert.equal(outcome.signalBlockers.length, 1);
    assert.equal(
      outcome.signalBlockers[0].code,
      "STRATEGY_DIRECTION_UNCONFIRMED",
    );
    assert.equal(outcome.signalBlockers[0].source, "attribution");
    assert.equal(outcome.riskSkipped, true);
    assert.equal(risk.callCount, 0);
  });

  it("Decision HOLD + attribution provided → no blockers, Risk skipped via HOLD path", () => {
    const risk = spyRiskEngine();
    const outcome = runSignalPipeline({
      snapshot: baseSnapshot(),
      decisionEngine: fakeDecisionEngine("HOLD"),
      riskEngine: risk.engine,
      instrumentResolver: RESOLVER,
      attribution: { strategyId: "s1", intendedAction: "LONG" },
    });
    assert.deepEqual(outcome.signalBlockers, []);
    assert.equal(outcome.riskSkipped, true);
    assert.equal(risk.callCount, 0);
  });

  it("Decision BLOCKED + attribution provided → no signalBlockers (decision blocker path), Risk skipped", () => {
    const risk = spyRiskEngine();
    const outcome = runSignalPipeline({
      snapshot: baseSnapshot(),
      decisionEngine: fakeDecisionEngine("LONG", true),
      riskEngine: risk.engine,
      instrumentResolver: RESOLVER,
      attribution: { strategyId: "s1", intendedAction: "LONG" },
    });
    assert.deepEqual(outcome.signalBlockers, []);
    assert.equal(outcome.riskSkipped, true);
    assert.equal(risk.callCount, 0);
  });

  it("No attribution provided → direction gate inactive", () => {
    const risk = spyRiskEngine();
    const outcome = runSignalPipeline({
      snapshot: baseSnapshot(),
      decisionEngine: fakeDecisionEngine("LONG"),
      riskEngine: risk.engine,
      instrumentResolver: RESOLVER,
    });
    assert.deepEqual(outcome.signalBlockers, []);
    assert.equal(risk.callCount, 1);
  });
});
