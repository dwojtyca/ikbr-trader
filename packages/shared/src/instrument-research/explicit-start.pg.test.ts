import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { seedTwoSourceResearchStore } from './research.fixture.js';
import { marketauxCallIdentity } from './marketaux.js';
import { parseWshConfig } from './wsh.js';
const { Pool } = createRequire(new URL('../../../../apps/llm-agent/package.json', import.meta.url))('pg');
const connection=process.env.TEST_POSTGRES_URL;
type Fixture=Awaited<ReturnType<typeof seedTwoSourceResearchStore>>;
async function isolated(run: (pool: any, advance: (ms: number) => Promise<void>) => Promise<void>) {
 const url = new URL(connection!);
 assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && (url.port === '55432'
  || url.port === '55434' && url.pathname === '/ikbr_startup_recovery_test'
  || process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci'), 'Only isolated PostgreSQL allowed');
 url.pathname = '/postgres';
 const admin = new Pool({ connectionString: url.href }), name = 'explicit_start_' + randomUUID().replaceAll('-', '');
 await admin.query(`CREATE DATABASE ${name}`); url.pathname = '/' + name;
 const pool = new Pool({ connectionString: url.href, options: '-c search_path=public,pg_catalog' });
 try {
  await pool.query('CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)');
  await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
  // Keep same-hour scenarios away from wall-clock boundaries without editing source history.
  await pool.query("UPDATE fixture_clock SET offset_ms=extract(epoch FROM (date_trunc('hour',pg_catalog.clock_timestamp())+interval '1 hour 10 minutes'-pg_catalog.clock_timestamp()))*1000");
  const dir = new URL('../../../../infra/sql/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(file, dir), 'utf8'));
  await run(pool, async ms => { await pool.query('UPDATE fixture_clock SET offset_ms=offset_ms+$1', [ms]); });
 } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}

async function start(pool: any, f: Fixture, revision=1) {
 const db=await pool.connect();
 try {
  await db.query('BEGIN');
  if(revision===1)await db.query('INSERT INTO execution_entry_controls(account_id) VALUES($1)',[f.accountId]);
  else await db.query('UPDATE execution_entry_controls SET revision=$2,paused=true WHERE account_id=$1',[f.accountId,revision]);
  await db.query("INSERT INTO execution_entry_control_events(account_id,revision,paused,actor,reason) VALUES($1,$2,true,'fixture',$3)",[f.accountId,revision,'paper-start:'+randomUUID()]);
  const prep=await f.store.prepareStartupRepair(f.identity,revision,db);await db.query('COMMIT');return prep;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
async function prepareAgain(pool:any,f:Fixture,revision=1){
 const db=await pool.connect();try{await db.query('BEGIN');const p=await f.store.prepareStartupRepair(f.identity,revision,db);await db.query('COMMIT');return p;}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
async function refusal(f:Fixture,code=10276,kind:'regular'|'demand'='regular',stage:'metadata'|'events'='metadata') {
 let id='';
 await f.store.withWshEndpointLock(parseWshConfig(f.wshSource,f.policy).endpointId,async lease=>{
  const identity={...f.identity,sourceId:f.wshSource.id,sessionId:randomUUID()};
  const claimed=await f.store.claimWshAttempt(lease,identity,kind);assert.equal(claimed.state,'CLAIMED');if(claimed.state!=='CLAIMED')throw Error(claimed.reason);
  const ticket=claimed.ticket;id=ticket.id;await f.store.confirmWshPreflight(lease,ticket);
  const call={...identity,kind:'source' as const,provider:'ibkr-wsh',callKey:'refusal_'+randomUUID(),requestHash:'a'.repeat(64),reservedCostMicros:0,maxRequestsPerDay:f.wshSource.maxRequestsPerDay,maxCostMicrosPerDay:0,deadlineAt:new Date(await f.clock()+9000).toISOString()};
  const acquisition=await f.store.beginWshAcquisition(lease,{...identity,reservation:call},ticket);
  await f.store.recordCallOutcome(call.callKey,'FAILED');
  const stamp=new Date(await f.clock()).toISOString(),reason=`RESEARCH_WSH_ERROR_${code}`,providerError={code,message:'Fixture provider refusal'};
  const snapshot=f.empty(stamp);snapshot.coverage.push({sourceId:f.wshSource.id,role:'calendar',status:'ERROR',complete:false,checkedAt:stamp,windowStart:stamp,windowEnd:stamp,evidenceRefs:[],reason,providerError});
  await f.store.finishWshAttempt(lease,ticket,{outcome:'FAILED',acquisitionOutcome:'FAILED',acquisition, failureClass:'HARD',failureReason:reason,stage,providerError,snapshot,...(ticket.publicationSlotKey?{slotKey:ticket.publicationSlotKey}:{}),
   cleanup:{sessionId:ticket.sessionId,state:'CONFIRMED',verifiedLocalClosure:true,completedAt:stamp,localClosedAt:stamp,disconnectRequestedAt:stamp,cancellationAttemptedAt:stamp}});
 });return id;
}
for(const code of [10276,10277])test(`explicit start revalidates proved WSH${code} immediately once with unchanged failure history`,{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false}),old=await refusal(f,code);
 const before=(await pool.query('SELECT to_jsonb(a) row FROM research_wsh_refresh_attempts a WHERE id=$1',[old])).rows[0].row;
 assert.equal((await f.store.prepareRepair(f.identity)).sources.find(s=>s.role==='calendar')!.acquisition!.state,'HOLD');
 const preparation=await start(pool,f);const calendar=preparation.sources.find(s=>s.role==='calendar')!;
 assert.equal(calendar.acquisition!.state,'WAITING');assert.equal(calendar.acquisition!.reason,'RESEARCH_SOURCE_DEMAND');
 assert.equal(calendar.acquisition!.startup!.state,'PENDING');
 await prepareAgain(pool,f);const next=await refusal(f,code,'demand');assert.notEqual(next,old);
 const again=await prepareAgain(pool,f);assert.equal(again.sources.find(s=>s.role==='calendar')!.acquisition!.state,'HOLD');
 assert.equal((await pool.query("SELECT state FROM research_startup_source_requests WHERE role='calendar'")).rows[0].state,'CLAIMED');
 assert.deepEqual((await pool.query('SELECT to_jsonb(a) row FROM research_wsh_refresh_attempts a WHERE id=$1',[old])).rows[0].row,before);
 await start(pool,f,2);await refusal(f,code,'demand');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_refresh_attempts')).rows[0].n,3);
}));
test('fresh startup consumes opportunity and cannot spend it after a later refusal',{skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool);await start(pool,f);
 assert.deepEqual((await pool.query('SELECT state FROM research_startup_source_requests')).rows.map((r:any)=>r.state),['FRESH','FRESH']);
 await advance(3601000);await f.observe();await refusal(f);
 const prep=await prepareAgain(pool,f);assert.equal(prep.sources.find(s=>s.role==='calendar')!.acquisition!.state,'HOLD');
}));
test('missing sources one-shot claim is superseded before dispatch without new reservation',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false});await start(pool,f);
 const claimed=await f.store.claimMarketauxAttempt(f.identity,'demand');assert.ok(claimed.claimed);if(!claimed.claimed)return;
 await f.store.assertStartupDispatch(claimed.ticket.attemptId);
 await pool.query('UPDATE execution_entry_controls SET revision=revision+1 WHERE account_id=$1',[f.accountId]);
 await assert.rejects(f.store.assertStartupDispatch(claimed.ticket.attemptId),/RESEARCH_STARTUP_SUPERSEDED/);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n,0);
}));
test('unsupported provider failure stays held and source request identities cannot be rewritten',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await refusal(f,9999);const prep=await start(pool,f);
 assert.equal(prep.sources.find(s=>s.role==='calendar')!.acquisition!.state,'HOLD');
 await assert.rejects(pool.query("UPDATE research_startup_source_requests SET state='FRESH',disposed_at=clock_timestamp() WHERE role='calendar'"),/RESEARCH_STARTUP_DISPOSITION_INVALID/);
 await assert.rejects(pool.query("UPDATE research_startup_source_requests SET predecessor_id=NULL WHERE role='calendar'"),/RESEARCH_STARTUP_HISTORY_IMMUTABLE/);
 await assert.rejects(pool.query('DELETE FROM research_startup_source_requests'),/RESEARCH_STARTUP_HISTORY_IMMUTABLE/);
}));
test('metadata failure cannot be forged into proved events refusal',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});const old=await refusal(f,10276,'regular','events');
 assert.equal((await pool.query('SELECT research_startup_wsh_refusal($1) valid',[old])).rows[0].valid,false);
 const prep=await start(pool,f);assert.equal(prep.sources.find(s=>s.role==='calendar')!.acquisition!.state,'HOLD');
}));
test('a live attempt is joined and repeated startup polling cannot create another allowance',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false});const claimed=await f.store.claimMarketauxAttempt(f.identity);
 assert.ok(claimed.claimed);if(!claimed.claimed)return;
 await start(pool,f);await prepareAgain(pool,f);
 const r=(await pool.query("SELECT * FROM research_startup_source_requests WHERE role='news'")).rows[0];
 assert.equal(r.state,'JOINED');assert.equal(r.attempt_id,claimed.ticket.attemptId);
 assert.equal((await f.store.claimMarketauxAttempt(f.identity,'demand')).claimed,false);
 await assert.rejects(pool.query("UPDATE research_startup_source_requests SET state='PENDING',attempt_id=NULL,disposed_at=NULL WHERE id=$1",[r.id]),/RESEARCH_STARTUP_HISTORY_IMMUTABLE/);
}));
test('regular acquisition after registration consumes startup opportunity and cannot be relinked to older evidence',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false});await start(pool,f);
 const claimed=await f.store.claimMarketauxAttempt(f.identity);assert.ok(claimed.claimed);if(!claimed.claimed)return;
 const row=(await pool.query("SELECT * FROM research_startup_source_requests WHERE role='news'")).rows[0];assert.equal(row.state,'JOINED');
 await f.publishNews(claimed.ticket);assert.equal((await prepareAgain(pool,f)).sources.find(s=>s.role==='news')!.acquisition!.state,'READY');
 assert.equal((await pool.query("SELECT state FROM research_startup_source_requests WHERE id=$1",[row.id])).rows[0].state,'JOINED');
}));
test('concurrent demand claims consume a startup source once',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false});await start(pool,f);
 const results=await Promise.all([f.store.claimMarketauxAttempt(f.identity,'demand'),f.store.claimMarketauxAttempt(f.identity,'demand')]);
 assert.equal(results.filter(r=>r.claimed).length,1);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_startup_source_requests WHERE state='CLAIMED'")).rows[0].n,1);
}));
test('ordinary paused state is not explicit startup authority',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false});await pool.query('INSERT INTO execution_entry_controls(account_id) VALUES($1)',[f.accountId]);
 await pool.query("INSERT INTO execution_entry_control_events(account_id,revision,paused,actor,reason) VALUES($1,1,true,'fixture','operator stop')",[f.accountId]);
 await assert.rejects(prepareAgain(pool,f),/RESEARCH_STARTUP_AUTHORITY_INVALID/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_startup_source_requests')).rows[0].n,0);
}));
test('staged duplicate WSH demand cycles cannot replay consumed startup allowance',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await refusal(f);await start(pool,f);
 const latest=(await pool.query('SELECT c.* FROM research_wsh_refresh_cycles c ORDER BY started_at DESC LIMIT 1')).rows[0];
 const request=(await pool.query("SELECT id FROM research_repair_requests WHERE source_id=$1",[f.wshSource.id])).rows[0].id;
 const one=randomUUID(),two=randomUUID();
 await pool.query(`WITH at AS MATERIALIZED(SELECT date_trunc('milliseconds',clock_timestamp()) stamp)
  INSERT INTO research_wsh_refresh_cycles(id,ledger_key,config_hash,manifest_hash,instrument_id,source_id,account_id,source_policy_hash,started_at,next_regular_at,admission_kind,demand_request_id)
  SELECT x.id,$3,$4,$5,$6,$7,$8,$9,at.stamp,at.stamp+interval '1 hour','DEMAND',$10 FROM at CROSS JOIN (VALUES($1::uuid),($2::uuid)) x(id)`,
 [one,two,latest.ledger_key,latest.config_hash,latest.manifest_hash,latest.instrument_id,latest.source_id,latest.account_id,latest.source_policy_hash,request]);
 const attempt=async(cycle:string)=>pool.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,endpoint_id,session_id,started_at,deadline_at,state)
  SELECT gen_random_uuid(),id,0,$2,$3,started_at,started_at+interval '35 seconds','STARTED' FROM research_wsh_refresh_cycles WHERE id=$1`,[cycle,parseWshConfig(f.wshSource,f.policy).endpointId,randomUUID()]);
 await attempt(one);await assert.rejects(attempt(two),/RESEARCH_SOURCE_DEMAND_DENIED|RESEARCH_WSH_ATTEMPT_ACTIVE/);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_startup_source_requests WHERE state='CLAIMED'")).rows[0].n,1);
}));
for(const status of [401,402,403,429])test(`explicit start retains HTTP${status} provider guard`,{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false});const c=await f.store.claimMarketauxAttempt(f.identity);assert.ok(c.claimed);if(!c.claimed)return;
 const ticket=c.ticket,request={kind:'marketaux-news-v2' as const,attemptId:ticket.attemptId,slot:ticket.slot,sourceUrl:f.source.urls[0],windowStart:ticket.windowStart,asOf:ticket.asOf,pass:1 as const,page:1};
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,request);
 await f.store.reserveMarketauxCall(ticket,request,{...f.identity,...call,provider:f.source.provider,kind:'source',reservedCostMicros:f.source.costMicrosPerCall,maxRequestsPerDay:f.source.maxRequestsPerDay,maxCostMicrosPerDay:f.source.maxCostMicrosPerDay});
 await f.store.recordMarketauxCallOutcome(ticket,call.callKey,{outcome:'FAILED'});
 const reason=`RESEARCH_SOURCE_HTTP_${status}`,sourceError={name:'Error',code:null,message:'fixture provider refusal',httpStatus:status};
 await f.store.finishMarketauxFailure(ticket,{reason,sourceError,outcome:'FAILED',...(status===429?{retryAfterMs:120000}:{})},stamp=>{
  const snap=f.empty(stamp);snap.coverage.push({sourceId:f.source.id,role:'news',status:'ERROR',complete:false,evidenceRefs:[],checkedAt:stamp,windowStart:ticket.windowStart,windowEnd:ticket.asOf,reason,sourceError});return snap;
 });
 const prep=await start(pool,f),acquisition=prep.sources.find(s=>s.role==='news')!.acquisition!;
 if(status===429){assert.equal(acquisition.state,'WAITING');assert.ok(Date.parse(acquisition.nextDemandAt!)>await f.clock()+110000);}else assert.equal(acquisition.state,'HOLD');
 assert.equal((await f.store.claimMarketauxAttempt(f.identity,'demand')).claimed,false);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations WHERE provider='https://api.marketaux.com'")).rows[0].n,1);
}));
test('durable startup demand is discovered after unknown-read recovery without another prepare poll',{skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false}),identity={...f.identity,sourceId:f.wshSource.id};
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{
  const acquisition=await f.store.beginWshAcquisition(lease,{...identity,sessionId:randomUUID(),reservation:{...f.identity,provider:'ibkr-wsh',kind:'source',callKey:'unknown_'+randomUUID(),requestHash:'a'.repeat(64),deadlineAt:new Date(await f.clock()+9000).toISOString(),reservedCostMicros:0,maxRequestsPerDay:f.wshSource.maxRequestsPerDay,maxCostMicrosPerDay:0}});
  await f.store.retireWshAcquisition(lease,acquisition,'UNKNOWN');
 });
 const prep=await start(pool,f);assert.equal(prep.sources.find(s=>s.role==='calendar')!.acquisition!.state,'HOLD');
 assert.equal((await pool.query("SELECT state FROM research_repair_requests WHERE role='calendar'")).rows[0].state,'HOLD');
 assert.equal((await f.store.dueRepairs(f.identity)).some(r=>r.sourceId===f.wshSource.id),false);
 await advance(40000);await f.observe();assert.equal((await f.store.recoverExpiredWshReads(identity)).state,'RECOVERED');
 assert.equal((await pool.query("SELECT state FROM research_repair_requests WHERE role='calendar'")).rows[0].state,'HOLD');
 assert.equal((await f.store.dueRepairs(f.identity)).some(r=>r.sourceId===f.wshSource.id),true);
}));
test('a fresh concurrent legacy WSH publication consumes pending startup at demand admission',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await start(pool,f);await f.publishWsh();
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{
  const claim=await f.store.claimWshAttempt(lease,{...f.identity,sourceId:f.wshSource.id,sessionId:randomUUID()},'demand');assert.equal(claim.state,'DEFERRED');
 });
 assert.equal((await pool.query("SELECT state FROM research_startup_source_requests WHERE role='calendar'")).rows[0].state,'FRESH');
}));
test('another account entitlement refusal cannot override this account unsupported failure',{skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await refusal(f,9999);
 await advance(3601000);await f.observe();
 const foreign={...f,accountId:'DU_OTHER',identity:{...f.identity,accountId:'DU_OTHER'}};
 await refusal(foreign,10276);
 const prep=await start(pool,f);assert.equal(prep.sources.find(s=>s.role==='calendar')!.acquisition!.state,'HOLD');
 assert.equal(prep.sources.find(s=>s.role==='calendar')!.acquisition!.reason,'RESEARCH_SOURCE_FAILURE_UNPROVED');
}));
test('scheduler discovery observes a pending request made fresh without CLI polling',{skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await start(pool,f);await f.publishWsh();
 assert.equal((await pool.query("SELECT state FROM research_startup_source_requests WHERE role='calendar'")).rows[0].state,'PENDING');
 assert.equal((await f.store.dueRepairs(f.identity)).some(r=>r.sourceId===f.wshSource.id),true);
 await f.store.prepareRepair(f.identity);
 assert.equal((await pool.query("SELECT state FROM research_startup_source_requests WHERE role='calendar'")).rows[0].state,'FRESH');
 assert.equal((await f.store.dueRepairs(f.identity)).some(r=>r.sourceId===f.wshSource.id),false);
}));
