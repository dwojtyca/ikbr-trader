import assert from "node:assert/strict";
import { test } from "node:test";
import { AAPL_NATIVE_SOURCE, type Candle, type AaplTimeframe } from "@ikbr/shared";
import { AaplNativeRefresh, isAaplSubscription } from "./aapl-native-refresh.js";
import type { InstrumentSubscription } from "./types.js";
const sub: InstrumentSubscription = { instrumentId: "aapl_nasdaq", conid: "265598", symbol: "AAPL", contract: { secType: "STK", exchange: "SMART", currency: "USD" } };
const now = Date.parse("2026-09-24T18:00:00Z");
function candle(tf: AaplTimeframe): Candle { return { conid: sub.conid, symbol: sub.symbol, timeframe: tf,
  ts: new Date(tf === "1d" || tf === "1w" ? "2026-09-14T04:00:00Z" : "2026-09-23T13:30:00Z"),
  open: 100, high: 101, low: 99, close: 100, volume: 10, source: AAPL_NATIVE_SOURCE }; }
test("AAPL native warmup ignores recent legacy history, coalesces refresh and awaits idle", async () => {
  const rows = new Map<string, Candle[]>(); let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const requests: AaplTimeframe[] = [];
  const refresh = new AaplNativeRefresh({ now: () => now,
    read: async (_conid, tf) => rows.get(tf) ?? [{ ...candle(tf), source: undefined }],
    fetch: async (_sub, tf, count) => { assert.equal(count, tf === "1m" ? 230 : 60); requests.push(tf); if (tf === "1m") await barrier; return [candle(tf)]; },
    write: async c => { rows.set(c.timeframe, [c]); },
  });
  const first = refresh.run([sub]), duplicate = refresh.run([sub]); let idleDone = false;
  const idle = refresh.idle().then(() => { idleDone = true; });
  assert.equal(first, duplicate); await Promise.resolve(); assert.equal(idleDone, false);
  release(); await first; await idle; assert.equal(idleDone, true);
  assert.deepEqual(requests, ["1m", "5m", "1h", "4h", "1d", "1w"]);
  assert.equal(refresh.status.get(`${sub.conid}:1h`)?.error, "insufficient_native_closed_candles");
  await refresh.run([sub]); await refresh.run([sub], true); assert.equal(requests.length, 6);
});
test("exact subscription identity and source validation reject foreign, partial or malformed bars", async () => {
  let writes = 0;
  const refresh = new AaplNativeRefresh({ now: () => now, read: async () => [],
    fetch: async (_sub, tf) => [{ ...candle(tf), conid: "wrong" }, { ...candle(tf), source: undefined },
      { ...candle(tf), ts: new Date(now) }, { ...candle(tf), low: 102 }], write: async () => { writes++; } });
  await refresh.run([sub]); assert.equal(writes, 0);
  for (const patch of [{ instrumentId: "other" }, { symbol: "OTHER" }, { conid: "123" },
    { contract: { ...sub.contract, currency: "PLN" } }, { contract: { ...sub.contract, conId: 123 } }])
    assert.equal(isAaplSubscription({ ...sub, ...patch }), false);
});
test("pacing errors remain visible and repeated bootstrap cannot bypass bounded failure backoff", async () => {
  let clock = now, calls = 0;
  const refresh = new AaplNativeRefresh({ now: () => clock, read: async () => [], fetch: async () => { calls++; throw new Error("historicalData error 162"); }, write: async () => {} });
  await refresh.run([sub]); assert.equal(calls, 6);
  assert.match(refresh.status.get(`${sub.conid}:1m`)?.error ?? "", /162/);
  await refresh.run([sub]); assert.equal(calls, 6);
  clock += 59999; await refresh.run([sub], true); assert.equal(calls, 6);
  clock++; await refresh.run([sub]); assert.equal(calls, 7);
  clock += 240000; await refresh.run([sub]); assert.equal(calls, 13);
});
test("freshness status never labels old but numerous closed bars ready", async () => {
  const refresh = new AaplNativeRefresh({ now: () => now, read: async (_conid, tf) => Array.from({ length: 230 }, (_, i) => ({
    ...candle(tf), ts: new Date(tf === "1d" || tf === "1w" ? `2025-01-${String(6 + i % 5).padStart(2, "0")}T05:00:00Z` : `2025-01-06T14:${String(30 + i % 30).padStart(2, "0")}:00Z`),
  })), fetch: async () => [], write: async () => {} });
  await refresh.run([sub]);
  for (const status of refresh.status.values()) assert.equal(status.error, "stale_native_closed_candles");
});
test("fresh native counts wait for next completed interval rather than startup phase", async () => {
  let clock = Date.parse("2026-09-24T18:15:00Z");
  const requests: Array<{ tf: AaplTimeframe; at: number }> = [];
  const rows = new Map<AaplTimeframe, Candle[]>();
  for (const tf of ["1h", "4h"] as AaplTimeframe[]) {
    const history = Array.from({ length: 60 }, (_, i) => ({ ...candle(tf), ts: new Date(Date.parse("2026-06-01T13:30:00Z") + i * 86400000) }))
      .filter(c => ![0, 6].includes(c.ts.getUTCDay()));
    // Provide 50 different source rows, with the latest fully closed interval.
    for (let i = 0; history.length < 50; i++) {
      const date = new Date(Date.parse("2026-08-03T13:30:00Z") + i * 86400000);
      if (![0, 6].includes(date.getUTCDay())) history.push({ ...candle(tf), ts: date });
    }
    history.push({ ...candle(tf), ts: new Date(tf === "1h" ? "2026-09-24T17:00:00Z" : "2026-09-24T13:30:00Z") });
    rows.set(tf, history);
  }
  const refresh = new AaplNativeRefresh({ now: () => clock, read: async (_conid, tf) => rows.get(tf) ?? [],
    fetch: async (_sub, tf) => { requests.push({ tf, at: clock }); return []; }, write: async () => {} });
  await refresh.run([sub]); assert.equal(requests.some(x => x.tf === "1h" || x.tf === "4h"), false);
  clock = Date.parse("2026-09-24T19:00:00Z"); await refresh.run([sub]);
  assert.ok(requests.some(x => x.tf === "1h" && x.at === clock));
  assert.equal(requests.some(x => x.tf === "4h"), false);
  clock = Date.parse("2026-09-24T21:30:00Z"); await refresh.run([sub]);
  assert.ok(requests.some(x => x.tf === "4h" && x.at === clock));
});
