import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { AAPL_NATIVE_SOURCE, type Candle } from "@ikbr/shared";
import { MarketRepository } from "./db.js";
const connection = process.env.TEST_POSTGRES_URL;
test("source filter precedes LIMIT and provisional writes cannot overwrite canonical AAPL history", { skip: !connection }, async () => {
  const database = `aapl_native_${randomUUID().replaceAll("-", "")}`, url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`; const pool = new Pool({ connectionString: url.toString() });
  try {
    const repo = new MarketRepository(pool); await repo.init();
    const native: Candle = { conid: "265598", symbol: "AAPL", timeframe: "1m", ts: new Date("2026-09-24T13:30:00Z"),
      open: 100, high: 101, low: 99, close: 100, volume: 10, source: AAPL_NATIVE_SOURCE };
    await repo.upsertCandle({ ...native, symbol: "OLD", close: 99, source: undefined });
    await repo.upsertCandle(native);
    for (let i = 1; i <= 20; i++) await repo.upsertCandle({ ...native, ts: new Date(native.ts.getTime() + i * 60000), source: undefined });
    const read = await repo.getNativeAaplCandles("265598", "1m", 1);
    assert.deepEqual(read, [native]);
    await repo.upsertCandle({ ...native, close: 99, volume: 999, source: undefined });
    await repo.upsertCandle({ ...native, close: 99, source: "aggregate" });
    assert.deepEqual(await repo.getNativeAaplCandles("265598", "1m", 1), [native]);
    await repo.upsertCandle({ ...native, close: 100.5 });
    assert.equal((await repo.getNativeAaplCandles("265598", "1m", 1))[0].close, 100.5);
    assert.deepEqual(await repo.getNativeWseCandles("265598", "1m", 10), []);
    const other = { ...native, conid: "123", symbol: "OTHER", source: undefined };
    await repo.upsertCandle(other); await repo.upsertCandle({ ...other, close: 99 });
    assert.equal(Number((await pool.query("SELECT close FROM candles_1m WHERE conid='123'")).rows[0].close), 99);
  } finally {
    const disconnected = new Promise<void>(resolve => { let remaining = pool.totalCount;
      if (!remaining) return resolve(); pool.on("remove", () => { if (--remaining === 0) resolve(); }); });
    await pool.end(); await disconnected;
    try { await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }
});
