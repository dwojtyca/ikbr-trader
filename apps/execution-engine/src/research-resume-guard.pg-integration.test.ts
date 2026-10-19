import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { seedTwoSourceResearchStore } from '@ikbr/shared/instrument-research-testfixture';
import { parseWshConfig, wshRequestDates, wshReceiptPolicy, researchHash } from '@ikbr/shared/instrument-research';
import { assertResearchResumeAllowed } from './research-entry-guard.js';
import { runMigrations } from './migrations.js';
const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (pool: Pool, advance: () => Promise<void>) => Promise<void>) {
  const url = new URL(connection!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.ok(url.port === '55432' || url.port === '55434' && url.pathname === '/ikbr_startup_recovery_test' || process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci');
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

async function publishUnknownCleanup(f: Awaited<ReturnType<typeof seedTwoSourceResearchStore>>) {
  let attemptId = '';
  const config = parseWshConfig(f.wshSource, f.policy);
  await f.store.withWshEndpointLock(config.endpointId, async lease => {
    const claimed = await f.store.claimWshAttempt(lease, { ...f.identity, sourceId: f.wshSource.id, sessionId: randomUUID() }, 'regular');
    assert.equal(claimed.state, 'CLAIMED'); if (claimed.state !== 'CLAIMED') return;
    const ticket = claimed.ticket; attemptId = ticket.id; await f.store.confirmWshPreflight(lease, ticket);
    const base = { ...f.identity, provider: 'ibkr-wsh', kind: 'source' as const, reservedCostMicros: 0, maxRequestsPerDay: f.wshSource.maxRequestsPerDay, maxCostMicrosPerDay: f.wshSource.maxCostMicrosPerDay };
    const meta = { ...base, callKey: 'meta_' + randomUUID(), requestHash: 'a'.repeat(64), deadlineAt: new Date(await f.clock() + 9000).toISOString() };
    const acquisition = await f.store.beginWshAcquisition(lease, { ...f.identity, sourceId: f.wshSource.id, sessionId: ticket.sessionId, reservation: meta }, ticket);
    await f.store.recordCallOutcome(meta.callKey, 'SUCCEEDED');
    const now = new Date(await f.clock()).toISOString(), dates = wshRequestDates(config, now), requestHash = researchHash({ endpointId: config.endpointId, sessionId: ticket.sessionId, requestId: 2, method: 'reqWshEventData', request: {
      conId: config.conId, filter: '', fillWatchlist: false, fillPortfolio: false, fillCompetitors: false, ...dates, totalLimit: 100 } });
    await f.store.reserveWshCall(lease, acquisition, { ...base, callKey: 'events_' + randomUUID(), requestHash, deadlineAt: new Date(await f.clock() + 9000).toISOString() });
    const snapshot = f.empty(now);
    snapshot.coverage.push({ sourceId: f.wshSource.id, role: 'calendar', status: 'EMPTY', complete: true, checkedAt: now, windowStart: now, windowEnd: now, evidenceRefs: [], reason: 'RESEARCH_WSH_PROVIDER_QUERY_COMPLETE',
      wshAcquisition: { ...wshReceiptPolicy(config), coverageBasis: 'PROVIDER_REPORTED_QUERY', acquisitionId: acquisition.id, generation: acquisition.generation, sessionId: ticket.sessionId,
        requestId: 2, requestAsOf: now, requestStartDate: dates.startDate, requestEndDate: dates.endDate, totalLimit: 100, rowCount: 0, duplicateCount: 0, requestHash, receiptHash: 'e'.repeat(64), metadataHash: config.qualification.metadataHash } });
    await f.store.publishWshSnapshot(lease, acquisition, snapshot);
    await f.store.finishWshAttempt(lease, ticket, { outcome: 'SUCCEEDED', acquisition, cleanup: { sessionId: ticket.sessionId, state: 'UNKNOWN', verifiedLocalClosure: false,
      completedAt: now, cancellationAttemptedAt: now, disconnectRequestedAt: now, localClosedAt: null } });
  }); return attemptId;
}

test('final resume denies a PREPARED recovery hold despite still eligible cached research', { skip: !connection }, () => isolated(async pool => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false });
  await publishUnknownCleanup(f);
  assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
  await pool.query('INSERT INTO execution_entry_controls(account_id) VALUES($1)', [f.accountId]);
  await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds' WHERE service='llm-agent'");
  const challenge = await f.store.prepareResearchRecovery({ ...f.identity, sourceId: f.wshSource.id, kind: 'WSH_ENDPOINT_RESET', pauseRevision: 1, actor: 'operator:test', operationId: randomUUID() });
  await f.observe();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await assert.rejects(assertResearchResumeAllowed({ db, store: f.store, identity: f.identity, manifest: f.manifest,
      accountId: f.identity.accountId, instrumentIds: [f.policy.instrumentId] }), /RESEARCH_REQUIRED_COVERAGE_UNAVAILABLE/);
  } finally { await db.query('ROLLBACK'); db.release(); }
  assert.equal((await f.store.readResearchRecovery(challenge.id))?.state, 'PREPARED');
}));
