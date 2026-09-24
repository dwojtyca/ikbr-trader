import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createAaplIdentityResolver, type AaplIdentityResolver } from './aapl-identity.js';
import { BoundReviewWorker } from './bound-review-worker.js';
import type { BoundClaim, BoundDecision } from './bound-review-repository.js';
import type { DecisionContext } from './openai-decider.js';
const now = Date.parse('2026-09-24T18:00:00Z');
export const env = { IBKR_ENVIRONMENT: 'paper', AAPL_PROFILE_ENABLED: 'true', INSTRUMENT_BINDINGS_JSON: JSON.stringify([{ instrumentId: 'aapl_nasdaq', conId: 265598, localSymbol: 'AAPL', tradingClass: 'NMS', exchange: 'SMART', currency: 'USD', minTick: 0.01 }]) };
export const claim: BoundClaim = { token:'test', identity:{instrumentId:'aapl_nasdaq',conid:'265598',clientOrderHash:'hash',accountId:'DU1',sessionId:'test'},
  order:{id:1,instrumentId:'aapl_nasdaq',instrument:'AAPL',conid:'265598',side:'BUY',orderType:'LMT',quantity:1,entry:100,stop:99,takeProfit:102,confidence:.8,reason:'test',riskCheckStatus:'PASS',status:'PROPOSED',timestamp:new Date(now).toISOString(), indicators:{ema20:100} as BoundClaim['order']['indicators']} };
export const metadata = {symbol:'AAPL',conid:'265598',sec_type:'STK',exchange:'SMART',primary_exchange:'NASDAQ',currency:'USD',local_symbol:'AAPL',trading_class:'NMS',min_tick:.01,source:'ibkr',resolved_at:new Date(now-1000)};
function resolver(row:unknown=metadata, configuration:Record<string,unknown>=env, lookupFailure=false) {
  const pool={query:async()=>{if(lookupFailure)throw new Error('sensitive database details');return{rows:row?[row]:[]};}} as unknown as Pool;
  return createAaplIdentityResolver({pool,env:configuration,now:()=>now});
}
async function run(input:BoundClaim=structuredClone(claim), resolveAaplIdentity?:AaplIdentityResolver, verdict:'EXECUTE'|'REJECT'='EXECUTE') {
  let final:BoundDecision|undefined, modelContext:DecisionContext|undefined,newsCalls=0,modelCalls=0,deliveries=0, available=true;
  const worker=new BoundReviewWorker({resolveAaplIdentity,
    repository:{claim:async()=>{if(!available)return null;available=false;return input;},finalize:async(_c,d)=>{final=d;return d.decision==='EXECUTE';},recordDelivery:async()=>{}},
    execution:{getAccountSummary:async()=>({accountId:'DU1',source:'live',retrievedAt:new Date(now).toISOString(),positions:[],metrics:{},totals:{positionsCount:0,grossExposure:0,netExposure:0,unrealizedPnL:0,realizedPnL:0}}),executeBoundProposed:async()=>{deliveries++;return 'SUBMITTED';}},
    news:{isConfigured:()=>true,getNewsForSymbol:async()=>{newsCalls++;return[];}},
    decider:{isConfigured:()=>true,decide:async context=>{modelCalls++;modelContext=context;return{decision:verdict,confidence:.8,reason:'test',riskFlags:[]};}},model:'fake',promptVersion:'test',newsWindowHours:24,maxNewsItems:3});
  await worker.pollOnce();assert.equal(await worker.pollOnce(),false);
  return{final,modelContext,newsCalls,modelCalls,deliveries};
}
for(const verdict of ['EXECUTE','REJECT'] as const)test(`verified AAPL evidence reaches model and immutable decision: ${verdict}`,async()=>{
  const out=await run(undefined,resolver(),verdict);assert.equal(out.modelCalls,1);assert.equal(out.newsCalls,1);assert.equal(out.deliveries,verdict==='EXECUTE'?1:0);
  assert.deepEqual(out.modelContext?.indicatorSummary,claim.order.indicators);
  const context=out.final!.context as Record<string,unknown>;
  assert.deepEqual(context.instrument,{...claim.identity,...(await resolver()(claim) as {ok:true;evidence:unknown}).evidence as object});
  assert.deepEqual(out.modelContext?.evidence, context);
  assert.equal(context.accountValuationCurrency,'UNVERIFIED');assert.equal((context.coverage as Record<string,string>).financialStatements,'UNAVAILABLE');
});
for(const [field,value] of Object.entries({symbol:'OTHER',conid:'42',sec_type:'CASH',exchange:'NYSE',primary_exchange:'NYSE',currency:'EUR',local_symbol:'OTHER',trading_class:'AAPL',min_tick:0.1,source:'override_fallback',resolved_at:'bad'}))test(`metadata ${field} mismatch blocks all providers and delivery`,async()=>{
  const out=await run(undefined,resolver({...metadata,[field]:value}));assert.equal(out.final?.decision,'REJECT');assert.equal(out.newsCalls+out.modelCalls+out.deliveries,0);
});
for(const row of [null,{...metadata,source:null},{...metadata,source:'unknown'},{...metadata,resolved_at:new Date(now+1)}])test(`missing/untrusted metadata ${JSON.stringify(row?.source??null)} rejects`,async()=>{const out=await run(undefined,resolver(row));assert.equal(out.newsCalls+out.modelCalls+out.deliveries,0);assert.equal(out.final?.decision,'REJECT');});
for(const configuration of [{...env,INSTRUMENT_BINDINGS_JSON:''},{...env,INSTRUMENT_BINDINGS_JSON:'malformed'},{...env,AAPL_PROFILE_ENABLED:'bad'},{...env,AAPL_PROFILE_ENABLED:'false'}])test('missing/malformed/disabled binding fails closed',async()=>{const out=await run(undefined,resolver(metadata,configuration));assert.equal(out.newsCalls+out.modelCalls+out.deliveries,0);assert.equal(out.final?.decision,'REJECT');});
test('missing resolver or lookup error never invokes providers',async()=>{for(const resolve of [undefined,resolver(metadata,env,true)]){const out=await run(undefined,resolve);assert.equal(out.newsCalls+out.modelCalls+out.deliveries,0);assert.equal(out.final?.decision,'REJECT');}});
for(const patch of [{instrumentId:undefined},{instrument:' aapl '},{conid:'0265598'},{instrumentId:'AAPL_NASDAQ'},{instrument:'OTHER'},{conid:'42'}])test(`partial or aliased claim fails closed ${JSON.stringify(patch)}`,async()=>{
 const input=structuredClone(claim);Object.assign(input.order,patch);const out=await run(input,resolver());assert.equal(out.final?.reason,'AAPL_IDENTITY_CLAIM_MISMATCH');assert.equal(out.newsCalls+out.modelCalls+out.deliveries,0);
});
test('proposal snapshot identity must match claim, and snapshot-only marker cannot bypass resolver',async()=>{
 for(const patch of [{instrument_id:'other'},{instrument:'OTHER'},{conid:'42'},{id:2},{client_order_hash:'tampered'}]){
  const input=structuredClone(claim);input.proposalSnapshot={id:1,instrument_id:'aapl_nasdaq',instrument:'AAPL',conid:'265598',client_order_hash:'hash',...patch};
  const out=await run(input,resolver());assert.equal(out.final?.reason,'AAPL_IDENTITY_CLAIM_MISMATCH');assert.equal(out.newsCalls+out.modelCalls+out.deliveries,0);
 }
 const input=structuredClone(claim);input.identity.instrumentId='other';input.identity.conid='42';input.order.instrumentId='other';input.order.instrument='OTHER';input.order.conid='42';input.proposalSnapshot={instrument:' aapl '};
 const out=await run(input,resolver());assert.equal(out.final?.reason,'AAPL_IDENTITY_CLAIM_MISMATCH');assert.equal(out.newsCalls,0);
});

test('missing indicators remain unavailable with verified instrument identity',async()=>{
 const input=structuredClone(claim);delete input.order.indicators;
 const out=await run(input,resolver());assert.equal(out.modelContext?.indicatorSummary,null);
 const context=out.final!.context as Record<string,unknown>;
 assert.equal(context.indicatorAvailability,'UNAVAILABLE');assert.equal((context.coverage as Record<string,string>).technicalIndicators,'UNAVAILABLE');
});
for(const marker of ['symbol','instrumentId','conid'])test(`a sole noncanonical ${marker} AAPL marker cannot use legacy behavior`,async()=>{
 const input=structuredClone(claim);input.identity.instrumentId='other';input.identity.conid='42';input.order.instrumentId='other';input.order.instrument='OTHER';input.order.conid='42';
 if(marker==='symbol')input.order.instrument=' aapl ';
 if(marker==='instrumentId')input.identity.instrumentId=' AAPL_NASDAQ ';
 if(marker==='conid')input.identity.conid='0265598';
 const out=await run(input,resolver());assert.equal(out.final?.reason,'AAPL_IDENTITY_CLAIM_MISMATCH');assert.equal(out.newsCalls+out.modelCalls+out.deliveries,0);
});
