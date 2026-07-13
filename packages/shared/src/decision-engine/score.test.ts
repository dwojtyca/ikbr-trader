import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aggregateOverallScore } from "./score.js";
import type { RuleOutcome } from "./types.js";

function outcome(scoreContribution: number, ruleId = "r"): RuleOutcome {
  return {
    ruleId,
    category: "TECHNICAL",
    evaluation: {
      scoreContribution,
      reasons: [],
      warnings: [],
      blockers: [],
    },
  };
}

describe("aggregateOverallScore", () => {
  it("returns 0 for an empty list", () => {
    assert.equal(aggregateOverallScore([]), 0);
  });

  it("sums signed contributions", () => {
    assert.equal(
      aggregateOverallScore([outcome(20), outcome(-5), outcome(10)]),
      25,
    );
  });

  it("clamps at +100", () => {
    assert.equal(
      aggregateOverallScore([outcome(60), outcome(70), outcome(20)]),
      100,
    );
  });

  it("clamps at -100", () => {
    assert.equal(
      aggregateOverallScore([outcome(-60), outcome(-70), outcome(-20)]),
      -100,
    );
  });

  it("ignores non-finite contributions defensively", () => {
    assert.equal(
      aggregateOverallScore([outcome(20), outcome(Number.NaN), outcome(10)]),
      30,
    );
    assert.equal(
      aggregateOverallScore([
        outcome(20),
        outcome(Number.POSITIVE_INFINITY),
        outcome(10),
      ]),
      30,
    );
  });
});
