import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { ResearchStore } from './store.js';
import { twoSourceResearchFixture } from './research.fixture.js';
import { researchHash } from './validation.js';
import { marketauxCallIdentity, type MarketauxPageReceipt, type MarketauxRequestV2 } from './marketaux.js';
import type { MarketauxAttemptTicket } from './marketaux-refresh.js';
import type { TwoSourceResearchSnapshot } from './types.js';
import { loadTradingConfiguration } from '../trading-configuration/loader.js';
import { TradingConfigurationStore } from '../trading-configuration/store.js';
const { Pool } = createRequire(new URL('../../../../apps/llm-agent/package.json', import.meta.url))('pg');
const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (pool: any) => Promise<void>) {
  const url = new URL(connection!);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname) && (url.port === '55432'
    || process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci'), 'Only isolated PostgreSQL allowed');
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.href }), name = 'marketaux_hostile_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE DATABASE ${name}`); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: url.href });
  try {
    const dir = new URL('../../../../infra/sql/migrations/', import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(file, dir), 'utf8'));
    await run(pool);
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function seed(pool: any, budget = 2400) {
  const f = twoSourceResearchFixture(), store = new ResearchStore(pool);
  for (const policy of f.manifest.instruments) policy.sources.find(s => s.adapter === 'marketaux-news')!.maxRequestsPerDay = budget;
  f.manifestHash = researchHash(f.manifest);
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: 'bundle', TRADING_CONFIG_PATH: '/fixture.json', TRADING_CONFIG_EXPECTED_HASH: f.configHash },
    { readFile: () => readFileSync(new URL('../trading-configuration/fixtures/valid-generic.json', import.meta.url), 'utf8') });
  await new TradingConfigurationStore(pool).register({ service: 'execution-engine', processId: randomUUID(), loaded, tradingEnabled: false });
  await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  const observe = async () => {
    for (const service of ['execution-engine', 'llm-agent'] as const)
      await store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: randomUUID(), tradingEnabled: false });
  };
  await observe();
  const identity = { configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId, sourceId: f.source.id, accountId: 'DU_SYNTHETIC' };
  const empty = (at: string): TwoSourceResearchSnapshot => ({ schemaVersion: 2, researchPolicy: 'TWO_SOURCE_HOURLY_V1',
    configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId, mappingHash: researchHash(f.policy),
    createdAt: at, evidence: [], coverage: [], news: [], events: [] });
  const claim = async () => { const result = await store.claimMarketauxAttempt(identity); assert.ok(result.claimed); return result.ticket; };
  const reservation = (ticket: MarketauxAttemptTicket, pass: 1 | 2 = 1) => {
    const policy = f.manifest.instruments.find(p => p.instrumentId === ticket.instrumentId)!;
    const source = policy.sources.find(s => s.id === ticket.sourceId)!;
    const request: MarketauxRequestV2 = { kind: 'marketaux-news-v2', attemptId: ticket.attemptId, slot: ticket.slot,
      sourceUrl: source.urls[0], windowStart: ticket.windowStart, asOf: ticket.asOf, pass, page: 1 };
    const call = marketauxCallIdentity(f.manifestHash, policy.instrumentId, source, request);
    return { request, call, reservation: { accountId: ticket.accountId, provider: source.provider, kind: 'source' as const,
      configHash: ticket.configHash, manifestHash: ticket.manifestHash, callKey: call.callKey, requestHash: call.requestHash,
      reservedCostMicros: source.costMicrosPerCall, maxRequestsPerDay: budget, maxCostMicrosPerDay: 2400 } };
  };
  const negative = (ticket: MarketauxAttemptTicket, reason: string, at: string) => {
    const snapshot = empty(at);
    snapshot.coverage.push({ sourceId: ticket.sourceId, role: 'news', status: 'ERROR', checkedAt: at, windowStart: ticket.windowStart,
      windowEnd: ticket.asOf, complete: false, evidenceRefs: [], reason });
    return snapshot;
  };
  const complete = async (ticket: MarketauxAttemptTicket) => {
    const pages: MarketauxPageReceipt[] = [];
    for (const pass of [1, 2] as const) {
      const r = reservation(ticket, pass); await store.reserveMarketauxCall(ticket, r.request, r.reservation);
      const contentHash = researchHash({ syntheticPage: pass });
      const outcome = await store.recordMarketauxCallOutcome(ticket, r.call.callKey, { outcome: 'SUCCEEDED', contentHash });
      pages.push({ ...r.call, pass, page: 1, fetchedAt: outcome.recordedAt, contentHash, found: 0, returned: 0, limit: 2 });
    }
    return (at: string) => {
      const snapshot = empty(at);
      snapshot.coverage.push({ sourceId: ticket.sourceId, role: 'news', status: 'EMPTY', checkedAt: at, windowStart: ticket.windowStart,
        windowEnd: ticket.asOf, complete: true, evidenceRefs: [], reason: 'Synthetic complete query', acquisition: {
          kind: 'marketaux-news-v2', attemptId: ticket.attemptId, slot: ticket.slot, sourceHash: ticket.sourceHash, startedAt: ticket.startedAt, completedAt: at,
          queryStart: new Date(Date.parse(ticket.windowStart) - 1000).toISOString(), queryEnd: new Date(Date.parse(ticket.asOf) + 1000).toISOString(), asOf: ticket.asOf,
          entityQualificationHash: researchHash(f.newsConfig.qualification), entitlementHash: researchHash(f.newsConfig.entitlement),
          found: 0, emitted: 0, recordSetHash: researchHash([]), pages: structuredClone(pages),
        } });
      return snapshot;
    };
  };
  return { f, store, identity, empty, observe, claim, reservation, negative, complete };
}

test('hourly concurrent admission is unique and restart or cloned tickets cannot resume reserved work', { skip: !connection }, () => isolated(async pool => {
  const h = await seed(pool), other = new ResearchStore(pool);
  const claims = await Promise.all([h.store.claimMarketauxAttempt(h.identity), other.claimMarketauxAttempt(h.identity)]);
  assert.equal(claims.filter(c => c.claimed).length, 1);
  const admitted = claims.find(c => c.claimed)!; assert.ok(admitted.claimed);
  const owner = claims[0].claimed ? h.store : other, ticket = admitted.ticket, r = h.reservation(ticket);
  assert.equal((await new ResearchStore(pool).claimMarketauxAttempt(h.identity)).claimed, false);
  await assert.rejects(new ResearchStore(pool).reserveMarketauxCall(ticket, r.request, r.reservation), /TICKET_INVALID/);
  await assert.rejects(owner.reserveMarketauxCall({ ...ticket, monotonicDeadlineMs: Infinity }, r.request, r.reservation), /TICKET_INVALID/);
  await owner.reserveMarketauxCall(ticket, r.request, r.reservation);
  assert.equal(Number((await pool.query('SELECT count(*) FROM research_marketaux_attempts')).rows[0].count), 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM research_call_reservations')).rows[0].count), 1);
}));

test('attempt identities and linked successful receipts remain SQL immutable', { skip: !connection }, () => isolated(async pool => {
  const h = await seed(pool), ticket = await h.claim(), r = h.reservation(ticket);
  await h.store.reserveMarketauxCall(ticket, r.request, r.reservation);
  await h.store.recordMarketauxCallOutcome(ticket, r.call.callKey, { outcome: 'SUCCEEDED', contentHash: 'a'.repeat(64) });
  for (const sql of [
    "UPDATE research_marketaux_attempts SET source_hash=repeat('b',64)",
    "UPDATE research_marketaux_attempts SET started_at=started_at-interval '1 hour',deadline_at=deadline_at-interval '1 hour'",
    'DELETE FROM research_marketaux_attempts', 'TRUNCATE research_marketaux_attempts CASCADE',
    "UPDATE research_marketaux_response_receipts SET content_hash=repeat('b',64)",
    "UPDATE research_marketaux_response_receipts SET recorded_at=recorded_at+interval '1 millisecond'",
    'DELETE FROM research_marketaux_response_receipts', 'UPDATE research_marketaux_attempt_calls SET pass=2',
  ]) await assert.rejects(pool.query(sql), /IMMUTABLE|immutable|append.only/i, sql);
  const receipt = (await pool.query('SELECT * FROM research_marketaux_response_receipts')).rows[0];
  assert.equal(receipt.content_hash, 'a'.repeat(64));
  await assert.rejects(h.store.recordMarketauxCallOutcome(ticket, r.call.callKey, { outcome: 'UNKNOWN' }), /duplicate|unique|immutable/i);
}));

test('SQL cannot forge success against an empty snapshot without complete linked provider calls', { skip: !connection }, () => isolated(async pool => {
  const h = await seed(pool), initial = await h.store.storeSnapshot(h.empty(new Date().toISOString())), ticket = await h.claim();
  await pool.query("UPDATE research_marketaux_attempts SET state='FINALIZING' WHERE id=$1", [ticket.attemptId]);
  await assert.rejects(pool.query("UPDATE research_marketaux_attempts SET state='SUCCEEDED',finished_at=clock_timestamp(),snapshot_id=$2,projection_hash=$3 WHERE id=$1",
    [ticket.attemptId, initial.id, 'a'.repeat(64)]), /RESEARCH_MARKETAUX_|check constraint/);
  assert.equal((await pool.query('SELECT state FROM research_marketaux_attempts')).rows[0].state, 'FINALIZING');
}));

test('swapped response hash or timestamp and incomplete EMPTY finalization leave a durable hold', { skip: !connection }, async () => {
  for (const fault of ['hash', 'time', 'missing-page'] as const) await isolated(async pool => {
    const h = await seed(pool), ticket = await h.claim(), build = await h.complete(ticket);
    await assert.rejects(h.store.finalizeMarketauxSuccess(ticket, at => {
      const snapshot = build(at), receipt = snapshot.coverage[0]; assert.ok('acquisition' in receipt && receipt.acquisition);
      if (fault === 'hash') receipt.acquisition.pages[0].contentHash = 'b'.repeat(64);
      if (fault === 'time') receipt.acquisition.pages[0].fetchedAt = ticket.startedAt;
      if (fault === 'missing-page') receipt.acquisition.pages.pop();
      return snapshot;
    }), /RESEARCH_MARKETAUX_RECEIPT_INVALID/);
    assert.equal((await pool.query('SELECT state FROM research_marketaux_attempts')).rows[0].state, 'FINALIZING');
    assert.equal(await h.store.latestSnapshot(h.identity), null);
    assert.ok((await h.store.readMarketauxRefreshState(h.identity)).holdReasons.includes('RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED'));
    assert.equal((await new ResearchStore(pool).claimMarketauxAttempt(h.identity)).claimed, false);
  });
});

test('source and manifest rotation preserve original issuer cadence and do not import old cache', { skip: !connection }, () => isolated(async pool => {
  const h = await seed(pool), ticket = await h.claim(), reason = 'RESEARCH_MARKETAUX_KEY_MISSING';
  await h.store.finishMarketauxFailure(ticket, { outcome: 'FAILED', reason }, at => h.negative(ticket, reason, at));
  await pool.query("UPDATE research_observations SET expires_at=statement_timestamp()-interval '1 second',observed_at=statement_timestamp()-interval '31 seconds'");
  h.f.source.id = 'marketaux-rotated'; h.f.manifestHash = researchHash(h.f.manifest);
  await h.store.registerManifest({ manifest: h.f.manifest, configuration: h.f.config, tradingEnabled: false, adopt: true });
  await h.observe();
  const identity = { ...h.identity, manifestHash: h.f.manifestHash, sourceId: h.f.source.id };
  const claim = await new ResearchStore(pool).claimMarketauxAttempt(identity);
  assert.equal(claim.claimed, false);
  if (claim.claimed) throw new Error('unexpected claim');
  assert.equal(claim.reason, 'RESEARCH_MARKETAUX_SLOT_TOO_EARLY');
  assert.equal(Date.parse(claim.nextCheckAt!), Date.parse(ticket.startedAt) + 3600000);
  assert.equal(await h.store.latestSnapshot(identity), null);
}));

test('concurrent different issuers consume one pooled provider budget atomically', { skip: !connection }, () => isolated(async pool => {
  const h = await seed(pool, 1), policies = h.f.manifest.instruments;
  const claims = await Promise.all(policies.map(p => h.store.claimMarketauxAttempt({ ...h.identity, instrumentId: p.instrumentId,
    sourceId: p.sources.find(s => s.adapter === 'marketaux-news')!.id })));
  const tickets = claims.map(c => { assert.ok(c.claimed); return c.ticket; });
  const reservations = await Promise.allSettled(tickets.map(ticket => { const r = h.reservation(ticket); return h.store.reserveMarketauxCall(ticket, r.request, r.reservation); }));
  assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = reservations.find(r => r.status === 'rejected'); assert.ok(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /RESEARCH_BUDGET_EXHAUSTED/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM research_call_reservations')).rows[0].count), 1);
  assert.equal(Number((await pool.query('SELECT count(*) FROM research_marketaux_budget_denials')).rows[0].count), tickets.length - 1);
}));
