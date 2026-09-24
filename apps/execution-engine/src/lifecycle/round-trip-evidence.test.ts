import { test } from "node:test";
import assert from "node:assert/strict";
import { roundTrip, roundTripWithSmr } from "./round-trip-test-fixture.js";
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
  ["target residual position",f=>{f.evidence.lifecycle.positionSnapshot!.positions.push({accountId:"DU_TEST",sessionId:"current",conid:"123",instrument:"TEST",quantity:1,observedAt:f.evidence.lifecycle.positionSnapshot!.observedAt});}],
];
for (const [name,mutate] of invalid) test(`${name} cannot prove round-trip acceptance`, () => {
  const f=roundTrip(); mutate(f); const r=evaluateRoundTrip(f.evidence,f.context);
  assert.equal(r.status,"NOT_PROVEN"); assert.ok(r.reasons.length); assert.equal(r.netPnlPLN,null);
});
test("foreign-account fills cannot fund a missing own exit", () => {
  const f=roundTrip(); f.snapshot.executions[1].accountId="OTHER";
  assert.equal(evaluateRoundTrip(f.evidence,f.context).status,"NOT_PROVEN");
});
for (const quantity of [4172, -4172]) test(`SMR position ${quantity}, manual sell and fills do not contaminate the WSE round trip`, () => {
  const f = roundTripWithSmr(); f.snapshot.positions[0].position = quantity;
  f.evidence.lifecycle.positionSnapshot!.positions[0].quantity = quantity;
  const r = evaluateRoundTrip(f.evidence, f.context);
  assert.equal(r.status, "COMPLETED"); assert.equal(r.completionScope, "INSTRUMENT");
  assert.equal(r.conid, "123"); assert.equal(r.netPnlPLN, 1);
  assert.deepEqual(r.fills.map(fill => fill.execId), ["fill-1", "fill-2"]);
  assert.deepEqual(r.commissionsByCurrency, { PLN: 1 });
  assert.deepEqual(r.outsideScope, { positionObservedAt: f.evidence.lifecycle.positionSnapshot!.observedAt,
    ordersObservedAt: f.snapshot.capturedAt, positions: [{ conid: "559289446", instrument: "SMR", quantity }], workingOrderCount: 1 });
});

const invalidMixed: Array<[string, (f: ReturnType<typeof roundTripWithSmr>) => void]> = [
  ["target working order", f => { f.snapshot.openOrders[0].conId = "123"; }],
  ["target broker position", f => { f.snapshot.positions[0].conId = "123"; f.snapshot.positions[0].position = 1; }],
  ["duplicate target positions", f => { const sync=f.evidence.lifecycle.positionSnapshot!;
    sync.positions.push(...[0,0].map(quantity=>({accountId:"DU_TEST",sessionId:"current",conid:"123",instrument:"TEST",quantity,observedAt:sync.observedAt}))); }],
  ["contradictory target positions", f => { const sync=f.evidence.lifecycle.positionSnapshot!;
    sync.positions.push(...[1,-1].map(quantity=>({accountId:"DU_TEST",sessionId:"current",conid:"123",instrument:"TEST",quantity,observedAt:sync.observedAt}))); }],
  ["foreign snapshot account", f => { f.evidence.lifecycle.positionSnapshot!.positions[0].accountId="OTHER"; }],
  ["wrong snapshot session", f => { f.evidence.lifecycle.positionSnapshot!.positions[0].sessionId="old"; }],
  ["stale outside position", f => { f.evidence.lifecycle.positionSnapshot!.positions[0].observedAt=new Date(f.context.nowMs-20000); }],
  ["incomplete snapshot", f => { f.evidence.lifecycle.positionSnapshot!.complete=false; }],
  ["wrong generation", f => { f.evidence.lifecycle.positionSnapshot!.generation=2; }],
  ["active account hold", f => { f.evidence.lifecycle.activeHoldCount=1; }],
  ["non-CLEAN run", f => { f.run.status="INCOMPLETE"; }],
  ["missing order account", f => { f.snapshot.openOrders[0].accountId=""; }],
  ["missing position account", f => { f.snapshot.positions[0].accountId=""; }],
  ["nonfinite outside broker quantity", f => { f.snapshot.positions[0].position=NaN; }],
  ["nonfinite outside snapshot quantity", f => { f.evidence.lifecycle.positionSnapshot!.positions[0].quantity=NaN; }],
];
for (const identity of ["", " ", "unknown", "0", "00123", "1e2"]) {
  invalidMixed.push([`outside order conid ${JSON.stringify(identity)}`, f=>{f.snapshot.openOrders[0].conId=identity;}]);
  invalidMixed.push([`outside snapshot conid ${JSON.stringify(identity)}`, f=>{f.evidence.lifecycle.positionSnapshot!.positions[0].conid=identity;}]);
  invalidMixed.push([`outside broker position conid ${JSON.stringify(identity)}`, f=>{f.snapshot.positions[0].conId=identity;}]);
}
for (const [field,value] of [["brokerOrderId","100"],["orderRef","test-PARENT"],["permId","1000"]] as const)
  invalidMixed.push([`SMR order reuses owned ${field}`, f=>{f.snapshot.openOrders[0][field]=value;}]);
for (const [name, mutate] of invalidMixed) test(`${name} cannot be hidden as outside-scope activity`, () => {
  const f=roundTripWithSmr(); mutate(f);
  const result=evaluateRoundTrip(f.evidence,f.context);
  assert.equal(result.status,"NOT_PROVEN"); assert.equal(result.netPnlPLN,null); assert.ok(result.reasons.length);
});
test("zero complete round-trip net is retained as zero", () => {
  const f=roundTrip(); f.evidence.fills[1].commission=1.5;
  assert.equal(evaluateRoundTrip(f.evidence,f.context).netPnlPLN,0);
});

test("protective child without denormalized proposal id remains linked by exact broker evidence", () => {
  const f=roundTrip(); f.evidence.fills[1].proposed_order_id=null;
  assert.equal(evaluateRoundTrip(f.evidence,f.context).status,"COMPLETED");
});
