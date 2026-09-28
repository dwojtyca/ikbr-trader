import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { ConfiguredStrategyStateRepository } from "./configured-strategy-state.js";
const url=process.env.TEST_POSTGRES_URL;
async function fixture(run:(pool:Pool,source:string)=>Promise<void>){
 const admin=new Pool({connectionString:url}),schema=`pp2_state_${randomUUID().replaceAll("-","")}`;
 await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
 try{
 await pool.query(`CREATE TABLE proposed_orders(id BIGSERIAL PRIMARY KEY,execution_attempted_at TIMESTAMPTZ,execution_account_id TEXT,conid TEXT,strategy TEXT,strategy_attribution JSONB,client_order_hash TEXT);
 CREATE TABLE broker_execution_fills(exec_id TEXT PRIMARY KEY,proposed_order_id BIGINT,account_id TEXT,conid TEXT,broker_order_id TEXT,side TEXT,shares FLOAT8,price FLOAT8,executed_at TIMESTAMPTZ,commission FLOAT8,commission_currency TEXT,currency TEXT,sec_type TEXT,sec_type_conflict BOOLEAN NOT NULL DEFAULT FALSE);
 CREATE TABLE broker_order_links(proposed_order_id BIGINT,account_id TEXT,role TEXT,broker_order_id TEXT,order_ref TEXT);
 CREATE TABLE lifecycle_close_operations(original_proposal_id BIGINT,state TEXT,account_id TEXT,conid TEXT,original_hash TEXT,close_proposal_id BIGINT);
 CREATE TABLE trading_configuration_management_snapshots(source_hash TEXT,entries_disabled BOOLEAN);
 CREATE TABLE trading_configuration_snapshots(effective_hash TEXT);
 CREATE FUNCTION trading_configuration_immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'immutable'; END$$;`);
 await pool.query(readFileSync(new URL("../../../../../infra/sql/migrations/000018_strategy_binding_state.sql",import.meta.url),"utf8"));
 const source="a".repeat(64);await pool.query("INSERT INTO trading_configuration_snapshots VALUES($1)",[source]);await pool.query("SELECT capture_strategy_binding_inheritance($1)",[source]);await run(pool,source);
 }finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
const input={accountId:"DU_TEST",conId:"123",implementationId:"momentum_breakout_long_v1"};
function repo(pool:Pool,source:string,read:(id:number)=>Promise<unknown>=async()=>{throw Error("not expected");}){return new ConfiguredStrategyStateRepository({pool,getInheritanceSourceHash:async()=>source,outcomeReader:{read},cooldownMs:60_000});}
async function outcome(pool:Pool,net:number,time="2026-09-28T12:00:00Z"){
 const p=(await pool.query(`INSERT INTO proposed_orders(execution_attempted_at,execution_account_id,conid,strategy,strategy_attribution,client_order_hash) VALUES(now(),'DU_TEST','123','momentum_breakout_long_v1','{"version":1}','hash') RETURNING id`)).rows[0];const id=Number(p.id);
 await pool.query(`INSERT INTO broker_order_links VALUES($1,'DU_TEST','PARENT',$2,$3),($1,'DU_TEST','TP',$4,$5)`,[id,`b${id}`,`ref${id}`,`s${id}`,`exit${id}`]);
 await pool.query(`INSERT INTO broker_execution_fills VALUES($1,$2,'DU_TEST','123',$3,'BUY',1,100,$4,0,'PLN','PLN','STK',false),($5,$2,'DU_TEST','123',$6,'SELL',1,$7,$4,0,'PLN','PLN','STK',false)`,[`b${id}`,id,`b${id}`,time,`s${id}`,`s${id}`,100+net]);
 const economicEvidence={fills:[{execId:`b${id}`,accountId:"DU_TEST",conid:"123",proposedOrderId:id,brokerOrderId:`b${id}`,side:"BUY",quantity:1,price:100,executedAt:new Date(time).toISOString(),commission:0,commissionCurrency:"PLN",currency:"PLN",secType:"STK",secTypeConflict:false},{execId:`s${id}`,accountId:"DU_TEST",conid:"123",proposedOrderId:id,brokerOrderId:`s${id}`,side:"SELL",quantity:1,price:100+net,executedAt:new Date(time).toISOString(),commission:0,commissionCurrency:"PLN",currency:"PLN",secType:"STK",secTypeConflict:false}],links:[{proposedOrderId:id,accountId:"DU_TEST",role:"PARENT",brokerOrderId:`b${id}`,orderRef:`ref${id}`},{proposedOrderId:id,accountId:"DU_TEST",role:"TP",brokerOrderId:`s${id}`,orderRef:`exit${id}`}],close:null};
 return {proposalId:id,accountId:"DU_TEST",conid:"123",status:"COMPLETED",accounting:"COMPLETE",clientOrderHash:"hash",strategyAttribution:{version:1},missingCommissionExecIds:[],grossPnl:{amount:net,currency:"PLN"},netPnlPLN:net,economicEvidence};
}
test("state initializes only from immutable capture, stays contract scoped and survives restart",{skip:!url},()=>fixture(async(pool,source)=>{
 const r=repo(pool,source);assert.equal((await r.sync(input)).enabled,true);await r.sync({...input,conId:"456"});assert.equal((await pool.query("SELECT count(*) n FROM strategy_binding_state")).rows[0].n,"2");
 await assert.rejects(pool.query("UPDATE strategy_binding_legacy_inheritance SET cooldown_count=99"),/immutable/);
 assert.equal((await repo(pool,source).sync(input)).enabled,true);
}));
test("concurrent same-timestamp outcomes counted exactly once, third loss cooldown and next streak permanent",{skip:!url},()=>fixture(async(pool,source)=>{
 const reports=new Map<number,unknown>();for(let i=0;i<3;i++){const o=await outcome(pool,-1);reports.set(o.proposalId,o);}const read=async(id:number)=>reports.get(id);
 await Promise.all([repo(pool,source,read).sync(input),repo(pool,source,read).sync(input)]);
 let state=(await pool.query("SELECT * FROM strategy_binding_state")).rows[0];assert.equal(state.cooldown_count,1);assert.equal(state.consecutive_loss_count,0);assert.equal((await pool.query("SELECT count(*) n FROM strategy_binding_outcomes")).rows[0].n,"3");
 for(let i=0;i<3;i++){const o=await outcome(pool,-1,"2026-09-28T12:01:00Z");reports.set(o.proposalId,o);}assert.equal((await repo(pool,source,read).sync(input)).permanentlyDisabled,true);
 state=(await pool.query("SELECT * FROM strategy_binding_state")).rows[0];assert.equal(state.enabled,false);
}));
test("report/read fee correction interleaving cannot reset a loss counter",{skip:!url},()=>fixture(async(pool,source)=>{
 const report=await outcome(pool,1);const r=repo(pool,source,async()=>{await pool.query("UPDATE broker_execution_fills SET commission=10 WHERE side='SELL'");return report;});
 assert.equal((await r.sync(input)).holdReason,"OUTCOME_EVIDENCE_CHANGED");assert.equal((await pool.query("SELECT count(*) n FROM strategy_binding_outcomes")).rows[0].n,"0");
}));
test("consumed report survives restart without HTTP but late fees permanently hold",{skip:!url},()=>fixture(async(pool,source)=>{
 const report=await outcome(pool,-1);await repo(pool,source,async()=>report).sync(input);assert.equal((await repo(pool,source).sync(input)).enabled,true);
 await pool.query("UPDATE broker_execution_fills SET commission=1 WHERE side='SELL'");assert.equal((await repo(pool,source).sync(input)).holdReason,"OUTCOME_EVIDENCE_CHANGED");
}));
test("pending or missing net fees fail closed without consuming outcome",{skip:!url},()=>fixture(async(pool,source)=>{
 const report=await outcome(pool,1);await assert.rejects(repo(pool,source,async()=>({...report,accounting:"PENDING_FEES"})).sync(input),/COMPLETION_UNAVAILABLE/);
 assert.equal((await pool.query("SELECT count(*) n FROM strategy_binding_outcomes")).rows[0].n,"0");
}));
test("legacy counts inherit once and a winning outcome resets streak without reimport",{skip:!url},()=>fixture(async(pool)=>{
 await pool.query(`CREATE TABLE strategy_runtime_state(strategy_id TEXT PRIMARY KEY,enabled BOOLEAN,permanently_disabled BOOLEAN,cooldown_until TIMESTAMPTZ,consecutive_loss_count INT,cooldown_count INT,last_evaluated_fill_at TIMESTAMPTZ);
 INSERT INTO strategy_runtime_state VALUES('momentum_breakout_long_v1',true,false,null,2,0,null)`);
 const source="b".repeat(64);await pool.query("INSERT INTO trading_configuration_management_snapshots VALUES($1,true)",[source]);await pool.query("SELECT capture_strategy_binding_inheritance($1)",[source]);
 const report=await outcome(pool,1);await repo(pool,source,async()=>report).sync(input);await repo(pool,source).sync(input);
 assert.equal((await pool.query("SELECT consecutive_loss_count FROM strategy_binding_state")).rows[0].consecutive_loss_count,0);
 await pool.query("UPDATE strategy_runtime_state SET enabled=false");await pool.query("SELECT capture_strategy_binding_inheritance($1)",[source]);
 assert.equal((await pool.query("SELECT enabled FROM strategy_binding_legacy_inheritance WHERE source_hash=$1",[source])).rows[0].enabled,true);
}));
test("late earlier outcome holds rather than rewriting streak order",{skip:!url},()=>fixture(async(pool,source)=>{
 const later=await outcome(pool,-1,"2026-09-28T12:02:00Z");await repo(pool,source,async()=>later).sync(input);
 const earlier=await outcome(pool,1,"2026-09-28T12:01:00Z");assert.equal((await repo(pool,source,async()=>earlier).sync(input)).holdReason,"OUTCOME_ORDER_CONFLICT");
 assert.equal((await pool.query("SELECT consecutive_loss_count FROM strategy_binding_state")).rows[0].consecutive_loss_count,1);
}));
test("capture refuses missing legacy state on a database with historical evidence",{skip:!url},()=>fixture(async(pool)=>{
 await outcome(pool,1);await pool.query("INSERT INTO trading_configuration_management_snapshots VALUES($1,true)",["b".repeat(64)]);await assert.rejects(pool.query("SELECT capture_strategy_binding_inheritance($1)",["b".repeat(64)]),/LEGACY_STATE_UNAVAILABLE/);
}));

test("late identity conflict flag holds consumed outcome even when original account fields remain unchanged",{skip:!url},()=>fixture(async(pool,source)=>{
 const report=await outcome(pool,1);await repo(pool,source,async()=>report).sync(input);
 await pool.query("UPDATE broker_execution_fills SET sec_type_conflict=true WHERE side='SELL'");
 assert.equal((await repo(pool,source).sync(input)).holdReason,"OUTCOME_EVIDENCE_CHANGED");
}));
test("inheritance capture refuses unknown source hash on a fresh database",{skip:!url},()=>fixture(async(pool)=>{
 await assert.rejects(pool.query("SELECT capture_strategy_binding_inheritance($1)",["f".repeat(64)]),/LEGACY_STATE_SOURCE_UNPROVEN/);
}));
test("legacy infinite timestamps reject capture atomically and state dates fail closed",{skip:!url},()=>fixture(async(pool,initialSource)=>{
 await pool.query(`CREATE TABLE strategy_runtime_state(strategy_id TEXT PRIMARY KEY,enabled BOOLEAN,permanently_disabled BOOLEAN,cooldown_until TIMESTAMPTZ,consecutive_loss_count INT,cooldown_count INT,last_evaluated_fill_at TIMESTAMPTZ);
 INSERT INTO strategy_runtime_state VALUES('momentum_breakout_long_v1',true,false,'infinity',2,0,null)`);
 const source="c".repeat(64);await pool.query("INSERT INTO trading_configuration_management_snapshots VALUES($1,true)",[source]);
 await assert.rejects(pool.query("SELECT capture_strategy_binding_inheritance($1)",[source]),/LEGACY_STATE_TIME_INVALID/);
 assert.equal((await pool.query("SELECT count(*) n FROM strategy_binding_legacy_inheritance WHERE source_hash=$1",[source])).rows[0].n,"0");
 await pool.query("UPDATE strategy_runtime_state SET cooldown_until=null,last_evaluated_fill_at='-infinity'");
 await assert.rejects(pool.query("SELECT capture_strategy_binding_inheritance($1)",[source]),/LEGACY_STATE_TIME_INVALID/);
 assert.equal((await pool.query("SELECT count(*) n FROM strategy_binding_legacy_inheritance WHERE source_hash=$1",[source])).rows[0].n,"0");
 await repo(pool,initialSource).sync(input);
 await assert.rejects(pool.query("UPDATE strategy_binding_state SET cooldown_until='infinity'"),/check constraint/);
 await assert.rejects(pool.query("UPDATE strategy_binding_state SET last_exit_at='-infinity'"),/check constraint/);
 await pool.query("UPDATE strategy_binding_state SET cooldown_until='290000-01-01 00:00:00+00'");
 await assert.rejects(repo(pool,initialSource).sync(input),/PP2_STATE_TIME_INVALID/);
}));
test("actual full-close round-trip DTO agrees with raw PARENT close linkage in state ledger",{skip:!url},()=>fixture(async(pool,source)=>{
 const {roundTrip}=await import(new URL("../../../../execution-engine/src/lifecycle/round-trip-test-fixture.ts",import.meta.url).href);
 const {evaluateRoundTrip}=await import(new URL("../../../../execution-engine/src/lifecycle/round-trip-evidence.ts",import.meta.url).href);
 const f=roundTrip();const link={...f.links[0],proposed_order_id:43,broker_order_id:"104",order_ref:"close",perm_id:"1004"};
 f.evidence.close={state:"COMPLETED",accountId:"DU_TEST",conid:"123",originalHash:f.review.client_order_hash,closeProposalId:43,links:[link]};
 Object.assign(f.snapshot.executions[1],{brokerOrderId:"104",orderRef:"close",permId:"1004"});Object.assign(f.evidence.fills[1],{broker_order_id:"104",proposed_order_id:43});
 const report=evaluateRoundTrip(f.evidence,f.context);assert.equal(report.status,"COMPLETED");assert.equal(report.accounting,"COMPLETE");
 assert.equal(report.economicEvidence.links.find((x:{proposedOrderId:number})=>x.proposedOrderId===43).role,"PARENT");
 await pool.query(`INSERT INTO proposed_orders(id,execution_attempted_at,execution_account_id,conid,strategy,strategy_attribution,client_order_hash)
  VALUES(42,now(),'DU_TEST','123','momentum_breakout_long_v1','{"version":1}',$1),(43,null,'DU_TEST','123',null,null,null)`,[report.clientOrderHash]);
 for(const l of report.economicEvidence.links)await pool.query("INSERT INTO broker_order_links VALUES($1,$2,$3,$4,$5)",[l.proposedOrderId,l.accountId,l.role,l.brokerOrderId,l.orderRef]);
 for(const r of report.economicEvidence.fills)await pool.query("INSERT INTO broker_execution_fills VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",[r.execId,r.proposedOrderId,r.accountId,r.conid,r.brokerOrderId,r.side,r.quantity,r.price,r.executedAt,r.commission,r.commissionCurrency,r.currency,r.secType,r.secTypeConflict]);
 await pool.query("INSERT INTO lifecycle_close_operations VALUES(42,'COMPLETED','DU_TEST','123',$1,43)",[report.clientOrderHash]);
 const state=await repo(pool,source,async()=>({...report,strategyAttribution:{version:1}})).sync(input);assert.equal(state.holdReason,undefined);
 assert.equal((await pool.query("SELECT count(*) n FROM strategy_binding_outcomes")).rows[0].n,"1");
}));
