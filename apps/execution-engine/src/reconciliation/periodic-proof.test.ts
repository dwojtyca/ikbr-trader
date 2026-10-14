import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { AccountingCaptureReference } from '../accounting/types.js';
import { readPeriodicProof } from './periodic-proof.js';

function fixture() {
  const now = 1_000_000;
  const context = { accountId: 'PAPER', sessionId: 'session', sessionStartedAt: new Date(0) };
  const reference = { captureId: 'capture-42' } as AccountingCaptureReference;
  const snapshot: Record<string, unknown> = { accountId: context.accountId, sessionId: context.sessionId, connectionGeneration: 3,
    exposureComplete: true, recoveryComplete: true, accounting: reference, originalAcquisitionStartedAt: new Date(now - 1000).toISOString(),
    capturedAt: new Date(now).toISOString() };
  const state = {
    row: { id: '42', status: 'CLEAN', session_id: context.sessionId, holds: '0', now: new Date(now), broker_snapshot: snapshot } as Record<string, unknown> | undefined,
    identity: { connected: true, accountId: 'PAPER', sessionId: 'session', generation: 3 },
    accountingAvailable: true, accountingGap: false, accountingChecks: 0, queries: 0, afterQuery: () => {},
  };
  const db = { query: async (sql: string, parameters: unknown[]) => {
    state.queries++;
    assert.deepEqual(parameters, [context.accountId]);
    assert.match(sql, /reconciliation_holds WHERE account_id=\$1 AND active/);
    assert.match(sql, /ORDER BY started_at DESC,id DESC LIMIT 1/);
    state.afterQuery();
    return { rows: state.row ? [state.row] : [] };
  } } as unknown as Pick<Pool, 'query'>;
  const proof = () => readPeriodicProof({ db, currentIdentity: () => state.identity,
    accounting: () => state.accountingAvailable ? { assertCurrent: actual => {
      state.accountingChecks++; assert.equal(actual, reference);
      if (state.accountingGap) throw new Error('ACCOUNTING_SOURCE_GAP');
    } } : undefined }, context, 42);
  return { state, snapshot, proof, now };
}
test('production periodic proof checks the latest account run and current accounting reference without rejuvenating acquisition time', async () => {
  const f = fixture();
  assert.deepEqual(await f.proof(), { generation: 3, acquiredAt: f.now - 1000 });
  assert.equal(f.state.queries, 1); assert.equal(f.state.accountingChecks, 1);
});
const disqualifications: Record<string, (f: ReturnType<typeof fixture>) => void> = {
  'missing latest run': f => { f.state.row = undefined; },
  'different latest run': f => { f.state.row!.id = 43; },
  'latest run still running': f => { f.state.row!.status = 'RUNNING'; },
  'failed latest run': f => { f.state.row!.status = 'FAILED'; },
  'wrong run session': f => { f.state.row!.session_id = 'old-session'; },
  'active reconciliation hold': f => { f.state.row!.holds = '1'; },
  'missing broker snapshot': f => { f.state.row!.broker_snapshot = undefined; },
  'wrong snapshot account': f => { f.snapshot.accountId = 'OTHER'; },
  'wrong snapshot session': f => { f.snapshot.sessionId = 'old-session'; },
  'changed broker generation': f => { f.state.identity.generation++; },
  'partial exposure coverage': f => { f.snapshot.exposureComplete = false; },
  'partial recovery coverage': f => { f.snapshot.recoveryComplete = false; },
  'missing coverage': f => { delete f.snapshot.exposureComplete; },
  'missing accounting service': f => { f.state.accountingAvailable = false; },
  'missing accounting reference': f => { delete f.snapshot.accounting; },
  'current accounting gap': f => { f.state.accountingGap = true; },
  'missing original acquisition': f => { delete f.snapshot.originalAcquisitionStartedAt; },
  'invalid original acquisition': f => { f.snapshot.originalAcquisitionStartedAt = 'invalid'; },
  'future original acquisition': f => { f.snapshot.originalAcquisitionStartedAt = new Date(f.now + 1).toISOString(); },
  'expired original acquisition with fresh publication': f => { f.snapshot.originalAcquisitionStartedAt = new Date(f.now - 5001).toISOString(); },
  'disconnected current identity': f => { f.state.identity.connected = false; },
  'different current account': f => { f.state.identity.accountId = 'OTHER'; },
  'generation changes during proof query': f => { f.state.afterQuery = () => { f.state.identity.generation++; }; },
};
for (const [name, disqualify] of Object.entries(disqualifications)) test(`production periodic proof denies ${name}`, async () => {
  const f = fixture(); disqualify(f); assert.equal(await f.proof(), null);
});
test('production periodic proof retains the existing inclusive five-second acquisition bound', async () => {
  const f = fixture(); f.snapshot.originalAcquisitionStartedAt = new Date(f.now - 5000).toISOString();
  assert.deepEqual(await f.proof(), { generation: 3, acquiredAt: f.now - 5000 });
});
