import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IBApi } from '@stoqey/ib';
import { CompletedOrdersClient, type CompletedOrdersRequest, type CompletedOrdersSocket } from './completed-orders-client.js';
import { brokerDiagnosticPrivacy, type BrokerPhaseEvent } from './phase-diagnostics.js';
import { completedRecord, captureRequest } from './completed-test-fixture.js';
import { IbBrokerReconciliationAdapter } from './ib-broker-adapter.js';
import type { TwsExecutionClient } from '../tws-execution-client.js';

class Socket extends EventEmitter implements CompletedOrdersSocket {
  connections = 0; disconnects = 0; requests: boolean[] = [];
  operations: string[] = [];
  connectAction = () => { this.emit('received', ['private-handshake']); this.emit('nextValidId', 1); };
  accountsAction = () => this.emit('managedAccounts', 'DU-TEST');
  requestAction = () => { this.emit('sent', [99, false]); this.emit('completedOrdersEnd'); };
  disconnectAction = () => this.emit('disconnected');
  connect() { this.operations.push('connect'); this.connections++; this.connectAction(); }
  disconnect() { this.operations.push('disconnect'); this.disconnects++; this.disconnectAction(); }
  reqManagedAccts() { this.operations.push('managed'); this.accountsAction(); }
  reqCompletedOrders(apiOnly: boolean) { this.operations.push('completed'); this.requests.push(apiOnly); this.requestAction(); }
}
const request = (signal = new AbortController().signal, timeoutMs = 20): CompletedOrdersRequest => ({ accountId: 'DU-TEST', timeoutMs, abortSignal: signal, runId: '42' });
const settleTurn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const socket = new Socket(), events: BrokerPhaseEvent[] = [];
  const diagnostics = { emit: (event: BrokerPhaseEvent) => events.push(event), privacy: () => brokerDiagnosticPrivacy(
    { ALERT_TELEGRAM_BOT_TOKEN: '123456:private-token' }, { allowedPaperAccounts: ['DU-TEST'], allowedLiveAccounts: [] }, 'DU-TEST') };
  const client = new CompletedOrdersClient({ host: 'private-broker-host', port: 1, clientId: 120 },
    { createSocket: () => socket, shutdownTimeoutMs: 10, diagnostics });
  return { socket, events, diagnostics, client };
}
function assertTrace(events: BrokerPhaseEvent[], captureId = 1) {
  assert.ok(events.length > 0 && events.length <= 20, `bounded event count ${events.length}`);
  for (const event of events) {
    assert.equal(event.runId, 42); assert.equal(event.captureId, captureId); assert.equal(event.requestId, undefined);
    assert.equal(typeof event.durationMs, 'number'); assert.ok(Number.isFinite(event.durationMs) && event.durationMs! >= 0);
  }
  assert.doesNotMatch(JSON.stringify(events), /DU-TEST|private-broker-host|private-handshake|private-token/);
}
const stages = {
  nextValidId: { reason: 'waiting_next_valid_id', configure: (socket: Socket) => { socket.connectAction = () => {}; } },
  accounts: { reason: 'waiting_managed_accounts', configure: (socket: Socket) => { socket.accountsAction = () => false; } },
  write: { reason: 'request_write_unobserved', configure: (socket: Socket) => { socket.requestAction = () => {}; } },
  response: { reason: 'waiting_first_completed_response', configure: (socket: Socket) => { socket.requestAction = () => { socket.emit('sent', [99, false]); }; } },
  end: { reason: 'waiting_completed_end', configure: (socket: Socket) => { socket.requestAction = () => {
    socket.emit('sent', [99, false]); for (let i = 0; i < 100; i++) socket.emit('completedOrder', ...completedRecord());
  }; } },
  endWithoutWriteObservation: { reason: 'waiting_completed_end', configure: (socket: Socket) => { socket.requestAction = () => {
    socket.emit('completedOrder', ...completedRecord());
  }; } },
};
for (const [name, stage] of Object.entries(stages)) for (const failure of ['timeout', 'aborted'] as const) {
  test(`completed ${failure} identifies ${name} stage without changing result or cleanup`, async () => {
    const f = fixture(); stage.configure(f.socket); const controller = new AbortController();
    const pending = f.client.load(request(controller.signal));
    if (failure === 'aborted') { await settleTurn(); controller.abort(); }
    assert.deepEqual(await pending, { ok: false, rows: [], error: failure });
    const event = f.events.find(row => row.phase === 'completed.read');
    assert.equal(event?.reason, `${failure}:${stage.reason}`); assert.equal(event?.cause, null);
    assert.equal(f.socket.disconnects, 1); assert.deepEqual(f.socket.eventNames(), ['error']);
    assertTrace(f.events);
    assert.ok(f.events.filter(row => row.phase === 'completed.first_validated_row').length <= 1);
    if (name === 'endWithoutWriteObservation') {
      assert.equal(f.events.filter(row => row.phase === 'completed.first_validated_row').length, 1);
      assert.equal(f.events.some(row => row.phase === 'completed.request_write'), false);
      assert.equal(f.events.filter(row => row.phase === 'completed.request_write_unobserved').length, 1);
      assert.equal(f.events.find(row => row.phase === 'completed.request_write_unobserved')?.reason, 'local_socket_write_unobserved');
    }
  });
}
test('successful completion records semantic end and confirmed shutdown, not raw payloads', async () => {
  const f = fixture();
  f.socket.requestAction = () => {
    const sent = [99]; Object.defineProperty(sent, 1, { get: () => { throw Error('raw payload inspected'); } });
    f.socket.emit('sent', sent); f.socket.emit('sent', sent);
    f.socket.emit('received', ['102', 'private-row-payload']);
    for (let i = 0; i < 100; i++) f.socket.emit('completedOrder', ...completedRecord());
    f.socket.emit('completedOrdersEnd');
  };
  const result = await f.client.load(request(undefined, 100));
  assert.equal(result.ok, true); assert.equal(result.rows.length, 1); assert.deepEqual(f.socket.requests, [false]);
  for (const phase of ['enqueue', 'queue', 'connect_called', 'next_valid_id', 'managed_accounts_requested', 'managed_accounts', 'request_called',
    'request_write', 'first_ingress', 'first_validated_row', 'end', 'disconnect_requested', 'disconnected', 'read', 'shutdown', 'settlement']) {
    assert.equal(f.events.filter(row => row.phase === `completed.${phase}`).length, 1, phase);
  }
  assert.equal(f.events.find(row => row.phase === 'completed.request_write')?.reason, 'local_socket_write_attempt');
  assertTrace(f.events);
  const metadata = f.events.map(event => {
    assert.deepEqual(Object.keys(event).sort(), ['captureId', 'cause', 'durationMs', 'outcome', 'phase', 'reason', 'runId']);
    assert.equal(event.cause, null);
    const { durationMs, ...fields } = event;
    assert.equal(typeof durationMs, 'number'); assert.ok(Number.isFinite(durationMs) && durationMs! >= 0);
    assert.equal(Object.values(fields).includes(987), false);
    return fields;
  });
  assert.doesNotMatch(JSON.stringify(metadata), /private-row-payload|987|test-ref/);
  const count = f.events.length;
  for (const event of ['received', 'sent', 'completedOrder', 'completedOrdersEnd', 'disconnected', 'error']) f.socket.emit(event, ['99', '102']);
  assert.equal(f.events.length, count); assert.deepEqual(f.socket.eventNames(), ['error']);
});
test('raw ingress containing 102 cannot establish decoded completion or first valid row', async () => {
  const f = fixture(); f.socket.requestAction = () => {
    f.socket.emit('sent', [99, false]);
    f.socket.emit('received', ['anything', '102']); f.socket.emit('received', ['102']);
  };
  assert.equal((await f.client.load(request())).error, 'timeout');
  assert.equal(f.events.find(row => row.phase === 'completed.read')?.reason, 'timeout:waiting_first_completed_response');
  assert.equal(f.events.some(row => row.phase === 'completed.end' || row.phase === 'completed.first_validated_row'), false);
});
for (const failure of ['timeout', 'aborted'] as const) test(`queued ${failure} creates no socket and retains queue elapsed/correlation`, async () => {
  const firstSocket = new Socket(); firstSocket.connectAction = () => {};
  const events: BrokerPhaseEvent[] = []; let creates = 0;
  const client = new CompletedOrdersClient({ host: 'unused', port: 1, clientId: 120 },
    { createSocket: () => { creates++; return firstSocket; }, diagnostics: { emit: event => events.push(event) } });
  const first = client.load(request(undefined, 40)), controller = new AbortController();
  const second = client.load(request(controller.signal, failure === 'timeout' ? 1 : 100));
  if (failure === 'aborted') controller.abort();
  assert.equal((await first).error, 'timeout'); assert.equal((await second).error, failure); assert.equal(creates, 1);
  const queued = events.filter(event => event.captureId === 2); assertTrace(queued, 2);
  assert.equal(queued.find(event => event.phase === 'completed.read')?.reason, `${failure}:waiting_queue`);
  assert.equal(queued.some(event => event.phase === 'completed.connect_called'), false);
  assert.ok(queued.find(event => event.phase === 'completed.queue')!.durationMs! >= 1);
});
for (const stage of ['connect', 'accounts_request', 'completed_request'] as const) test(`thrown ${stage} preserves actual sanitized cause and original result`, async () => {
  const f = fixture(), error = Object.assign(new Error('DU-TEST private-broker-host 123456:private-token failed'), { name: 'ActualSocketError', code: 'ECONNRESET' });
  const throwError = () => { throw error; };
  if (stage === 'connect') f.socket.connectAction = throwError;
  if (stage === 'accounts_request') f.socket.accountsAction = throwError;
  if (stage === 'completed_request') f.socket.requestAction = throwError;
  const result = await f.client.load(request());
  assert.equal(result.error, stage === 'connect' ? 'completed_connect_failed' : error.message);
  const cause = f.events.find(event => event.phase === 'completed.read')?.cause;
  assert.equal(cause?.name, error.name); assert.equal(cause?.code, error.code); assert.match(cause!.message!, /failed/);
  assertTrace(f.events);
});
test('socket factory rejection stays a rejection and does not poison the next queued load', async () => {
  const f = fixture(), error = Object.assign(new Error('factory private-broker-host failure'), { code: 'FACTORY_FAILED' }); let creates = 0;
  const client = new CompletedOrdersClient({ host: 'private-broker-host', port: 1, clientId: 120 },
    { diagnostics: f.diagnostics, createSocket: () => { if (++creates === 1) throw error; return f.socket; } });
  await assert.rejects(client.load(request()), actual => actual === error);
  assert.equal(f.events.find(event => event.phase === 'completed.settlement')?.reason, 'rejected:socket_factory');
  assert.equal(f.events.find(event => event.phase === 'completed.read')?.cause?.code, 'FACTORY_FAILED');
  assert.equal((await client.load(request())).ok, true); assert.equal(creates, 2);
  assertTrace(f.events.filter(event => event.captureId === 1)); assertTrace(f.events.filter(event => event.captureId === 2), 2);
});
test('managed-account validation and unexpected disconnect retain existing errors', async () => {
  for (const failure of ['account', 'disconnect'] as const) {
    const f = fixture();
    if (failure === 'account') f.socket.accountsAction = () => f.socket.emit('managedAccounts', 'FOREIGN-PRIVATE');
    else f.socket.requestAction = () => { f.socket.emit('disconnected'); };
    const result = await f.client.load(request());
    assert.equal(result.error, failure === 'account' ? 'completed_account_mismatch' : 'completed_disconnected');
    assert.equal(f.events.find(event => event.phase === 'completed.read')?.outcome, 'error');
    assert.doesNotMatch(JSON.stringify(f.events), /FOREIGN-PRIVATE/); assertTrace(f.events);
  }
});
test('informational SDK errors stay nonfatal and fatal SDK codes preserve the original cause', async () => {
  for (const fatal of [false, true]) {
    const f = fixture(); f.socket.requestAction = () => {
      for (const code of [2104, 2106, 2107, 2108, 2158]) f.socket.emit('error', new Error('private-info'), code);
      if (fatal) f.socket.emit('error', Object.assign(new Error('DU-TEST 123456:private-token original failure'), { name: 'BrokerFailure' }), 326);
      else f.socket.emit('completedOrdersEnd');
    };
    const result = await f.client.load(request()); assert.equal(result.ok, !fatal);
    const event = f.events.find(row => row.phase === 'completed.read');
    assert.equal(event?.cause?.code ?? null, fatal ? '326' : null);
    if (fatal) assert.equal(event?.cause?.name, 'BrokerFailure');
    assertTrace(f.events); assert.doesNotMatch(JSON.stringify(f.events), /private-info/);
  }
});
test('string SDK errors retain their actual sanitized message/code without inventing an Error name', async () => {
  const f = fixture(); f.socket.requestAction = () => { f.socket.emit('error', 'DU-TEST 123456:private-token original string failure', 502); };
  assert.equal((await f.client.load(request())).error, 'completed_broker_error:502');
  const cause = f.events.find(event => event.phase === 'completed.read')?.cause;
  assert.equal(cause?.name, null); assert.equal(cause?.code, '502'); assert.match(cause!.message!, /original string failure/);
  assertTrace(f.events);
});
test('initial timeout survives a separately recorded shutdown throw and uncertainty fence', async () => {
  const f = fixture(); f.socket.requestAction = () => {};
  f.socket.disconnectAction = () => { throw Object.assign(new Error('private-broker-host cleanup failed'), { name: 'CleanupFailure', code: 'CLEANUP' }); };
  assert.equal((await f.client.load(request())).error, 'completed_disconnect_unconfirmed');
  assert.equal(f.events.find(event => event.phase === 'completed.read')?.reason, 'timeout:request_write_unobserved');
  assert.equal(f.events.find(event => event.phase === 'completed.shutdown_error')?.cause?.name, 'CleanupFailure');
  assert.equal(f.events.find(event => event.phase === 'completed.shutdown_error')?.cause?.code, 'CLEANUP');
  assert.equal(f.events.find(event => event.phase === 'completed.shutdown')?.reason, 'disconnect_unconfirmed');
  const result = await f.client.load(request()); assert.equal(result.error, 'completed_disconnect_unconfirmed');
  assert.equal(f.socket.connections, 1); assert.equal(f.events.filter(event => event.captureId === 2).find(event => event.phase === 'completed.read')?.reason,
    'completed_disconnect_unconfirmed:shutdown_fenced');
  assertTrace(f.events.filter(event => event.captureId === 1)); assertTrace(f.events.filter(event => event.captureId === 2), 2);
});
test('shutdown SDK cause is bounded and cannot erase the initial timeout', async () => {
  const f = fixture(); f.socket.requestAction = () => {};
  f.socket.disconnectAction = () => {
    for (let i = 0; i < 100; i++) f.socket.emit('error', new Error('cleanup actual failure'), 502);
    f.socket.emit('disconnected'); return true;
  };
  assert.equal((await f.client.load(request())).error, 'timeout');
  assert.equal(f.events.find(event => event.phase === 'completed.read')?.reason, 'timeout:request_write_unobserved');
  assert.equal(f.events.filter(event => event.phase === 'completed.shutdown_error').length, 1);
  assert.equal(f.events.find(event => event.phase === 'completed.shutdown_error')?.cause?.code, '502'); assertTrace(f.events);
});
test('abort after semantic end does not change the original shutdown wait result', async () => {
  const f = fixture(); f.socket.disconnectAction = () => false;
  const controller = new AbortController(), pending = f.client.load(request(controller.signal, 100));
  await settleTurn(); controller.abort(); f.socket.emit('disconnected');
  assert.equal((await pending).ok, true); assertTrace(f.events);
});
test('throwing diagnostic sink or privacy callback never changes request results/counts/cleanup', async () => {
  for (const mode of ['emit', 'privacy'] as const) {
    const socket = new Socket();
    const client = new CompletedOrdersClient({ host: 'unused', port: 1, clientId: 120 }, { createSocket: () => socket,
      diagnostics: { emit: () => { if (mode === 'emit') throw new Error('sink failed'); }, privacy: () => { if (mode === 'privacy') throw new Error('privacy failed'); return {}; } } });
    assert.deepEqual(await client.load(request()), { ok: true, rows: [] });
    assert.deepEqual(socket.requests, [false]); assert.equal(socket.disconnects, 1); assert.deepEqual(socket.eventNames(), ['error']);
  }
});
for (const phase of ['end', 'read', 'disconnected'] as const) {
  for (const outcome of ['complete', 'broker_error', 'disconnected'] as const) {
    if (phase === 'end' && outcome !== 'complete') continue;
    test(`reentrant abort and throwing ${phase} sink preserve terminal ${outcome} and cleanup`, async () => {
      const socket = new Socket(), controller = new AbortController(), events: BrokerPhaseEvent[] = [];
      if (outcome === 'broker_error') socket.requestAction = () => { socket.emit('error', new Error('original broker failure'), 502); };
      if (outcome === 'disconnected') socket.requestAction = () => { socket.emit('disconnected'); };
      let aborted = false;
      const client = new CompletedOrdersClient({ host: 'unused', port: 1, clientId: 120 }, { createSocket: () => socket,
        diagnostics: { emit: event => {
          events.push(event);
          if (event.phase === `completed.${phase}`) { aborted = true; controller.abort(); throw new Error('sink failed after abort'); }
        } } });
      const expectedError = outcome === 'broker_error' ? 'completed_broker_error:502' : 'completed_disconnected';
      assert.deepEqual(await client.load(request(controller.signal, 100)), outcome === 'complete'
        ? { ok: true, rows: [] } : { ok: false, rows: [], error: expectedError });
      assert.equal(aborted, true); assert.deepEqual(socket.requests, [false]); assert.equal(socket.connections, 1);
      assert.equal(socket.disconnects, outcome === 'disconnected' ? 0 : 1); assert.deepEqual(socket.eventNames(), ['error']);
      assert.equal(events.filter(event => event.phase === 'completed.read').length, 1);
      assert.equal(events.filter(event => event.phase === 'completed.settlement').length, 1); assertTrace(events);
    });
  }
}
const activePhaseOperations: Record<string, string[]> = {
  enqueue: [], queue: [], connect_called: ['disconnect'], first_ingress: ['connect', 'disconnect'],
  next_valid_id: ['connect', 'disconnect'], managed_accounts_requested: ['connect', 'disconnect'],
  managed_accounts: ['connect', 'managed', 'disconnect'], request_called: ['connect', 'managed', 'disconnect'],
  request_write: ['connect', 'managed', 'completed', 'disconnect'], first_validated_row: ['connect', 'managed', 'completed', 'disconnect'],
};
for (const [phase, expectedOperations] of Object.entries(activePhaseOperations)) for (const mode of ['emit', 'privacy'] as const) {
  test(`active ${phase} ${mode} abort+throw stops socket work after cleanup and permits the next queued capture`, async () => {
    const withRow = (socket: Socket) => { socket.requestAction = () => {
      socket.emit('sent', [99, false]); socket.emit('completedOrder', ...completedRecord()); socket.emit('completedOrdersEnd');
    }; };
    const baseline = fixture(); withRow(baseline.socket);
    assert.equal((await baseline.client.load(request(undefined, 100))).ok, true);
    const privacyCall = baseline.events.findIndex(event => event.phase === `completed.${phase}`) + 1;
    assert.ok(privacyCall > 0);
    const controller = new AbortController(), sockets: Socket[] = [], events: BrokerPhaseEvent[] = [];
    let privacyCalls = 0, faulted = false, enqueuingSecond = false;
    const abortAndThrow = () => { faulted = true; controller.abort(); throw new Error('diagnostic abort then throw'); };
    const client = new CompletedOrdersClient({ host: 'unused', port: 1, clientId: 120 }, {
      createSocket: () => { const socket = new Socket(); withRow(socket); sockets.push(socket); return socket; },
      diagnostics: {
        emit: event => { events.push(event); if (mode === 'emit' && !faulted && event.captureId === 1 && event.phase === `completed.${phase}`) abortAndThrow(); },
        privacy: () => { if (!enqueuingSecond && ++privacyCalls === privacyCall && mode === 'privacy' && !faulted) abortAndThrow(); return {}; },
      },
    });
    const first = client.load(request(controller.signal, 100));
    enqueuingSecond = true;
    const second = client.load(request(undefined, 100));
    enqueuingSecond = false;
    assert.deepEqual(await first, { ok: false, rows: [], error: 'aborted' });
    const next = await second; assert.equal(next.ok, true); assert.equal(next.rows.length, 1); assert.equal(faulted, true);
    const firstCreated = expectedOperations.length > 0;
    assert.equal(sockets.length, firstCreated ? 2 : 1);
    if (firstCreated) assert.deepEqual(sockets[0].operations, expectedOperations);
    assert.deepEqual(sockets.at(-1)!.operations, ['connect', 'managed', 'completed', 'disconnect']);
    for (const socket of sockets) {
      assert.equal(socket.disconnects, 1); assert.deepEqual(socket.eventNames(), ['error']);
      assert.equal(socket.operations.indexOf('disconnect'), socket.operations.length - 1);
    }
    for (const captureId of [1, 2]) {
      const capture = events.filter(event => event.captureId === captureId);
      assert.equal(capture.filter(event => event.phase === 'completed.read').length, 1);
      assert.equal(capture.filter(event => event.phase === 'completed.settlement').length, 1); assertTrace(capture, captureId);
    }
  });
}
test('production adapter forwards correlation into the actual completed client diagnostics', async () => {
  const f = fixture();
  const tws = { getConnectionGeneration: () => 1, isConnected: () => true, getManagedAccounts: async () => ['DU-TEST'],
    reqPositionsSnapshot: async () => ({ ok: true, rows: [], endObserved: true }), reqAllOpenOrdersSnapshot: async () => ({ ok: true, rows: [], endObserved: true }),
    reqExecutionsSnapshot: async () => ({ ok: true, rows: [], endObserved: true }) } as unknown as TwsExecutionClient;
  const result = await new IbBrokerReconciliationAdapter(tws, f.client).capture({ ...captureRequest(), reconciliationRunId: 42 });
  assert.equal(result.recoveryComplete, true); assertTrace(f.events);
});
test('installed SDK emits the local write milestone and semantic end through its real encoder/decoder without a network socket', async () => {
  const api = new IBApi({ host: 'unused', port: 1, clientId: 120, maxReqPerSec: 40 });
  const controller = (api as unknown as { controller: { socket: { _serverVersion: number; client: { write: () => boolean } };
    emitEvent: (event: string, ...args: unknown[]) => void; onMessage: (tokens: string[]) => void; processIngressQueue: () => void } }).controller;
  controller.socket._serverVersion = 178; let writes = 0;
  controller.socket.client = { write: () => {
    if (++writes === 2) queueMicrotask(() => { controller.onMessage(['102']); controller.processIngressQueue(); });
    return true;
  } };
  Object.assign(api, { connect: () => { controller.emitEvent('nextValidId', 1); controller.emitEvent('managedAccounts', 'DU-TEST'); },
    disconnect: () => controller.emitEvent('disconnected') });
  const events: BrokerPhaseEvent[] = [];
  const client = new CompletedOrdersClient({ host: 'unused', port: 1, clientId: 120 }, {
    createSocket: () => api as unknown as CompletedOrdersSocket, diagnostics: { emit: event => events.push(event) },
  });
  assert.deepEqual(await client.load(request(undefined, 200)), { ok: true, rows: [] });
  assert.equal(writes, 2); assert.equal(events.filter(event => event.phase === 'completed.request_write').length, 1);
  assert.equal(events.filter(event => event.phase === 'completed.end').length, 1); assertTrace(events);
});
