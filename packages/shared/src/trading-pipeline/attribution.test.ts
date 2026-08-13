import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DecisionEngine } from "../decision-engine/evaluator.js";
import type { DecisionResult } from "../decision-engine/types.js";
import { ExecutionTicketBuilder } from "../execution-ticket/builder.js";
import { RiskEngine } from "../risk-engine/evaluator.js";
import type { RiskEvaluation } from "../risk-engine/types.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import { SignalEngine } from "../signal-engine/evaluator.js";
import type { ExecutionTicketPolicy } from "../execution-ticket/types.js";

import { buildSnapshot } from "../decision-engine/snapshot.testfixture.js";
import { buildInstrument } from "../risk-engine/risk-input.testfixture.js";
import { TradingPipeline } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// PR15.4 §14.2 — full TradingPipeline attribution integration
// ---------------------------------------------------------------------------

class LongRule {
  readonly id = "long-fixture";
  readonly category = "TECHNICAL" as const;
  supports() {
    return true;
  }
  evaluate() {
    return {
      scoreContribution: 60,
      reasons: [
        {
          id: "long-fixture",
          category: "TECHNICAL" as const,
          weight: 1,
          direction: "BULLISH" as const,
          message: "test forces LONG",
        },
      ],
      warnings: [],
      blockers: [],
    };
  }
}

function policyFixture(): ExecutionTicketPolicy {
  return {
    quantity: 1,
    orderType: "LMT",
    timeInForce: "DAY",
    outsideRth: false,
    transmit: true,
    priceTickSize: 0.25,
    priceRoundingMode: "nearest",
  };
}

describe("TradingPipeline — PR15.4 attribution integration", () => {
  function buildPipeline(recordRisk: () => void) {
    const decisionEngine = new DecisionEngine({ rules: [new LongRule()] });
    const realRisk = new RiskEngine({ rules: [] });
    const spiedRisk = {
      evaluate: (
        d: DecisionResult,
        s: MarketContextSnapshot,
        i: Instrument,
      ): RiskEvaluation => {
        recordRisk();
        return realRisk.evaluate(d, s, i);
      },
    } as unknown as RiskEngine;
    const instrument = buildInstrument();
    const signalEngine = new SignalEngine({
      decisionEngine,
      riskEngine: spiedRisk,
      instrumentResolver: () => instrument,
    });
    const ticketBuilder = new ExecutionTicketBuilder({
      idFactory: () => "t",
      correlationIdFactory: () => "c",
    });
    return {
      pipeline: new TradingPipeline({ signalEngine, ticketBuilder }),
      instrument,
    };
  }

  it("direction mismatch → ATTRIBUTION failure, Risk NOT called", () => {
    let riskCalls = 0;
    const { pipeline, instrument } = buildPipeline(() => {
      riskCalls += 1;
    });
    const result = pipeline.run(buildSnapshot(), instrument, policyFixture(), {
      strategyId: "test_v1",
      intendedAction: "SHORT",
    });
    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "ATTRIBUTION");
    assert.equal(riskCalls, 0);
    assert.equal(result.signal?.blockers.length, 1);
    assert.equal(
      result.signal?.blockers[0].code,
      "STRATEGY_DIRECTION_UNCONFIRMED",
    );
    assert.equal(result.signal?.blockers[0].source, "attribution");
    assert.equal(result.signal?.metadata.strategyId, "test_v1");
  });

  it("direction match → metadata.strategyId set on signal, Risk called (pipeline reaches signal stage cleanly)", () => {
    let riskCalls = 0;
    const { pipeline, instrument } = buildPipeline(() => {
      riskCalls += 1;
    });
    const result = pipeline.run(buildSnapshot(), instrument, policyFixture(), {
      strategyId: "test_v1",
      intendedAction: "LONG",
    });
    // The direction gate has already been proven above. Here we only
    // assert that with matching direction, the signal stage runs
    // through Risk and metadata.strategyId is stamped — regardless
    // of downstream ticket outcome (which depends on the snapshot
    // fixture and is not the subject of this test).
    assert.equal(riskCalls, 1);
    if (result.outcome === "SUCCESS") {
      assert.equal(result.signal.metadata.strategyId, "test_v1");
    } else if (result.outcome === "FAILURE" && result.signal) {
      assert.equal(result.signal.metadata.strategyId, "test_v1");
    }
  });
});
