import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isFlatNotificationSnapshot} from './notification-checkpoint.js';
import {flatNotificationSnapshot} from './notification-checkpoint-test-fixture.js';
import type {BrokerReconciliationSnapshot} from '../reconciliation/broker-adapter.js';

test('notification flat proof requires every positive source and exact empty account exposure',()=>{
  const s=flatNotificationSnapshot();assert.equal(isFlatNotificationSnapshot(s),true);
  for(const name of ['positions','openOrders','executions','completedOrders','session'] as const){
    const copy=structuredClone(s);delete (copy.sourceCoverage as Record<string,unknown>)[name];assert.equal(isFlatNotificationSnapshot(copy),false);
    assert.equal(isFlatNotificationSnapshot({...s,sourceCoverage:{...s.sourceCoverage,[name]:{...s.sourceCoverage[name],available:false}}}),false);
  }
  assert.equal(isFlatNotificationSnapshot({...s,positions:[{accountId:'PAPER',conId:'123',secType:'STK',symbol:'T',position:1}],sourceCoverage:{...s.sourceCoverage,positions:{...s.sourceCoverage.positions,count:1}}}),false);
  assert.equal(isFlatNotificationSnapshot({...s,openOrders:[{accountId:null,brokerOrderId:'1',status:'Submitted',observedAt:new Date()}],sourceCoverage:{...s.sourceCoverage,openOrders:{...s.sourceCoverage.openOrders,count:1}}}),false);
  assert.equal(isFlatNotificationSnapshot({sourceCoverage:{}} as BrokerReconciliationSnapshot),false);
});
test('historical executions are not rejected merely for existing; ownership is validated transactionally',()=>{
 const s=flatNotificationSnapshot(); const execution={accountId:'PAPER',conId:'123',secType:'STK',execId:'historic',brokerOrderId:'1',shares:1,executedAt:new Date()};
 assert.equal(isFlatNotificationSnapshot({...s,executions:[execution],sourceCoverage:{...s.sourceCoverage,executions:{...s.sourceCoverage.executions,count:1}}}),true);
});

test('notification checkpoint has a bounded pool wait and releases late connections without queries',async()=>{
 const {LifecycleNotificationCheckpoint}=await import('./notification-checkpoint.js');
 let connect!:(value:unknown)=>void, released=0,queries=0;
 const pool={connect:()=>new Promise(resolve=>{connect=resolve;})};
 const s=flatNotificationSnapshot();
 const checkpoint=new LifecycleNotificationCheckpoint(pool as never,{} as never,()=>({accountId:'PAPER',sessionId:'session',generation:1,connected:true}));
 const request={accountId:'PAPER',sessionId:'session',sessionStartedAt:new Date(),reconciliationRunId:1,positionGeneration:1,safetyMarginMs:1,sourceTimeoutMs:20,abortSignal:new AbortController().signal};
 await assert.rejects(checkpoint.publish(s,request,new Date(),{}),/notification_checkpoint_deadline/);
 connect({release:()=>{released++;},query:async()=>{queries++;return {rows:[]};}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(released,1);assert.equal(queries,0);
});
test('aborted checkpoint acquisition releases late client and cannot publish',async()=>{
 const {LifecycleNotificationCheckpoint}=await import('./notification-checkpoint.js');
 const controller=new AbortController();let connect!:(value:unknown)=>void,released=0;
 const checkpoint=new LifecycleNotificationCheckpoint({connect:()=>new Promise(resolve=>{connect=resolve;})} as never,{} as never,()=>({accountId:'PAPER',sessionId:'session',generation:1,connected:true}));
 const pending=checkpoint.publish(flatNotificationSnapshot(),{accountId:'PAPER',sessionId:'session',sessionStartedAt:new Date(),reconciliationRunId:1,positionGeneration:1,safetyMarginMs:1,sourceTimeoutMs:1000,abortSignal:controller.signal},new Date(),{});
 controller.abort();await assert.rejects(pending,/notification_checkpoint_deadline/);connect({release:()=>{released++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(released,1);
});
