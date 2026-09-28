import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTradingConfiguration, computeTradingConfigurationHash } from "@ikbr/shared/trading-config";
import { loadServiceTradingConfiguration } from "./trading-configuration-bootstrap.js";

const fixture = readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8");
const parsed = parseTradingConfiguration(fixture);
if (!parsed.ok) throw new Error("fixture invalid");
const bundleEnv = { TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixtures/trading.json",
  TRADING_CONFIG_EXPECTED_HASH: computeTradingConfigurationHash(parsed.configuration), RUNTIME_ENABLED: "false", LLM_AGENT_ENABLED: "false" };

test("production consumer loads generic bundle regardless of runtime flags", () => {
  const result = loadServiceTradingConfiguration(bundleEnv, { readFile: () => fixture });
  assert.equal(result.loaded.mode, "bundle");
  assert.equal(result.authority.getBoundInstrument("xyz_nyse")?.brokerSymbol, "QZXP");
  assert.equal(result.authority.getBoundInstrument("aapl_smart")?.instrument.primaryExchange, "NASDAQ");
  for (const instrument of result.registry.listAll()) {
    assert.equal(instrument.trading.executionEnabled, parsed.ok && parsed.configuration.instruments.find(row => row.id === instrument.id)!.entryEnabled);
    assert.equal(instrument.trading.signalGenerationEnabled, false);
    assert.equal(instrument.trading.aiAnalysisEnabled, false);
  }
});
test("production consumer cannot fall back after file, hash, or authority failure", () => {
  assert.throws(() => loadServiceTradingConfiguration(bundleEnv, { readFile: () => { throw new Error("not found"); } }), /CONFIG_FILE_UNAVAILABLE/);
  assert.throws(() => loadServiceTradingConfiguration({ ...bundleEnv, TRADING_CONFIG_EXPECTED_HASH: "0".repeat(64) }, { readFile: () => fixture }), /CONFIG_HASH_MISMATCH/);
  assert.throws(() => loadServiceTradingConfiguration({ ...bundleEnv, WATCHLIST_SYMBOLS: "AAPL" }, { readFile: () => fixture }), /CONFIG_AUTHORITY_CONFLICT/);
  assert.throws(() => loadServiceTradingConfiguration(bundleEnv, { readFile: () => "{}" }), /CONFIG_VALIDATION_FAILED/);
});
test("legacy still loads and validates shared bindings while runtime is disabled", () => {
  assert.equal(loadServiceTradingConfiguration({ RUNTIME_ENABLED: "false", LLM_AGENT_ENABLED: "false" }).loaded.mode, "legacy");
  assert.throws(() => loadServiceTradingConfiguration({ RUNTIME_ENABLED: "false", INSTRUMENT_BINDINGS_JSON: "invalid" }), /INSTRUMENT_BINDINGS_JSON_INVALID/);
});
