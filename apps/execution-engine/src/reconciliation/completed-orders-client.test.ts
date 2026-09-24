import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletedOrdersClient } from "./completed-orders-client.js";
import { completedFixture, CompletedSocketFixture, completedRecord, captureRequest } from "./completed-test-fixture.js";
import { buildExecutionConfig } from "../config.js";
const request = (signal = new AbortController().signal) => ({ accountId: "DU-TEST", timeoutMs: 1000, abortSignal: signal });

test("completed Filled with zero total preserves broker fill and terminal zero remaining", async () => {
  const f = completedFixture();
  f.socket.handle = () => {
    const [c, o, s] = completedRecord();
    for (let i = 0; i < 2; i++) f.socket.emit("completedOrder", c,
      { ...o, totalQuantity: 0, filledQuantity: 7 }, s);
  };
  const pending = f.client.load(request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.socket.disconnects, 0);
  f.socket.emit("completedOrdersEnd");
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].filled, 7); assert.equal(result.rows[0].remaining, 0);
  assert.equal(result.rows[0].brokerOrderId, null);
  assert.equal(f.socket.disconnects, 1);
});

const invalidQuantities: [string, unknown, unknown, string][] = [
  ...[undefined, "0", -1, NaN, Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER]
    .map((total, i): [string, unknown, unknown, string] => [`total-${i}`, total, 7, "Filled"]),
  ...[undefined, "7", -1, 0, NaN, Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER]
    .map((filled, i): [string, unknown, unknown, string] => [`fill-${i}`, 0, filled, "Filled"]),
  ...["Cancelled", "ApiCancelled", "Inactive"]
    .map((status): [string, unknown, unknown, string] => [status, 0, 7, status]),
  ["positive-total-underfill", 8, 7, "Filled"],
  ["positive-total-overfill", 6, 7, "Filled"],
];
for (const [name, totalQuantity, filledQuantity, status] of invalidQuantities) {
  test(`completed zero-total exception rejects ${name}`, async () => {
    const f = completedFixture();
    f.socket.handle = () => {
      const [c, o, s] = completedRecord();
      f.socket.emit("completedOrder", c, { ...o, totalQuantity, filledQuantity }, { ...s, status });
      f.socket.emit("completedOrdersEnd");
    };
    assert.deepEqual(await f.client.load(request()), { ok: false, rows: [], error: "completed_record_invalid" });
  });
}
test("completed zero-total conflicting fill duplicates fail closed", async () => {
  const f = completedFixture();
  f.socket.handle = () => {
    const [c, o, s] = completedRecord();
    for (const filledQuantity of [7, 8]) f.socket.emit("completedOrder", c,
      { ...o, totalQuantity: 0, filledQuantity }, s);
    f.socket.emit("completedOrdersEnd");
  };
  assert.deepEqual(await f.client.load(request()), { ok: false, rows: [], error: "completed_conflicting_duplicate" });
});

test("completed client waits for end, retains null API ID and deduplicates exact records", async () => {
  const f = completedFixture();
  f.socket.handle = () => { f.socket.emit("completedOrder", ...completedRecord()); f.socket.emit("completedOrder", ...completedRecord()); };
  const promise = f.client.load(request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.socket.disconnects, 0);
  f.socket.emit("completedOrdersEnd");
  const result = await promise;
  assert.equal(result.ok, true); assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].brokerOrderId, null); assert.equal(result.rows[0].permId, "987");
  assert.deepEqual(f.socket.requests, [false]); assert.equal(f.socket.disconnects, 1); assert.deepEqual(f.socket.eventNames(), ["error"]);
});
for (const mode of ["account", "record", "duplicate", "disconnect", "fatal", "early_end", "account_change", "unknown_account", "filled", "status"] as const) {
  test(`completed source fails closed: ${mode}`, async () => {
    const f = completedFixture();
    if (mode === "account") f.socket.accounts = "OTHER";
    if (mode === "early_end") f.socket.connect = () => { f.socket.emit("completedOrdersEnd"); };
    f.socket.handle = () => {
      const [c, o, s] = completedRecord();
      const contract: Record<string, unknown> = { ...c }, order: Record<string, unknown> = { ...o }, state: Record<string, unknown> = { ...s };
      if (mode === "record") contract.conId = -1;
      if (mode === "unknown_account") order.account = "OTHER";
      if (mode === "filled") order.filledQuantity = 2;
      if (mode === "status") state.status = "Submitted";
      f.socket.emit("completedOrder", contract, order, state);
      if (mode === "duplicate") f.socket.emit("completedOrder", contract, { ...order, action: "SELL" }, state);
      if (mode === "disconnect") f.socket.emit("disconnected");
      if (mode === "fatal") f.socket.emit("error", new Error("bad"), 326);
      if (mode === "account_change") f.socket.emit("managedAccounts", "OTHER");
      f.socket.emit("completedOrdersEnd");
    };
    const result = await f.client.load(request());
    assert.equal(result.ok, false); assert.deepEqual(result.rows, []); assert.deepEqual(f.socket.eventNames(), ["error"]);
  });
}
test("completed client ignores informational errors and excludes validated foreign managed account", async () => {
  const f = completedFixture(); f.socket.accounts = "DU-TEST,OTHER";
  f.socket.handle = () => {
    for (const code of [2104, 2106, 2107, 2108, 2158]) f.socket.emit("error", new Error("farm"), code);
    const [c, o, s] = completedRecord(); f.socket.emit("completedOrder", c, { ...o, account: "OTHER" }, s);
    f.socket.emit("completedOrdersEnd");
  };
  assert.deepEqual(await f.client.load(request()), { ok: true, rows: [] });
});
test("timeout and abort cleanup; queued aborted caller never creates a socket", async () => {
  const sockets: CompletedSocketFixture[] = [];
  const client = new CompletedOrdersClient({ host: "unused", port: 1, clientId: 120 }, { createSocket: () => {
    const s = new CompletedSocketFixture(); s.handle = () => {}; sockets.push(s); return s;
  } });
  const a = new AbortController(), b = new AbortController();
  const first = client.load(request(a.signal)), second = client.load(request(b.signal));
  await new Promise(resolve => setImmediate(resolve)); b.abort(); a.abort();
  assert.equal((await first).error, "aborted"); assert.equal((await second).error, "aborted"); assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].eventNames(), ["error"]);
  assert.equal((await client.load({ ...request(), timeoutMs: 10 })).error, "timeout");
  assert.equal(sockets[1].disconnects, 1); assert.deepEqual(sockets[1].eventNames(), ["error"]);
  const aborted = new AbortController(); aborted.abort(); await client.load(request(aborted.signal)); assert.equal(sockets.length, 2);
});
test("concurrent successful requests use fresh serialized sockets", async () => {
  const sockets: CompletedSocketFixture[] = [];
  const client = new CompletedOrdersClient({ host: "unused", port: 1, clientId: 120 }, { createSocket: () => {
    const s = new CompletedSocketFixture(); s.handle = () => {}; sockets.push(s); return s;
  } });
  const a = client.load(request()), b = client.load(request());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sockets.length, 1);
  sockets[0].emit("completedOrdersEnd"); await a;
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sockets.length, 2);
  sockets[1].emit("completedOrdersEnd"); assert.equal((await b).ok, true);
});
test("production adapter completes current-state coverage but never claims ambiguous historical window", async () => {
  const f = completedFixture(); const current = await f.adapter.capture(captureRequest());
  assert.equal(current.recoveryComplete, true); assert.equal(current.sourceCoverage.completedOrders.recoveryScope, "current_state_only");
  const old = await f.adapter.capture({ ...captureRequest(), oldestAmbiguousAttemptedAt: new Date(0) });
  assert.equal(old.exposureComplete, true); assert.equal(old.recoveryComplete, false);
  assert.equal(old.sourceCoverage.completedOrders.available, true); assert.equal(old.sourceCoverage.completedOrders.boundedWindow, false);
});
for (const mode of ["reconnect", "disconnect", "changeAccount"] as const) test(`production composite fence: ${mode}`, async () => {
  const f = completedFixture(); f.socket.handle = () => { f[mode](); f.socket.emit("completedOrdersEnd"); };
  const snapshot = await f.adapter.capture(captureRequest()); assert.equal(snapshot.exposureComplete, false); assert.equal(snapshot.recoveryComplete, false);
});
for (const key of ["EXECUTION_CLIENT_ID", "INGESTION_CLIENT_ID", "BACKTEST_INGESTION_CLIENT_ID", "IBKR_ES_ACQUISITION_CLIENT_ID", "IB_METADATA_CLIENT_ID"]) test(`completed socket ID rejects collision with ${key}`, () => {
  assert.throws(() => buildExecutionConfig({ [key]: "120" }));
});

test("asynchronous shutdown prevents client-ID reuse and contains late SDK errors", async () => {
  const sockets: CompletedSocketFixture[] = [];
  const client = new CompletedOrdersClient({ host: "unused", port: 1, clientId: 120 }, { createSocket: () => {
    const s = new CompletedSocketFixture(); s.disconnect = () => { s.disconnects++; }; sockets.push(s); return s;
  } });
  const a = client.load(request()), b = client.load(request());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sockets.length, 1);
  sockets[0].emit("error", new Error("late TCP error"), 502);
  sockets[0].emit("disconnected"); assert.equal((await a).ok, false);
  sockets[0].emit("error", new Error("after close"), 502);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sockets.length, 2);
  sockets[1].emit("disconnected"); assert.equal((await b).ok, true);
  assert.deepEqual(sockets[0].eventNames(), ["error"]);
});
test("unconfirmed disconnect fences future captures until process restart", async () => {
  let creates = 0; const socket = new CompletedSocketFixture(); socket.disconnect = () => { socket.disconnects++; };
  const client = new CompletedOrdersClient({ host: "unused", port: 1, clientId: 120 }, {
    createSocket: () => { creates++; return socket; }, shutdownTimeoutMs: 10,
  });
  assert.equal((await client.load(request())).error, "completed_disconnect_unconfirmed");
  socket.emit("error", new Error("late"), 502);
  assert.equal((await client.load(request())).error, "completed_disconnect_unconfirmed"); assert.equal(creates, 1);
});
