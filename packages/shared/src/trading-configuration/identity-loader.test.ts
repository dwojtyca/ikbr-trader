import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseTradingConfiguration } from "./parser.js";
import { canonicalizeTradingConfiguration, computeTradingConfigurationHash, computeStrategyInstanceHash, decodeTradingConfigurationSnapshot, sha256 } from "./identity.js";
import { loadTradingConfiguration } from "./loader.js";
import { buildTradingConfigurationProjection } from "./projection.js";

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/valid-generic.json", import.meta.url), "utf8"));
function parse(input: unknown) { const result = parseTradingConfiguration(input); assert.equal(result.ok, true); if (!result.ok) throw Error("fixture"); return result.configuration; }
test("canonical identity ignores formatting, catalogue order and omitted defaults; snapshot decoder rejects tampering", () => {
  const raw = fixture(), configuration = parse(raw), hash = computeTradingConfigurationHash(configuration);
  raw.strategyInstances[0].parameters = { dailyReturn20MinPct: 8, h1Return4MinPct: 1, return60MinPct: .2 };
  for (const key of Object.keys(raw)) if (Array.isArray(raw[key])) raw[key].reverse();
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  assert.equal(computeTradingConfigurationHash(parse(JSON.stringify(reordered, null, 2))), hash);
  const canonical = canonicalizeTradingConfiguration(configuration);
  assert.equal(computeTradingConfigurationHash(decodeTradingConfigurationSnapshot(canonical, hash)), hash);
  const envelope = JSON.parse(canonical);
  envelope.configuration.strategyInstances[0].parameters.rsiMax = 99;
  const tampered = JSON.stringify(envelope);
  assert.throws(() => decodeTradingConfigurationSnapshot(tampered, sha256(tampered)), /SNAPSHOT_INVALID/);
  assert.throws(() => decodeTradingConfigurationSnapshot(canonical, "a".repeat(64)), /SNAPSHOT_INVALID/);
  delete envelope.configuration.strategyInstances[0].parameters.rsiMax;
  const missing = JSON.stringify(envelope);
  assert.throws(() => decodeTradingConfigurationSnapshot(missing, sha256(missing)), /SNAPSHOT_INVALID/);
});
test("policy, flag, revision and override changes alter identity without changing another instance", () => {
  const source = fixture(), original = parse(source), originalHash = computeTradingConfigurationHash(original);
  for (const mutate of [
    (v: typeof source) => { v.instruments[0].entryEnabled = false; },
    v => { v.riskPolicies[0].maxSpread = .2; },
    v => { v.strategyInstances[0].revision++; },
    v => { v.strategyInstances[0].parameters = { dailyReturn20MinPct: 9 }; },
  ]) {
    const changed = fixture(); mutate(changed); const resolved = parse(changed);
    assert.notEqual(computeTradingConfigurationHash(resolved), originalHash);
    assert.equal(computeStrategyInstanceHash(resolved.strategyInstances[1]), computeStrategyInstanceHash(original.strategyInstances[1]));
  }
  assert.equal(computeStrategyInstanceHash(original.strategyInstances[0]), computeStrategyInstanceHash({ ...original.strategyInstances[0], id: "renamed" }));
});
test("loader fails configured-file and conflicting authority before fallback; legacy defaults are explicit diagnostics", () => {
  const text = JSON.stringify(fixture()), hash = computeTradingConfigurationHash(parse(text));
  const env = { TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/config/trading.json", TRADING_CONFIG_EXPECTED_HASH: hash };
  let reads = 0;
  const readFile = () => { reads++; return text; };
  assert.equal(loadTradingConfiguration(env, { readFile }).mode, "bundle");
  for (const key of ["INSTRUMENT_BINDINGS_JSON", "WATCHLIST_SYMBOLS", "WATCHLIST_CONTRACT_OVERRIDES", "SIGNAL_PRICE_MULTIPLIER_OVERRIDES", "SIGNAL_FRACTIONAL_SYMBOLS", "TRADING_LOOP_INSTRUMENT_IDS", "GPW_PROFILE_ENABLED", "AAPL_PROFILE_ENABLED", "GPW_MOMENTUM_PROFILE"]) {
    const before = reads;
    assert.throws(() => loadTradingConfiguration({ ...env, [key]: "true" }, { readFile }), /AUTHORITY_CONFLICT/);
    assert.equal(reads, before);
  }
  assert.throws(() => loadTradingConfiguration({ ...env, TRADING_CONFIG_EXPECTED_HASH: "a".repeat(64) }, { readFile }), /HASH_MISMATCH/);
  assert.throws(() => loadTradingConfiguration(env, { readFile: () => { throw Error("secret file contents"); } }), error => error instanceof Error && error.message === "CONFIG_FILE_UNAVAILABLE");
  assert.throws(() => loadTradingConfiguration({ TRADING_CONFIG_PATH: "/configured" }, { readFile }), /AUTHORITY_CONFLICT/);
  assert.deepEqual(loadTradingConfiguration({}).diagnostics, ["LEGACY_CONFIGURATION_UNVERSIONED"]);
  assert.throws(() => loadTradingConfiguration({ TRADING_CONFIG_MIGRATION_PREPARE: "true" }), /DISABLED_WRITES/);
  assert.equal(loadTradingConfiguration({ TRADING_CONFIG_MIGRATION_PREPARE: "true", TRADING_ENABLED: "false" }).migrationPrepare, true);
});
test("all fixture instruments project monitoring with independent identities and unconditional PP4 blocker", () => {
  const projection = buildTradingConfigurationProjection(parse(fixture()));
  assert.equal(projection.authority.getBoundInstrument("xyz_nyse")?.brokerSymbol, "QZXP");
  assert.equal(projection.registry.listExecutionEnabled().length, 3);
  for (const row of projection.readiness) {
    assert.equal(row.entryReady, false);
    assert.ok(!row.reasons.includes("PP2_STRATEGY_RUNTIME_UNAVAILABLE"));
    assert.ok(row.reasons.includes("RESEARCH_PER_PROPOSAL_REQUIRED"));
    assert.equal(row.priceGrid.status, "unknown");
  }
  assert.ok(projection.readiness.find(row => row.instrumentId === "disabled_assignment")!.reasons.includes("STRATEGY_INSTANCE_DISABLED"));
});
