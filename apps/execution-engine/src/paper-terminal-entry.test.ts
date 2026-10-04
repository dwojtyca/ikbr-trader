import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundTrip } from './lifecycle/round-trip-test-fixture.js';
import { isProvenUnfilledPaperEntry } from './paper-terminal-entry.js';
function fixture() {
  const f = roundTrip(); f.snapshot.executions.splice(0); f.coverage.executions.count = 0; f.evidence.fills = [];
  const completedOrders = f.evidence.lifecycle.links.map(link => ({ accountId: f.context.accountId, conId: f.order.conid,
    brokerOrderId: link.broker_order_id, orderRef: link.order_ref, permId: link.perm_id, filled: 0, remaining: 0,
    action: link.role === 'PARENT' ? 'BUY' : 'SELL', secType: 'STK', currency: 'PLN', terminalStatus: 'Cancelled', observedAt: new Date(f.context.nowMs - 500).toISOString() }));
  Object.assign(f.snapshot, { completedOrders });
  Object.assign(f.coverage, { completedOrders: { available: true, boundedWindow: true, timedOut: false, count: 3 } });
  return { ...f, completedOrders };
}
test('known zero-fill terminal bracket releases only active ownership, preserving original attempt', () => {
  const f = fixture(); const original = structuredClone(f.evidence);
  assert.equal(isProvenUnfilledPaperEntry(f.evidence, f.context), true); assert.deepEqual(f.evidence, original);
});
test('missing/ambiguous terminal leg, residual fill and wrong typed cancellation never release ownership', () => {
  for (const patch of [{ terminalStatus: 'Submitted' }, { filled: 1 }, { secType: 'FUT' }, { currency: 'USD' }, { brokerOrderId: 'unknown' }]) {
    const f = fixture(); Object.assign(f.completedOrders[0], patch); assert.equal(isProvenUnfilledPaperEntry(f.evidence, f.context), false);
  }
  const missing = fixture(); missing.completedOrders.pop(); assert.equal(isProvenUnfilledPaperEntry(missing.evidence, missing.context), false);
});

test('completed cancel-only operation accepts exact durable terminals, never close marker or missing child',()=>{
 const f=fixture();
 f.evidence.close={state:'COMPLETED',accountId:'DU_TEST',conid:'123',originalHash:f.evidence.lifecycle.clientOrderHash!,closeProposalId:null,links:[],submissionAttemptedAt:null,generation:1,sessionId:'current',clientId:7,barrierAt:new Date(f.context.nowMs-2000).toISOString(),terminals:f.evidence.lifecycle.links.map(link=>({role:link.role as 'PARENT'|'TP'|'SL',brokerOrderId:link.broker_order_id!,orderRef:link.order_ref,permId:link.perm_id,accountId:'DU_TEST',conid:'123',clientId:7,status:'CANCELLED',generation:1,sessionId:'current',confirmedAt:new Date(f.context.nowMs-2000).toISOString()}))};
 assert.equal(isProvenUnfilledPaperEntry(f.evidence,f.context),true);
 f.evidence.close.terminals!.pop();assert.equal(isProvenUnfilledPaperEntry(f.evidence,f.context),false);
 f.evidence.close.terminals!.push({ ...f.evidence.close.terminals![0] });assert.equal(isProvenUnfilledPaperEntry(f.evidence,f.context),false);
 f.evidence.close.submissionAttemptedAt=new Date();assert.equal(isProvenUnfilledPaperEntry(f.evidence,f.context),false);
});
