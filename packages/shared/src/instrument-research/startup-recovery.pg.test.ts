import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {seedTwoSourceResearchStore} from './research.fixture.js';
import {ResearchStore} from './store.js';
import {marketauxCallIdentity} from './marketaux.js';
import {researchHash} from './validation.js';
import type {RecoveryIdentity,RecoveryChallenge,RecoveryEvidence,ResearchRecoveryClock} from './startup-recovery.js';
const {Pool}=createRequire(new URL('../../../../apps/llm-agent/package.json',import.meta.url))('pg');
const connection=process.env.TEST_POSTGRES_URL;
async function isolated(run:(pool:any,clock:ResearchRecoveryClock,advance:(ms:number,host?:boolean)=>Promise<void>)=>Promise<void>, beforeRecoveryMigration?:(pool:any,clock:ResearchRecoveryClock)=>Promise<void>){
 const url=new URL(connection!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname)&& (url.port==='55434'&&url.pathname==='/ikbr_startup_recovery_test'||process.env.CI==='true'&&url.port==='5432'&&url.pathname==='/ikbr_trader_ci'));
 url.pathname='/postgres';const admin=new Pool({connectionString:url.href}),name='startup_recovery_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${name}`);url.pathname='/'+name;
 const pool=new Pool({connectionString:url.href,options:'-c search_path=public,pg_catalog'});let offset=0;
 const clock:ResearchRecoveryClock={wallNow:()=>Date.now()+offset,monotonicNow:()=>performance.now()+offset,domainId:()=> 'd'.repeat(64)};
 try{await pool.query('CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)');
 await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
 const dir=new URL('../../../../infra/sql/migrations/',import.meta.url);for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){if(file.startsWith('000037')&&beforeRecoveryMigration)await beforeRecoveryMigration(pool,clock);await pool.query(readFileSync(new URL(file,dir),'utf8'));}
 await run(pool,clock,async(ms,host=true)=>{await pool.query('UPDATE fixture_clock SET offset_ms=offset_ms+$1',[ms]);if(host)offset+=ms;});
 }finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
type Fixture=Awaited<ReturnType<typeof seedTwoSourceResearchStore>>;
async function claim(f:Fixture){const c=await f.store.claimMarketauxAttempt(f.identity);assert.ok(c.claimed);return c.ticket;}
async function reserve(f:Fixture,t:Awaited<ReturnType<typeof claim>>){
 const request={kind:'marketaux-news-v2' as const,attemptId:t.attemptId,slot:t.slot,sourceUrl:f.source.urls[0],windowStart:t.windowStart,asOf:t.asOf,pass:1 as const,page:1};
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,request);
 const permit=await f.store.reserveMarketauxCall(t,request,{...f.identity,provider:f.source.provider,kind:'source',...call,reservedCostMicros:f.source.costMicrosPerCall,maxRequestsPerDay:f.source.maxRequestsPerDay,maxCostMicrosPerDay:f.source.maxCostMicrosPerDay});return {call,permit};
}
function identity(f:Fixture):RecoveryIdentity{return {...f.identity,kind:'MARKETAUX_PRODUCER_QUIESCENCE',pauseRevision:1,actor:'operator:test',operationId:randomUUID()};}
function evidence(c:RecoveryChallenge):RecoveryEvidence{
 const at=Date.now(),stamp=(d:number)=>new Date(at+d).toISOString();return {version:'local-research-recovery-v1',kind:'MARKETAUX_PRODUCER_QUIESCENCE',challengeId:c.id,challengeHash:c.challengeHash,nonce:c.nonce,hostIdHash:'a'.repeat(64),platform:'darwin',collectorStartedAt:stamp(-3000),producerCheckedAt:stamp(-2000),producerRecheckedAt:stamp(-1000),deploymentHash:'b'.repeat(64),producers:[{containerId:'c'.repeat(64),imageId:'sha256:'+'d'.repeat(64),project:'fixture',service:'llm-agent',startedAt:stamp(-10000),finishedAt:stamp(-2500),state:'exited'}],runningProducerIds:[]};
}
async function maintenance(f:Fixture,pool:any){await pool.query('INSERT INTO execution_entry_controls(account_id) VALUES($1)',[f.accountId]);await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds' WHERE service='llm-agent'");}

test('expired fenced acquisition recovers once without refund or cached admission', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock}),t=await claim(f),{call,permit}=await reserve(f,t);permit.assertActive();
 assert.equal((await f.store.recoverMarketauxAttempts(f.identity)).state,'WAITING');
 await advance(126000);await f.observe();
 const outcomes=await Promise.all([f.store.recoverMarketauxAttempts(f.identity),f.store.recoverMarketauxAttempts(f.identity)]);
 assert.deepEqual(outcomes.map(r=>r.state).sort(),['NOT_REQUIRED','RECOVERED']);
 assert.equal((await pool.query('SELECT outcome FROM research_call_outcomes WHERE call_key=$1',[call.callKey])).rows[0].outcome,'UNKNOWN');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n,3);
 assert.throws(permit.assertActive,/CLOCK_OR_DEADLINE/);
 assert.equal((await f.store.claimMarketauxAttempt(f.identity)).claimed,false);
 assert.equal((await f.store.prepareRepair(f.identity)).state,'HOLD');
 await advance(3600000);await f.observe();await f.publishNews();assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
 assert.equal((await pool.query('SELECT state FROM research_marketaux_attempts WHERE id=$1',[t.attemptId])).rows[0].state,'UNKNOWN');
}));

test('database-only forward jump cannot recover or create a receipt', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await claim(f);await advance(3600000,false);await f.observe();
 const result=await f.store.recoverMarketauxAttempts(f.identity);assert.equal(result.state,'OPERATOR_REQUIRED');assert.equal(result.reason,'RESEARCH_RECOVERY_CLOCK_UNPROVED');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_recoveries')).rows[0].n,0);
}));

test('maintenance survives stopped producer heartbeat and commit never admits old cache', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await claim(f);await advance(126000);await f.observe();await maintenance(f,pool);
 const c=await f.store.prepareResearchRecovery(identity(f));
 await assert.rejects(f.store.prepareRepair(f.identity),/PEER_MISSING|MAINTENANCE_HOLD/);
 const input={challengeId:c.id,challengeHash:c.challengeHash,operationId:randomUUID(),actor:'operator:test',pauseRevision:1,evidence:evidence(c)};
 const receipt=await f.store.commitResearchRecovery(input);assert.equal((await f.store.commitResearchRecovery(input)).id,receipt.id);
 assert.equal((await f.store.readResearchRecovery(c.id))!.state,'COMMITTED');
 await f.observe();assert.equal((await f.store.prepareRepair(f.identity)).state,'HOLD');
 await assert.rejects(pool.query('DELETE FROM research_marketaux_recoveries'),/immutable/i);
}));

test('obsolete challenge supersession preserves hold and is read back by operation', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await claim(f);await advance(126000);await f.observe();await maintenance(f,pool);
 const first=await f.store.prepareResearchRecovery(identity(f));await pool.query("UPDATE execution_entry_controls SET revision=revision+1 WHERE account_id=$1",[f.accountId]);
 const replacement={...identity(f),pauseRevision:2};const old=evidence(first);
 const input={challengeId:first.id,challengeHash:first.challengeHash,replacement,evidence:{...old,kind:'PRODUCER_QUIESCENCE' as const}};
 const next=await f.store.supersedeResearchRecovery(input);assert.notEqual(next.id,first.id);
 assert.equal((await f.store.readResearchRecoveryReplacement(replacement.operationId,replacement))?.id,next.id);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_recovery_challenges WHERE state='PREPARED'")).rows[0].n,1);
 await f.observe();const held=await f.store.prepareRepair(f.identity);assert.equal(held.state,'HOLD');assert.ok(held.reasons.includes('RESEARCH_RECOVERY_MAINTENANCE_HOLD'));
}));

for(const [name,wallDelta,monoDelta] of [['wall forward with frozen monotonic',2000,0],['wall backward',-2000,0],['monotonic discontinuity',0,2000]] as const){
 test(`${name} permanently invalidates dispatch and success publication`,{skip:!connection},()=>isolated(async(pool,clock)=>{
  const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock}),ticket=await claim(f),{permit,call}=await reserve(f,ticket);
  const originalWall=clock.wallNow,originalMono=clock.monotonicNow;clock.wallNow=()=>originalWall()+wallDelta;clock.monotonicNow=()=>originalMono()+monoDelta;
  assert.throws(permit.assertActive,/CLOCK_OR_DEADLINE/);clock.wallNow=originalWall;clock.monotonicNow=originalMono;
  assert.throws(permit.assertActive,/CLOCK_OR_DEADLINE/);
  await assert.rejects(f.store.recordMarketauxCallOutcome(ticket,call.callKey,{outcome:'SUCCEEDED',contentHash:'e'.repeat(64)}),/CLOCK_OR_DEADLINE/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_outcomes WHERE call_key=$1',[call.callKey])).rows[0].n,0);
 }));
}
test('DB clock regression and slow sample fail before reservation', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await advance(-2000,false);await f.observe();
 await assert.rejects(f.store.claimMarketauxAttempt(f.identity),/CLOCK_UNPROVED/);await advance(2000,false);await f.observe();
 const base=clock.monotonicNow;let n=0;clock.monotonicNow=()=>base()+(++n)*2000;
 await assert.rejects(f.store.claimMarketauxAttempt(f.identity),/CLOCK_UNPROVED/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempts')).rows[0].n,0);
}));

test('operation readback discovers obsolete challenge only under current identical issuer scope', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await claim(f);await advance(126000);await f.observe();await maintenance(f,pool);
 const originalIdentity=identity(f),c=await f.store.prepareResearchRecovery(originalIdentity);
 await pool.query('UPDATE execution_entry_controls SET revision=revision+1 WHERE account_id=$1',[f.accountId]);
 const nextManifest=structuredClone(f.manifest);nextManifest.instruments[0].business+=' Updated fixture authority.';
 const {hash:nextHash}=await f.store.registerManifest({manifest:nextManifest,configuration:f.config,tradingEnabled:false,adopt:false});
 // Synthetic durable authority rotation; ordinary adoption continues to reject unresolved work.
 await pool.query('UPDATE research_authority SET manifest_hash=$1 WHERE config_hash=$2',[nextHash,f.configHash]);
 await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds'");
 const replacement={...originalIdentity,manifestHash:nextHash,pauseRevision:2};
 for(const service of ['execution-engine','llm-agent'] as const)await f.store.observe({...replacement,service,processId:service+'-replacement',tradingEnabled:false});
 assert.equal((await f.store.readResearchRecoveryReplacement(originalIdentity.operationId,replacement))?.id,c.id);
 await assert.rejects(f.store.readResearchRecovery(c.id),/PAUSE_CHANGED|AUTHORITY/);
 await assert.rejects(f.store.readResearchRecoveryReplacement(originalIdentity.operationId,originalIdentity),/PAUSE_CHANGED|AUTHORITY/);
 const other=nextManifest.instruments.find(p=>p.instrumentId!==f.identity.instrumentId)!;
 await assert.rejects(f.store.readResearchRecoveryReplacement(originalIdentity.operationId,{...replacement,instrumentId:other.instrumentId}),/SCOPE_INVALID/);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_recovery_challenges WHERE state='PREPARED'")).rows[0].n,1);
}));

test('exact commit receipt readback rejects wrong operation and preserves original evidence', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await claim(f);await advance(126000);await f.observe();await maintenance(f,pool);
 const c=await f.store.prepareResearchRecovery(identity(f)),input={challengeId:c.id,challengeHash:c.challengeHash,operationId:randomUUID(),actor:'operator:test',pauseRevision:1,evidence:evidence(c)};
 const receipt=await f.store.commitResearchRecovery(input);
 assert.deepEqual(await f.store.readResearchRecoveryReceipt(c.id,input.operationId),receipt);
 assert.equal(await f.store.readResearchRecoveryReceipt(c.id,randomUUID()),null);
 await assert.rejects(f.store.commitResearchRecovery({...input,evidence:{...input.evidence,deploymentHash:'f'.repeat(64)}}),/OPERATION_REUSED/);
 await assert.rejects(pool.query("UPDATE research_recovery_audit SET evidence_hash=$1 WHERE operation_id=$2",['f'.repeat(64),input.operationId]),/immutable/i);
 assert.equal((await f.store.readResearchRecoveryReceipt(c.id,input.operationId))?.evidenceHash,researchHash(input.evidence));
}));

test('expired challenge retains its hold and cannot be cancelled or committed by SQL', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await claim(f);await advance(126000);await f.observe();await maintenance(f,pool);
 const c=await f.store.prepareResearchRecovery(identity(f));await advance(901000);await f.observe();
 await assert.rejects(f.store.commitResearchRecovery({challengeId:c.id,challengeHash:c.challengeHash,operationId:randomUUID(),actor:'operator:test',pauseRevision:1,evidence:evidence(c)}),/CHALLENGE_EXPIRED/);
 const prep=await f.store.prepareRepair(f.identity);assert.equal(prep.state,'HOLD');assert.equal(prep.sources.find(s=>s.sourceId===f.source.id)?.marketauxRefresh?.recovery?.challengeId,c.id);
 await assert.rejects(pool.query("UPDATE research_recovery_challenges SET state='CANCELLED',successor_challenge_id=$2 WHERE id=$1",[c.id,randomUUID()]),/REPLACEMENT_INVALID/);
 await assert.rejects(pool.query("UPDATE research_recovery_challenges SET state='COMMITTED',receipt_id=$2 WHERE id=$1",[c.id,randomUUID()]),/RECEIPT_INVALID/);
 await assert.rejects(pool.query('TRUNCATE research_recovery_audit'),/immutable/i);
}));

for(const legacyState of ['UNKNOWN','STARTED'] as const){
 test(`legacy ${legacyState} with ${legacyState==='STARTED'?'six successful pages and missing pass two':'unknown first page'} requires exact producer proof`,{skip:!connection},async()=>{
  let f:Fixture;const attemptId=randomUUID();let original:any;let reservationRows:any[];let outcomes:any[];
  await isolated(async(pool,clock,advance)=>{
   await advance(126000);await f.observe();assert.equal((await f.store.recoverMarketauxAttempts(f.identity)).state,'OPERATOR_REQUIRED');
   assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_recoveries')).rows[0].n,0);
   await maintenance(f,pool);const c=await f.store.prepareResearchRecovery(identity(f));assert.equal(c.predecessors[0].id,attemptId);
   await f.store.commitResearchRecovery({challengeId:c.id,challengeHash:c.challengeHash,operationId:randomUUID(),actor:'operator:test',pauseRevision:1,evidence:evidence(c)});
   const after=(await pool.query('SELECT * FROM research_marketaux_attempts WHERE id=$1',[attemptId])).rows[0];
   if(legacyState==='UNKNOWN')assert.deepEqual(after,original);else assert.equal(after.state,'UNKNOWN');
   assert.deepEqual((await pool.query('SELECT * FROM research_call_reservations ORDER BY call_key')).rows,reservationRows);
   for(const old of outcomes)assert.deepEqual((await pool.query('SELECT * FROM research_call_outcomes WHERE call_key=$1',[old.call_key])).rows[0],old);
   await f.observe();assert.equal((await f.store.prepareRepair(f.identity)).state,'HOLD');
   await advance(3600000);await f.observe();await f.publishWsh();await f.publishNews();assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
   assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempt_calls WHERE attempt_id=$1',[attemptId])).rows[0].n,legacyState==='UNKNOWN'?1:7);
  },async(pool,clock)=>{
   f=await seedTwoSourceResearchStore(pool,{publishNews:false,publishWsh:false,recoveryClock:clock});
   const started=new Date(await f.clock()).toISOString(),deadline=new Date(Date.parse(started)+120000).toISOString();
   await pool.query(`INSERT INTO research_marketaux_attempts(id,account_id,provider,config_hash,manifest_hash,instrument_id,source_id,ledger_key,source_hash,slot,started_at,deadline_at,state)
     VALUES($1,$2,'https://api.marketaux.com',$3,$4,$5,$6,$7,$8,$9,$10,$11,'STARTED')`,[attemptId,f.accountId,f.configHash,f.manifestHash,f.identity.instrumentId,f.source.id,'marketaux:ibkr-conid:'+f.policy.listing.conId,researchHash(f.source),Math.floor(Date.parse(started)/3600000),started,deadline]);
   for(let i=0;i<(legacyState==='UNKNOWN'?1:7);i++){
    const key='legacy_'+randomUUID(),stamp=new Date(await f.clock()).toISOString();
    await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
      VALUES($1,$2,'https://api.marketaux.com','source',$3,$4,$5,1,$6,$7,$8)`,[key,f.accountId,f.configHash,f.manifestHash,researchHash({fixture:attemptId,page:i}),stamp,new Date(Date.parse(stamp)+10000).toISOString(),stamp.slice(0,10)]);
    await pool.query('INSERT INTO research_marketaux_attempt_calls(call_key,attempt_id,pass,page) VALUES($1,$2,$3,$4)',[key,attemptId,i<6?1:2,i<6?i+1:1]);
    if(legacyState==='UNKNOWN'||i<6){await pool.query('INSERT INTO research_call_outcomes(call_key,outcome) VALUES($1,$2)',[key,legacyState==='UNKNOWN'?'UNKNOWN':'SUCCEEDED']);
      await pool.query('INSERT INTO research_marketaux_response_receipts(call_key,content_hash,recorded_at) SELECT call_key,$2,recorded_at FROM research_call_outcomes WHERE call_key=$1',[key,legacyState==='UNKNOWN'?null:'c'.repeat(64)]);}
   }
   if(legacyState==='UNKNOWN')await pool.query("UPDATE research_marketaux_attempts SET state='UNKNOWN',finished_at=clock_timestamp(),failure_class='UNKNOWN',failure_reason='RESEARCH_SOURCE_TIMEOUT' WHERE id=$1",[attemptId]);
   original=(await pool.query('SELECT * FROM research_marketaux_attempts WHERE id=$1',[attemptId])).rows[0];
   Object.assign(original,{recovery_protocol:null,clock_domain_id:null,clock_db_at:null,clock_wall_at:null});
   reservationRows=(await pool.query('SELECT * FROM research_call_reservations ORDER BY call_key')).rows;outcomes=(await pool.query('SELECT * FROM research_call_outcomes')).rows;
  });
 });
}

function commitFaultPool(pool:any,statement:string,afterCommit:boolean){
 let armed=false;
 return {arm:()=>{armed=true;},pool:{query:pool.query.bind(pool),connect:async()=>{
  const client=await pool.connect();let target=false;
  return {release:client.release.bind(client),query:async(sql:string,params?:unknown[])=>{
   if(armed&&sql.includes(statement))target=true;
   if(armed&&target&&sql==='COMMIT'){
    armed=false;if(afterCommit)await client.query(sql,params);throw new Error('synthetic lost COMMIT acknowledgement');
   }
   return client.query(sql,params);
  }};
 }}};
}
for(const afterCommit of [false,true])test(`publication lost ACK ${afterCommit?'after':'before'} commit has exact persisted result and no retry`,{skip:!connection},()=>isolated(async(pool,clock)=>{
 const fault=commitFaultPool(pool,"SET state='SUCCEEDED'",afterCommit),f=await seedTwoSourceResearchStore(fault.pool,{publishNews:false,recoveryClock:clock});
 const ticket=await claim(f);fault.arm();await assert.rejects(f.publishNews(ticket),/lost COMMIT/);
 const result=await f.store.readMarketauxAttemptResult(ticket.attemptId);
 assert.equal(result?.state,afterCommit?'SUCCEEDED':'FINALIZING');assert.equal(result?.verified,afterCommit);assert.equal(result?.snapshotId!==null,afterCommit);
 if(afterCommit)assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');else assert.equal((await f.store.prepareRepair(f.identity)).state,'HOLD');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_marketaux_attempts')).rows[0].n,1);
}));
test('automatic retirement lost COMMIT acknowledgement resolves exact receipt once', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const fault=commitFaultPool(pool,'INSERT INTO research_marketaux_recoveries',true),f=await seedTwoSourceResearchStore(fault.pool,{publishNews:false,recoveryClock:clock});
 await claim(f);await advance(126000);await f.observe();fault.arm();
 const result=await f.store.recoverMarketauxAttempts(f.identity);assert.equal(result.state,'RECOVERED');assert.equal(result.recoveryIds.length,1);
 assert.equal((await pool.query('SELECT id FROM research_marketaux_recoveries')).rows[0].id,result.recoveryIds[0]);
 assert.equal((await f.store.recoverMarketauxAttempts(f.identity)).state,'NOT_REQUIRED');
}));

test('known HTTP failure after clock discontinuity cannot retain or publish eligible cache', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{recoveryClock:clock});await advance(3600000);await f.observe();const ticket=await claim(f),{call}=await reserve(f,ticket);
 await f.store.recordMarketauxCallOutcome(ticket,call.callKey,{outcome:'FAILED'});
 const original=clock.wallNow;clock.wallNow=()=>original()+2000;
 const result=await f.store.finishMarketauxFailure(ticket,{outcome:'FAILED',reason:'RESEARCH_SOURCE_HTTP_503',sourceError:{name:'HTTPError',code:null,message:'Synthetic unavailable response',httpStatus:503}},()=>{throw new Error('negative publication must not run');});
 assert.deepEqual(result,{retained:false,snapshot:null});
 const row=(await pool.query('SELECT state,retained FROM research_marketaux_attempts WHERE id=$1',[ticket.attemptId])).rows[0];assert.deepEqual(row,{state:'UNKNOWN',retained:false});
}));

test('SQL Marketaux admission waits for concurrent maintenance preparation before rejecting', {skip:!connection},()=>isolated(async(pool,clock,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,recoveryClock:clock});await claim(f);await advance(126000);await f.observe();await maintenance(f,pool);
 let notify!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>{notify=r;}),gate=new Promise<void>(r=>{release=r;});
 const wrapped={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();let preparing=false;return {release:client.release.bind(client),query:async(sql:string,values?:unknown[])=>{
  if(sql.includes('INSERT INTO research_recovery_challenges('))preparing=true;if(preparing&&sql==='COMMIT'){notify();await gate;}return client.query(sql,values);
 }}}};
 const store=new ResearchStore(wrapped,clock),preparing=store.prepareResearchRecovery(identity(f));await reached;
 const client=await pool.connect();let insert:Promise<unknown>|undefined;
 try{
  const pid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  insert=client.query(`INSERT INTO research_marketaux_attempts(id,account_id,provider,config_hash,manifest_hash,instrument_id,source_id,ledger_key,source_hash,slot,started_at,deadline_at,state,recovery_protocol,clock_domain_id,clock_db_at,clock_wall_at)
   SELECT $1,$2,'https://api.marketaux.com',$3,$4,$5,$6,$7,$8,floor(extract(epoch FROM stamp)/3600),stamp,stamp+interval '120 seconds','STARTED','DEADLINE_FENCED_HTTP_V1',$9,stamp,stamp FROM (SELECT clock_timestamp() AS stamp) t`,[randomUUID(),f.accountId,f.configHash,f.manifestHash,f.identity.instrumentId,f.source.id,'marketaux:ibkr-conid:'+f.policy.listing.conId,researchHash(f.source),'d'.repeat(64)]);
  const rejected=assert.rejects(insert,/RESEARCH_RECOVERY_MAINTENANCE_HOLD/);let blocked=false;const end=Date.now()+2000;
  while(Date.now()<end){if((await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='research_recovery_challenges'::regclass AND mode='ShareLock' AND NOT granted",[pid])).rows.length){blocked=true;break;}await new Promise<void>(resolve=>setImmediate(resolve));}
  assert.equal(blocked,true);release();await preparing;await rejected;
 }finally{release();await preparing.catch(()=>{});if(insert)await insert.catch(()=>{});client.release();}
}));
