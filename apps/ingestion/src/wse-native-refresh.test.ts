import assert from "node:assert/strict";
import { test } from "node:test";
import { WSE_NATIVE_SOURCE, type Candle, type WseTimeframe } from "@ikbr/shared";
import { WseNativeRefresh, isWseSubscription } from "./wse-native-refresh.js";
import type { InstrumentSubscription } from "./types.js";
const sub: InstrumentSubscription = { instrumentId: "pko_wse", conid: "35146360", symbol: "PKO", contract: { secType: "STK", exchange: "WSE", currency: "PLN" } };
const now = Date.parse("2026-09-24T10:00:00Z");
function candle(tf: WseTimeframe): Candle { return { conid: sub.conid, symbol: sub.symbol, timeframe: tf, ts: new Date("2026-09-14T07:00:00Z"), open: 60, high: 61, low: 59, close: 60, volume: 10, source: WSE_NATIVE_SOURCE }; }
test("WSE refresh uses native six TFs, checks counts and coalesces concurrent callers", async () => {
  const rows = new Map<string, Candle[]>(); let release!: () => void; const barrier = new Promise<void>(r => { release = r; });
  const requests: WseTimeframe[] = [];
  const refresh = new WseNativeRefresh({ now: () => now,
    read: async (_conid, tf) => rows.get(tf) ?? [],
    fetch: async (_sub, tf) => { requests.push(tf); if (tf === "1m") await barrier; return [candle(tf)]; },
    write: async c => { rows.set(c.timeframe, [c]); },
  });
  const first = refresh.run([sub]); const duplicate = refresh.run([sub]);
  assert.equal(first, duplicate); release(); await first;
  assert.deepEqual(requests, ["1m", "5m", "1h", "4h", "1d", "1w"]);
  assert.equal(refresh.status.get(`${sub.conid}:1h`)?.error, "insufficient_native_closed_candles");
  await refresh.run([sub]); assert.equal(requests.length, 6);
});
test("wrong contract or old provenance never writes", async () => {
  let writes = 0;
  const refresh = new WseNativeRefresh({ now: () => now, read: async () => [],
    fetch: async (_sub, tf) => [{ ...candle(tf), conid: "wrong" }, { ...candle(tf), source: undefined }], write: async () => { writes++; } });
  await refresh.run([sub]); assert.equal(writes, 0);
  assert.equal(isWseSubscription({ ...sub, contract: { secType: "STK", exchange: "SMART", currency: "USD" } }), false);
});
test("native refresh discovers next closed H1 and H4 at bar boundary, independent of startup phase", async () => {
  let clock = Date.parse("2026-09-24T11:15:00Z");
  const fetched: Array<{ tf: WseTimeframe; at: number }> = [];
  const rows = new Map<WseTimeframe, Candle[]>();
  for (const tf of ["1m", "5m", "1h", "4h", "1d", "1w"] as WseTimeframe[]) {
    const start = tf === "1h" ? "2026-09-24T10:00:00Z" : tf === "4h" ? "2026-09-24T07:00:00Z" : "2026-09-14T07:00:00Z";
    rows.set(tf, Array.from({length: 220}, () => ({ ...candle(tf), ts: new Date(start) })));
  }
  const refresh = new WseNativeRefresh({ now: () => clock, read: async (_conid, tf) => rows.get(tf)!,
    fetch: async (_sub, tf) => { fetched.push({ tf, at: clock }); return []; }, write: async () => {} });
  await refresh.run([sub]);
  assert.equal(fetched.some(x => x.tf === "1h" || x.tf === "4h"), false);
  clock = Date.parse("2026-09-24T12:00:00Z"); await refresh.run([sub]);
  assert.ok(fetched.some(x => x.tf === "1h" && x.at === clock));
  clock = Date.parse("2026-09-24T15:00:00Z"); await refresh.run([sub]);
  assert.ok(fetched.some(x => x.tf === "4h" && x.at === clock));
});
