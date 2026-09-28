import assert from "node:assert/strict";
import { test } from "node:test";
import { assessTradingConfigurationAdmission, TRADING_CONFIGURATION_SERVICES, type TradingConfigurationObservation } from "./admission.js";
const nowMs = Date.parse("2026-09-28T12:00:00.000Z"), hash = "a".repeat(64);
const local = { mode: "bundle" as const, migrationPrepare: false, effectiveHash: hash };
const rows = (): TradingConfigurationObservation[] => TRADING_CONFIGURATION_SERVICES.map((service, index) => ({ service, processId: String(index), mode: "bundle", schemaVersion: 1, canonicalVersion: 1, effectiveHash: hash,
  migrationPrepared: false, legacySourceHash: null, observedAt: new Date(nowMs - 1000).toISOString(), expiresAt: new Date(nowMs + 29000).toISOString() }));
test("matching bundle remains denied; missing, stale, unknown versions and concurrent processes remain visible", () => {
  const match = assessTradingConfigurationAdmission(local, { latched: true, nowMs, observations: rows() });
  assert.equal(match.allowed, false); assert.deepEqual(match.reasons, ["PP3_EXECUTION_POLICY_UNAVAILABLE"]);
  assert.ok(assessTradingConfigurationAdmission(local, { latched: true, nowMs, observations: rows().slice(1) }).reasons.includes("CONFIG_SERVICE_UNAVAILABLE"));
  for (const patch of [{ effectiveHash: "b".repeat(64) }, { schemaVersion: 2 }, { canonicalVersion: 2 }, { mode: "legacy" as const }]) {
    const observations = rows(); observations.push({ ...observations[0], processId: "concurrent", ...patch });
    assert.ok(assessTradingConfigurationAdmission(local, { latched: true, nowMs, observations }).reasons.includes("CONFIG_DRIFT"));
  }
  const expired = rows().map(row => ({ ...row, expiresAt: new Date(nowMs).toISOString() }));
  assert.ok(assessTradingConfigurationAdmission(local, { latched: true, nowMs, observations: expired }).reasons.includes("CONFIG_SERVICE_UNAVAILABLE"));
  assert.ok(assessTradingConfigurationAdmission(local, null).reasons.includes("CONFIG_STORE_UNAVAILABLE"));
});
test("preparation, sticky rollout and live mixed modes block legacy even after peers disappear", () => {
  const legacy = { mode: "legacy" as const, migrationPrepare: false };
  assert.equal(assessTradingConfigurationAdmission(legacy, { latched: false, nowMs, observations: [] }).allowed, true);
  assert.equal(assessTradingConfigurationAdmission(legacy, { latched: true, nowMs, observations: [] }).allowed, false);
  assert.equal(assessTradingConfigurationAdmission(legacy, { latched: false, nowMs, observations: rows() }).allowed, false);
  assert.equal(assessTradingConfigurationAdmission(legacy, { latched: false, nowMs, observations: rows().map(row => ({ ...row, mode: "legacy", migrationPrepared: true })) }).allowed, false);
  assert.equal(assessTradingConfigurationAdmission({ ...legacy, migrationPrepare: true }, { latched: false, nowMs, observations: [] }).allowed, false);
});
