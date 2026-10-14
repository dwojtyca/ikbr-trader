import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readPeriodicProof } from './periodic-proof.js';
import { emitBrokerPhase, type BrokerPhaseEvent } from './phase-diagnostics.js';

const connection = process.env.TEST_POSTGRES_URL;
test('actual PostgreSQL BIGSERIAL run ID passes production periodic proof and diagnostic boundaries', { skip: !connection }, async () => {
  const url = new URL(connection!), database = `periodic_id_${randomUUID().replaceAll('-', '')}`;
  url.pathname = '/postgres'; const admin = new Pool({ connectionString: url.href });
  url.pathname = `/${database}`; const pool = new Pool({ connectionString: url.href });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    await pool.query(`CREATE TABLE reconciliation_runs(id BIGSERIAL PRIMARY KEY,account_id TEXT NOT NULL,session_id TEXT NOT NULL,
      status TEXT NOT NULL,broker_snapshot JSONB NOT NULL,started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE reconciliation_holds(account_id TEXT NOT NULL,active BOOLEAN NOT NULL);`);
    const now = (await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
    const context = { accountId: 'TEST-PERIODIC', sessionId: 'test-session', sessionStartedAt: now };
    const snapshot = { accountId: context.accountId, sessionId: context.sessionId, connectionGeneration: 1,
      originalAcquisitionStartedAt: now.toISOString(), exposureComplete: true, recoveryComplete: true, accounting: { captureId: 'test-capture' } };
    const inserted = await pool.query<{ id: number }>(`INSERT INTO reconciliation_runs(account_id,session_id,status,broker_snapshot)
      VALUES($1,$2,'CLEAN',$3) RETURNING id`, [context.accountId, context.sessionId, snapshot]);
    const actualDriverId = inserted.rows[0].id;
    assert.equal(typeof actualDriverId, 'string', 'pg BIGSERIAL is a string despite the repository-style TypeScript annotation');
    let accountingChecks = 0;
    const dependencies = { db: pool, currentIdentity: () => ({ connected: true, accountId: context.accountId, sessionId: context.sessionId, generation: 1 }),
      accounting: () => ({ assertCurrent: (reference: unknown) => { assert.deepEqual(reference, snapshot.accounting); accountingChecks++; } }) };
    const expected = { generation: 1, acquiredAt: now.getTime() };
    assert.deepEqual(await readPeriodicProof(dependencies, context, actualDriverId), expected);
    assert.deepEqual(await readPeriodicProof(dependencies, context, Number(actualDriverId)), expected);
    assert.equal(accountingChecks, 2);
    assert.equal(await readPeriodicProof(dependencies, context, String(Number(actualDriverId) + 1)), null);
    const events: BrokerPhaseEvent[] = [];
    emitBrokerPhase({ emit: event => events.push(event) }, 'scheduler.capture', 'skipped', { runId: actualDriverId, caller: 'periodic' });
    assert.equal(events[0].runId, Number(actualDriverId)); assert.equal(typeof events[0].runId, 'number');
    await pool.query('INSERT INTO reconciliation_holds(account_id,active) VALUES($1,true)', [context.accountId]);
    assert.equal(await readPeriodicProof(dependencies, context, actualDriverId), null);
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
});
