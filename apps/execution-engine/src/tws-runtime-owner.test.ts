import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsExecutionClient, type PreparedBrokerOrder, type RuntimeOwnerGuard } from "./tws-execution-client.js";

class Socket extends EventEmitter {
  writes: number[] = [];
  connect() { queueMicrotask(() => this.emit("nextValidId", 20)); }
  disconnect() { this.emit("disconnected"); }
  placeOrder(id: number) { this.writes.push(id); queueMicrotask(() => this.emit("orderStatus", id, "Submitted", 0, 1)); }
  cancelOrder(id: number) { this.writes.push(id); queueMicrotask(() => this.emit("orderStatus", id, "Cancelled", 0, 1, 0, 70, 0, 0, 4)); }
}
const plan = (close: boolean): PreparedBrokerOrder => ({
  contract: { conId: 123, symbol: "TEST", secType: "STK", currency: "USD", exchange: "SMART" },
  normalizedTicket: { instrument: "TEST", reason: "fixture", confidence: 1, timestamp: new Date().toISOString(), riskCheckStatus: "PASS",
    side: close ? "SELL" : "BUY", quantity: 1, entry: 100, orderType: "LMT", positionEffect: close ? "CLOSE_OR_REDUCE" : "OPEN_OR_ADD" },
  plan: { parentOrderId: 20, relatedOrderIds: new Set([20]), orders: [{ orderId: 20, order: { action: close ? "SELL" : "BUY", totalQuantity: 1, transmit: true } }] },
  legs: [{ role: "PARENT", roleOrdinal: 0, brokerOrderId: "20", orderRef: "ref" }],
});

for (const kind of ["entry", "close", "owned-cancel", "ordinary-cancel"] as const) {
  test(`${kind} delayed final send cannot borrow a successor owner`, async () => {
    const socket = new Socket();
    let generation = 1, release!: () => void, reached!: () => void;
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capture = (): RuntimeOwnerGuard => { const captured = generation; return {
      assertCurrent: () => { if (captured !== generation) throw new Error("STALE_OWNER"); },
      assertInTransaction: async () => { if (captured !== generation) throw new Error("STALE_OWNER"); },
    }; };
    const permit = async (_owner: RuntimeOwnerGuard, send: () => void) => {
      reached(); await gate; send();
    };
    const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
      () => {}, undefined, undefined, undefined, { ib: socket, captureRuntimeOwner: capture, withRuntimeOwnerPermit: permit });
    await client.connect();
    const owner = capture();
    const result = kind === "entry" ? client.dispatchPreparedOrder(plan(false), Date.now() + 1000, send => permit(owner, send))
      : kind === "close" ? client.dispatchPreparedClose(plan(true), client.getConnectionGeneration(), Date.now() + 1000, owner)
      : kind === "ordinary-cancel" ? client.cancelBrokerOrder("20")
      : client.cancelOwnedOrder({ brokerOrderId: "20", orderRef: "ref", permId: "70", accountId: "PAPER", conid: 123, clientId: 4,
        expectedGeneration: client.getConnectionGeneration(), observedAt: new Date().toISOString() }, owner);
    const rejected = assert.rejects(result, /STALE_OWNER/);
    await ready; generation++; release(); await rejected;
    assert.deepEqual(socket.writes, []);
    client.disconnect();
  });
}

test("each bracket leg checks owner immediately and a partial send is never retried", async () => {
  const socket = new Socket(); let valid = true;
  const owner: RuntimeOwnerGuard = { assertCurrent: () => { if (!valid) throw new Error("STALE_OWNER"); }, assertInTransaction: async () => {} };
  const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
    () => {}, undefined, undefined, undefined, { ib: socket, captureRuntimeOwner: () => owner });
  await client.connect();
  socket.placeOrder = id => { socket.writes.push(id); valid = false; };
  const prepared = plan(false); prepared.plan.orders.push({ orderId: 21, order: {} });
  await assert.rejects(client.dispatchPreparedOrder(prepared, Date.now() + 1000, async send => send()), /STALE_OWNER/);
  assert.deepEqual(socket.writes, [20]); client.disconnect();
});

test("lost connect attempt and predecessor socket callbacks cannot restore current transport or ingress", async () => {
  const old = new Socket(), next = new Socket(); let valid = true, updates = 0, fills = 0, commissions = 0;
  const capture = (): RuntimeOwnerGuard => { const captured = valid; return { assertCurrent: () => { if (!captured || !valid) throw new Error("STALE_OWNER"); }, assertInTransaction: async () => {} }; };
  old.connect = () => {};
  const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
    () => {}, () => { updates++; }, () => { fills++; }, () => { commissions++; },
    { ib: old, ibFactory: () => next, captureRuntimeOwner: capture });
  const pending = client.connect(); const rejected = assert.rejects(pending, /OWNER_CHANGED/);
  valid = false; client.disconnect(); old.emit("nextValidId", 20); await rejected;
  assert.equal(client.isConnected(), false);
  valid = true; await client.connect(); const generation = client.getConnectionGeneration();
  old.emit("disconnected"); old.emit("connected"); old.emit("nextValidId", 900);
  old.emit("orderStatus", 20, "Filled", 1, 0);
  old.emit("execDetails", 1, { symbol: "TEST" }, { execId: "x", side: "BOT", shares: 1, price: 100 });
  old.emit("commissionReport", { execId: "x", commission: 1 });
  assert.equal(client.isConnected(), true); assert.equal(client.getConnectionGeneration(), generation);
  assert.deepEqual([updates, fills, commissions], [0, 0, 0]); client.disconnect();
});

test("ordinary cancel rejects a predecessor acknowledgement after its single send", async () => {
  const socket = new Socket(); let generation = 1;
  const capture = (): RuntimeOwnerGuard => { const captured = generation; return {
    assertCurrent: () => { if (captured !== generation) throw new Error("STALE_OWNER"); }, assertInTransaction: async () => {},
  }; };
  const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
    () => {}, undefined, undefined, undefined, { ib: socket, captureRuntimeOwner: capture,
      withRuntimeOwnerPermit: async (_owner, send) => send() });
  await client.connect();
  socket.cancelOrder = id => { socket.writes.push(id); generation++; socket.emit("orderStatus", id, "Cancelled", 0, 1); };
  await assert.rejects(client.cancelBrokerOrder("20"), /STALE_OWNER/);
  assert.deepEqual(socket.writes, [20]); client.disconnect();
});

test("submitted auto-cancel keeps its scheduled origin instead of borrowing a successor", async () => {
  const socket = new Socket(); let generation = 1;
  const capture = (): RuntimeOwnerGuard => { const captured = generation; return {
    assertCurrent: () => { if (captured !== generation) throw new Error("STALE_OWNER"); }, assertInTransaction: async () => {},
  }; };
  const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100, submittedAutoCancelMs: 5 },
    () => {}, undefined, undefined, undefined, { ib: socket, captureRuntimeOwner: capture,
      withRuntimeOwnerPermit: async (_owner, send) => send() });
  await client.connect();
  (client as unknown as { openOrderContext: Map<number, unknown> }).openOrderContext.set(20, { role: "parent", symbol: "TEST", side: "BUY" });
  socket.emit("orderStatus", 20, "Submitted", 0, 1);
  generation++;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(socket.writes, []); client.disconnect();
});

for (const close of [false, true]) for (const boundary of ["ack", "error", "commit", "replaced-socket"] as const) {
  test(`${close ? "close" : "entry"} stale ${boundary} after send retains uncertainty without replay`, async () => {
    const old = new Socket(), next = new Socket(); let generation = 1;
    const capture = (): RuntimeOwnerGuard => { const captured = generation; return {
      assertCurrent: () => { if (captured !== generation) throw new Error("STALE_OWNER"); }, assertInTransaction: async () => {},
    }; };
    const permit = async (_owner: RuntimeOwnerGuard, send: () => void) => { send(); await new Promise(resolve => setImmediate(resolve)); if (boundary === "commit") generation++; };
    const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100 },
      () => {}, undefined, undefined, undefined, { ib: old, ibFactory: () => next, captureRuntimeOwner: capture, withRuntimeOwnerPermit: permit });
    await client.connect();
    old.placeOrder = id => {
      old.writes.push(id);
      queueMicrotask(() => { void (async () => {
        if (boundary !== "commit") generation++;
        if (boundary === "replaced-socket") { client.disconnect(); await client.connect(); }
        if (boundary === "error") old.emit("error", { reqId: id, code: 201, message: "old rejection" });
        else old.emit("orderStatus", id, "Submitted", 0, 1);
      })(); });
    };
    const owner = capture();
    const result = close ? client.dispatchPreparedClose(plan(true), client.getConnectionGeneration(), Date.now() + 1000, owner)
      : client.dispatchPreparedOrder(plan(false), Date.now() + 1000, send => permit(owner, send));
    await assert.rejects(result, /STALE_OWNER|CONNECTION_CHANGED/);
    assert.deepEqual(old.writes, [20]); assert.deepEqual(next.writes, []);
    assert.equal(old.listenerCount("orderStatus"), 1); assert.equal(old.listenerCount("error"), 1);
    client.disconnect();
  });
}
