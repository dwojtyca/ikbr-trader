import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AccountingSourceService } from './source-service.js';
import type { AccountingSocket } from './source-collector.js';
import type { AccountingSourceStore, SourceControl, SourceObservation } from './source-store.js';
import type { SourceSettingsV1, StoredQualification } from './types.js';
import type { BrokerReconciliationSnapshot } from '../reconciliation/broker-adapter.js';
import type { BrokerPhaseEvent } from '../reconciliation/phase-diagnostics.js';

async function fixture(mode: 'ok' | 'drain' | 'cost' | 'publication') {
  const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper',
    accountId: 'PRIVATE-ACCOUNT', endpoint: { host: 'unused', port: 1 }, sourceClientId: 0, executionTimeZone: 'UTC' };
  const control: SourceControl = { source_id: 'source', process_session_id: 'process', connection_generation: 1, semantic_revision: 0,
    qualification_id: 'qualification', gap: true, hold: null, settings_hash: 'hash',
    lanes: { accounting: { received: 0, persisted: 0, pending: 0 }, execution: { received: 0, persisted: 0, pending: 0 } } };
  const original = Object.assign(new Error('PRIVATE-ACCOUNT private-secret operation failed'), { name: 'DatabaseFailure', code: '08006' });
  const events: BrokerPhaseEvent[] = [];
  const qualification = { id: 'qualification', settings, input: { settingsSha256: 'hash' }, protocolVersion: 178,
    expiresAt: new Date(Date.now() + 60_000).toISOString() } as StoredQualification;
  const store = { sourceId: 'source', sessionId: 'process', begin: async () => control, qualification: async () => qualification,
    latestValues: async () => [], gap: async () => control,
    append: async (observation: SourceObservation) => { if (mode === 'drain') throw original; return { control, value: observation.value }; },
    publish: async (_capture: unknown, validate: () => void) => { validate(); if (mode === 'publication') throw original; },
  } as unknown as AccountingSourceStore;
  const socket = new EventEmitter() as EventEmitter & AccountingSocket;
  Object.assign(socket, { serverVersion: 178,
    connect: () => { socket.emit('server', 178, 'private'); socket.emit('nextValidId', 1); }, disconnect: () => {},
    reqManagedAccts: () => socket.emit('managedAccounts', settings.accountId),
    reqCurrentTime: () => socket.emit('currentTime', Math.floor(Date.now() / 1000)),
    reqExecutions: (requestId: number) => {
      if (mode === 'cost') socket.emit('execDetails', requestId,
        { conId: 1, secType: 'STK', symbol: 'PKO', currency: 'PLN', exchange: 'WSE' },
        { execId: 'exec.1', acctNumber: settings.accountId, orderId: 1, side: 'BOT', shares: 1, price: 1,
          time: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().slice(0, 19).replaceAll('-', '').replace('T', ' ') });
      socket.emit('execDetailsEnd', requestId);
    },
  });
  const service = new AccountingSourceService(store, settings, 'hash', () => ({ connected: true, accountId: settings.accountId,
    sessionId: 'process', generation: 1 }), () => socket,
  { emit: event => events.push(event), privacy: () => ({ accountIds: [settings.accountId], secrets: ['private-secret'] }) });
  await service.initialize();
  const snapshot = { exposureComplete: true, recoveryComplete: true, accountId: settings.accountId, sessionId: 'process', connectionGeneration: 1,
    sourceCoverage: { executions: { window: {} } } } as unknown as BrokerReconciliationSnapshot;
  return { service, events, original, join: () => service.join(snapshot,
    { runId: 42, positionGeneration: 1, recoveryStart: new Date(), timeoutMs: 25, abortSignal: new AbortController().signal }) };
}
test('accounting diagnostics cover successful drain, costs and publication with run identity', async () => {
  const f = await fixture('ok'); const result = await f.join(); assert.ok(result.accounting);
  for (const phase of ['accounting.drain', 'accounting.cost_wait', 'accounting.inspection_persistence', 'accounting.publication']) {
    assert.ok(f.events.some(event => event.phase === phase && event.outcome === 'ok' && event.runId === 42), phase);
  }
  assert.ok(f.events.some(event => event.phase === 'accounting.clock_wait' && event.runId === 42));
  await f.service.close();
});
for (const mode of ['drain', 'cost', 'publication'] as const) test(`${mode} failure is distinguished and original persistence causes survive mapping`, async () => {
  const f = await fixture(mode);
  await assert.rejects(f.join(), mode === 'cost' ? /FEE_PENDING/ : mode === 'drain' ? /PERSISTENCE_FAILED/ : error => error === f.original);
  assert.ok(f.events.some(event => event.phase === `accounting.${mode === 'cost' ? 'cost_wait' : mode}` && event.outcome === 'error'));
  if (mode !== 'cost') {
    const cause = f.events.find(event => event.cause?.code === '08006')?.cause;
    assert.equal(cause?.name, 'DatabaseFailure'); assert.match(cause!.message!, /operation failed/);
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE-ACCOUNT|private-secret/);
  }
  await f.service.close().catch(() => undefined);
});
