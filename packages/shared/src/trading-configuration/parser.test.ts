import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MOMENTUM_CONFIGURATION_DEFAULTS_V1 } from "./defaults.js";
import { parseTradingConfiguration } from "./parser.js";

const fixtureUrl = new URL("./fixtures/valid-generic.json", import.meta.url);
const fixtureText = readFileSync(fileURLToPath(fixtureUrl), "utf8");
const fixture = JSON.parse(fixtureText) as Record<string, any>;
const clone = (): Record<string, any> => JSON.parse(fixtureText) as Record<string, any>;
const issueCodes = (value: unknown): string[] => {
  const result = parseTradingConfiguration(value);
  assert.equal(result.ok, false);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

test("accepts generic stock configuration, shared instances, custom parameters and monitor-only rows", () => {
  const parsed = parseTradingConfiguration(fixtureText);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const { configuration } = parsed;
  assert.deepEqual(configuration.instruments.slice(0, 2).map((i) => i.strategySelection.instanceIds), [["momentum_default"], ["momentum_default"]]);
  assert.equal(configuration.instruments[2]?.contract.symbol, "QZXP");
  assert.equal(configuration.instruments[3]?.strategySelection.instanceIds.length, 0);
  assert.deepEqual(configuration.strategyInstances[0]?.parameters, MOMENTUM_CONFIGURATION_DEFAULTS_V1);
  assert.equal(configuration.strategyInstances[1]?.parameters.dailyReturn20MinPct, 12);
  assert.equal(configuration.strategyInstances[1]?.parameters.return60MinPct, 0.5);
  assert.equal(configuration.strategyInstances[2]?.enabled, false);
  assert.equal(configuration.instruments[4]?.strategySelection.instanceIds[0], "momentum_paused");
});

test("returns a detached deeply frozen snapshot", () => {
  const input = clone();
  const parsed = parseTradingConfiguration(input);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  input.strategyInstances[0].parameters = { dailyReturn20MinPct: 99 };
  input.instruments[0].contract.symbol = "BAD";
  assert.equal(parsed.configuration.strategyInstances[0]?.parameters.dailyReturn20MinPct, 8);
  assert.equal(parsed.configuration.instruments[0]?.contract.symbol, "PKO");
  assert.equal(Object.isFrozen(parsed.configuration), true);
  assert.equal(Object.isFrozen(parsed.configuration.strategyInstances), true);
  assert.equal(Object.isFrozen(parsed.configuration.strategyInstances[0]?.parameters), true);
  assert.throws(() => { (parsed.configuration.strategyInstances[0]!.parameters as any).dailyReturn20MinPct = 1; }, TypeError);
});

test("rejects malformed JSON safely and oversized text", () => {
  assert.deepEqual(issueCodes("{secret: broken"), ["INVALID_JSON"]);
  assert.deepEqual(issueCodes(" ".repeat(1024 * 1024 + 1)), ["LIMIT_EXCEEDED"]);
});

test("rejects non-object roots, non-plain objects, arrays and primitive coercions", () => {
  for (const value of [null, [], 3, Object.create({ schemaVersion: 1 }), new Date()]) assert.ok(issueCodes(value).includes("INVALID_TYPE"));
  const input = clone();
  input.strategyInstances[0].revision = "1";
  assert.ok(issueCodes(input).includes("INVALID_TYPE"));
});

test("rejects wrong primitive and container types across schema boundaries", () => {
  const mutations: Array<(input: Record<string, any>) => void> = [
    (x) => { x.schemaVersion = "1"; },
    (x) => { x.strategyInstances[0].enabled = 1; },
    (x) => { x.strategyInstances[0].parameters = null; },
    (x) => { x.instruments[0].contract = "PKO"; },
    (x) => { x.instruments[0].strategySelection.instanceIds = "momentum_default"; },
    (x) => { x.accountPolicies[0].maxOpenPositions = "1"; },
    (x) => { x.riskPolicies[0].maxEntryNotional.amount = "1000"; },
    (x) => { x.researchPolicies[0].required = "true"; },
  ];
  for (const mutate of mutations) {
    const input = clone(); mutate(input);
    assert.ok(issueCodes(input).includes("INVALID_TYPE"));
  }
});

test("rejects malformed objects, null and arrays at literal boundaries without throwing", () => {
  const mutations: Array<(input: Record<string, any>, value: unknown) => void> = [
    (x, value) => { x.instruments[0].contract.broker = value; },
    (x, value) => { x.instruments[0].assetClass = value; },
    (x, value) => { x.instruments[0].session.useRTH = value; },
    (x, value) => { x.executionPolicies[0].outsideRth = value; },
  ];
  for (const value of [null, [], { toString: 1 }]) {
    for (const mutate of mutations) {
      const input = clone(); mutate(input, value);
      assert.doesNotThrow(() => parseTradingConfiguration(input));
      assert.equal(parseTradingConfiguration(input).ok, false);
    }
  }
});

test("rejects unknown keys, prototype keys, unsupported versions and fixed-default overrides", () => {
  let input = clone(); input.extra = "redacted";
  assert.ok(issueCodes(input).includes("UNKNOWN_FIELD"));
  assert.ok(issueCodes('{"__proto__":{},"schemaVersion":1}').includes("INVALID_VALUE"));
  input = clone(); input.schemaVersion = 2;
  assert.ok(issueCodes(input).includes("UNSUPPORTED_VERSION"));
  input = clone(); input.strategyInstances[0].parameters = { rsiMax: 1 };
  assert.ok(issueCodes(input).includes("UNKNOWN_FIELD"));
});

test("rejects non-finite, negative-zero, malformed strings and parameter range violations", () => {
  let input = clone(); input.strategyInstances[0].revision = -0;
  assert.ok(issueCodes(input).includes("INVALID_VALUE"));
  input = clone(); input.instruments[0].contract.expectedMinTick = Number.POSITIVE_INFINITY;
  assert.ok(issueCodes(input).includes("INVALID_VALUE"));
  input = clone(); input.strategyInstances[0].parameters = { dailyReturn20MinPct: 101 };
  assert.ok(issueCodes(input).includes("INVALID_VALUE"));
  input = clone(); input.instruments[0].contract.symbol = " pko ";
  assert.ok(issueCodes(input).includes("INVALID_VALUE"));
});

test("rejects unsupported capability combinations and unresolved references", () => {
  let input = clone(); input.instruments[0].contract.currency = "USD";
  assert.ok(issueCodes(input).includes("UNSUPPORTED_CAPABILITY"));
  input = clone(); input.instruments[0].entryEnabled = true; input.instruments[0].monitoringEnabled = false;
  assert.ok(issueCodes(input).includes("CONTRADICTORY_POLICY"));
  input = clone(); input.instruments[0].riskPolicyId = "missing_policy";
  assert.ok(issueCodes(input).includes("MISSING_REFERENCE"));
  input = clone(); input.strategyInstances[0].implementationId = "unknown";
  assert.ok(issueCodes(input).includes("UNSUPPORTED_IMPLEMENTATION"));
});

test("resolves every policy and strategy reference", () => {
  for (const key of ["accountPolicyId", "entryPolicyId", "executionPolicyId", "riskPolicyId", "researchPolicyId", "issuerMappingId"] as const) {
    const input = clone(); input.instruments[0][key] = "missing_reference";
    const result = parseTradingConfiguration(input);
    assert.equal(result.ok, false, `${key} should resolve`);
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.path === `$.instruments[0].${key}` && issue.code === "MISSING_REFERENCE"));
  }
  const input = clone(); input.instruments[0].strategySelection.instanceIds = ["missing_instance"];
  assert.ok(issueCodes(input).includes("MISSING_REFERENCE"));
});

test("accepts each editable threshold at its inclusive limits and rejects values outside them", () => {
  const thresholds: Array<[string, number, number]> = [
    ["dailyReturn20MinPct", 0, 100], ["h1Return4MinPct", 0, 100], ["return60MinPct", 0, 3],
  ];
  for (const [key, min, max] of thresholds) {
    for (const value of [min, max]) {
      const input = clone(); input.strategyInstances[0].parameters = { [key]: value };
      assert.equal(parseTradingConfiguration(input).ok, true, `${key}=${value} should be accepted`);
    }
    for (const value of [min - 0.01, max + 0.01, String(min), Number.NaN, -0]) {
      const input = clone(); input.strategyInstances[0].parameters = { [key]: value };
      assert.equal(parseTradingConfiguration(input).ok, false, `${key}=${String(value)} should be rejected`);
    }
  }
});

test("rejects unsupported ETF, future, short, fractional-share and GTC declarations", () => {
  const mutations: Array<(input: Record<string, any>) => void> = [
    (x) => { x.instruments[0].assetClass = "ETF"; },
    (x) => { x.instruments[0].assetClass = "FUT"; },
    (x) => { x.executionPolicies[0].direction = "SHORT"; },
    (x) => { x.executionPolicies[0].quantity = 0.5; },
    (x) => { x.executionPolicies[0].timeInForce = "GTC"; },
  ];
  for (const mutate of mutations) {
    const input = clone(); mutate(input);
    assert.ok(issueCodes(input).includes("UNSUPPORTED_CAPABILITY"));
  }
});

test("rejects duplicate catalogue IDs, strategy selections, conIds, listings and symbols", () => {
  let input = clone(); input.accountPolicies.push({ ...input.accountPolicies[0] });
  assert.ok(issueCodes(input).includes("DUPLICATE_ID"));
  input = clone(); input.instruments[0].strategySelection.instanceIds.push("momentum_default");
  assert.ok(issueCodes(input).includes("DUPLICATE_ID"));
  input = clone(); input.instruments[1].contract.conId = input.instruments[0].contract.conId;
  assert.ok(issueCodes(input).includes("DUPLICATE_IDENTITY"));
  input = clone(); input.instruments[1].contract.symbol = "PKO";
  assert.ok(issueCodes(input).includes("DUPLICATE_IDENTITY"));
  input = clone(); input.instruments[1].contract.primaryExchange = "NASDAQ"; input.instruments[1].contract.currency = "PLN";
  input.issuerMappings[1].primaryExchange = "NASDAQ"; input.issuerMappings[1].currency = "PLN"; input.riskPolicies[1].maxEntryNotional.currency = "PLN";
  input.instruments[1].contract.symbol = "PKO"; input.instruments[1].contract.conId = 999999;
  assert.ok(issueCodes(input).includes("DUPLICATE_IDENTITY"));
});

test("bounds diagnostics and does not echo rejected values", () => {
  const input = clone(); input.secret = "never echo this value";
  const parsed = parseTradingConfiguration(input);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.issues.length > 0);
  assert.ok(parsed.issues.every((issue) => !issue.message.includes("never echo this value")));
  const secretKeyInput = clone(); secretKeyInput["secret-identifier-should-not-appear"] = true;
  const secretKeyResult = parseTradingConfiguration(secretKeyInput);
  assert.equal(secretKeyResult.ok, false);
  assert.equal(JSON.stringify(secretKeyResult).includes("secret-identifier-should-not-appear"), false);
  const nestedSecretKeyInput = clone(); nestedSecretKeyInput.instruments[0].contract["secret-contract-value"] = "x";
  const nestedSecretKeyResult = parseTradingConfiguration(nestedSecretKeyInput);
  assert.equal(nestedSecretKeyResult.ok, false);
  assert.equal(JSON.stringify(nestedSecretKeyResult).includes("secret-contract-value"), false);
  const many = clone();
  many.instruments = Array.from({ length: 120 }, (_, i) => ({ ...many.instruments[0], id: `copy_${i}` }));
  const result = parseTradingConfiguration(many);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.length <= 100);
});

test("scheduled entry capability is exact max2 and leaves supervised documents unchanged", () => {
  const baseline = parseTradingConfiguration(clone());
  assert.equal(baseline.ok, true);
  if (baseline.ok) assert.deepEqual(baseline.configuration.entryPolicies[0], { id: "one_attempt", kind: "supervised_one_attempt", maxAttemptsPerAccountDay: 1 });
  const input = clone();
  input.entryPolicies[0].kind = "bounded_scheduled";
  input.entryPolicies[0].maxAttemptsPerAccountDay = 2;
  assert.equal(parseTradingConfiguration(input).ok, true);
  for (const value of [1, 3, "2", null]) {
    input.entryPolicies[0].maxAttemptsPerAccountDay = value;
    assert.equal(parseTradingConfiguration(input).ok, false);
  }
  input.entryPolicies[0].kind = "supervised_one_attempt";
  input.entryPolicies[0].maxAttemptsPerAccountDay = 2;
  assert.equal(parseTradingConfiguration(input).ok, false);
});
