import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { TradingConfigurationStore, TRADING_CONFIGURATION_SERVICES, computeTradingConfigurationHash, loadTradingConfiguration,
  parseTradingConfiguration, createLegacyManagementSnapshot, buildTradingConfigurationProjection, retainedStateRecovery,
  type RetainedStateRecoveryInput, type RetainedStateInspection, type RetainedStateRecoveryReceipt } from "@ikbr/shared/trading-config";
import { runMigrations } from "./migrations.js";
const url=process.env.TEST_POSTGRES_URL;
async function isolated(run:(pool:Pool,input:RetainedStateRecoveryInput)=>Promise<void>){
  const name=`retained_${randomUUID().replaceAll("-","")}`,target=new URL(url!);target.pathname="/postgres";
  const admin=new Pool({connectionString:target.toString()});await admin.query(`CREATE DATABASE ${name}`);target.pathname=`/${name}`;
  const pool=new Pool({connectionString:target.toString()});
  try {
    await runMigrations(pool);
    const raw=readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json",import.meta.url),"utf8");
    const p=parseTradingConfiguration(raw);if(!p.ok)throw Error("fixture");
    const loaded=loadTradingConfiguration({TRADING_CONFIG_MODE:"bundle",TRADING_CONFIG_PATH:"/fixture",TRADING_CONFIG_EXPECTED_HASH:computeTradingConfigurationHash(p.configuration)},{readFile:()=>raw});
    const legacy=createLegacyManagementSnapshot(buildTradingConfigurationProjection(p.configuration).authority);
    const input:RetainedStateRecoveryInput={loaded,environment:"paper",tradingEnabled:false,entriesPaused:true,tradingLoopEnabled:false,aiWorkerEnabled:false,
      accountId:"DU_TEST",allowedPaperAccounts:["DU_TEST"],legacyEvidence:{schemaVersion:1,sourceHash:legacy.sourceHash,canonical:legacy.canonical}};
    await run(pool,input);
  }finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
async function latch(pool:Pool,input:RetainedStateRecoveryInput){
  const store=new TradingConfigurationStore(pool);
  for(const service of TRADING_CONFIGURATION_SERVICES)await store.register({service,processId:randomUUID(),loaded:input.loaded,tradingEnabled:false});
}
async function history(pool:Pool){
  await pool.query(`CREATE TABLE strategy_runtime_state(strategy_id TEXT PRIMARY KEY,enabled BOOLEAN NOT NULL,permanently_disabled BOOLEAN NOT NULL,
    cooldown_until TIMESTAMPTZ,consecutive_loss_count INT NOT NULL,cooldown_count INT NOT NULL,last_evaluated_fill_at TIMESTAMPTZ,reason TEXT);
    INSERT INTO strategy_runtime_state VALUES('momentum_breakout_long_v1',false,true,null,2,3,'2026-09-01','retained'),('other',false,false,'2026-12-01',1,1,'2026-09-02','cooldown');
    INSERT INTO broker_execution_fills(exec_id,account_id,conid,executed_at,strategy) VALUES('unlinked','DU_TEST','123','2026-09-01','momentum_breakout_long_v1'),('unknown','DU_TEST','456','2026-09-02',null);
    INSERT INTO execution_audit_log(correlation_id,route,method,actor_kind,outcome) VALUES('00000000-0000-0000-0000-000000000001','/historic','POST','operator','completed');`);
}
const inspect=async(pool:Pool,input:RetainedStateRecoveryInput)=>await retainedStateRecovery(pool,input) as RetainedStateInspection;
const recover=async(pool:Pool,input:RetainedStateRecoveryInput,review:RetainedStateInspection)=>await retainedStateRecovery(pool,input,review) as RetainedStateRecoveryReceipt;
const original=async(pool:Pool)=>{
  const rows:Record<string,unknown>={};
  for(const table of ["strategy_runtime_state","broker_execution_fills","execution_audit_log","trading_configuration_rollout","trading_configuration_transitions","paper_entry_migration_holds","paper_entry_budget_adoptions","paper_entry_attempts","paper_entry_legacy_day_debts"])
    rows[table]=(await pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return rows;
};
test("retained history rejects first adoption before committing latch or snapshot",{skip:!url},()=>isolated(async(pool,input)=>{
  await history(pool);await assert.rejects(()=>latch(pool,input),/LEGACY_STATE_SOURCE_UNPROVEN/);
  assert.equal((await pool.query("SELECT bundle_latched FROM trading_configuration_rollout")).rows[0].bundle_latched,false);
  assert.equal((await pool.query("SELECT * FROM trading_configuration_snapshots")).rowCount,0);
}));
test("explicit recovery copies every safety row once and preserves original history, audit and latch",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);const before=await original(pool),review=await inspect(pool,input);assert.equal(review.eligible,true,JSON.stringify(review));
  assert.equal((await pool.query("SELECT * FROM strategy_retained_state_recoveries")).rowCount,0);
  const receipt=await recover(pool,input,review);assert.ok(receipt.notBeforeBucketMs>Date.now());assert.deepEqual(await original(pool),before);
  const inherited=(await pool.query("SELECT implementation_id,enabled,permanently_disabled,consecutive_loss_count,cooldown_count FROM strategy_binding_legacy_inheritance ORDER BY implementation_id")).rows;
  assert.deepEqual(inherited,[{implementation_id:"momentum_breakout_long_v1",enabled:false,permanently_disabled:true,consecutive_loss_count:2,cooldown_count:3},
    {implementation_id:"other",enabled:false,permanently_disabled:false,consecutive_loss_count:1,cooldown_count:1}]);
  await pool.query("UPDATE strategy_runtime_state SET consecutive_loss_count=9");assert.deepEqual(await recover(pool,input,review),receipt);
  await assert.rejects(()=>recover(pool,input,{...review,inspectionDigest:"f".repeat(64)}),/REPEAT_CONFLICT/);
  for(const sql of ["UPDATE strategy_retained_state_recoveries SET history_count=1","DELETE FROM strategy_retained_state_recoveries","TRUNCATE strategy_retained_state_recoveries"])
    await assert.rejects(()=>pool.query(sql),/immutable/);
}));
test("disabled Paper, account, authority and peer preconditions cannot be bypassed",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);
  for(const change of [{tradingEnabled:true},{environment:"live"},{entriesPaused:false},{tradingLoopEnabled:true},{aiWorkerEnabled:true},{accountId:"OTHER"},
    {legacyEvidence:{...input.legacyEvidence,sourceHash:"a".repeat(64)}}])await assert.rejects(()=>inspect(pool,{...input,...change}),/RETAINED_RECOVERY_/);
  await pool.query("DELETE FROM trading_configuration_observations WHERE service='ingestion'");assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_PEER_MISMATCH"]);
}));
test("state and history changes require a new inspection; missing/invalid state and existing proposal reject",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);const review=await inspect(pool,input);
  await pool.query("UPDATE strategy_runtime_state SET cooldown_count=8 WHERE strategy_id='other'");await assert.rejects(()=>recover(pool,input,review),/EVIDENCE_CHANGED/);
  const next=await inspect(pool,input);await pool.query("UPDATE broker_execution_fills SET commission=1 WHERE exec_id='unknown'");await assert.rejects(()=>recover(pool,input,next),/EVIDENCE_CHANGED/);
  await pool.query("UPDATE strategy_runtime_state SET cooldown_until='infinity'");assert.equal((await inspect(pool,input)).eligible,false);
  await pool.query("UPDATE strategy_runtime_state SET cooldown_until=null; DELETE FROM strategy_runtime_state WHERE strategy_id='momentum_breakout_long_v1'");
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_STATE_UNAVAILABLE"]);
  await pool.query(`INSERT INTO proposed_orders(instrument,side,order_type,quantity,entry,reason,confidence,risk_check_status,status)
    VALUES('AAPL','BUY','LMT',1,100,'fixture',1,'PASS','PROPOSED')`);assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_OWNERSHIP_PRESENT"]);
  assert.equal((await pool.query("SELECT * FROM strategy_retained_state_recoveries")).rowCount,0);
}));
test("cutoff publication failure rolls back attestation and capture",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);const review=await inspect(pool,input);
  await pool.query(`CREATE FUNCTION reject_conversion() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected'; END$$;
    CREATE TRIGGER reject_conversion BEFORE INSERT ON strategy_runtime_conversion FOR EACH ROW EXECUTE FUNCTION reject_conversion()`);
  await assert.rejects(()=>recover(pool,input,review),/injected/);
  for(const table of ["strategy_runtime_conversion","strategy_binding_legacy_inheritance","strategy_retained_state_recoveries"])
    assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount,0);
}));
test("retained history alone never authorizes ordinary conversion",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);await assert.rejects(()=>new TradingConfigurationStore(pool).prepareStrategyRuntime(input.loaded,false),/LEGACY_STATE_SOURCE_UNPROVEN/);
  await pool.query("DROP TABLE strategy_runtime_state");assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_STATE_UNAVAILABLE"]);
}));
test("archived unowned metadata is provenance, while any ownership still rejects",{skip:!url},()=>isolated(async(pool,input)=>{
  const {canonicalJson,sha256}=await import("@ikbr/shared/trading-config");
  if(input.loaded.mode!=="bundle")throw Error("fixture");
  const current={...input.loaded.configuration,instruments:input.loaded.configuration.instruments.map(i=>i.id==="pko_wse"?{...i,entryEnabled:false}:i)};
  const pko=current.instruments.find(i=>i.id==="pko_wse")!;assert.equal(pko.contract.expectedMinTick,0.01);assert.equal(pko.entryEnabled,false);
  input.loaded={...input.loaded,configuration:current,effectiveHash:computeTradingConfigurationHash(current)};
  await latch(pool,input);await history(pool);
  const old=JSON.parse(input.legacyEvidence.canonical),oldPko=old.bindings.find((b:{instrumentId:string})=>b.instrumentId==="pko_wse");
  oldPko.minTick=0.0001;assert.equal(oldPko.minTick,0.0001);
  const canonical=canonicalJson(old);input.legacyEvidence={schemaVersion:1,canonical,sourceHash:sha256(canonical)};
  assert.equal((await inspect(pool,input)).eligible,true);
  await pool.query(`INSERT INTO proposed_orders(instrument,side,order_type,quantity,entry,reason,confidence,risk_check_status,status)
    VALUES('AAPL','BUY','LMT',1,100,'fixture',1,'PASS','UNKNOWN')`);
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_OWNERSHIP_PRESENT"]);
}));
test("recovery serializes state and fill writers and returns unchanged pre-write capture",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);const review=await inspect(pool,input);
  let arrived!:()=>void,release!:()=>void;const atBarrier=new Promise<void>(r=>{arrived=r;}),proceed=new Promise<void>(r=>{release=r;});
  const wrapped={query:pool.query.bind(pool),connect:async()=>{
    const db=await pool.connect();return {release:()=>db.release(),query:async(sql:string,values?:unknown[])=>{
      if(sql==="SELECT retained_strategy_recovery_inventory() AS inventory"){arrived();await proceed;}
      return db.query(sql,values);
    }};
  }};
  const pending=retainedStateRecovery(wrapped,input,review);await atBarrier;
  const state=await pool.connect(),fill=await pool.connect();
  try{
    const ids=await Promise.all([state,fill].map(async db=>(await db.query("SELECT pg_backend_pid() pid")).rows[0].pid));
    const writers=[state.query("UPDATE strategy_runtime_state SET cooldown_count=7 WHERE strategy_id='other'"),fill.query("UPDATE broker_execution_fills SET commission=1 WHERE exec_id='unknown'")];
    let blocked=false;
    for(let i=0;i<100;i++)if(Number((await pool.query("SELECT count(*) n FROM pg_stat_activity WHERE pid=ANY($1) AND wait_event_type='Lock'",[ids])).rows[0].n)===2){blocked=true;break;}
    assert.equal(blocked,true);release();await pending;await Promise.all(writers);
    assert.equal((await pool.query("SELECT cooldown_count FROM strategy_binding_legacy_inheritance WHERE implementation_id='other'")).rows[0].cooldown_count,1);
  }finally{release();state.release();fill.release();}
}));
const insertProof=`INSERT INTO strategy_retained_state_recoveries(source_hash,legacy_authority_hash,legacy_authority_canonical,account_hash,state_capture,state_digest,
 history_count,history_digest,inspection_digest,capture_semantics)
 SELECT $1,$2,$3,$4,i->'stateCapture',i->>'stateDigest',(i->>'historyCount')::bigint,i->>'historyDigest',$5,'present_legacy_state_not_historical_ownership_v1'
 FROM (SELECT retained_strategy_recovery_inventory() i) inventory`;
test("SQL rejects fabricated proof fields and cannot reuse a committed unattached receipt",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);const review=await inspect(pool,input),db=await pool.connect();
  const {sha256}=await import("@ikbr/shared/trading-config");
  const args=[review.sourceHash,review.legacyAuthorityHash,input.legacyEvidence.canonical,review.accountHash,review.inspectionDigest];
  try{
    const forgedDigest=(await pool.query("SELECT retained_strategy_inspection_digest($1,$2,$3,retained_strategy_recovery_inventory()) digest",[args[0],sha256("{}"),args[3]])).rows[0].digest;
    for(const bad of [[...args.slice(0,4),"f".repeat(64)],[args[0],sha256("{}"),"{}",args[3],forgedDigest]]){
      await db.query("BEGIN");await db.query("SET LOCAL TIME ZONE 'UTC'");await assert.rejects(()=>db.query(insertProof,bad),/RETAINED_RECOVERY_/);await db.query("ROLLBACK");
    }
    await db.query("BEGIN");await db.query("SET LOCAL TIME ZONE 'UTC'");await db.query(insertProof,args);await db.query("COMMIT");
    await assert.rejects(()=>pool.query("SELECT capture_strategy_binding_inheritance($1)",[review.sourceHash]),/LEGACY_STATE_SOURCE_UNPROVEN/);
    await assert.rejects(()=>recover(pool,input,review),/REPEAT_CONFLICT/);
    assert.equal((await pool.query("SELECT * FROM strategy_binding_legacy_inheritance")).rowCount,0);
  }finally{await db.query("ROLLBACK");db.release();}
}));
test("unknown WSH acquisitions and unresolved source calls remain blockers without clearing debt",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);
  await pool.query(`INSERT INTO research_wsh_endpoints(endpoint_id) VALUES('fixture');
    INSERT INTO research_wsh_acquisitions(id,endpoint_id,generation,session_id,source_id,instrument_id,ledger_key,config_hash,manifest_hash,state,retired_at)
    VALUES('00000000-0000-0000-0000-000000000002','fixture',1,'session','source','instrument','ledger','config','manifest','UNKNOWN',now())`);
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_OWNERSHIP_PRESENT"]);
}));
test("unresolved source reservation and nonfinite legacy audit date refuse recovery",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);
  await pool.query("ALTER TABLE strategy_runtime_state ADD COLUMN updated_at TIMESTAMPTZ; UPDATE strategy_runtime_state SET updated_at='infinity'");
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_STATE_INVALID"]);await pool.query("UPDATE strategy_runtime_state SET updated_at=null");
  const hash="b".repeat(64),source=input.loaded.mode==="bundle"?input.loaded.effectiveHash:"";
  await pool.query("INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,'{}')",[hash,source]);
  await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
    SELECT 'unknown-source','DU_TEST','source','source',$1,$2,$2,0,now(),now()+interval '5 seconds',(now() AT TIME ZONE 'UTC')::date`,[source,hash]);
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_OWNERSHIP_PRESENT"]);
  await pool.query("INSERT INTO research_call_outcomes(call_key,outcome) VALUES('unknown-source','UNKNOWN')");
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_OWNERSHIP_PRESENT"]);
  assert.equal((await pool.query("SELECT * FROM research_call_reservations")).rowCount,1);
}));
test("foreign retained account, stale/mixed peers, negative counters and different first identity reject",{skip:!url},()=>isolated(async(pool,input)=>{
  await latch(pool,input);await history(pool);
  await pool.query("UPDATE broker_execution_fills SET account_id='DU_FOREIGN' WHERE exec_id='unknown'");
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_HISTORY_INVALID"]);
  await pool.query("UPDATE broker_execution_fills SET account_id='DU_TEST' WHERE exec_id='unknown'");
  await pool.query("UPDATE trading_configuration_observations SET observed_at=now()-interval '1 minute' WHERE service='ingestion'");
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_PEER_MISMATCH"]);
  await pool.query("UPDATE trading_configuration_observations SET observed_at=now(),expires_at=now()+interval '30 seconds',mode='legacy' WHERE service='ingestion'");
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_PEER_MISMATCH"]);
  await pool.query("UPDATE trading_configuration_observations SET mode='bundle' WHERE service='ingestion'");
  await pool.query("UPDATE strategy_runtime_state SET consecutive_loss_count=-1 WHERE strategy_id='other'");
  assert.deepEqual((await inspect(pool,input)).reasons,["RETAINED_RECOVERY_STATE_INVALID"]);
  await pool.query("UPDATE strategy_runtime_state SET consecutive_loss_count=1 WHERE strategy_id='other'");
  if(input.loaded.mode!=="bundle")throw Error("fixture");
  const configuration={...input.loaded.configuration,strategyInstances:input.loaded.configuration.strategyInstances.map(i=>({...i,revision:i.revision+1}))};
  const changed={...input,loaded:{...input.loaded,configuration,effectiveHash:computeTradingConfigurationHash(configuration)}};
  assert.deepEqual((await inspect(pool,changed)).reasons,["RETAINED_RECOVERY_ROLLOUT_MISMATCH"]);
  assert.equal((await pool.query("SELECT * FROM strategy_retained_state_recoveries")).rowCount,0);
}));
