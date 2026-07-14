import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TRADING_LOOP_INTERVAL_MIN_MS,
  buildTradingLoopConfig,
  tradingLoopSchema,
} from "./config.js";

describe("tradingLoopSchema — defaults", () => {
  it("empty env yields disabled loop with safe defaults", () => {
    const env = tradingLoopSchema.parse({});
    const cfg = buildTradingLoopConfig({ env });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.intervalMs, 30_000);
    assert.equal(cfg.startupDelayMs, 1_000);
    assert.equal(cfg.maxConcurrentInstruments, 2);
    assert.deepEqual(cfg.instrumentIds, []);
    assert.equal(cfg.shutdownTimeoutMs, 10_000);
    assert.equal(cfg.exposureTimeoutMs, 3_000);
  });

  it("interval below the safe minimum fails validation", () => {
    const parsed = tradingLoopSchema.safeParse({
      TRADING_LOOP_INTERVAL_MS: String(TRADING_LOOP_INTERVAL_MIN_MS - 1),
    });
    assert.equal(parsed.success, false);
  });

  it("max concurrency below 1 fails validation", () => {
    const parsed = tradingLoopSchema.safeParse({
      TRADING_LOOP_MAX_CONCURRENT_INSTRUMENTS: "0",
    });
    assert.equal(parsed.success, false);
  });
});

describe("buildTradingLoopConfig — boolean parsing", () => {
  for (const truthy of ["true", "TRUE", "True"]) {
    it(`enabled='${truthy}' → enabled: true`, () => {
      const env = tradingLoopSchema.parse({ TRADING_LOOP_ENABLED: truthy });
      assert.equal(buildTradingLoopConfig({ env }).enabled, true);
    });
  }
  for (const falsy of ["false", "0", "yes", ""]) {
    it(`enabled='${falsy}' → enabled: false (only literal 'true' enables)`, () => {
      const env = tradingLoopSchema.parse({ TRADING_LOOP_ENABLED: falsy });
      assert.equal(buildTradingLoopConfig({ env }).enabled, false);
    });
  }
});

describe("buildTradingLoopConfig — instrument id parsing", () => {
  it("empty CSV → empty scope override (registry is used)", () => {
    const env = tradingLoopSchema.parse({ TRADING_LOOP_INSTRUMENT_IDS: "" });
    assert.deepEqual(buildTradingLoopConfig({ env }).instrumentIds, []);
  });

  it("trims whitespace and de-duplicates", () => {
    const env = tradingLoopSchema.parse({
      TRADING_LOOP_INSTRUMENT_IDS: "  AAPL , MSFT ,AAPL,,   TSLA  ",
    });
    assert.deepEqual(
      buildTradingLoopConfig({ env }).instrumentIds,
      ["AAPL", "MSFT", "TSLA"],
    );
  });
});

describe("buildTradingLoopConfig — policyDefaults were removed in round 4", () => {
  it("config no longer exposes a global policyDefaults field", () => {
    const env = tradingLoopSchema.parse({});
    const cfg = buildTradingLoopConfig({ env });
    assert.equal(
      "policyDefaults" in (cfg as unknown as Record<string, unknown>),
      false,
    );
  });
});
