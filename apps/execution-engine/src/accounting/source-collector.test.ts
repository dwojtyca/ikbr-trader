import { test } from "node:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { EventEmitter } from "node:events";
import { accountingSocketWithTransportClose, AccountingSourceCollector, normalizeAccountingCommission, normalizeAccountingExecution, type AccountingSocket } from "./source-collector.js";
import type { SourceSettingsV1 } from "./types.js";
import type { BrokerPhaseEvent } from '../reconciliation/phase-diagnostics.js';

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
test('phase diagnostics distinguish readiness, unsent clock, missing response and replay end without raw frames', async () => {
  for (const failure of ['ready', 'clock_unsent', 'clock_sent', 'end'] as const) {
    const events: BrokerPhaseEvent[] = [], socket = new EventEmitter() as EventEmitter & AccountingSocket;
    Object.assign(socket, { serverVersion: 178,
      connect: () => { if (failure !== 'ready') { socket.emit('server', 178, 'private'); socket.emit('nextValidId', 1); } },
      disconnect: () => {}, reqManagedAccts: () => socket.emit('managedAccounts', settings.accountId),
      reqCurrentTime: () => {
        socket.emit('sent', [7, 'private-broker-payload']); socket.emit('received', ['49', '1', 'private', 'extra']);
        if (failure !== 'clock_unsent') socket.emit('sent', [49, 1]);
        if (failure === 'end') {
          socket.emit('received', ['49', '1', String(Math.floor(Date.now() / 1000))]);
          socket.emit('currentTime', Math.floor(Date.now() / 1000));
        }
      }, reqExecutions: () => {},
    });
    const collector = new AccountingSourceCollector(settings, { observe: () => {}, gap: () => {} }, () => socket, { emit: event => events.push(event) });
    await assert.rejects(collector.replay(20, new AbortController().signal), /REPLAY_INCOMPLETE/);
    const expected = failure === 'ready' ? 'accounting.ready' : failure === 'end' ? 'accounting.replay_end_wait' : 'accounting.clock_wait';
    assert.ok(events.some(event => event.phase === expected && event.outcome === 'error'));
    if (failure === 'clock_unsent') assert.ok(events.some(event => event.reason === 'clock_send_unobserved'));
    if (failure === 'clock_sent') assert.ok(events.some(event => event.reason === 'clock_response_unavailable'));
    assert.doesNotMatch(JSON.stringify(events), /private|TEST-ONLY|brokerTime|reportedSeconds/);
    const count = events.length; socket.emit('sent', [49, 1]); socket.emit('received', ['49', '1', '123']);
    assert.equal(events.length, count);
  }
});
test("collector uses client-zero all-account unfiltered replay with preceding broker clock and exact end", async () => {
  class Socket extends EventEmitter implements AccountingSocket {
    serverVersion = 178;
    connect() { this.emit("server", 178, "broker connection"); this.emit("nextValidId", 1); }
    disconnect() { this.emit("disconnected"); this.emit("transportClosed"); }
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
      disconnect: () => { socket.emit("disconnected"); socket.emit("transportClosed"); }, reqManagedAccts: () => { socket.emit("currentTime", Math.floor(Date.now() / 1000)); socket.emit("managedAccounts", settings.accountId); },
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

test("retirement waits for transport ack while late data remain fenced", async () => {
  const sockets: Array<EventEmitter & AccountingSocket> = [], observations: string[] = [];
  const collector = new AccountingSourceCollector(settings, { observe: event => observations.push(event.kind), gap: () => {} }, () => {
    const socket = new EventEmitter() as EventEmitter & AccountingSocket;
    Object.assign(socket, { serverVersion: 178, connect: () => { socket.emit("server", 178, "test"); socket.emit("nextValidId", 1); },
      disconnect: () => {}, reqManagedAccts: () => socket.emit("managedAccounts", settings.accountId),
      reqCurrentTime: () => socket.emit("currentTime", Math.floor(Date.now() / 1000)), reqExecutions: (id: number) => socket.emit("execDetailsEnd", id) });
    sockets.push(socket); return socket;
  });
  await collector.replay(100, new AbortController().signal);
  const retiring = collector.retire(100);
  assert.throws(() => collector.connect(), /SOURCE_RETIREMENT_UNKNOWN/);
  const before = [...observations]; sockets[0].emit("currentTime", 1); sockets[0].emit("managedAccounts", "FOREIGN");
  assert.deepEqual(observations, before); assert.equal(sockets.length, 1);
  sockets[0].emit("disconnected"); assert.throws(() => collector.connect(), /SOURCE_RETIREMENT_UNKNOWN/);
  sockets[0].emit("transportClosed"); assert.equal(await retiring, true);
  assert.equal((await collector.replay(100, new AbortController().signal)).generation, 2);
  const cleanup = collector.retire(100); sockets[1].emit("disconnected"); sockets[1].emit("transportClosed"); assert.equal(await cleanup, true);
});
test("missing retirement ack times out and prevents replacement socket", async () => {
  let created = 0;
  const collector = new AccountingSourceCollector(settings, { observe: () => {}, gap: () => {} }, () => {
    created++; const socket = new EventEmitter() as EventEmitter & AccountingSocket;
    Object.assign(socket, { serverVersion: 178, connect: () => {}, disconnect: () => {}, reqManagedAccts: () => {}, reqCurrentTime: () => {}, reqExecutions: () => {} });
    return socket;
  });
  collector.connect(); assert.equal(await collector.retire(10), false);
  assert.throws(() => collector.connect(), /SOURCE_RETIREMENT_UNKNOWN/); assert.equal(created, 1);
});
test("owner fence precedes every connection and rejects socket callbacks after ownership loss", async () => {
  let owns = false, created = 0, observed = 0;
  const socket = new EventEmitter() as EventEmitter & AccountingSocket;
  Object.assign(socket, { serverVersion: 178, connect: () => {}, disconnect: () => { socket.emit("disconnected"); socket.emit("transportClosed"); }, reqManagedAccts: () => {}, reqCurrentTime: () => {}, reqExecutions: () => {} });
  const collector = new AccountingSourceCollector(settings, { observe: () => observed++, gap: () => {},
    assertOwner: () => { if (!owns) throw Error("ACCOUNTING_SOURCE_OWNER_LOST"); } }, () => { created++; return socket; });
  assert.throws(() => collector.connect(), /SOURCE_OWNER_LOST/); assert.equal(created, 0);
  owns = true; collector.connect(); owns = false; socket.emit("server", 178, "test");
  assert.equal(observed, 0); await assert.rejects(collector.replay(10, new AbortController().signal), /SOURCE_OWNER_LOST/);
  assert.equal(await collector.retire(), true);
});

test("installed adapter retirement waits for native close after API disconnected or EOF", async () => {
  const transport = new Socket({ allowHalfOpen: true });
  const api = new EventEmitter() as EventEmitter & AccountingSocket;
  let disconnects = 0;
  Object.assign(api, { serverVersion: 178, controller: { socket: { client: transport } },
    connect: () => {}, disconnect: () => { disconnects++; api.emit("disconnected"); }, reqManagedAccts: () => {}, reqCurrentTime: () => {}, reqExecutions: () => {} });
  const wrapped = accountingSocketWithTransportClose(api);
  const collector = new AccountingSourceCollector(settings, { observe: () => {}, gap: () => {} }, () => wrapped);
  collector.connect(); api.emit("disconnected"); transport.emit("end");
  let acknowledged = false;
  const retiring = collector.retire(100).then(result => { acknowledged = result; return result; });
  assert.equal(acknowledged, false); assert.equal(disconnects, 1);
  assert.throws(() => collector.connect(), /SOURCE_RETIREMENT_UNKNOWN/);
  assert.equal(await retiring, true); assert.equal(transport.closed, true);
});
test("unsupported native transport never manufactures retirement proof", async () => {
  const api = new EventEmitter() as EventEmitter & AccountingSocket;
  Object.assign(api, { serverVersion: 178, connect: () => {}, disconnect: () => api.emit("disconnected"), reqManagedAccts: () => {}, reqCurrentTime: () => {}, reqExecutions: () => {} });
  const collector = new AccountingSourceCollector(settings, { observe: () => {}, gap: () => {} }, () => accountingSocketWithTransportClose(api));
  collector.connect(); assert.equal(await collector.retire(10), false);
  assert.throws(() => collector.connect(), /SOURCE_RETIREMENT_UNKNOWN/);
});

test('automatic replay brackets an explicit UTC history request with present master config', async () => {
  const { OFFICIAL_SDK_SHA256 } = await import('./official-sdk-bridge.js');
  const observed: Array<{kind:string; value:unknown}> = [];
  let sent: unknown, reads = 0;
  const socket = new EventEmitter() as EventEmitter & AccountingSocket;
  Object.assign(socket, { serverVersion: 226, automatic: true, sdkSha256: OFFICIAL_SDK_SHA256,
    connect: () => { socket.emit('server', 226, 'test'); socket.emit('nextValidId', 0); },
    disconnect: () => socket.emit('transportClosed'), reqManagedAccts: () => socket.emit('managedAccounts', settings.accountId),
    reqConfig: async () => { reads++; return { masterClientIdPresent: true, masterClientId: 0 }; },
    reqCurrentTime: () => socket.emit('currentTimeInMillis', Date.now()),
    reqExecutions: (id:number, filter: unknown) => { sent = filter; socket.emit('execDetailsEnd', id); } });
  const collector = new AccountingSourceCollector(settings, { observe: e => observed.push(e), gap: () => {}, automatic: true, settingsHash: 'a'.repeat(64) }, () => socket);
  const result = await collector.replay(1000, new AbortController().signal);
  assert.equal(reads, 2); assert.equal(result.capability?.filter.lastNDays, 7);
  assert.equal(result.capability?.filter.acctCode, settings.accountId);
  assert.deepEqual(sent, result.capability?.filter);
  assert.match(result.capability!.filter.time, /^\d{8}-\d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(observed.map(v => v.kind), ['handshake', 'managed_accounts', 'configuration', 'clock', 'replay_start', 'replay_end', 'configuration']);
  await collector.retire();
});

test('automatic replay rejects unsupported master, expired history, and config change without inventing coverage', async () => {
  const { OFFICIAL_SDK_SHA256 } = await import('./official-sdk-bridge.js');
  for (const mode of ['master', 'history', 'changed', 'error'] as const) {
    let reads = 0;
    const socket = new EventEmitter() as EventEmitter & AccountingSocket;
    Object.assign(socket, { serverVersion: 226, automatic: true, sdkSha256: OFFICIAL_SDK_SHA256,
      connect: () => { socket.emit('server', 226, 'test'); socket.emit('nextValidId', 0); }, disconnect: () => socket.emit('transportClosed'),
      reqManagedAccts: () => socket.emit('managedAccounts', settings.accountId), reqCurrentTime: () => socket.emit('currentTimeInMillis', Date.now()),
      reqConfig: async () => { reads++; return { masterClientIdPresent: true, masterClientId: mode === 'master' || mode === 'changed' && reads === 2 ? 4 : 0 }; },
      reqExecutions: (id:number) => { if (mode === 'error') socket.emit('error', new Error('partial unavailable'), 102); socket.emit('execDetailsEnd', id); } });
    const collector = new AccountingSourceCollector(settings, { observe: () => {}, gap: () => {}, automatic: true }, () => socket);
    await assert.rejects(collector.replay(1000, new AbortController().signal, mode === 'history' ? Date.now() - 8 * 86400000 : undefined), /MASTER_SCOPE|HISTORY_WINDOW|SOURCE_GAP/);
    await collector.retire();
  }
});
