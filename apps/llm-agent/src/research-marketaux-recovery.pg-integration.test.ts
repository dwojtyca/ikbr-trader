import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { ResearchStore, marketauxCallIdentity, marketauxWindow, researchHash, researchRefreshSlotKey } from '@ikbr/shared/instrument-research';
import { TradingConfigurationStore,loadTradingConfiguration } from '@ikbr/shared/trading-config';
import {marketauxFixture,marketauxResponse} from './research-marketaux.testfixture.js';
import {ResearchRefreshScheduler} from './research-refresh.js';
const connection=process.env.TEST_POSTGRES_URL;
async function isolated(mode:string,run:(v:Awaited<ReturnType<typeof seed>>)=>Promise<void>){
 const name=`marketaux_recovery_${randomUUID().replaceAll('-','')}`,url=new URL(connection!);url.pathname='/postgres';
 const admin=new Pool({connectionString:url.toString()});await admin.query(`CREATE DATABASE ${name}`);url.pathname=`/${name}`;
 const pool=new Pool({connectionString:url.toString()});
 try{const dir=new URL('../../../infra/sql/migrations/',import.meta.url);for(const file of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await pool.query(readFileSync(new URL(file,dir),'utf8'));await run(await seed(pool,mode));}
 finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
async function seed(pool:Pool,mode:string){
 const now=(await pool.query('SELECT clock_timestamp() now')).rows[0].now.getTime(),f=marketauxFixture(now);
 const loaded=loadTradingConfiguration({TRADING_CONFIG_MODE:'bundle',TRADING_CONFIG_PATH:'/fixture.json',TRADING_CONFIG_EXPECTED_HASH:f.configHash},{readFile:()=>readFileSync(new URL('../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json',import.meta.url),'utf8')});
 await new TradingConfigurationStore(pool).register({service:'execution-engine',processId:randomUUID(),loaded,tradingEnabled:false});
 const store=new ResearchStore(pool);await store.registerManifest({manifest:f.manifest,configuration:f.config,tradingEnabled:false,adopt:true});
 for(const service of ['execution-engine','llm-agent'] as const)await store.observe({configHash:f.configHash,manifestHash:f.manifestHash,service,processId:service,tradingEnabled:false});
 const identity={accountId:'DU_TEST',configHash:f.configHash,manifestHash:f.manifestHash,instrumentId:f.policy.instrumentId};
 const slot=Math.floor(now/900000)-1,window=marketauxWindow(slot),reservedAt=slot*900000+1000,deadline=reservedAt+10000;
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,{sourceUrl:f.source.urls[0],...window,pass:1,page:1});
 await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
 VALUES($1,'DU_TEST',$2,'source',$3,$4,$5,1,$6,$7,($6::timestamptz AT TIME ZONE 'UTC')::date)`,[call.callKey,f.source.provider,f.configHash,f.manifestHash,mode==='hash'?'f'.repeat(64):call.requestHash,new Date(reservedAt),new Date(deadline)]);
 if(mode!=='missing')await pool.query('INSERT INTO research_call_outcomes(call_key,outcome,recorded_at) VALUES($1,$2,$3)',[call.callKey,mode==='success'?'SUCCEEDED':'UNKNOWN',new Date(mode==='early'?deadline-1:deadline+1)]);
 const negative=structuredClone(f.snapshot);negative.coverage.push({sourceId:f.source.id,role:'news',status:'ERROR',checkedAt:window.asOf,windowStart:window.windowStart,windowEnd:window.asOf,complete:false,evidenceRefs:[],reason:'RESEARCH_MARKETAUX_ACQUISITION_FAILED',...(mode==='new'?{sourceError:{name:'Error',code:'CERT_HAS_EXPIRED',message:'certificate expired'}}:{})});
 const slotKey=researchRefreshSlotKey(f.manifestHash,f.policy.instrumentId,f.source.id,'news',slot);
 await store.storeSnapshot(negative,mode==='no-slot'?undefined:slotKey);
 if(mode==='copied'){const copied=structuredClone(negative);copied.createdAt=new Date(now+1).toISOString();await store.storeSnapshot(copied);}
 await pool.query(`INSERT INTO research_repair_requests(account_id,config_hash,manifest_hash,instrument_id,source_id,role,state,reasons,next_check_at)
 VALUES('DU_TEST',$1,$2,$3,$4,'news','HOLD',$5::jsonb,NULL)`,[f.configHash,f.manifestHash,f.policy.instrumentId,f.source.id,JSON.stringify(['RESEARCH_MARKETAUX_ACQUISITION_FAILED','RESEARCH_NEWS_ERROR'])]);
 return{f,store,pool,identity,call};
}
for(const mode of ['valid','copied'])test(`legacy terminal UNKNOWN permits fresh demanded slot without rewriting old evidence: ${mode}`,{skip:!connection},()=>isolated(mode,async({f,store,pool,identity,call})=>{
 assert.equal((await store.dueRepairs(identity)).length,1);
 const prepared=await store.prepareRepair(identity);assert.equal(prepared.state,'WAITING',JSON.stringify(prepared));assert.ok(prepared.reasons.includes('RESEARCH_MARKETAUX_LEGACY_FRESH_VERIFICATION'));
 let requests=0;
 const scheduler=new ResearchRefreshScheduler({manifest:f.manifest,manifestHash:f.manifestHash,accountId:identity.accountId,store:new ResearchStore(pool),marketauxOnDemand:true,marketauxApiKey:'fixture',marketauxFetch:async(_source,request)=>{requests++;return marketauxResponse([],request.page,0);}});
 await scheduler.tickRepairs();assert.equal(requests,2);assert.equal((await store.prepareRepair(identity)).state,'READY');
 assert.equal((await pool.query('SELECT outcome FROM research_call_outcomes WHERE call_key=$1',[call.callKey])).rows[0].outcome,'UNKNOWN');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n,3);
 assert.equal((await store.dueRepairs(identity)).length,0);
}));
for(const mode of ['early','missing','hash','success','new','no-slot'])test(`legacy fresh verification requires exact terminal deadline evidence: ${mode}`,{skip:!connection},()=>isolated(mode,async({store,identity})=>{
 assert.equal((await store.prepareRepair(identity)).state,'HOLD');
}));

test('expired current-slot FAILED without matching transient publication cannot become an automatic retry',{skip:!connection},()=>isolated('valid',async({f,store,pool,identity})=>{
 const now=Date.now(),window=marketauxWindow(Math.floor(now/900000)),call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,{sourceUrl:f.source.urls[0],...window,pass:1,page:1});
 await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
 VALUES($1,'DU_TEST',$2,'source',$3,$4,$5,1,$6,$7,($6::timestamptz AT TIME ZONE 'UTC')::date)`,[call.callKey,f.source.provider,f.configHash,f.manifestHash,call.requestHash,new Date(now-5000),new Date(now-1000)]);
 await store.recordCallOutcome(call.callKey,'FAILED');
 const result=await store.prepareRepair(identity);assert.equal(result.state,'HOLD');assert.ok(result.reasons.includes('RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE'));
}));

test('restart at a slot boundary waits for the previous slot outstanding request deadline',{skip:!connection},()=>isolated('valid',async({f,pool,identity})=>{
 const boundary=(Math.floor(Date.now()/900000)+1)*900000, previous=marketauxWindow(Math.floor(boundary/900000)-1);
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,{sourceUrl:f.source.urls[0],...previous,pass:1,page:1});
 await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
 VALUES($1,'DU_TEST',$2,'source',$3,$4,$5,1,$6,$7,($6::timestamptz AT TIME ZONE 'UTC')::date)`,[call.callKey,f.source.provider,f.configHash,f.manifestHash,call.requestHash,new Date(boundary-5000),new Date(boundary+5000)]);
 const restarted=new ResearchStore(pool);Object.defineProperty(restarted,'now',{value:async()=>boundary+1000});
 const result=await restarted.prepareRepair(identity);assert.equal(result.state,'WAITING');assert.ok(result.reasons.includes('RESEARCH_WAITING_EXISTING_ACQUISITION'));assert.equal(result.nextCheckAt,new Date(boundary+5000).toISOString());
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n,2);
}));

test('unpublished FAILED remains held across later slots until a newer verified complete acquisition',{skip:!connection},()=>isolated('valid',async({f,store,pool,identity})=>{
 const now=Date.now(),slot=Math.floor(now/900000)-3,window=marketauxWindow(slot),reserved=slot*900000+1000;
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,{sourceUrl:f.source.urls[0],...window,pass:1,page:1});
 await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
 VALUES($1,'DU_TEST',$2,'source',$3,$4,$5,1,$6,$7,($6::timestamptz AT TIME ZONE 'UTC')::date)`,[call.callKey,f.source.provider,f.configHash,f.manifestHash,call.requestHash,new Date(reserved),new Date(reserved+10000)]);
 await pool.query("INSERT INTO research_call_outcomes(call_key,outcome,recorded_at) VALUES($1,'FAILED',$2)",[call.callKey,new Date(reserved+1)]);
 assert.equal((await new ResearchStore(pool).prepareRepair(identity)).state,'HOLD');
 const shim=Object.create(store) as ResearchStore;
 shim.hasRefreshSlot=async key=> ['reports','calendar'].some(role=>key===researchRefreshSlotKey(f.manifestHash,f.policy.instrumentId,'official',role as 'reports'|'calendar',Math.floor(now/(role==='reports'?86400000:86400000)))) || store.hasRefreshSlot(key);
 const scheduler=new ResearchRefreshScheduler({manifest:f.manifest,manifestHash:f.manifestHash,accountId:identity.accountId,store:shim,marketauxApiKey:'fixture',marketauxFetch:async(_source,request)=>marketauxResponse([],request.page,0)});
 await scheduler.tick();assert.equal((await store.prepareRepair(identity)).state,'READY');
 const restarted=new ResearchStore(pool);Object.defineProperty(restarted,'now',{value:async()=>now+35*60000});
 assert.equal((await restarted.prepareRepair(identity)).state,'WAITING');
 assert.equal((await pool.query('SELECT outcome FROM research_call_outcomes WHERE call_key=$1',[call.callKey])).rows[0].outcome,'FAILED');
}));

test('republishing older complete coverage after a newer FAILED does not clear the durable hold',{skip:!connection},()=>isolated('valid',async({f,store,pool,identity})=>{
 const now=Date.now(),shim=Object.create(store) as ResearchStore;
 shim.hasRefreshSlot=async key=>['reports','calendar'].some(role=>key===researchRefreshSlotKey(f.manifestHash,f.policy.instrumentId,'official',role as 'reports'|'calendar',Math.floor(now/86400000)))||store.hasRefreshSlot(key);
 await new ResearchRefreshScheduler({manifest:f.manifest,manifestHash:f.manifestHash,accountId:identity.accountId,store:shim,marketauxApiKey:'fixture',marketauxFetch:async(_source,request)=>marketauxResponse([],request.page,0)}).tick();
 assert.equal((await store.prepareRepair(identity)).state,'READY');
 const complete=(await store.latestSnapshot(identity))!.snapshot;
 const slot=Math.floor(now/900000)-3,window=marketauxWindow(slot),reserved=slot*900000+1000;
 const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,{sourceUrl:f.source.urls[0],...window,pass:1,page:1});
 await pool.query(`INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day)
 VALUES($1,'DU_TEST',$2,'source',$3,$4,$5,1,$6,$7,($6::timestamptz AT TIME ZONE 'UTC')::date)`,[call.callKey,f.source.provider,f.configHash,f.manifestHash,call.requestHash,new Date(reserved),new Date(reserved+10000)]);
 await store.recordCallOutcome(call.callKey,'FAILED');
 const copied=structuredClone(complete);copied.createdAt=new Date(Date.now()+1).toISOString();await store.storeSnapshot(copied);
 const restarted=new ResearchStore(pool);Object.defineProperty(restarted,'now',{value:async()=>now+35*60000});
 const result=await restarted.prepareRepair(identity);assert.equal(result.state,'HOLD');assert.ok(result.reasons.includes('RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE'));
 assert.equal((await pool.query('SELECT outcome FROM research_call_outcomes WHERE call_key=$1',[call.callKey])).rows[0].outcome,'FAILED');
}));
