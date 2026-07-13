import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeConfidence } from "./confidence.js";
import { buildSnapshot } from "./snapshot.testfixture.js";
import type {
  DecisionBlocker,
  DecisionCategory,
  RuleOutcome,
} from "./types.js";

function outcome(
  scoreContribution: number,
  options: {
    ruleId?: string;
    category?: DecisionCategory;
    blockers?: readonly DecisionBlocker[];
  } = {},
): RuleOutcome {
  return {
    ruleId: options.ruleId ?? "r",
    category: options.category ?? "TECHNICAL",
    evaluation: {
      scoreContribution,
      reasons: [],
      warnings: [],
      blockers: options.blockers ?? [],
    },
  };
}

describe("computeConfidence", () => {
  it("returns 0 when no rules produced a signed contribution", () => {
    const snapshot = buildSnapshot({ overallStatus: "fresh" });
    const value = computeConfidence({
      outcomes: [outcome(0), outcome(0)],
      snapshot,
      expectedRuleCount: 3,
      blockerPenalty: 25,
    });
    assert.equal(value, 0);
  });

  it("returns 100 for full coverage, full agreement, fresh snapshot, no blockers", () => {
    const snapshot = buildSnapshot({ overallStatus: "fresh" });
    const outcomes = [outcome(20), outcome(30), outcome(40)];
    const value = computeConfidence({
      outcomes,
      snapshot,
      expectedRuleCount: 3,
      blockerPenalty: 25,
    });
    assert.equal(value, 100);
  });

  it("penalises conflicting rules (consistency < 1)", () => {
    const snapshot = buildSnapshot({ overallStatus: "fresh" });
    // sum = 0, absSum = 40 → consistency = 0.
    const value = computeConfidence({
      outcomes: [outcome(20), outcome(-20)],
      snapshot,
      expectedRuleCount: 2,
      blockerPenalty: 25,
    });
    assert.equal(value, 0);
  });

  it("penalises partial consistency proportionally", () => {
    const snapshot = buildSnapshot({ overallStatus: "fresh" });
    // sum = 20, absSum = 60 → consistency = 1/3 → base ≈ 33.
    const value = computeConfidence({
      outcomes: [outcome(40), outcome(-20)],
      snapshot,
      expectedRuleCount: 2,
      blockerPenalty: 25,
    });
    assert.equal(value, 33);
  });

  it("penalises low coverage (fewer rules than expected)", () => {
    const snapshot = buildSnapshot({ overallStatus: "fresh" });
    // 1 of 4 expected → coverage 0.25 → base = 25.
    const value = computeConfidence({
      outcomes: [outcome(20)],
      snapshot,
      expectedRuleCount: 4,
      blockerPenalty: 25,
    });
    assert.equal(value, 25);
  });

  it("penalises stale snapshot (freshness factor 0.3)", () => {
    const snapshot = buildSnapshot({ overallStatus: "stale" });
    // consistent, full coverage → base = 100 × 0.3 = 30.
    const value = computeConfidence({
      outcomes: [outcome(20), outcome(30)],
      snapshot,
      expectedRuleCount: 2,
      blockerPenalty: 25,
    });
    assert.equal(value, 30);
  });

  it("collapses to 0 for an unavailable snapshot regardless of rule agreement", () => {
    const snapshot = buildSnapshot({ overallStatus: "unavailable" });
    const value = computeConfidence({
      outcomes: [outcome(50), outcome(50)],
      snapshot,
      expectedRuleCount: 2,
      blockerPenalty: 25,
    });
    assert.equal(value, 0);
  });

  it("subtracts blockerPenalty per blocker", () => {
    const snapshot = buildSnapshot({ overallStatus: "fresh" });
    const blocker: DecisionBlocker = {
      code: "STALE_DATA",
      message: "x",
    };
    // base = 100, penalty = 25 → 75.
    const value = computeConfidence({
      outcomes: [
        outcome(30, { blockers: [blocker] }),
        outcome(30),
      ],
      snapshot,
      expectedRuleCount: 2,
      blockerPenalty: 25,
    });
    assert.equal(value, 75);
  });

  it("caps blocker penalty at 100 (never negative)", () => {
    const snapshot = buildSnapshot({ overallStatus: "fresh" });
    const blocker: DecisionBlocker = { code: "STALE_DATA", message: "x" };
    const many: RuleOutcome[] = [];
    for (let i = 0; i < 10; i += 1) {
      many.push(outcome(10, { ruleId: `r${i}`, blockers: [blocker] }));
    }
    const value = computeConfidence({
      outcomes: many,
      snapshot,
      expectedRuleCount: 10,
      blockerPenalty: 25,
    });
    assert.equal(value, 0);
  });
});
