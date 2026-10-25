import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
import type {Pool} from 'pg';
import {AccountingSourceOwner} from './source-owner.js';
import type {SourceSettingsV1} from './types.js';
const settings:SourceSettingsV1={schemaVersion:1,sourceKind:'ibkr-tws-seven-day-v1',environment:'paper',accountId:'TEST-OWNER',endpoint:{host:'127.0.0.1',port:45678},sourceClientId:0,executionTimeZone:'UTC'};
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const result=(value:Record<string,unknown>)=>({rowCount:1,rows:[value]});
type Query={text:string;values?:unknown[];query_timeout?:number};
class Client extends EventEmitter{
 releases=0;queries:Query[]=[];hook:((query:Query)=>Promise<ReturnType<typeof result>>|undefined)|undefined;
 async query(input:string|Query){const q=typeof input==='string'?{text:input}:input;this.queries.push(q);const intercepted=this.hook?.(q);if(intercepted)return intercepted;
  if(q.text.includes('SELECT pending_operation_id'))return result({pending_operation_id:null});
  if(q.text.includes('pg_try_advisory_lock'))return result({locked:true});
  if(q.text.includes('INSERT INTO accounting_source_owners'))return result({generation:1});
  if(q.text.includes('pg_advisory_unlock'))return result({unlocked:true});
  if(q.text.includes('SELECT NOT EXISTS'))return result({absent:true});
  if(q.text.includes('SELECT EXISTS'))return result({held:true});
  return result({});
 }
 release(destroy:boolean){assert.equal(destroy,true);this.releases++;}
}
function fixture(){
 const client=new Client();let losses=0,connectHook:(()=>Promise<Client>)|undefined;
 const pool={connect:()=>connectHook?connectHook():Promise.resolve(client),query:async()=>result({})};
 const owner=new AccountingSourceOwner(pool as unknown as Pool,settings,()=>{losses++;});
 return {owner,client,pool,losses:()=>losses,setConnect:(hook:()=>Promise<Client>)=>{connectHook=hook;}};
}

test('release revokes synchronously, shares one pending proof and destroys once',async()=>{
 const f=fixture();await f.owner.acquire();await f.owner.retire(true);const gate=deferred<ReturnType<typeof result>>(),started=deferred<void>();
 f.client.hook=q=>{if(q.text.includes('pg_advisory_unlock')){started.resolve();return gate.promise;}};
 const first=f.owner.release(),second=f.owner.release();assert.equal(first,second);assert.throws(()=>f.owner.assertHeld(),/OWNER_LOST/);assert.throws(()=>f.owner.assertCurrent(),/OWNER_LOST/);
 await started.promise;assert.equal(f.client.releases,0);gate.resolve(result({unlocked:true}));await first;await f.owner.release();
 assert.equal(f.client.queries.filter(q=>q.text.includes('pg_advisory_unlock')).length,1);assert.equal(f.client.releases,1);assert.equal(f.losses(),0);
});
for(const defect of ['false','missing','lost acknowledgement','stacked lock'] as const)test(`unconfirmed ${defect} rejects without retry or fabricated retirement`,async()=>{
 const f=fixture();await f.owner.acquire();await f.owner.retire(true);const cause=new Error('synthetic lost acknowledgement');
 f.client.hook=q=>{
  if(q.text.includes('pg_advisory_unlock'))return defect==='false'?Promise.resolve(result({unlocked:false})):defect==='missing'?Promise.resolve({rowCount:0,rows:[]}):defect==='lost acknowledgement'?Promise.reject(cause):undefined;
  if(q.text.includes('SELECT NOT EXISTS')&&defect==='stacked lock')return Promise.resolve(result({absent:false}));
 };
 const before=f.client.queries.length,closing=f.owner.release();await assert.rejects(closing,e=>e instanceof Error&&e.message==='ACCOUNTING_SOURCE_OWNER_RELEASE_UNKNOWN'&&(defect!=='lost acknowledgement'||e.cause===cause));
 assert.equal(f.owner.release(),closing);await assert.rejects(f.owner.release(),/RELEASE_UNKNOWN/);assert.equal(f.client.releases,1);
 assert.equal(f.client.queries.slice(before).filter(q=>q.text.includes('pg_advisory_unlock')).length,1);
 assert.equal(f.client.queries.slice(before).some(q=>/UPDATE|INSERT/.test(q.text)),false);assert.throws(()=>f.owner.assertHeld(),/OWNER_LOST/);
});

test('release retains one deadline across delayed unlock and never-completing absence proof',async t=>{
 let now=100;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setTimeout']});
 const f=fixture();await f.owner.acquire();await f.owner.retire(true);
 const unlock=deferred<ReturnType<typeof result>>(),absence=deferred<ReturnType<typeof result>>(),began=deferred<void>(),checking=deferred<void>();
 f.client.hook=q=>{if(q.text.includes('pg_advisory_unlock')){began.resolve();return unlock.promise;}if(q.text.includes('SELECT NOT EXISTS')){checking.resolve();return absence.promise;}};
 const close=f.owner.release(),rejected=assert.rejects(close,/RELEASE_UNKNOWN/);await began.promise;
 now+=1500;t.mock.timers.tick(1500);unlock.resolve(result({unlocked:true}));await checking.promise;
 assert.equal(f.client.queries.at(-1)?.query_timeout,500);now+=500;t.mock.timers.tick(500);await rejected;
 assert.equal(f.client.releases,1);absence.resolve(result({absent:true}));await Promise.resolve();assert.throws(()=>f.owner.assertHeld(),/OWNER_LOST/);
});

test('in-flight verifier cannot refresh a released owner or invoke another loss callback',async()=>{
 const f=fixture();await f.owner.acquire();const proof=deferred<ReturnType<typeof result>>(),started=deferred<void>();
 f.client.hook=q=>{if(q.text.includes('SELECT EXISTS')){started.resolve();return proof.promise;}};
 const verifying=f.owner.verifyCurrent(),rejected=assert.rejects(verifying,/OWNER_LOST/);await started.promise;await f.owner.retire(true);await f.owner.release();
 proof.resolve(result({held:true}));await rejected;assert.equal(f.losses(),0);assert.throws(()=>f.owner.assertHeld(),/OWNER_LOST/);
});

test('a client obtained after release cannot acquire or resurrect local ownership',async()=>{
 const f=fixture(),connection=deferred<Client>(),started=deferred<void>();f.setConnect(()=>{started.resolve();return connection.promise;});
 const acquiring=f.owner.acquire(),rejected=assert.rejects(acquiring,/OWNER_LOST/);await started.promise;await f.owner.release();connection.resolve(f.client);await rejected;
 assert.equal(f.client.queries.length,0);assert.equal(f.client.releases,1);assert.throws(()=>f.owner.fence(),/OWNER_LOST/);await f.owner.release();assert.equal(f.client.releases,1);
});

test('late activate and retire completion cannot restore released authority',async()=>{
 for(const operation of ['activate','retire'] as const){
  const f=fixture();await f.owner.acquire();await f.owner.retire(true);const gate=deferred<ReturnType<typeof result>>(),started=deferred<void>();
  if(operation==='activate')f.client.hook=q=>{if(q.text.includes("SET retirement_state='ACTIVE'")){started.resolve();return gate.promise;}};
  else f.pool.query=async()=>{started.resolve();return gate.promise;};
  const mutation=operation==='activate'?f.owner.activate():f.owner.retire(true),rejected=assert.rejects(mutation,/OWNER_LOST/);await started.promise;
  await f.owner.release();gate.resolve(result({}));await rejected;assert.throws(()=>f.owner.assertHeld(),/OWNER_LOST/);assert.equal(f.client.releases,1);
 }
});

test('cleanup-only NEW ACTIVE and LOST release retains prior loss and retirement rules',async()=>{
 const fresh=fixture();await fresh.owner.release();await fresh.owner.release();assert.equal(fresh.client.releases,0);
 for(const state of ['ACTIVE','LOST'] as const){const f=fixture();await f.owner.acquire();if(state==='LOST')await assert.rejects(f.owner.retire(false),/RETIREMENT_UNKNOWN/);
  const before=f.client.queries.length;await f.owner.release();await f.owner.release();assert.equal(f.client.releases,1);assert.equal(f.losses(),1);assert.equal(f.client.queries.length,before);assert.throws(()=>f.owner.assertHeld(),/OWNER_LOST/);
 }
});
