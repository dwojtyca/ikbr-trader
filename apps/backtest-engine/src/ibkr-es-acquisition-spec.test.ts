import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IBKR_ES_BAR_REQUEST } from "@ikbr/shared";
import { chicagoWallToUtc } from "./cme-session-calendar.js";
import {
  acquisitionSpecSha256, estimateHistoricalRequests, IBKR_ES_ACQUISITION_SPEC_VERSION,
  IBKR_ES_CALENDAR_VERSION, IBKR_ES_LOCAL_SYMBOLS, IBKR_ES_ROLL_POLICY_VERSION,
  IBKR_ES_TARGET_FROM, IBKR_ES_TARGET_TO, parseIbkrEsAcquisitionSpec,
} from "./ibkr-es-acquisition-spec.js";

function fixture() {
  const expiries = ["20250919", "20251219", "20260320", "20260618", "20260918"];
  const lastTrades = expiries.map((expiry) => chicagoWallToUtc(
    `${expiry.slice(0,4)}-${expiry.slice(4,6)}-${expiry.slice(6,8)}`,
    "08:30",
  ).toISOString());
  const contracts = IBKR_ES_LOCAL_SYMBOLS.map((localSymbol, index) => ({
    conId: index + 1, localSymbol, symbol: "ES" as const, secType: "FUT" as const,
    tradingClass: "ES" as const, exchange: "CME" as const, currency: "USD" as const,
    multiplier: "50" as const, minTick: 0.25 as const,
    lastTradeDateOrContractMonth: expiries[index],
    expiryDate: expiries[index], expiryDateSource: "ibkr-summary-expiry" as const,
    lastTradeRuleVersion: "cme-es-quarterly-termination-0830-ct-v1" as const,
    lastTradeAt: lastTrades[index],
    fetchFrom: index === 0 ? IBKR_ES_TARGET_FROM : new Date(new Date(lastTrades[index - 1]).getTime() - 15 * 86_400_000).toISOString(),
    fetchTo: index === IBKR_ES_LOCAL_SYMBOLS.length - 1 ? IBKR_ES_TARGET_TO : lastTrades[index],
  }));
  return {
    schemaVersion: IBKR_ES_ACQUISITION_SPEC_VERSION, sourceVersion: "ibkr-es-1m-trades-v1",
    createdAt: "2026-09-16T12:00:00.000Z", target: { dateFrom: IBKR_ES_TARGET_FROM, dateTo: IBKR_ES_TARGET_TO },
    request: { ...IBKR_ES_BAR_REQUEST }, rollPolicyVersion: IBKR_ES_ROLL_POLICY_VERSION,
    calendarVersion: IBKR_ES_CALENDAR_VERSION,
    pacing: { requestsPer10Minutes: 50, maxConcurrency: 2 }, contracts,
    estimatedHistoricalRequests: estimateHistoricalRequests(contracts), ibApiServerVersion: 176,
  };
}

describe("IBKR ES acquisition specification", () => {
  it("accepts only the exact ordered retained five-contract source contract", () => {
    const spec = parseIbkrEsAcquisitionSpec(fixture());
    assert.equal(spec.contracts.length, 5);
    assert.equal(acquisitionSpecSha256(spec).length, 64);
  });

  it("rejects substitutions, reordered contracts, unsafe pacing, and extra fields", () => {
    const base = fixture();
    assert.throws(() => parseIbkrEsAcquisitionSpec({ ...base, request: { ...base.request, whatToShow: "MIDPOINT" } }));
    assert.throws(() => parseIbkrEsAcquisitionSpec({ ...base, contracts: [...base.contracts].reverse() }), /ordered/);
    assert.throws(() => parseIbkrEsAcquisitionSpec({ ...base, pacing: { requestsPer10Minutes: 51, maxConcurrency: 2 } }));
    assert.throws(() => parseIbkrEsAcquisitionSpec({ ...base, accountId: "secret" }));
    assert.throws(() => parseIbkrEsAcquisitionSpec({ ...base, estimatedHistoricalRequests: 1 }), /derived/);
  });

  it("enforces exact 08:30 America/Chicago last trade time across DST", () => {
    for (const index of [0, 1]) {
      const base = fixture();
      const contracts = base.contracts.map((contract) => ({ ...contract }));
      const wrongLastTradeAt = `${contracts[index].expiryDate.slice(0, 4)}-${contracts[index].expiryDate.slice(4, 6)}-${contracts[index].expiryDate.slice(6, 8)}T00:00:00.000Z`;
      contracts[index].lastTradeAt = wrongLastTradeAt;
      contracts[index].fetchTo = wrongLastTradeAt;
      contracts[index + 1].fetchFrom = new Date(
        new Date(wrongLastTradeAt).getTime() - 15 * 86_400_000,
      ).toISOString();
      assert.throws(() => parseIbkrEsAcquisitionSpec({
        ...base,
        contracts,
        estimatedHistoricalRequests: estimateHistoricalRequests(contracts),
      }), /08:30 America\/Chicago/);
    }
  });
});
