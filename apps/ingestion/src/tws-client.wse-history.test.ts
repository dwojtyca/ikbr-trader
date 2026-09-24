import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsClient } from "./tws-client.js";
import type { InstrumentSubscription } from "./types.js";
const sub: InstrumentSubscription = { instrumentId: "pko_wse", symbol: "PKO", conid: "35146360", contract: { conId: 35146360, secType: "STK", exchange: "WSE", currency: "PLN" } };
class Fake extends EventEmitter {
  requests: unknown[][] = [];
  dates = ["20260923", "20260924"];
  reqHistoricalData(...args: unknown[]) { this.requests.push(args); queueMicrotask(() => {
    for (const date of this.dates) this.emit("historicalData", args[0], date, 60, 61, 59, 60, 100);
    this.emit("historicalData", args[0], "finished");
  }); }
}
test("native WSE daily parsing excludes current partial day and records provenance", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-24T10:00:00Z") });
  const ib = new Fake(); const client = new TwsClient({ host: "localhost", port: 4002, clientId: 1, securityType: "STK", exchange: "SMART", currency: "USD", marketDataType: 1 }, () => {}, () => {}, { ib });
  const result = await client.backfillRecentCandles([sub], "1d", 50);
  assert.equal(result[0].candles.length, 1);
  assert.equal(result[0].candles[0].ts.toISOString(), "2026-09-22T22:00:00.000Z");
  assert.equal(result[0].candles[0].source, "ibkr_wse_native_v1");
  assert.equal(ib.requests[0][6], 1);
  await client.backfillRecentCandles([sub], "12h", 50);
  assert.equal(ib.requests.length, 1);
});
