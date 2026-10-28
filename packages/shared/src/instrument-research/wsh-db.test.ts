import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {connectWshBounded,WshBoundedConnection} from './wsh-db.js';
import {ResearchStore} from './store.js';
import type {ResearchConnection} from './types.js';

const wall=Date.UTC(2026,9,28,9);
function clock(t:TestContext,rollbackRead=Infinity){
 let monotonic=1000,wallReads=0;
 const completions:(()=>void)[]=[],observed:Promise<unknown>[]=[];
 function deferred<T=void>(cleanupValue?:()=>T){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  completions.push(()=>resolve(cleanupValue?.() as T));
  return{promise,resolve};
 }
 function observe<T>(promise:Promise<T>):Promise<T>{
  observed.push(promise);void promise.catch(()=>{});return promise;
 }
 t.after(async()=>{
  for(const complete of completions)complete();
  await continuations();await Promise.allSettled(observed);await continuations();
 });
 t.mock.method(performance,'now',()=>monotonic);
 t.mock.method(Date,'now',()=>wall-(++wallReads>=rollbackRead?60000:0));
 t.mock.timers.enable({apis:['setTimeout']});
 return{deferred,observe,advance:(ms:number)=>{assert.ok(ms>=0);monotonic+=ms;t.mock.timers.tick(ms);},wallReads:()=>wallReads};
}
// A native event-loop turn drains the finite promise chain of a resolved fake
// dependency after its wrapper already timed out; no logical time advances.
const continuations=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('late pool connection is destroyed once and never queried after acquisition deadline',async t=>{
 const time=clock(t),acquired=time.deferred<ResearchConnection>(()=>raw),started=time.deferred(),released=time.deferred();
 const releases:boolean[]=[];let queries=0,timedOut=false;
 const raw:ResearchConnection={query:async()=>{queries++;return{rows:[]};},release:destroy=>{releases.push(!!destroy);released.resolve();}};
 const result=time.observe(assert.rejects(connectWshBounded({query:raw.query,connect:()=>{started.resolve();return acquired.promise;}},new Date(wall+20).toISOString()),/BOOKKEEPING_TIMEOUT/).then(()=>{timedOut=true;}));
 await started.promise;time.advance(19);await continuations();assert.equal(timedOut,false);assert.deepEqual(releases,[]);
 time.advance(1);await result;assert.equal(queries,0);assert.deepEqual(releases,[]);
 time.advance(50);acquired.resolve(raw);await released.promise;await continuations();
 assert.deepEqual(releases,[true]);assert.equal(queries,0);
});
test('cumulative operation deadline expires across queries and destroys rather than pooling active connection',async t=>{
 const time=clock(t),first=time.deferred(),second=time.deferred(),firstIssued=time.deferred(),secondIssued=time.deferred();
 let writes=0,timedOut=false;const releases:boolean[]=[],queries:string[]=[],budgets:unknown[]=[];
 const bounded=new WshBoundedConnection({query:async(sql,values)=>{
  if(sql.includes('set_config'))budgets.push(values?.[0]);
  else{queries.push(sql);if(sql==='SELECT first'){firstIssued.resolve();await first.promise;}else{secondIssued.resolve();await second.promise;}writes++;}
  return{rows:[]};
 },release:destroy=>releases.push(!!destroy)});
 bounded.beginOperation(new Date(wall+50).toISOString());
 const firstResult=time.observe(bounded.db.query('SELECT first'));await firstIssued.promise;
 time.advance(35);first.resolve();await firstResult;assert.equal(writes,1);assert.deepEqual(releases,[]);
 const result=time.observe(assert.rejects(bounded.db.query('SELECT second'),/BOOKKEEPING_TIMEOUT/).then(()=>{timedOut=true;}));await secondIssued.promise;
 time.advance(14);await continuations();assert.equal(timedOut,false);assert.deepEqual(releases,[]);
 time.advance(1);await result;assert.deepEqual(releases,[true]);
 await assert.rejects(bounded.db.query('SELECT forbidden'),/BOOKKEEPING_TIMEOUT/);bounded.destroy();
 time.advance(20);second.resolve();await continuations();
 assert.deepEqual(queries,['SELECT first','SELECT second']);assert.deepEqual(budgets,['50','15']);
 assert.equal(writes,2);assert.deepEqual(releases,[true]);
});
test('new transaction cannot renew original monotonic attempt deadline',async t=>{
 const time=clock(t),releases:boolean[]=[],queries:string[]=[];
 const bounded=new WshBoundedConnection({query:async sql=>{queries.push(sql);return{rows:[]};},release:destroy=>releases.push(!!destroy)});
 bounded.startAttempt(25);bounded.beginOperation();await bounded.db.query('SELECT first');bounded.endOperation();time.advance(35);
 bounded.beginOperation();await assert.rejects(bounded.db.query('SELECT later'),/BOOKKEEPING_TIMEOUT/);bounded.destroy();
 assert.deepEqual(queries.filter(sql=>!sql.includes('set_config')),['SELECT first']);assert.deepEqual(releases,[true]);
});
test('unavailable original connection never permits a late COMMIT continuation',async t=>{
 const time=clock(t),setup=time.deferred(),entered=time.deferred();let commit=0;const releases:boolean[]=[];
 const bounded=new WshBoundedConnection({query:async sql=>{if(sql.includes('set_config')){entered.resolve();await setup.promise;}if(sql==='COMMIT')commit++;return{rows:[]};},release:destroy=>releases.push(!!destroy)});
 bounded.beginOperation(new Date(wall+15).toISOString());const result=time.observe(assert.rejects(bounded.db.query('COMMIT'),/BOOKKEEPING_TIMEOUT/));
 await entered.promise;time.advance(15);await result;assert.equal(commit,0);assert.deepEqual(releases,[true]);
 time.advance(45);setup.resolve();await continuations();assert.equal(commit,0);assert.deepEqual(releases,[true]);
});

test('expired terminal resolution cannot open a fresh connection or query after settlement deadline',async t=>{
 clock(t);let connections=0,queries=0;
 const store=new ResearchStore({connect:async()=>{connections++;throw Error('must not connect');},query:async()=>{queries++;return{rows:[]};}});
 const ticket={id:'expired',cycleId:'cycle',ordinal:0 as const,endpointId:'endpoint',sessionId:'session',accountId:'account',configHash:'a'.repeat(64),manifestHash:'b'.repeat(64),instrumentId:'fixture',sourceId:'wsh',startedAt:new Date(wall-36000).toISOString(),deadlineAt:new Date(wall-1000).toISOString(),nextRegularAt:new Date(wall+864000).toISOString()};
 await assert.rejects(store.readWshAttempt(ticket),/BOOKKEEPING_TIMEOUT/);assert.equal(connections,0);assert.equal(queries,0);
});

function attemptReadbackFixture(remainingMs:number){
 let connections=0,queries=0;
 const ticket={id:'attempt',cycleId:'cycle',ordinal:0 as const,endpointId:'endpoint',sessionId:'session',accountId:'account',configHash:'a'.repeat(64),manifestHash:'b'.repeat(64),instrumentId:'fixture',sourceId:'wsh',startedAt:new Date(wall).toISOString(),deadlineAt:new Date(wall+60000).toISOString(),nextRegularAt:new Date(wall+900000).toISOString()};
 const row={id:ticket.id,cycle_id:ticket.cycleId,ordinal:0,endpoint_id:ticket.endpointId,session_id:ticket.sessionId,account_id:ticket.accountId,config_hash:ticket.configHash,manifest_hash:ticket.manifestHash,instrument_id:ticket.instrumentId,source_id:ticket.sourceId,started_at:ticket.startedAt,deadline_at:ticket.deadlineAt,next_regular_at:ticket.nextRegularAt,state:'STARTED',result_hash:null,finished_at:null,cleanup_state:'UNKNOWN',failure_class:null,failure_reason:null,failure_stage:null};
 const query=async(sql:string)=>{queries++;return{rows:sql.includes('SELECT outcome')?[{outcome:'SUCCEEDED'}]:sql.includes('FROM research_wsh_refresh_attempts')?[row]:[]};};
 const store=new ResearchStore({query,connect:async()=>{connections++;return{query,release:()=>{}};}});
 // Seed only the already-established monotonic budget without waiting35s.
 (Reflect.get(store,'wshTicketDeadlines') as WeakMap<object,number>).set(ticket,performance.now()+remainingMs);
 return{store,ticket,counts:()=>({connections,queries})};
}
test('all separate-connection current-attempt APIs reject monotonic expiry despite future wall deadline',async t=>{
 clock(t);const f=attemptReadbackFixture(-1);
 await assert.rejects(f.store.readWshAttempt(f.ticket),/BOOKKEEPING_TIMEOUT/);
 await assert.rejects(f.store.readWshAcquisition('acquisition',f.ticket),/BOOKKEEPING_TIMEOUT/);
 await assert.rejects(f.store.readSnapshot('snapshot',undefined,f.ticket),/BOOKKEEPING_TIMEOUT/);
 await assert.rejects(f.store.recordCallOutcome('call','SUCCEEDED',undefined,f.ticket),/BOOKKEEPING_TIMEOUT/);
 assert.deepEqual(f.counts(),{connections:0,queries:0});
});
test('all separate-connection current-attempt APIs accept remaining original budget',async t=>{
 clock(t);const f=attemptReadbackFixture(1000);
 assert.equal((await f.store.readWshAttempt(f.ticket))?.id,f.ticket.id);
 assert.equal(await f.store.readWshAcquisition('acquisition',f.ticket),null);
 assert.equal(await f.store.readSnapshot('snapshot',undefined,f.ticket),null);
 await f.store.recordCallOutcome('call','SUCCEEDED',undefined,f.ticket);
 assert.equal(f.counts().connections,4);assert.ok(f.counts().queries>0);
});

for(const handoff of ['connection','query'] as const)test(`positive20ms attempt budget survives host rollback at ${handoff} handoff`,async t=>{
 const time=clock(t,handoff==='connection'?3:5),acquired=time.deferred<ResearchConnection>(()=>raw),setup=time.deferred(),entered=time.deferred(),released=time.deferred();
 let queries=0,connected=false,timedOut=false;const releases:boolean[]=[];
 const ticket={id:'attempt',cycleId:'cycle',ordinal:0 as const,endpointId:'endpoint',sessionId:'session',accountId:'account',configHash:'a'.repeat(64),manifestHash:'b'.repeat(64),instrumentId:'fixture',sourceId:'wsh',startedAt:new Date(wall).toISOString(),deadlineAt:new Date(wall+60000).toISOString(),nextRegularAt:new Date(wall+900000).toISOString()};
 const raw:ResearchConnection={query:async()=>{queries++;entered.resolve();await setup.promise;return{rows:[]};},release:destroy=>{releases.push(!!destroy);released.resolve();}};
 const store=new ResearchStore({query:raw.query,connect:async()=>{if(handoff==='connection'){entered.resolve();await acquired.promise;}connected=true;return raw;}});
 (Reflect.get(store,'wshTicketDeadlines') as WeakMap<object,number>).set(ticket,performance.now()+20);
 const result=time.observe(assert.rejects(store.readWshAcquisition('acquisition',ticket),/BOOKKEEPING_TIMEOUT/).then(()=>{timedOut=true;}));await entered.promise;
 time.advance(19);await continuations();assert.equal(timedOut,false);assert.deepEqual(releases,[]);
 time.advance(1);await result;if(handoff==='connection'){assert.equal(connected,false);assert.deepEqual(releases,[]);}else assert.deepEqual(releases,[true]);
 assert.equal(time.wallReads(),1,'wall time is sampled once before the monotonic handoff');
 time.advance(60);if(handoff==='connection')acquired.resolve(raw);else setup.resolve();
 await released.promise;await continuations();assert.deepEqual(releases,[true]);
 assert.equal(queries,handoff==='connection'?0:1,'no query continuation after expiry');
});
test('legacy wall deadline is converted once; connection completion carries the original monotonic deadline',async t=>{
 const time=clock(t,3),setup=time.deferred(),entered=time.deferred();let queries=0,timedOut=false;const releases:boolean[]=[];
 const bounded=await connectWshBounded({query:async()=>({rows:[]}),connect:async()=>({query:async()=>{queries++;entered.resolve();await setup.promise;return{rows:[]};},release:destroy=>releases.push(!!destroy)})},new Date(wall+20).toISOString());
 const result=time.observe(assert.rejects(bounded.db.query('SELECT must_expire'),/BOOKKEEPING_TIMEOUT/).then(()=>{timedOut=true;}));await entered.promise;
 time.advance(19);await continuations();assert.equal(timedOut,false);assert.deepEqual(releases,[]);
 time.advance(1);await result;assert.deepEqual(releases,[true]);
 time.advance(60);setup.resolve();await continuations();assert.equal(time.wallReads(),1);assert.equal(queries,1);assert.deepEqual(releases,[true]);
});
