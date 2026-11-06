import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { TwsClient, awaitExactlyOneContractDetails } from './tws-client.js';
import { AutoBootstrapController } from './auto-bootstrap.js';
import { captureResearchSourceError } from '@ikbr/shared/instrument-research';
import { sessionIdentityFixture } from './session-fixture.js';

const config = { host: 'unused', port: 0, clientId: 1, securityType: 'STK', exchange: 'SMART', currency: 'USD', marketDataType: 1 };
class FakeIb extends EventEmitter {
  connects = 0; disconnects = 0; probes = 0; sends: number[] = []; history: number[] = [];
  handshake = true;
  connect() { this.connects++; if (this.handshake) this.emit('nextValidId', 1); }
  disconnect() { this.disconnects++; this.emit('disconnected'); }
  reqMarketDataType() {}
  reqCurrentTime() { this.probes++; }
  reqManagedAccts() {}
  reqMktData(id: number) { this.sends.push(id); }
  reqHistoricalData(id: number) { this.history.push(id); }
  cancelHistoricalData() {}
}
function fixture() {
  const sockets: FakeIb[] = [], ticks: unknown[] = [];
  let wall = 100_000, monotonic = 0;
  const client = new TwsClient(config, tick => { ticks.push(tick); }, () => {}, {
    ibFactory: () => { const ib = new FakeIb(); sockets.push(ib); return ib; },
    now: () => wall, monotonicNow: () => monotonic,
  });
  return { client, sockets, ticks, advance: (ms: number) => { wall += ms; monotonic += ms; } };
}

test('probe is single flight, validates its deadline before delayed timeout callback and retires emitter', async () => {
  const f = fixture(); await f.client.connect();
  const old = f.sockets[0];
  const probe = f.client.probe(); assert.equal(f.client.probe(), probe); assert.equal(old.probes, 1);
  f.advance(15_000); old.emit('currentTime', 1_800_000_000);
  await assert.rejects(probe, /LIVENESS_TIMEOUT/);
  assert.equal(old.listenerCount('currentTime'), 0); assert.equal(old.disconnects, 1);
  await f.client.connect(); const fresh = f.sockets[1];
  const next = f.client.probe(); let settled = false; void next.then(() => { settled = true; });
  old.emit('currentTime', 1_800_000_000); old.emit('nextValidId', 99); old.emit('disconnected');
  await Promise.resolve(); assert.equal(settled, false); assert.equal(f.client.isConnected(), true);
  fresh.emit('currentTime', 1_800_000_001); await next;
  f.client.disconnect();
});

for (const reply of [0, -1, 0.5, NaN, Infinity, '1800000000']) test(`invalid broker clock reply ${reply} retires rather than certifies`, async () => {
  const f = fixture(); await f.client.connect(); const probe = f.client.probe();
  f.sockets[0].emit('currentTime', reply); await assert.rejects(probe, /INVALID_REPLY/);
  assert.equal(f.client.isConnected(), false); assert.equal(f.sockets[0].disconnects, 1);
});

test('retirement rejects identifier-less account read and connecting handshake, old callbacks cannot revive', async () => {
  const f = fixture(); await f.client.connect();
  const accounts = f.client.getManagedAccounts(); f.client.disconnect();
  await assert.rejects(accounts, /INTERRUPTED/); assert.equal(f.sockets[0].listenerCount('managedAccounts'), 0);
  f.sockets[0].emit('managedAccounts', 'old');
  await f.client.connect(); f.client.disconnect();
  const ib = new FakeIb(); ib.handshake = false;
  const client = new TwsClient(config, () => {}, () => {}, { ibFactory: () => ib });
  const connect = client.connect(); client.disconnect(); await assert.rejects(connect, /INTERRUPTED/);
  ib.emit('nextValidId', 1); assert.equal(client.isConnected(), false); assert.equal(ib.disconnects, 1);
});

test('connection failure retains separately supplied IB code and sanitized original cause', async () => {
  const ib = new FakeIb(); ib.handshake = false;
  const client = new TwsClient(config, () => {}, () => {}, { ibFactory: () => ib });
  const pending = client.connect();
  const original = new Error('Connection failed for DU1234567\napi_token=private-token'); original.name = 'BrokerConnectionError';
  ib.emit('error', original, { code: 502 });
  await assert.rejects(pending, error => {
    assert.equal((error as Error).message, 'TWS_CONNECT_FAILED');
    const cause = captureResearchSourceError(error);
    assert.equal(cause.name, 'BrokerConnectionError'); assert.equal(cause.code, 502);
    assert.match(cause.message, /Connection failed/);
    assert.doesNotMatch(cause.message, /DU1234567|private-token|\n/);
    return true;
  });
  assert.equal(client.isConnected(), false); assert.equal(ib.disconnects, 1);
});

test('history pacing debit and request IDs survive replacement; queued old reads never borrow new emitter', async () => {
  const f = fixture(); await f.client.connect();
  f.client.addSubscriptions([{ symbol: 'TEST', conid: '1' }]); const firstId = f.sockets[0].sends[0];
  for (let n = 0; n < 50; n++) await f.client.acquireHistoricalPacingToken();
  const identity = sessionIdentityFixture();
  const pending = f.client.fetchSessionCandles({ symbol: identity.symbol, conid: String(identity.conId), instrumentId: identity.instrumentId }, identity, '1m', 1);
  f.client.disconnect(); await assert.rejects(pending, /INTERRUPTED/);
  await f.client.connect(); f.client.addSubscriptions([{ symbol: 'TEST', conid: '1' }]);
  assert.ok(f.sockets[1].sends[0] > firstId);
  const stillPaced = f.client.acquireHistoricalPacingToken(); let charged = false;
  void stillPaced.then(() => { charged = true; }, () => {});
  await Promise.resolve(); assert.equal(charged, false);
  f.client.disconnect(); await assert.rejects(stillPaced, /INTERRUPTED/);
  assert.deepEqual(f.sockets.map(x => x.history.length), [0, 0]);
});

test('buffered tick before overdue watchdog detects wake and cannot become fresh evidence', async () => {
  let now = 1_000, calls = 0;
  const sockets: FakeIb[] = [], ticks: unknown[] = [];
  const client: TwsClient = new TwsClient(config, tick => { ticks.push(tick); }, () => {}, {
    ibFactory: () => { const ib = new FakeIb(); sockets.push(ib); return ib; },
    continuous: () => controller.continuous(), now: () => now,
  });
  const controller: AutoBootstrapController<void> = new AutoBootstrapController({ enabled: true, now: () => now,
    readStopped: async () => false, writeStopped: async () => {}, stop: async () => {},
    ready: () => client.isConnected(), invalidateReads: () => client.disconnect(),
    bootstrap: async () => { calls++; await client.connect(); client.addSubscriptions([{ symbol: 'TEST', conid: '1' }]); },
  });
  await controller.initialize(); await controller.tick();
  const old = sockets[0], ticker = old.sends[0]; old.emit('marketDataType', ticker, 1); old.emit('tickPrice', ticker, 1, 100);
  const before = ticks.length; now += 60_000;
  old.emit('tickPrice', ticker, 2, 101);
  assert.equal(ticks.length, before); assert.equal(client.isConnected(), false);
  assert.equal(controller.diagnostics().recoveryReason, 'SCHEDULING_INTERRUPTION');
  await controller.tick(); assert.equal(calls, 2); assert.equal(sockets.length, 2);
  old.emit('error', new Error('late')); old.emit('tickPrice', ticker, 1, 102);
  assert.equal(ticks.length, before); assert.equal(client.isConnected(), true);
  await controller.shutdown();
});

test('installed ib 0.2.9 retirement clears queued handshake commands and destroys unconnected socket', () => {
  const client = new TwsClient(config, () => {}, () => {});
  const ib = (client as unknown as { ib: any }).ib;
  const socket = new EventEmitter() as EventEmitter & { destroyed: boolean; destroy(): void };
  socket.destroyed = false; socket.destroy = () => { socket.destroyed = true; };
  ib._controller._socket._client = socket;
  ib._controller._commands.pause(); ib.connect(); ib.reqCurrentTime();
  assert.ok(ib._controller._commands._commands.length > 0);
  client.disconnect();
  assert.equal(socket.destroyed, true); assert.equal(client.isConnected(), false);
  assert.deepEqual(ib._controller._commands._commands, []);
  assert.deepEqual(ib._controller._commands._commandsCurrent, []);
  socket.emit('error', new Error('late physical close'));
  ib._controller.resume(); assert.equal(socket.destroyed, true);
});

test('buffered managed-account and history responses reject elapsed deadlines before timer delivery', async () => {
  const f = fixture(); await f.client.connect();
  const accounts = f.client.getManagedAccounts(); f.advance(8_000);
  f.sockets[0].emit('managedAccounts', 'DU_TEST'); await assert.rejects(accounts, /READ_TIMEOUT/);
  assert.equal(f.sockets[0].listenerCount('managedAccounts'), 0);
  const identity = sessionIdentityFixture();
  const history = f.client.fetchSessionCandles({ symbol: identity.symbol, conid: String(identity.conId), instrumentId: identity.instrumentId }, identity, '1m', 1);
  await Promise.resolve(); f.advance(30_000);
  f.sockets[0].emit('historicalData', f.sockets[0].history[0], 'finished');
  await assert.rejects(history, /READ_TIMEOUT/);
  assert.equal(f.sockets[0].listenerCount('historicalData'), 0); f.client.disconnect();
});

test('strict contract response rejects expired deadline even when its timer has not run', async () => {
  const ib = new EventEmitter() as EventEmitter & { reqContractDetails(): void };
  ib.reqContractDetails = () => {};
  let now = 0;
  const request = awaitExactlyOneContractDetails({ ib, reqId: 1, contract: {}, label: 'test', timeoutMs: 8000, monotonicNow: () => now });
  ib.emit('contractDetails', 1, { contract: { conId: 1 } }); now = 8000;
  ib.emit('contractDetailsEnd', 1); await assert.rejects(request, /READ_TIMEOUT/);
  assert.equal(ib.listenerCount('contractDetails'), 0); assert.equal(ib.listenerCount('contractDetailsEnd'), 0);
});
