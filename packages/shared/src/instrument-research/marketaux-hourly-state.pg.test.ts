import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { seedTwoSourceResearchStore } from './research.fixture.js';
import { marketauxCallIdentity } from './marketaux.js';
import type { MarketauxAttemptTicket } from './marketaux-refresh.js';
import { researchHash } from './validation.js';
const {Pool}=createRequire(new URL('../../../../apps/llm-agent/package.json',import.meta.url))('pg');
const connection=process.env.TEST_POSTGRES_URL;
async function isolated(run:(pool:any,advance:(ms:number)=>Promise<void>)=>Promise<void>) {
 const url=new URL(connection!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && (url.port==='55432' || url.port==='55434' && url.pathname==='/ikbr_startup_recovery_test' || process.env.CI==='true' && url.port==='5432' && url.pathname==='/ikbr_trader_ci'));url.pathname='/postgres';
 const admin=new Pool({connectionString:url.href}),name='marketaux_state_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${name}`);url.pathname='/'+name;
 const pool=new Pool({connectionString:url.href,options:'-c search_path=public,pg_catalog'});
 try {
  // A test-only database clock advances every SQL boundary together; immutable source history is never edited.
  await pool.query('CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)');
  await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
  const dir=new URL('../../../../infra/sql/migrations/',import.meta.url);for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await pool.query(readFileSync(new URL(file,dir),'utf8'));
  await run(pool,async ms=>{await pool.query('UPDATE fixture_clock SET offset_ms=offset_ms+$1',[ms]);});
 } finally {await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
type Fixture=Awaited<ReturnType<typeof seedTwoSourceResearchStore>>;
async function ticket(f:Fixture) {const c=await f.store.claimMarketauxAttempt(f.identity);assert.ok(c.claimed);return c.ticket;}
async function failure(f:Fixture,t:MarketauxAttemptTicket,status:number|'UNKNOWN') {
 const request={kind:'marketaux-news-v2' as const,attemptId:t.attemptId,slot:t.slot,sourceUrl:f.source.urls[0],windowStart:t.windowStart,asOf:t.asOf,pass:1 as const,page:1};
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,request);
 await f.store.reserveMarketauxCall(t,request,{...f.identity,provider:f.source.provider,kind:'source',...call,reservedCostMicros:1,maxRequestsPerDay:f.source.maxRequestsPerDay,maxCostMicrosPerDay:f.source.maxCostMicrosPerDay});
 await f.store.recordMarketauxCallOutcome(t,call.callKey,{outcome:status==='UNKNOWN'?'UNKNOWN':'FAILED'});
 const reason=status==='UNKNOWN'?'RESEARCH_SOURCE_TIMEOUT':`RESEARCH_SOURCE_HTTP_${status}`,sourceError={name:'Error',code:null,message:reason,...(status==='UNKNOWN'?{}:{httpStatus:status})};
 return f.store.finishMarketauxFailure(t,{reason,sourceError,outcome:status==='UNKNOWN'?'UNKNOWN':'FAILED'},stamp=>{
  const s=f.empty(stamp);s.coverage.push({sourceId:f.source.id,role:'news',status:'ERROR',complete:false,evidenceRefs:[],checkedAt:stamp,windowStart:t.windowStart,windowEnd:t.asOf,reason,sourceError});return s;
 });
}

test('real two-source cache is ready; known transient retains original news and source ages', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool);assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
 const before=await f.store.latestSnapshot(f.identity), expiry=(await f.store.readMarketauxRefreshState(f.identity)).expiresAt;
 await advance(3601000);await f.observe();const t=await ticket(f);
 const retained=await failure(f,t,503);assert.equal(retained.retained,true);assert.equal(retained.snapshot?.id,before!.id);
 assert.equal((await f.store.readMarketauxRefreshState(f.identity)).expiresAt,expiry);
 assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
 assert.equal((await f.store.readMarketauxRefreshState(f.identity)).latestFailure?.reason,'RESEARCH_SOURCE_HTTP_503');
 await advance(24*3600000);await f.observe();assert.notEqual((await f.store.prepareRepair(f.identity)).state,'READY');
}));

test('hard and unknown attempts block fresh cache; unknown cannot create fresh success or retry', {skip:!connection},async()=>{
 for(const status of [401,'UNKNOWN'] as const)await isolated(async(pool,advance)=>{
  const f=await seedTwoSourceResearchStore(pool);await advance(3601000);await f.observe();const t=await ticket(f);
  const result=await failure(f,t,status);assert.equal(result.retained,false);
  assert.equal((await f.store.prepareRepair(f.identity)).state,'HOLD');
  assert.deepEqual((await f.store.readMarketauxRefreshState(f.identity)).holdReasons,['RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED']);
  if(status==='UNKNOWN'){assert.equal(result.snapshot,null);await advance(3601000);await f.observe();assert.equal((await f.store.claimMarketauxAttempt(f.identity)).claimed,false);}
 });
});

test('new hourly success merges latest WSH projection', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool),stale=(await f.store.latestSnapshot(f.identity))!.snapshot.coverage.find(c=>c.role==='calendar')!;
 const finalize=f.store.finalizeMarketauxSuccess.bind(f.store);
 f.store.finalizeMarketauxSuccess=(t,build)=>finalize(t,stamp=>{const snapshot=build(stamp);snapshot.coverage.push(structuredClone(stale));return snapshot;});
 await advance(3601000);await f.observe();const t=await ticket(f);
 await f.publishWsh();const calendar=(await f.store.latestSnapshot(f.identity))!.snapshot.coverage.find(c=>c.role==='calendar');
 const next=await f.publishNews(t);assert.deepEqual(next.snapshot.coverage.find(c=>c.role==='calendar'),calendar);
 assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
}));

test('publication and prepare serialize without deadlock or lost head', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool);await advance(3601000);await f.observe();const t=await ticket(f);
 const results=await Promise.all([f.publishNews(t),f.store.prepareRepair(f.identity)]);
 assert.ok(results[0]);assert.ok(['READY','HOLD'].includes(results[1].state));
 assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE state='FINALIZING'")).rows[0].n,0);
}));

test('lost terminal COMMIT reply resolves only from complete immutable committed proof', {skip:!connection},()=>isolated(async pool=>{
 let lose=false;
 const proxy={query:(sql:string,args?:unknown[])=>pool.query(sql,args),connect:async()=>{
  const raw=await pool.connect();let terminal=false;
  return {release:(destroy?:boolean)=>raw.release(destroy),query:async(sql:string,args?:unknown[])=>{
   if(sql.includes("SET state='SUCCEEDED'"))terminal=true;
   const result=await raw.query(sql,args);
   if(sql==='COMMIT'&&terminal&&lose){lose=false;throw new Error('synthetic lost commit reply');}
   return result;
  }};
 }};
 const f=await seedTwoSourceResearchStore(proxy,{publishNews:false});lose=true;
 await assert.rejects(f.publishNews(),/lost commit reply/);
 assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
 const state=await f.store.readMarketauxRefreshState(f.identity);assert.deepEqual(state.holdReasons,[]);
 const row=(await pool.query("SELECT * FROM research_marketaux_attempts WHERE state='SUCCEEDED'")).rows[0];
 assert.equal(state.lastSuccessfulAt,row.finished_at.toISOString());
 assert.equal(researchHash((await f.store.latestSnapshot(f.identity))!.snapshot),(await f.store.latestSnapshot(f.identity))!.hash);
}));

test('denied automation and retention cannot claim or reserve a provider call', {skip:!connection},async()=>{
 for(const [field,value] of [['automation','DENIED'],['automation','UNVERIFIED'],['retention','DENIED'],['retention','UNVERIFIED'],['retention','FULL_DOCUMENT']] as const) await isolated(async pool=>{
  const f=await seedTwoSourceResearchStore(pool,{publishWsh:false,publishNews:false,configureManifest:manifest=>{
   for(const policy of manifest.instruments){const source=policy.sources.find(s=>s.adapter==='marketaux-news')!;source[field]=value as never;}
  }});
  await assert.rejects(f.store.claimMarketauxAttempt(f.identity),/RESEARCH_PERMISSION_UNVERIFIED/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n,0);
 });
});

test('issued ticket identity cannot be overwritten by another issued ticket', {skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishNews:false}),a=await ticket(f);
 const policy=f.manifest.instruments.find(p=>p.instrumentId!==f.policy.instrumentId)!,source=policy.sources.find(s=>s.adapter==='marketaux-news')!;
 const claim=await f.store.claimMarketauxAttempt({...f.identity,instrumentId:policy.instrumentId,sourceId:source.id});assert.ok(claim.claimed);
 Object.assign(claim.ticket,a);
 await assert.rejects(f.store.finishMarketauxFailure(claim.ticket,{reason:'RESEARCH_SOURCE_TIMEOUT',outcome:'UNKNOWN'},f.empty),/RESEARCH_MARKETAUX_TICKET_INVALID/);
 assert.equal((await pool.query("SELECT count(*)::int n FROM research_marketaux_attempts WHERE state='STARTED'")).rows[0].n,2);
}));

test('original-day budget denial retains cache after UTC midnight and rejects fabricated caps', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const initial=Date.parse(String((await pool.query('SELECT clock_timestamp() AS now')).rows[0].now));
 const evening=Date.UTC(new Date(initial).getUTCFullYear(),new Date(initial).getUTCMonth(),new Date(initial).getUTCDate()+1,22,30);
 await advance(evening-initial);
 const f=await seedTwoSourceResearchStore(pool,{configureManifest:manifest=>{for(const p of manifest.instruments)p.sources.find(s=>s.adapter==='marketaux-news')!.maxRequestsPerDay=2;}});
 const original=(await f.store.latestSnapshot(f.identity))!,expires=(await f.store.readMarketauxRefreshState(f.identity)).expiresAt;
 const now=await f.clock(),midnight=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate()+1);
 await advance(midnight-now-1000);await f.observe();const t=await ticket(f);
 await assert.rejects(pool.query(`INSERT INTO research_marketaux_budget_denials(attempt_id,budget_day,recorded_at,requests_used,cost_used,max_requests,max_cost,next_cost)
  VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date,clock_timestamp(),0,0,0,0,0)`,[t.attemptId]),/RESEARCH_MARKETAUX_BUDGET_PROOF_INVALID/);
 const request={kind:'marketaux-news-v2' as const,attemptId:t.attemptId,slot:t.slot,sourceUrl:f.source.urls[0],windowStart:t.windowStart,asOf:t.asOf,pass:1 as const,page:1};
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,request);
 await assert.rejects(f.store.reserveMarketauxCall(t,request,{...f.identity,provider:f.source.provider,kind:'source',...call,reservedCostMicros:1,maxRequestsPerDay:2,maxCostMicrosPerDay:2400}),/RESEARCH_BUDGET_EXHAUSTED/);
 const denial=(await pool.query('SELECT * FROM research_marketaux_budget_denials WHERE attempt_id=$1',[t.attemptId])).rows[0];assert.equal(Number(denial.requests_used),2);
 await advance(2000);await f.observe();
 const result=await f.store.finishMarketauxFailure(t,{reason:'RESEARCH_BUDGET_EXHAUSTED',outcome:'FAILED'},f.empty);
 assert.equal(result.retained,true);assert.equal(result.snapshot?.id,original.id);
 assert.equal((await f.store.readMarketauxRefreshState(f.identity)).expiresAt,expires);
 assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
}));

test('concurrent hard and retained failures preserve the newly published WSH source', {skip:!connection},async()=>{
 for(const status of [401,503])await isolated(async(pool,advance)=>{
  const f=await seedTwoSourceResearchStore(pool),old=(await f.store.latestSnapshot(f.identity))!.snapshot.coverage.find(c=>c.role==='calendar')!;
  await advance(3601000);await f.observe();const t=await ticket(f);
  const results=await Promise.all([failure(f,t,status),f.publishWsh()]);assert.equal(results[0].retained,status===503);
  const latest=(await f.store.latestSnapshot(f.identity))!.snapshot,calendar=latest.coverage.find(c=>c.role==='calendar')!;
  assert.ok(Date.parse(calendar.checkedAt)>Date.parse(old.checkedAt));
  assert.equal(latest.coverage.find(c=>c.role==='news')!.status,status===503?'EMPTY':'ERROR');
  assert.equal((await f.store.prepareRepair(f.identity)).state,status===503?'READY':'HOLD');
 });
});

test('lost retained-failure commit needs complete response proof; missing receipt stays closed', {skip:!connection},()=>isolated(async(pool,advance)=>{
 let lose=false,hide=false;
 const proxy={query:(sql:string,args?:unknown[])=>pool.query(sql,args),connect:async()=>{
  const raw=await pool.connect();let terminal=false;
  return {release:(destroy?:boolean)=>raw.release(destroy),query:async(sql:string,args?:unknown[])=>{
   if(sql.includes("SET state='FAILED'"))terminal=true;
   const result=await raw.query(sql,args);
   if(sql==='COMMIT'&&terminal&&lose){lose=false;throw new Error('synthetic lost retained commit reply');}
   if(hide&&sql.includes('receipt.recorded_at AS receipt_at'))return {...result,rows:result.rows.map((r:any)=>({...r,receipt_at:null}))};
   return result;
  }};
 }};
 const f=await seedTwoSourceResearchStore(proxy);await advance(3601000);await f.observe();const t=await ticket(f);lose=true;
 await assert.rejects(failure(f,t,503),/lost retained commit reply/);
 assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
 hide=true;
 await assert.rejects(f.store.prepareRepair(f.identity),/RESEARCH_MARKETAUX_PROVENANCE_INVALID/);
 hide=false;assert.equal((await f.store.prepareRepair(f.identity)).state,'READY');
}));


test('initial news publication cannot import an unrelated calendar projection', {skip:!connection},()=>isolated(async pool=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false,publishNews:false});
 const finalize=f.store.finalizeMarketauxSuccess.bind(f.store);
 f.store.finalizeMarketauxSuccess=(t,build)=>finalize(t,stamp=>{const snapshot=build(stamp);snapshot.coverage.push(structuredClone(f.snapshot.coverage.find(c=>c.role==='calendar')!));snapshot.events=structuredClone(f.snapshot.events);snapshot.evidence.push(...structuredClone(f.snapshot.evidence));return snapshot;});
 await assert.rejects(f.publishNews(),/RESEARCH_MARKETAUX_SOURCE_PROJECTION_INVALID/);
 assert.equal(await f.store.latestSnapshot(f.identity),null);
 assert.equal((await f.store.prepareRepair(f.identity)).state,'HOLD');
}));
