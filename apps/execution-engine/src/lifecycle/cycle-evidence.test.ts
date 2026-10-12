import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateLifecycleOwnership } from './ownership.js';
import { evaluateRoundTrip } from './round-trip-evidence.js';
import { roundTrip } from './round-trip-test-fixture.js';
import { activeStockEvidenceFailure } from './protection-evidence.js';
import { terminalCycleFailure, type LifecycleCycle } from './cycle-evidence.js';

function cycleFixture(id: number) {
  const f=roundTrip();
  f.order.id=id; f.review.proposed_order_id=id; f.evidence.window!.consumedProposalId=id;
  for(const link of f.evidence.lifecycle.links) { link.proposed_order_id=id; link.broker_order_id=String(Number(link.broker_order_id)+id*10); link.order_ref=`${id}:${link.order_ref}`; link.perm_id=String(Number(link.perm_id)+id*10); }
  for(let i=0;i<f.snapshot.executions.length;i++) {const e=f.snapshot.executions[i],link=f.evidence.lifecycle.links[i]; e.execId=`${id}:${e.execId}`;e.brokerOrderId=link.broker_order_id!;e.orderRef=link.order_ref;e.permId=link.perm_id!;Object.assign(f.evidence.fills[i],{exec_id:e.execId,broker_order_id:e.brokerOrderId,proposed_order_id:id});}
  return f;
}
function accepted(f: ReturnType<typeof cycleFixture>): LifecycleCycle {
  const report=evaluateRoundTrip(f.evidence,f.context);assert.equal(report.status,'COMPLETED',JSON.stringify(report.reasons));
  return {proposalId:f.order.id!,links:[...f.evidence.lifecycle.links],terminalFingerprint:`${f.order.id}:stable`,currentFingerprint:`${f.order.id}:stable`,terminalProof:{status:'FLAT',report,links:[...f.evidence.lifecycle.links],executionIds:f.snapshot.executions.map(e=>e.execId)}};
}
function sequence() {
  const first=cycleFixture(42), old=accepted(first), current=cycleFixture(43);
  const live: LifecycleCycle={proposalId:43,links:[...current.evidence.lifecycle.links],terminalProof:null,terminalFingerprint:null,currentFingerprint:'live'};
  current.evidence.lifecycle.cycles=[old,live];
  current.snapshot.executions.unshift(...first.snapshot.executions);current.coverage.executions.count=4;
  return {first,old,current,live};
}
test('completed same-contract cycle remains valid while next cycle is protected, then closes and a third owns only its fills',()=>{
  const {first,old,current,live}=sequence();
  const exit=current.snapshot.executions.pop()!;const exitFill=current.evidence.fills.pop()!;current.coverage.executions.count=3;
  current.snapshot.positions=[{accountId:'DU_TEST',conId:'123',position:1}];current.coverage.positions.count=1;
  current.snapshot.openOrders=current.evidence.lifecycle.links.slice(1).map(l=>({accountId:'DU_TEST',conId:'123',brokerOrderId:l.broker_order_id!,orderRef:l.order_ref,permId:l.perm_id!,clientId:7,status:'Submitted',remaining:1,filled:0,action:'SELL',secType:'STK',currency:'PLN'}));current.coverage.openOrders.count=2;
  assert.equal(evaluateLifecycleOwnership(current.evidence.lifecycle,current.context).status,'OWNED_POSITION');
  assert.equal(activeStockEvidenceFailure(current.evidence,'PLN'),null);
  assert.equal(terminalCycleFailure(old,current.evidence.lifecycle,current.context),null);
  first.evidence.lifecycle.run=current.evidence.lifecycle.run; first.evidence.lifecycle.cycles=[old,live];
  assert.equal(evaluateRoundTrip(first.evidence,first.context).status,'COMPLETED');
  current.snapshot.executions.push(exit);current.evidence.fills.push(exitFill);current.coverage.executions.count=4;
  current.snapshot.positions=[];current.coverage.positions.count=0;current.snapshot.openOrders=[];current.coverage.openOrders.count=0;
  const second=accepted(current); assert.equal(second.terminalProof!.report.fills.length,2);
  const third=cycleFixture(44);third.evidence.lifecycle.cycles=[old,second,{proposalId:44,links:[...third.evidence.lifecycle.links],terminalProof:null,terminalFingerprint:null,currentFingerprint:'third'}];
  third.snapshot.executions.unshift(...current.snapshot.executions);third.coverage.executions.count=6;
  const final=evaluateRoundTrip(third.evidence,third.context);assert.equal(final.status,'COMPLETED',JSON.stringify(final.reasons));assert.deepEqual(final.fills.map(f=>f.execId),['44:fill-1','44:fill-2']);
});
for(const fault of ['commission','late_fill','price','unknown_execution','unknown_order','ambiguous_identity'] as const) test(`historical ${fault} remains an account hold across cycles`,()=>{
  const {old,current,live}=sequence();
  if(fault==='commission')old.currentFingerprint='changed commission';
  if(fault==='late_fill'){current.snapshot.executions.push({...current.snapshot.executions[0],execId:'late'});current.coverage.executions.count++;}
  if(fault==='price')current.snapshot.executions[0].price++;
  if(fault==='unknown_execution'){current.snapshot.executions.push({...current.snapshot.executions[0],execId:'unknown',brokerOrderId:'999',orderRef:'unknown',permId:'999'});current.coverage.executions.count++;}
  if(fault==='unknown_order'){current.snapshot.openOrders.push({accountId:'DU_TEST',conId:'123',brokerOrderId:'999',orderRef:'unknown',permId:'999',clientId:0,status:'Submitted',remaining:1,filled:0,action:'SELL'});current.coverage.openOrders.count++;}
  if(fault==='ambiguous_identity')live.links[0].broker_order_id=old.links[0].broker_order_id;
  assert.equal(evaluateLifecycleOwnership(current.evidence.lifecycle,current.context).status,'BLOCKED');
  assert.ok(terminalCycleFailure(old,current.evidence.lifecycle,current.context));
});
