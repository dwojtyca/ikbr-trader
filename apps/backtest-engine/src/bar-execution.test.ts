import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAdverseSlippage,
  futuresRoundTripPnl,
  normalizeInstructionPrice,
  priceToTicks,
  stopExitReference,
} from "./bar-execution.js";
import type { FuturesContractSpec } from "./futures-model.js";

const spec: FuturesContractSpec = {
  tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
  tickSize: 0.25, commissionPerContractPerSide: 1.25, slippageTicks: 1,
  sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "test",
};

describe("futures bar execution", () => {
  it("normalizes all instruction directions without increasing aggressiveness", () => {
    assert.equal(normalizeInstructionPrice(5000.13, 0.25, "BUY", "limit"), 5000);
    assert.equal(normalizeInstructionPrice(5000.13, 0.25, "SELL", "limit"), 5000.25);
    assert.equal(normalizeInstructionPrice(5000.13, 0.25, "BUY", "stop"), 5000.25);
    assert.equal(normalizeInstructionPrice(5000.13, 0.25, "SELL", "stop"), 5000);
    assert.equal(normalizeInstructionPrice(-1.13, 0.25, "BUY", "limit"), -1.25);
    assert.equal(normalizeInstructionPrice(-1.13, 0.25, "SELL", "limit"), -1);
    assert.equal(normalizeInstructionPrice(5000.125, 0.25, "BUY", "limit"), 5000);
    assert.equal(normalizeInstructionPrice(5000.125, 0.25, "SELL", "limit"), 5000.25);
    assert.equal(normalizeInstructionPrice(5000.125, 0.25, "BUY", "stop"), 5000.25);
    assert.equal(normalizeInstructionPrice(5000.125, 0.25, "SELL", "stop"), 5000);
    assert.equal(normalizeInstructionPrice(-1.125, 0.25, "BUY", "limit"), -1.25);
    assert.equal(normalizeInstructionPrice(-1.125, 0.25, "SELL", "limit"), -1);
  });
  it("uses integer tick identity", () => {
    assert.equal(priceToTicks(5000.25, 0.25), 20001);
    assert.equal(priceToTicks(-1.125, 0.25), -4.5);
  });
  it("applies adverse slippage and gap-through stop references", () => {
    assert.equal(applyAdverseSlippage(5000, "BUY", spec), 5000.25);
    assert.equal(applyAdverseSlippage(5000, "SELL", spec), 4999.75);
    assert.equal(stopExitReference("SELL", 4998, 4995, 0.25), 4995);
    assert.equal(stopExitReference("BUY", 5002, 5005, 0.25), 5005);
  });
  it("calculates long and short P&L with two-sided commission and no double slippage subtraction", () => {
    assert.deepEqual(futuresRoundTripPnl({ direction: 1, quantity: 2, entryFillPrice: 5000.25, exitFillPrice: 5001.75, fxRate: 1, spec }), { grossPnl: 150, commission: 5, netPnl: 145 });
    assert.deepEqual(futuresRoundTripPnl({ direction: -1, quantity: 1, entryFillPrice: 5000, exitFillPrice: 4998, fxRate: 1, spec }), { grossPnl: 100, commission: 2.5, netPnl: 97.5 });
  });
});
