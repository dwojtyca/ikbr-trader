import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AccountingSourceCollector, normalizeAccountingCommission, normalizeAccountingExecution, type AccountingSocket } from "./source-collector.js";
import type { SourceSettingsV1 } from "./types.js";

const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: "ibkr-tws-seven-day-v1", environment: "paper", accountId: "TEST-ONLY",
  endpoint: { host: "unused", port: 1 }, sourceClientId: 0, executionTimeZone: "Europe/Warsaw" };
test("canonical timestamps require explicit zone and retain pending price revision", () => {
  const contract = { conId: 1, secType: "STK", symbol: "PKO", currency: "PLN", exchange: "WSE" };
  const exec = { execId: "a.1", acctNumber: settings.accountId, orderId: 1, side: "BOT", shares: 1, price: 2, time: "20260115 15:30:21", pendingPriceRevision: true };
  assert.equal(normalizeAccountingExecution(contract, exec, settings).executedAt, "2026-01-15T14:30:21.000Z");
  assert.equal(normalizeAccountingExecution(contract, exec, settings).pendingPriceRevision, true);
  for (const time of ["20261025 02:30:00", "20260329 02:30:00", "invalid"]) assert.throws(() => normalizeAccountingExecution(contract, { ...exec, time }, settings), /TIMESTAMP_INVALID/);
  assert.throws(() => normalizeAccountingExecution(contract, { ...exec, acctNumber: "FOREIGN" }, settings), /IDENTITY_INVALID/);
  assert.equal(normalizeAccountingCommission({ execId: "a", currency: "PLN", commission: 1, realizedPNL: Number.MAX_VALUE }).realizedPnL, null);
});
test("collector uses client-zero all-account unfiltered replay with preceding broker clock and exact end", async () => {
  class Socket extends EventEmitter implements AccountingSocket {
    serverVersion = 178;
    connect() { this.emit("server", 178, "broker connection"); this.emit("nextValidId", 1); }
    disconnect() { this.emit("disconnected"); }
    reqManagedAccts() { this.emit("managedAccounts", settings.accountId); }
    reqCurrentTime() { this.emit("currentTime", Math.floor(Date.now() / 1000)); }
    reqExecutions(id: number, filter: unknown) {
      assert.deepEqual(filter, { clientId: 0, acctCode: settings.accountId, time: "", symbol: "", secType: "", exchange: "", side: "" });
      this.emit("execDetailsEnd", id + 1); queueMicrotask(() => this.emit("execDetailsEnd", id));
    }
  }
  const events: string[] = [], socket = new Socket();
  const collector = new AccountingSourceCollector(settings, { observe: e => events.push(e.kind), gap: () => {} }, () => socket);
  const result = await collector.replay(100, new AbortController().signal);
  assert.deepEqual(result.executionIds, []); assert.equal(result.generation, 1);
  assert.ok(events.indexOf("clock") < events.indexOf("replay_start")); assert.equal(events.filter(e => e === "replay_end").length, 1);
  collector.close();
});
test("wrong end, clock skew, abort and disconnect never complete a replay", async () => {
  for (const failure of ["end", "clock", "disconnect", "abort"] as const) {
    const socket = new EventEmitter() as EventEmitter & AccountingSocket;
    Object.assign(socket, { serverVersion: 178, connect: () => { socket.emit("server", 178, "time"); socket.emit("nextValidId", 1); }, disconnect: () => {},
      reqManagedAccts: () => socket.emit("managedAccounts", settings.accountId),
      reqCurrentTime: () => socket.emit("currentTime", Math.floor(Date.now() / 1000) + (failure === "clock" ? 100 : 0)),
      reqExecutions: (id: number) => { if (failure === "disconnect") socket.emit("disconnected"); socket.emit("execDetailsEnd", failure === "end" ? id + 1 : id); } });
    const controller = new AbortController(); if (failure === "abort") controller.abort();
    const collector = new AccountingSourceCollector(settings, { observe: () => {}, gap: () => {} }, () => socket);
    await assert.rejects(collector.replay(20, controller.signal));
  }
});
test("fresh sockets fence retired callbacks and ignore unsolicited clocks before request", async () => {
  const sockets: Array<EventEmitter & AccountingSocket> = [], events: string[] = [];
  let delayClock = false;
  const collector = new AccountingSourceCollector(settings, { observe: e => events.push(e.kind), gap: () => events.push("gap") }, () => {
    const socket = new EventEmitter() as EventEmitter & AccountingSocket;
    Object.assign(socket, { serverVersion: 178, connect: () => { socket.emit("server", 178, "time"); socket.emit("nextValidId", 1); },
      disconnect: () => socket.emit("disconnected"), reqManagedAccts: () => { socket.emit("currentTime", Math.floor(Date.now() / 1000)); socket.emit("managedAccounts", settings.accountId); },
      reqCurrentTime: () => { if (!delayClock) socket.emit("currentTime", Math.floor(Date.now() / 1000)); },
      reqExecutions: (id: number) => socket.emit("execDetailsEnd", id) }); sockets.push(socket); return socket;
  });
  await collector.replay(100, new AbortController().signal); collector.close(); delayClock = true;
  const replay = collector.replay(1000, new AbortController().signal); await new Promise(resolve => setImmediate(resolve));
  const before = [...events]; sockets[0].emit("currentTime", Math.floor(Date.now() / 1000)); sockets[0].emit("disconnected");
  assert.deepEqual(events, before); assert.equal(events.filter(e => e === "clock").length, 1);
  sockets[1].emit("currentTime", Math.floor(Date.now() / 1000)); assert.equal((await replay).generation, 2);
  collector.close();
});
test("invalid first clock records bounded evidence and cannot accept a later good callback", async () => {
  for (const value of [NaN, Infinity, -Infinity, 1.5, 1e20, "not a number", {}, Math.floor(Date.now() / 1000) - 10]) {
    const observed: Array<{ kind: string; value: unknown }> = [], socket = new EventEmitter() as EventEmitter & AccountingSocket;
    Object.assign(socket, { serverVersion: 178, connect: () => { socket.emit("server", 178, "time"); socket.emit("nextValidId", 1); }, disconnect: () => {},
      reqManagedAccts: () => socket.emit("managedAccounts", settings.accountId),
      reqCurrentTime: () => { socket.emit("currentTime", value); socket.emit("currentTime", Math.floor(Date.now() / 1000)); },
      reqExecutions: () => { throw Error("must never replay after rejected clock"); } });
    const collector = new AccountingSourceCollector(settings, { observe: e => observed.push(e), gap: () => {} }, () => socket);
    await assert.rejects(collector.replay(100, new AbortController().signal), /CLOCK_INVALID/);
    const rejected = observed.filter(e => e.kind === "clock_rejected"); assert.equal(rejected.length, 1);
    assert.equal(observed.some(e => e.kind === "clock"), false); assert.ok(JSON.stringify(rejected[0]).length < 700);
  }
});
