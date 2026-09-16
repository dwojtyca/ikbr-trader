import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertExactIbkrEsContract,
  buildExactIbkrEsHistoricalContract,
  formatIbUtcEndDateTime,
  IBKR_ES_BAR_REQUEST,
  isCmeEquityIndexOpenMinuteV1,
  type IbkrEsContractIdentity,
} from "./ibkr-bar-source.js";

const identity: IbkrEsContractIdentity = {
  conId: 123,
  localSymbol: "ESH5",
  lastTradeDateOrContractMonth: "20250321",
  minTick: 0.25,
  symbol: "ES",
  secType: "FUT",
  tradingClass: "ES",
  exchange: "CME",
  currency: "USD",
  multiplier: "50",
};

describe("IBKR ES bar source", () => {
  it("freezes the exact native 1m TRADES request tuple", () => {
    assert.deepEqual(IBKR_ES_BAR_REQUEST, {
      provider: "IBKR TWS API", secType: "FUT", symbol: "ES",
      tradingClass: "ES", exchange: "CME", currency: "USD", multiplier: "50",
      includeExpired: true, barSize: "1 min", whatToShow: "TRADES",
      useRTH: 0, formatDate: 2, keepUpToDate: false,
    });
    assert.equal(Object.isFrozen(IBKR_ES_BAR_REQUEST), true);
  });

  it("fails closed outside the bounded CME calendar and during maintenance/closures", () => {
    assert.equal(isCmeEquityIndexOpenMinuteV1(new Date("2026-06-01T21:30:00Z")), false);
    assert.equal(isCmeEquityIndexOpenMinuteV1(new Date("2025-12-25T16:00:00Z")), false);
    assert.equal(isCmeEquityIndexOpenMinuteV1(new Date("2026-06-01T22:00:00Z")), true);
    assert.equal(isCmeEquityIndexOpenMinuteV1(new Date("2026-09-01T14:00:00Z")), false);
    assert.equal(isCmeEquityIndexOpenMinuteV1(new Date("2025-01-09T14:29:00Z")), true);
    assert.equal(isCmeEquityIndexOpenMinuteV1(new Date("2025-01-09T14:30:00Z")), false);
  });

  it("formats request end times in UTC independently of machine timezone", () => {
    assert.equal(formatIbUtcEndDateTime(new Date("2026-01-02T03:04:05.000Z")), "20260102-03:04:05");
  });

  it("requires complete exact expired-future identity", () => {
    assert.deepEqual(buildExactIbkrEsHistoricalContract(identity), {
      conId: 123, symbol: "ES", secType: "FUT",
      expiry: "20250321",
      lastTradeDateOrContractMonth: "20250321", multiplier: "50",
      exchange: "CME", currency: "USD", localSymbol: "ESH5",
      tradingClass: "ES", includeExpired: true,
    });
    for (const changed of [
      { ...identity, conId: 0 },
      { ...identity, localSymbol: "ES CONT" },
      { ...identity, tradingClass: "MES" },
      { ...identity, multiplier: "5" },
      { ...identity, minTick: 0.5 },
    ]) assert.throws(() => assertExactIbkrEsContract(changed));
    assert.throws(() => assertExactIbkrEsContract(identity, "ESM5"), /substituted/);
  });
});
