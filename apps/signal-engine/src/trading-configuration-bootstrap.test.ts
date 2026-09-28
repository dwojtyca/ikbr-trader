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
    assert.equal(instrument.trading.executionEnabled, false);
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

test("configured state requires explicit environment and exact matching account allowlist", async () => {
  const { parseConfiguredAccountScope } = await import("./trading-configuration-bootstrap.js");
  assert.deepEqual(parseConfiguredAccountScope({ IBKR_ACCOUNT_ID: "DU1", IB_SOCKET_PORT: "4002", ALLOWED_PAPER_ACCOUNTS: "DU1" }), { ok: false, reason: "PP2_ACCOUNT_ENVIRONMENT_UNAVAILABLE" });
  assert.deepEqual(parseConfiguredAccountScope({ IBKR_ENVIRONMENT: "paper", ALLOWED_PAPER_ACCOUNTS: "DU1" }), { ok: false, reason: "PP2_ACCOUNT_ID_UNAVAILABLE" });
  assert.deepEqual(parseConfiguredAccountScope({ IBKR_ENVIRONMENT: "paper", IBKR_ACCOUNT_ID: " DU1 ", ALLOWED_PAPER_ACCOUNTS: "DU1" }), { ok: false, reason: "PP2_ACCOUNT_ID_UNAVAILABLE" });
  assert.deepEqual(parseConfiguredAccountScope({ IBKR_ENVIRONMENT: "live", IBKR_ACCOUNT_ID: "DU1", ALLOWED_PAPER_ACCOUNTS: "DU1", ALLOWED_LIVE_ACCOUNTS: "U1" }), { ok: false, reason: "PP2_ACCOUNT_NOT_ALLOWED" });
  assert.deepEqual(parseConfiguredAccountScope({ IBKR_ENVIRONMENT: "paper", IBKR_ACCOUNT_ID: "DU2", ALLOWED_PAPER_ACCOUNTS: "DU1, DU2" }), { ok: true, accountId: "DU2", environment: "paper" });
  assert.deepEqual(parseConfiguredAccountScope({ IBKR_ENVIRONMENT: "live", IBKR_ACCOUNT_ID: "U1", ALLOWED_LIVE_ACCOUNTS: "U1" }), { ok: true, accountId: "U1", environment: "live" });
  assert.deepEqual(parseConfiguredAccountScope({ IBKR_ENVIRONMENT: "", IBKR_ACCOUNT_ID: "DU1", ALLOWED_PAPER_ACCOUNTS: "DU1" }), { ok: false, reason: "PP2_ACCOUNT_ENVIRONMENT_UNAVAILABLE" });
  assert.equal(loadServiceTradingConfiguration({}).configuredAccount, undefined);
});

test("actual diagnostic readiness ignores only the fixed entry-policy blocker", async () => {
  const { assertConfiguredEvaluationReady } = await import("./trading-configuration-bootstrap.js");
  const account = { ok: true as const, accountId: "DU1", environment: "paper" as const };
  await assertConfiguredEvaluationReady({ account, admission: async () => ({ reasons: ["PP3_EXECUTION_POLICY_UNAVAILABLE"] }) });
  for (const reason of ["CONFIG_DRIFT", "CONFIG_STORE_UNAVAILABLE", "CONFIG_MIGRATION_PREPARATION", "CONFIG_SERVICE_UNAVAILABLE", "PP4_RESEARCH_UNAVAILABLE"]) {
    await assert.rejects(assertConfiguredEvaluationReady({ account, admission: async () => ({ reasons: ["PP3_EXECUTION_POLICY_UNAVAILABLE", reason] }) }), new RegExp(reason));
  }
  let peerReads = 0;
  await assert.rejects(assertConfiguredEvaluationReady({ account: { ok: false, reason: "PP2_ACCOUNT_NOT_ALLOWED" }, admission: async () => { peerReads++; return { reasons: [] }; } }), /PP2_ACCOUNT_NOT_ALLOWED/);
  assert.equal(peerReads, 0);
});
