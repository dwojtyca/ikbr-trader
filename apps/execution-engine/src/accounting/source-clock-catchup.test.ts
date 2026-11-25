import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountingSourceService } from './source-service.js';
import type { AccountingSourceOwner } from './source-owner.js';
import type { AccountingSocket } from './source-collector.js';
import { AccountingSourceStore, type SourceControl, type SourceObservation } from './source-store.js';
import type { Pool, PoolClient } from 'pg';
import type { AccountingCapture, SourceSettingsV1, StoredQualification } from './types.js';
import { OFFICIAL_SDK_SHA256 } from './official-sdk-bridge.js';
import type { BrokerReconciliationSnapshot } from '../reconciliation/broker-adapter.js';
import type { BrokerPhaseEvent } from '../reconciliation/phase-diagnostics.js';

async function fixture(skew = 55) {
  const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: 'PRIVATE-ACCOUNT',
    endpoint: { host: 'unused', port: 1 }, sourceClientId: 0, executionTimeZone: 'UTC' };
  const control: SourceControl = { source_id: 'source', process_session_id: 'session', connection_generation: 1, semantic_revision: 0,
    qualification_id: null, gap: true, hold: null, settings_hash: 'hash', lanes: { accounting: { received: 0, persisted: 0, pending: 0 }, execution: { received: 0, persisted: 0, pending: 0 } } };
  const identity = { connected: true, accountId: settings.accountId, sessionId: 'session', generation: 1 };
  const observations: SourceObservation[] = [], captures: AccountingCapture[] = [], qualifications: StoredQualification[] = [], events: BrokerPhaseEvent[] = [];
  let ownerLost = false, brokerTime = 0;
  const owner = { acquire: async () => {}, assertCurrent: () => { if (ownerLost) throw new Error('ACCOUNTING_SOURCE_OWNER_LOST'); }, assertHeld: () => {},
    retire: async () => {}, release: async () => {}, endpoint: () => settings.endpoint } as unknown as AccountingSourceOwner;
  const store = { sourceId: 'source', sessionId: 'session', rejectedClock: async () => null, recovery: { initialize: async () => {}, latest: async () => null },
    begin: async () => control, control: async () => control, qualification: async () => null, latestValues: async () => [],
    gap: async (generation: number) => { control.connection_generation = generation; control.semantic_revision = Number(control.semantic_revision) + 1; return control; },
    databaseTime: async (_timeoutMs: number) => Date.now(),
    append: async (observation: SourceObservation) => { observations.push(observation); return { control, value: observation.value }; },
    recordQualification: async (record: StoredQualification, current: () => void) => {
      current(); assert.ok(brokerTime <= Date.now()); qualifications.push(record); control.qualification_id = record.id;
      control.semantic_revision = Number(control.semantic_revision) + 1; return control;
    },
    publish: async (capture: AccountingCapture, current: () => void) => { current(); assert.ok(Date.parse(capture.coveredThrough) <= Date.parse(capture.capturedAt)); captures.push(capture); },
  };
  const socket = new EventEmitter() as EventEmitter & AccountingSocket;
  Object.assign(socket, { serverVersion: 226, automatic: true, sdkSha256: OFFICIAL_SDK_SHA256,
    reqConfig: async () => ({ masterClientIdPresent: true, masterClientId: 0 }),
    connect: () => { socket.emit('server', 226, 'test'); socket.emit('nextValidId', 1); },
    disconnect: () => { socket.emit('disconnected'); socket.emit('transportClosed'); },
    reqManagedAccts: () => socket.emit('managedAccounts', settings.accountId),
    reqCurrentTime: () => { brokerTime = Date.now() + skew; socket.emit('currentTimeInMillis', brokerTime); },
    reqExecutions: (id: number) => socket.emit('execDetailsEnd', id),
  });
  const service = new AccountingSourceService(store as unknown as AccountingSourceStore, settings, 'hash', () => identity, () => socket,
    { emit: event => events.push(event), privacy: () => ({ accountIds: [settings.accountId] }) }, { owner, automaticSourceRecoveryEnabled: true });
  await service.initialize();
  const snapshot = { exposureComplete: true, recoveryComplete: true, accountId: settings.accountId, sessionId: identity.sessionId,
    connectionGeneration: identity.generation, sourceCoverage: { executions: { window: {} } } } as unknown as BrokerReconciliationSnapshot;
  return { service, store, socket, identity, control, observations, captures, qualifications, events, loseOwner: () => { ownerLost = true; }, brokerTime: () => brokerTime,
    join: (timeoutMs = 1000, abortSignal = new AbortController().signal) => service.join(snapshot,
      { runId: 42, positionGeneration: 1, recoveryStart: new Date(Date.now() - 1000), timeoutMs, abortSignal }) };
}

test('small positive skew waits for genuine history before first qualification and repeated captures', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 3; n++) { const result = await f.join(); f.service.assertCurrent(result.accounting); }
    assert.equal(f.qualifications.length, 1); assert.equal(f.captures.length, 3);
    assert.ok(f.observations.filter(o => o.kind === 'inspection').every(o => {
      const value = o.value as { brokerTime: string; completedAt: string }; return Date.parse(value.brokerTime) <= Date.parse(value.completedAt);
    }));
    assert.ok(f.events.some(e => e.phase === 'accounting.clock_catchup' && e.outcome === 'ok' && /localLeadMs=/.test(e.reason ?? '')));
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE-ACCOUNT/);
  } finally { await f.service.close(); }
});
test('database lag independently delays publication even after the local clock caught up', async () => {
  const f = await fixture(0); let reads = 0;
  f.store.databaseTime = async () => { reads++; return Date.now() - 55; };
  try { await f.join(); assert.ok(reads >= 2); assert.ok(f.brokerTime() <= Date.now() - 55); }
  finally { await f.service.close(); }
});
test('already historical evidence needs only one clock read', async () => {
  const f = await fixture(-100); let reads = 0;
  f.store.databaseTime = async () => { reads++; return Date.now(); };
  try { await f.join(); assert.equal(reads, 1); } finally { await f.service.close(); }
});
for (const mode of ['broker-lead', 'database-lead', 'database-stale', 'invalid-database'] as const) test(`${mode} never qualifies or publishes`, async () => {
  const f = await fixture(mode === 'broker-lead' ? 2100 : 0);
  if (mode !== 'broker-lead') f.store.databaseTime = async () => mode === 'invalid-database' ? NaN : Date.now() + (mode === 'database-lead' ? -2100 : 11000);
  try {
    await assert.rejects(f.join(), mode === 'database-stale' ? /EVIDENCE_STALE/ : /CLOCK_INVALID/);
    assert.equal(f.qualifications.length, 0); assert.equal(f.captures.length, 0);
    assert.doesNotMatch(JSON.stringify(f.events), /NaN|Infinity/);
  } finally { await f.service.close(); }
});
for (const when of ['before', 'waiting', 'database-read'] as const) test(`abort ${when} prevents late publication`, async () => {
  const f = await fixture(200), abort = new AbortController();
  let finishRead: (() => void) | undefined;
  if (when === 'database-read') f.store.databaseTime = () => new Promise(resolve => { finishRead = () => resolve(Date.now()); abort.abort(); });
  if (when === 'before') abort.abort();
  const timer = when === 'waiting' ? setTimeout(() => abort.abort(), 20) : undefined;
  try {
    await assert.rejects(f.join(1000, abort.signal), /REPLAY_INCOMPLETE/);
    finishRead?.(); await delay(5); assert.equal(f.qualifications.length, 0); assert.equal(f.captures.length, 0);
  } finally { clearTimeout(timer); await f.service.close(); }
});
test('hanging database read consumes the original finite deadline', async () => {
  const f = await fixture(); f.store.databaseTime = () => new Promise(() => {});
  const started = performance.now();
  try { await assert.rejects(f.join(60), /REPLAY_INCOMPLETE/); assert.ok(performance.now() - started < 500); assert.equal(f.captures.length, 0); }
  finally { await f.service.close(); }
});
test('replay time is charged to the original deadline before catch-up', async () => {
  const f = await fixture(200); f.socket.reqExecutions = id => { setTimeout(() => f.socket.emit('execDetailsEnd', id), 80); };
  const started = performance.now();
  try { await assert.rejects(f.join(120), /REPLAY_INCOMPLETE/); assert.ok(performance.now() - started < 220); assert.equal(f.captures.length, 0); }
  finally { await f.service.close(); }
});
test('wall-clock rollback does not re-arm catch-up deadline', async t => {
  const f = await fixture(100); const now = Date.now; let reads = 0;
  f.store.databaseTime = async () => { if (++reads === 1) t.mock.method(Date, 'now', () => now() - 100); return now(); };
  const started = performance.now();
  try { await assert.rejects(f.join(80), /REPLAY_INCOMPLETE/); assert.ok(performance.now() - started < 500); assert.equal(f.captures.length, 0); }
  finally { t.mock.restoreAll(); await f.service.close(); }
});
test('fixed two-second catch-up cap survives stalled clocks and a longer operation budget', async t => {
  const f = await fixture(100), frozen = Date.now(); t.mock.method(Date, 'now', () => frozen);
  const started = performance.now();
  try {
    await assert.rejects(f.join(5000), /REPLAY_INCOMPLETE/);
    assert.ok(performance.now() - started >= 1900); assert.ok(performance.now() - started < 4000);
    assert.equal(f.captures.length, 0); assert.equal(f.qualifications.length, 0);
  } finally { t.mock.restoreAll(); await f.service.close(); }
});
test('Warsaw account-day rollover is rejected without qualifying future-day evidence', async t => {
  const f = await fixture(55);
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 25, 22, 59, 59, 990));
  try { await assert.rejects(f.join(), /EVIDENCE_STALE/); assert.equal(f.qualifications.length, 0); assert.equal(f.captures.length, 0); }
  finally { t.mock.restoreAll(); await f.service.close(); }
});
test('clock read acquisition timeout destroys a late client without issuing a query', async () => {
  let acquire!: (db: PoolClient) => void, destroyed: boolean | undefined, queries = 0;
  const db = { release: (destroy: boolean) => { destroyed = destroy; }, query: () => { queries++; } } as unknown as PoolClient;
  const pool = { connect: () => new Promise<PoolClient>(resolve => { acquire = resolve; }) } as unknown as Pool;
  const store = new AccountingSourceStore(pool, 'source', 'session');
  await assert.rejects(store.databaseTime(20), /PERSISTENCE_TIMEOUT/);
  acquire(db); await delay(0); assert.equal(destroyed, true); assert.equal(queries, 0);
});
test('failed clock query destroys its client and uses a bounded read without transaction locks', async () => {
  let destroyed: boolean | undefined;
  const failure = new Error('read failed');
  const db = { release: (destroy: boolean) => { destroyed = destroy; }, query: async (query: { text: string; query_timeout: number }) => {
    assert.equal(query.text, 'SELECT clock_timestamp() AS now'); assert.ok(query.query_timeout > 0 && query.query_timeout <= 100);
    throw failure;
  } } as unknown as PoolClient;
  const store = new AccountingSourceStore({ connect: async () => db } as unknown as Pool, 'source', 'session');
  await assert.rejects(store.databaseTime(100), error => error === failure); assert.equal(destroyed, true);
});
for (const change of ['owner', 'generation', 'execution', 'revision', 'lane'] as const) test(`${change} change during catch-up is fenced`, async () => {
  const f = await fixture(100); let reads = 0;
  f.store.databaseTime = async () => {
    if (++reads === 2) {
      if (change === 'owner') f.loseOwner();
      if (change === 'generation') f.socket.disconnect();
      if (change === 'execution') f.identity.generation++;
      if (change === 'revision') f.control.semantic_revision = Number(f.control.semantic_revision) + 1;
      if (change === 'lane') f.service.observeCommission({ execId: 'new', currency: 'USD', commission: 1, realizedPnL: 0 }, async () => {});
    }
    return Date.now();
  };
  try { await assert.rejects(f.join(), /SOURCE_OWNER_LOST|SOURCE_GAP|REVISION_CHANGED|PERSISTENCE_PENDING/); assert.equal(f.captures.length, 0); assert.equal(f.qualifications.length, 0); }
  finally { await f.service.close(); }
});
for (const stage of ['inspection', 'qualification', 'publication'] as const) test(`${stage} delay cannot publish stale evidence`, async t => {
  const f = await fixture(0), now = Date.now;
  const age = () => t.mock.method(Date, 'now', () => now() + 11000);
  if (stage === 'inspection') { const original = f.store.append; f.store.append = async o => { const result = await original(o); if (o.kind === 'inspection') age(); return result; }; }
  if (stage === 'qualification') { const original = f.store.recordQualification; f.store.recordQualification = async (q, guard) => { age(); return original(q, guard); }; }
  if (stage === 'publication') { const original = f.store.publish; f.store.publish = async (c, guard) => { age(); return original(c, guard); }; }
  try { await assert.rejects(f.join(), /EVIDENCE_STALE/); assert.equal(f.captures.length, 0); }
  finally { t.mock.restoreAll(); await f.service.close(); }
});
