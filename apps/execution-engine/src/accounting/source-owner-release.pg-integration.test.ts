import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { AccountingSourceOwner } from './source-owner.js';
import type { SourceSettingsV1 } from './types.js';

const connection = process.env.TEST_POSTGRES_URL;
async function isolated(port: number, run: (pool: Pool, settings: SourceSettingsV1) => Promise<void>) {
  const url = new URL(connection!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) &&
    (url.port === '55434' && url.pathname === '/ikbr_startup_recovery_test' ||
      process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci'));
  const schema = 'owner_release_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8 });
  try {
    await pool.query(`CREATE TABLE accounting_source_owners(endpoint_key text PRIMARY KEY,owner_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),
      retirement_state text NOT NULL CHECK(retirement_state IN ('ACTIVE','RETIRED','UNKNOWN')),acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      retired_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    await run(pool, { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: 'TEST-RELEASE',
      endpoint: { host: '127.0.0.1', port }, sourceClientId: 0, executionTimeZone: 'UTC' });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}

async function delayedTeardown(pool: Pool, settings: SourceSettingsV1) {
  const client = await pool.connect(), destroy = client.release.bind(client);
  const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  let destructions = 0;
  client.release = (error?: Error | boolean) => { assert.equal(error, true); destructions++; };
  const owner = new AccountingSourceOwner({ connect: async () => client, query: pool.query.bind(pool) } as unknown as Pool, settings);
  await owner.acquire();
  const fence = owner.fence(), key = BigInt.asIntN(64, BigInt('0x' + createHash('sha256').update(fence.endpointKey).digest('hex').slice(0, 16)));
  const bits = BigInt.asUintN(64, key);
  const locks = async () => Number((await pool.query(`SELECT count(*) AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory'
    AND classid=$2::oid AND objid=$3::oid AND objsubid=1 AND granted`, [pid, (bits >> 32n).toString(), (bits & 0xffffffffn).toString()])).rows[0].n);
  return { owner, client, pid, key, fence, locks, destructions: () => destructions, destroy: () => destroy(true) };
}

test('acknowledged release permits immediate replacement while old PostgreSQL transport is still open', { skip: !connection }, () => isolated(58091, async (pool, settings) => {
  const f = await delayedTeardown(pool, settings), replacement = new AccountingSourceOwner(pool, settings);
  try {
    assert.equal(await f.locks(), 1);
    await f.owner.retire(true); await f.owner.release();
    assert.equal(f.destructions(), 1);
    assert.equal(await f.locks(), 0);
    assert.equal((await pool.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [f.pid])).rowCount, 1);
    await replacement.acquire(); assert.equal(replacement.fence().generation, f.fence.generation + 1);
    await replacement.retire(true); await replacement.release();
    await f.owner.release(); assert.equal(f.destructions(), 1);
  } finally { f.destroy(); await replacement.release(); }
}));

test('pending unlock fences local use and competing acquisition; concurrent releases issue one unlock', { skip: !connection }, () => isolated(58092, async (pool, settings) => {
  const f = await delayedTeardown(pool, settings), competitor = new AccountingSourceOwner(pool, { ...settings, accountId: 'OTHER' });
  const query = f.client.query.bind(f.client);
  let open!: () => void, entered!: () => void, unlocks = 0;
  const gate = new Promise<void>(resolve => { open = resolve; }), atUnlock = new Promise<void>(resolve => { entered = resolve; });
  f.client.query = ((...args: any[]) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (sql?.includes('pg_advisory_unlock')) { unlocks++; entered(); return gate.then(() => (query as any)(...args)); }
    return (query as any)(...args);
  }) as PoolClient['query'];
  let releases: Promise<void>[] = [];
  try {
    await f.owner.retire(true);
    releases = [f.owner.release(), f.owner.release()];
    await atUnlock;
    assert.throws(() => f.owner.assertHeld(), /SOURCE_OWNER_LOST/);
    assert.throws(() => f.owner.assertCurrent(), /SOURCE_OWNER_LOST/);
    assert.equal(f.destructions(), 0); assert.equal(await f.locks(), 1);
    await assert.rejects(competitor.acquire(), /SOURCE_OWNER_CONFLICT/);
    open(); await Promise.all(releases);
    assert.equal(unlocks, 1); assert.equal(f.destructions(), 1); assert.equal(await f.locks(), 0);
    assert.equal((await pool.query('SELECT generation,retirement_state FROM accounting_source_owners')).rows[0].generation, '1');
  } finally { open(); await Promise.allSettled(releases); f.destroy(); await competitor.release(); }
}));

test('stacked advisory lock rejects orderly release without rewriting durable retirement or generation', { skip: !connection }, () => isolated(58093, async (pool, settings) => {
  const f = await delayedTeardown(pool, settings);
  try {
    await f.client.query('SELECT pg_advisory_lock($1::bigint)', [f.key.toString()]);
    await f.owner.retire(true);
    const before = (await pool.query('SELECT row_to_json(o) AS value FROM accounting_source_owners o')).rows[0].value;
    await assert.rejects(f.owner.release(), /SOURCE_OWNER_RELEASE_UNKNOWN/);
    assert.equal(await f.locks(), 1); assert.equal(f.destructions(), 1);
    assert.deepEqual((await pool.query('SELECT row_to_json(o) AS value FROM accounting_source_owners o')).rows[0].value, before);
    assert.throws(() => f.owner.assertHeld(), /SOURCE_OWNER_LOST/);
    await assert.rejects(f.owner.release(), /SOURCE_OWNER_RELEASE_UNKNOWN/);
    assert.equal(f.destructions(), 1);
  } finally { f.destroy(); }
}));
