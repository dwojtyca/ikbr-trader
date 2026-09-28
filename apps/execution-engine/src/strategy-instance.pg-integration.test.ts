import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import type { SignalTicket } from "@ikbr/shared";
import { strategyTriggerId } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { buildStrategyAttribution, computeTradingConfigurationHash, loadTradingConfiguration, parseTradingConfiguration, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { ExecutionRepository,validatePersistedOrderIdentity } from "./repository.js";
import { focusedSubmissionTestSessionGuard } from "./session-entry-guard.fixture.js";
import { runMigrations } from "./migrations.js";
import type { AiEntryRiskEvidence } from "./ai-entry-risk.js";
import { deriveChildOrderRef, deriveParentOrderRef } from "./reconciliation/order-ref.js";
const url=process.env.TEST_POSTGRES_URL;
const accountId="DU_PP2_TEST",sessionId="pp2_session";
const raw=()=>JSON.parse(readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json",import.meta.url),"utf8"));
async function fixture(run:(f:Awaited<ReturnType<typeof prepare>>)=>Promise<void>){
 const name=`pp2_identity_${randomUUID().replaceAll("-","")}`,target=new URL(url!);target.pathname="/postgres";
 const admin=new Pool({connectionString:target.toString()});await admin.query(`CREATE DATABASE ${name}`);target.pathname=`/${name}`;
 const pool=new Pool({connectionString:target.toString()});
 try{await runMigrations(pool);await run(await prepare(pool));}finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
async function install(pool:Pool,input=raw()){
 const parsed=parseTradingConfiguration(input);assert.ok(parsed.ok);if(!parsed.ok)throw Error("fixture");
 const loaded=loadTradingConfiguration({TRADING_CONFIG_MODE:"bundle",TRADING_CONFIG_PATH:"/test.json",TRADING_CONFIG_EXPECTED_HASH:computeTradingConfigurationHash(parsed.configuration)},{readFile:()=>JSON.stringify(input)});
 await new TradingConfigurationStore(pool).register({service:"execution-engine",processId:randomUUID(),loaded,tradingEnabled:false});
 return parsed.configuration;
}
async function prepare(pool:Pool){
 const configuration=await install(pool);let currentHash=computeTradingConfigurationHash(configuration);
 const repo=new ExecutionRepository(pool,undefined,undefined,focusedSubmissionTestSessionGuard,()=>currentHash);
 const at=(await pool.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
 const bucket=Math.floor(at.getTime()/60_000)*60_000;
 await pool.query("INSERT INTO strategy_runtime_conversion(singleton,source_hash,v2_not_before_bucket_ms) VALUES(true,$1,$2)",[computeTradingConfigurationHash(configuration),bucket]);
 await pool.query("INSERT INTO broker_snapshot_syncs(account_id,session_id,generation,observed_at,complete) VALUES($1,$2,1,clock_timestamp(),true)",[accountId,sessionId]);
 const ticket=(config=configuration,instrumentId="xyz_nyse"):SignalTicket=>{
  const instrument=config.instruments.find(row=>row.id===instrumentId)!;
  return {instrument:instrument.contract.symbol,instrumentId,conid:String(instrument.contract.conId),side:"BUY",positionEffect:"OPEN_OR_ADD",orderType:"LMT",quantity:1,entry:100,stop:99,takeProfit:105,reason:"PP2 fixture",confidence:.8,timestamp:at.toISOString(),riskCheckStatus:"PASS",
   strategyAttribution:buildStrategyAttribution(config,instrumentId,instrument.strategySelection.instanceIds[0]),strategyTrigger:{version:1,source:"evaluation_bucket",timeframe:"1m",observedAt:at.toISOString(),bucketStartMs:bucket}};
 };
 const insert=(t=ticket(),preflight=true,trustedObservedAt=at.toISOString())=>repo.insertProposedFromTicket(t,t.strategyAttribution!.implementationId,{clientOrderId:`loop:v4:${t.instrumentId}:${t.strategyAttribution!.implementationId}:${strategyTriggerId(t.strategyTrigger!)}`,clientOrderHash:computeClientOrderHash(t)},
  {kind:"available",accountId,sessionId,maxSnapshotAgeMs:60_000},preflight?{strategyPreflight:{effectiveConfigHash:t.strategyAttribution!.effectiveConfigHash,observedAt:trustedObservedAt}}:{});
 return {pool,repo,configuration,ticket,insert,at,setCurrentHash:(hash:string)=>{currentHash=hash;}};
}
test("full migrations actual v2 insert/read and immutable proposal/review identity",{skip:!url},()=>fixture(async f=>{
 const t=f.ticket(),inserted=await f.insert(t);assert.equal(inserted.kind,"inserted",JSON.stringify(inserted));if(inserted.kind!=="inserted")return;
 const order=await f.repo.getProposedOrderById(inserted.id);assert.ok(order);assert.deepEqual(order.strategyAttribution,t.strategyAttribution);assert.deepEqual(order.strategyTrigger,t.strategyTrigger);assert.equal(order.clientOrderHashVersion,2);
 assert.equal(validatePersistedOrderIdentity(order,computeClientOrderHash(t)).ok,true);
 assert.equal(validatePersistedOrderIdentity({...order,strategyAttribution:undefined},computeClientOrderHash(t)).ok,false);
 await assert.rejects(f.pool.query("UPDATE proposed_orders SET strategy_attribution=jsonb_set(strategy_attribution,'{instanceRevision}','99') WHERE id=$1",[inserted.id]),/immutable/);
 await assert.rejects(f.pool.query("UPDATE proposed_orders SET strategy_trigger=jsonb_set(strategy_trigger,'{bucketStartMs}','0') WHERE id=$1",[inserted.id]),/immutable/);
 await assert.rejects(f.pool.query("UPDATE proposal_ai_reviews SET strategy_attribution='{}' WHERE proposed_order_id=$1",[inserted.id]),/immutable/);
 assert.equal((await f.pool.query("SELECT count(*) n FROM strategy_trigger_fences")).rows[0].n,"1");
}));
test("v2 actual insert refuses missing preflight and swapped instrument assignment",{skip:!url},()=>fixture(async f=>{
 assert.equal((await f.insert(f.ticket(),false)).kind,"invalid_ticket_shape");
 const t=f.ticket();t.strategyAttribution={...t.strategyAttribution!,instrumentId:"aapl_smart"};assert.throws(()=>f.insert(t),/STRATEGY_INSTRUMENT_MISMATCH/);
 const other=f.ticket();other.strategyAttribution={...other.strategyAttribution!,instanceId:"momentum_default"};assert.equal((await f.insert(other)).kind,"invalid_ticket_shape");
 assert.equal((await f.pool.query("SELECT count(*) n FROM proposed_orders")).rows[0].n,"0");
}));
test("expired trigger cannot rearm through revision and logical-instance rename under concurrency",{skip:!url},()=>fixture(async f=>{
 const first=await f.insert();assert.equal(first.kind,"inserted",JSON.stringify(first));if(first.kind!=="inserted")return;
 await f.pool.query("UPDATE proposed_orders SET status='EXPIRED' WHERE id=$1",[first.id]);await f.pool.query("UPDATE proposal_ai_reviews SET status='EXPIRED' WHERE proposed_order_id=$1",[first.id]);
 const next=raw();const item=next.instruments.find((x:{id:string})=>x.id==="xyz_nyse");const previous=item.strategySelection.instanceIds[0];
 const instance=next.strategyInstances.find((x:{id:string})=>x.id===previous);instance.id="renamed_instance";instance.revision++;
 for(const instrument of next.instruments)instrument.strategySelection.instanceIds=instrument.strategySelection.instanceIds.map((id:string)=>id===previous?instance.id:id);
 item.id="renamed_contract";
 const config=await install(f.pool,next),ticket=f.ticket(config,"renamed_contract");f.setCurrentHash(computeTradingConfigurationHash(config));
 const results=await Promise.all([f.insert(ticket),f.insert(ticket)]);
 for(const result of results){assert.equal(result.kind,"active_intent_exists",JSON.stringify(result));if(result.kind==="active_intent_exists")assert.equal(result.existingOrderId,first.id);}
 assert.equal((await f.pool.query("SELECT count(*) n FROM proposed_orders")).rows[0].n,"1");assert.equal((await f.pool.query("SELECT count(*) n FROM strategy_trigger_fences")).rows[0].n,"1");
}));
test("actual AI claim binds stored v2 identity and finalization rejects a changed instance",{skip:!url},()=>fixture(async f=>{
 const inserted=await f.insert();assert.equal(inserted.kind,"inserted",JSON.stringify(inserted));if(inserted.kind!=="inserted")return;
 const {BoundReviewRepository}=await import(new URL("../../llm-agent/src/bound-review-repository.ts",import.meta.url).href);
 const foreign=new BoundReviewRepository(f.pool,{effectiveConfigHash:"f".repeat(64)});await assert.rejects(foreign.claim(),/AI_STRATEGY_IDENTITY_MISMATCH/);
 const repo=new BoundReviewRepository(f.pool,{effectiveConfigHash:computeTradingConfigurationHash(f.configuration)});
 const claim=await repo.claim();assert.ok(claim);assert.equal(claim.identity.clientOrderHashVersion,2);assert.equal(claim.order.id,inserted.id);
 const decision={decision:"EXECUTE",reason:"fixture evidence",confidence:.8,model:"fixture",promptVersion:"fixture_v1",context:{}};
 const changed={...claim,identity:{...claim.identity,strategyAttribution:{...claim.identity.strategyAttribution,instanceRevision:999}}};assert.equal(await repo.finalize(changed,decision),false);
 assert.equal(await repo.finalize(claim,decision),true);
 const stored=(await f.pool.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1",[inserted.id])).rows[0];assert.equal(stored.status,"APPROVED");assert.deepEqual(stored.strategy_attribution,f.ticket().strategyAttribution);
}));

test("current loaded configuration rejects a historical but valid attributed proposal",{skip:!url},()=>fixture(async f=>{
 f.setCurrentHash("f".repeat(64));const result=await f.insert();assert.equal(result.kind,"invalid_ticket_shape");
 assert.equal((await f.pool.query("SELECT count(*) n FROM proposed_orders")).rows[0].n,"0");
}));

async function submissionFixture(f:Awaited<ReturnType<typeof prepare>>){
 const inserted=await f.insert();assert.equal(inserted.kind,"inserted",JSON.stringify(inserted));if(inserted.kind!=="inserted")throw Error("fixture insert failed");
 const order=await f.repo.getProposedOrderById(inserted.id);assert.ok(order);
 const {BoundReviewRepository}=await import(new URL("../../llm-agent/src/bound-review-repository.ts",import.meta.url).href);
 const reviews=new BoundReviewRepository(f.pool,{effectiveConfigHash:computeTradingConfigurationHash(f.configuration)});
 const claim=await reviews.claim();assert.ok(claim);
 assert.equal(await reviews.finalize(claim,{decision:"EXECUTE",reason:"fixture evidence",confidence:.8,model:"fixture",promptVersion:"fixture_v1",context:{}}),true);
 const now=Date.now(),stamp=f.at.toISOString();
 const risk:AiEntryRiskEvidence={accountId,sessionId,instrumentId:order.instrumentId!,conid:order.conid!,assessedAtMs:now,validUntilMs:now+60_000,
  accountRequestStartedAt:stamp,accountCompletedAt:stamp,bidObservedAt:stamp,askObservedAt:stamp,bid:99.99,ask:100,
  netLiquidation:10000,availableFunds:5000,grossPositionValue:0,notional:100,stopRisk:1,quoteCurrency:"USD",valuationCurrency:"USD",
  quoteNotional:100,quoteStopRisk:1,fxToUsd:1,fxValuationBuffer:1,fxSource:"same_currency",limits:{maxNotionalPct:10,maxStopRiskPct:.5,maxExposurePct:25},
  strategyAttribution:order.strategyAttribution,strategyTrigger:order.strategyTrigger,strategyObservedAt:stamp,strategyEffectiveConfigHash:computeTradingConfigurationHash(f.configuration)};
 const clientOrderId=`loop:v4:${order.instrumentId}:${order.strategy}:${strategyTriggerId(order.strategyTrigger!)}`;
 const reserve=(evidence:AiEntryRiskEvidence)=>f.repo.tryStartSubmissionWithPlan({id:inserted.id,owner:sessionId,accountId,instrument:order.instrument,conid:order.conid!,allowCrossContractExposure:false,
  positionGuard:{kind:"available",accountId,sessionId,maxSnapshotAgeMs:60_000},aiRiskEvidence:evidence,
  prepared:{clientOrderId,clientOrderHash:computeClientOrderHash(order),instrument:order.instrument,instrumentId:order.instrumentId,conid:order.conid!,
   legs:[{role:"PARENT",roleOrdinal:0,brokerOrderId:"1000",orderRef:deriveParentOrderRef(clientOrderId)},
    {role:"TP",roleOrdinal:1,brokerOrderId:"1001",orderRef:deriveChildOrderRef(clientOrderId,{role:"TP",ordinal:1})},
    {role:"SL",roleOrdinal:1,brokerOrderId:"1002",orderRef:deriveChildOrderRef(clientOrderId,{role:"SL",ordinal:1})}]}});
 return {id:inserted.id,order,risk,reserve};
}

test("v2 reservation rejects stale or mismatched risk without marker or links, then reserves valid approval once",{skip:!url},()=>fixture(async f=>{
 const s=await submissionFixture(f);let sends=0;
 const invalid:AiEntryRiskEvidence[]=[
  {...s.risk,validUntilMs:Date.now()-1},
  {...s.risk,validUntilMs:undefined as unknown as number},
  {...s.risk,strategyEffectiveConfigHash:"f".repeat(64)},
  {...s.risk,strategyObservedAt:undefined},
  {...s.risk,strategyTrigger:{...s.risk.strategyTrigger!,bucketStartMs:s.risk.strategyTrigger!.bucketStartMs-60_000}},
  {...s.risk,strategyAttribution:{...s.risk.strategyAttribution!,instanceRevision:999}},
 ];
 for(const risk of invalid){
  const result=await s.reserve(risk);
  if(result.kind==="claimed_with_persisted_plan")sends++;
  assert.equal(result.kind,"submission_identity_mismatch",JSON.stringify(result));
  const row=(await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1",[s.id])).rows[0];assert.equal(row.execution_attempted_at,null);
  assert.equal((await f.pool.query("SELECT count(*) n FROM broker_order_links WHERE proposed_order_id=$1",[s.id])).rows[0].n,"0");
 }
 f.setCurrentHash("f".repeat(64));assert.equal((await s.reserve(s.risk)).kind,"submission_identity_mismatch");
 assert.equal((await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1",[s.id])).rows[0].execution_attempted_at,null);
 assert.equal(sends,0);
 f.setCurrentHash(s.risk.strategyEffectiveConfigHash!);
 const success=await s.reserve(s.risk);assert.equal(success.kind,"claimed_with_persisted_plan",JSON.stringify(success));
 assert.ok((await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1",[s.id])).rows[0].execution_attempted_at);
 assert.equal((await f.pool.query("SELECT count(*) n FROM broker_order_links WHERE proposed_order_id=$1",[s.id])).rows[0].n,"3");
 assert.equal((await s.reserve(s.risk)).kind,"not_claimed");
}));

test("v2 dispatch rechecks persisted risk expiry, trigger and current configuration before its callback",{skip:!url},()=>fixture(async f=>{
 const s=await submissionFixture(f);assert.equal((await s.reserve(s.risk)).kind,"claimed_with_persisted_plan");
 const before=(await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1",[s.id])).rows[0].execution_attempted_at;
 let sends=0;const dispatch=()=>f.repo.withEntryDispatchPermit(s.order,accountId,()=>{sends++;});
 const persist=(risk:unknown)=>f.pool.query("UPDATE proposal_ai_reviews SET risk_evidence=$2 WHERE proposed_order_id=$1",[s.id,JSON.stringify(risk)]);
 for(const risk of [
  {...s.risk,validUntilMs:Date.now()-1},
  {...s.risk,validUntilMs:undefined},
  {...s.risk,strategyEffectiveConfigHash:"f".repeat(64)},
  {...s.risk,strategyObservedAt:undefined},
  {...s.risk,strategyTrigger:{...s.risk.strategyTrigger!,bucketStartMs:s.risk.strategyTrigger!.bucketStartMs-60_000}},
  {...s.risk,strategyAttribution:{...s.risk.strategyAttribution!,instanceRevision:999}},
 ]){await persist(risk);await assert.rejects(dispatch,/STRATEGY_/);assert.equal(sends,0);}
 await persist(s.risk);f.setCurrentHash("f".repeat(64));await assert.rejects(dispatch,/STRATEGY_/);assert.equal(sends,0);
 f.setCurrentHash(s.risk.strategyEffectiveConfigHash!);
 const originalReview=(await f.pool.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1",[s.id])).rows[0];
 // Fixture-only replacement models corrupt/restored evidence; normal UPDATE is immutable.
 const replaceReview=async(overrides:Record<string,unknown>)=>{
  await f.pool.query("DELETE FROM proposal_ai_reviews WHERE proposed_order_id=$1",[s.id]);
  await f.pool.query("INSERT INTO proposal_ai_reviews SELECT * FROM jsonb_populate_record(NULL::proposal_ai_reviews,$1::jsonb)",[JSON.stringify({...originalReview,...overrides})]);
 };
 for(const [overrides,reason] of [
  [{expires_at:new Date(Date.now()-1).toISOString()},/ai_review_expired/],
  [{session_id:"foreign_session"},/ai_review_identity_mismatch/],
  [{status:"REJECTED"},/ai_review_rejected/],
 ] as const){await replaceReview(overrides);await assert.rejects(dispatch,reason);assert.equal(sends,0);}
 await replaceReview({});
 await assert.rejects(f.repo.withEntryDispatchPermit(s.order,accountId,()=>{sends++;},async()=>{f.setCurrentHash("f".repeat(64));}),/STRATEGY_/);assert.equal(sends,0);
 assert.deepEqual((await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1",[s.id])).rows[0].execution_attempted_at,before);
 f.setCurrentHash(s.risk.strategyEffectiveConfigHash!);await dispatch();assert.equal(sends,1);
}));

test("conversion cutoff rejects previous-bucket trigger and admits exact cutoff bucket",{skip:!url},()=>fixture(async f=>{
 const ticket=f.ticket();const cutoff=ticket.strategyTrigger!.bucketStartMs;
 const previousObservedAt=new Date(f.at.getTime()-60_000).toISOString();
 ticket.strategyTrigger={...ticket.strategyTrigger!,observedAt:previousObservedAt,bucketStartMs:cutoff-60_000};
 assert.equal((await f.insert(ticket,true,previousObservedAt)).kind,"invalid_ticket_shape");
 assert.equal((await f.pool.query("SELECT count(*) n FROM proposed_orders")).rows[0].n,"0");
 assert.equal((await f.pool.query("SELECT count(*) n FROM strategy_trigger_fences")).rows[0].n,"0");
 const current=f.ticket();assert.equal(current.strategyTrigger!.bucketStartMs,cutoff);
 assert.equal((await f.insert(current)).kind,"inserted");
}));
