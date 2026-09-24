import assert from "node:assert/strict";
import { test } from "node:test";
import { newYorkMidnight, aaplCandleEnd, validClosedAaplCandle, AAPL_NATIVE_SOURCE } from "./aapl-candles.js";
import type { Candle } from "./index.js";
const candle: Candle = { conid: "265598", symbol: "AAPL", timeframe: "4h", ts: new Date("2026-09-24T13:30:00Z"),
  open: 100, high: 101, low: 99, close: 100, volume: 100, source: AAPL_NATIVE_SOURCE };
test("RTH four-hour bar requires its full duration, including a short-session bar", () => {
  assert.equal(validClosedAaplCandle(candle, Date.parse("2026-09-24T17:29:59Z")), false);
  assert.equal(validClosedAaplCandle(candle, Date.parse("2026-09-24T17:30:00Z")), true);
  const shortSession = { ...candle, ts: new Date("2026-11-27T14:30:00Z") };
  assert.equal(validClosedAaplCandle(shortSession, Date.parse("2026-11-27T18:00:00Z")), false);
  assert.equal(validClosedAaplCandle(shortSession, Date.parse("2026-11-27T18:30:00Z")), true);
});
for (const [name, patch] of Object.entries({
  source: { source: undefined }, symbol: { symbol: "OTHER" }, conid: { conid: "123" }, unsupported: { timeframe: "12h" },
  malformed: { ts: new Date(NaN) }, premarket: { ts: new Date("2026-09-24T13:29:00Z") },
  afterhours: { ts: new Date("2026-09-24T20:00:00Z") }, weekend: { ts: new Date("2026-09-26T13:30:00Z") },
  offMinute: { ts: new Date("2026-09-24T13:30:00.001Z") }, high: { high: 99.5 }, low: { low: 100.5 },
  nonfinite: { open: NaN }, negative: { volume: -1 }, volume: { volume: Infinity },
})) test(`closed AAPL candle refuses ${name}`, () => {
  assert.equal(validClosedAaplCandle({ ...candle, ...patch } as Candle, Date.parse("2026-09-28T20:00:00Z")), false);
});
test("NY date-only conversion is strict and DST-aware", () => {
  assert.equal(newYorkMidnight(2026, 9, 24).toISOString(), "2026-09-24T04:00:00.000Z");
  assert.equal(newYorkMidnight(2026, 1, 22).toISOString(), "2026-01-22T05:00:00.000Z");
  assert.equal(newYorkMidnight(2024, 2, 29).toISOString(), "2024-02-29T05:00:00.000Z");
  for (const args of [[2026, 2, 29], [2026, 2, 30], [2026, 13, 1], [1999, 1, 1], [2026, 1, 0]])
    assert.throws(() => newYorkMidnight(args[0], args[1], args[2]));
  assert.equal(new Date(aaplCandleEnd(newYorkMidnight(2026, 3, 8), "1d")).toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(new Date(aaplCandleEnd(newYorkMidnight(2026, 3, 2), "1w")).toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(new Date(aaplCandleEnd(newYorkMidnight(2026, 10, 26), "1w")).toISOString(), "2026-11-02T05:00:00.000Z");
});
for (const timeframe of ["1d", "1w"] as const) test(`current ${timeframe} remains incomplete until NY calendar boundary`, () => {
  const c = { ...candle, timeframe, ts: newYorkMidnight(2026, 9, 21) }, end = aaplCandleEnd(c.ts, timeframe);
  assert.equal(validClosedAaplCandle(c, end - 1), false);
  assert.equal(validClosedAaplCandle(c, end), true);
  assert.equal(validClosedAaplCandle({ ...c, ts: new Date("2026-09-21T12:00:00Z") }, end), false);
});
