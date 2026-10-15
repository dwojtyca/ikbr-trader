import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { seedTwoSourceResearchStore } from '@ikbr/shared/instrument-research-testfixture';
import { assertResearchResumeAllowed } from './research-entry-guard.js';
import { runMigrations } from './migrations.js';
const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (pool: Pool, advance: () => Promise<void>) => Promise<void>) {
  const url = new URL(connection!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.ok(url.port === '55432' || process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci');
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.href }), name = 'research_resume_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE DATABASE ${name}`); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: url.href, options: '-c search_path=public,pg_catalog' });
  try {
    await pool.query('CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)');
    await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
    await runMigrations(pool);
    await run(pool, async () => { await pool.query('UPDATE fixture_clock SET offset_ms=offset_ms+3601000'); });
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
test('final resume rechecks durable research after earlier READY preparation', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool);
  assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
  await advance(); await f.observe();
  const claim = await f.store.claimMarketauxAttempt(f.identity); assert.ok(claim.claimed);
  await f.store.finishMarketauxFailure(claim.ticket, { reason: 'RESEARCH_SOURCE_TIMEOUT', outcome: 'UNKNOWN' }, f.empty);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await assert.rejects(assertResearchResumeAllowed({ db, store: f.store, identity: f.identity, manifest: f.manifest,
      accountId: f.identity.accountId, instrumentIds: [f.policy.instrumentId] }), /RESEARCH_REQUIRED_COVERAGE_UNAVAILABLE/);
  } finally { await db.query('ROLLBACK'); db.release(); }
}));
test('resume holds source admission until its transaction completes without a publication deadlock', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool); await advance(); await f.observe();
  const claim = await f.store.claimMarketauxAttempt(f.identity); assert.ok(claim.claimed);
  const db = await pool.connect(); let publication: Promise<unknown> | undefined;
  try {
    await db.query('BEGIN');
    const deadline = await assertResearchResumeAllowed({ db, store: f.store, identity: f.identity, manifest: f.manifest,
      accountId: f.identity.accountId, instrumentIds: [f.policy.instrumentId] });
    assert.ok(deadline > Date.now());
    let published = false;
    publication = f.publishNews(claim.ticket).then(() => { published = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(published, false);
    await db.query('COMMIT'); await publication;
    assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
  } finally { await db.query('ROLLBACK'); db.release(); await publication; }
}));
