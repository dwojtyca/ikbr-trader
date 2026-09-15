import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findStrategyProfile,
  listAllStrategyProfiles,
  SMALL_CAP_UNIVERSE,
} from "./strategy-profiles.js";

describe("strategy profiles — PR15.5A compatibility correction", () => {
  it("narrows both enabled momentum profiles to their implemented secTypes", () => {
    for (const id of [
      "momentum_breakout_long_v1",
      "momentum_breakdown_short_v1",
    ]) {
      const profile = findStrategyProfile(id);
      assert.ok(profile, `missing profile: ${id}`);
      assert.deepEqual(profile.secType, ["STK", "IND"]);
      assert.equal(profile.enabledInBot, true);
    }
  });

  it("preserves every behavior-bearing field of the remaining profiles", () => {
    assert.deepEqual(
      listAllStrategyProfiles().map((profile) => profile.id),
      [
        "momentum_breakout_long_v1",
        "momentum_breakdown_short_v1",
        "range_reversal_v1",
        "gap_fade_short_v1",
        "trend_following_long_v1",
        "smallcap_donchian_breakout_long_v1",
        "smallcap_donchian_breakdown_short_v1",
      ],
    );

    const expected = [
      {
        id: "range_reversal_v1",
        secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
        directionalRegimes: ["range"],
        volatilityRegimes: ["normal_volatility", "high_volatility"],
        style: "reversion",
        enabledInBot: false,
        entryScore: 0.4,
        decisionEdge: 0.08,
        minConfidenceMultiplier: 1,
        quantityFactor: 0.5,
        spreadFactor: 0.85,
        requireVolume: true,
        earlyExitEnabled: undefined,
        excludedSymbols: undefined,
        includedSymbols: undefined,
      },
      {
        id: "gap_fade_short_v1",
        secType: ["STK", "IND", "ETF"],
        directionalRegimes: ["range", "bear_trend"],
        volatilityRegimes: ["normal_volatility", "high_volatility"],
        style: "reversion",
        enabledInBot: true,
        entryScore: 0.5,
        decisionEdge: 0.08,
        minConfidenceMultiplier: 1.1,
        quantityFactor: 1,
        spreadFactor: 1,
        requireVolume: true,
        earlyExitEnabled: undefined,
        excludedSymbols: SMALL_CAP_UNIVERSE,
        includedSymbols: undefined,
      },
      {
        id: "trend_following_long_v1",
        secType: ["STK", "IND"],
        directionalRegimes: ["bull_trend"],
        volatilityRegimes: ["normal_volatility", "high_volatility"],
        style: "trend",
        enabledInBot: false,
        entryScore: 0.6,
        decisionEdge: 0.08,
        minConfidenceMultiplier: 1,
        quantityFactor: 1,
        spreadFactor: 1,
        requireVolume: true,
        earlyExitEnabled: undefined,
        excludedSymbols: undefined,
        includedSymbols: undefined,
      },
      {
        id: "smallcap_donchian_breakout_long_v1",
        secType: ["STK"],
        directionalRegimes: ["bull_trend"],
        volatilityRegimes: ["normal_volatility", "high_volatility"],
        style: "breakout",
        enabledInBot: true,
        entryScore: 0.5,
        decisionEdge: 0.08,
        minConfidenceMultiplier: 1,
        quantityFactor: 0.6,
        spreadFactor: 1.8,
        requireVolume: false,
        earlyExitEnabled: true,
        excludedSymbols: undefined,
        includedSymbols: SMALL_CAP_UNIVERSE,
      },
      {
        id: "smallcap_donchian_breakdown_short_v1",
        secType: ["STK"],
        directionalRegimes: ["bear_trend"],
        volatilityRegimes: ["normal_volatility", "high_volatility"],
        style: "breakout",
        enabledInBot: true,
        entryScore: 0.5,
        decisionEdge: 0.08,
        minConfidenceMultiplier: 1,
        quantityFactor: 0.5,
        spreadFactor: 1.8,
        requireVolume: false,
        earlyExitEnabled: true,
        excludedSymbols: undefined,
        includedSymbols: SMALL_CAP_UNIVERSE,
      },
    ] as const;

    for (const baseline of expected) {
      const profile = findStrategyProfile(baseline.id);
      assert.ok(profile, `missing profile: ${baseline.id}`);
      assert.deepEqual(profile.secType, baseline.secType);
      assert.deepEqual(profile.directionalRegimes, baseline.directionalRegimes);
      assert.deepEqual(profile.volatilityRegimes, baseline.volatilityRegimes);
      assert.equal(profile.style, baseline.style);
      assert.equal(profile.enabledInBot, baseline.enabledInBot);
      assert.equal(profile.entryScore, baseline.entryScore);
      assert.equal(profile.decisionEdge, baseline.decisionEdge);
      assert.equal(
        profile.minConfidenceMultiplier,
        baseline.minConfidenceMultiplier,
      );
      assert.equal(profile.quantityFactor, baseline.quantityFactor);
      assert.equal(profile.spreadFactor, baseline.spreadFactor);
      assert.equal(profile.requireVolume, baseline.requireVolume);
      assert.equal(profile.earlyExitEnabled, baseline.earlyExitEnabled);
      assert.deepEqual(profile.excludedSymbols, baseline.excludedSymbols);
      assert.deepEqual(profile.includedSymbols, baseline.includedSymbols);
    }
  });
});
