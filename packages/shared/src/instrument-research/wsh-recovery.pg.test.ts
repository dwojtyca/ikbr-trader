import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {ResearchStore} from './store.js';
import {inspectResearch} from './repair.js';
import {researchHash} from './validation.js';
import {wshResearchFixture} from './research.fixture.js';
import {loadTradingConfiguration} from '../trading-configuration/loader.js';
import {TradingConfigurationStore} from '../trading-configuration/store.js';
import {buildStrategyAttribution} from '../trading-config.js';
import {parseWshConfig,wshRequestDates,wshReceiptPolicy,type WshEndpointLease} from './wsh.js';
import type {WshAttemptResult,WshAttemptTicket} from './wsh-refresh.js';
const {Pool}=createRequire(new URL('../../../../apps/llm-agent/package.json',import.meta.url))('pg');
const connection=process.env.TEST_POSTGRES_URL;
async function isolated(run:(pool:any)=>Promise<void>){
 const url=new URL(connection!);assert.ok(['127.0.0.1','localhost'].includes(url.hostname) && (url.port==='55432'||url.port==='55434'&&url.pathname==='/ikbr_startup_recovery_test'||url.port==='55438'&&url.pathname==='/ikbr_owner_recovery_test'||process.env.CI==='true'&&url.port==='5432'&&url.pathname==='/ikbr_trader_ci'),'Only isolated PostgreSQL allowed');url.pathname='/postgres';
 const admin=new Pool({connectionString:url.href}),name='wsh_recovery_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE ${name}`);url.pathname='/'+name;
 const pool=new Pool({connectionString:url.href});try{const dir=new URL('../../../../infra/sql/migrations/',import.meta.url);for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())await pool.query(readFileSync(new URL(f,dir),'utf8'));await run(pool);}finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
}
async function seed(pool:any,omitNews=false,ongoing=false){
 const f=wshResearchFixture();
 if(ongoing){f.source.parserConfig.refreshIntervalMs=3600000;for(const name of ['qualification','entitlement'])Object.assign(f.source.parserConfig[name] as object,{expiresAt:null,validity:{mode:'OPERATOR_CONFIRMED_ONGOING',confirmedAt:new Date(Date.now()-10000).toISOString(),confirmationRef:'owner-confirmation-fixture',confirmationHash:'e'.repeat(64)}});}

 f.source.parserConfig.maxAgeMs=86400000;f.snapshot.manifestHash=researchHash(f.manifest);f.snapshot.mappingHash=researchHash(f.policy);
 const store=new ResearchStore(pool),loaded=loadTradingConfiguration({TRADING_CONFIG_MODE:'bundle',TRADING_CONFIG_PATH:'/fixture.json',TRADING_CONFIG_EXPECTED_HASH:f.configHash},{readFile:()=>readFileSync(new URL('../trading-configuration/fixtures/valid-generic.json',import.meta.url),'utf8')});
 await new TradingConfigurationStore(pool).register({service:'execution-engine',processId:randomUUID(),loaded,tradingEnabled:false});
 await store.registerManifest({manifest:f.manifest,configuration:f.config,tradingEnabled:false,adopt:true});
 for(const service of ['execution-engine','llm-agent'] as const)await store.observe({configHash:f.configHash,manifestHash:f.snapshot.manifestHash,service,processId:service,tradingEnabled:false});
 if(omitNews)f.snapshot.coverage=f.snapshot.coverage.filter(c=>c.role!=='news');
 await store.storeSnapshot(f.snapshot);
 const identity={configHash:f.configHash,manifestHash:f.snapshot.manifestHash,instrumentId:f.policy.instrumentId,sourceId:f.source.id,accountId:'DU_TEST'};
 let fixtureSessionId='';
 const claim=async(lease:WshEndpointLease,kind:'regular'|'retry'='regular')=>{const result=await store.claimWshAttempt(lease,{...identity,sessionId:randomUUID()},kind);if(result.state==='CLAIMED'){await store.confirmWshPreflight(lease,result.ticket);fixtureSessionId=result.ticket.sessionId;}return result;};
 const failure=(kind:'TRANSIENT'|'HARD'|'UNCERTAIN'='TRANSIENT'):WshAttemptResult=>{const snapshot=structuredClone(f.snapshot),at=new Date().toISOString();snapshot.createdAt=at;snapshot.coverage=snapshot.coverage.filter(c=>c.sourceId!==f.source.id);snapshot.coverage.push({sourceId:f.source.id,role:'calendar',status:'ERROR',complete:false,evidenceRefs:[],checkedAt:at,windowStart:at,windowEnd:at,reason:kind==='TRANSIENT'?'RESEARCH_WSH_TIMEOUT':'RESEARCH_WSH_METADATA_MISMATCH'});return{outcome:'FAILED',failureClass:kind,failureReason:kind==='TRANSIENT'?'RESEARCH_WSH_TIMEOUT':'RESEARCH_WSH_METADATA_MISMATCH',stage:'connect',snapshot,cleanup:{sessionId:fixtureSessionId,state:'NOT_NEEDED',verifiedLocalClosure:false,completedAt:at,cancellationAttemptedAt:null,disconnectRequestedAt:null,localClosedAt:null},sourceError:{name:'Error',code:null,message:'original timeout'}};};
 return{f,store,identity,claim,failure};
}
test('durable pre-connect failure counts once; restart cannot bypass delay and diagnostic survives STARTED', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);let ticket!:WshAttemptTicket;
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;ticket=c.ticket;const result=h.failure();await h.store.finishWshAttempt(lease,ticket,result);const stored=await h.store.readWshAttempt(ticket);assert.equal(stored?.terminalResultHash,researchHash(result));assert.equal((await h.claim(lease,'retry')).state,'DEFERRED');assert.equal((await h.claim(lease)).state,'DEFERRED');});
 const restarted=new ResearchStore(pool),state=await restarted.readWshRefreshState(h.identity,pool);assert.equal(state.latestFailure?.failureReason,'RESEARCH_WSH_TIMEOUT');assert.ok(state.nextRetryAt);assert.equal(state.blocksCachedEvidence,false);
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_attempts')).rows[0].count,'1');assert.equal((await pool.query('SELECT count(*) FROM research_call_reservations')).rows[0].count,'0');
 const prep=await restarted.prepareRepair(h.identity);assert.equal(prep.sources.find(r=>r.sourceId==='wsh')?.state,'WAITING');assert.equal(prep.sources.find(r=>r.sourceId==='wsh')?.sourceError?.message,'original timeout');assert.equal(prep.sources.find(r=>r.sourceId==='wsh')?.failureReason,'RESEARCH_WSH_TIMEOUT');
 await assert.rejects(pool.query("UPDATE research_wsh_refresh_attempts SET failure_reason='changed' WHERE id=$1",[ticket.id]),/IMMUTABLE/);
}));
test('global issuer excludes concurrent endpoint attempts and unknown retirement alone keeps HOLD', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);let ticket!:WshAttemptTicket;
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'CLAIMED');if(c.state==='CLAIMED')ticket=c.ticket;});
 await pool.query('ALTER TABLE research_wsh_refresh_attempts DISABLE TRIGGER research_wsh_refresh_attempt_guard');await pool.query("UPDATE research_wsh_refresh_attempts SET endpoint_id='other-owned-endpoint' WHERE id=$1",[ticket.id]);await pool.query('ALTER TABLE research_wsh_refresh_attempts ENABLE TRIGGER research_wsh_refresh_attempt_guard');
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>assert.equal((await h.claim(lease)).state,'DEFERRED'));
 // Fixture ages an unfinished attempt; production identities remain immutable.
 await pool.query('ALTER TABLE research_wsh_refresh_attempts DISABLE TRIGGER research_wsh_refresh_attempt_guard');
 await pool.query("UPDATE research_wsh_refresh_attempts SET started_at=statement_timestamp()-interval '40 seconds',deadline_at=statement_timestamp()-interval '5 seconds' WHERE id=$1",[ticket.id]);
 await pool.query('ALTER TABLE research_wsh_refresh_attempts ENABLE TRIGGER research_wsh_refresh_attempt_guard');
 await assert.rejects(h.store.readWshRefreshState(h.identity,pool),/RESEARCH_WSH_READ_RECOVERY_IDENTITY_INVALID/);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>assert.equal((await h.claim(lease)).state,'DEFERRED'));
 const row=(await pool.query('SELECT state,failure_class FROM research_wsh_refresh_attempts WHERE id=$1',[ticket.id])).rows[0];assert.equal(row.state,'UNKNOWN');assert.equal(row.failure_class,'UNCERTAIN');
 await assert.rejects(h.store.readWshRefreshState(h.identity,pool),/RESEARCH_WSH_READ_RECOVERY_IDENTITY_INVALID/);
}));
async function published(pool:any,h:Awaited<ReturnType<typeof seed>>,unknownClosure?:boolean,beforePublish?:(snapshot:any,lease:WshEndpointLease,acquisition:any)=>Promise<void>){
 let result:any;
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const claim=unknownClosure===undefined?null:await h.claim(lease);const ticket=claim?.state==='CLAIMED'?claim.ticket:undefined;
  const deadline=()=>new Date(Date.now()+9000).toISOString(),sessionId=ticket?.sessionId??randomUUID(),base={...h.identity,provider:'ibkr-wsh',kind:'source' as const,reservedCostMicros:0,maxRequestsPerDay:100,maxCostMicrosPerDay:0};
  const meta={...base,callKey:'meta_'+randomUUID(),requestHash:'a'.repeat(64),deadlineAt:deadline()};
  const acq=await h.store.beginWshAcquisition(lease,{...h.identity,sessionId,reservation:meta},ticket);await h.store.recordCallOutcome(meta.callKey,'SUCCEEDED');
  const now=new Date().toISOString(),config=parseWshConfig(h.f.source,h.f.policy),dates=wshRequestDates(config,now),requestHash=researchHash({endpointId:config.endpointId,sessionId,requestId:2,method:'reqWshEventData',request:{conId:config.conId,filter:'',fillWatchlist:false,fillPortfolio:false,fillCompetitors:false,...dates,totalLimit:100}});
  const call={...base,callKey:'events_'+randomUUID(),requestHash,deadlineAt:deadline()};await h.store.reserveWshCall(lease,acq,call);
  const s=structuredClone(h.f.snapshot);s.createdAt=now;s.coverage=s.coverage.filter(c=>c.sourceId!==h.f.source.id);
  s.coverage.push({sourceId:h.f.source.id,role:'calendar',status:'EMPTY',complete:true,checkedAt:now,windowStart:now,windowEnd:now,evidenceRefs:[],reason:'RESEARCH_WSH_PROVIDER_QUERY_COMPLETE',wshAcquisition:{...wshReceiptPolicy(config),coverageBasis:'PROVIDER_REPORTED_QUERY',acquisitionId:acq.id,generation:acq.generation,sessionId,requestId:2,requestAsOf:now,requestStartDate:dates.startDate,requestEndDate:dates.endDate,totalLimit:100,rowCount:0,duplicateCount:0,requestHash,receiptHash:'e'.repeat(64),metadataHash:config.qualification.metadataHash}});
  if(beforePublish)await beforePublish(s,lease,acq);
  result=await h.store.publishWshSnapshot(lease,acq,s);
  if(ticket){const at=new Date().toISOString();await h.store.finishWshAttempt(lease,ticket,{outcome:'SUCCEEDED',acquisition:acq,cleanup:{sessionId:ticket.sessionId,state:'UNKNOWN',verifiedLocalClosure:unknownClosure!,completedAt:at,cancellationAttemptedAt:at,disconnectRequestedAt:at,localClosedAt:unknownClosure?at:null}});}
  await pool.query("UPDATE research_wsh_acquisitions SET started_at=clock_timestamp()-$2::interval WHERE id=$1",[acq.id,`${config.refreshIntervalMs+60000} milliseconds`]);
 });return result;
}
test('real published EMPTY success retains exact head after transient; hard failure invalidates and cannot resurrect', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),good=await published(pool,h);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;await h.store.finishWshAttempt(lease,c.ticket,h.failure());});
 assert.deepEqual(await h.store.latestSnapshot(h.identity),good);
 const state=await h.store.readWshRefreshState(h.identity,pool);assert.equal(state.retained,true);assert.equal((await h.store.prepareRepair(h.identity)).sources.find(r=>r.sourceId==='wsh')?.state,'READY');assert.equal(state.lastSuccessfulAt,good.snapshot.coverage.find((c:any)=>c.role==='calendar').checkedAt);
 // Seed next permitted retry's due time as historical test data, without relaxing production admission.
 await pool.query('ALTER TABLE research_wsh_refresh_attempts DISABLE TRIGGER research_wsh_refresh_attempt_guard');await pool.query("UPDATE research_wsh_refresh_attempts SET retry_due_at=clock_timestamp()-interval '1 second'");await pool.query('ALTER TABLE research_wsh_refresh_attempts ENABLE TRIGGER research_wsh_refresh_attempt_guard');
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease,'retry');assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;assert.equal((await h.store.readWshRefreshState(h.identity,pool)).latestFailure?.failureReason,'RESEARCH_WSH_TIMEOUT');assert.equal((await h.store.prepareRepair(h.identity)).sources.find(r=>r.sourceId==='wsh')?.state,'READY');await h.store.finishWshAttempt(lease,c.ticket,h.failure('HARD'));});
 assert.notEqual((await h.store.latestSnapshot(h.identity))?.id,good.id);assert.equal((await h.store.readWshRefreshState(h.identity,pool)).blocksCachedEvidence,true);
}));
async function dueNow(pool:any){await pool.query('ALTER TABLE research_wsh_refresh_attempts DISABLE TRIGGER research_wsh_refresh_attempt_guard');try{await pool.query("UPDATE research_wsh_refresh_attempts SET retry_due_at=clock_timestamp()-interval '1 second' WHERE retry_due_at IS NOT NULL");}finally{await pool.query('ALTER TABLE research_wsh_refresh_attempts ENABLE TRIGGER research_wsh_refresh_attempt_guard');}}
test('two positive retry ordinals are durable; no fourth attempt, regular cycle reset, or call refund', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);
 for(const ordinal of [0,1,2]){
  if(ordinal)await dueNow(pool);
  await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
   const c=await h.claim(lease,ordinal?'retry':'regular');assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;assert.equal(c.ticket.ordinal,ordinal);
   await h.store.finishWshAttempt(lease,c.ticket,h.failure());
  });
 }
 const restarted=new ResearchStore(pool);await restarted.withWshEndpointLock('fixture-endpoint',async lease=>{assert.equal((await restarted.claimWshAttempt(lease,{...h.identity,sessionId:randomUUID()},'retry')).state,'DEFERRED');assert.equal((await restarted.claimWshAttempt(lease,{...h.identity,sessionId:randomUUID()},'regular')).state,'DEFERRED');});
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_attempts')).rows[0].count,'3');assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_cycles')).rows[0].count,'1');
 const p=await restarted.prepareRepair(h.identity);assert.equal(p.sources.find(s=>s.sourceId==='wsh')?.state,'HOLD');
}));
test('unconfirmed cleanup and10281 never authorize fast retry; original failure remains typed', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;const result=h.failure();result.cleanup.state='UNKNOWN';if(result.outcome==='SUCCEEDED')throw Error('fixture');result.failureClass='BUSY';result.failureReason='RESEARCH_WSH_ERROR_10281';result.providerError={code:10281,message:'original busy text'};await h.store.finishWshAttempt(lease,c.ticket,result);assert.equal((await h.claim(lease,'retry')).state,'DEFERRED');});
 const state=await h.store.readWshRefreshState(h.identity,pool);assert.equal(state.nextRetryAt,null);assert.equal(state.latestFailure?.providerError?.code,10281);
}));
test('lost terminal acknowledgement is verified by exact result hash, never overwritten or replayed', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;const result=h.failure();await h.store.finishWshAttempt(lease,c.ticket,result);assert.equal((await new ResearchStore(pool).readWshAttempt(c.ticket))?.terminalResultHash,researchHash(result));await assert.rejects(h.store.finishWshAttempt(lease,c.ticket,h.failure('HARD')),/IMMUTABLE/);});assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_attempts')).rows[0].count,'1');
}));
test('query-only diagnostic caller never connects or begins transaction; forged ticket rejected', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);let ticket!:WshAttemptTicket;await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);if(c.state!=='CLAIMED')throw Error('claim');ticket=c.ticket;await h.store.finishWshAttempt(lease,c.ticket,h.failure());});
 const readonly={query:(sql:string,params?:unknown[])=>{assert.ok(!/^\s*(BEGIN|COMMIT|UPDATE|INSERT|DELETE|LOCK|SET)/i.test(sql));return pool.query(sql,params);}};
 await h.store.readWshRefreshState(h.identity,readonly);await assert.rejects(h.store.readWshAttempt({...ticket,sessionId:randomUUID()}),/IDENTITY/);
}));

test('SQL global issuer admission serializes an unfinished old cycle against next cycle on another endpoint', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),now=new Date(),oldStart=new Date(now.getTime()-900000),old=randomUUID(),next=randomUUID(),ledger='ibkr-wsh:'+String(h.f.source.parserConfig.isin);
 for(const [id,start] of [[old,oldStart],[next,now]] as const)await pool.query(`INSERT INTO research_wsh_refresh_cycles(id,ledger_key,config_hash,manifest_hash,instrument_id,source_id,account_id,source_policy_hash,started_at,next_regular_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,ledger,h.identity.configHash,h.identity.manifestHash,h.identity.instrumentId,h.identity.sourceId,h.identity.accountId,researchHash(h.f.source),start,new Date(start.getTime()+900000)]);
 const add=async(cycle:string,start:Date,endpoint:string)=>{const db=await pool.connect();try{await db.query('BEGIN');await db.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,endpoint_id,session_id,started_at,deadline_at,state) VALUES($1,$2,0,$3,$4,$5,$6,'STARTED')`,[randomUUID(),cycle,endpoint,randomUUID(),start,new Date(start.getTime()+35000)]);await db.query('COMMIT');return 'claimed';}catch(e){await db.query('ROLLBACK');return (e as Error).message;}finally{db.release();}};
 const results=await Promise.all([add(old,oldStart,'old-endpoint'),add(next,now,'next-endpoint')]);assert.equal(results.filter(r=>r==='claimed').length,1);assert.ok(results.some(r=>r.includes('ATTEMPT_ACTIVE')));
}));

async function bound(pool:any,h:Awaited<ReturnType<typeof seed>>,good:any){
 const hash='b'.repeat(64),listing=h.f.policy.listing;
 const row=(await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,client_order_hash)
 VALUES($1,$2,$3,'BUY','LMT',1,100,99,102,'fixture',1,'PASS',$4) RETURNING id`,[listing.symbol,h.identity.instrumentId,String(listing.conId),hash])).rows[0];
 await pool.query(`INSERT INTO research_bindings(proposed_order_id,client_order_hash,config_hash,manifest_hash,instrument_id,snapshot_id,snapshot_hash,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[row.id,hash,h.identity.configHash,h.identity.manifestHash,h.identity.instrumentId,good.id,good.hash,good.sequence]);
 return{...h.identity,proposalId:Number(row.id),clientOrderHash:hash};
}
async function bindProposal(pool:any,h:Awaited<ReturnType<typeof seed>>){
 const hash='b'.repeat(64),listing=h.f.policy.listing,stamp=new Date().toISOString(),attribution=buildStrategyAttribution(h.f.config,h.identity.instrumentId,'momentum_default');
 const trigger={version:1,source:'evaluation_bucket',timeframe:'1m',observedAt:stamp,bucketStartMs:Math.floor(Date.parse(stamp)/60000)*60000};
 const row=(await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger)
 VALUES($1,$2,$3,'BUY','LMT',1,100,99,102,'fixture',1,'PASS',$4,2,$5,$6) RETURNING id`,[listing.symbol,h.identity.instrumentId,String(listing.conId),hash,attribution,trigger])).rows[0];
 await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger)
 VALUES($1,$2,$3,$4,'DU_TEST','fixture',2,$5,$6)`,[row.id,hash,h.identity.instrumentId,String(listing.conId),attribution,trigger]);
 const identity={...h.identity,proposalId:Number(row.id),clientOrderHash:hash},result=await h.store.bind(identity);
 assert.equal(result.eligibility.eligible,true);assert.ok(Number.isFinite(Date.parse(result.eligibility.expiresAt!)));
 return identity;
}
test('unconfirmed preflight immediately holds preparation and actual existing binding across restart without changing good head',{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),good=await published(pool,h),binding=await bound(pool,h,good);
 await h.store.validateBinding(binding);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const c=await h.store.claimWshAttempt(lease,{...h.identity,sessionId:randomUUID()},'regular');assert.equal(c.state,'CLAIMED');
  if(c.state!=='CLAIMED')throw Error('fixture');
  const invalid=h.failure('HARD');if(invalid.outcome==='SUCCEEDED')throw Error('fixture');invalid.snapshot.manifestHash='0'.repeat(64);invalid.cleanup.sessionId=c.ticket.sessionId;
  await assert.rejects(h.store.finishWshAttempt(lease,c.ticket,invalid));
 });
 const restarted=new ResearchStore(pool);assert.equal((await restarted.prepareRepair(h.identity)).state,'WAITING');
 await assert.rejects(restarted.validateBinding(binding),/ATTEMPT_UNRESOLVED/);
 assert.deepEqual(await restarted.latestSnapshot(h.identity),good);
}));
for(const verified of [false,true])test(`successful publication cleanup UNKNOWN fences another issuer; verified local close=${verified}`,{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),good=await published(pool,h,verified),other=h.f.manifest.instruments.find(p=>p.instrumentId!==h.identity.instrumentId)!;
 const input={...h.identity,instrumentId:other.instrumentId,sessionId:randomUUID()};
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.store.claimWshAttempt(lease,input,'regular');assert.equal(c.state,'DEFERRED');if(c.state==='DEFERRED')assert.equal(c.reason,'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED');});
 await pool.query('ALTER TABLE research_wsh_refresh_cycles DISABLE TRIGGER research_wsh_refresh_cycle_immutable');
 await pool.query("UPDATE research_wsh_refresh_cycles SET started_at=started_at-interval '16 minutes',next_regular_at=next_regular_at-interval '16 minutes'");
 await pool.query('ALTER TABLE research_wsh_refresh_cycles ENABLE TRIGGER research_wsh_refresh_cycle_immutable');
 const restarted=new ResearchStore(pool);await restarted.withWshEndpointLock('fixture-endpoint',async lease=>assert.equal((await restarted.claimWshAttempt(lease,input,'regular')).state,verified?'CLAIMED':'DEFERRED'));
 assert.deepEqual(await h.store.latestSnapshot(h.identity),good);
 assert.equal((await pool.query('SELECT state FROM research_wsh_acquisitions')).rows[0].state,'PUBLISHED');
 if(!verified){const state=await h.store.readWshRefreshState(h.identity,pool);assert.equal(state.acquisitionBlockedReason,'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED');assert.equal(state.nextRegularAt,null);assert.equal((await h.store.prepareRepair(h.identity)).sources.find(r=>r.sourceId==='wsh')?.state,'READY');const expired=inspectResearch(h.f.manifest,h.identity.instrumentId,good,Date.parse(state.expiresAt!),[],[],[state]);assert.equal(expired.sources.find(r=>r.sourceId==='wsh')?.state,'HOLD');assert.ok(expired.sources.find(r=>r.sourceId==='wsh')?.reasons.includes('RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED'));}
}));
test('metadata and event account mismatch reject before charging either wrong account budget',{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const c=await h.claim(lease);if(c.state!=='CLAIMED')throw Error('fixture');
  const base={...h.identity,provider:'ibkr-wsh',kind:'source' as const,reservedCostMicros:0,maxRequestsPerDay:100,maxCostMicrosPerDay:0,requestHash:'a'.repeat(64),deadlineAt:new Date(Date.now()+9000).toISOString()};
  await assert.rejects(h.store.beginWshAcquisition(lease,{...h.identity,sessionId:c.ticket.sessionId,reservation:{...base,accountId:'WRONG',callKey:'wrong_metadata'}},c.ticket),/IDENTITY|RESERVATION/);
  assert.equal((await pool.query('SELECT count(*) FROM research_call_reservations')).rows[0].count,'0');
  const acq=await h.store.beginWshAcquisition(lease,{...h.identity,sessionId:c.ticket.sessionId,reservation:{...base,callKey:'metadata'}},c.ticket);await h.store.recordCallOutcome('metadata','SUCCEEDED');
  await assert.rejects(h.store.reserveWshCall(lease,acq,{...base,accountId:'WRONG',callKey:'wrong_events'}),/RESERVATION/);
  assert.equal((await pool.query('SELECT count(*) FROM research_call_reservations')).rows[0].count,'1');
 });
}));
test('bounded due rotation reaches third contended issuer without claiming first two',{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),first=await h.store.dueWshAttempts(h.identity),second=await h.store.dueWshAttempts(h.identity);
 assert.equal(first.length,2);assert.equal(new Set([...first,...second].map(r=>r.identity.instrumentId)).size,h.f.manifest.instruments.length);
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_attempts')).rows[0].count,'0');
}));
test('concurrent other-source publication survives WSH transient settlement with unchanged WSH provenance',{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),good=await published(pool,h);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const c=await h.claim(lease);if(c.state!=='CLAIMED')throw Error('fixture');
  const changed=structuredClone(good.snapshot);changed.createdAt=new Date().toISOString();changed.coverage.find((r:any)=>r.role==='news').reason='new ordinary source observation';
  const latest=await new ResearchStore(pool).storeSnapshot(changed);await h.store.finishWshAttempt(lease,c.ticket,h.failure());
  assert.deepEqual(await h.store.latestSnapshot(h.identity),latest);
  const binding=await bound(pool,h,latest);await h.store.validateBinding(binding);assert.equal((await h.store.prepareRepair(h.identity)).state,'READY');
 });
}));
for(const lock of ['authority','issuer','budget','head'] as const)test(`actual held ${lock} lock bounds WSH bookkeeping and preserves unresolved attempt`,{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),held=await pool.connect();
 try{await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const c=lock==='authority'||lock==='issuer'?null:await h.claim(lease);
  await held.query('BEGIN');
  if(lock==='authority')await held.query('SELECT * FROM research_authority FOR UPDATE');
  if(lock==='issuer')await held.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',['research-wsh-issuer:ibkr-wsh:'+h.f.source.parserConfig.isin]);
  if(lock==='budget')await held.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',['research-budget:DU_TEST:ibkr-wsh']);
  if(lock==='head')await held.query('SELECT * FROM research_snapshot_heads FOR UPDATE');
  const start=Date.now();
  if(!c)await assert.rejects(h.claim(lease),/TIMEOUT|statement timeout/);
  else if(c.state==='CLAIMED'&&lock==='head')await assert.rejects(h.store.finishWshAttempt(lease,c.ticket,h.failure('HARD')),/TIMEOUT|statement timeout/);
  else if(c.state==='CLAIMED')await assert.rejects(h.store.beginWshAcquisition(lease,{...h.identity,sessionId:c.ticket.sessionId,reservation:{...h.identity,provider:'ibkr-wsh',kind:'source',reservedCostMicros:0,maxRequestsPerDay:100,maxCostMicrosPerDay:0,callKey:randomUUID(),requestHash:'a'.repeat(64),deadlineAt:new Date(Date.now()+9000).toISOString()}},c.ticket),/TIMEOUT|statement timeout/);
  assert.ok(Date.now()-start<4500);await held.query('ROLLBACK');
 });}finally{await held.query('ROLLBACK');held.release();}
 assert.equal((await pool.query('SELECT count(*) FROM research_call_reservations')).rows[0].count,'0');
}));
for(const offset of [-60000,60000])test(`raw cleanup host clock offset ${offset} stays unchanged; retry uses DB time`,{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const c=await h.claim(lease);if(c.state!=='CLAIMED')throw Error('fixture');
  const result=h.failure(),raw=new Date(Date.now()+offset).toISOString();result.cleanup.completedAt=raw;
  const before=(await pool.query('SELECT clock_timestamp() AS now')).rows[0].now;
  await h.store.finishWshAttempt(lease,c.ticket,result);
  const row=(await pool.query('SELECT cleanup_completed_at,retry_due_at,result_hash,clock_timestamp() AS now FROM research_wsh_refresh_attempts WHERE id=$1',[c.ticket.id])).rows[0];
  assert.equal(row.cleanup_completed_at.toISOString(),raw);assert.equal(row.result_hash,researchHash(result));
  assert.ok(row.retry_due_at.getTime()>=before.getTime()+30000);assert.ok(row.retry_due_at.getTime()<=row.now.getTime()+30000);
 });
}));
test('missing or replayed cleanup session rejects; reused transport session cannot claim a different issuer', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool);await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const c=await h.claim(lease);if(c.state!=='CLAIMED')throw Error('fixture');
  for(const id of [undefined,randomUUID()]){const bad=h.failure();bad.cleanup.sessionId=id as unknown as string;await assert.rejects(h.store.finishWshAttempt(lease,c.ticket,bad),/CLEANUP_SESSION/);}
  await h.store.finishWshAttempt(lease,c.ticket,h.failure());
  const other=h.f.manifest.instruments.find(p=>p.instrumentId!==h.identity.instrumentId)!;
  await assert.rejects(h.store.claimWshAttempt(lease,{...h.identity,instrumentId:other.instrumentId,sessionId:c.ticket.sessionId},'regular'),/unique|session_id/);
 });
 assert.equal((await pool.query('SELECT count(*) FROM research_wsh_refresh_attempts')).rows[0].count,'1');
}));

function unrelated(snapshot:any){const refs=new Set(snapshot.evidence.filter((e:any)=>e.sourceId==='wsh').map((e:any)=>e.ref));return{coverage:snapshot.coverage.filter((c:any)=>c.sourceId!=='wsh'),evidence:snapshot.evidence.filter((e:any)=>e.sourceId!=='wsh'),events:snapshot.events.filter((e:any)=>!refs.has(e.evidenceRef)),reports:snapshot.reports,facts:snapshot.facts,news:snapshot.news};}
for(const omitted of [true,false])test(`successful acquisition merges current head preserving ${omitted?'newly added':'updated'} unrelated coverage and content`,{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool,omitted);let newer:any;
 const good=await published(pool,h,undefined,async incoming=>{
  const prior=(await h.store.latestSnapshot(h.identity))!,changed=structuredClone(prior.snapshot),at=new Date().toISOString();
  changed.createdAt=at;changed.facts[0].value=2001;
  if(omitted)changed.coverage.push({sourceId:'official',role:'news',status:'EMPTY',complete:true,evidenceRefs:[],reason:'newly acquired news',checkedAt:at,windowStart:new Date(Date.parse(at)-86400000).toISOString(),windowEnd:at});
  else{const c=changed.coverage.find(c=>c.role==='news')!;c.checkedAt=at;c.windowEnd=at;c.reason='newer ordinary news';}
  assert.notDeepEqual(unrelated(incoming),unrelated(changed));newer=await new ResearchStore(pool).storeSnapshot(changed);
 });
 assert.deepEqual(unrelated(good.snapshot),unrelated(newer.snapshot));
 assert.equal((await pool.query('SELECT state,snapshot_id FROM research_wsh_acquisitions')).rows[0].state,'PUBLISHED');
 const binding=await bound(pool,h,good);await h.store.validateBinding(binding);assert.equal((await h.store.prepareRepair(h.identity)).state,'READY');
 assert.equal((await h.store.latestSnapshot(h.identity))!.id,good.id);
}));
test('hard-negative settlement preserves newly committed unrelated head but both preparation and existing binding reject', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),good=await published(pool,h);let newer:any;
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{
  const c=await h.claim(lease);if(c.state!=='CLAIMED')throw Error('fixture');
  const changed=structuredClone(good.snapshot);changed.createdAt=new Date().toISOString();changed.facts[0].value=3001;changed.coverage.find((v:any)=>v.role==='news').reason='concurrent newer news';
  newer=await new ResearchStore(pool).storeSnapshot(changed);await h.store.finishWshAttempt(lease,c.ticket,h.failure('HARD'));
 });
 const failed=(await h.store.latestSnapshot(h.identity))!;assert.deepEqual(unrelated(failed.snapshot),unrelated(newer.snapshot));
 const binding=await bound(pool,h,failed);await assert.rejects(h.store.validateBinding(binding),/ATTEMPT_UNRESOLVED/);assert.equal((await h.store.prepareRepair(h.identity)).state,'HOLD');
}));
test('successful publication blocked on current head expires without publication or late overwrite', {skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool),held=await pool.connect();let original:any,acquisitionId='';
 try{
  await assert.rejects(published(pool,h,undefined,async(_incoming,_lease,acq)=>{
   acquisitionId=acq.id;original=await h.store.latestSnapshot(h.identity);await held.query('BEGIN');await held.query('SELECT * FROM research_snapshot_heads FOR UPDATE');
  }),/BOOKKEEPING_TIMEOUT|statement timeout/);
 }finally{await held.query('ROLLBACK');held.release();}
 assert.deepEqual(await h.store.latestSnapshot(h.identity),original);
 assert.equal((await pool.query('SELECT state FROM research_wsh_acquisitions WHERE id=$1',[acquisitionId])).rows[0].state,'PENDING');
 assert.equal((await pool.query('SELECT count(*) FROM research_call_outcomes WHERE outcome=\'SUCCEEDED\'')).rows[0].count,'1');
}));
test('ongoing published calendar retains finite24h expiry, actual binding and exact SQL policy hash',{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool,false,true),good=await published(pool,h),binding=await bindProposal(pool,h),coverage=good.snapshot.coverage.find((c:any)=>c.role==='calendar');
 assert.equal(coverage.wshAcquisition.contractVersion,'ibkr-wsh-v2');assert.equal(coverage.wshAcquisition.qualificationExpiresAt,null);assert.equal(coverage.wshAcquisition.qualificationHash,researchHash(h.f.source.parserConfig.qualification));
 await h.store.validateBinding(binding);assert.equal((await h.store.prepareRepair(h.identity)).state,'READY');
 const state=await h.store.readWshRefreshState(h.identity,pool);assert.equal(Date.parse(state.expiresAt!),Date.parse(coverage.checkedAt)+86400000);
 const sql=(await pool.query('SELECT * FROM research_wsh_source_policy($1,$2,$3,$4)',[h.identity.configHash,h.identity.manifestHash,h.identity.instrumentId,h.identity.sourceId])).rows[0];assert.equal(sql.policy_hash,researchHash(h.f.source));assert.equal(sql.interval_ms,3600000);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease);assert.equal(c.state,'CLAIMED');if(c.state==='CLAIMED')await h.store.finishWshAttempt(lease,c.ticket,h.failure());});
 assert.deepEqual(await h.store.latestSnapshot(h.identity),good);await h.store.validateBinding(binding);assert.equal((await h.store.prepareRepair(h.identity)).state,'READY');
 await dueNow(pool);await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.claim(lease,'retry');assert.equal(c.state,'CLAIMED');if(c.state==='CLAIMED')await h.store.finishWshAttempt(lease,c.ticket,h.failure('HARD'));});
 const restarted=new ResearchStore(pool);assert.equal((await restarted.prepareRepair(h.identity)).state,'HOLD');await assert.rejects(restarted.validateBinding(binding));assert.equal((await restarted.readWshRefreshState(h.identity,pool)).blocksCachedEvidence,true);
}));
test('ongoing receipt does not bypass failed hard settlement and restart HOLD',{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool,false,true),good=await published(pool,h),binding=await bindProposal(pool,h);await h.store.validateBinding(binding);
 await h.store.withWshEndpointLock('fixture-endpoint',async lease=>{const c=await h.store.claimWshAttempt(lease,{...h.identity,sessionId:randomUUID()},'regular');assert.equal(c.state,'CLAIMED');if(c.state!=='CLAIMED')return;
 const result=h.failure('HARD');if(result.outcome==='SUCCEEDED')throw Error('fixture');result.cleanup.sessionId=c.ticket.sessionId;result.snapshot.manifestHash='0'.repeat(64);await assert.rejects(h.store.finishWshAttempt(lease,c.ticket,result));});
 const restarted=new ResearchStore(pool);assert.deepEqual(await restarted.latestSnapshot(h.identity),good);assert.equal((await restarted.prepareRepair(h.identity)).state,'WAITING');await assert.rejects(restarted.validateBinding(binding),/ATTEMPT_UNRESOLVED/);
}));
test('ongoing calendar24h equality agrees across real stored head/binding and controlled evaluation clock',{skip:!connection},()=>isolated(async pool=>{
 const h=await seed(pool,false,true),good=await published(pool,h),checked=Date.parse(good.snapshot.coverage.find((c:any)=>c.role==='calendar').checkedAt);
 // Only evaluation time is injected. All manifests, acquisitions, provenance, heads and bindings use real isolated PostgreSQL.
 let at=checked+86400000-1;
 const wrap=(db:any)=>({query:(sql:any,values?:any[])=>sql==='SELECT clock_timestamp() AS now'?Promise.resolve({rows:[{now:new Date(at)}]}):db.query(sql,values),release:()=>db.release()});
 const clockPool={query:wrap(pool).query,connect:async()=>wrap(await pool.connect())};const store=new ResearchStore(clockPool as any);
 const fresh=structuredClone(good.snapshot);fresh.createdAt=new Date(at).toISOString();for(const c of fresh.coverage.filter((c:any)=>c.role!=='calendar')){c.checkedAt=fresh.createdAt;c.windowEnd=fresh.createdAt;c.windowStart=new Date(at-86400000).toISOString();}
 const head=await store.storeSnapshot(fresh),binding=await bound(pool,h,head);assert.equal((await store.validateBinding(binding)).eligibility.eligible,true);assert.equal((await store.prepareRepair(h.identity)).state,'READY');assert.equal((await store.readWshRefreshState(h.identity,clockPool as any)).expiresAt,new Date(checked+86400000).toISOString());
 at++;await assert.rejects(store.validateBinding(binding),/SOURCE_STALE_OR_FUTURE/);assert.notEqual((await store.prepareRepair(h.identity)).state,'READY');
 assert.equal((await pool.query('SELECT state FROM research_wsh_acquisitions')).rows[0].state,'PUBLISHED');assert.deepEqual((await h.store.readSnapshot(good.id))?.snapshot,good.snapshot);
}));
