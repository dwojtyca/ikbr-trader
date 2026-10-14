import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Pool,PoolClient} from 'pg';
import {LifecycleNotificationCheckpoint} from './notification-checkpoint.js';
import {roundTrip} from './round-trip-test-fixture.js';
import {evaluateRoundTrip} from './round-trip-evidence.js';
import type {LifecycleCycle} from './cycle-evidence.js';
import type {BrokerOrderRow} from '../reconciliation/broker-adapter.js';

function fixture() {
  const f=roundTrip(), now=new Date(f.context.nowMs);
  const transactionIdentity=Symbol('caller transaction');
  let checkedAt=now;
  const report=evaluateRoundTrip(f.evidence,f.context);
  assert.equal(report.status,'COMPLETED');
  const cycle:LifecycleCycle={proposalId:42,links:f.links,terminalFingerprint:'accepted',currentFingerprint:'accepted',
    terminalProof:{status:'FLAT',report,links:structuredClone(f.links),executionIds:f.snapshot.executions.map(e=>e.execId)}};
  f.evidence.lifecycle.cycles=[cycle];
  f.snapshot.recoveryComplete=true;
  f.coverage.executions.window.recoveryWindowComplete=true;
  Object.assign(f.coverage.completedOrders,{available:true,boundedWindow:true});
  Object.assign(f.snapshot,{connectionGeneration:1});
  const acquired=new Date(f.context.nowMs-1000).toISOString();
  const ordinarySnapshot=structuredClone(f.snapshot);
  const checkpointRow={now,session_id:'current',connection_generation:1,reconciliation_run_id:1,
    acquisition_started_at:acquired,captured_at:f.snapshot.capturedAt,observed_at:acquired,
    run_status:'CLEAN',completed_at:f.run.completed_at,final_snapshot:f.snapshot,snapshot:ordinarySnapshot,holds:0,faults:0,
    sources_completed_at:Object.fromEntries(['sessionBefore','positions','openOrders','executions','completedOrders','sessionAfter'].map(k=>[k,f.snapshot.capturedAt]))};
  const query=async(sql:string)=>{
    if(sql==='SELECT notification_fixture_transaction')return {rows:[{identity:transactionIdentity}],rowCount:1};
    if(sql.includes('SELECT setting FROM pg_settings'))return {rows:[{setting:'0'}],rowCount:1};
    if(sql.includes('SELECT c.*'))return {rows:[checkpointRow],rowCount:1};
    if(sql.includes('SELECT p.id FROM proposed_orders'))return {rows:[{id:42}],rowCount:1};
    if(sql.includes('clock_timestamp() AS now'))return {rows:[{now:checkedAt}],rowCount:1};
    return {rows:[],rowCount:0};
  };
  const db={query} as unknown as PoolClient;
  let reads=0;
  const service=new LifecycleNotificationCheckpoint({} as Pool,{getRoundTripEvidence:async(id,account,transaction)=>{
    assert.equal(id,42);assert.equal(account,'DU_TEST');assert.ok(transaction);
    assert.equal((await transaction.query('SELECT notification_fixture_transaction')).rows[0].identity,transactionIdentity);
    reads++;return f.evidence;
  }},()=>({connected:true,accountId:'DU_TEST',sessionId:'current',generation:1}));
  return {f,cycle,checkpointRow,ordinarySnapshot,reads:()=>reads,advanceCheck:(ms:number)=>{checkedAt=new Date(now.getTime()+ms);},eligible:()=>service.eligible(db,'DU_TEST',true)};
}

test('notification proof reuses accepted terminal economics under the caller transaction',async()=>{
  const f=fixture(),proof=await f.eligible();assert.ok(proof);
  assert.equal(proof.runId,1);assert.equal(proof.sessionId,'current');assert.equal(proof.generation,1);
  assert.equal(proof.validUntil.getTime(),f.f.context.nowMs+9000);assert.equal(f.reads(),1);
});

test('proof that expires while historical evidence is read cannot qualify',async()=>{
  const f=fixture();f.advanceCheck(9000);assert.equal(await f.eligible(),null);assert.equal(f.reads(),1);
});

for(const change of ['fingerprint','price','late_execution','working_order','running','missing_terminal_proof'] as const) {
  test(`historical ${change} cannot be used to defer a stale notification`,async()=>{
    const f=fixture();
    if(change==='fingerprint')f.cycle.currentFingerprint='corrected-fee';
    if(change==='price')f.f.snapshot.executions[0].price++;
    if(change==='late_execution'){f.f.snapshot.executions.push({...f.f.snapshot.executions[0],execId:'late'});f.f.coverage.executions.count++;}
    if(change==='working_order'){f.f.snapshot.openOrders.push({accountId:'DU_TEST',conId:'123',brokerOrderId:'101',orderRef:'test-TP',permId:'1001',clientId:7,status:'Submitted',remaining:1,filled:0,action:'SELL'});f.f.coverage.openOrders.count++;}
    if(change==='running'){f.f.run.status='RUNNING';f.checkpointRow.run_status='RUNNING';}
    if(change==='missing_terminal_proof')f.cycle.terminalProof=null;
    assert.equal(await f.eligible(),null);
  });
}

function completedParent(f:ReturnType<typeof fixture>):BrokerOrderRow {
  return {accountId:'DU_TEST',brokerOrderId:null,permId:'1000',orderRef:'test-PARENT',conId:'123',secType:'STK',
    currency:'PLN',symbol:'TEST',status:'Filled',terminalStatus:'Filled',action:'BUY',filled:1,remaining:0,
    observedAt:new Date(f.f.context.nowMs-100)};
}
function completed(f:ReturnType<typeof fixture>,rows:BrokerOrderRow[]) {
  Object.assign(f.ordinarySnapshot,{completedOrders:rows});f.ordinarySnapshot.sourceCoverage.completedOrders.count=rows.length;
}
test('production completed identity without order ID must agree with unique accepted terminal economics',async()=>{
  const f=fixture();completed(f,[completedParent(f)]);assert.ok(await f.eligible());
});
for(const change of ['quantity','total_quantity','order_id','perm_id','contract','currency','action','type','duplicate','unknown_reference'] as const) {
  test(`completed-order ${change} contradiction cannot defer a notification`,async()=>{
    const f=fixture(),row={...completedParent(f)};
    if(change==='quantity')row.filled=2;
    if(change==='total_quantity')row.totalQuantity=2;
    if(change==='order_id')row.brokerOrderId='999';
    if(change==='perm_id')row.permId='9999';
    if(change==='contract')row.conId='456';
    if(change==='currency')Object.assign(row,{currency:'USD'});
    if(change==='action')row.action='SELL';
    if(change==='type')Object.assign(row,{secType:'FUT'});
    if(change==='unknown_reference')row.orderRef='manual-unknown';
    completed(f,change==='duplicate'?[row,{...row}]:[row]);
    assert.equal(await f.eligible(),null);
  });
}

for (const remaining of [1, 0]) {
  test(`cancelled owned protection requires consistent original quantity: remaining ${remaining}`, async () => {
    const f=fixture();
    completed(f,[{...completedParent(f),permId:'1002',orderRef:'test-SL',action:'SELL',
      status:'Cancelled',terminalStatus:'Cancelled',filled:0,remaining}]);
    const proof=await f.eligible();
    if(remaining===1) assert.ok(proof); else assert.equal(proof,null);
  });
}

for(const change of ['quantity','price','contract','type','currency','side','timestamp','missing_timestamp','duplicate','unknown_execution','perm_id','order_ref'] as const) {
  test(`independent ordinary execution ${change} cannot contradict accepted terminal evidence`,async()=>{
    const f=fixture(),row=f.ordinarySnapshot.executions[0];
    assert.notEqual(f.ordinarySnapshot,f.f.snapshot);
    assert.notEqual(row,f.f.snapshot.executions[0]);
    if(change==='quantity')row.shares=2;
    if(change==='price')row.price++;
    if(change==='contract')row.conId='456';
    if(change==='type')Object.assign(row,{secType:'FUT'});
    if(change==='currency')Object.assign(row,{currency:'USD'});
    if(change==='side')row.side='SLD';
    if(change==='timestamp')row.executedAt=new Date(new Date(row.executedAt).getTime()+1000).toISOString();
    if(change==='missing_timestamp')Object.assign(row,{executedAt:null});
    if(change==='duplicate')f.ordinarySnapshot.executions.push({...row});
    if(change==='unknown_execution')row.execId='unknown';
    if(change==='perm_id')row.permId='9999';
    if(change==='order_ref')row.orderRef='unknown';
    f.ordinarySnapshot.sourceCoverage.executions.count=f.ordinarySnapshot.executions.length;
    assert.equal(await f.eligible(),null);
  });
}

test('independent checkpoint accepts normalized side and equivalent timestamp instant',async()=>{
  const f=fixture(), row=f.ordinarySnapshot.executions[0];
  row.side='BUY';Object.assign(row,{executedAt:new Date(row.executedAt)});
  assert.ok(await f.eligible());
});
test('bounded ordinary replay may omit old accepted fills',async()=>{
  const f=fixture();f.ordinarySnapshot.executions=[];f.ordinarySnapshot.sourceCoverage.executions.count=0;
  assert.ok(await f.eligible());
});
