import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createAaplIdentityResolver } from './aapl-identity.js';
import { BoundReviewWorker } from './bound-review-worker.js';
import type { BoundClaim, BoundDecision } from './bound-review-repository.js';
const now = Date.parse('2026-09-24T18:00:00Z');
export const env = { IBKR_ENVIRONMENT: 'paper', AAPL_PROFILE_ENABLED: 'true', INSTRUMENT_BINDINGS_JSON: JSON.stringify([{ instrumentId: 'aapl_nasdaq', conId: 265598, localSymbol: 'AAPL', tradingClass: 'NMS', exchange: 'SMART', currency: 'USD', minTick: 0.01 }]) };
export const claim: BoundClaim = { token:'test', identity:{instrumentId:'aapl_nasdaq',conid:'265598',clientOrderHash:'hash',accountId:'DU1',sessionId:'test'},
  order:{id:1,instrumentId:'aapl_nasdaq',instrument:'AAPL',conid:'265598',side:'BUY',orderType:'LMT',quantity:1,entry:100,stop:99,takeProfit:102,confidence:.8,reason:'test',riskCheckStatus:'PASS',status:'PROPOSED',timestamp:new Date(now).toISOString(), indicators:{ema20:100} as BoundClaim['order']['indicators']} };
export const metadata = {symbol:'AAPL',conid:'265598',sec_type:'STK',exchange:'SMART',primary_exchange:'NASDAQ',currency:'USD',local_symbol:'AAPL',trading_class:'NMS',min_tick:.01,source:'ibkr',resolved_at:new Date(now-1000)};
function resolver(row:unknown=metadata, configuration:Record<string,unknown>=env, lookupFailure=false) {
  const pool={query:async()=>{if(lookupFailure)throw new Error('sensitive database details');return{rows:row?[row]:[]};}} as unknown as Pool;
  return createAaplIdentityResolver({pool,env:configuration,now:()=>now});
}
test('historical AAPL metadata resolver retains exact verified identity',async()=>{
 const result=await resolver()(structuredClone(claim));assert.equal(result.ok,true);
 if(result.ok){assert.equal(result.evidence.currency,'USD');assert.equal(result.evidence.primaryExchange,'NASDAQ');}
});
for(const [field,value] of Object.entries({symbol:'OTHER',conid:'42',sec_type:'CASH',exchange:'NYSE',primary_exchange:'NYSE',currency:'EUR',local_symbol:'OTHER',trading_class:'AAPL',min_tick:0.1,source:'override_fallback',resolved_at:'bad'}))test(`historical resolver rejects metadata ${field}`,async()=>{
 assert.equal((await resolver({...metadata,[field]:value})(structuredClone(claim))).ok,false);
});
for(const row of [null,{...metadata,source:null},{...metadata,source:'unknown'},{...metadata,resolved_at:new Date(now+1)}])test('historical resolver rejects missing/future provenance',async()=>{
 assert.equal((await resolver(row)(structuredClone(claim))).ok,false);
});
for(const configuration of [{...env,INSTRUMENT_BINDINGS_JSON:''},{...env,INSTRUMENT_BINDINGS_JSON:'malformed'},{...env,AAPL_PROFILE_ENABLED:'bad'},{...env,AAPL_PROFILE_ENABLED:'false'}])test('historical binding cannot infer missing configuration',async()=>{
 assert.equal((await resolver(metadata,configuration)(structuredClone(claim))).ok,false);
});
for(const patch of [{instrumentId:undefined},{instrument:' aapl '},{conid:'0265598'},{instrumentId:'AAPL_NASDAQ'},{instrument:'OTHER'},{conid:'42'}])test(`historical resolver refuses aliased claim ${JSON.stringify(patch)}`,async()=>{
 const input=structuredClone(claim);Object.assign(input.order,patch);assert.equal((await resolver()(input)).ok,false);
});
test('legacy verified metadata is insufficient to authorize PP4 provider work',async()=>{
 let saved:BoundDecision|undefined;let calls=0;
 const worker=new BoundReviewWorker({repository:{claim:async()=>structuredClone(claim),finalize:async(_c,d)=>{saved=d;return false;},recordDelivery:async()=>{}},
  execution:{executeBoundProposed:async()=>{calls++;return'UNKNOWN';}},model:'fixture',promptVersion:'pp4-research-v1'});
 await worker.pollOnce();assert.equal(saved?.reason,'RESEARCH_UNAVAILABLE');assert.equal(calls,0);
});
