import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FullCloseService } from './close-service.js';
import type { CloseRepository } from './close-repository.js';
import type { CloseOperation, ClosePrepared, CloseRisk } from './close-types.js';
import { fixture } from './close-test-fixture.js';
test('expiry while loading original context after durable claim preserves unknown close and sends nothing', async () => {
  const f = fixture(), realNow = Date.now, start = realNow(); let op: CloseOperation | null = null, writes = 0;
  const repo = {
    get: async () => op, execution: { getLifecycleEvidence: async () => f.evidence }, evidence: async () => f.evidence,
    reserve: async () => {
      op = { id: 1, originalProposalId: 42, requestId: 'fixture', accountId: 'DU_TEST', sessionId: 'session', clientId: 1, generation: 1,
        originalHash: f.evidence.clientOrderHash!, instrumentId: 'test', conid: '123', limitPrice: 100, state: 'PREPARING', owner: 'fixture',
        terminals: [], cancelAttempts: [], barrierAt: null, closeProposalId: null, closeLink: null, submissionAttemptedAt: null, observation: null, failureReason: null };
      return { operation: op, created: true };
    },
    claim: async (_op: CloseOperation, _ticket: unknown, _prepared: unknown, risk: CloseRisk, _context: unknown, _evaluate: unknown, validate: () => Promise<void>) => {
      await validate(); op!.submissionAttemptedAt = new Date(start).toISOString(); op!.riskExpiresAt = risk.expiresAt; op!.state = 'SUBMISSION_UNKNOWN'; return op!;
    },
    block: async (_op: CloseOperation, state: CloseOperation['state'], reason: string) => { op!.state = state; op!.failureReason = reason; return op!; },
    claimAlert: async () => false, observe: async () => op!,
  } as unknown as CloseRepository;
  const service = new FullCloseService(repo, {
    context: async () => { await Promise.resolve(); if (op?.submissionAttemptedAt) Date.now = () => start + 10000;
      return { accountId: 'DU_TEST', sessionId: 'session', clientId: 1, generation: 1, nowMs: Date.now(), bound: f.context.bound }; },
    refresh: async () => {}, evaluate: () => ({ ok: true, reasons: [], quantity: 1, residualQuantity: 1, allTerminal: true, closeWorking: false, canComplete: false, barrierAt: null,
      legs: ['PARENT', 'TP', 'SL'].map(role => ({ role: role as 'PARENT' | 'TP' | 'SL', brokerOrderId: role, orderRef: role, permId: role, accountId: 'DU_TEST', conid: '123', clientId: 1, working: false, fullyFilled: true, observedAt: new Date(start).toISOString() })) }),
    assessRisk: async () => ({ ok: true, reasons: [], evidence: {}, expiresAt: new Date(start + 10000).toISOString() }),
    prepare: async () => ({} as ClosePrepared), validatePrepared: () => {}, cancel: async () => { throw Error('not working'); },
    dispatch: async () => { writes++; }, alert: async () => {},
  });
  try {
    const result = await service.request(42, 'fixture', 100, 'fixture');
    assert.equal(result.state, 'SUBMISSION_UNKNOWN'); assert.equal(result.failureReason, 'close_dispatch_risk_expired');
    assert.equal(result.submissionAttemptedAt, new Date(start).toISOString()); assert.equal(writes, 0);
  } finally { Date.now = realNow; }
});
