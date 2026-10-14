import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {connectWshBounded,WshBoundedConnection} from './wsh-db.js';
import type {ResearchConnection} from './types.js';

test('late pool connection is destroyed once and never queried after acquisition deadline',async()=>{
 const releases:boolean[]=[];let queries=0;
 const raw:ResearchConnection={query:async()=>{queries++;return{rows:[]};},release:destroy=>{releases.push(!!destroy);}};
 await assert.rejects(connectWshBounded({query:raw.query,connect:async()=>{await delay(70);return raw;}},new Date(Date.now()+20).toISOString()),/BOOKKEEPING_TIMEOUT/);
 await delay(90);assert.deepEqual(releases,[true]);assert.equal(queries,0);
});
test('cumulative operation deadline expires across queries and destroys rather than pooling active connection',async()=>{
 let writes=0;const releases:boolean[]=[];
 const bounded=new WshBoundedConnection({query:async sql=>{if(!sql.includes('set_config')){await delay(35);writes++;}return{rows:[]};},release:destroy=>releases.push(!!destroy)});
 bounded.beginOperation(new Date(Date.now()+50).toISOString());
 await bounded.db.query('SELECT first');await assert.rejects(bounded.db.query('SELECT second'),/BOOKKEEPING_TIMEOUT/);
 await assert.rejects(bounded.db.query('SELECT forbidden'),/BOOKKEEPING_TIMEOUT/);bounded.destroy();assert.deepEqual(releases,[true]);await delay(50);assert.equal(writes,2);
});
test('new transaction cannot renew original monotonic attempt deadline',async()=>{
 const releases:boolean[]=[];const bounded=new WshBoundedConnection({query:async()=>({rows:[]}),release:destroy=>releases.push(!!destroy)});
 bounded.startAttempt(25);bounded.beginOperation();await bounded.db.query('SELECT first');bounded.endOperation();await delay(35);
 bounded.beginOperation();await assert.rejects(bounded.db.query('SELECT later'),/BOOKKEEPING_TIMEOUT/);bounded.destroy();assert.deepEqual(releases,[true]);
});
test('unavailable original connection never permits a late COMMIT continuation',async()=>{
 let commit=0;const bounded=new WshBoundedConnection({query:async sql=>{if(sql.includes('set_config'))await delay(60);if(sql==='COMMIT')commit++;return{rows:[]};},release:()=>{}});
 bounded.beginOperation(new Date(Date.now()+15).toISOString());await assert.rejects(bounded.db.query('COMMIT'),/BOOKKEEPING_TIMEOUT/);await delay(80);assert.equal(commit,0);
});

test('expired terminal resolution cannot open a fresh connection or query after settlement deadline',async()=>{
 const {ResearchStore}=await import('./store.js');let connections=0,queries=0;
 const store=new ResearchStore({connect:async()=>{connections++;throw Error('must not connect');},query:async()=>{queries++;return{rows:[]};}});
 const ticket={id:'expired',cycleId:'cycle',ordinal:0 as const,endpointId:'endpoint',sessionId:'session',accountId:'account',configHash:'a'.repeat(64),manifestHash:'b'.repeat(64),instrumentId:'fixture',sourceId:'wsh',startedAt:new Date(Date.now()-36000).toISOString(),deadlineAt:new Date(Date.now()-1000).toISOString(),nextRegularAt:new Date(Date.now()+864000).toISOString()};
 await assert.rejects(store.readWshAttempt(ticket),/BOOKKEEPING_TIMEOUT/);assert.equal(connections,0);assert.equal(queries,0);
});

async function attemptReadbackFixture(remainingMs:number){
 const {ResearchStore}=await import('./store.js'),{performance}=await import('node:perf_hooks');
 let connections=0,queries=0;
 const ticket={id:'attempt',cycleId:'cycle',ordinal:0 as const,endpointId:'endpoint',sessionId:'session',accountId:'account',configHash:'a'.repeat(64),manifestHash:'b'.repeat(64),instrumentId:'fixture',sourceId:'wsh',startedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60000).toISOString(),nextRegularAt:new Date(Date.now()+900000).toISOString()};
 const row={id:ticket.id,cycle_id:ticket.cycleId,ordinal:0,endpoint_id:ticket.endpointId,session_id:ticket.sessionId,account_id:ticket.accountId,config_hash:ticket.configHash,manifest_hash:ticket.manifestHash,instrument_id:ticket.instrumentId,source_id:ticket.sourceId,started_at:ticket.startedAt,deadline_at:ticket.deadlineAt,next_regular_at:ticket.nextRegularAt,state:'STARTED',result_hash:null,finished_at:null,cleanup_state:'UNKNOWN',failure_class:null,failure_reason:null,failure_stage:null};
 const query=async(sql:string)=>{queries++;return{rows:sql.includes('SELECT outcome')?[{outcome:'SUCCEEDED'}]:sql.includes('FROM research_wsh_refresh_attempts')?[row]:[]};};
 const store=new ResearchStore({query,connect:async()=>{connections++;return{query,release:()=>{}};}});
 // Seed only the already-established monotonic budget to reproduce host-clock rollback without waiting35s.
 (Reflect.get(store,'wshTicketDeadlines') as WeakMap<object,number>).set(ticket,performance.now()+remainingMs);
 return{store,ticket,counts:()=>({connections,queries})};
}
test('all separate-connection current-attempt APIs reject monotonic expiry despite future wall deadline',async()=>{
 const f=await attemptReadbackFixture(-1);
 await assert.rejects(f.store.readWshAttempt(f.ticket),/BOOKKEEPING_TIMEOUT/);
 await assert.rejects(f.store.readWshAcquisition('acquisition',f.ticket),/BOOKKEEPING_TIMEOUT/);
 await assert.rejects(f.store.readSnapshot('snapshot',undefined,f.ticket),/BOOKKEEPING_TIMEOUT/);
 await assert.rejects(f.store.recordCallOutcome('call','SUCCEEDED',undefined,f.ticket),/BOOKKEEPING_TIMEOUT/);
 assert.deepEqual(f.counts(),{connections:0,queries:0});
});
test('all separate-connection current-attempt APIs accept remaining original budget',async()=>{
 const f=await attemptReadbackFixture(1000);
 assert.equal((await f.store.readWshAttempt(f.ticket))?.id,f.ticket.id);
 assert.equal(await f.store.readWshAcquisition('acquisition',f.ticket),null);
 assert.equal(await f.store.readSnapshot('snapshot',undefined,f.ticket),null);
 await f.store.recordCallOutcome('call','SUCCEEDED',undefined,f.ticket);
 assert.equal(f.counts().connections,4);assert.ok(f.counts().queries>0);
});

for(const handoff of ['connection','query'] as const)test(`positive20ms attempt budget survives host rollback at ${handoff} handoff`,async t=>{
 const {ResearchStore}=await import('./store.js'),{performance}=await import('node:perf_hooks');
 const realNow=Date.now,wall=realNow();let wallReads=0,queries=0,connected=false;const releases:boolean[]=[];
 const ticket={id:'attempt',cycleId:'cycle',ordinal:0 as const,endpointId:'endpoint',sessionId:'session',accountId:'account',configHash:'a'.repeat(64),manifestHash:'b'.repeat(64),instrumentId:'fixture',sourceId:'wsh',startedAt:new Date(wall).toISOString(),deadlineAt:new Date(wall+60000).toISOString(),nextRegularAt:new Date(wall+900000).toISOString()};
 const raw:ResearchConnection={query:async()=>{queries++;if(handoff==='query')await delay(80);return{rows:[]};},release:destroy=>releases.push(!!destroy)};
 const store=new ResearchStore({query:raw.query,connect:async()=>{if(handoff==='connection')await delay(80);connected=true;return raw;}});
 (Reflect.get(store,'wshTicketDeadlines') as WeakMap<object,number>).set(ticket,performance.now()+20);
 // Old code resampled wall time at these two handoffs, renewing the20ms allowance by60s.
 t.mock.method(Date,'now',()=>{wallReads++;return realNow()-(wallReads>=(handoff==='connection'?3:5)?60000:0);});
 const started=performance.now();await assert.rejects(store.readWshAcquisition('acquisition',ticket),/BOOKKEEPING_TIMEOUT/);
 assert.ok(performance.now()-started<200);if(handoff==='connection')assert.equal(connected,false);
 assert.equal(wallReads,1,'wall time is sampled once before the monotonic handoff');
 await delay(100);assert.deepEqual(releases,[true]);assert.equal(queries,handoff==='connection'?0:1,'no query continuation after expiry');
});
test('legacy wall deadline is converted once; connection completion carries the original monotonic deadline',async t=>{
 const {performance}=await import('node:perf_hooks');const realNow=Date.now,wall=realNow();let reads=0,queries=0;const releases:boolean[]=[];
 t.mock.method(Date,'now',()=>{reads++;return realNow()-(reads>=3?60000:0);});
 const bounded=await connectWshBounded({query:async()=>({rows:[]}),connect:async()=>({query:async()=>{queries++;await delay(80);return{rows:[]};},release:destroy=>releases.push(!!destroy)})},new Date(wall+20).toISOString());
 const start=performance.now();await assert.rejects(bounded.db.query('SELECT must_expire'),/BOOKKEEPING_TIMEOUT/);
 assert.ok(performance.now()-start<200);await delay(100);assert.equal(reads,1);assert.equal(queries,1);assert.deepEqual(releases,[true]);
});
