import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { ProposedOrder } from '@ikbr/shared';
import { computeClientOrderHash } from '@ikbr/shared/client-order-hash';
import { buildStrategyAttribution, canonicalizeTradingConfiguration } from '@ikbr/shared/trading-config';
import { ResearchStore, researchHash, RESEARCH_SYSTEM_PROMPT, RESEARCH_REQUEST_VERSION, researchWireRequest, type ResearchOrderContextV1 } from '@ikbr/shared/instrument-research';
import { researchFixture } from '@ikbr/shared/instrument-research-testfixture';
import { createResearchEntryValidator } from './research-entry-guard.js';
import { runMigrations } from './migrations.js';
const url=process.env.TEST_POSTGRES_URL;

async function fixture(run:(f:Awaited<ReturnType<typeof seed>>)=>Promise<void>, mutateDecision?:(decision:Record<string,unknown>)=>Record<string,unknown>){
 const name=`pp4_execution_${randomUUID().replaceAll('-','')}`,target=new URL(url!);target.pathname='/postgres';
 const admin=new Pool({connectionString:target.toString()});await admin.query(`CREATE DATABASE ${name}`);target.pathname=`/${name}`;
 const pool=new Pool({connectionString:target.toString()});
 try{await runMigrations(pool);await run(await seed(pool,mutateDecision));}finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
async function seed(pool:Pool,mutateDecision?:(decision:Record<string,unknown>)=>Record<string,unknown>){
 const now=Date.now(),r=researchFixture(now),stamp=(delta=0)=>new Date(now+delta).toISOString();
 await pool.query('INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)',[r.configHash,canonicalizeTradingConfiguration(r.config)]);
 const store=new ResearchStore(pool);await store.registerManifest({manifest:r.manifest,configuration:r.config,tradingEnabled:false,adopt:true});
 for(const service of ['execution-engine','llm-agent'] as const)await store.observe({configHash:r.configHash,manifestHash:r.manifestHash,service,processId:service,tradingEnabled:false});
 await store.storeSnapshot(r.snapshot);
 const instrument=r.config.instruments.find(i=>i.id===r.policy.instrumentId)!;
 const order:ProposedOrder={id:1,instrument:instrument.contract.symbol,instrumentId:instrument.id,conid:String(instrument.contract.conId),side:'BUY',orderType:'LMT',quantity:1,entry:100,stop:99,takeProfit:102,
  confidence:.8,reason:'PP4 fixture',timestamp:stamp(-200),riskCheckStatus:'PASS',status:'PROPOSED',strategy:'momentum_breakout_long_v1',clientOrderHashVersion:2,
  strategyAttribution:buildStrategyAttribution(r.config,instrument.id,instrument.strategySelection.instanceIds[0]),
  strategyTrigger:{version:1,source:'evaluation_bucket',timeframe:'1m',observedAt:stamp(-200),bucketStartMs:Math.floor((now-200)/60000)*60000}};
 const hash=computeClientOrderHash(order),accountId='DU_PP4_TEST',sessionId='session';
 await pool.query(`INSERT INTO proposed_orders(id,instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,client_order_id,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger)
  VALUES(1,$1,$2,$3,'BUY','LMT',1,100,99,102,'PP4 fixture',.8,'PASS','PROPOSED',$4,'pp4-fixture',$5,2,$6,$7)`,
  [order.instrument,order.instrumentId,order.conid,order.strategy,hash,JSON.stringify(order.strategyAttribution),JSON.stringify(order.strategyTrigger)]);
 await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger)
  VALUES(1,$1,$2,$3,$4,$5,2,$6,$7)`,[hash,order.instrumentId,order.conid,accountId,sessionId,JSON.stringify(order.strategyAttribution),JSON.stringify(order.strategyTrigger)]);
 const identity={proposalId:1,clientOrderHash:hash,instrumentId:instrument.id,configHash:r.configHash,manifestHash:r.manifestHash};
 const research=await store.bind(identity);
 const context:ResearchOrderContextV1={schemaVersion:1,proposedOrderId:1,clientOrderHash:hash,effectiveConfigHash:r.configHash,accountId,sessionId,instrumentId:instrument.id,conid:order.conid!,
  connectionGeneration:1,requestedAt:stamp(-400),completedAt:stamp(-200),validUntilMs:now+9000,
  reconciliation:{runId:1,positionGeneration:1,requestStartedAt:stamp(-1000),completedAt:stamp(-300),capturedAt:stamp(-350),complete:true,positions:[],openOrders:[]},
  account:{requestStartedAt:stamp(-400),completedAt:stamp(-200),configuredBaseCurrency:'USD',cashByCurrency:{USD:5000},exchangeRatesToBase:{USD:1},usdMetrics:{netLiquidation:10000,availableFunds:5000,grossPositionValue:0}},
  quote:{bid:99,ask:100,bidObservedAt:stamp(-400),askObservedAt:stamp(-200)},valuation:{quoteCurrency:'USD',valuationCurrency:'USD',quoteNotional:100,quoteStopRisk:1,fxToUsd:1,fxSource:'same_currency',fxValuationBuffer:1},
  fees:{currency:'USD',reserve:5,source:'configured_risk_reserve',estimateStatus:'UNAVAILABLE'},
  risk:{ok:true,evidence:{accountId,sessionId,instrumentId:instrument.id,conid:order.conid!,assessedAtMs:now-200,validUntilMs:now+9500}}};
 const request={schemaVersion:RESEARCH_REQUEST_VERSION,model:r.manifest.model.model,promptVersion:r.manifest.model.promptVersion,outputSchemaVersion:r.manifest.model.outputSchemaVersion,
  maxOutputTokens:r.manifest.model.maxOutputTokens,systemPrompt:RESEARCH_SYSTEM_PROMPT,providerRequest:{} as Record<string,unknown>,context:{research,orderContext:context,proposal:order,identity:{clientOrderHash:hash,instrumentId:instrument.id,conid:order.conid,accountId,sessionId,
   strategyAttribution:order.strategyAttribution,strategyTrigger:order.strategyTrigger},indicators:null}};
 request.providerRequest=researchWireRequest(request);
 const requestHash=researchHash(request),modelDecision={decision:'EXECUTE',reason:'fixture verified research',confidence:.8,riskFlags:[],evidenceRefs:research.eligibility.requiredEvidenceRefs};
 const decision={...modelDecision,model:request.model,promptVersion:request.promptVersion,outputSchemaVersion:request.outputSchemaVersion,contextHash:requestHash,research:research.binding,context:request.context,
  timings:{startedAt:stamp(-100),completedAt:stamp(-50),latencyMs:50,outcome:'COMPLETED'}};
 await pool.query(`INSERT INTO proposal_ai_model_calls(proposed_order_id,claim_token,call_key,request_json,request_hash,research_snapshot_id,model,prompt_version,output_schema_version,started_at,deadline_at)
  VALUES(1,$1,'model:proposal:1',$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),JSON.stringify(request),requestHash,research.binding.snapshotId,request.model,request.promptVersion,request.outputSchemaVersion,stamp(-100),stamp(9900)]);
 await pool.query('INSERT INTO proposal_ai_model_outcomes(proposed_order_id,outcome_json) VALUES(1,$1)',[JSON.stringify({kind:'COMPLETED',completedAt:stamp(-50),result:{decision:modelDecision,actualModel:'fixture-model',usage:null}})]);
 await pool.query("UPDATE proposal_ai_reviews SET status='APPROVED',decision_json=$1,decided_at=clock_timestamp(),delivery_started_at=clock_timestamp() WHERE proposed_order_id=1",[JSON.stringify(mutateDecision?mutateDecision(decision):decision)]);
 const validate=createResearchEntryValidator({store,loadedIdentity:()=>({configHash:r.configHash,manifestHash:r.manifestHash})});
 const check=async()=>{const db=await pool.connect();try{await db.query('BEGIN');const result=await validate({db,order,clientOrderHash:hash,accountId,sessionId});await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}};
 return {pool,store,check,validate,order,hash,accountId,sessionId,decision,research,r};
}
test('real research store fences immutable AI approval against changed references, context and newer negative head',{skip:!url},()=>fixture(async f=>{
 const permit=await f.check();assert.ok(permit.validUntilMs>Date.now());permit.assertCurrent();
 await assert.rejects(f.pool.query('UPDATE proposal_ai_reviews SET decision_json=$1 WHERE proposed_order_id=1',[JSON.stringify({...f.decision,evidenceRefs:['invented']})]),/immutable/);
 const negative=structuredClone(f.r.snapshot);negative.coverage[1].status='ERROR';negative.coverage[1].complete=false;
 await f.store.storeSnapshot(negative);await assert.rejects(f.check(),/RESEARCH_SNAPSHOT_SUPERSEDED/);
 assert.equal((await f.pool.query('SELECT execution_attempted_at FROM proposed_orders WHERE id=1')).rows[0].execution_attempted_at,null);
 assert.equal((await f.store.readSnapshot(f.research.binding.snapshotId))!.hash,f.research.binding.snapshotHash);
}));
test('real execution validation independently rejects corrupted review membership',{skip:!url},async()=>{
 for(const mutate of [(d:Record<string,unknown>)=>({...d,evidenceRefs:['invented']}),(d:Record<string,unknown>)=>({...d,contextHash:'f'.repeat(64)}),
  (d:Record<string,unknown>)=>({...d,research:{...(d.research as Record<string,unknown>),snapshotHash:'e'.repeat(64)}})])
  await fixture(async f=>{await assert.rejects(f.check(),/RESEARCH_/);},mutate);
});
test('research head publication waits until the final synchronous send transaction releases its permit',{skip:!url},()=>fixture(async f=>{
 const db=await f.pool.connect();let published=false,sends=0;
 try{
  await db.query('BEGIN');await db.query('SELECT id FROM proposed_orders WHERE id=1 FOR UPDATE');
  const permit=await f.validate({db,order:f.order,clientOrderHash:f.hash,accountId:f.accountId,sessionId:f.sessionId});
  const publication=f.store.storeSnapshot(structuredClone(f.r.snapshot)).then(()=>{published=true;});
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(published,false);
  permit.assertCurrent();assert.ok(Date.now()<permit.validUntilMs);sends++;
  await db.query('COMMIT');await publication;assert.equal(sends,1);assert.equal(published,true);
  await assert.rejects(f.check(),/RESEARCH_SNAPSHOT_SUPERSEDED/);
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}));
