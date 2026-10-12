import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { buildTradingConfigurationProjection, canonicalizeTradingConfiguration } from '@ikbr/shared/trading-config';
import { runMigrations } from './migrations.js';
import { recurringPolicyFixture } from './paper-run-policy.fixture.js';
import { paperLocalDate, parsePaperRunPolicy } from './paper-run-policy.js';
import { adoptPaperEntryBudget, bindPaperProposal, checkPaperEntryBudget, reservePaperEntryAttempt } from './paper-entry-budget.js';
import { createSessionEntryGuard } from './session-entry-guard.js';
import { PaperPolicyAuthority } from './paper-policy-authority.js';
import { stockMetadataFixture } from './stock-market-test-fixture.js';
const url=process.env.TEST_POSTGRES_URL;
async function tx<T>(pool:Pool,fn:(db:PoolClient)=>Promise<T>){const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
async function fixture(fn:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){
 const name=`recurring_${randomUUID().replaceAll('-','')}`,target=new URL(url!);target.pathname='/postgres';const admin=new Pool({connectionString:target.toString()});await admin.query(`CREATE DATABASE ${name}`);target.pathname=`/${name}`;const pool=new Pool({connectionString:target.toString()});
 try{await runMigrations(pool);await fn(await setup(pool));}finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
async function setup(pool:Pool){
 const now=Date.now(),f=recurringPolicyFixture(paperLocalDate(now,'Europe/Warsaw')),account=f.policy.accountId;
 await pool.query('INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)',[f.loaded.effectiveHash,canonicalizeTradingConfiguration(f.loaded.configuration)]);
 const prior=parsePaperRunPolicy({IBKR_ENVIRONMENT:'paper',PAPER_RUN_POLICY_JSON:{version:1,runId:'prior',accountId:account,effectiveConfigHash:f.loaded.effectiveHash,accountDayTimeZone:'Europe/Warsaw',kind:'supervised_one_attempt',maxAttemptsPerAccountDay:1,maxAttemptsPerInstrumentDay:1,currencyCaps:f.manifest.currencyCaps,windows:f.manifest.instruments.map(i=>({...i,startsAt:new Date(now-1000).toISOString(),endsAt:new Date(now+60000).toISOString()}))}},f.loaded)!;
 await tx(pool,db=>adoptPaperEntryBudget(db,prior,{tradingEnabled:false}));await tx(pool,db=>adoptPaperEntryBudget(db,f.policy,{tradingEnabled:false}));
 const authority=buildTradingConfigurationProjection(f.loaded.configuration).authority,guard=createSessionEntryGuard(id=>authority.getBoundInstrument(id));
 for(const i of f.policy.instruments!){const bound=authority.getBoundInstrument(i.instrumentId)!;const evidence=stockMetadataFixture(bound,account,now).sessionEvidence;await pool.query("INSERT INTO instrument_session_schedules(instrument_id,conid,use_rth,generation,status,evidence,updated_at) VALUES($1,$2,true,1,'READY',$3,$4)",[i.instrumentId,String(i.conId),evidence.schedule,evidence.updatedAt]);}
 const state={writes:false,paused:true,ready:true,calls:0};
 const store=new PaperPolicyAuthority(pool,{policy:()=>f.policy,assertDisabledPaused:async()=>{if(state.writes||!state.paused)throw Error('disabled_paused');},readiness:async()=>{state.calls++;if(!state.ready)throw Error('not_ready');return{evidence:{ready:true},validUntilMs:Date.now()+10000,assertCurrent:()=>{if(!state.ready)throw Error('not_ready');}};}});
 const schedule={requestId:randomUUID(),expectedRevision:0,manifestHash:f.policy.manifestHash,priorManifestHash:prior.manifestHash,reason:'isolated same-day recurring adoption'};
 const adopt=async()=>{await store.change(account,'SCHEDULE',schedule,'fixture');await store.change(account,'ADOPT',{requestId:randomUUID(),expectedRevision:1,manifestHash:f.policy.manifestHash,reason:'fixture'},'fixture');};
 const proposal=async(index=0)=>{const i=f.policy.instruments![index];const id=Number((await pool.query("INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status) VALUES($1,$2,$3,'BUY','LMT',1,100,99,102,'fixture',.8,'PASS') RETURNING id",[i.instrument,i.instrumentId,String(i.conId)])).rows[0].id);const order={id,instrument:i.instrument,instrumentId:i.instrumentId,conid:String(i.conId)};await tx(pool,db=>bindPaperProposal(db,f.policy,id,order,guard));return order;};
 const supervise=async(order:Awaited<ReturnType<typeof proposal>>,status='FLAT')=>{await pool.query(`INSERT INTO lifecycle_supervision(original_proposal_id,account_id,original_hash,instrument_id,conid,session_identity,policy_source,exit_before_close_minutes,session_date,session_start,session_end,exit_deadline,session_generation,status,observed_at,terminal_proof)
 SELECT $1,$2,'fixture',$3,$4,'{}','ENTRY_RESERVATION',15,(session_binding->>'sessionDate'),starts_at,(session_binding->>'sessionEnd')::timestamptz,ends_at,1,$5,clock_timestamp(),CASE WHEN $5='FLAT' THEN '{"status":"FLAT"}'::jsonb ELSE NULL END FROM paper_run_proposals WHERE proposed_order_id=$1`,[order.id,account,order.instrumentId,order.conid,status]);};
 return{...f,pool,account,prior,guard,store,state,schedule,adopt,proposal,supervise};
}
test('v3 same-day adoption is explicit, paused, revisioned and never granted by registration', {skip:!url},()=>fixture(async f=>{
 const order=await f.proposal();assert.deepEqual(await checkPaperEntryBudget(f.pool,f.policy,f.account,order,{},f.guard),{ok:false,reason:'paper_budget_policy_adoption_required'});
 f.state.writes=true;await assert.rejects(f.store.change(f.account,'SCHEDULE',f.schedule,'fixture'),/disabled_paused/);f.state.writes=false;
 await f.adopt();assert.equal(f.state.paused,true);assert.ok(f.state.calls>=4);
 assert.equal((await f.store.change(f.account,'SCHEDULE',f.schedule,'fixture')).replay,true);
 assert.equal((await checkPaperEntryBudget(f.pool,f.policy,f.account,order,{},f.guard)).ok,true);
 assert.equal((await f.pool.query('SELECT paper_policy_cap($1,$2) cap',[f.account,f.policy.runId])).rows[0].cap,null);
 await assert.rejects(f.pool.query('SELECT paper_policy_cap($1,$2)',[f.account,f.prior.runId]),/AUTHORITY_MISMATCH/);
}));
test('v3 repeated completed same-day reservations exceed old quotas while unknown attempts remain held', {skip:!url},()=>fixture(async f=>{
 await f.adopt();
 for(let cycle=0;cycle<4;cycle++){const order=await f.proposal();assert.equal((await tx(f.pool,db=>reservePaperEntryAttempt(db,f.policy,f.account,order,f.guard))).ok,true);assert.equal((await checkPaperEntryBudget(f.pool,f.policy,f.account,order,{proposalId:order.id,dispatch:true},f.guard)).ok,true);await f.supervise(order);}
 const unknown=await f.proposal();assert.equal((await tx(f.pool,db=>reservePaperEntryAttempt(db,f.policy,f.account,unknown,f.guard))).ok,true);
 const next=await f.proposal();assert.deepEqual(await tx(f.pool,db=>reservePaperEntryAttempt(db,f.policy,f.account,next,f.guard)),{ok:false,reason:'paper_budget_active_attempt'});
 assert.equal((await f.pool.query('SELECT count(*)::int n FROM paper_entry_attempts')).rows[0].n,5);
 await assert.rejects(f.pool.query('DELETE FROM paper_entry_attempts'),/IMMUTABLE/);
}));
test('v3 allows only the other protected contract and preserves account-wide unknown holds', {skip:!url},()=>fixture(async f=>{
 await f.adopt();const first=await f.proposal();assert.equal((await tx(f.pool,db=>reservePaperEntryAttempt(db,f.policy,f.account,first,f.guard))).ok,true);await f.supervise(first,'PROTECTED');
 const second=await f.proposal(1);assert.equal((await tx(f.pool,db=>reservePaperEntryAttempt(db,f.policy,f.account,second,f.guard))).ok,true);
 const repeat=await f.proposal();assert.deepEqual(await tx(f.pool,db=>reservePaperEntryAttempt(db,f.policy,f.account,repeat,f.guard)),{ok:false,reason:'paper_budget_active_attempt'});
 await f.pool.query("UPDATE lifecycle_supervision SET status='HOLD' WHERE original_proposal_id=$1",[first.id]);
 assert.deepEqual(await checkPaperEntryBudget(f.pool,f.policy,f.account,second,{proposalId:second.id,dispatch:true},f.guard),{ok:false,reason:'paper_budget_active_attempt'});
}));
test('v3 binds actual session proof and a calendar revision only tightens the original cutoff', {skip:!url},()=>fixture(async f=>{
 await f.adopt();const order=await f.proposal();const binding=(await f.pool.query('SELECT * FROM paper_run_proposals WHERE proposed_order_id=$1',[order.id])).rows[0];assert.ok(binding.ends_at-binding.starts_at>3600000);assert.match(binding.session_binding.hash,/^[a-f0-9]{64}$/);
 const check=()=>checkPaperEntryBudget(f.pool,f.policy,f.account,order,{proposalId:order.id},f.guard);
 const original=await check();assert.ok(original.ok);
 const stored=(await f.pool.query('SELECT evidence FROM instrument_session_schedules WHERE instrument_id=$1',[order.instrumentId])).rows[0].evidence;
 stored.sessions[0].end=new Date(Date.now()+30*60000).toISOString();await f.pool.query('UPDATE instrument_session_schedules SET generation=generation+1,evidence=$2 WHERE instrument_id=$1',[order.instrumentId,stored]);
 const shortened=await check();assert.ok(shortened.ok);assert.ok(shortened.endsAtMs<original.endsAtMs);
 stored.sessions[0].end=new Date(Date.now()+2*3600000).toISOString();await f.pool.query('UPDATE instrument_session_schedules SET generation=generation+1,evidence=$2 WHERE instrument_id=$1',[order.instrumentId,stored]);
 const extended=await check();assert.ok(extended.ok);assert.equal(extended.endsAtMs,original.endsAtMs);
 await f.pool.query("UPDATE instrument_session_schedules SET status='FAILED' WHERE instrument_id=$1",[order.instrumentId]);assert.equal((await check()).ok,false);
}));
test('SQL explicit null capability rejects missing or malformed quotas and forged session binding', {skip:!url},()=>fixture(async f=>{
 for(const key of ['maxAttemptsPerAccountDay','maxAttemptsPerInstrumentDay']) for(const value of [undefined,1,'null']){
   const manifest={...f.manifest,[key]:value};const canonical=JSON.stringify(manifest);const valid=(await f.pool.query('SELECT paper_recurring_manifest_valid(jsonb_populate_record(r,$2::jsonb)) valid FROM paper_runs r WHERE run_id=$1',[f.policy.runId,JSON.stringify({manifest,canonical_manifest:canonical,manifest_hash:createHash('sha256').update(canonical).digest('hex')})])).rows[0].valid;assert.equal(valid,false);
 }
 const order=await f.proposal();const binding=(await f.pool.query('SELECT session_binding FROM paper_run_proposals WHERE proposed_order_id=$1',[order.id])).rows[0].session_binding;
 for(const key of ['status','generation','updatedAt','schedule']) { const forged=structuredClone(binding);delete forged.evidence[key];forged.canonical=JSON.stringify(forged.evidence);forged.hash=createHash('sha256').update(forged.canonical).digest('hex');await assert.rejects(f.pool.query("INSERT INTO paper_run_proposals(proposed_order_id,run_id,instrument_id,conid,session_timezone,starts_at,ends_at,session_binding) SELECT proposed_order_id,run_id,instrument_id,conid,session_timezone,starts_at,ends_at,$2 FROM paper_run_proposals WHERE proposed_order_id=$1",[order.id,forged]),/SESSION_EVIDENCE_INVALID/,key); }
 for(const evidence of [undefined,null,[],{}]) { const forged={...binding,evidence};await assert.rejects(f.pool.query("INSERT INTO paper_run_proposals(proposed_order_id,run_id,instrument_id,conid,session_timezone,starts_at,ends_at,session_binding) SELECT proposed_order_id,run_id,instrument_id,conid,session_timezone,starts_at,ends_at,$2 FROM paper_run_proposals WHERE proposed_order_id=$1",[order.id,forged]),/SESSION_EVIDENCE_INVALID/); }
 await assert.rejects(f.pool.query("INSERT INTO paper_run_proposals(proposed_order_id,run_id,instrument_id,conid,session_timezone,starts_at,ends_at,session_binding) SELECT proposed_order_id,run_id,instrument_id,conid,session_timezone,starts_at,ends_at,$2 FROM paper_run_proposals WHERE proposed_order_id=$1",[order.id,{...binding,hash:'0'.repeat(64)}]),/SESSION_EVIDENCE_INVALID/);
}));
