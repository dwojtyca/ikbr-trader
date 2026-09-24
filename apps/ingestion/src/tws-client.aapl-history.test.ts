import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AAPL_NATIVE_SOURCE, type AaplTimeframe } from "@ikbr/shared";
import { TwsClient } from "./tws-client.js";
import type { InstrumentSubscription } from "./types.js";
const sub: InstrumentSubscription = { instrumentId: "aapl_nasdaq", symbol: "AAPL", conid: "265598", contract: { conId: 265598, symbol: "AAPL", secType: "STK", exchange: "SMART", currency: "USD" } };
const config = { host: "unused", port: 0, clientId: 1, securityType: "STK", exchange: "SMART", currency: "USD", marketDataType: 1 };
class Fake extends EventEmitter {
  requests: unknown[][] = [];
  dates = ["20260923", "20260924", "20260230"];
  error?: number;
  reqHistoricalData(...args: unknown[]) { this.requests.push(args); queueMicrotask(() => {
    if (this.error) { this.emit("error", new Error("historical fixture failure"), { id: args[0], code: this.error }); return; }
    for (const date of this.dates) this.emit("historicalData", args[0], date, 100, 101, 99, 100, 100);
    this.emit("historicalData", args[0], "finished");
  }); }
}
test("AAPL daily request is RTH native and excludes current day and malformed date", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-24T17:00:00Z") });
  const ib = new Fake(), client = new TwsClient(config, () => {}, () => {}, { ib });
  const rows = await client.fetchNativeAaplCandles(sub, "1d", 60);
  assert.equal(rows.length, 1); assert.equal(rows[0].source, AAPL_NATIVE_SOURCE);
  assert.equal(rows[0].ts.toISOString(), "2026-09-23T04:00:00.000Z");
  assert.equal(ib.requests[0][6], 1); assert.equal(ib.requests[0][5], "TRADES");
  await assert.rejects(client.fetchNativeAaplCandles(sub, "12h" as AaplTimeframe, 60), /aapl_native_request_invalid/);
  await assert.rejects(client.fetchNativeAaplCandles({ ...sub, conid: "123" }, "1m", 60));
  assert.equal(ib.requests.length, 1);
});
for (const timeframe of ["1m", "5m", "1h", "4h"] as const) test(`AAPL ${timeframe} filters incomplete and premarket timestamps`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-24T18:00:00Z") });
  const ib = new Fake();
  ib.dates = ["2026-09-24T13:29:00Z", "2026-09-24T13:30:00Z", "2026-09-24T17:59:30Z", "2026-09-24T18:00:00Z"]
    .map(date => String(Date.parse(date) / 1000));
  const client = new TwsClient(config, () => {}, () => {}, { ib });
  const rows = await client.fetchNativeAaplCandles(sub, timeframe, 60);
  assert.equal(rows.length, 1); assert.equal(rows[0].ts.toISOString(), "2026-09-24T13:30:00.000Z");
  assert.equal(ib.requests[0][6], 1);
});
test("AAPL broker pacing errors propagate promptly and don't become empty successful history", async () => {
  const ib = new Fake(); ib.error = 162;
  const client = new TwsClient(config, () => {}, () => {}, { ib });
  await assert.rejects(client.fetchNativeAaplCandles(sub, "1m", 230), /historicalData error 162/);
  assert.equal(ib.requests.length, 1);
});
test("native AAPL and legacy backfill share the existing client historical budget", async () => {
  const ib = new Fake(); ib.dates = [];
  const waits: number[] = [];
  const client = new TwsClient(config, () => {}, () => {}, { ib, now: () => 1000,
    sleep: async ms => { waits.push(ms); await new Promise<void>(() => {}); } });
  for (let i = 0; i < 49; i++) await client.backfillRecentCandles([{ ...sub, instrumentId: undefined }], "1m", 1);
  await client.fetchNativeAaplCandles(sub, "1m", 230);
  void client.fetchNativeAaplCandles(sub, "1m", 230);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ib.requests.length, 50); assert.deepEqual(waits, [30000]);
});
test("AAPL historical parsing rejects host-local, ISO and normalized invalid dates at the adapter boundary", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-03-03T19:00:00Z") });
  const ib = new Fake(), client = new TwsClient(config, () => {}, () => {}, { ib });
  ib.dates = ["2026-02-30T14:30:00Z", "2026-03-02T14:30:00Z", "20260302 14:30:00", "20260302",
    "1772461800000", "1772461800.0", " 1772461800", "1772461800suffix", String(Date.parse("2026-03-02T14:30:00Z") / 1000)];
  const intraday = await client.fetchNativeAaplCandles(sub, "1m", 230);
  assert.equal(intraday.length, 1); assert.equal(intraday[0].ts.toISOString(), "2026-03-02T14:30:00.000Z");
  ib.dates = ["20260230", "2026-02-30T05:00:00Z", "2026-03-02T05:00:00Z", "1772427600", "20260302 ", "20260302"];
  const daily = await client.fetchNativeAaplCandles(sub, "1d", 60);
  assert.equal(daily.length, 1); assert.equal(daily[0].ts.toISOString(), "2026-03-02T05:00:00.000Z");
});
