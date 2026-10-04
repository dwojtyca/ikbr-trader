import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { ResearchStore, researchHash } from "@ikbr/shared/instrument-research";
import { loadTradingConfiguration, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { ResearchBoundReviewRepository } from "./research-review-repository.js";
import { BoundReviewWorker } from "./bound-review-worker.js";
import { buildResearchModelRequest } from "./research-decision.js";
import { reviewFixture } from "./research-review.testfixture.js";
import type { BoundDecision } from "./bound-review-repository.js";
const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const name = `pp4_ai_${randomUUID().replaceAll("-", "")}`, url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE DATABASE ${name}`); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    const dir = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) await pool.query(readFileSync(new URL(file, dir), "utf8"));
    await run(await seed(pool));
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function seed(pool: Pool) {
  const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
  const f = reviewFixture(now), loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json", TRADING_CONFIG_EXPECTED_HASH: f.configHash },
    { readFile: () => readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8") });
  await new TradingConfigurationStore(pool).register({ service: "execution-engine", processId: randomUUID(), loaded, tradingEnabled: false });
  const store = new ResearchStore(pool);
  await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const) await store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: service, tradingEnabled: false });
  await store.storeSnapshot(f.snapshot);
  const c=f.claim;
  await pool.query(`INSERT INTO proposed_orders(id,instrument,instrument_id,conid,side,position_effect,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,
    client_order_id,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger) VALUES(1,$1,$2,$3,'BUY','OPEN_OR_ADD','LMT',1,100,99,105,'fixture',.8,'PASS','PROPOSED',$4,
    'fixture',$5,2,$6,$7)`,[c.order.instrument,c.identity.instrumentId,c.identity.conid,c.order.strategy,c.identity.clientOrderHash,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger)]);
  await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger)
    VALUES(1,$1,$2,$3,'DU_TEST','session',2,$4,$5)`,[c.identity.clientOrderHash,c.identity.instrumentId,c.identity.conid,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger)]);
  const repo=new ResearchBoundReviewRepository(pool,{manifest:f.manifest,hash:f.manifestHash});
  return {...f,pool,store,repo};
}
async function prepared(f: Awaited<ReturnType<typeof seed>>) {
  const claim=(await f.repo.claim())!;assert.ok(claim);
  const research=await f.repo.prepareResearch(claim);
  const request=buildResearchModelRequest(claim,research,f.context);
  const reservation=await f.repo.reserveModel(claim,request);
  return {claim,research,request,reservation};
}
function output(){return{decision:"EXECUTE" as const,confidence:.8,reason:"fixture sourced context",riskFlags:["fixture"],evidenceRefs:["reports"]};}
async function approve(f:Awaited<ReturnType<typeof seed>>,p:Awaited<ReturnType<typeof prepared>>){
  const completedAt=(await f.pool.query("SELECT clock_timestamp() AS now")).rows[0].now.toISOString();const result={decision:output(),actualModel:"fixture-model",usage:null};
  await f.repo.recordModelOutcome(p.claim,p.reservation,{kind:"COMPLETED",completedAt,result});
  const decision:BoundDecision={...result.decision,model:p.request.model,actualModel:result.actualModel,promptVersion:p.request.promptVersion,outputSchemaVersion:p.request.outputSchemaVersion,
    context:p.request.context,contextHash:p.reservation.requestHash,research:p.research.binding,
    timings:{startedAt:p.reservation.startedAt,completedAt,latencyMs:Date.parse(completedAt)-Date.parse(p.reservation.startedAt),outcome:"COMPLETED"}};
  return {decision,approved:await f.repo.finalize(p.claim,decision)};
}
test("research AI persists exact replay and at-most-once model reservation/approval/delivery",{skip:!connection},()=>isolated(async f=>{
  const p=await prepared(f);await assert.rejects(f.repo.reserveModel(p.claim,p.request),/ALREADY_RESERVED/);
  const out=await approve(f,p);assert.equal(out.approved,true);
  assert.equal(await f.repo.finalize(p.claim,out.decision),false);assert.equal(await f.repo.claim(),null);
  await f.repo.recordDelivery(p.claim,"UNKNOWN");await f.repo.recordDelivery(p.claim,"SUBMITTED");
  const saved=(await f.pool.query("SELECT request_json,request_hash FROM proposal_ai_model_calls WHERE proposed_order_id=1")).rows[0];
  assert.equal(researchHash(saved.request_json),saved.request_hash);assert.deepEqual(saved.request_json,p.request);
  assert.equal((await f.pool.query("SELECT delivery_outcome FROM proposal_ai_reviews WHERE proposed_order_id=1")).rows[0].delivery_outcome,"UNKNOWN");
  await assert.rejects(f.pool.query("UPDATE proposal_ai_model_calls SET request_json='{}'"),/immutable/);
  await assert.rejects(f.pool.query("DELETE FROM proposal_ai_model_outcomes"),/immutable/);
}));
test("claim expiration before reservation allows new lease but stale worker cannot charge or finalize",{skip:!connection},()=>isolated(async f=>{
  const old=(await f.repo.claim())!;const research=await f.repo.prepareResearch(old);const request=buildResearchModelRequest(old,research,f.context);
  await f.pool.query("UPDATE proposal_ai_reviews SET claim_until=clock_timestamp()-interval '1 second' WHERE proposed_order_id=1");
  const current=(await f.repo.claim())!;assert.notEqual(old.token,current.token);
  await assert.rejects(f.repo.reserveModel(old,request),/CLAIM_EXPIRED/);
  const fresh=buildResearchModelRequest(current,await f.repo.prepareResearch(current),f.context);
  await f.repo.reserveModel(current,fresh);assert.equal((await f.pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count,"1");
}));
test("reserved model call consumes permanently after lease expiry and restart; late result remains audit only",{skip:!connection},()=>isolated(async f=>{
  const p=await prepared(f);
  await f.pool.query("UPDATE proposal_ai_reviews SET claim_until=clock_timestamp()-interval '1 second' WHERE proposed_order_id=1");
  assert.equal(await new ResearchBoundReviewRepository(f.pool,{manifest:f.manifest,hash:f.manifestHash}).claim(),null);
  const completedAt=new Date().toISOString();await f.repo.recordModelOutcome(p.claim,p.reservation,{kind:"LATE_RESPONSE",completedAt,result:{decision:output(),actualModel:"fixture",usage:null}});
  assert.equal((await f.pool.query("SELECT status FROM proposal_ai_reviews WHERE proposed_order_id=1")).rows[0].status,"EXPIRED");
  assert.equal((await f.pool.query("SELECT count(*) FROM proposal_ai_model_calls")).rows[0].count,"1");
  assert.equal(await f.repo.finalize(p.claim,{...output(),model:"fixture",promptVersion:"fixture",context:{}}),false);
}));
test("new source failure during model work fences approval without replacement call",{skip:!connection},()=>isolated(async f=>{
  const p=await prepared(f);const negative=structuredClone(f.snapshot);negative.coverage[1].status="ERROR";negative.coverage[1].complete=false;
  await f.store.storeSnapshot(negative);assert.equal((await approve(f,p)).approved,false);
  await assert.rejects(f.repo.prepareResearch(p.claim),/SUPERSEDED/);
  assert.equal((await f.pool.query("SELECT count(*) FROM proposal_ai_model_calls")).rows[0].count,"1");
}));
test("AI REJECT is final with risk flags and never causes a second request",{skip:!connection},()=>isolated(async f=>{
  let calls=0,deliveries=0;
  const worker=new BoundReviewWorker({repository:f.repo,execution:{getAiContext:async()=>f.context,executeBoundProposed:async()=>{deliveries++;return"SUBMITTED";}},
    researchDecider:{isConfigured:()=>true,decide:async()=>{calls++;return{decision:{...output(),decision:"REJECT",riskFlags:["earnings_uncertainty"]},actualModel:"fixture",usage:null};}},model:"fixture",promptVersion:"pp4-research-v1"});
  await worker.pollOnce();assert.equal(await worker.pollOnce(),false);assert.equal(calls,1);assert.equal(deliveries,0);
  const saved=(await f.pool.query("SELECT decision_json FROM proposal_ai_reviews WHERE proposed_order_id=1")).rows[0].decision_json;
  assert.deepEqual(saved.riskFlags,["earnings_uncertainty"]);assert.equal(saved.contextHash,researchHash((await f.pool.query("SELECT request_json FROM proposal_ai_model_calls")).rows[0].request_json));
}));

test("crash after successful model audit expires without corrupting outcome or blocking subsequent polls", {skip: !connection}, () => isolated(async f => {
  const p = await prepared(f);
  const completedAt = (await f.pool.query("SELECT clock_timestamp() AS now")).rows[0].now.toISOString();
  await f.repo.recordModelOutcome(p.claim, p.reservation, {kind: "COMPLETED", completedAt, result: {decision: output(), actualModel: "fixture", usage: null}});
  await f.pool.query("UPDATE proposal_ai_reviews SET claim_until=clock_timestamp()-interval '1 second' WHERE proposed_order_id=1");
  assert.equal(await f.repo.claim(), null);
  assert.equal(await f.repo.claim(), null);
  assert.equal((await f.pool.query("SELECT status FROM proposal_ai_reviews WHERE proposed_order_id=1")).rows[0].status, "EXPIRED");
  assert.equal((await f.pool.query("SELECT outcome FROM research_call_outcomes WHERE call_key=$1", [p.reservation.callKey])).rows[0].outcome, "SUCCEEDED");
  await f.repo.recordModelOutcome(p.claim, p.reservation, {kind: "LATE_RESPONSE", completedAt});
  assert.equal((await f.pool.query("SELECT count(*) FROM proposal_ai_model_late_outcomes")).rows[0].count, "1");
  await assert.rejects(f.pool.query("TRUNCATE proposal_ai_model_calls CASCADE"), /immutable/);
}));

test("model budget lock wait rechecks transient context before charging or send", {skip: !connection}, () => isolated(async f => {
  const claim = (await f.repo.claim())!;
  const research = await f.repo.prepareResearch(claim);
  const context = structuredClone(f.context);
  context.validUntilMs = Date.now() + 200;
  context.risk.evidence.validUntilMs = context.validUntilMs;
  const request = buildResearchModelRequest(claim, research, context);
  const lock = await f.pool.connect();
  await lock.query("BEGIN");
  await lock.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", ["research-budget:DU_TEST:openai"]);
  const pending = assert.rejects(f.repo.reserveModel(claim, request), /CONTEXT|EXPIRED|DEADLINE/);
  await new Promise(resolve => setTimeout(resolve, 250));
  await lock.query("ROLLBACK"); lock.release();
  await pending;
  assert.equal((await f.pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "0");
}));
