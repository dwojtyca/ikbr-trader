import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsExecutionClient, type OwnedOrderCancellation, type PreparedBrokerOrder } from "./tws-execution-client.js";

class FakeIb extends EventEmitter {
  connections = 0;
  cancels: number[] = [];
  orders: number[] = [];
  onCancel = (_id: number): void => {};
  connect(): void { this.connections++; queueMicrotask(() => this.emit("nextValidId", 20)); }
  disconnect(): void { this.emit("disconnected"); }
  cancelOrder(id: number): void { this.cancels.push(id); this.onCancel(id); }
  placeOrder(id: number): void {
    this.orders.push(id);
    this.emit("orderStatus", id, "Submitted", 0, 1, 0, 70, 0, 0, 4);
  }
  ack(status = "Cancelled", perm = 70, client = 4): void {
    this.emit("orderStatus", 20, status, 0, 1, 0, perm, 0, 0, client);
  }
}
async function fixture() {
  const ib = new FakeIb();
  const client = new TwsExecutionClient({host:"unused", port:0, clientId:4,
    securityType:"STK",exchange:"SMART",currency:"USD",orderTimeoutMs:20},()=>{},undefined,undefined,undefined,{ib});
  await client.connect();
  const input: OwnedOrderCancellation = {brokerOrderId:"20", orderRef:"owned-ref", permId:"70",
    accountId:"PAPER", conid:123, clientId:4, expectedGeneration:client.getConnectionGeneration(),
    observedAt:new Date().toISOString()};
  return {ib,client,input};
}
for (const status of ["Cancelled", "ApiCancelled"]) {
  test(`owned cancel waits through pending to exact ${status}`, async () => {
    const {ib,client,input} = await fixture();
    let pending = true;
    ib.onCancel = () => { ib.ack("PendingCancel"); queueMicrotask(() => { pending = false; ib.ack(status); }); };
    const result = await client.cancelOwnedOrder(input);
    assert.equal(pending, false);
    assert.equal(result.status, "CANCELLED");
    assert.equal(result.permId,"70");
    assert.equal(result.connectionGeneration,input.expectedGeneration);
    assert.deepEqual(ib.cancels,[20]);
    assert.equal(ib.listenerCount("disconnected"),1);
  });
}
for (const scenario of ["wrong perm", "wrong client", "inactive", "filled", "10147", "timeout", "pending", "reconnect"]) {
  test(`owned cancel refuses ${scenario}`, async () => {
    const {ib,client,input} = await fixture();
    ib.onCancel = () => {
      if (scenario === "wrong perm") ib.ack("Cancelled",71);
      if (scenario === "wrong client") ib.ack("Cancelled",70,9);
      if (scenario === "inactive") ib.ack("Inactive");
      if (scenario === "filled") ib.ack("Filled");
      if (scenario === "10147") ib.emit("error",{reqId:20,code:10147,message:"missing"});
      if (scenario === "pending") ib.ack("PendingCancel");
      if (scenario === "reconnect") { ib.emit("disconnected"); ib.emit("connected"); ib.ack(); }
    };
    await assert.rejects(client.cancelOwnedOrder(input), /CLOSE_/);
    assert.deepEqual(ib.cancels,[20]);
    assert.equal(ib.listenerCount("orderStatus"),1);
    assert.equal(ib.listenerCount("error"),1);
    assert.equal(ib.listenerCount("disconnected"),1);
  });
}
for (const mutation of ["disconnect", "reconnect", "stale", "foreign client", "missing perm", "missing ref"]) {
  test(`owned cancel preflight ${mutation} sends zero writes`, async () => {
    const {ib,client,input} = await fixture();
    if (mutation === "disconnect" || mutation === "reconnect") client.disconnect();
    if (mutation === "reconnect") await client.connect();
    const altered = {...input,
      ...(mutation === "stale" ? {observedAt:new Date(Date.now()-11_000).toISOString()} : {}),
      ...(mutation === "foreign client" ? {clientId:5} : {}),
      ...(mutation === "missing perm" ? {permId:"0"} : {}),
      ...(mutation === "missing ref" ? {orderRef:""} : {})};
    await assert.rejects(client.cancelOwnedOrder(altered),/CLOSE_/);
    assert.deepEqual(ib.cancels,[]);
  });
}
function prepared(): PreparedBrokerOrder {
  return {
    contract:{conId:123,symbol:"TEST",secType:"STK",currency:"USD",exchange:"SMART"},
    normalizedTicket:{instrument:"TEST",reason:"full close",confidence:1,timestamp:new Date().toISOString(),riskCheckStatus:"PASS",side:"SELL",quantity:1,entry:100,orderType:"LMT",positionEffect:"CLOSE_OR_REDUCE"},
    plan:{parentOrderId:20,relatedOrderIds:new Set([20]),orders:[{orderId:20,order:{action:"SELL",totalQuantity:1,orderType:"LMT",lmtPrice:100,account:"PAPER",orderRef:"owned-close",transmit:true}}]},
    legs:[{role:"PARENT",roleOrdinal:0,brokerOrderId:"20",orderRef:"owned-close"}],
  };
}
for (const reconnect of [false,true]) {
  test(`strict close dispatch rejects disconnected/reconnected generation: ${reconnect}`, async () => {
    const {ib,client,input} = await fixture();
    client.disconnect();
    if (reconnect) await client.connect();
    const connections = ib.connections;
    assert.throws(()=>client.dispatchPreparedClose(prepared(),input.expectedGeneration),/CLOSE_CONNECTION_CHANGED/);
    assert.deepEqual(ib.orders,[]);
    assert.equal(ib.connections,connections);
  });
}
test("strict close dispatch uses existing persisted plan without reconnect", async () => {
  const {ib,client,input} = await fixture();
  const result = await client.dispatchPreparedClose(prepared(),input.expectedGeneration);
  assert.equal(result.brokerOrderId,"20");
  assert.deepEqual(ib.orders,[20]);
  assert.equal(ib.connections,1);
});
