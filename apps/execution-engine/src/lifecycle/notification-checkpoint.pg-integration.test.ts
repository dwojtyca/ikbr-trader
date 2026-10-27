import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {mkdtempSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMigrations,resolveMigrationsDir} from '../migrations.js';
import {ExecutionRepository} from '../repository.js';
import {LifecycleNotificationCheckpoint,type NotificationContext} from './notification-checkpoint.js';
import {LifecycleAlertStore} from './lifecycle-alerts.js';
import {flatNotificationSnapshot} from './notification-checkpoint-test-fixture.js';
const connection=process.env.TEST_POSTGRES_URL;
const input={accountId:'PAPER',proposalId:null,code:'BROKER_STATE_STALE' as const,notification:'FLAT_WATCHDOG_V1' as const,evidence:{reason:'lifecycle_observation_overdue'}};
async function fixture(baseline=false){
 const name=`notification_${randomUUID().replaceAll('-','')}`,url=new URL(connection!);url.pathname='/postgres';
 const admin=new Pool({connectionString:url.toString()});await admin.query(`CREATE DATABASE ${name}`);url.pathname=`/${name}`;
 const pool=new Pool({connectionString:url.toString()});
 if(baseline){const dir=mkdtempSync(join(tmpdir(),'notification-migrations-'));try{for(const file of readdirSync(resolveMigrationsDir()).filter(f=>Number(f.slice(0,6))<32))copyFileSync(join(resolveMigrationsDir(),file),join(dir,file));await runMigrations(pool,{migrationsDir:dir});}finally{rmSync(dir,{recursive:true,force:true});}}
 else await runMigrations(pool);
 let context:NotificationContext={accountId:'PAPER',sessionId:'session',generation:1,connected:true};
 const checkpoint=new LifecycleNotificationCheckpoint(pool,new ExecutionRepository(pool),()=>context);
 const store=new LifecycleAlertStore(pool,checkpoint);
 async function seed(){
  const snapshot=flatNotificationSnapshot(context.accountId,context.sessionId,context.generation);
  await pool.query(`INSERT INTO broker_snapshot_syncs(account_id,session_id,observed_at,complete,generation) VALUES($1,$2,clock_timestamp(),true,1)
    ON CONFLICT(account_id) DO UPDATE SET session_id=EXCLUDED.session_id,observed_at=EXCLUDED.observed_at,complete=true,generation=1`,[context.accountId,context.sessionId]);
  const run=Number((await pool.query(`INSERT INTO reconciliation_runs(account_id,session_id,status,position_generation) VALUES($1,$2,'RUNNING',1) RETURNING id`,[context.accountId,context.sessionId])).rows[0].id);
  const sources=Object.fromEntries(['sessionBefore','positions','openOrders','executions','completedOrders','sessionAfter'].map(k=>[k,snapshot.capturedAt.toISOString()]));
  await checkpoint.publish(snapshot,{accountId:context.accountId,sessionId:context.sessionId,sessionStartedAt:new Date(),safetyMarginMs:100,sourceTimeoutMs:8000,abortSignal:new AbortController().signal,reconciliationRunId:run,positionGeneration:1},snapshot.capturedAt,sources);
  return {run,snapshot,async clean(){await pool.query(`UPDATE reconciliation_runs SET status='CLEAN',completed_at=clock_timestamp(),snapshot_complete=true,broker_snapshot=$2::jsonb,source_coverage=$3::jsonb WHERE id=$1`,[run,JSON.stringify(snapshot),JSON.stringify(snapshot.sourceCoverage)]);}};
 }
 async function proof(resolving=false){const db=await pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`snap:${context.accountId}`]);return await checkpoint.eligible(db,context.accountId,resolving);}finally{await db.query('ROLLBACK');db.release();}}
 return {pool,store,checkpoint,seed,proof,get context(){return context;},set context(c:NotificationContext){context=c;},async close(){await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}};
}
describe('flat watchdog notification PostgreSQL',{skip:!connection},()=>{
 it('retains immediate fault hold, coalesces only fresh recovery and preserves recurrence audit',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();assert.ok(await f.proof());await f.store.recordFault(input);
   const initial=(await f.store.readStatus('PAPER')).faults[0];assert.equal(initial.active,true);assert.equal(initial.delivery,'PENDING');
   assert.equal(initial.notificationDeadline!.getTime()-initial.firstObservedAt.getTime(),5000);
   await f.store.recordFault(input);assert.equal((await f.store.readStatus('PAPER')).faults[0].notificationDeadline!.getTime(),initial.notificationDeadline!.getTime());
   assert.equal(await f.store.claimNext(['PAPER'],'p'),null);await capture.clean();await f.store.resolveScope('PAPER',null,[]);
   let status=await f.store.readStatus('PAPER');assert.equal(status.faults[0].delivery,'COALESCED');assert.equal(status.faults[0].attempts,0);assert.equal(status.deliveryAttempts.length,0);
   await f.store.recordFault(input);await f.store.resolveScope('PAPER',null,[]);status=await f.store.readStatus('PAPER');assert.equal(status.faults.length,2);assert.ok(status.faults.every(x=>x.delivery==='COALESCED'));
   await f.store.startWorkerSession('PAPER','p');await f.store.heartbeatWorker('PAPER','p',true);const probe=await f.store.claimNext(['PAPER'],'p');assert.ok(probe);await f.store.complete(probe.id,probe.lease_token,{status:'DELIVERED',messageId:'1'});
   const db=await f.pool.connect();try{assert.equal(await f.store.entryFailure(db,'PAPER','p'),null);}finally{db.release();}
   await assert.rejects(f.pool.query(`UPDATE lifecycle_faults SET active=true WHERE id=$1`,[initial.id]),/COALESCED/);
   await assert.rejects(f.pool.query(`UPDATE lifecycle_alert_outbox SET status='DELIVERED' WHERE fault_id=$1`,[initial.id]),/COALESCED/);
   await assert.rejects(f.pool.query(`INSERT INTO lifecycle_alert_delivery_attempts(outbox_id,attempt_number,lease_token,status)
    SELECT id,1,$2,'SENDING' FROM lifecycle_alert_outbox WHERE fault_id=$1`,[initial.id,randomUUID()]),/COALESCED/);
  }finally{await f.close();}
 });
 it('promotes proof loss before due filtering and never coalesces after promotion or session change',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();await f.store.recordFault(input);f.context={...f.context,connected:false};
   const claim=await f.store.claimNext(['PAPER'],'p');assert.ok(claim);assert.equal(claim.attempts,1);
   f.context={...f.context,connected:true};await capture.clean();await f.store.resolveScope('PAPER',null,[]);
   assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'SENDING');
   await f.store.complete(claim.id,claim.lease_token,{status:'UNKNOWN',errorCode:'lost_ack'});
   await f.store.resolveScope('PAPER',null,[]);assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'UNKNOWN');
   await f.store.recordFault(input);f.context={...f.context,generation:2};const next=await f.seed();await next.clean();await f.store.resolveScope('PAPER',null,[]);
   assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'PENDING');
  }finally{await f.close();}
 });
 it('deadline cannot be extended; late recovery and earlier resolution cannot be blessed by later proof',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();await f.store.recordFault(input);
   await f.pool.query(`UPDATE lifecycle_faults SET first_observed_at=clock_timestamp()-interval '6 seconds' WHERE account_id='PAPER'`);
   await f.pool.query(`UPDATE lifecycle_alert_outbox o SET notification_deadline=f.first_observed_at+interval '5 seconds',next_attempt_at=f.first_observed_at+interval '5 seconds' FROM lifecycle_faults f WHERE f.id=o.fault_id`);
   await capture.clean();await f.store.resolveScope('PAPER',null,[]);assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'PENDING');assert.ok(await f.store.claimNext(['PAPER'],'p'));
   await f.store.recordFault(input);f.context={...f.context,connected:false};await f.store.resolveScope('PAPER',null,[]);
   f.context={...f.context,connected:true};await f.store.resolveScope('PAPER',null,[]);assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'PENDING');
  }finally{await f.close();}
 });
 it('rejects stale, future, malformed, different generation and uncorrelated execution checkpoints',async()=>{
  const f=await fixture();try{
   await f.seed();assert.ok(await f.proof());
   for(const sql of [
    `UPDATE lifecycle_notification_checkpoints SET acquisition_started_at=clock_timestamp()-interval '11 seconds'`,
    `UPDATE lifecycle_notification_checkpoints SET captured_at=clock_timestamp()+interval '1 second'`,
    `UPDATE broker_snapshot_syncs SET generation=2`,
    `UPDATE lifecycle_notification_checkpoints SET snapshot=jsonb_set(snapshot,'{sourceCoverage}','{}')`,
    `UPDATE lifecycle_notification_checkpoints SET sources_completed_at='{}'`,
   ]){await f.pool.query(sql);assert.equal(await f.proof(),null);await f.seed();}
   await f.pool.query(`UPDATE lifecycle_notification_checkpoints SET snapshot=jsonb_set(jsonb_set(snapshot,'{executions}',$1::jsonb),'{sourceCoverage,executions,count}','1')`,[JSON.stringify([{accountId:'PAPER',conId:'123',secType:'STK',execId:'unknown',brokerOrderId:'7',shares:1,executedAt:new Date().toISOString()}])]);assert.equal(await f.proof(),null);
   await f.seed();await f.store.recordFault({...input,code:'PROTECTION_GAP',proposalId:99});assert.equal(await f.proof(),null);
  }finally{await f.close();}
 });
 it('serializes claim versus recovery and keeps global due order across accounts',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();await f.store.recordFault(input);await capture.clean();
   const [claim]=await Promise.all([f.store.claimNext(['PAPER'],'p'),f.store.resolveScope('PAPER',null,[])]);assert.equal(claim,null);assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'COALESCED');
   await f.store.recordFault({accountId:'Z',proposalId:1,code:'PROTECTION_GAP',evidence:{}});
   await f.store.recordFault({accountId:'A',proposalId:1,code:'PROTECTION_GAP',evidence:{}});
   assert.equal((await f.store.claimNext(['A','Z'],'p'))?.account_id,'Z');
   await assert.rejects(f.pool.query(`UPDATE lifecycle_alert_outbox SET notification_deadline=clock_timestamp() WHERE account_id='A'`),/lifecycle_notification_policy_check/);
   await assert.rejects(f.pool.query(`UPDATE lifecycle_alert_outbox SET status='COALESCED' WHERE account_id='A'`));
  }finally{await f.close();}
 });
 it('proof exceptions and old ordinary outbox episodes remain immediate',async()=>{
  const f=await fixture();try{
   const broken=new LifecycleAlertStore(f.pool,{isCurrent:()=>false,eligible:async db=>{await db.query('SELECT absent_notification_column');return null;}});
   await broken.recordFault(input);assert.ok(await broken.claimNext(['PAPER'],'p'));
   const capture=await f.seed();await capture.clean();await f.store.resolveScope('PAPER',null,[]);assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'SENDING');
  }finally{await f.close();}
 });
 it('upgrades version31 without reclassifying existing faults or delivery history',async()=>{
  const f=await fixture(true);try{
   const id=(await f.pool.query(`INSERT INTO lifecycle_faults(account_id,code) VALUES('PAPER','BROKER_STATE_STALE') RETURNING id`)).rows[0].id;
   await f.pool.query(`INSERT INTO lifecycle_alert_outbox(account_id,fault_id,status,attempts,last_error_code) VALUES('PAPER',$1,'UNKNOWN',1,'lost_ack')`,[id]);
   const result=await runMigrations(f.pool);assert.deepEqual(result.applied,['000032_broker_stale_alert_policy.sql','000033_wsh_refresh_recovery.sql','000034_wsh_hourly_refresh.sql','000035_marketaux_hourly_refresh.sql','000036_accounting_clock_recovery.sql','000037_startup_research_recovery.sql','000038_accounting_owner_recovery.sql','000039_accounting_owner_api_evidence.sql','000040_research_recovery_created_producer.sql']);
   const row=(await f.pool.query('SELECT status,attempts,last_error_code,notification_policy FROM lifecycle_alert_outbox WHERE fault_id=$1',[id])).rows[0];
   assert.deepEqual(row,{status:'UNKNOWN',attempts:1,last_error_code:'lost_ack',notification_policy:null});
   assert.equal((await runMigrations(f.pool)).applied.length,0);
  }finally{await f.close();}
 });
 it('active deadline is due after restart while safety delivery hold remains active during delay',async()=>{
  const f=await fixture();try{
   await f.seed();await f.store.startWorkerSession('PAPER','p');await f.store.heartbeatWorker('PAPER','p',true);
   const probe=await f.store.claimNext(['PAPER'],'p');assert.ok(probe);await f.store.complete(probe.id,probe.lease_token,{status:'DELIVERED',messageId:'1'});
   await f.store.recordFault(input);const db=await f.pool.connect();try{assert.equal(await f.store.entryFailure(db,'PAPER','p'),'lifecycle_critical_delivery_unconfirmed');}finally{db.release();}
   await f.pool.query(`UPDATE lifecycle_faults SET first_observed_at=clock_timestamp()-interval '6 seconds' WHERE account_id='PAPER'`);
   await f.pool.query(`UPDATE lifecycle_alert_outbox o SET notification_deadline=f.first_observed_at+interval '5 seconds',next_attempt_at=f.first_observed_at+interval '5 seconds' FROM lifecycle_faults f WHERE f.id=o.fault_id`);
   const restart=new LifecycleAlertStore(f.pool,f.checkpoint);const claim=await restart.claimNext(['PAPER'],'p');assert.ok(claim);assert.equal((await restart.readStatus('PAPER')).faults[0].active,true);
  }finally{await f.close();}
 });
 it('pending entry under account lock prevents delayed classification; locked account cannot starve urgent other account',async()=>{
  const f=await fixture();const db=await f.pool.connect();try{
   await f.seed();await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('snap:PAPER')::bigint)");
   await db.query(`INSERT INTO proposed_orders(instrument,side,order_type,quantity,reason,confidence,risk_check_status,status,execution_account_id)
     VALUES('TEST','BUY','LMT',1,'fixture',1,'PASS','PROPOSED','PAPER')`);
   const recording=f.store.recordFault(input);await new Promise(resolve=>setImmediate(resolve));await db.query('COMMIT');await recording;
   assert.equal((await f.store.readStatus('PAPER')).faults[0].notificationPolicy,null);
   await f.store.recordFault({accountId:'Z',proposalId:1,code:'PROTECTION_GAP',evidence:{}});
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtext('snap:PAPER')::bigint)");
   const claim=await f.store.claimNext(['PAPER','Z'],'p');assert.equal(claim?.account_id,'Z');
   await db.query('ROLLBACK');
  }finally{await db.query('ROLLBACK');db.release();await f.close();}
 });
 it('current local exposure, active reconciliation hold and unknown close intent disqualify',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();
   await f.pool.query(`INSERT INTO broker_position_snapshots(account_id,instrument,conid,quantity,session_id,observed_at) VALUES('PAPER','TEST','123',1,'session',clock_timestamp())`);assert.equal(await f.proof(),null);await f.pool.query('DELETE FROM broker_position_snapshots');
   await f.pool.query(`INSERT INTO reconciliation_holds(account_id,instrument,identity_key,reason,severity,reconciliation_run_id) VALUES('PAPER','TEST','test','unknown_submission','CRITICAL',$1)`,[capture.run]);assert.equal(await f.proof(),null);await f.pool.query('DELETE FROM reconciliation_holds');
   const id=(await f.pool.query(`INSERT INTO proposed_orders(instrument,side,order_type,quantity,reason,confidence,risk_check_status,status,execution_account_id)
    VALUES('TEST','BUY','LMT',1,'fixture',1,'PASS','CANCELLED','PAPER') RETURNING id`)).rows[0].id;
   await f.pool.query(`INSERT INTO lifecycle_close_operations(original_proposal_id,request_id,account_id,session_id,client_id,socket_generation,original_hash,instrument_id,conid,limit_price,owner,actor,state)
    VALUES($1,$2,'PAPER','session',1,1,'hash','test','123',1,$3,'fixture','SUBMISSION_UNKNOWN')`,[id,randomUUID(),randomUUID()]);assert.equal(await f.proof(),null);
   await f.pool.query('DELETE FROM lifecycle_close_operations');
   await f.pool.query(`UPDATE proposed_orders SET status='SUBMITTED' WHERE id=$1`,[id]);assert.equal(await f.proof(),null);
  }finally{await f.close();}
 });
 it('expiry during eligibility cannot delay or coalesce an already due alarm',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();let expire=false;
   const slow=new LifecycleAlertStore(f.pool,{isCurrent:(account,proof)=>f.checkpoint.isCurrent(account,proof),eligible:async(db,account,resolving)=>{const proof=await f.checkpoint.eligible(db,account,resolving);return proof&&expire?{...proof,validUntil:new Date(0)}:proof;}});
   expire=true;await slow.recordFault(input);assert.equal((await slow.readStatus('PAPER')).faults[0].notificationPolicy,null);
   await slow.resolveScope('PAPER',null,[]);expire=false;await slow.recordFault(input);await capture.clean();expire=true;await slow.resolveScope('PAPER',null,[]);assert.equal((await slow.readStatus('PAPER')).faults[0].delivery,'PENDING');
  }finally{await f.close();}
 });

 it('immutable migration hold keeps notification immediate',async()=>{
  const f=await fixture();try{await f.seed();assert.ok(await f.proof());await f.pool.query(`INSERT INTO paper_entry_migration_holds(evidence_key,account_id,reason,evidence) VALUES('test','PAPER','unknown','{}')`);assert.equal(await f.proof(),null);}finally{await f.close();}
 });

});

describe('notification transaction boundary regressions',{skip:!connection},()=>{
 for(const operation of ['record','resolve'] as const)for(const driftAt of [2,3,4,5])it(`${operation} detects live identity drift at check ${driftAt}`,async()=>{
  const f=await fixture();try{
   const capture=await f.seed();if(operation==='resolve'){await f.store.recordFault(input);await capture.clean();}
   let checks=0;
   const guarded=new LifecycleAlertStore(f.pool,{eligible:(...args)=>f.checkpoint.eligible(...args),isCurrent:(account,proof)=>{
    checks++;if(checks===driftAt)f.context={...f.context,connected:false};return f.checkpoint.isCurrent(account,proof);
   }});
   if(operation==='record')await guarded.recordFault(input);else await guarded.resolveScope('PAPER',null,[]);
   const status=await guarded.readStatus('PAPER');
   assert.ok(status.faults.some(row=>row.active&&row.delivery==='PENDING'));
   assert.equal(status.faults.filter(row=>row.delivery==='COALESCED').length,operation==='resolve'&&driftAt===5?1:0);
   assert.ok(await guarded.claimNext(['PAPER'],'p'));
  }finally{await f.close();}
 });
 it('unknown COMMIT acknowledgement propagates without compensation or history rewrite',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();await f.store.recordFault(input);await capture.clean();let commits=0;
   const uncertainPool={connect:async()=>{const db=await f.pool.connect();return new Proxy(db,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
    const result=await Reflect.apply(target.query,target,args);if(args[0]==='COMMIT'){commits++;throw Error('fixture_commit_ack_unknown');}return result;
   };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}} as Pool;
   const uncertain=new LifecycleAlertStore(uncertainPool,f.checkpoint);
   await assert.rejects(uncertain.resolveScope('PAPER',null,[]),/fixture_commit_ack_unknown/);
   assert.equal(commits,1);const status=await f.store.readStatus('PAPER');assert.equal(status.faults.length,1);assert.equal(status.faults[0].delivery,'COALESCED');
  }finally{await f.close();}
 });
 it('held outbox row does not block another account claim or disabled transition',async()=>{
  const f=await fixture();const db=await f.pool.connect();try{
   await f.seed();await f.store.recordFault(input);await f.store.recordFault({accountId:'Z',proposalId:1,code:'PROTECTION_GAP',evidence:{}});
   await db.query('BEGIN');await db.query("SELECT id FROM lifecycle_alert_outbox WHERE account_id='PAPER' FOR UPDATE");
   assert.equal((await f.store.claimNext(['PAPER','Z'],'p'))?.account_id,'Z');
   await f.store.recordFault({accountId:'Z',proposalId:2,code:'PROTECTION_GAP',evidence:{}});
   await f.store.markDisabled(['PAPER','Z']);
   assert.equal((await f.store.readStatus('PAPER')).faults[0].delivery,'PENDING');assert.equal((await f.store.readStatus('Z')).faults[0].delivery,'DISABLED');
   await db.query('ROLLBACK');
  }finally{await db.query('ROLLBACK');db.release();await f.close();}
 });
 it('due claim versus recovery never coalesces an attempted or expired episode',async()=>{
  const f=await fixture();try{
   const capture=await f.seed();await f.store.recordFault(input);await capture.clean();
   await f.pool.query("UPDATE lifecycle_faults SET first_observed_at=clock_timestamp()-interval '6 seconds'");
   await f.pool.query("UPDATE lifecycle_alert_outbox o SET notification_deadline=f.first_observed_at+interval '5 seconds',next_attempt_at=f.first_observed_at+interval '5 seconds' FROM lifecycle_faults f WHERE f.id=o.fault_id");
   const [claimed]=await Promise.all([f.store.claimNext(['PAPER'],'p'),f.store.resolveScope('PAPER',null,[])]);
   const claim=claimed??await f.store.claimNext(['PAPER'],'p');assert.ok(claim);
   const status=await f.store.readStatus('PAPER');assert.equal(status.faults[0].delivery,'SENDING');assert.equal(status.deliveryAttempts.length,1);
  }finally{await f.close();}
 });
 it('new process session cannot reuse old checkpoint or old delayed policy',async()=>{
  const f=await fixture();try{
   await f.seed();await f.store.recordFault(input);f.context={...f.context,sessionId:'new-process'};
   const restartedCheckpoint=new LifecycleNotificationCheckpoint(f.pool,new ExecutionRepository(f.pool),()=>f.context);
   const restarted=new LifecycleAlertStore(f.pool,restartedCheckpoint);assert.ok(await restarted.claimNext(['PAPER'],'new-worker'));
   const capture=await f.seed();await capture.clean();await restarted.resolveScope('PAPER',null,[]);
   assert.equal((await restarted.readStatus('PAPER')).faults[0].delivery,'SENDING');
  }finally{await f.close();}
 });
 it('abort during an active PostgreSQL checkpoint query rolls back with no delayed publication',async()=>{
  const f=await fixture();const blocker=await f.pool.connect();try{
   const capture=await f.seed();await f.pool.query('DELETE FROM lifecycle_notification_checkpoints');
   await blocker.query('BEGIN');await blocker.query('LOCK TABLE reconciliation_runs IN ACCESS EXCLUSIVE MODE');
   const controller=new AbortController();const publication=f.checkpoint.publish(capture.snapshot,{accountId:'PAPER',sessionId:'session',sessionStartedAt:new Date(),reconciliationRunId:capture.run,positionGeneration:1,safetyMarginMs:1,sourceTimeoutMs:1000,abortSignal:controller.signal},capture.snapshot.capturedAt,{});
   // Observe the active blocked query rather than assume a timer reached it.
   let waiting=false;for(let n=0;n<100&&!waiting;n++){
    waiting=Number((await f.pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT r.id,s.generation,%'")).rows[0].count)>0;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,2));
   }
   assert.equal(waiting,true);controller.abort();await assert.rejects(publication,/notification_checkpoint_deadline/);
   await blocker.query('ROLLBACK');await new Promise(resolve=>setImmediate(resolve));
   assert.equal(Number((await f.pool.query('SELECT count(*) FROM lifecycle_notification_checkpoints')).rows[0].count),0);
  }finally{await blocker.query('ROLLBACK');blocker.release();await f.close();}
 });
});
