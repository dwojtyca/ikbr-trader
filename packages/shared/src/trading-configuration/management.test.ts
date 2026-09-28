import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { InstrumentRegistry } from "../instruments/registry.js";
import { InstrumentBindingAuthority } from "../instruments/bindings.js";
import { buildConfiguredInstrumentRegistry } from "../instruments/configured-registry.js";
import { parseTradingConfiguration } from "./parser.js";
import { buildTradingConfigurationProjection } from "./projection.js";
import { assertManagementCompatibility, createLegacyManagementSnapshot, decodeLegacyManagementSnapshot, validateRetainedOwnership } from "./management.js";

for (const selected of ["pko_wse", "aapl_nasdaq"]) test(`actual ${selected} legacy seed missing primary listing remains unchanged during compatible conversion`, () => {
  const registry = buildConfiguredInstrumentRegistry({ IBKR_ENVIRONMENT: "paper", GPW_PROFILE_ENABLED: selected === "pko_wse" ? "true" : "false", AAPL_PROFILE_ENABLED: selected === "aapl_nasdaq" ? "true" : "false" });
  const bindings = [
    { instrumentId: "pko_wse", conId: 35146360, localSymbol: "PKO", tradingClass: "PKO", exchange: "WSE", currency: "PLN", minTick: .01 },
    { instrumentId: "aapl_nasdaq", conId: 265598, localSymbol: "AAPL", tradingClass: "NMS", exchange: "SMART", currency: "USD", minTick: .01 },
  ];
  const legacy = new InstrumentBindingAuthority(registry, bindings);
  const stored = createLegacyManagementSnapshot(legacy), restored = decodeLegacyManagementSnapshot(stored.canonical, stored.sourceHash);
  const raw = JSON.parse(readFileSync(new URL("../../../../config/trading/paper.v1.json", import.meta.url), "utf8"));
  const parsed = parseTradingConfiguration(raw); assert.equal(parsed.ok, true); if (!parsed.ok) throw Error("fixture");
  const current = buildTradingConfigurationProjection(parsed.configuration).authority;
  assert.doesNotThrow(() => assertManagementCompatibility(current, restored));
  assert.equal(restored.getBoundInstrument(selected)!.instrument.primaryExchange, undefined);
  assert.equal(createLegacyManagementSnapshot(restored).canonical, stored.canonical);
  assert.equal(createLegacyManagementSnapshot(restored).sourceHash, stored.sourceHash);
  const old = restored.getBoundInstrument(selected)!;
  validateRetainedOwnership(restored, [{ instrumentId: selected, conId: String(old.conId), symbol: old.brokerSymbol, strategy: "momentum_breakout_long_v1", clientOrderHash: "a".repeat(64) }]);
  const primaryConflict = new InstrumentBindingAuthority(new InstrumentRegistry(restored.listBoundInstruments().map(row => ({ ...row.instrument, primaryExchange: row.instrumentId === selected ? "OTHER" : undefined }))), bindings);
  assert.throws(() => assertManagementCompatibility(current, primaryConflict), /IDENTITY_CONFLICT/);
  const reusedSymbol = structuredClone(raw);
  const renamed = reusedSymbol.instruments.find((row: { id: string }) => row.id === selected);
  renamed.id = "new_listing"; renamed.contract.conId = 999111;
  const collision = parseTradingConfiguration(reusedSymbol); if (!collision.ok) throw Error("fixture");
  assert.throws(() => assertManagementCompatibility(buildTradingConfigurationProjection(collision.configuration).authority, restored), /IDENTITY_CONFLICT/);
  raw.instruments.find((row: { id: string }) => row.id === selected).contract.conId = 987999;
  const changed = parseTradingConfiguration(raw); if (!changed.ok) throw Error("fixture");
  assert.throws(() => assertManagementCompatibility(buildTradingConfigurationProjection(changed.configuration).authority, restored), /IDENTITY_CONFLICT/);
});
