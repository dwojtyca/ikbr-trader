import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStrategies } from "@ikbr/signal-engine/strategies/strategy-registry";
import {
  ResearchEsMomentumBreakoutLongStrategy,
  createResearchEsStrategies,
} from "./research-es-strategy.js";

describe("PR15.5D research-only strategy seam", () => {
  it("keeps FUT out of the production registry", () => {
    const production = createStrategies(["momentum_breakout_long_v1"]);
    assert.equal(production.length, 1);
    assert.deepEqual(production[0].secTypes, ["STK", "IND"]);
    assert.equal(production[0] instanceof ResearchEsMomentumBreakoutLongStrategy, false);
  });

  it("creates only the dedicated FUT adapter", () => {
    const research = createResearchEsStrategies();
    assert.equal(research.length, 1);
    assert.ok(research[0] instanceof ResearchEsMomentumBreakoutLongStrategy);
    assert.deepEqual((research[0] as ResearchEsMomentumBreakoutLongStrategy).secTypes, ["FUT"]);
  });
});
