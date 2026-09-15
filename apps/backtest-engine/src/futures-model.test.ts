import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertWholeContracts,
  parseFuturesSpecsJson,
  requireFuturesSpec,
  validateFuturesContractMetadata,
  validateFuturesContractSpec,
} from "./futures-model.js";

const es = {
  tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
  tickSize: 0.25, commissionPerContractPerSide: 1.25, slippageTicks: 1,
  sessionTemplate: "cme_equity_index", timezone: "America/Chicago",
  calendarVersion: "test-2026",
} as const;

describe("futures contract specification", () => {
  it("accepts explicit ES economics", () => {
    assert.deepEqual(validateFuturesContractSpec(es), es);
  });
  it("rejects incorrect ES multiplier and tick", () => {
    assert.throws(() => validateFuturesContractSpec({ ...es, multiplier: 5 }), /multiplier must be 50/);
    assert.throws(() => validateFuturesContractSpec({ ...es, tickSize: 0.5 }), /tick size must be 0.25/);
  });
  it("fails closed for missing or malformed configuration", () => {
    assert.throws(() => parseFuturesSpecsJson("{"), /valid JSON/);
    assert.throws(() => requireFuturesSpec(new Map(), "ES"), /Missing futures specification/);
    assert.throws(() => parseFuturesSpecsJson(JSON.stringify({ NQ: es })), /must match tradingClass/);
  });
  it("requires positive whole contracts", () => {
    assert.doesNotThrow(() => assertWholeContracts(2));
    for (const value of [0, -1, 0.5, Number.NaN]) assert.throws(() => assertWholeContracts(value), /whole number/);
  });
  it("requires complete contract identity and expiry", () => {
    const valid = { conid: "123", symbol: "es", localSymbol: "ESZ6", tradingClass: "es", lastTradeAt: new Date("2026-12-18T15:30:00Z") };
    assert.equal(validateFuturesContractMetadata(valid).tradingClass, "ES");
    assert.throws(() => validateFuturesContractMetadata({ ...valid, conid: "" }), /identity/);
    assert.throws(() => validateFuturesContractMetadata({ ...valid, lastTradeAt: new Date("bad") }), /lastTradeAt/);
  });
});

