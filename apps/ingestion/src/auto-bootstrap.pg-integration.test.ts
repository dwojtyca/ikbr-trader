import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { MarketRepository } from './db.js';
const connection = process.env.TEST_POSTGRES_URL;

test('ingestion stop survives repeated startup and enforces exactly one control row', { skip: !connection }, async () => {
  const database = `ingestion_control_${randomUUID().replaceAll('-', '')}`, url = new URL(connection!);
  url.pathname = '/postgres'; const admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${database}`); url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    const first = new MarketRepository(pool); await first.init(); assert.equal(await first.readIngestionStopped(), false);
    await first.writeIngestionStopped(true);
    const restarted = new MarketRepository(pool); await restarted.init(); assert.equal(await restarted.readIngestionStopped(), true);
    await assert.rejects(pool.query('INSERT INTO ingestion_auto_control(singleton,manually_stopped) VALUES(false,false)'), /check constraint/);
    await assert.rejects(pool.query('INSERT INTO ingestion_auto_control(singleton,manually_stopped) VALUES(true,false)'), /unique constraint/);
    await restarted.writeIngestionStopped(false); assert.equal(await first.readIngestionStopped(), false);
    await pool.query('DELETE FROM ingestion_auto_control');
    await assert.rejects(first.readIngestionStopped(), /UNAVAILABLE/);
    await assert.rejects(first.writeIngestionStopped(false), /UNAVAILABLE/);
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end();
  }
});
