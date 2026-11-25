import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { awaitExactlyOneContractDetails, TwsClient, type IbEventPort } from './tws-client.js';
import { AutoBootstrapController } from './auto-bootstrap.js';
import { contractDiagnosticText, contractQueryDiagnostic, contractSourceError, type ContractDiagnosticEvent,
  type ContractResolutionDiagnostic } from './contract-resolution-diagnostics.js';

class FakeIb extends EventEmitter {
  request: (id: number) => void = () => {};
  connect() { this.emit('connected'); this.emit('server', 180, 'not retained'); this.emit('nextValidId', 1); }
  disconnect() { this.emit('disconnected'); }
  reqMarketDataType() {}
  reqContractDetails(id: number) { this.request(id); }
}
const config = { host: 'unused', port: 0, clientId: 1, securityType: 'STK', exchange: 'SMART', currency: 'USD', marketDataType: 1 };
const instrument = (symbol = 'PKO') => ({ symbol, conid: '123', instrumentId: `${symbol.toLowerCase()}_fixture` });
function reply(ib: FakeIb, id: number) { ib.emit('contractDetails', id, { contract: { conId: 123, symbol: 'FIXTURE' } }); ib.emit('contractDetailsEnd', id); }
function request(ib: FakeIb, extra: Partial<Parameters<typeof awaitExactlyOneContractDetails>[0]> = {}) {
  const snapshots: ContractResolutionDiagnostic[] = [];
  const promise = awaitExactlyOneContractDetails({ ib: ib as unknown as IbEventPort, reqId: 7,
    contract: { symbol: 'PKO', conId: 123 }, label: 'PKO', timeoutMs: 100,
    onDiagnostic: d => snapshots.push(d), ...extra });
  return { promise, snapshots, terminals: () => snapshots.filter(d => d.outcome !== null) };
}
function clean(ib: FakeIb) {
  assert.equal(ib.listenerCount('contractDetails'), 0); assert.equal(ib.listenerCount('contractDetailsEnd'), 0);
  assert.equal(ib.listenerCount('error'), 0);
}

for (const positional of [false, true]) test(`matching broker error preserves original cause: positional=${positional}`, async () => {
  const ib = new FakeIb(), r = request(ib);
  const error = Object.assign(new Error('Brak uprawnień'), { name: 'BrokerReject' });
  if (positional) ib.emit('error', error, 200, 7); else ib.emit('error', error, { code: 200, id: 7 });
  await assert.rejects(r.promise, (e: unknown) => {
    assert.deepEqual((e as { sourceError: unknown }).sourceError, { name: 'BrokerReject', code: 200, message: 'Brak uprawnień' });
    return true;
  });
  assert.equal(r.terminals()[0].outcome, 'BROKER_ERROR');
  assert.equal(r.terminals()[0].brokerCause, 'REQUEST_ERROR_OBSERVED'); clean(ib);
});

test('unrelated request and global farm messages are not a request cause', async () => {
  const ib = new FakeIb(), r = request(ib);
  for (const meta of [{ code: 200, id: 8 }, { code: 2104, id: -1 }, { code: 2106 }]) ib.emit('error', new Error('context'), meta);
  reply(ib, 8); assert.equal(r.terminals().length, 0); reply(ib, 7); await r.promise;
  assert.equal(r.terminals()[0].outcome, 'SUCCESS'); assert.equal(r.terminals()[0].detailCount, 1);
  assert.equal(r.terminals()[0].sourceError, null); clean(ib);
});

for (const count of [0, 1]) test(`timeout with ${count} responses reports unknown broker cause`, async () => {
  const ib = new FakeIb(), r = request(ib, { timeoutMs: 10 });
  if (count) ib.emit('contractDetails', 7, { contract: {} });
  await assert.rejects(r.promise, /Timed out/);
  const terminal = r.terminals()[0];
  assert.equal(terminal.outcome, 'TIMEOUT'); assert.equal(terminal.detailCount, count); assert.equal(terminal.endCount, 0);
  assert.equal(terminal.timeoutMs, 10); assert.equal(terminal.sdkInvocationAttempted, true);
  assert.equal(terminal.sdkInvocationReturned, true); assert.equal(terminal.wireTransmission, 'UNAVAILABLE');
  assert.equal(terminal.brokerCause, 'UNKNOWN'); assert.equal(terminal.sourceError, null); clean(ib);
});

for (const count of [0, 2]) test(`end marker with ${count} responses retains accurate terminal counts`, async () => {
  const ib = new FakeIb(), r = request(ib);
  for (let n = 0; n < count; n++) ib.emit('contractDetails', 7, { contract: {} });
  ib.emit('contractDetailsEnd', 7); await assert.rejects(r.promise);
  assert.equal(r.terminals()[0].outcome, count ? 'AMBIGUOUS_DETAILS' : 'NO_DETAILS');
  assert.equal(r.terminals()[0].detailCount, count); assert.equal(r.terminals()[0].endCount, 1); clean(ib);
});

for (const throws of [false, true]) test(`synchronous terminal then SDK ${throws ? 'throw' : 'return'} freezes evidence once`, async () => {
  const ib = new FakeIb(); ib.request = id => { reply(ib, id); if (throws) throw new Error('after terminal'); };
  const r = request(ib); await r.promise;
  assert.equal(r.terminals().length, 1); const terminal = r.terminals()[0];
  assert.equal(terminal.outcome, 'SUCCESS'); assert.equal(terminal.sdkInvocationAttempted, true);
  assert.equal(terminal.sdkInvocationReturned, false); clean(ib);
});

test('synchronous broker error followed by throw keeps first terminal and original cause', async () => {
  const ib = new FakeIb(); ib.request = id => { ib.emit('error', new Error('first'), { id, code: 'E_CONTRACT' }); throw new Error('second'); };
  const r = request(ib); await assert.rejects(r.promise, /E_CONTRACT/);
  assert.equal(r.terminals().length, 1); assert.equal(r.terminals()[0].sourceError?.message, 'first');
  assert.equal(r.terminals()[0].sdkInvocationReturned, false); clean(ib);
});

test('throwing diagnostic callback cannot prevent dispatch, cleanup or change SDK error outcome', async () => {
  const ib = new FakeIb(); let sends = 0;
  ib.request = () => { sends++; throw Object.assign(new Error('marshal'), { name: 'LocalAdapter', code: 'LOCAL_CODE' }); };
  const r = request(ib, { onDiagnostic: () => { throw new Error('observer'); } });
  await assert.rejects(r.promise, e => (e as { sourceError: { code: string } }).sourceError.code === 'LOCAL_CODE');
  assert.equal(sends, 1); clean(ib);
});

test('pre-aborted and buffered expired callbacks never fabricate successful current evidence', async () => {
  const aborted = new AbortController(); aborted.abort(); const ib = new FakeIb();
  let sends = 0; ib.request = () => { sends++; };
  const r = request(ib, { signal: aborted.signal }); await assert.rejects(r.promise, /INTERRUPTED/);
  assert.equal(sends, 0); assert.equal(r.terminals()[0].sdkInvocationAttempted, false); clean(ib);
  let now = 0; const late = request(ib, { monotonicNow: () => now }); now = 101;
  ib.emit('contractDetails', 7, { contract: {} }); await assert.rejects(late.promise, /READ_TIMEOUT/);
  assert.equal(late.terminals()[0].detailCount, 0); clean(ib);
  const invalid = request(ib, { monotonicNow: () => NaN, now: () => Infinity });
  ib.emit('contractDetailsEnd', 7); await assert.rejects(invalid.promise);
  assert.equal(invalid.terminals()[0].elapsedMs, null); assert.equal(invalid.terminals()[0].startedAt, null);
});

test('global connection failure is snapshotted before synchronous retirement; successor is independent', async () => {
  const sockets: FakeIb[] = [], logs: ContractDiagnosticEvent[] = [];
  const client = new TwsClient(config, () => {}, () => {}, { ibFactory: () => { const ib = new FakeIb(); sockets.push(ib); return ib; },
    onDiagnostic: e => logs.push(e) });
  await client.connect(); client.beginBootstrapDiagnostics();
  const pending = client.resolveContracts([instrument()]);
  sockets[0].emit('error', new Error('farm down'), { code: 1100, id: -1 }); await pending;
  const failed = client.contractFailures().failures[0];
  assert.equal(failed.outcome, 'INTERRUPTED'); assert.equal(failed.sourceError, null);
  assert.equal(failed.transport?.globalContext[0].sourceError.code, '1100');
  assert.equal(failed.transport?.aborted, true); assert.equal(failed.transport?.retired, true);
  assert.notEqual(failed.transportGeneration, failed.currentTransportGeneration);
  assert.ok(failed.transport?.socketConnectedAt); assert.equal(failed.transport?.serverVersion, 180);
  assert.ok(failed.transport?.nextValidIdAt);
  await client.connect(); const before = JSON.stringify(client.contractResolutionDiagnostics());
  sockets[0].emit('error', new Error('old'), { code: 200, id: 10000 });
  assert.equal(JSON.stringify(client.contractResolutionDiagnostics()), before);
  assert.equal(client.contractResolutionDiagnostics().transport.globalContext.length, 0);
  assert.equal(logs.filter(e => e.event === 'contract_resolution_finished').length, 1); client.disconnect();
});

test('diagnostic accessors do not evaluate continuity and returned snapshots cannot mutate retained state', async () => {
  let checks = 0; const ib = new FakeIb();
  const client = new TwsClient(config, () => {}, () => {}, { ib, continuous: () => { checks++; return true; } });
  await client.connect(); ib.request = id => reply(ib, id); await client.resolveContracts([instrument()]);
  const before = checks, view = client.contractResolutionDiagnostics(); view.history[0].label = 'changed';
  view.transport.globalContext.push({ observedAt: null, generation: 0, sourceError: { name: null, code: null, message: 'changed' } });
  assert.equal(client.contractResolutionDiagnostics().history[0].label.includes('changed'), false);
  assert.equal(client.contractResolutionDiagnostics().transport.globalContext.length, 0); assert.equal(checks, before); client.disconnect();
});

test('bounded bootstrap failures survive more than twenty successes and report overflow independently', async () => {
  const ib = new FakeIb(), client = new TwsClient(config, () => {}, () => {}, { ib }); await client.connect();
  client.beginBootstrapDiagnostics(); let n = 0;
  ib.request = id => { if (n++ === 0) ib.emit('error', new Error('PKO unavailable'), { id, code: 200 }); else reply(ib, id); };
  await client.resolveContracts([instrument(), ...Array.from({ length: 25 }, () => instrument('AAPL'))]);
  assert.equal(client.contractResolutionDiagnostics().history.length, 20);
  assert.equal(client.contractResolutionDiagnostics().omittedRequests, 6);
  assert.equal(client.contractFailures().failures[0].label, 'PKO (pko_fixture)');
  client.beginBootstrapDiagnostics(); ib.request = id => ib.emit('error', new Error('failed'), { id, code: 200 });
  await client.resolveContracts(Array.from({ length: 25 }, () => instrument()));
  assert.equal(client.contractFailures().failures.length, 20); assert.equal(client.contractFailures().omittedFailures, 5);
  assert.equal(client.contractFailures().truncated, true);
  for (let i = 0; i < 12; i++) ib.emit('error', new Error('farm'), { code: 2104, id: -1 });
  assert.equal(client.contractResolutionDiagnostics().transport.globalContext.length, 8);
  assert.equal(client.contractResolutionDiagnostics().transport.omittedGlobalMessages, 4); client.disconnect();
});

test('bootstrap preserves PKO failure through invalidation, clears unrelated later failure and later success', async () => {
  const ib = new FakeIb(), client = new TwsClient(config, () => {}, () => {}, { ibFactory: () => ib });
  let mode = 0, now = 0, ready = false;
  const controller = new AutoBootstrapController({ enabled: true, now: () => now,
    readStopped: async () => false, writeStopped: async () => {}, stop: async () => {}, ready: () => ready,
    beginBootstrapDiagnostics: () => client.beginBootstrapDiagnostics(), contractFailures: () => client.contractFailures(),
    invalidateReads: () => client.disconnect(), bootstrap: async () => {
      if (mode === 1) throw new Error('database unavailable');
      await client.connect(); let n = 0;
      ib.request = id => { if (mode === 0 && n++ === 0) ib.emit('error', new Error('specific PKO failure'), { id, code: 200 }); else reply(ib, id); };
      await client.resolveContracts([instrument(), instrument('AAPL')]); ready = mode === 2;
    } });
  await controller.initialize(); await assert.rejects(controller.tick(), /INCOMPLETE/);
  const failure = controller.diagnostics().contractFailure!;
  assert.equal(failure.failures[0].sourceError?.message, 'specific PKO failure');
  assert.equal(client.isConnected(), false); failure.failures.length = 0;
  assert.equal(controller.diagnostics().contractFailure!.failures.length, 1);
  mode = 1; now = 30_000; await assert.rejects(controller.tick(), /database/);
  assert.equal(controller.diagnostics().contractFailure, null);
  mode = 2; now = 90_000; await controller.tick(); assert.equal(controller.diagnostics().contractFailure, null);
  assert.equal(client.contractFailures().failures.length, 0); await controller.shutdown();
});

test('all retained strings and log paths redact encoded credentials/accounts and payload fragments', async () => {
  const secret = 'private secret/abc', account = 'account private/123', privacy = { secrets: [secret], accountIds: [account] };
  const bad = `prefix ${encodeURIComponent(secret)} ${account} postgresql://user:password@host/db {"raw":"PAYLOAD"}`;
  const text = contractDiagnosticText(bad, privacy, 1000);
  assert.doesNotMatch(text, /private|PAYLOAD|postgresql:|password@/);
  assert.doesNotMatch(JSON.stringify(contractQueryDiagnostic({ symbol: bad, localSymbol: bad, ignored: 'RAW' }, privacy)), /private|RAW|PAYLOAD/);
  assert.doesNotMatch(JSON.stringify(contractSourceError(Object.assign(new Error(bad), { name: bad }), privacy, bad)), /private|PAYLOAD|postgresql:/);
  const ib = new FakeIb(), logs: unknown[] = [];
  const client = new TwsClient(config, () => {}, line => logs.push(line), { ib, privacy, onDiagnostic: e => logs.push(e) });
  await client.connect(); client.beginBootstrapDiagnostics();
  ib.request = id => ib.emit('error', Object.assign(new Error(bad), { name: bad }), { id, code: 'E_LOCAL' });
  await client.resolveContracts([{ ...instrument(bad), localSymbol: bad }]);
  ib.emit('error', new Error(bad), { code: 2104, id: -1 });
  assert.doesNotMatch(JSON.stringify({ logs, health: client.contractResolutionDiagnostics() }), /private|PAYLOAD|postgresql:|password@/);
  const long = 'x'.repeat(10000); assert.equal(contractDiagnosticText(long).length, 100);
  assert.ok(contractSourceError(new Error(long)).message.length <= 1000);
  assert.doesNotMatch(contractDiagnosticText('x\ny\u202e'), /\n|\u202e/); client.disconnect();
});

for (const terminal of ['success', 'error'] as const) test(`throwing diagnostic state accessors cannot strand ${terminal}`, async () => {
  const ib = new FakeIb(); ib.request = id => {
    if (terminal === 'success') reply(ib, id); else ib.emit('error', new Error('original'), { code: 200, id });
  };
  const r = request(ib, { transportDiagnostic: () => { throw new Error('observer'); },
    currentTransportGeneration: () => { throw new Error('observer'); } });
  if (terminal === 'success') await r.promise; else await assert.rejects(r.promise, /original/);
  assert.equal(r.terminals().length, 1); assert.equal(r.terminals()[0].transport, null);
  assert.equal(r.terminals()[0].currentTransportGeneration, null); clean(ib);
});
