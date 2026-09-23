import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsExecutionClient, type BrokerOrderStatusUpdate } from "./tws-execution-client.js";
import { IbBrokerReconciliationAdapter } from "./reconciliation/ib-broker-adapter.js";

class FakeIb extends EventEmitter {
  cancelCalls: number[] = [];
  onCancel: (id: number) => void = () => {};
  connect(): void { queueMicrotask(() => this.emit("nextValidId", 1)); }
  cancelOrder(id: number): void { this.cancelCalls.push(id); this.onCancel(id); }
  reqManagedAccts(): void { this.emit("managedAccounts", "PAPER"); }
  reqPositions(): void {
    for (const account of ["PAPER", "OTHER", undefined]) {
      this.emit("position", account, { symbol: "TEST", conId: 123 }, 1, 100);
    }
    this.emit("positionEnd");
  }
  cancelPositions(): void {}
  reqAllOpenOrders(): void {
    for (const [i, account] of ["PAPER", "OTHER", undefined].entries()) {
      this.emit("openOrder", i + 1, { symbol: "TEST", conId: 123 },
        { account, orderRef: `ref-${i}`, action: "BUY" }, { status: "Submitted" });
    }
    this.emit("openOrderEnd");
  }
  reqExecutions(id: number): void {
    for (const [i, acctNumber] of ["PAPER", "OTHER", undefined].entries()) {
      this.emit("execDetails", id, { symbol: "TEST", conId: 123 }, {
        execId: `e-${i}`, orderId: i + 1, acctNumber, side: "BOT", shares: 1, price: 100,
      });
    }
    this.emit("execDetailsEnd", id);
  }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function makeClient(ib: FakeIb, updates: BrokerOrderStatusUpdate[] = [], submittedAutoCancelMs = 0) {
  return new TwsExecutionClient({ host: "unused", port: 0, clientId: 1,
    securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 20,
    submittedAutoCancelMs }, () => {}, update => updates.push(update), undefined, undefined, { ib });
}

for (const status of ["Cancelled", "ApiCancelled", "PendingCancel", "Inactive", undefined]) {
  test(`cancel confirmation preserves uncertainty for ${status ?? "timeout"}`, async () => {
    const ib = new FakeIb();
    const client = makeClient(ib);
    ib.onCancel = id => { if (status) ib.emit("orderStatus", id, status, 0, 1); };
    const result = client.cancelBrokerOrder("17");
    if (status === "Cancelled" || status === "ApiCancelled") {
      assert.deepEqual(await result, { brokerOrderId: "17", status: "CANCELLED" });
    } else if (status === "PendingCancel") {
      assert.deepEqual(await result, { brokerOrderId: "17", status: "PENDING_CANCEL" });
    } else {
      await assert.rejects(result, /Timed out waiting cancel confirmation/);
    }
    assert.deepEqual(ib.cancelCalls, [17]);
    assert.equal(ib.listenerCount("orderStatus"), 1);
    assert.equal(ib.listenerCount("error"), 1);
  });
}

test("10147 rejects cancel without a synthetic status", async () => {
  const ib = new FakeIb();
  const updates: BrokerOrderStatusUpdate[] = [];
  const client = makeClient(ib, updates);
  ib.onCancel = id => ib.emit("error", { reqId: id, code: 10147, message: "not found" });
  await assert.rejects(client.cancelBrokerOrder("17"), /code=10147/);
  assert.deepEqual(updates, []);
});

for (const trigger of ["locate", "submitted"] as const) {
  test(`${trigger} auto-cancel 10147 never terminalizes local order`, async () => {
    const ib = new FakeIb();
    const updates: BrokerOrderStatusUpdate[] = [];
    const client = makeClient(ib, updates, trigger === "submitted" ? 1 : 0);
    await client.connect();
    // Seed the context normally registered by a submitted plan; exercise real listeners and cancel method.
    const internal = client as unknown as { openOrderContext: Map<number, unknown> };
    internal.openOrderContext.set(17, { symbol: "TEST", side: "SELL", positionEffect: "OPEN", role: "parent" });
    ib.onCancel = id => ib.emit("error", { reqId: id, code: 10147, message: "not found" });
    if (trigger === "locate") {
      ib.emit("error", { reqId: 17, code: 404, message: "held while securities are located" });
      await turn();
    } else {
      ib.emit("orderStatus", 17, "Submitted", 0, 1);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.deepEqual(ib.cancelCalls, [17]);
    assert.ok(updates.every(update => update.status !== "CANCELLED"));
    assert.ok(internal.openOrderContext.has(17));
  });
}

test("raw broker accounts survive snapshot methods and production adapter without requested-account fallback", async () => {
  const ib = new FakeIb();
  const client = makeClient(ib);
  await client.connect();
  const options = { timeoutMs: 100, abortSignal: new AbortController().signal };
  const orders = await client.reqAllOpenOrdersSnapshot(options);
  assert.deepEqual(orders.rows.map(row => row.accountId), ["PAPER", "OTHER", undefined]);
  const executions = await client.reqExecutionsSnapshot({ ...options, accountId: "PAPER", since: new Date() });
  assert.deepEqual(executions.rows.map(row => row.accountId), ["PAPER", "OTHER", ""]);
  const positions = await client.reqPositionsSnapshot(options);
  assert.deepEqual(positions.rows.map(row => row.accountId), ["PAPER", "OTHER", ""]);
  const snapshot = await new IbBrokerReconciliationAdapter(client).capture({
    accountId: "PAPER", sessionId: "session", sessionStartedAt: new Date(),
    safetyMarginMs: 0, sourceTimeoutMs: 100, abortSignal: options.abortSignal,
  });
  assert.deepEqual(snapshot.openOrders.map(row => row.accountId), ["PAPER", "OTHER", null]);
  assert.deepEqual(snapshot.executions.map(row => row.accountId), ["PAPER", "OTHER", ""]);
  assert.deepEqual(snapshot.positions.map(row => row.accountId), ["PAPER", ""]);
  assert.equal(snapshot.exposureComplete, true);
});

for (const raw of [undefined, "", "nonsense", "20260230 12:00:00 UTC", "20260923 24:00:00 UTC",
  "20260923 12:00:00 US/Eastern", "20260923 12:00:00", "20260923 12:00:00 UTC trailing",
  "20260923 12:00:00 UTC", "20260923 12:00:00 GMT"]) {
  test(`execution snapshot preserves timestamp provenance for ${raw ?? "missing"}`, async () => {
    const ib = new FakeIb();
    ib.reqExecutions = id => {
      ib.emit("execDetails", id, {conId:123}, {execId:"one",orderId:1,acctNumber:"PAPER",shares:1,side:"BOT",time:raw});
      ib.emit("execDetailsEnd", id);
    };
    const rows = (await makeClient(ib).reqExecutionsSnapshot({accountId:"PAPER",since:new Date(),timeoutMs:100,
      abortSignal:new AbortController().signal})).rows;
    const valid = raw === "20260923 12:00:00 UTC" || raw === "20260923 12:00:00 GMT";
    assert.equal(JSON.parse(JSON.stringify(rows))[0].executedAt, valid ? "2026-09-23T12:00:00.000Z" : null);
  });
}

for (const raw of ["20260923 12:00:00", "20260230 12:00:00", "20260923 12:00:00 US/Eastern"]) {
  test(`explicit Gateway UTC configuration accepts only valid bare timestamps: ${raw}`, async () => {
    const ib = new FakeIb();
    ib.reqExecutions = id => {
      ib.emit("execDetails", id, {conId:123}, {execId:"one",orderId:1,acctNumber:"PAPER",shares:1,side:"BOT",time:raw});
      ib.emit("execDetailsEnd", id);
    };
    const client = new TwsExecutionClient({host:"unused",port:0,clientId:1,securityType:"STK",exchange:"SMART",currency:"USD",
      orderTimeoutMs:100,executionTimeZone:"UTC"},()=>{},undefined,undefined,undefined,{ib});
    const rows = (await client.reqExecutionsSnapshot({accountId:"PAPER",since:new Date(),timeoutMs:100,
      abortSignal:new AbortController().signal})).rows;
    assert.equal(JSON.parse(JSON.stringify(rows))[0].executedAt,
      raw === "20260923 12:00:00" ? "2026-09-23T12:00:00.000Z" : null);
  });
}
