import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { seedTwoSourceResearchStore } from './research.fixture.js';
import { researchHash } from './validation.js';
import { canonicalJson } from '../trading-configuration/identity.js';
import { marketauxCallIdentity } from './marketaux.js';
const { Pool } = createRequire(new URL('../../../../apps/llm-agent/package.json', import.meta.url))('pg');
const connection = process.env.TEST_POSTGRES_URL;
const directory = new URL('../../../../infra/sql/migrations/', import.meta.url);
const migration45 = readFileSync(new URL('000045_startup_research_freshness.sql', directory), 'utf8');
async function isolated(through: number, run: (pool: any, advance: (ms: number) => Promise<void>) => Promise<void>) {
 const url = new URL(connection!);
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && (url.port==='55434' && url.pathname==='/ikbr_startup_recovery_test' || process.env.CI==='true' && url.port==='5432' && url.pathname==='/ikbr_trader_ci'), 'Only isolated PostgreSQL allowed');
 url.pathname='/postgres'; const admin=new Pool({connectionString:url.href}), name='source_upgrade_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE DATABASE ${name}`); url.pathname='/'+name;
 const pool=new Pool({connectionString:url.href,options:'-c search_path=public,pg_catalog'});
 try {
  await pool.query('CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)');
  await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.sql') && Number(f.slice(0,6))<=through).sort()) await pool.query(readFileSync(new URL(file,directory),'utf8'));
  await run(pool,async ms=>{await pool.query('UPDATE fixture_clock SET offset_ms=offset_ms+$1',[ms]);});
 } finally {await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}

test('migration45 preserves original migration42 receipts, challenge disposition, charges and late-call fences while admitting due demand before old hour', {skip:!connection},()=>isolated(44,async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false,publishNews:false}), identity={...f.identity,sourceId:f.wshSource.id};
 let predecessor!: Awaited<ReturnType<typeof f.store.beginWshAcquisition>>;
 const callKey='legacy_'+randomUUID();
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{
  predecessor=await f.store.beginWshAcquisition(lease,{...identity,sessionId:randomUUID(),reservation:{...f.identity,provider:'ibkr-wsh',kind:'source',callKey,requestHash:'a'.repeat(64),deadlineAt:new Date(await f.clock()+9000).toISOString(),reservedCostMicros:0,maxRequestsPerDay:f.wshSource.maxRequestsPerDay,maxCostMicrosPerDay:f.wshSource.maxCostMicrosPerDay}});
 });
 await advance(40000);await f.observe();
 await pool.query('INSERT INTO execution_entry_controls(account_id) VALUES($1)',[f.accountId]);
 await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds' WHERE service='llm-agent'");
 const challenge=await f.store.prepareResearchRecovery({...identity,kind:'WSH_ENDPOINT_RESET',pauseRevision:1,actor:'operator:test',operationId:randomUUID()});
 await f.observe();assert.equal((await f.store.recoverExpiredWshReads(identity)).state,'RECOVERED');
 const capture=async()=>({
  acquisitions:(await pool.query('SELECT to_jsonb(a) data FROM research_wsh_acquisitions a ORDER BY id')).rows,
  receipts:(await pool.query('SELECT to_jsonb(r) data FROM research_wsh_read_recoveries r ORDER BY id')).rows,
  predecessors:(await pool.query('SELECT to_jsonb(r) data FROM research_wsh_read_recovery_predecessors r ORDER BY predecessor_id')).rows,
  challenges:(await pool.query('SELECT to_jsonb(r) data FROM research_recovery_challenges r ORDER BY id')).rows,
  dispositions:(await pool.query('SELECT to_jsonb(r) data FROM research_wsh_read_recovery_challenges r ORDER BY challenge_id')).rows,
  reservations:(await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r ORDER BY call_key')).rows,
  outcomes:(await pool.query('SELECT to_jsonb(r) data FROM research_call_outcomes r ORDER BY call_key')).rows,
 });
 const original=await capture();
 const receipt=JSON.parse(original.receipts[0].data.canonical_json),oldHour=Date.parse(receipt.issuers[0].nextRegularAt);
 assert.equal(original.dispositions[0].data.challenge_id,challenge.id);
 assert.equal(original.outcomes.length,0);
 await assert.rejects(f.store.recordCallOutcome(callKey,'SUCCEEDED'),/GENERATION_RETIRED/);
 await pool.query(migration45);
 assert.deepEqual(await capture(),original);
 await assert.rejects(f.store.recordCallOutcome(callKey,'SUCCEEDED'),/GENERATION_RETIRED/);
 await assert.rejects(pool.query("UPDATE research_recovery_challenges SET state='CANCELLED' WHERE id=$1",[challenge.id]),/SUPERSEDED|CHALLENGE/);
 await assert.rejects(pool.query("UPDATE research_wsh_acquisitions SET state='PUBLISHED' WHERE id=$1",[predecessor.id]),/RETIRED|IDENTITY|OUTCOME|IMMUTABLE/);
 const before=await f.store.prepareRepair(identity);
 assert.equal(before.sources.find(s=>s.sourceId===identity.sourceId)?.acquisition?.state,'WAITING');
 await advance(31000);await f.observe();await f.store.prepareRepair(identity);
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{
  const claimed=await f.store.claimWshAttempt(lease,{...identity,sessionId:randomUUID()},'demand');
  assert.equal(claimed.state,'CLAIMED');if(claimed.state!=='CLAIMED')return;
  assert.ok(Date.parse(claimed.ticket.startedAt)<oldHour);assert.ok(claimed.ticket.publicationSlotKey);
  await f.store.confirmWshPreflight(lease,claimed.ticket);
  const successor=await f.store.beginWshAcquisition(lease,{...identity,sessionId:claimed.ticket.sessionId,reservation:{...f.identity,provider:'ibkr-wsh',kind:'source',callKey:'successor_'+randomUUID(),requestHash:'b'.repeat(64),deadlineAt:new Date(await f.clock()+9000).toISOString(),reservedCostMicros:0,maxRequestsPerDay:f.wshSource.maxRequestsPerDay,maxCostMicrosPerDay:f.wshSource.maxCostMicrosPerDay}},claimed.ticket);
  assert.notEqual(successor.id,predecessor.id);assert.ok(successor.generation>predecessor.generation);
 });
 assert.deepEqual((await capture()).receipts,original.receipts);
 assert.deepEqual((await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r WHERE call_key=$1',[callKey])).rows,original.reservations);
 await assert.rejects(f.store.recordCallOutcome(callKey,'SUCCEEDED'),/GENERATION_RETIRED/);
}));

test('migration45 rejects an altered migration44 function definition before schema mutation', {skip:!connection},()=>isolated(44,async pool=>{
 const before=(await pool.query("SELECT pg_get_functiondef('research_marketaux_attempt_guard()'::regprocedure) definition")).rows[0].definition as string;
 assert.ok(before.includes('RESEARCH_MARKETAUX_OUTCOME_INVALID'));
 await pool.query(before.replace('RESEARCH_MARKETAUX_OUTCOME_INVALID','RESEARCH_MARKETAUX_OUTCOME_CHANGED'));
 const db=await pool.connect();try {await db.query('BEGIN');await assert.rejects(db.query(migration45),/RESEARCH_DEMAND_BASELINE_FUNCTION_MISMATCH/);await db.query('ROLLBACK');}finally{db.release();}
 assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='research_marketaux_attempts' AND column_name='admission_kind'")).rows[0].n,0);
}));

type Fixture=Awaited<ReturnType<typeof seedTwoSourceResearchStore>>;
async function failedNews(f:Fixture,httpStatus?:number) {
 const claimed=await f.store.claimMarketauxAttempt(f.identity);assert.ok(claimed.claimed);if(!claimed.claimed)throw new Error(claimed.reason);
 const ticket=claimed.ticket,request={kind:'marketaux-news-v2' as const,attemptId:ticket.attemptId,slot:ticket.slot,sourceUrl:f.source.urls[0],windowStart:ticket.windowStart,asOf:ticket.asOf,pass:1 as const,page:1};
 const call=marketauxCallIdentity(ticket.manifestHash,ticket.instrumentId,f.source,request);
 await f.store.reserveMarketauxCall(ticket,request,{...f.identity,provider:f.source.provider,kind:'source',...call,reservedCostMicros:f.source.costMicrosPerCall,maxRequestsPerDay:f.source.maxRequestsPerDay,maxCostMicrosPerDay:f.source.maxCostMicrosPerDay});
 await f.store.recordMarketauxCallOutcome(ticket,call.callKey,httpStatus?{outcome:'FAILED'}:{outcome:'SUCCEEDED',contentHash:'a'.repeat(64)});
 const reason=httpStatus?`RESEARCH_SOURCE_HTTP_${httpStatus}`:'RESEARCH_MARKETAUX_PAYLOAD_INVALID',sourceError={name:'Error',code:null,message:reason,...(httpStatus?{httpStatus}:{})};
 const finish=()=>f.store.finishMarketauxFailure(ticket,{reason,sourceError,outcome:'FAILED'},stamp=>{
  const snapshot=f.empty(stamp);snapshot.coverage.push({sourceId:f.source.id,role:'news',status:'ERROR',complete:false,evidenceRefs:[],checkedAt:stamp,windowStart:ticket.windowStart,windowEnd:ticket.asOf,reason,sourceError});return snapshot;
 });
 return {ticket,finish};
}

test('source rename and manifest rotation retain issuer failure delay and charged history', {skip:!connection},()=>isolated(45,async(pool,advance)=>{
 let offset=0;const recoveryClock={wallNow:()=>Date.now()+offset,monotonicNow:()=>performance.now()+offset,domainId:()=> 'd'.repeat(64)};
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,publishWsh:false,recoveryClock}),failure=await failedNews(f);await failure.finish();
 const prior=(await pool.query('SELECT to_jsonb(a) data FROM research_marketaux_attempts a WHERE id=$1',[failure.ticket.attemptId])).rows[0].data;
 const charged=(await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r ORDER BY call_key')).rows;
 const manifest=structuredClone(f.manifest),policy=manifest.instruments.find(p=>p.instrumentId===f.identity.instrumentId)!;
 const source=policy.sources.find(s=>s.id===f.identity.sourceId)!;source.id='renamed-news';
 await f.store.registerManifest({manifest,configuration:f.config,tradingEnabled:false,adopt:true});
 const identity={...f.identity,manifestHash:researchHash(manifest),sourceId:source.id};
 const observe=async()=>{
  await pool.query("UPDATE trading_configuration_observations SET observed_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 seconds'");
  for(const service of ['execution-engine','llm-agent'] as const)await f.store.observe({...identity,service,processId:'rotated-'+service,tradingEnabled:false});
 };
 await pool.query("UPDATE research_observations SET expires_at=clock_timestamp()-interval '1 millisecond' WHERE manifest_hash<>$1",[identity.manifestHash]);
 await observe();let prep=await f.store.prepareRepair(identity),demand=prep.sources.find(s=>s.sourceId===source.id)!.acquisition!;
 assert.equal(demand.state,'WAITING');assert.equal(Date.parse(demand.nextDemandAt!),Date.parse(prior.finished_at)+30000);
 assert.equal((await f.store.claimMarketauxAttempt(identity,'demand')).claimed,false);
 await advance(31000);offset+=31000;await observe();prep=await f.store.prepareRepair(identity);demand=prep.sources.find(s=>s.sourceId===source.id)!.acquisition!;
 assert.equal(demand.reason,'RESEARCH_SOURCE_DEMAND');assert.ok((await f.store.claimMarketauxAttempt(identity,'demand')).claimed);
 assert.deepEqual((await pool.query('SELECT to_jsonb(a) data FROM research_marketaux_attempts a WHERE id=$1',[failure.ticket.attemptId])).rows[0].data,prior);
 assert.deepEqual((await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r ORDER BY call_key')).rows,charged);
}));

test('claim waits for concurrent provider cooldown transaction and observes its committed deadline', {skip:!connection},()=>isolated(45,async pool=>{
 let release!:()=>void,entered!:()=>void,armed=false;
 const gate=new Promise<void>(resolve=>{release=resolve;}),written=new Promise<void>(resolve=>{entered=resolve;});
 const wrapped={query:pool.query.bind(pool),connect:async()=>{
  const client=await pool.connect();return {release:(destroy?:boolean)=>client.release(destroy),query:async(sql:string,values?:unknown[])=>{
   const result=await client.query(sql,values);
   if(armed && sql.startsWith("UPDATE research_marketaux_attempts SET state='FAILED'")){entered();await gate;}
   return result;
  }};
 }};
 const f=await seedTwoSourceResearchStore(wrapped,{publishNews:false,publishWsh:false}),other=await seedTwoSourceResearchStore(pool,{instrumentId:'xyz_nyse',publishNews:false,publishWsh:false});
 const failure=await failedNews(f,429);armed=true;const finishing=failure.finish();await written;
 let settled=false;const claiming=other.store.claimMarketauxAttempt(other.identity,'regular').finally(()=>{settled=true;});
 try {
  for(let i=0;i<30;i++){
   const waiting=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) waiting")).rows[0].waiting;
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(settled,false);
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE instrument_id='xyz_nyse'")).rows[0].n,0);
 } finally {release();}
 await finishing;const denied=await claiming;assert.equal(denied.claimed,false);
 if(!denied.claimed){assert.equal(denied.reason,'RESEARCH_PROVIDER_COOLDOWN');assert.ok(denied.nextCheckAt);}
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE instrument_id='xyz_nyse'")).rows[0].n,0);
}));

test('SQL demand rejects a canonically hashed current WSH projection differing from its original publication', {skip:!connection},()=>isolated(45,async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false}),current=(await f.store.latestSnapshot(f.identity))!,snapshot=structuredClone(current.snapshot);
 snapshot.coverage.find(c=>c.sourceId===f.wshSource.id)!.reason='RESEARCH_WSH_ALTERED_PROJECTION';
 const id=randomUUID(),sequence=current.sequence+1;
 await pool.query('INSERT INTO research_snapshots(id,snapshot_hash,config_hash,manifest_hash,instrument_id,sequence,canonical_json) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,researchHash(snapshot),f.identity.configHash,f.identity.manifestHash,f.identity.instrumentId,sequence,canonicalJson(snapshot)]);
 await pool.query('UPDATE research_snapshot_heads SET snapshot_id=$4,sequence=$5 WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3',[f.identity.configHash,f.identity.manifestHash,f.identity.instrumentId,id,sequence]);
 const demand=(await pool.query('SELECT * FROM research_source_demand($1,$2,$3,$4,$5,clock_timestamp())',[f.accountId,f.identity.configHash,f.identity.manifestHash,f.identity.instrumentId,f.wshSource.id])).rows[0];
 assert.equal(demand.state,'HOLD');assert.equal(demand.reason,'RESEARCH_SOURCE_PROVENANCE_INVALID');
 assert.equal((await pool.query('SELECT snapshot_hash FROM research_snapshots WHERE id=$1',[current.id])).rows[0].snapshot_hash,current.hash);
}));

for(const failure of [
 {failureClass:'BUSY' as const,failureReason:'RESEARCH_WSH_ERROR_10281',providerError:{code:999,message:'different provider failure'}},
 {failureClass:'TRANSIENT' as const,failureReason:'RESEARCH_WSH_IDENTITY_INVALID'},
 {failureClass:'ABORTED' as const,failureReason:'RESEARCH_WSH_ACCOUNT_INVALID'},
])test(`SQL demand refuses unsupported ${failure.failureClass} WSH failure proof`, {skip:!connection},()=>isolated(45,async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,publishWsh:false}),identity={...f.identity,sourceId:f.wshSource.id};
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{
  const claimed=await f.store.claimWshAttempt(lease,{...identity,sessionId:randomUUID()},'regular');assert.equal(claimed.state,'CLAIMED');if(claimed.state!=='CLAIMED')return;
  await f.store.confirmWshPreflight(lease,claimed.ticket);
  const stamp=new Date(await f.clock()).toISOString(),snapshot=f.empty(stamp);
  snapshot.coverage.push({sourceId:identity.sourceId,role:'calendar',status:'ERROR',complete:false,evidenceRefs:[],checkedAt:stamp,windowStart:stamp,windowEnd:stamp,reason:failure.failureReason});
  await f.store.finishWshAttempt(lease,claimed.ticket,{outcome:'FAILED',...failure,stage:'connect',snapshot,cleanup:{sessionId:claimed.ticket.sessionId,state:'NOT_NEEDED',verifiedLocalClosure:false,completedAt:stamp,cancellationAttemptedAt:null,disconnectRequestedAt:null,localClosedAt:null}});
 });
 const demand=(await pool.query('SELECT * FROM research_source_demand($1,$2,$3,$4,$5,clock_timestamp())',[f.accountId,identity.configHash,identity.manifestHash,identity.instrumentId,identity.sourceId])).rows[0];
 assert.equal(demand.state,'HOLD');assert.equal(demand.reason,'RESEARCH_SOURCE_FAILURE_UNPROVED');
}));

test('markerless local usage failure remains held after a proved pooled quota recovery', {skip:!connection},()=>isolated(45,async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false,publishWsh:false});
 const otherPolicies=f.manifest.instruments.filter(p=>p.instrumentId!==f.identity.instrumentId && p.sources.some(s=>s.adapter==='marketaux-news'));
 assert.ok(otherPolicies.length>=2);
 const issuer=(index:number):Fixture=>{const policy=otherPolicies[index],source=policy.sources.find(s=>s.adapter==='marketaux-news')!;return {...f,policy,source,identity:{...f.identity,instrumentId:policy.instrumentId,sourceId:source.id},empty:stamp=>({...f.empty(stamp),instrumentId:policy.instrumentId,mappingHash:researchHash(policy)})};};
 await f.store.prepareRepair(f.identity);const own=await f.store.claimMarketauxAttempt(f.identity,'demand');assert.ok(own.claimed);if(!own.claimed)return;
 const quota=await failedNews(issuer(0),402);await quota.finish();
 assert.equal((await pool.query('SELECT research_marketaux_usage_hold($1) held',[f.accountId])).rows[0].held,true);
 await failedNews(issuer(1));
 assert.equal((await pool.query('SELECT research_marketaux_usage_hold($1) held',[f.accountId])).rows[0].held,false);
 const reason='RESEARCH_PROVIDER_USAGE_HOLD';
 await f.store.finishMarketauxFailure(own.ticket,{reason,outcome:'FAILED'},stamp=>{
  const snapshot=f.empty(stamp);snapshot.coverage.push({sourceId:f.source.id,role:'news',status:'ERROR',complete:false,evidenceRefs:[],checkedAt:stamp,windowStart:own.ticket.windowStart,windowEnd:own.ticket.asOf,reason});return snapshot;
 });
 assert.equal((await pool.query('SELECT provider_refusal,research_source_failure_retryable(id,false) retryable FROM research_marketaux_attempts WHERE id=$1',[own.ticket.attemptId])).rows[0].retryable,false);
 await advance(31000);await f.observe();
 const prep=await f.store.prepareRepair(f.identity),demand=prep.sources.find(s=>s.sourceId===f.source.id)!.acquisition!;
 assert.equal(demand.state,'HOLD');assert.equal(demand.reason,'RESEARCH_SOURCE_FAILURE_UNPROVED');
 assert.equal((await f.store.claimMarketauxAttempt(f.identity,'demand')).claimed,false);
}));
