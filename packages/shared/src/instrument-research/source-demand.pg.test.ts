import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { seedTwoSourceResearchStore } from './research.fixture.js';
import { marketauxCallIdentity } from './marketaux.js';
import { ResearchStore } from './store.js';
import { parseWshConfig, wshReceiptPolicy, wshRequestDates } from './wsh.js';
import { researchHash } from './validation.js';
import type { MarketauxAttemptFailure, MarketauxAttemptTicket } from './marketaux-refresh.js';
const { Pool } = createRequire(new URL('../../../../apps/llm-agent/package.json', import.meta.url))('pg');
const connection = process.env.TEST_POSTGRES_URL;
type Fixture = Awaited<ReturnType<typeof seedTwoSourceResearchStore>>;

async function isolated(run: (pool: any, advance: (ms: number) => Promise<void>) => Promise<void>) {
 const url = new URL(connection!);
 assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && (url.port === '55432'
  || url.port === '55434' && url.pathname === '/ikbr_startup_recovery_test'
  || process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci'), 'Only isolated PostgreSQL allowed');
 url.pathname = '/postgres';
 const admin = new Pool({ connectionString: url.href }), name = 'source_demand_' + randomUUID().replaceAll('-', '');
 await admin.query(`CREATE DATABASE ${name}`); url.pathname = '/' + name;
 const pool = new Pool({ connectionString: url.href, options: '-c search_path=public,pg_catalog' });
 try {
  await pool.query('CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)');
  await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
  // Keep same-hour scenarios away from wall-clock boundaries without editing source history.
  await pool.query("UPDATE fixture_clock SET offset_ms=extract(epoch FROM (date_trunc('hour',pg_catalog.clock_timestamp())+interval '1 hour 10 minutes'-pg_catalog.clock_timestamp()))*1000");
  const dir = new URL('../../../../infra/sql/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(file, dir), 'utf8'));
  await run(pool, async ms => { await pool.query('UPDATE fixture_clock SET offset_ms=offset_ms+$1', [ms]); });
 } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}

async function claim(f: Fixture, kind: 'regular' | 'demand' = 'regular') {
 const result = await f.store.claimMarketauxAttempt(f.identity, kind);
 assert.ok(result.claimed, result.claimed ? '' : result.reason); return result.ticket;
}
async function failNews(f: Fixture, ticket: MarketauxAttemptTicket,
 options: { status?: number; retryAfterMs?: number | null; retryAfterAt?: string } = {}) {
 const request = { kind: 'marketaux-news-v2' as const, attemptId: ticket.attemptId, slot: ticket.slot,
  sourceUrl: f.source.urls[0], windowStart: ticket.windowStart, asOf: ticket.asOf, pass: 1 as const, page: 1 };
 const call = marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, request);
 await f.store.reserveMarketauxCall(ticket, request, { ...f.identity, provider: f.source.provider, kind: 'source', ...call,
  reservedCostMicros: f.source.costMicrosPerCall, maxRequestsPerDay: f.source.maxRequestsPerDay, maxCostMicrosPerDay: f.source.maxCostMicrosPerDay });
 await f.store.recordMarketauxCallOutcome(ticket, call.callKey, options.status
  ? { outcome: 'FAILED' } : { outcome: 'SUCCEEDED', contentHash: 'a'.repeat(64) });
 const reason = options.status ? `RESEARCH_SOURCE_HTTP_${options.status}` : 'RESEARCH_MARKETAUX_PAYLOAD_INVALID';
 const sourceError = { name: 'Error', code: null, message: reason, ...(options.status ? { httpStatus: options.status } : {}) };
 const failure: MarketauxAttemptFailure = { reason, sourceError, outcome: 'FAILED',
  ...('retryAfterMs' in options ? { retryAfterMs: options.retryAfterMs } : {}),
  ...('retryAfterAt' in options ? { retryAfterAt: options.retryAfterAt } : {}) };
 return f.store.finishMarketauxFailure(ticket, failure, stamp => {
  const snapshot = f.empty(stamp);
  snapshot.coverage.push({ sourceId: f.source.id, role: 'news', status: 'ERROR', complete: false, evidenceRefs: [],
   checkedAt: stamp, windowStart: ticket.windowStart, windowEnd: ticket.asOf, reason, sourceError }); return snapshot;
 });
}
async function newsAcquisition(f: Fixture) {
 return (await f.store.prepareRepair(f.identity)).sources.find(s => s.sourceId === f.source.id)!.acquisition!;
}
async function attemptRow(pool: any, ticket: MarketauxAttemptTicket) {
 return (await pool.query('SELECT * FROM research_marketaux_attempts WHERE id=$1', [ticket.attemptId])).rows[0];
}
function otherIssuer(f: Fixture): Fixture {
 const policy = f.manifest.instruments.find(p => p.instrumentId !== f.policy.instrumentId)!, source = policy.sources.find(s => s.adapter === 'marketaux-news')!;
 return { ...f, policy, source, identity: { ...f.identity, instrumentId: policy.instrumentId, sourceId: source.id },
  empty: stamp => ({ ...f.empty(stamp), instrumentId: policy.instrumentId, mappingHash: researchHash(policy) }) };
}
async function reserveNews(f: Fixture, ticket: MarketauxAttemptTicket, page = 1) {
 const request = { kind: 'marketaux-news-v2' as const, attemptId: ticket.attemptId, slot: ticket.slot, sourceUrl: f.source.urls[0],
  windowStart: ticket.windowStart, asOf: ticket.asOf, pass: 1 as const, page };
 const call = marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, request);
 await f.store.reserveMarketauxCall(ticket, request, { ...f.identity, provider: f.source.provider, kind: 'source', ...call,
  reservedCostMicros: f.source.costMicrosPerCall, maxRequestsPerDay: f.source.maxRequestsPerDay, maxCostMicrosPerDay: f.source.maxCostMicrosPerDay });
 return call;
}
async function wshRead(f: Fixture, kind: 'regular' | 'demand', succeeds: boolean) {
 const config = parseWshConfig(f.wshSource, f.policy), identity = { ...f.identity, sourceId: f.wshSource.id, sessionId: randomUUID() };
 let ticket!: import('./wsh-refresh.js').WshAttemptTicket;
 await f.store.withWshEndpointLock(config.endpointId, async lease => {
  const claimed = await f.store.claimWshAttempt(lease, identity, kind);
  assert.equal(claimed.state, 'CLAIMED'); if (claimed.state !== 'CLAIMED') throw Error('fixture'); ticket = claimed.ticket;
  await f.store.confirmWshPreflight(lease, ticket);
  const base = { ...identity, provider: 'ibkr-wsh', kind: 'source' as const, reservedCostMicros: 0,
   maxRequestsPerDay: f.wshSource.maxRequestsPerDay, maxCostMicrosPerDay: 0 };
  const metadata = { ...base, callKey: 'demand_meta_' + randomUUID(), requestHash: 'a'.repeat(64), deadlineAt: new Date(await f.clock() + 9000).toISOString() };
  const acquisition = await f.store.beginWshAcquisition(lease, { ...identity, reservation: metadata }, ticket);
  await f.store.recordCallOutcome(metadata.callKey, 'SUCCEEDED');
  const stamp = new Date(await f.clock()).toISOString(), dates = wshRequestDates(config, stamp);
  const requestHash = researchHash({ endpointId: config.endpointId, sessionId: ticket.sessionId, requestId: 2, method: 'reqWshEventData', request: {
   conId: config.conId, filter: '', fillWatchlist: false, fillPortfolio: false, fillCompetitors: false, ...dates, totalLimit: 100 } });
  const events = { ...base, callKey: 'demand_events_' + randomUUID(), requestHash, deadlineAt: new Date(await f.clock() + 9000).toISOString() };
  await f.store.reserveWshCall(lease, acquisition, events); await f.store.recordCallOutcome(events.callKey, 'SUCCEEDED');
  const snapshot = f.empty(stamp), cleanup = { sessionId: ticket.sessionId, state: 'CONFIRMED' as const, verifiedLocalClosure: true,
   completedAt: stamp, localClosedAt: stamp, cancellationAttemptedAt: stamp, disconnectRequestedAt: stamp };
  if (succeeds) {
   snapshot.coverage.push({ sourceId: f.wshSource.id, role: 'calendar', status: 'EMPTY', complete: true, checkedAt: stamp,
    windowStart: stamp, windowEnd: stamp, evidenceRefs: [], reason: 'Synthetic provider-reported empty query',
    wshAcquisition: { ...wshReceiptPolicy(config), coverageBasis: 'PROVIDER_REPORTED_QUERY', acquisitionId: acquisition.id,
     generation: acquisition.generation, sessionId: ticket.sessionId, requestId: 2, requestAsOf: stamp, requestStartDate: dates.startDate,
     requestEndDate: dates.endDate, totalLimit: 100, rowCount: 0, duplicateCount: 0, requestHash, receiptHash: 'e'.repeat(64), metadataHash: config.qualification.metadataHash } });
   await f.store.publishWshSnapshot(lease, acquisition, snapshot, ticket.publicationSlotKey, ticket.deadlineAt);
   await f.store.finishWshAttempt(lease, ticket, { outcome: 'SUCCEEDED', acquisition, cleanup });
  } else {
   snapshot.coverage.push({ sourceId: f.wshSource.id, role: 'calendar', status: 'ERROR', complete: false, checkedAt: stamp,
    windowStart: stamp, windowEnd: stamp, evidenceRefs: [], reason: 'RESEARCH_WSH_PAYLOAD_INVALID' });
   await f.store.finishWshAttempt(lease, ticket, { outcome: 'FAILED', failureClass: 'HARD', failureReason: 'RESEARCH_WSH_PAYLOAD_INVALID',
    stage: 'events', acquisition, acquisitionOutcome: 'FAILED', snapshot, ...(ticket.publicationSlotKey ? { slotKey: ticket.publicationSlotKey } : {}), cleanup });
  }
 });
 return ticket;
}
async function directNewsClaim(pool: any, f: Fixture, kind: 'REGULAR' | 'DEMAND', request: string | null) {
 return pool.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) AS at)
  INSERT INTO research_marketaux_attempts(id,account_id,provider,config_hash,manifest_hash,instrument_id,source_id,
   ledger_key,source_hash,slot,started_at,deadline_at,state,recovery_protocol,clock_domain_id,clock_db_at,clock_wall_at,admission_kind,demand_request_id)
  SELECT gen_random_uuid(),a.account_id,a.provider,a.config_hash,a.manifest_hash,a.instrument_id,a.source_id,
   a.ledger_key,a.source_hash,floor(extract(epoch FROM stamp.at)/3600)::bigint,stamp.at,stamp.at+interval '120 seconds',
   'STARTED',a.recovery_protocol,a.clock_domain_id,stamp.at,stamp.at,$2,$3
  FROM research_marketaux_attempts a CROSS JOIN stamp WHERE a.id=$1`,
 [(await pool.query('SELECT id FROM research_marketaux_attempts WHERE instrument_id=$1 ORDER BY started_at DESC LIMIT 1', [f.policy.instrumentId])).rows[0].id, kind, request]);
}

test('fresh proved sources cause no demand attempts or additional budget reservations', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool), before = (await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n;
 assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
 assert.equal((await newsAcquisition(f)).state, 'READY');
 assert.equal((await f.store.claimMarketauxAttempt(f.identity, 'demand')).claimed, false);
 await f.store.withWshEndpointLock(parseWshConfig(f.wshSource, f.policy).endpointId, async lease => {
  const c = await f.store.claimWshAttempt(lease, { ...f.identity, sourceId: f.wshSource.id, sessionId: randomUUID() }, 'demand');
  assert.equal(c.state, 'DEFERRED');
 });
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n, before);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE admission_kind='DEMAND'")).rows[0].n, 0);
}));

test('AAPL parser HARD failure is replaced in the same hour without changing old attempt, slots or charges', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), old = await claim(f);
 await failNews(f, old);
 const original = await attemptRow(pool, old), beforeSlots = (await pool.query('SELECT * FROM research_refresh_slots ORDER BY slot_key')).rows;
 const preparation = await f.store.prepareRepair(f.identity);
 assert.notEqual(preparation.state, 'READY'); assert.equal((await newsAcquisition(f)).state, 'WAITING');
 assert.equal((await f.store.claimMarketauxAttempt(f.identity, 'demand')).claimed, false);
 await advance(31000); await f.observe(); await f.store.prepareRepair(f.identity);
 const replacement = await claim(f, 'demand');
 assert.notEqual(replacement.attemptId, old.attemptId); assert.equal(replacement.slot, old.slot);
 assert.equal(replacement.asOf, old.asOf); assert.ok(Date.parse(replacement.startedAt) < Date.parse(old.startedAt) + 3600000);
 await f.publishNews(replacement);
 assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
 assert.deepEqual(await attemptRow(pool, old), original);
 for (const slot of beforeSlots) assert.deepEqual((await pool.query('SELECT * FROM research_refresh_slots WHERE slot_key=$1', [slot.slot_key])).rows[0], slot);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempts')).rows[0].n, 2);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 3);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_refresh_slots WHERE slot_key LIKE 'research_demand_slot_%'")).rows[0].n, 1);
 assert.equal((await f.store.claimMarketauxAttempt(f.identity)).claimed, false);
}));

test('restarted concurrent workers admit only one due demand without resetting failure backoff', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), old = await claim(f); await failNews(f, old);
 const before = await newsAcquisition(f);
 const recoveryClock = { wallNow: () => Date.now() + offset, monotonicNow: () => performance.now() + offset, domainId: () => 'e'.repeat(64) };
 let offset = await f.clock() - Date.now();
 const restarted = new ResearchStore(pool, recoveryClock);
 assert.equal((await restarted.claimMarketauxAttempt(f.identity, 'demand')).claimed, false);
 assert.equal((await newsAcquisition(f)).nextDemandAt, before.nextDemandAt);
 await advance(31000); await f.observe(); offset = await f.clock() - Date.now(); await f.store.prepareRepair(f.identity);
 const results = await Promise.all([f.store.claimMarketauxAttempt(f.identity, 'demand'), restarted.claimMarketauxAttempt(f.identity, 'demand')]);
 assert.equal(results.filter(r => r.claimed).length, 1);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE admission_kind='DEMAND'")).rows[0].n, 1);
}));

test('expired news is independently refreshed while expired calendar qualification keeps entry held', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool), original = (await f.store.latestSnapshot(f.identity))!;
 const calendar = original.snapshot.coverage.find(c => c.sourceId === f.wshSource.id);
 await advance(86401000); await f.observe();
 const preparation = await f.store.prepareRepair(f.identity);
 assert.equal(preparation.state, 'HOLD');
 assert.equal(preparation.sources.find(s => s.sourceId === f.source.id)!.acquisition?.state, 'WAITING');
 const t = await claim(f, 'demand'); await f.publishNews(t);
 assert.equal((await newsAcquisition(f)).state, 'READY');
 assert.equal((await f.store.prepareRepair(f.identity)).state, 'HOLD');
 assert.deepEqual((await f.store.latestSnapshot(f.identity))!.snapshot.coverage.find(c => c.sourceId === f.wshSource.id), calendar);
 assert.equal((await f.store.readSnapshot(original.id))!.hash, original.hash);
}));

test('repeated demand failure uses 30s,120s,10min without same-hour publication collisions', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false });
 for (const [index, delay] of [30000, 120000, 600000, 600000].entries()) {
  await f.store.prepareRepair(f.identity);
  const t = await claim(f, index ? 'demand' : 'regular'); await failNews(f, t);
  const row = await attemptRow(pool, t), acquisition = await newsAcquisition(f);
  assert.equal(Date.parse(acquisition.nextDemandAt!) - row.finished_at.getTime(), delay);
  assert.equal((await f.store.claimMarketauxAttempt(f.identity, 'demand')).claimed, false);
  await advance(delay + 1000); await f.observe();
 }
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 4);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_refresh_slots WHERE slot_key LIKE 'research_demand_slot_%'")).rows[0].n, 3);
}));

test('unrelated source permission HOLD does not suppress missing news demand', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false, publishWsh: false,
  configureManifest: manifest => { for (const policy of manifest.instruments) policy.sources.find(s => s.adapter === 'ibkr-wsh')!.automation = 'DENIED'; } });
 const preparation = await f.store.prepareRepair(f.identity);
 assert.equal(preparation.state, 'HOLD');
 assert.equal(preparation.sources.find(s => s.sourceId === f.source.id)!.acquisition?.state, 'WAITING');
 const t = await claim(f, 'demand'); await f.publishNews(t);
 assert.equal((await f.store.prepareRepair(f.identity)).state, 'HOLD');
 assert.equal((await newsAcquisition(f)).state, 'READY');
}));

test('WSH BUSY retains usable calendar and does not open a demand cycle', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool); await advance(3601000); await f.observe();
 const original = (await f.store.latestSnapshot(f.identity))!.snapshot.coverage.find(c => c.sourceId === f.wshSource.id);
 const identity = { ...f.identity, sourceId: f.wshSource.id, sessionId: randomUUID() };
 await f.store.withWshEndpointLock(parseWshConfig(f.wshSource, f.policy).endpointId, async lease => {
  const c = await f.store.claimWshAttempt(lease, identity, 'regular'); assert.equal(c.state, 'CLAIMED'); if (c.state !== 'CLAIMED') throw Error('fixture');
  await f.store.confirmWshPreflight(lease, c.ticket); const stamp = new Date(await f.clock()).toISOString(), snapshot = f.empty(stamp);
  snapshot.coverage.push({ sourceId: f.wshSource.id, role: 'calendar', status: 'ERROR', complete: false, checkedAt: stamp,
   windowStart: stamp, windowEnd: stamp, evidenceRefs: [], reason: 'RESEARCH_WSH_ERROR_10281' });
  await f.store.finishWshAttempt(lease, c.ticket, { outcome: 'FAILED', failureClass: 'BUSY', failureReason: 'RESEARCH_WSH_ERROR_10281',
   providerError: { code: 10281, message: 'Synthetic provider busy' }, stage: 'events', snapshot,
   cleanup: { sessionId: c.ticket.sessionId, state: 'CONFIRMED', verifiedLocalClosure: true, completedAt: stamp,
    localClosedAt: stamp, cancellationAttemptedAt: stamp, disconnectRequestedAt: stamp } });
  await f.store.prepareRepair(f.identity);
  assert.equal((await f.store.claimWshAttempt(lease, { ...identity, sessionId: randomUUID() }, 'demand')).state, 'DEFERRED');
 });
 assert.deepEqual((await f.store.latestSnapshot(f.identity))!.snapshot.coverage.find(c => c.sourceId === f.wshSource.id), original);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_wsh_refresh_cycles WHERE admission_kind='DEMAND'")).rows[0].n, 0);
}));

test('exhausted shared news budget does not produce denied demand attempts or refund charged calls', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false, configureManifest: manifest => {
  for (const policy of manifest.instruments) policy.sources.find(s => s.adapter === 'marketaux-news')!.maxRequestsPerDay = 1;
 } });
 const old = await claim(f); await failNews(f, old); await advance(31000); await f.observe();
 assert.equal((await newsAcquisition(f)).reason, 'RESEARCH_BUDGET_EXHAUSTED');
 for (let i = 0; i < 3; i++) { await f.store.prepareRepair(f.identity); assert.equal((await f.store.claimMarketauxAttempt(f.identity, 'demand')).claimed, false); }
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempts')).rows[0].n, 1);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 1);
}));

test('direct SQL demand rejects forged due requests with fresh cache and preserved regular pacing', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool); await f.store.prepareRepair(f.identity);
 const request = (await pool.query('SELECT id FROM research_repair_requests WHERE source_id=$1 AND instrument_id=$2', [f.source.id, f.policy.instrumentId])).rows[0].id;
 await pool.query("UPDATE research_repair_requests SET state='WAITING',next_check_at=clock_timestamp()-interval '1 second' WHERE id=$1", [request]);
 await assert.rejects(directNewsClaim(pool, f, 'DEMAND', request), /RESEARCH_SOURCE_DEMAND_DENIED/);
 await assert.rejects(directNewsClaim(pool, f, 'REGULAR', null), /RESEARCH_MARKETAUX_SLOT_TOO_EARLY/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempts')).rows[0].n, 1);
}));

test('direct SQL cannot bypass demand backoff or use another source repair request', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }); await failNews(f, await claim(f)); await f.store.prepareRepair(f.identity);
 const requests = (await pool.query('SELECT id,source_id FROM research_repair_requests WHERE instrument_id=$1', [f.policy.instrumentId])).rows;
 const news = requests.find((r: any) => r.source_id === f.source.id).id, calendar = requests.find((r: any) => r.source_id === f.wshSource.id).id;
 await pool.query("UPDATE research_repair_requests SET state='WAITING',next_check_at=clock_timestamp()-interval '1 second' WHERE id=$1", [news]);
 await assert.rejects(directNewsClaim(pool, f, 'DEMAND', news), /RESEARCH_SOURCE_DEMAND_DENIED/);
 await advance(31000); await f.observe(); await f.store.prepareRepair(f.identity);
 await assert.rejects(directNewsClaim(pool, f, 'DEMAND', calendar), /RESEARCH_SOURCE_DEMAND_DENIED/);
 await directNewsClaim(pool, f, 'DEMAND', news);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE admission_kind='DEMAND'")).rows[0].n, 1);
}));

test('demand SQL admission observes exact stored backoff boundary without JavaScript precision loss', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), t = await claim(f); await failNews(f, t); await f.store.prepareRepair(f.identity);
 const row = (await pool.query(`SELECT
  research_source_demand_admission(r.id,a.account_id,a.config_hash,a.manifest_hash,a.instrument_id,a.source_id,a.finished_at+interval '30 seconds'-interval '1 microsecond') AS early,
  research_source_demand_admission(r.id,a.account_id,a.config_hash,a.manifest_hash,a.instrument_id,a.source_id,a.finished_at+interval '30 seconds') AS due
  FROM research_marketaux_attempts a JOIN research_repair_requests r USING(account_id,config_hash,manifest_hash,instrument_id,source_id) WHERE a.id=$1`, [t.attemptId])).rows[0];
 assert.equal(row.early, false); assert.equal(row.due, true);
}));

test('WSH demand SQL forbids in-cycle retry deadline and ordinal one even for BUSY authority', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }); await f.store.prepareRepair(f.identity);
 await f.store.withWshEndpointLock(parseWshConfig(f.wshSource, f.policy).endpointId, async lease => {
  const c = await f.store.claimWshAttempt(lease, { ...f.identity, sourceId: f.wshSource.id, sessionId: randomUUID() }, 'demand');
  assert.equal(c.state, 'CLAIMED'); if (c.state !== 'CLAIMED') throw Error('fixture');
  await assert.rejects(pool.query("UPDATE research_wsh_refresh_attempts SET retry_due_at=clock_timestamp()+interval '30 seconds' WHERE id=$1", [c.ticket.id]), /RESEARCH_WSH_DEMAND_RETRY_INVALID/);
  await f.store.confirmWshPreflight(lease, c.ticket);
  const stamp = new Date(await f.clock()).toISOString(), snapshot = f.empty(stamp);
  snapshot.coverage.push({ sourceId: f.wshSource.id, role: 'calendar', status: 'ERROR', complete: false, checkedAt: stamp,
   windowStart: stamp, windowEnd: stamp, evidenceRefs: [], reason: 'RESEARCH_WSH_ERROR_10281' });
  await f.store.finishWshAttempt(lease, c.ticket, { outcome: 'FAILED', failureClass: 'BUSY', failureReason: 'RESEARCH_WSH_ERROR_10281',
   providerError: { code: 10281, message: 'Synthetic provider busy' }, stage: 'events', snapshot, slotKey: c.ticket.publicationSlotKey,
   cleanup: { sessionId: c.ticket.sessionId, state: 'CONFIRMED', verifiedLocalClosure: true, completedAt: stamp,
    localClosedAt: stamp, cancellationAttemptedAt: stamp, disconnectRequestedAt: stamp } });
  assert.equal((await pool.query('SELECT retry_due_at FROM research_wsh_refresh_attempts WHERE id=$1', [c.ticket.id])).rows[0].retry_due_at, null);
  await assert.rejects(pool.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,predecessor_id,endpoint_id,session_id,started_at,deadline_at,state)
   SELECT gen_random_uuid(),cycle_id,1,id,endpoint_id,gen_random_uuid()::text,started_at,deadline_at,'STARTED'
   FROM research_wsh_refresh_attempts WHERE id=$1`, [c.ticket.id]), /RESEARCH_WSH_DEMAND_RETRY_INVALID/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_refresh_attempts WHERE cycle_id=$1', [c.ticket.cycleId])).rows[0].n, 1);
 });
}));

test('provider cooldown received after another issuer claims blocks its reservation without charging a call', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), first = await claim(f);
 const policy = f.manifest.instruments.find(p => p.instrumentId !== f.policy.instrumentId)!, source = policy.sources.find(s => s.adapter === 'marketaux-news')!;
 const identity = { ...f.identity, instrumentId: policy.instrumentId, sourceId: source.id };
 const second = await f.store.claimMarketauxAttempt(identity); assert.ok(second.claimed);
 await failNews(f, first, { status: 429, retryAfterMs: 180000 });
 const t = second.ticket, request = { kind: 'marketaux-news-v2' as const, attemptId: t.attemptId, slot: t.slot,
  sourceUrl: source.urls[0], windowStart: t.windowStart, asOf: t.asOf, pass: 1 as const, page: 1 };
 const call = marketauxCallIdentity(f.manifestHash, policy.instrumentId, source, request);
 await assert.rejects(f.store.reserveMarketauxCall(t, request, { ...identity, provider: source.provider, kind: 'source', ...call,
  reservedCostMicros: source.costMicrosPerCall, maxRequestsPerDay: source.maxRequestsPerDay, maxCostMicrosPerDay: source.maxCostMicrosPerDay }), /RESEARCH_PROVIDER_COOLDOWN/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations WHERE call_key=$1', [call.callKey])).rows[0].n, 0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1', [t.attemptId])).rows[0].n, 0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 1);
}));

test('invalid numeric or conflicting provider retry evidence rejects without terminal mutation', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), t = await claim(f), before = await attemptRow(pool, t);
 for (const extra of [{ retryAfterMs: -1 }, { retryAfterMs: 0.5 }, { retryAfterMs: Number.NaN }, { retryAfterMs: Infinity },
  { retryAfterMs: Number.MAX_SAFE_INTEGER + 1 }, { retryAfterMs: 1, retryAfterAt: new Date(await f.clock() + 60000).toISOString() }]) {
  await assert.rejects(f.store.finishMarketauxFailure(t, { reason: 'RESEARCH_SOURCE_HTTP_429', outcome: 'FAILED', ...extra }, f.empty), /RESEARCH_PROVIDER_COOLDOWN_INVALID/);
  assert.deepEqual(await attemptRow(pool, t), before);
 }
}));

for (const timing of ['absent', 'zero', 'malformed', 'long', 'absolute'] as const)
 test(`429 ${timing} timing persists pooled cooldown for regular and demand across issuers`, { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), old = await claim(f);
  const absolute = new Date(await f.clock() + 7200000).toISOString();
  const options = timing === 'absent' ? {} : timing === 'absolute' ? { retryAfterAt: absolute }
   : { retryAfterMs: timing === 'zero' ? 0 : timing === 'malformed' ? null : 7200000 };
  await failNews(f, old, { status: 429, ...options });
  const row = await attemptRow(pool, old), expected = timing === 'malformed' ? 600000 : timing === 'long' ? 7200000 : 60000;
  if (timing === 'absolute') assert.equal(row.provider_not_before.toISOString(), absolute);
  else assert.equal(row.provider_not_before.getTime() - row.finished_at.getTime(), expected);
  assert.equal(row.provider_retry_invalid, timing === 'malformed');
  const other = f.manifest.instruments.find(p => p.instrumentId !== f.policy.instrumentId)!, source = other.sources.find(s => s.adapter === 'marketaux-news')!;
  const identity = { ...f.identity, instrumentId: other.instrumentId, sourceId: source.id };
  await f.store.prepareRepair(identity);
  for (const kind of ['regular', 'demand'] as const) assert.equal((await f.store.claimMarketauxAttempt(identity, kind)).claimed, false);
  const next = await newsAcquisition(f); assert.equal(next.nextDemandAt, row.provider_not_before.toISOString());
  const boundary = (await pool.query(`SELECT
   research_source_demand_admission(r.id,a.account_id,a.config_hash,a.manifest_hash,a.instrument_id,a.source_id,a.provider_not_before-interval '1 microsecond') AS early,
   research_source_demand_admission(r.id,a.account_id,a.config_hash,a.manifest_hash,a.instrument_id,a.source_id,a.provider_not_before) AS due
   FROM research_marketaux_attempts a JOIN research_repair_requests r USING(account_id,config_hash,manifest_hash,instrument_id,source_id) WHERE a.id=$1`, [old.attemptId])).rows[0];
  assert.equal(boundary.early, false); assert.equal(boundary.due, true);
  await advance(row.provider_not_before.getTime() - await f.clock() + 1000); await f.observe(); await f.store.prepareRepair(identity);
  assert.equal((await f.store.claimMarketauxAttempt(identity, 'demand')).claimed, true);
  assert.equal((await attemptRow(pool, old)).provider_not_before.toISOString(), row.provider_not_before.toISOString());
 }));

for (const priorSuccess of [false, true]) test(`local cooldown settles with retained fresh cache and prior successful call=${priorSuccess}`, { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool), before = (await f.store.latestSnapshot(f.identity))!;
 await advance(3601000); await f.observe();
 const own = await claim(f), other = otherIssuer(f), quota = await claim(other);
 if (priorSuccess) { const call = await reserveNews(f, own); await f.store.recordMarketauxCallOutcome(own, call.callKey, { outcome: 'SUCCEEDED', contentHash: 'b'.repeat(64) }); }
 await failNews(other, quota, { status: 429, retryAfterMs: 180000 });
 await assert.rejects(reserveNews(f, own, priorSuccess ? 2 : 1), /RESEARCH_PROVIDER_COOLDOWN/);
 const result = await f.store.finishMarketauxFailure(own, { reason: 'RESEARCH_PROVIDER_COOLDOWN', outcome: 'FAILED' }, f.empty);
 assert.equal(result.retained, true); assert.equal(result.snapshot?.id, before.id);
 const row = await attemptRow(pool, own); assert.equal(row.failure_class, 'TRANSIENT'); assert.equal(row.retained, true);
 assert.equal(row.provider_not_before.toISOString(), (await attemptRow(pool, quota)).provider_not_before.toISOString());
 assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1', [own.attemptId])).rows[0].n, priorSuccess ? 1 : 0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, priorSuccess ? 4 : 3);
}));

test('real WSH HARD reads recover through distinct same-hour demand negative and successful publications', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishWsh: false });
 const original = await wshRead(f, 'regular', false);
 const history = (await pool.query('SELECT * FROM research_wsh_refresh_attempts WHERE id=$1', [original.id])).rows[0];
 await f.store.prepareRepair(f.identity); await advance(31000); await f.observe(); await f.store.prepareRepair(f.identity);
 const failed = await wshRead(f, 'demand', false);
 assert.notEqual(failed.cycleId, original.cycleId); assert.equal(failed.ordinal, 0);
 assert.equal((await pool.query('SELECT retry_due_at FROM research_wsh_refresh_attempts WHERE id=$1', [failed.id])).rows[0].retry_due_at, null);
 await f.store.prepareRepair(f.identity); await advance(121000); await f.observe(); await f.store.prepareRepair(f.identity);
 const success = await wshRead(f, 'demand', true);
 assert.ok(Date.parse(success.startedAt) < Date.parse(original.nextRegularAt));
 assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
 assert.deepEqual((await pool.query('SELECT * FROM research_wsh_refresh_attempts WHERE id=$1', [original.id])).rows[0], history);
 const slots = (await pool.query('SELECT slot_key,snapshot_id FROM research_refresh_slots WHERE slot_key=ANY($1::text[])', [[failed.publicationSlotKey, success.publicationSlotKey]])).rows;
 assert.equal(slots.length, 2); assert.notEqual(slots[0].snapshot_id, slots[1].snapshot_id);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='ibkr-wsh'")).rows[0].n, 6);
}));

test('direct WSH demand cannot choose a future timestamp to evade real database backoff', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }), old = await wshRead(f, 'regular', false);
 await f.store.prepareRepair(f.identity);
 const request = (await pool.query('SELECT id FROM research_repair_requests WHERE source_id=$1 AND instrument_id=$2', [f.wshSource.id, f.policy.instrumentId])).rows[0].id;
 await assert.rejects(pool.query(`INSERT INTO research_wsh_refresh_cycles(id,ledger_key,config_hash,manifest_hash,instrument_id,source_id,account_id,source_policy_hash,started_at,next_regular_at,admission_kind,demand_request_id)
  SELECT gen_random_uuid(),ledger_key,config_hash,manifest_hash,instrument_id,source_id,account_id,source_policy_hash,
   started_at+interval '10 minutes',next_regular_at+interval '10 minutes','DEMAND',$2
  FROM research_wsh_refresh_cycles WHERE id=$1`, [old.cycleId, request]), /RESEARCH_WSH_ADMISSION_TIME_INVALID/);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_wsh_refresh_cycles WHERE admission_kind='DEMAND'")).rows[0].n, 0);
}));

for (const status of [401, 403, 402]) test(`HTTP ${status} cannot become a fast demand read`, { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), old = await claim(f); await failNews(f, old, { status });
 await advance(601000); await f.observe();
 assert.equal((await newsAcquisition(f)).state, 'HOLD');
 assert.equal((await f.store.claimMarketauxAttempt(f.identity, 'demand')).claimed, false);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempts')).rows[0].n, 1);
}));

test('pooled402 blocks other issuer demand until a proved response for a call reserved after the402', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), other = otherIssuer(f);
 const quota = await claim(f), early = await claim(other), lateCall = await reserveNews(other, early);
 await failNews(f, quota, { status: 402 });
 await other.store.recordMarketauxCallOutcome(early, lateCall.callKey, { outcome: 'SUCCEEDED', contentHash: 'c'.repeat(64) });
 // Settle the already-issued attempt truthfully; its late response is not quota renewal.
 await other.store.finishMarketauxFailure(early, { reason: 'RESEARCH_MARKETAUX_PAYLOAD_INVALID', outcome: 'FAILED' }, stamp => {
  const snapshot = other.empty(stamp); snapshot.coverage.push({ sourceId: other.source.id, role: 'news', status: 'ERROR', complete: false,
   checkedAt: stamp, windowStart: early.windowStart, windowEnd: early.asOf, evidenceRefs: [], reason: 'RESEARCH_MARKETAUX_PAYLOAD_INVALID' }); return snapshot;
 });
 await f.store.prepareRepair(other.identity); await advance(31000); await f.observe();
 assert.equal((await f.store.claimMarketauxAttempt(other.identity, 'demand')).claimed, false);
 await advance(3601000); await f.observe();
 const renewed = await claim(other, 'regular'), good = await reserveNews(other, renewed);
 await other.store.recordMarketauxCallOutcome(renewed, good.callKey, { outcome: 'SUCCEEDED', contentHash: 'd'.repeat(64) });
 // The unrelated original issuer can now recover, but the old402 is still audited.
 await f.store.prepareRepair(f.identity);
 assert.equal((await newsAcquisition(f)).state, 'WAITING');
 assert.equal((await f.store.claimMarketauxAttempt(f.identity, 'demand')).claimed, true);
 assert.equal((await attemptRow(pool, quota)).failure_reason, 'RESEARCH_SOURCE_HTTP_402');
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 3);
}));

test('402 received after demand claim refuses dispatch without charging and resumes after proved ordinary renewal', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), other = otherIssuer(f);
 await f.store.prepareRepair(f.identity);
 const demand = await claim(f, 'demand'), quota = await claim(other);
 await failNews(other, quota, { status: 402 });
 await assert.rejects(reserveNews(f, demand), /RESEARCH_PROVIDER_USAGE_HOLD/);
 const reason = 'RESEARCH_PROVIDER_USAGE_HOLD';
 const settled = await f.store.finishMarketauxFailure(demand, { reason, outcome: 'FAILED' }, stamp => {
  const snapshot = f.empty(stamp); snapshot.coverage.push({ sourceId: f.source.id, role: 'news', status: 'ERROR', complete: false,
   checkedAt: stamp, windowStart: demand.windowStart, windowEnd: demand.asOf, evidenceRefs: [], reason }); return snapshot;
 });
 assert.equal(settled.retained, false);
 const original = await attemptRow(pool, demand);
 assert.equal(original.state, 'FAILED'); assert.equal(original.failure_class, 'HARD'); assert.equal(original.failure_reason, reason);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1', [demand.attemptId])).rows[0].n, 0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 1);
 assert.equal((await newsAcquisition(f)).state, 'HOLD');
 await advance(3601000); await f.observe();
 const renewed = await claim(other, 'regular'), call = await reserveNews(other, renewed);
 await other.store.recordMarketauxCallOutcome(renewed, call.callKey, { outcome: 'SUCCEEDED', contentHash: 'f'.repeat(64) });
 assert.equal((await newsAcquisition(f)).state, 'WAITING');
 const replacement = await claim(f, 'demand'); assert.notEqual(replacement.attemptId, demand.attemptId);
 assert.deepEqual(await attemptRow(pool, demand), original);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 2);
}));

test('402 refusal remains recoverable when ordinary renewal precedes local failure settlement', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), other = otherIssuer(f);
 const policy = f.manifest.instruments.find(p => p.instrumentId !== f.policy.instrumentId && p.instrumentId !== other.policy.instrumentId)!;
 assert.ok(policy, 'fixture requires a third independent issuer');
 const source = policy.sources.find(s => s.adapter === 'marketaux-news')!;
 const third: Fixture = { ...f, policy, source, identity: { ...f.identity, instrumentId: policy.instrumentId, sourceId: source.id },
  empty: stamp => ({ ...f.empty(stamp), instrumentId: policy.instrumentId, mappingHash: researchHash(policy) }) };
 await f.store.prepareRepair(f.identity);
 const demand = await claim(f, 'demand'), quota = await claim(other);
 await failNews(other, quota, { status: 402 });
 await assert.rejects(reserveNews(f, demand), /RESEARCH_PROVIDER_USAGE_HOLD/);
 const refused = (await attemptRow(pool, demand)).provider_refusal;
 assert.equal(refused.reason, 'RESEARCH_PROVIDER_USAGE_HOLD');
 assert.deepEqual(Object.keys(refused).sort(), ['reason', 'recordedAt']);
 const renewal = await claim(third, 'regular'), call = await reserveNews(third, renewal);
 await third.store.recordMarketauxCallOutcome(renewal, call.callKey, { outcome: 'SUCCEEDED', contentHash: 'f'.repeat(64) });
 assert.equal((await pool.query('SELECT research_marketaux_usage_hold($1) AS held', [f.accountId])).rows[0].held, false);
 await assert.rejects(reserveNews(f, demand), /RESEARCH_PROVIDER_USAGE_HOLD/);
 assert.deepEqual((await attemptRow(pool, demand)).provider_refusal, refused);
 const reason = 'RESEARCH_PROVIDER_USAGE_HOLD';
 await f.store.finishMarketauxFailure(demand, { reason, outcome: 'FAILED' }, stamp => {
  const snapshot = f.empty(stamp); snapshot.coverage.push({ sourceId: f.source.id, role: 'news', status: 'ERROR', complete: false,
   checkedAt: stamp, windowStart: demand.windowStart, windowEnd: demand.asOf, evidenceRefs: [], reason }); return snapshot;
 });
 const original = await attemptRow(pool, demand);
 assert.equal(original.state, 'FAILED'); assert.equal(original.failure_reason, reason);
 assert.equal((await newsAcquisition(f)).state, 'WAITING');
 await advance(31000); await f.observe(); await f.store.prepareRepair(f.identity);
 const replacement = await claim(f, 'demand'); assert.notEqual(replacement.attemptId, demand.attemptId);
 assert.deepEqual(await attemptRow(pool, demand), original);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1', [demand.attemptId])).rows[0].n, 0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 2);
}));

test('429 reservation refusal preserves fresh cache when its cooldown expires before settlement', { skip: !connection }, () => isolated(async (pool, advance) => {
 const f = await seedTwoSourceResearchStore(pool), before = (await f.store.latestSnapshot(f.identity))!;
 await advance(3601000); await f.observe();
 const own = await claim(f), other = otherIssuer(f), quota = await claim(other);
 await failNews(other, quota, { status: 429 });
 await assert.rejects(reserveNews(f, own), /RESEARCH_PROVIDER_COOLDOWN/);
 const refused = (await attemptRow(pool, own)).provider_refusal;
 assert.equal(refused.reason, 'RESEARCH_PROVIDER_COOLDOWN');
 await advance(61000); await f.observe();
 await assert.rejects(reserveNews(f, own), /RESEARCH_PROVIDER_COOLDOWN/);
 assert.deepEqual((await attemptRow(pool, own)).provider_refusal, refused);
 const result = await f.store.finishMarketauxFailure(own, { reason: 'RESEARCH_PROVIDER_COOLDOWN', outcome: 'FAILED' }, stamp => {
  const snapshot = f.empty(stamp); snapshot.coverage.push({ sourceId: f.source.id, role: 'news', status: 'ERROR', complete: false,
   checkedAt: stamp, windowStart: own.windowStart, windowEnd: own.asOf, evidenceRefs: [], reason: 'RESEARCH_PROVIDER_COOLDOWN' }); return snapshot;
 });
 assert.equal(result.retained, true); assert.equal(result.snapshot?.id, before.id);
 const row = await attemptRow(pool, own); assert.equal(row.failure_class, 'TRANSIENT'); assert.equal(row.failure_reason, 'RESEARCH_PROVIDER_COOLDOWN');
 assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1', [own.attemptId])).rows[0].n, 0);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n, 3);
}));

test('SQL provider refusal requires a current proved hold and remains immutable after committed reservation denial', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), own = await claim(f), other = otherIssuer(f), quota = await claim(other);
 const marker = (stamp = 'clock_timestamp()', extra = '') => pool.query(`UPDATE research_marketaux_attempts
  SET provider_refusal=jsonb_build_object('reason','RESEARCH_PROVIDER_COOLDOWN','recordedAt',${stamp})${extra} WHERE id=$1`, [own.attemptId]);
 await assert.rejects(marker(), /RESEARCH_PROVIDER_REFUSAL_INVALID/);
 await failNews(other, quota, { status: 429 });
 await assert.rejects(marker("clock_timestamp()+interval '1 hour'"), /RESEARCH_PROVIDER_REFUSAL_INVALID/);
 await assert.rejects(marker('clock_timestamp()', ",failure_reason='RESEARCH_SOURCE_TIMEOUT'"), /RESEARCH_PROVIDER_REFUSAL_INVALID/);
 assert.equal((await attemptRow(pool, own)).provider_refusal, null);
 await assert.rejects(reserveNews(f, own), /RESEARCH_PROVIDER_COOLDOWN/);
 const saved = (await attemptRow(pool, own)).provider_refusal;
 const proof = (await pool.query(`SELECT (provider_refusal->>'recordedAt')::timestamptz>=started_at
  AND (provider_refusal->>'recordedAt')::timestamptz<deadline_at
  AND (provider_refusal->>'recordedAt')::timestamptz<=clock_timestamp() AS valid FROM research_marketaux_attempts WHERE id=$1`, [own.attemptId])).rows[0];
 assert.equal(proof.valid, true);
 await assert.rejects(pool.query('UPDATE research_marketaux_attempts SET provider_refusal=NULL WHERE id=$1', [own.attemptId]), /RESEARCH_PROVIDER_REFUSAL_IMMUTABLE/);
 await assert.rejects(pool.query("UPDATE research_marketaux_attempts SET provider_refusal=provider_refusal||'{\"reason\":\"RESEARCH_PROVIDER_USAGE_HOLD\"}'::jsonb WHERE id=$1", [own.attemptId]), /RESEARCH_PROVIDER_REFUSAL_IMMUTABLE/);
 assert.deepEqual((await attemptRow(pool, own)).provider_refusal, saved);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1', [own.attemptId])).rows[0].n, 0);
}));

for (const readback of [true, false]) test(`lost provider-refusal COMMIT acknowledgement requires exact readback=${readback}`, { skip: !connection }, () => isolated(async pool => {
 let lose = false, hide = false;
 const proxy = { query: (sql: string, args?: unknown[]) => pool.query(sql, args), connect: async () => {
  const raw = await pool.connect(); let wroteMarker = false;
  return { release: (destroy?: boolean) => raw.release(destroy), query: async (sql: string, args?: unknown[]) => {
   if (sql.startsWith('UPDATE research_marketaux_attempts SET provider_refusal=')) wroteMarker = true;
   const result = await raw.query(sql, args);
   if (sql === 'COMMIT' && wroteMarker && lose) { lose = false; hide = !readback; throw new Error('synthetic lost refusal commit acknowledgement'); }
   if (hide && sql.startsWith('SELECT * FROM research_marketaux_attempts WHERE id=')) return { ...result, rows: [] };
   return result;
  } };
 } };
 const f = await seedTwoSourceResearchStore(proxy, { publishNews: false }), own = await claim(f), other = otherIssuer(f), quota = await claim(other);
 await failNews(other, quota, { status: 429 }); lose = true;
 await assert.rejects(reserveNews(f, own), readback ? /RESEARCH_PROVIDER_COOLDOWN/ : /synthetic lost refusal commit acknowledgement/);
 assert.equal(lose, false); hide = false;
 assert.equal((await attemptRow(pool, own)).provider_refusal.reason, 'RESEARCH_PROVIDER_COOLDOWN');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1', [own.attemptId])).rows[0].n, 0);
 if (!readback) {
  const result = await f.store.finishMarketauxFailure(own, { reason: 'RESEARCH_PROVIDER_COOLDOWN', outcome: 'FAILED' }, f.empty);
  assert.equal(result.snapshot, null); assert.equal((await attemptRow(pool, own)).state, 'UNKNOWN');
 }
}));

test('direct SQL429 cannot omit cooldown, pass NULL timing or understate malformed-header fallback', { skip: !connection }, () => isolated(async pool => {
 const f = await seedTwoSourceResearchStore(pool, { publishNews: false }), t = await claim(f);
 await pool.query("UPDATE research_marketaux_attempts SET state='FINALIZING' WHERE id=$1", [t.attemptId]);
 const settle = (extra: string) => pool.query(`WITH stamp AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) AS at)
  UPDATE research_marketaux_attempts SET state='UNKNOWN',finished_at=stamp.at,failure_class='UNKNOWN',
   failure_reason='RESEARCH_SOURCE_HTTP_429',source_error='{"name":"Error","code":null,"message":"Synthetic429","httpStatus":429}'::jsonb
   ${extra} FROM stamp WHERE id=$1`, [t.attemptId]);
 for (const extra of ['', ',provider_not_before=NULL', ",provider_not_before=stamp.at+interval '59 seconds'",
  ',provider_not_before=NULL,provider_retry_invalid=true', ",provider_not_before=stamp.at+interval '60 seconds',provider_retry_invalid=true"])
  await assert.rejects(settle(extra), /RESEARCH_PROVIDER_COOLDOWN_INVALID/);
 await settle(",provider_not_before=stamp.at+interval '60 seconds'");
 assert.equal((await pool.query("SELECT provider_not_before=finished_at+interval '60 seconds' AS bounded FROM research_marketaux_attempts WHERE id=$1", [t.attemptId])).rows[0].bounded, true);
}));
