import { test } from "node:test";
import assert from "node:assert/strict";
import { roundTrip } from "./round-trip-test-fixture.js";
import { evaluateRoundTrip } from "./round-trip-evidence.js";


test("round-trip reports exact owned PLN fills, labelled fees and legitimate broker zero", () => {
  const f = roundTrip(), r = evaluateRoundTrip(f.evidence, f.context);
  assert.equal(r.status, "COMPLETED"); assert.equal(r.accounting, "COMPLETE");
  assert.deepEqual(r.grossPnl, {currency:"PLN",amount:2}); assert.equal(r.netPnlPLN,1);
  assert.equal(r.fills[1].brokerRealizedPnl,0); assert.equal(r.canSubmit,false);
});
test("natural SL exit proves mechanics independently from loss", () => {
  const f = roundTrip(); Object.assign(f.snapshot.executions[1], {brokerOrderId:"102",orderRef:"test-SL",permId:"1002",price:99});
  Object.assign(f.evidence.fills[1], {broker_order_id:"102",price:99});
  const r = evaluateRoundTrip(f.evidence,f.context); assert.equal(r.status,"COMPLETED"); assert.equal(r.netPnlPLN,-2);
});
test("explicit full-close fill is linked to its own proposal", () => {
  const f = roundTrip(); const link = {...f.links[0],proposed_order_id:43,broker_order_id:"104",order_ref:"close",perm_id:"1004"};
  f.evidence.close = {state:"COMPLETED",accountId:"DU_TEST",conid:"123",originalHash:f.review.client_order_hash,closeProposalId:43,links:[link]};
  Object.assign(f.snapshot.executions[1], {brokerOrderId:"104",orderRef:"close",permId:"1004"});
  Object.assign(f.evidence.fills[1], {broker_order_id:"104",proposed_order_id:43});
  assert.equal(evaluateRoundTrip(f.evidence,f.context).status,"COMPLETED");
});
for (const mode of ["missing", "foreign", "zero"] as const) test(`commission ${mode} preserves currency honesty`, () => {
  const f = roundTrip(); f.evidence.fills[1].commission = mode === "missing" ? null : 0;
  if (mode === "foreign") f.evidence.fills[1].commission_currency = "EUR";
  const r = evaluateRoundTrip(f.evidence,f.context); assert.equal(r.status,"COMPLETED");
  assert.equal(r.accounting, mode === "missing" ? "PENDING_FEES" : mode === "foreign" ? "MIXED_CURRENCY" : "COMPLETE");
  assert.equal(r.netPnlPLN,mode === "zero" ? 1.5 : null);
});
const invalid: Array<[string,(f:ReturnType<typeof roundTrip>)=>void]> = [
  ["missing window",f=>{f.evidence.window=null;}],
  ["wrong window proposal",f=>{f.evidence.window!.consumedProposalId=999;}],
  ["wrong window account",f=>{f.evidence.window!.accountId="OTHER";}],
  ["attempt outside window",f=>{f.evidence.window!.startsAt=new Date(f.context.nowMs-10000);}],
  ["stale",f=>{f.context.nowMs+=10000;}], ["session",f=>{f.context.sessionId="other";}],
  ["partial",f=>{f.snapshot.executions[1].shares=.5;f.evidence.fills[1].shares=.5;}],
  ["wrong account",f=>{f.evidence.fills[1].account_id="OTHER";}],
  ["wrong contract",f=>{f.evidence.fills[1].conid="999";}],
  ["wrong proposal",f=>{f.evidence.fills[1].proposed_order_id=999;}],
  ["wrong currency",f=>{f.evidence.fills[1].currency="USD";}],
  ["wrong price",f=>{f.evidence.fills[1].price=103;}],
  ["missing fill",f=>{f.evidence.fills.pop();}], ["duplicate fill",f=>{f.evidence.fills.push(f.evidence.fills[0]);}],
  ["unknown execution",f=>{f.snapshot.executions[1].orderRef="foreign";}],
  ["missing risk",f=>{Object.assign(f.review,{risk_evidence:null});}],
  ["missing approval",f=>{f.review.status="PENDING";}],
  ["non-clean reconciliation",f=>{f.run.status="INCOMPLETE";}],
  ["incomplete position",f=>{f.evidence.lifecycle.positionSnapshot!.complete=false;}],
  ["unrelated open position",f=>{f.evidence.lifecycle.positionSnapshot!.positions.push({accountId:"DU_TEST",sessionId:"current",conid:"999",instrument:"OTHER",quantity:1,observedAt:f.evidence.lifecycle.positionSnapshot!.observedAt});}],
];
for (const [name,mutate] of invalid) test(`${name} cannot prove round-trip acceptance`, () => {
  const f=roundTrip(); mutate(f); const r=evaluateRoundTrip(f.evidence,f.context);
  assert.equal(r.status,"NOT_PROVEN"); assert.ok(r.reasons.length); assert.equal(r.netPnlPLN,null);
});
test("foreign-account fills cannot fund a missing own exit", () => {
  const f=roundTrip(); f.snapshot.executions[1].accountId="OTHER";
  assert.equal(evaluateRoundTrip(f.evidence,f.context).status,"NOT_PROVEN");
});
test("unrelated same-account working orders prevent clean acceptance", () => {
  const f=roundTrip(); f.snapshot.openOrders.push({accountId:"DU_TEST",conId:"999",brokerOrderId:"999",orderRef:"other",permId:"9999",clientId:7,status:"Submitted",remaining:1,filled:0,action:"BUY"});
  f.coverage.openOrders.count=1;
  const r=evaluateRoundTrip(f.evidence,f.context);assert.equal(r.status,"NOT_PROVEN");assert.ok(r.reasons.includes("account_working_orders_remain"));
});
test("zero complete round-trip net is retained as zero", () => {
  const f=roundTrip(); f.evidence.fills[1].commission=1.5;
  assert.equal(evaluateRoundTrip(f.evidence,f.context).netPnlPLN,0);
});

test("protective child without denormalized proposal id remains linked by exact broker evidence", () => {
  const f=roundTrip(); f.evidence.fills[1].proposed_order_id=null;
  assert.equal(evaluateRoundTrip(f.evidence,f.context).status,"COMPLETED");
});
