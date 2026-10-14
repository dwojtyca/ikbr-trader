import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IbBrokerReconciliationAdapter} from './ib-broker-adapter.js';
import type {TwsExecutionClient} from '../tws-execution-client.js';
import type {BrokerPhaseEvent} from './phase-diagnostics.js';
function fixture(){
 const tws={isConnected:()=>true,getConnectionGeneration:()=>1,getManagedAccounts:async()=>['PAPER'],reqPositionsSnapshot:async()=>({ok:true,rows:[]}),reqAllOpenOrdersSnapshot:async()=>({ok:true,rows:[]}),reqExecutionsSnapshot:async()=>({ok:true,rows:[],endObserved:true})};
 const completed={load:async()=>({ok:true as const,rows:[],endObserved:true})};
 const req={accountId:'PAPER',sessionId:'session',sessionStartedAt:new Date(),sourceTimeoutMs:20,safetyMarginMs:1,abortSignal:new AbortController().signal,reconciliationRunId:1,positionGeneration:1};
 return {tws,completed,req};
}
test('checkpoint precedes accounting join and retains original acquisition time',async()=>{
 const f=fixture(),events:BrokerPhaseEvent[]=[],order:string[]=[];
 const adapter=new IbBrokerReconciliationAdapter(f.tws as unknown as TwsExecutionClient,f.completed,{join:async s=>{order.push('accounting');throw Object.assign(new Error('custom-secret unavailable'),{code:'SOURCE'});}},
  {diagnostics:{emit:e=>events.push(e),privacy:()=>({secrets:['custom-secret']})},checkpoint:async(s,_req,started,sources)=>{order.push('checkpoint');assert.equal(s.originalAcquisitionStartedAt,started.toISOString());assert.equal(Object.keys(sources).length,6);}});
 const snapshot=await adapter.capture(f.req);assert.deepEqual(order,['checkpoint','accounting']);assert.equal(snapshot.exposureComplete,true);
 const cause=events.find(e=>e.phase==='capture.accountingJoin');assert.equal(cause?.outcome,'error');assert.equal(cause?.cause?.code,'SOURCE');assert.equal(cause?.cause?.message,'[UKRYTO] unavailable');
 assert.equal(events.at(-1)?.phase,'capture.total');assert.equal(events.at(-1)?.outcome,'error');
});
test('returned source timeout reports failure rather than success and session cause stays sanitized',async()=>{
 const f=fixture(),events:BrokerPhaseEvent[]=[];
 Object.assign(f.tws,{reqPositionsSnapshot:async()=>({ok:false,error:'timeout',rows:[]}),getManagedAccounts:async()=>{throw Object.assign(new Error('custom-secret clock'),{name:'SocketFailure',code:503});}});
 const adapter=new IbBrokerReconciliationAdapter(f.tws as unknown as TwsExecutionClient,f.completed,undefined,{diagnostics:{emit:e=>events.push(e),privacy:()=>({secrets:['custom-secret']})}});
 const snapshot=await adapter.capture(f.req);assert.equal(snapshot.exposureComplete,false);
 assert.equal(events.find(e=>e.phase==='capture.positions')?.outcome,'error');assert.equal(events.find(e=>e.phase==='capture.positions')?.reason,'timeout');
 assert.deepEqual(events.find(e=>e.phase==='capture.sessionBefore.cause')?.cause,{name:'SocketFailure',code:'503',message:'[UKRYTO] clock'});
});
