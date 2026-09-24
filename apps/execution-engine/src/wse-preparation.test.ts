import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import type { SignalTicket } from "@ikbr/shared";
import { fixture } from "./lifecycle/close-test-fixture.js";
import { TwsExecutionClient } from "./tws-execution-client.js";
import { wseMetadataFixture } from "./wse-market-rules.fixture.js";

class FakeIb extends EventEmitter {
  orders: Array<{ id: number; contract: unknown; order: Record<string, unknown> }> = [];
  contractRequests = 0;
  connect() { queueMicrotask(() => this.emit("nextValidId", 20)); }
  disconnect() { this.emit("disconnected"); }
  reqContractDetails() { this.contractRequests++; throw new Error("legacy resolver must not run"); }
  placeOrder(id: number, contract: unknown, order: Record<string, unknown>) {
    this.orders.push({ id, contract, order });
    queueMicrotask(() => this.emit("orderStatus", id, "Submitted", 0, 1, 0, id + 100, 0, 0, 4));
  }
}
async function setup(t: TestContext, close = false, pko = false) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-24T10:00:00Z") });
  const bound = fixture().context.bound!;
  Object.assign(bound, { currency: "PLN", exchange: "WSE", minTick: .0001 });
  Object.assign(bound.instrument, { currency: "PLN", exchange: "WSE" });
  if (pko) {
    Object.assign(bound,{instrumentId:"pko_wse",brokerSymbol:"PKO",conId:35146360,localSymbol:"PKO",tradingClass:"PKO"});
    Object.assign(bound.instrument,{id:"pko_wse",brokerSymbol:"PKO",conId:35146360,localSymbol:"PKO"});
  }
  const metadata = wseMetadataFixture(bound, "PAPER", Date.now());
  metadata.priceIncrements = [{ lowEdge: 0, increment: .01 }, { lowEdge: 100, increment: .05 }];
  const ib = new FakeIb();
  const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK",
    exchange: "SMART", currency: "USD", orderTimeoutMs: 30 }, () => {}, undefined, undefined, undefined,
    { ib, resolveBoundInstrument: id => id === bound.instrumentId ? bound : undefined,
      loadWseMetadata: async () => metadata });
  await client.connect(); t.after(() => client.disconnect());
  const ticket: SignalTicket = { instrument: bound.brokerSymbol, instrumentId: bound.instrumentId, conid: String(bound.conId),
    side: close ? "SELL" : "BUY", positionEffect: close ? "CLOSE_OR_REDUCE" : "OPEN_OR_ADD", quantity: 1,
    orderType: "LMT", entry: 100.05, ...(close ? {} : { stop: 99.99, takeProfit: 102.1 }),
    reason: "test", confidence: 1, riskCheckStatus: "PASS", timestamp: new Date().toISOString() };
  const prepare = () => client.prepareBrokerOrderPlan(ticket, "PAPER", "DAY", { proposedOrderId: 1, clientOrderId: "wse-test" });
  return { ib, client, ticket, metadata, bound, prepare };
}
for (const close of [false, true]) test(`strict WSE ${close ? "close" : "bracket"} uses exact per-leg rules, no legacy resolver`, async t => {
  const f = await setup(t, close), p = await f.prepare();
  assert.deepEqual(p.normalizedTicket, f.ticket);
  assert.equal(f.ib.contractRequests, 0);
  if (close) await f.client.dispatchPreparedClose(p, f.client.getConnectionGeneration());
  else await f.client.dispatchPreparedOrder(p);
  assert.deepEqual(f.ib.orders.map(x => x.order.orderType === "STP" ? x.order.auxPrice : x.order.lmtPrice), close ? [100.05] : [100.05, 102.1, 99.99]);
});
for (const mutation of ["entry", "stop", "tp", "fraction", "closed", "missing date", "wrong account", "stale", "foreign contract"]) {
  test(`WSE preparation refuses ${mutation} before writes`, async t => {
    const f = await setup(t);
    if (mutation === "entry") f.ticket.entry = 100.01;
    if (mutation === "stop") f.ticket.stop = 99.991;
    if (mutation === "tp") f.ticket.takeProfit = 102.01;
    if (mutation === "fraction") f.ticket.quantity = .5;
    if (mutation === "closed") f.metadata.liquidHours = "20260924:CLOSED";
    if (mutation === "missing date") f.metadata.liquidHours = "20260925:0900-20260925:1700";
    if (mutation === "wrong account") f.metadata.accountId = "OTHER";
    if (mutation === "stale") f.metadata.requestStartedAtMs -= 60000;
    if (mutation === "foreign contract") f.metadata.conId++;
    await assert.rejects(f.prepare());
    assert.equal(f.ib.orders.length, 0); assert.equal(f.ib.contractRequests, 0);
  });
}
for (const mutation of ["expiry", "cutoff", "generation", "wire", "contract", "ticket"]) test(`WSE dispatch fences ${mutation}`, async t => {
  const f = await setup(t);
  if (mutation === "cutoff") {
    t.mock.timers.setTime(new Date("2026-09-24T14:44:59Z").getTime());
    Object.assign(f.metadata, wseMetadataFixture(f.bound, "PAPER", Date.now()));
  }
  const p = await f.prepare();
  if (mutation === "expiry") t.mock.timers.setTime(Date.now() + 60000);
  if (mutation === "cutoff") t.mock.timers.setTime(Date.now() + 1000);
  if (mutation === "generation") { f.client.disconnect(); await f.client.connect(); }
  if (mutation === "wire") p.plan.orders[1].order.lmtPrice = 102.01;
  if (mutation === "contract") p.contract.currency = "USD";
  if (mutation === "ticket") p.normalizedTicket.entry = 100.01;
  await assert.rejects(f.client.dispatchPreparedOrder(p));
  assert.equal(f.ib.orders.length, 0);
});
test("WSE legacy direct route and untracked prepared objects cannot dispatch", async t => {
  const f = await setup(t);
  await assert.rejects(f.client.placeSignalOrder(f.ticket, "PAPER", "DAY", { proposedOrderId: 1 }), /WSE_BOUND_PREPARATION_REQUIRED/);
  const p = await f.prepare();
  await assert.rejects(f.client.dispatchPreparedOrder({ ...p }), /WSE_PREPARATION_REQUIRED/);
  assert.equal(f.ib.orders.length, 0);
});

for (const stage of ["missing", "expired", "during connect", "before first wire"]) test(`PKO entry deadline ${stage} sends no orders`,async t=>{
  const f=await setup(t,false,true),p=await f.prepare();
  const deadline=Date.now()+1000;
  if(stage==="expired") t.mock.timers.tick(1000);
  if(stage==="during connect") {const connect=f.client.connect.bind(f.client);f.client.connect=async()=>{await connect();t.mock.timers.tick(1000);};}
  if(stage==="before first wire") {
    const original=Date.now;let reads=0;
    t.mock.method(Date,"now",()=>{reads++;return original()+(reads>=3?1000:0);});
  }
  await assert.rejects(()=>f.client.dispatchPreparedOrder(p,stage==="missing"?undefined:deadline),/gpw_window_dispatch_expired/);
  assert.equal(f.ib.orders.length,0);
});
test("PKO valid entry deadline allows bracket",async t=>{
 const f=await setup(t,false,true),p=await f.prepare();
 await f.client.dispatchPreparedOrder(p,Date.now()+1000);assert.equal(f.ib.orders.length,3);
});

test("PKO lifecycle close remains possible without an entry window",async t=>{
 const f=await setup(t,true,true),p=await f.prepare();
 await f.client.dispatchPreparedClose(p,f.client.getConnectionGeneration());assert.equal(f.ib.orders.length,1);
});
