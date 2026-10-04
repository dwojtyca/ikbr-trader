import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateResearchOrderContext, type ResearchOrderContextV1 } from './research-order-context.js';
const nowMs = Date.parse('2026-10-04T12:00:00.000Z');
const stamp = (delta = 0) => new Date(nowMs + delta).toISOString();
function fixture(): ResearchOrderContextV1 {
  return { schemaVersion: 1, proposedOrderId: 1, clientOrderHash: 'a'.repeat(64), effectiveConfigHash: 'b'.repeat(64), accountId: 'DU_TEST',
    sessionId: 'session', instrumentId: 'synthetic', conid: '123', connectionGeneration: 3, requestedAt: stamp(-100), completedAt: stamp(), validUntilMs: nowMs + 9000,
    reconciliation: { runId: 1, positionGeneration: 2, requestStartedAt: stamp(-1000), completedAt: stamp(-100), capturedAt: stamp(-200), complete: true,
      positions: [{accountId:'DU_TEST',conId:'123',symbol:'SYN',position:1}], openOrders: [{accountId:'DU_TEST',brokerOrderId:'1',conId:'123',status:'Submitted'}] },
    account: { requestStartedAt: stamp(-100), completedAt: stamp(), configuredBaseCurrency: 'USD', cashByCurrency: {USD:5000}, exchangeRatesToBase:{USD:1},
      usdMetrics: {netLiquidation:10000, availableFunds:5000,grossPositionValue:1000} },
    quote:{bid:99,ask:100,bidObservedAt:stamp(-100),askObservedAt:stamp()},
    valuation:{quoteCurrency:'USD',valuationCurrency:'USD',quoteNotional:100,quoteStopRisk:1,fxToUsd:1,fxSource:'same_currency',fxValuationBuffer:1},
    fees:{currency:'USD',reserve:5,source:'configured_risk_reserve',estimateStatus:'UNAVAILABLE'},
    risk:{ok:true,evidence:{accountId:'DU_TEST',sessionId:'session',instrumentId:'synthetic',conid:'123',assessedAtMs:nowMs,validUntilMs:nowMs+9900}} };
}
test('trusted context retains complete exposures, valuation source and fee uncertainty', () => {
  const value = fixture();
  assert.deepEqual(validateResearchOrderContext(value,value,nowMs),value);
});
for (const [name, mutate] of [
  ['stale reconciliation', (c: ResearchOrderContextV1) => c.reconciliation.requestStartedAt=stamp(-10_000)],
  ['future quote', (c: ResearchOrderContextV1) => c.quote.askObservedAt=stamp(1)],
  ['incomplete orders', (c: ResearchOrderContextV1) => { c.reconciliation.complete=false as true; }],
  ['wrong risk session', (c: ResearchOrderContextV1) => { c.risk.evidence.sessionId='other'; }],
  ['unknown position identity', (c: ResearchOrderContextV1) => { delete c.reconciliation.positions[0].conId; }],
  ['wrong order account', (c: ResearchOrderContextV1) => { c.reconciliation.openOrders[0].accountId='OTHER'; }],
  ['expired risk', (c: ResearchOrderContextV1) => { c.risk.evidence.validUntilMs=nowMs; }],
  ['invented long validity', (c: ResearchOrderContextV1) => { c.validUntilMs=nowMs+10_001; }],
  ['missing PLN FX', (c: ResearchOrderContextV1) => { c.valuation.quoteCurrency='PLN';c.valuation.fxSource='ib_account_exchange_rate';c.fees.currency='PLN'; }],
  ['nonfinite risk time', (c: ResearchOrderContextV1) => { c.risk.evidence.assessedAtMs=NaN; }],
] as const) test(`context rejects ${name}`, () => {
  const value=fixture(),identity=structuredClone(value);mutate(value);assert.throws(()=>validateResearchOrderContext(value,identity,nowMs));
});
test('same-age context cannot replace the proposal or configuration identity',()=>{
  const context=fixture();assert.throws(()=>validateResearchOrderContext(context,{...context,clientOrderHash:'c'.repeat(64)},nowMs));
});
