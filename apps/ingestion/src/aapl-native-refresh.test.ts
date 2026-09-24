import { scheduleFixture } from "./aapl-schedule-fixture.js";
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
  const refresh = new AaplNativeRefresh({ schedule: async () => scheduleFixture(now), readSchedule: async () => scheduleFixture(now), now: () => now,
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
  const refresh = new AaplNativeRefresh({ schedule: async () => scheduleFixture(now), readSchedule: async () => scheduleFixture(now), now: () => now, read: async () => [],
    fetch: async (_sub, tf) => [{ ...candle(tf), conid: "wrong" }, { ...candle(tf), source: undefined },
      { ...candle(tf), ts: new Date(now) }, { ...candle(tf), low: 102 }], write: async () => { writes++; } });
  await refresh.run([sub]); assert.equal(writes, 0);
  for (const patch of [{ instrumentId: "other" }, { symbol: "OTHER" }, { conid: "123" },
    { contract: { ...sub.contract, currency: "PLN" } }, { contract: { ...sub.contract, conId: 123 } }])
    assert.equal(isAaplSubscription({ ...sub, ...patch }), false);
});
test("pacing errors remain visible and repeated bootstrap cannot bypass bounded failure backoff", async () => {
  let clock = now, calls = 0;
  const refresh = new AaplNativeRefresh({ schedule: async () => scheduleFixture(now), readSchedule: async () => scheduleFixture(now), now: () => clock, read: async () => [], fetch: async () => { calls++; throw new Error("historicalData error 162"); }, write: async () => {} });
  await refresh.run([sub]); assert.equal(calls, 6);
  assert.match(refresh.status.get(`${sub.conid}:1m`)?.error ?? "", /162/);
  await refresh.run([sub]); assert.equal(calls, 6);
  clock += 59999; await refresh.run([sub], true); assert.equal(calls, 6);
  clock++; await refresh.run([sub]); assert.equal(calls, 12);
  clock += 240000; await refresh.run([sub]); assert.equal(calls, 18);
});
test("freshness status never labels old but numerous closed bars ready", async () => {
  const refresh = new AaplNativeRefresh({ schedule: async () => scheduleFixture(now), readSchedule: async () => scheduleFixture(now), now: () => now, read: async (_conid, tf) => Array.from({ length: 230 }, (_, i) => ({
    ...candle(tf), ts: new Date(tf === "1d" || tf === "1w" ? `2025-01-${String(6 + i % 5).padStart(2, "0")}T05:00:00Z` : `2025-01-06T14:${String(30 + i % 30).padStart(2, "0")}:00Z`),
  })), fetch: async () => [], write: async () => {} });
  await refresh.run([sub]);
  for (const status of refresh.status.values()) assert.ok(status.error);
});
test("newly closed boundary fetch is not suppressed by the previous higher-timeframe fetch", async () => {
  let clock = Date.parse("2026-09-24T15:59:30Z");
  const requests: Array<{ tf: AaplTimeframe; at: number }> = [];
  const refresh = new AaplNativeRefresh({ schedule: async () => scheduleFixture(clock), readSchedule: async () => scheduleFixture(clock),
    now: () => clock, read: async () => [], fetch: async (_sub, tf) => { requests.push({ tf, at: clock }); return []; }, write: async () => {} });
  await refresh.run([sub]);
  clock = Date.parse("2026-09-24T16:00:00Z"); await refresh.run([sub]);
  clock = Date.parse("2026-09-24T16:00:30Z"); await refresh.run([sub]);
  assert.ok(requests.some(x => x.tf === "4h" && x.at === clock));
});
test("missing schedule and concurrent invalidation cannot persist fetched shortened buckets", async () => {
  let writes = 0, calls = 0;
  const missing = new AaplNativeRefresh({ schedule: async () => null, readSchedule: async () => null,
    now: () => now, read: async () => [], fetch: async () => { calls++; return []; }, write: async () => { writes++; } });
  await missing.run([sub]); assert.equal(calls, 0); assert.equal(writes, 0);
  let evidence = scheduleFixture(now);
  const raced = new AaplNativeRefresh({ schedule: async () => evidence, readSchedule: async () => evidence,
    now: () => now, read: async () => [], fetch: async (_sub, tf) => { evidence = { ...evidence, generation: evidence.generation + 1, status: 'FAILED' }; return [candle(tf)]; },
    write: async () => { writes++; } });
  await raced.run([sub]); assert.equal(writes, 0);
  assert.match(raced.status.get(`${sub.conid}:1m`)?.error ?? '', /schedule/);
});
test("opening four-hour bucket is persisted at noon, not four hours after open", async () => {
  let clock = Date.parse('2026-09-24T15:59:59Z');
  const writes: Candle[] = [];
  const refresh = new AaplNativeRefresh({ schedule: async () => scheduleFixture(clock), readSchedule: async () => scheduleFixture(clock), now: () => clock,
    read: async () => [], fetch: async (_sub, tf) => tf === '4h' ? [{ ...candle(tf), ts: new Date('2026-09-24T13:30:00Z') }] : [], write: async c => { writes.push(c); } });
  await refresh.run([sub]); assert.equal(writes.length, 0);
  clock += 60000; await refresh.run([sub]); assert.equal(writes.length, 1); assert.equal(writes[0].timeframe, '4h');
});
test("warmed pre-open native history does not refetch six timeframes on each minute", async () => {
  const { AAPL_REQUIRED_CANDLES, aaplExpectedSlot, newYorkMidnight, validClosedAaplCandle } = await import('@ikbr/shared');
  let clock = Date.parse('2026-09-24T13:27:00Z'), calls = 0;
  const rows = new Map<AaplTimeframe, Candle[]>();
  for (const tf of Object.keys(AAPL_REQUIRED_CANDLES) as AaplTimeframe[]) {
    const values: Candle[] = [];
    for (let i = 0; i < 560; i++) {
      const day = new Date(Date.UTC(2024, 0, 1 + i));
      if ([0, 6].includes(day.getUTCDay()) || (tf === '1w' && day.getUTCDay() !== 5)) continue;
      const midnight = newYorkMidnight(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      const value = { ...candle(tf), ts: new Date(midnight.getTime() + (tf === '1d' || tf === '1w' ? 0 : 9.5 * 3600000)) };
      if (validClosedAaplCandle(value, clock)) values.push(value);
    }
    const expected = aaplExpectedSlot(tf, scheduleFixture(clock).schedule!, clock)!;
    rows.set(tf, [...values.slice(-(AAPL_REQUIRED_CANDLES[tf] - 1)), { ...candle(tf), ts: new Date(expected.start) }]);
  }
  const refresh = new AaplNativeRefresh({ schedule: async () => scheduleFixture(clock), readSchedule: async () => scheduleFixture(clock), now: () => clock,
    read: async (_conid, tf) => rows.get(tf)!, fetch: async () => { calls++; return []; }, write: async () => {} });
  await refresh.run([sub]); clock += 60000; await refresh.run([sub]); clock += 60000; await refresh.run([sub]);
  assert.equal(calls, 0);
  for (const status of refresh.status.values()) assert.ok(status.error);
});
test('schedule repository failure replaces old warmup readiness without broker work or unhandled rejection', async () => {
  let fail = false, fetches = 0;
  const refresh = new AaplNativeRefresh({ now: () => now,
    schedule: async () => { if (fail) throw new Error('schedule_database_unavailable'); return scheduleFixture(now); },
    readSchedule: async () => scheduleFixture(now), read: async () => [], fetch: async () => { fetches++; return []; }, write: async () => {} });
  await refresh.run([sub]); const before = fetches; fail = true;
  await refresh.run([sub]); assert.equal(fetches, before);
  for (const status of refresh.status.values()) {
    assert.equal(status.scheduleStatus, 'FAILED'); assert.equal(status.error, 'schedule_database_unavailable'); assert.equal(status.nativeClosed, 0);
  }
});
