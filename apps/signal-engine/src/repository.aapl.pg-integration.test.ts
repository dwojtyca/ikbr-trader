import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { AAPL_NATIVE_SOURCE } from '@ikbr/shared';
import { nativeAaplSchedule } from './runtime/strategy/aapl-native.fixture.js';
import { SignalRepository } from './repository.js';

it('AAPL provenance and exact contract filter precede SQL LIMIT without changing WSE reads',
  { skip: !process.env.TEST_POSTGRES_URL }, async () => {
    const schema = `aapl_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: process.env.TEST_POSTGRES_URL });
    const pool = new Pool({ connectionString: process.env.TEST_POSTGRES_URL, options: `-c search_path=${schema}` });
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`CREATE TABLE candles_1m (conid text, symbol text, ts timestamptz,
        open numeric, high numeric, low numeric, close numeric, volume numeric, source text)`);
      await pool.query(`INSERT INTO candles_1m SELECT '265598','AAPL', '2026-09-24 15:00Z'::timestamptz + n * interval '1 minute',
        200,201,199,200,100,'legacy' FROM generate_series(1,100) n`);
      for (const [conid, symbol, source] of [['265598','AAPL',AAPL_NATIVE_SOURCE], ['123','AAPL',AAPL_NATIVE_SOURCE],
        ['265598','WRONG',AAPL_NATIVE_SOURCE], ['35146360','PKO','ibkr_wse_native_v1']]) {
        await pool.query(`INSERT INTO candles_1m SELECT $1,$2,'2026-09-24 14:00Z'::timestamptz + n * interval '1 minute',
          200,201,199,200,100,$3 FROM generate_series(1,3) n`, [conid,symbol,source]);
      }
      const repo = new SignalRepository(pool, {} as Redis);
      await pool.query(`CREATE TABLE aapl_schedule_state (instrument_id text PRIMARY KEY, generation bigint NOT NULL, status text, evidence jsonb, updated_at timestamptz)`);
      assert.equal(await repo.getAaplScheduleEvidence(), null);
      const calendar = nativeAaplSchedule();
      await pool.query(`INSERT INTO aapl_schedule_state VALUES ('aapl_nasdaq', $1, $2, $3, $4)`, [calendar.generation, calendar.status, JSON.stringify(calendar.schedule), calendar.updatedAt]);
      assert.deepEqual(await repo.getAaplScheduleEvidence(), calendar);
      await pool.query(`UPDATE aapl_schedule_state SET generation=generation+1, status='REFRESHING', evidence=NULL`);
      assert.deepEqual(await repo.getAaplScheduleEvidence(), { ...calendar, generation: 2, status: 'REFRESHING', schedule: null });
      const native = await repo.getRecentCandlesForContract('AAPL', '265598', '1m', 2, false, AAPL_NATIVE_SOURCE);
      assert.deepEqual(native.map(c => [c.conid,c.symbol,c.source,c.ts.toISOString()]), [
        ['265598','AAPL',AAPL_NATIVE_SOURCE,'2026-09-24T14:02:00.000Z'],
        ['265598','AAPL',AAPL_NATIVE_SOURCE,'2026-09-24T14:03:00.000Z'],
      ]);
      assert.equal((await repo.getRecentCandlesForContract('AAPL','265598','1m',2))[0].source, 'legacy');
      const wse = await repo.getRecentCandlesForContract('PKO','35146360','1m',2,true);
      assert.equal(wse.length, 2); assert.ok(wse.every(c => c.source === 'ibkr_wse_native_v1'));
    } finally {
      await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
    }
  });
