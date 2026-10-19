import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {ResearchStore} from './store.js';
import {researchHash} from './validation.js';
import {wshResearchFixture} from './research.fixture.js';
import {loadTradingConfiguration} from '../trading-configuration/loader.js';
import {TradingConfigurationStore} from '../trading-configuration/store.js';
import {type WshEndpointLease} from './wsh.js';
import type {WshAttemptResult} from './wsh-refresh.js';
const {Pool}=createRequire(new URL('../../../../apps/llm-agent/package.json',import.meta.url))('pg');
const connection=process.env.TEST_POSTGRES_URL;
async function isolated(run:(pool:any)=>Promise<void>,before34=false){
 const url=new URL(connection!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && (url.port==='55432'||url.port==='55434'&&url.pathname==='/ikbr_startup_recovery_test'||process.env.CI==='true'&&url.port==='5432'&&url.pathname==='/ikbr_trader_ci'),'Only isolated PostgreSQL allowed');url.pathname='/postgres';
 const admin=new Pool({connectionString:url.href}),name='wsh_hourly_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${name}`);url.pathname='/'+name;
 const pool=new Pool({connectionString:url.href});try{const dir=new URL('../../../../infra/sql/migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')&&(!before34||f<'000034')).sort())await pool.query(readFileSync(new URL(f,dir),'utf8'));await run(pool);}finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
async function seed(pool:any,omitNews=false,historicalSchema=false){
 const f=wshResearchFixture();

 f.source.parserConfig.maxAgeMs=86400000;f.snapshot.manifestHash=researchHash(f.manifest);f.snapshot.mappingHash=researchHash(f.policy);
 const store=new ResearchStore(pool),loaded=loadTradingConfiguration({TRADING_CONFIG_MODE:'bundle',TRADING_CONFIG_PATH:'/fixture.json',TRADING_CONFIG_EXPECTED_HASH:f.configHash},{readFile:()=>readFileSync(new URL('../trading-configuration/fixtures/valid-generic.json',import.meta.url),'utf8')});
 await new TradingConfigurationStore(pool).register({service:'execution-engine',processId:randomUUID(),loaded,tradingEnabled:false});
 await store.registerManifest({manifest:f.manifest,configuration:f.config,tradingEnabled:false,adopt:true});
 for(const service of ['execution-engine','llm-agent'] as const)await store.observe({configHash:f.configHash,manifestHash:f.snapshot.manifestHash,service,processId:service,tradingEnabled:false});
 if(omitNews)f.snapshot.coverage=f.snapshot.coverage.filter(c=>c.role!=='news');
 if(historicalSchema){
  // Seed actual pre34 bytes without invoking a current store against an old schema.
  const {canonicalJson}=await import('../trading-configuration/identity.js');
  await pool.query('INSERT INTO research_snapshots(id,snapshot_hash,config_hash,manifest_hash,instrument_id,sequence,canonical_json) VALUES($1,$2,$3,$4,$5,1,$6)',[randomUUID(),researchHash(f.snapshot),f.snapshot.configHash,f.snapshot.manifestHash,f.snapshot.instrumentId,canonicalJson(f.snapshot)]);
 }else await store.storeSnapshot(f.snapshot);
 const identity={configHash:f.configHash,manifestHash:f.snapshot.manifestHash,instrumentId:f.policy.instrumentId,sourceId:f.source.id,accountId:'DU_TEST'};
 let fixtureSessionId='';
 const claim=async(lease:WshEndpointLease,kind:'regular'|'retry'='regular')=>{const result=await store.claimWshAttempt(lease,{...identity,sessionId:randomUUID()},kind);if(result.state==='CLAIMED'){await store.confirmWshPreflight(lease,result.ticket);fixtureSessionId=result.ticket.sessionId;}return result;};
 const failure=(kind:'TRANSIENT'|'HARD'|'UNCERTAIN'='TRANSIENT'):WshAttemptResult=>{const snapshot=structuredClone(f.snapshot),at=new Date().toISOString();snapshot.createdAt=at;snapshot.coverage=snapshot.coverage.filter(c=>c.sourceId!==f.source.id);snapshot.coverage.push({sourceId:f.source.id,role:'calendar',status:'ERROR',complete:false,evidenceRefs:[],checkedAt:at,windowStart:at,windowEnd:at,reason:kind==='TRANSIENT'?'RESEARCH_WSH_TIMEOUT':'RESEARCH_WSH_METADATA_MISMATCH'});return{outcome:'FAILED',failureClass:kind,failureReason:kind==='TRANSIENT'?'RESEARCH_WSH_TIMEOUT':'RESEARCH_WSH_METADATA_MISMATCH',stage:'connect',snapshot,cleanup:{sessionId:fixtureSessionId,state:'NOT_NEEDED',verifiedLocalClosure:false,completedAt:at,cancellationAttemptedAt:null,disconnectRequestedAt:null,localClosedAt:null},sourceError:{name:'Error',code:null,message:'original timeout'}};};
 return{f,store,identity,claim,failure};
}
async function cycle(pool:any,h:Awaited<ReturnType<typeof seed>>,start:Date,interval=900000,overrides:Record<string,unknown>={}){
 const row={id:randomUUID(),ledger:'ibkr-wsh:'+h.f.source.parserConfig.isin,config:h.identity.configHash,manifest:h.identity.manifestHash,instrument:h.identity.instrumentId,source:h.identity.sourceId,account:'DU_TEST',hash:researchHash(h.f.source),start,next:new Date(start.getTime()+interval),...overrides};
 return pool.query(`INSERT INTO research_wsh_refresh_cycles(id,ledger_key,config_hash,manifest_hash,instrument_id,source_id,account_id,source_policy_hash,started_at,next_regular_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,Object.values(row));
}
async function adopt(pool:any,h:Awaited<ReturnType<typeof seed>>,interval:number){
 await pool.query("UPDATE research_observations SET expires_at=statement_timestamp()-interval '1 second',observed_at=statement_timestamp()-interval '31 seconds'");
 h.f.source.parserConfig.refreshIntervalMs=interval;h.f.source.parserConfig.maxAgeMs=86400000;
 h.identity.manifestHash=researchHash(h.f.manifest);h.f.snapshot.manifestHash=h.identity.manifestHash;h.f.snapshot.mappingHash=researchHash(h.f.policy);
 await h.store.registerManifest({manifest:h.f.manifest,configuration:h.f.config,tradingEnabled:false,adopt:true});
 for(const service of ['execution-engine','llm-agent'] as const)await h.store.observe({...h.identity,service,processId:randomUUID(),tradingEnabled:false});
}
test('migration34 preserves pre34 cycles and exact canonical json source bytes/hash', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool,false,true);const start=new Date(Date.now()-120000);await cycle(pool,h,start);
 const cycleId=(await pool.query('SELECT id FROM research_wsh_refresh_cycles')).rows[0].id;
 await pool.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,endpoint_id,session_id,started_at,deadline_at,state) VALUES($1,$2,0,'fixture-endpoint',$3,$4,$5,'STARTED')`,[randomUUID(),cycleId,randomUUID(),start,new Date(start.getTime()+35000)]);
 await legacyAcquisition(pool,h,start);
 const acquisitions=await pool.query('SELECT row_to_json(a) AS row FROM research_wsh_acquisitions a');
 const historical=await pool.query('SELECT row_to_json(a) AS row FROM research_wsh_refresh_attempts a');
 const snapshots=await pool.query('SELECT row_to_json(s) AS row FROM research_snapshots s');
 const before=(await pool.query('SELECT row_to_json(c) AS row FROM research_wsh_refresh_cycles c')).rows;
 await pool.query(readFileSync(new URL('../../../../infra/sql/migrations/000034_wsh_hourly_refresh.sql',import.meta.url),'utf8'));
 assert.deepEqual((await pool.query('SELECT row_to_json(c) AS row FROM research_wsh_refresh_cycles c')).rows,before);
 assert.deepEqual((await pool.query('SELECT row_to_json(a) AS row FROM research_wsh_refresh_attempts a')).rows,historical.rows);
 assert.deepEqual((await pool.query('SELECT row_to_json(a) AS row FROM research_wsh_acquisitions a')).rows,acquisitions.rows);
 assert.deepEqual((await pool.query('SELECT row_to_json(s) AS row FROM research_snapshots s')).rows,snapshots.rows);
 const {canonicalJson}=await import('../trading-configuration/identity.js');
 // Validated text fields exercise exact escaping, nested object order and Unicode.
 h.f.source.parserConfig.entitlement={...(h.f.source.parserConfig.entitlement as any),reference:'ż😀 quote" slash\\ newline\n tab\t'};
 h.f.source.parserConfig.refreshIntervalMs=3600000;h.identity.manifestHash=researchHash(h.f.manifest);
 await pool.query('INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,$3)',[h.identity.manifestHash,h.identity.configHash,canonicalJson(h.f.manifest)]);
 const row=(await pool.query('SELECT * FROM research_wsh_source_policy($1,$2,$3,$4)',[h.identity.configHash,h.identity.manifestHash,h.identity.instrumentId,h.identity.sourceId])).rows[0];
 assert.equal(row.source_bytes,canonicalJson(h.f.source));assert.equal(row.policy_hash,researchHash(h.f.source));assert.equal(row.interval_ms,3600000);
 assert.deepEqual((await pool.query('SELECT row_to_json(c) AS row FROM research_wsh_refresh_cycles c')).rows,before);
},true));
test('direct SQL rejects forged source/ledger/hash, wrong duration and archived authority', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),now=new Date();
 for(const override of [{ledger:'ibkr-wsh:forged'},{hash:'f'.repeat(64)},{source:'missing'},{instrument:'missing'}])await assert.rejects(cycle(pool,h,now,900000,override),/POLICY_IDENTITY/);
 await assert.rejects(cycle(pool,h,now,3600000),/POLICY_IDENTITY/);
 const old={...h.identity};await adopt(pool,h,3600000);
 await assert.rejects(cycle(pool,h,now,900000),/POLICY_IDENTITY/);
 await assert.rejects(cycle(pool,h,now,900000,{manifest:old.manifestHash}),/POLICY_AUTHORITY/);
 await cycle(pool,h,now,3600000);
}));
test('hourly upgrade/downgrade preserves maximum original deadline and requested cadence across accounts', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),start=new Date(Date.now()-20*60000);await cycle(pool,h,start);
 await adopt(pool,h,3600000);const expected=start.getTime()+3600000;
 const state=await new ResearchStore(pool).readWshRefreshState(h.identity,pool);assert.equal(Date.parse(state.nextRegularAt!),expected);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'DEFERRED');if(c.state==='DEFERRED')assert.equal(Date.parse(c.nextCheckAt!),expected);});
 await assert.rejects(cycle(pool,h,new Date(expected-1),3600000,{account:'OTHER'}),/TOO_EARLY/);
 await cycle(pool,h,new Date(expected),3600000,{account:'OTHER'});
 await adopt(pool,h,900000);
 const downgraded=await h.store.readWshRefreshState(h.identity,pool);assert.equal(Date.parse(downgraded.nextRegularAt!),expected+3600000);
 await assert.rejects(cycle(pool,h,new Date(expected+900000)),/TOO_EARLY/);
 await cycle(pool,h,new Date(expected+3600000));
}));
test('legacy untracked acquisition pacing uses original and requested source policy', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),start=new Date(Date.now()-20*60000),ledger='ibkr-wsh:'+h.f.source.parserConfig.isin;
 await pool.query("INSERT INTO research_wsh_endpoints(endpoint_id) VALUES('fixture-endpoint')");
 await pool.query(`INSERT INTO research_wsh_acquisitions(id,endpoint_id,generation,session_id,source_id,instrument_id,ledger_key,config_hash,manifest_hash,started_at,state,retired_at) VALUES($1,'fixture-endpoint',1,$2,$3,$4,$5,$6,$7,$8,'FAILED',$8)`,[randomUUID(),randomUUID(),h.identity.sourceId,h.identity.instrumentId,ledger,h.identity.configHash,h.identity.manifestHash,start]);
 await adopt(pool,h,3600000);
 const state=await h.store.readWshRefreshState(h.identity,pool);assert.equal(Date.parse(state.nextRegularAt!),start.getTime()+3600000);
 await assert.rejects(cycle(pool,h,new Date(start.getTime()+3600000-1),3600000),/TOO_EARLY/);
 await cycle(pool,h,new Date(start.getTime()+3600000),3600000);
}));
test('migration refuses a differently defined legacy constraint without changing it', {skip:!connection},()=>isolated(async pool=>{
 await pool.query('ALTER TABLE research_wsh_refresh_cycles DROP CONSTRAINT research_wsh_refresh_cycles_check');
 await pool.query('ALTER TABLE research_wsh_refresh_cycles ADD CONSTRAINT research_wsh_refresh_cycles_check CHECK(next_regular_at>started_at)');
 await assert.rejects(pool.query(readFileSync(new URL('../../../../infra/sql/migrations/000034_wsh_hourly_refresh.sql',import.meta.url),'utf8')),/LEGACY_CONSTRAINT_MISMATCH/);
 assert.match((await pool.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='research_wsh_refresh_cycles_check'")).rows[0].def,/next_regular_at > started_at/);
},true));
test('SQL second transaction waits for issuer lock and rejects newly committed predecessor', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await adopt(pool,h,3600000);const first=await pool.connect(),second=await pool.connect(),start=new Date();
 try{await first.query('BEGIN');await cycle(first,h,start,3600000);
 let done=false;const waiting=cycle(second,h,new Date(start.getTime()+900000),3600000).then(()=>{done=true;throw Error('unexpected cycle');},(e:Error)=>{done=true;return e;});
 await new Promise(r=>setTimeout(r,50));assert.equal(done,false);await first.query('COMMIT');assert.match(String(await waiting),/TOO_EARLY/);
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_cycles')).rows[0].count,'1');
 }finally{await first.query('ROLLBACK');first.release();second.release();}
}));
test('SQL malformed canonical source cannot forge interval or issuer identity', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);const {canonicalJson}=await import('../trading-configuration/identity.js');
 for(const mutate of [(f:any)=>f.source.parserConfig.refreshIntervalMs='3600000',(f:any)=>f.source.parserConfig.refreshIntervalMs=3600000.5,(f:any)=>f.source.parserConfig.refreshIntervalMs=1800000,(f:any)=>f.source.adapter='sec-json',(f:any)=>f.source.provider='other',(f:any)=>f.source.parserConfig.kind='other',(f:any)=>f.policy.listing.currency='EUR',(f:any)=>f.policy.identifiers=f.policy.identifiers.filter((i:any)=>i.scheme!=='ISIN'),(f:any)=>f.source.parserConfig.conId=99,(f:any)=>f.source.parserConfig.isin='bad',(f:any)=>f.policy.sources.push(structuredClone(f.source)),(f:any)=>f.manifest.instruments.push(structuredClone(f.policy))]){
  const f=wshResearchFixture();mutate(f);const hash=researchHash(f.manifest);
  await pool.query('INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,$3)',[hash,f.configHash,canonicalJson(f.manifest)]);
  await pool.query('UPDATE research_authority SET manifest_hash=$1 WHERE config_hash=$2',[hash,f.configHash]);
  await assert.rejects(cycle(pool,h,new Date(),900000,{manifest:hash,hash:researchHash(f.source)}),/POLICY_IDENTITY/);
 }
}));
test('verified-close cleanup wait and hourly inherited floor agree in claim/read/preparation/due discovery', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;
 const result=h.failure();const at=new Date().toISOString();result.cleanup={sessionId:c.ticket.sessionId,state:'UNKNOWN',verifiedLocalClosure:true,completedAt:at,cancellationAttemptedAt:at,disconnectRequestedAt:at,localClosedAt:at};await h.store.finishWshAttempt(lease,c.ticket,result);});
 const started=(await pool.query('SELECT started_at FROM research_wsh_refresh_cycles')).rows[0].started_at.getTime();
 await adopt(pool,h,3600000);const expected=started+3600000;
 const state=await h.store.readWshRefreshState(h.identity,pool);assert.equal(Date.parse(state.nextRegularAt!),expected);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'DEFERRED');if(c.state==='DEFERRED')assert.equal(Date.parse(c.nextCheckAt!),expected);});
 const prep=await h.store.prepareRepair(h.identity),row=prep.sources.find(r=>r.sourceId===h.identity.sourceId)!;assert.equal(row.state,'HOLD');assert.equal(row.nextCheckAt,null);assert.equal(Date.parse(row.wshRefresh!.nextRegularAt!),expected);
 assert.equal((await h.store.dueWshAttempts(h.identity)).some(r=>r.identity.instrumentId===h.identity.instrumentId),false);
}));
test('hourly retries retain original anchor, two ordinals and no extra regular cycle', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await adopt(pool,h,3600000);let anchor='';
 for(const ordinal of [0,1,2]){
  if(ordinal){await pool.query('ALTER TABLE research_wsh_refresh_attempts DISABLE TRIGGER research_wsh_refresh_attempt_guard');await pool.query("UPDATE research_wsh_refresh_attempts SET retry_due_at=clock_timestamp()-interval '1 second' WHERE retry_due_at IS NOT NULL");await pool.query('ALTER TABLE research_wsh_refresh_attempts ENABLE TRIGGER research_wsh_refresh_attempt_guard');}
  await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease,ordinal?'retry':'regular');assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;
   assert.equal(c.ticket.ordinal,ordinal);if(!ordinal){anchor=c.ticket.nextRegularAt;assert.equal(Date.parse(anchor)-Date.parse(c.ticket.startedAt),3600000);}assert.equal(c.ticket.nextRegularAt,anchor);
   await h.store.finishWshAttempt(lease,c.ticket,h.failure());});
 }
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{assert.equal((await h.claim(lease,'retry')).state,'DEFERRED');assert.equal((await h.claim(lease)).state,'DEFERRED');});
 assert.equal((await h.store.readWshRefreshState(h.identity,pool)).nextRegularAt,anchor);
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_cycles')).rows[0].count,'1');
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_attempts')).rows[0].count,'3');
}));
test('no-ticket compatibility cannot bypass hourly pacing or charge a rejected call', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await adopt(pool,h,3600000);await cycle(pool,h,new Date(Date.now()-20*60000),3600000);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>assert.rejects(h.store.beginWshAcquisition(lease,{...h.identity,sessionId:randomUUID(),reservation:{...h.identity,provider:'ibkr-wsh',kind:'source',callKey:'rejected',requestHash:'a'.repeat(64),deadlineAt:new Date(Date.now()+9000).toISOString(),reservedCostMicros:0,maxRequestsPerDay:100,maxCostMicrosPerDay:0}}),/SLOT_TOO_EARLY/));
 assert.equal((await pool.query('SELECT count(*) FROM research_call_reservations')).rows[0].count,'0');
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_acquisitions')).rows[0].count,'0');
}));
async function legacyAcquisition(pool:any,h:Awaited<ReturnType<typeof seed>>,start:Date,manifest=h.identity.manifestHash){
 const id=randomUUID();await pool.query("INSERT INTO research_wsh_endpoints(endpoint_id) VALUES('fixture-endpoint') ON CONFLICT DO NOTHING");
 await pool.query(`INSERT INTO research_wsh_acquisitions(id,endpoint_id,generation,session_id,source_id,instrument_id,ledger_key,config_hash,manifest_hash,started_at,state,retired_at) VALUES($1,'fixture-endpoint',(SELECT coalesce(max(generation),0)+1 FROM research_wsh_acquisitions WHERE endpoint_id='fixture-endpoint'),$2,$3,$4,$5,$6,$7,$8,'FAILED',$8)`,[id,randomUUID(),h.identity.sourceId,h.identity.instrumentId,'ibkr-wsh:'+h.f.source.parserConfig.isin,h.identity.configHash,manifest,start]);return id;
}
test('older untracked hourly predecessor survives newer15m row and expired historical qualification', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),{canonicalJson}=await import('../trading-configuration/identity.js');
 const original=structuredClone(h.f.manifest),source=original.instruments.find(p=>p.instrumentId===h.identity.instrumentId)!.sources.find(s=>s.id===h.identity.sourceId)!;
 source.parserConfig.refreshIntervalMs=3600000;source.parserConfig.qualification={...(source.parserConfig.qualification as any),validFrom:new Date(Date.now()-86400000).toISOString(),expiresAt:new Date(Date.now()-3600000).toISOString()};
 const hash=researchHash(original);await pool.query('INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,$3)',[hash,h.identity.configHash,canonicalJson(original)]);
 const older=new Date(Date.now()-40*60000);await legacyAcquisition(pool,h,older,hash);await legacyAcquisition(pool,h,new Date(Date.now()-20*60000));
 const state=await h.store.readWshRefreshState(h.identity,pool);assert.equal(Date.parse(state.nextRegularAt!),older.getTime()+3600000);
 await assert.rejects(cycle(pool,h,new Date(older.getTime()+3600000-1)),/TOO_EARLY/);
 await cycle(pool,h,new Date(older.getTime()+3600000));
}));
test('invalid restrictive historical source blocks read and admission rather than guessing interval', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),{canonicalJson}=await import('../trading-configuration/identity.js');const malformed=structuredClone(h.f.manifest);
 malformed.instruments.find(p=>p.instrumentId===h.identity.instrumentId)!.sources.find(s=>s.id===h.identity.sourceId)!.parserConfig.conId=999;
 const hash=researchHash(malformed);await pool.query('INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,$3)',[hash,h.identity.configHash,canonicalJson(malformed)]);
 await legacyAcquisition(pool,h,new Date(Date.now()-60000),hash);
 await assert.rejects(h.store.readWshRefreshState(h.identity,pool),/POLICY_IDENTITY/);await assert.rejects(cycle(pool,h,new Date()),/POLICY_IDENTITY/);
}));
test('linked acquisition cannot move its durable hourly cycle anchor', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await adopt(pool,h,3600000);const start=new Date(Date.now()-40*60000);await cycle(pool,h,start,3600000);
 const acquisition=await legacyAcquisition(pool,h,new Date(Date.now()-60000)),c=(await pool.query('SELECT id FROM research_wsh_refresh_cycles')).rows[0];
 const attempt=randomUUID();await pool.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,endpoint_id,session_id,started_at,deadline_at,state) VALUES($1,$2,0,'fixture-endpoint',$3,$4,$5,'STARTED')`,[attempt,c.id,randomUUID(),start,new Date(start.getTime()+35000)]);
 await pool.query('UPDATE research_wsh_refresh_attempts SET preflight_complete=true,acquisition_id=$2 WHERE id=$1',[attempt,acquisition]);
 const row=(await pool.query('SELECT research_wsh_regular_not_before($1,3600000,clock_timestamp()) AS due',['ibkr-wsh:'+h.f.source.parserConfig.isin])).rows[0];assert.equal(row.due.getTime(),start.getTime()+3600000);
}));
