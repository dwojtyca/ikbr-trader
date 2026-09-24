import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { sessionNativeSource, type Candle } from '@ikbr/shared';
import { MarketRepository } from './db.js';
import { sessionIdentityFixture, sessionEvidenceFixture } from './session-fixture.js';
const connection = process.env.TEST_POSTGRES_URL;
test('generic schedule migration preserves legacy metadata and isolates contracts, modes and generations', { skip: !connection }, async () => {
  const database = `sessions_${randomUUID().replaceAll('-', '')}`, url = new URL(connection!); url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`; const pool = new Pool({ connectionString: url.toString() });
  try {
    await pool.query(`CREATE TABLE instrument_contracts (symbol text PRIMARY KEY,conid text NOT NULL,sec_type text NOT NULL,
      exchange text,primary_exchange text,currency text,local_symbol text,trading_class text,min_tick double precision,display_name text,
      contract_json jsonb,details_json jsonb,source text NOT NULL,resolved_at timestamptz NOT NULL DEFAULT NOW());
      CREATE UNIQUE INDEX instrument_contracts_conid_idx ON instrument_contracts(conid);
      INSERT INTO instrument_contracts(symbol,conid,sec_type,source) VALUES('SAME','101','FUT','ibkr')`);
    const migration = await readFile(new URL('../../../infra/sql/migrations/000015_instrument_session_schedules.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    assert.equal((await pool.query("SELECT source FROM instrument_contracts WHERE conid='101'")).rows[0].source, 'ibkr');
    const repo = new MarketRepository(pool); await repo.init();
    await repo.upsertInstrumentContract({ symbol: 'SAME', conid: '102', secType: 'FUT', source: 'ibkr' });
    await repo.upsertInstrumentContract({ symbol: 'SAME', conid: '101', secType: 'FUT', source: 'ibkr', localSymbol: 'UPDATED' });
    assert.equal((await pool.query("SELECT * FROM instrument_contracts WHERE symbol='SAME'")).rowCount, 2);
    assert.equal((await pool.query("SELECT local_symbol FROM instrument_contracts WHERE conid='101'")).rows[0].local_symbol, 'UPDATED');
    const a = sessionIdentityFixture(), b = sessionIdentityFixture({ conId: 999 }), mode = { ...a, useRTH: false };
    const ga = await repo.beginSessionSchedule(a, 'REFRESHING'), gb = await repo.beginSessionSchedule(b, 'REFRESHING');
    assert.equal(await repo.finishSessionSchedule(a, ga, sessionEvidenceFixture(a).schedule!), true);
    assert.equal((await repo.getSessionSchedule(b))?.status, 'REFRESHING');
    assert.equal(await repo.getSessionSchedule(mode), null);
    await repo.beginSessionSchedule(a, 'FAILED'); assert.equal(await repo.finishSessionSchedule(a, ga, sessionEvidenceFixture(a).schedule!), false);
    assert.equal(await repo.finishSessionSchedule(b, gb, sessionEvidenceFixture(b).schedule!), true);
    const gm = await repo.beginSessionSchedule(mode, 'REFRESHING'); await repo.finishSessionSchedule(mode, gm, sessionEvidenceFixture(mode).schedule!);
    assert.equal((await repo.getSessionSchedule(a))?.status, 'FAILED'); assert.equal((await repo.getSessionSchedule(mode))?.status, 'READY');
    const candle: Candle = { conid: String(a.conId), symbol: a.symbol, timeframe: '1m', ts: new Date('2026-09-24T13:30:00Z'),
      open: 100, high: 101, low: 99, close: 100, volume: 2, source: sessionNativeSource(a) };
    await repo.upsertCandle(candle);
    for (const source of [undefined, 'ibkr_aapl_rth_native_v1', 'ibkr_wse_native_v1', 'aggregate']) await repo.upsertCandle({ ...candle, close: 99, source });
    assert.deepEqual(await repo.getSessionCandles(a, '1m', 1), [candle]);
    for (let i = 1; i <= 10; i++) await repo.upsertCandle({ ...candle, ts: new Date(candle.ts.getTime() + i * 60000), source: sessionNativeSource(mode) });
    assert.deepEqual(await repo.getSessionCandles(a, '1m', 1), [candle]);
    assert.equal((await repo.getSessionCandles(mode, '1m', 1))[0].source, sessionNativeSource(mode));
    assert.deepEqual(await repo.getSessionCandles(b, '1m', 10), []);
  } finally {
    const disconnected = new Promise<void>(resolve => { let remaining = pool.totalCount;
      if (!remaining) return resolve(); pool.on('remove', () => { if (--remaining === 0) resolve(); }); });
    await pool.end(); await disconnected;
    try { await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }
});
test('ingestion startup and the real migration runner serialize metadata DDL on the same advisory lock', { skip: !connection }, async () => {
  const database = `session_ddl_${randomUUID().replaceAll('-', '')}`, url = new URL(connection!); url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`; const pool = new Pool({ connectionString: url.toString() });
  const migrationModule = new URL('../../execution-engine/src/migrations.ts', import.meta.url).href;
  const { runMigrations } = await import(migrationModule) as { runMigrations(pool: Pool): Promise<unknown> };
  const gate = await pool.connect(), lock = 0x69_6b_62_72_31_34_32n.toString();
  const running: Promise<unknown>[] = [];
  try {
    await pool.query(`CREATE TABLE instrument_contracts (symbol text PRIMARY KEY,conid text NOT NULL,sec_type text NOT NULL,
      exchange text,primary_exchange text,currency text,local_symbol text,trading_class text,min_tick double precision,display_name text,
      contract_json jsonb,details_json jsonb,source text NOT NULL,resolved_at timestamptz NOT NULL DEFAULT NOW());
      CREATE UNIQUE INDEX instrument_contracts_conid_idx ON instrument_contracts(conid);
      INSERT INTO instrument_contracts(symbol,conid,sec_type,source) VALUES('ROOT','101','FUT','ibkr')`);
    await gate.query('SELECT pg_advisory_lock($1)', [lock]);
    running.push(new MarketRepository(pool).init(), runMigrations(pool));
    let waiters = 0;
    for (let attempt = 0; attempt < 100 && waiters < 2; attempt++) {
      const row = await admin.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND wait_event='advisory'", [database]);
      waiters = row.rows[0].count;
      if (waiters < 2) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiters, 2, 'both production startup paths must wait on the same migration lock');
    await gate.query('SELECT pg_advisory_unlock($1)', [lock]);
    await Promise.all(running);
    const keys = await pool.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='instrument_contracts'::regclass AND contype='p'");
    assert.equal(keys.rows[0].definition, 'PRIMARY KEY (conid)');
    assert.equal((await pool.query("SELECT symbol FROM instrument_contracts WHERE conid='101'")).rows[0].symbol, 'ROOT');
    await new MarketRepository(pool).upsertInstrumentContract({ symbol: 'ROOT', conid: '102', secType: 'FUT', source: 'ibkr' });
    assert.equal((await pool.query("SELECT * FROM instrument_contracts WHERE symbol='ROOT'")).rowCount, 2);
  } finally {
    await gate.query('SELECT pg_advisory_unlock($1)', [lock]); gate.release();
    await Promise.allSettled(running);
    const disconnected = new Promise<void>(resolve => { let remaining = pool.totalCount;
      if (!remaining) return resolve(); pool.on('remove', () => { if (--remaining === 0) resolve(); }); });
    await pool.end(); await disconnected;
    try { await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
  }
});
