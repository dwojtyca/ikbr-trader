import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import Fastify from 'fastify';
import { observePostgresPoolErrors } from '@ikbr/shared/diagnostics';
import { AccountingSourceOwner } from './accounting/source-owner.js';
import { AccountingSourceStore } from './accounting/source-store.js';
import { accountingHash, type SourceSettingsV1 } from './accounting/types.js';
import { runMigrations } from './migrations.js';
import { withRuntimeOwnerPermit } from './runtime-owner-permit.js';

const url = process.env.TEST_POSTGRES_URL;
test('real checked-out backend loss preserves HTTP, rejects sends and fails source persistence', { skip: !url }, async () => {
  const target = new URL(url!);
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && (target.pathname === '/ikbr_owner_recovery_test' || process.env.CI === 'true'));
  const database = `pg_failure_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url });
  await admin.query(`CREATE DATABASE ${database}`); target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.href }), errors: Error[] = [];
  observePostgresPoolErrors(pool, error => errors.push(error));
  const app = Fastify(); app.get('/health', () => ({ ok: true }));
  const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: 'DU_BACKEND_TEST',
    endpoint: { host: '127.0.0.1', port: 45674 }, sourceClientId: 0, executionTimeZone: 'UTC' };
  const sourceId = accountingHash({ account: settings.accountId, kind: 'tws-accounting' }), session = randomUUID();
  const owner = new AccountingSourceOwner(pool, settings, undefined, { processSessionId: session, settingsHash: 'a'.repeat(64), sourceId });
  const terminate = async (db: Pick<PoolClient, 'query' | 'once'>) => {
    const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const failed = new Promise<void>(resolve => db.once('error', () => resolve()));
    assert.equal((await admin.query('SELECT pg_terminate_backend($1) AS terminated', [pid])).rows[0].terminated, true);
    await failed;
  };
  try {
    await runMigrations(pool); await owner.acquire();
    const store = new AccountingSourceStore(pool, sourceId, session); store.owner = owner; await store.begin(settings.accountId, 'a'.repeat(64));
    let sends = 0;
    await assert.rejects(withRuntimeOwnerPermit(pool, {
      assertCurrent: () => owner.assertCurrent(),
      assertInTransaction: async db => { await owner.assertInTransaction(db); await terminate(db as PoolClient); },
    }, () => { sends++; }), /terminat|connection/i);
    assert.equal(sends, 0);
    const dyingPermit = { connect: async () => {
      const db = await pool.connect(), query = db.query.bind(db);
      db.query = (async (...args: unknown[]) => {
        if (args[0] === 'COMMIT') await terminate(db);
        return (query as (...args: unknown[]) => Promise<unknown>)(...args);
      }) as PoolClient['query'];
      return db;
    } };
    await assert.rejects(withRuntimeOwnerPermit(dyingPermit, owner, () => { sends++; }), /terminat|connection|queryable/i);
    assert.equal(sends, 1);
    await assert.rejects(store.transaction(async db => { await terminate(db); await db.query('SELECT 1'); }), /terminat|connection|queryable/i);
    await store.gap(1, 'ACCOUNTING_CLOCK_INVALID');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM broker_accounting_observations')).rows[0].n, 1);
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.ok(errors.length >= 3); assert.ok(errors.some(error => (error as Error & { code?: string }).code === '57P01'));
    owner.assertCurrent(); assert.equal(sends, 1);
  } finally { await app.close(); await owner.release(); await pool.end(); await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); }
});
