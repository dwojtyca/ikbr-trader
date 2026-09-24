import assert from "node:assert/strict";
import { test } from "node:test";
import { warsawMidnight, wseCandleEnd, validClosedWseCandle, WSE_NATIVE_SOURCE } from "./wse-candles.js";
import type { Candle } from "./index.js";
const candle: Candle = { conid: "35146360", symbol: "PKO", timeframe: "1h", ts: new Date("2026-09-24T08:00:00Z"), open: 60, high: 61, low: 59, close: 60, volume: 100, source: WSE_NATIVE_SOURCE };
test("native provenance and complete interval are mandatory", () => {
  assert.equal(validClosedWseCandle(candle, Date.parse("2026-09-24T08:59:59Z")), false);
  assert.equal(validClosedWseCandle(candle, Date.parse("2026-09-24T09:00:00Z")), true);
  assert.equal(validClosedWseCandle({ ...candle, source: undefined }, Date.parse("2026-09-24T09:00:00Z")), false);
  assert.equal(validClosedWseCandle({ ...candle, timeframe: "12h" }, Date.parse("2026-09-25T09:00:00Z")), false);
  assert.equal(validClosedWseCandle({ ...candle, close: 80 }, Date.parse("2026-09-24T09:00:00Z")), false);
});
test("daily and weekly finality uses Warsaw calendar across DST", () => {
  assert.equal(warsawMidnight(2026, 3, 29).toISOString(), "2026-03-28T23:00:00.000Z");
  assert.equal(new Date(wseCandleEnd(warsawMidnight(2026, 3, 29), "1d")).toISOString(), "2026-03-29T22:00:00.000Z");
  assert.equal(new Date(wseCandleEnd(warsawMidnight(2026, 3, 23), "1w")).toISOString(), "2026-03-29T22:00:00.000Z");
});
