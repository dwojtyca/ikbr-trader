import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TwsExecutionClient, type PreparedBrokerOrder } from "./tws-execution-client.js";

for (const stage of ["missing", "expired", "during connect", "before first wire", "valid", "close", "permit missing", "permit rejected", "permit timeout", "permit duplicate", "permit expired", "permit commit failure", "permit disconnect"]) {
  test(`AAPL dispatcher ${stage} preserves entry deadline and close exemption`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-24T15:00:00Z") });
    let writes = 0, expireOnLog = false;
    class FakeIb extends EventEmitter {
      connect() { queueMicrotask(() => this.emit("nextValidId", 20)); }
      disconnect() { this.emit("disconnected"); }
      placeOrder(id: number) { writes++; queueMicrotask(() => this.emit("orderStatus", id, "Submitted", 0, 1, 0, id + 100, 0, 0, 4)); }
    }
    const ib = new FakeIb();
    const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 4, securityType: "STK",
      exchange: "SMART", currency: "USD", orderTimeoutMs: 100 }, () => { if (expireOnLog) t.mock.timers.tick(1000); },
      undefined, undefined, undefined, { ib });
    await client.connect(); t.after(() => client.disconnect());
    const close = stage === "close";
    const prepared: PreparedBrokerOrder = { contract: { conId: 265598, symbol: "AAPL", secType: "STK", exchange: "SMART", currency: "USD" },
      normalizedTicket: { instrument: "AAPL", instrumentId: "aapl_nasdaq", conid: "265598", side: close ? "SELL" : "BUY",
        positionEffect: close ? "CLOSE_OR_REDUCE" : "OPEN_OR_ADD", quantity: 1, orderType: "LMT", entry: 100,
        reason: "fixture", confidence: 1, riskCheckStatus: "PASS", timestamp: new Date().toISOString() },
      legs: [{ role: "PARENT", roleOrdinal: 0, brokerOrderId: "20", orderRef: "fixture" }],
      plan: { parentOrderId: 20, orders: [{ orderId: 20, order: { action: close ? "SELL" : "BUY", totalQuantity: 1,
        orderType: "LMT", lmtPrice: 100, orderRef: "fixture", tif: "DAY", transmit: true } }], relatedOrderIds: new Set([20]) } };
    const deadline = Date.now() + 1000;
    if (stage === "expired") t.mock.timers.tick(1000);
    if (stage === "during connect") {
      const connect = client.connect.bind(client);
      client.connect = async () => { await connect(); t.mock.timers.tick(1000); };
    }
    if (stage === "before first wire") {
      const on = ib.on.bind(ib);
      t.mock.method(ib, "on", (event: string, listener: (...args: unknown[]) => void) => {
        if (event === "orderStatus") t.mock.timers.tick(1000);
        return on(event, listener);
      });
    }
    expireOnLog = false;
    let lateSend: (() => void) | undefined;
    const permit = async (send: () => void) => {
      lateSend = send;
      if (stage === "permit rejected") throw new Error("fixture_permit_rejected");
      if (stage === "permit timeout") { await new Promise<void>(() => undefined); return; }
      if (stage === "permit expired") t.mock.timers.tick(1000);
      if (stage === "permit disconnect") client.disconnect();
      send();
      if (stage === "permit duplicate") send();
      if (stage === "permit commit failure") throw new Error("fixture_commit_failure");
    };
    const dispatch = () => client.dispatchPreparedOrder(prepared, stage === "missing" || close ? undefined : deadline, stage === "permit missing" ? undefined : permit);
    if (stage === "valid" || close) { await dispatch(); assert.equal(writes, 1); }
    else if (stage.startsWith("permit ")) {
      await assert.rejects(dispatch);
      assert.equal(writes, ["permit duplicate", "permit commit failure"].includes(stage) ? 1 : 0);
      if (lateSend) assert.throws(lateSend, /permit_inactive/);
    } else { await assert.rejects(dispatch, /aapl_window_dispatch_expired/); assert.equal(writes, 0); }
  });
}
