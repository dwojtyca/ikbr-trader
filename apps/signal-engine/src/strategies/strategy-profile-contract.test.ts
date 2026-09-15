import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listStrategyProfiles } from "@ikbr/shared";

import { createStrategy } from "./strategy-registry.js";
import type { Strategy } from "./strategy.types.js";

describe("active strategy profile contracts — PR15.5A", () => {
  it("declares only secTypes supported by each concrete implementation", () => {
    const mismatches: string[] = [];

    for (const profile of listStrategyProfiles()) {
      let strategy: Strategy;
      try {
        strategy = createStrategy(profile.id);
      } catch (error) {
        mismatches.push(
          `${profile.id}: implementation unavailable (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }

      for (const secType of profile.secType) {
        if (!strategy.secTypes.includes(secType)) {
          mismatches.push(
            `${profile.id}: profile declares unsupported secType ${secType}; implementation supports ${strategy.secTypes.join(", ")}`,
          );
        }
      }
    }

    assert.equal(
      mismatches.length,
      0,
      `strategy profile contract mismatches:\n${mismatches.join("\n")}`,
    );
  });

  it("keeps both momentum profiles away from unverified asset classes", () => {
    const profiles = listStrategyProfiles();
    for (const id of [
      "momentum_breakout_long_v1",
      "momentum_breakdown_short_v1",
    ]) {
      const profile = profiles.find((candidate) => candidate.id === id);
      assert.ok(profile, `missing active profile: ${id}`);
      assert.deepEqual(profile.secType, ["STK", "IND"]);
      for (const unsupported of ["ETF", "CMDTY", "FUT"] as const) {
        assert.equal(profile.secType.includes(unsupported), false);
      }
    }
  });
});
