import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExecutionInstrumentBindingAuthority, InstrumentBindingConfigError } from "./instrument-bindings-config.js";

test("GPW1 currency assessor cannot activate a PLN stock through bindings JSON", () => {
  const raw = JSON.stringify([{ instrumentId: "pko_gpw", conId: 35146360, localSymbol: "PKO",
    tradingClass: "PKO", exchange: "WSE", currency: "PLN", minTick: .0001,
    executionEnabled: true, executionPolicy: { strategyId: "momentum_breakout_long_v1" } }]);
  assert.throws(() => buildExecutionInstrumentBindingAuthority(raw), InstrumentBindingConfigError);
  assert.equal(buildExecutionInstrumentBindingAuthority(undefined).toDiagnostics().boundCount, 0);
});
