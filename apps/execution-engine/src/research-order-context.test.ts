import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { computeClientOrderHash } from '@ikbr/shared/client-order-hash';
import type { ProposedOrder } from '@ikbr/shared';
import type { AiEntryRiskEvidence } from './ai-entry-risk.js';
import type { AccountSnapshot } from './tws-execution-client.js';
import { buildResearchOrderContext, registerResearchOrderContextRoute, type ContextReconciliation } from './research-order-context.js';
import { registerExecutionAuth, AuthFailureBurstTracker } from './auth.js';
const nowMs = Date.parse('2026-10-04T12:00:00.000Z');
const stamp = (delta = 0) => new Date(nowMs + delta).toISOString();
function fixture() {
  const order: ProposedOrder = { id: 1, instrument:'SYN',instrumentId:'synthetic',conid:'123',side:'BUY',orderType:'LMT',quantity:1,entry:100,stop:99,takeProfit:102,
    confidence:0.8,reason:'trigger',timestamp:stamp(),riskCheckStatus:'PASS',status:'PROPOSED',strategy:'momentum_breakout_long_v1',
    clientOrderHashVersion:2,strategyAttribution:{version:1,implementationId:'momentum_breakout_long_v1',instanceId:'momentum',instanceRevision:1,instanceHash:'b'.repeat(64),
      effectiveConfigHash:'a'.repeat(64),instrumentId:'synthetic'},strategyTrigger:{version:1,source:'evaluation_bucket',timeframe:'1m',observedAt:stamp(),bucketStartMs:nowMs} };
  const risk = {accountId:'DU_TEST',sessionId:'session',instrumentId:'synthetic',conid:'123',assessedAtMs:nowMs,validUntilMs:nowMs+9900,
    accountRequestStartedAt:stamp(-100),accountCompletedAt:stamp(),bidObservedAt:stamp(-100),askObservedAt:stamp(),bid:99,ask:100,
    netLiquidation:10000,availableFunds:5000,grossPositionValue:1000,quoteCurrency:'USD',valuationCurrency:'USD',quoteNotional:100,quoteStopRisk:1,
    fxToUsd:1,fxValuationBuffer:1,fxSource:'same_currency',quoteFeeReserve:5,strategyEffectiveConfigHash:'a'.repeat(64),
    dailyLossEvidence:{reconciliationRunId:1,positionGeneration:2}} as AiEntryRiskEvidence;
  const snapshot: AccountSnapshot = {accountId:'DU_TEST',retrievedAt:stamp(),metrics:{},positions:[],
    totals:{positionsCount:0,longExposure:0,shortExposure:0,grossExposure:0,netExposure:0,unrealizedPnL:0,realizedPnL:0},riskEvidence:{requestStartedAt:stamp(-100),completedAt:stamp(),complete:true,configuredBaseCurrency:'USD',connectionGeneration:3,
    cashByCurrency:{USD:5000},exchangeRatesToBase:{USD:1},usdMetrics:{netLiquidation:10000,availableFunds:5000,grossPositionValue:1000}}};
  const coverage={available:true,boundedWindow:true,timedOut:false,count:0};
  const reconciliation: ContextReconciliation = {id:1,account_id:'DU_TEST',session_id:'session',status:'CLEAN',started_at:new Date(stamp(-1000)),completed_at:new Date(stamp(-100)),
    snapshot_complete:true,position_generation:2,current_position_generation:2,position_complete:true,position_session_id:'session',
    broker_snapshot:{accountId:'DU_TEST',sessionId:'session',capturedAt:new Date(stamp(-200)),connectionGeneration:3,exposureComplete:true,recoveryComplete:true,
      sourceCoverage:{positions:{...coverage},openOrders:{...coverage},completedOrders:{...coverage},session:{...coverage},
        executions:{available:true,timedOut:false,count:0,window:{from:stamp(-1000),to:stamp(-200),exposureWindowComplete:true,recoveryWindowComplete:true}}},
      positions:[],openOrders:[],completedOrders:[],executions:[]}};
  return {order,clientOrderHash:computeClientOrderHash(order),effectiveConfigHash:'a'.repeat(64),accountId:'DU_TEST',sessionId:'session',connectionGeneration:3,
    requestedAt:stamp(-100),nowMs,snapshot,risk,reconciliation};
}
test('broker context binds original proposal to exact complete reconciliation/account generation',()=>{
  const input=fixture(),context=buildResearchOrderContext(input);
  assert.equal(context.reconciliation.runId,1);assert.equal(context.validUntilMs,nowMs+9000);assert.equal(context.fees.estimateStatus,'UNAVAILABLE');
});
for (const [name,mutate] of [
  ['display-only summary', (i:ReturnType<typeof fixture>)=>{delete i.snapshot.riskEvidence;}],
  ['reconnected socket', (i:ReturnType<typeof fixture>)=>{i.connectionGeneration++;}],
  ['invalidated position generation', (i:ReturnType<typeof fixture>)=>{i.reconciliation.current_position_generation++;}],
  ['new running reconciliation', (i:ReturnType<typeof fixture>)=>{i.reconciliation.status='RUNNING';}],
  ['incomplete open orders', (i:ReturnType<typeof fixture>)=>{(i.reconciliation.broker_snapshot!.sourceCoverage.openOrders as {available:boolean}).available=false;}],
  ['unavailable completed coverage', (i:ReturnType<typeof fixture>)=>{(i.reconciliation.broker_snapshot!.sourceCoverage.completedOrders as {available:boolean}).available=false;}],
  ['missing order rows despite complete count', (i:ReturnType<typeof fixture>)=>{(i.reconciliation.broker_snapshot!.sourceCoverage.openOrders as {count:number}).count=1;}],
  ['wrong reconciliation session', (i:ReturnType<typeof fixture>)=>{i.reconciliation.session_id='old-session';}],
  ['stale but parseable evidence', (i:ReturnType<typeof fixture>)=>{i.reconciliation.started_at=new Date(stamp(-10_000));}],
  ['future broker capture', (i:ReturnType<typeof fixture>)=>{(i.reconciliation.broker_snapshot as {capturedAt:Date}).capturedAt=new Date(stamp(1));}],
  ['old risk reconciliation', (i:ReturnType<typeof fixture>)=>{i.risk.dailyLossEvidence!.reconciliationRunId=2;}],
  ['legacy unbound proposal', (i:ReturnType<typeof fixture>)=>{delete i.order.strategyAttribution;}],
  ['tampered original order', (i:ReturnType<typeof fixture>)=>{i.order.entry=101;}],
] as const) test(`broker context rejects ${name}`,()=>{const input=fixture();mutate(input);assert.throws(()=>buildResearchOrderContext(input));});
test('context route is authenticated and unavailable evidence never returns a context',async()=>{
  const app=Fastify();let calls=0;
  registerExecutionAuth(app,{token:'fixture-token',publicPaths:new Set(),writeAudit:()=>{},burstTracker:new AuthFailureBurstTracker(()=>{}),logger:{warn:()=>{}}});
  const input=fixture();
  registerResearchOrderContextRoute(app,{repo:{getExecutableProposedById:async()=>({order:input.order,clientOrderHash:input.clientOrderHash,clientOrderId:'fixture'})},
    prepare:async()=>{calls++;throw new Error('coverage_unavailable');}});
  assert.equal((await app.inject({url:'/execution/proposals/1/ai-context'})).statusCode,401);assert.equal(calls,0);
  const result=await app.inject({url:'/execution/proposals/1/ai-context',headers:{authorization:'Bearer fixture-token'}});
  assert.equal(result.statusCode,409);assert.equal(calls,1);assert.deepEqual(result.json(),{error:'coverage_unavailable'});await app.close();
});
