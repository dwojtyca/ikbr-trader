import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { parseOwnerRecoveryAccountProbe } from '@ikbr/shared/accounting-owner-recovery';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { IBApi } from '@stoqey/ib';
import { createOwnerRecoveryProbeSocket, createOwnerRecoverySocket, runOwnerRecoveryAccountProbe,
  type OwnerRecoveryProbeSocket, type OwnerRecoveryProbeDependencies } from './owner-recovery-transport.js';

const input = { endpoint: { host: '127.0.0.1', port: 12345 }, accountId: 'DU_FIXTURE' };
const contract = { conId: 123, symbol: 'XYZ', secType: 'STK', currency: 'USD', exchange: 'SMART' };
class Fake extends EventEmitter implements OwnerRecoveryProbeSocket {
  calls: string[] = []; closeAcknowledged = true;
  connect() { this.calls.push('connect'); }
  disconnect() { this.calls.push('disconnect'); this.emit('disconnected'); if (this.closeAcknowledged) this.emit('transportClosed'); }
  reqManagedAccts() { this.calls.push('managedAccounts'); }
  reqPositions() { this.calls.push('positions'); }
  reqAllOpenOrders() { this.calls.push('allOpenOrders'); }
  ready(account = input.accountId) { this.emit('server', 180); this.emit('nextValidId', 1); this.emit('managedAccounts', account); }
  complete() { this.emit('positionEnd'); this.emit('openOrderEnd'); }
  position(quantity = 0, identity: unknown = contract, account: unknown = input.accountId) { this.emit('position', account, identity, quantity, 0); }
  order(orderId = 0) { this.emit('openOrder', orderId, contract, { account: input.accountId, totalQuantity: 0 }, { status: 'Cancelled' }); }
}
function fixture() {
  const socket = new Fake(), timers = new Map<number, { at: number; fn: () => void }>();
  let elapsed = 0, drift = 0, sequence = 0;
  const deps: OwnerRecoveryProbeDependencies = { socket: () => socket, now: () => 1800000000000 + elapsed + drift,
    monotonicNow: () => elapsed,
    schedule: (fn, ms) => { const id = ++sequence; timers.set(id, { at: elapsed + ms, fn }); return id; },
    cancel: key => { timers.delete(key as number); } };
  return { socket, deps, timers, advance: (ms: number) => {
    elapsed = ms;
    for (const [id, timer] of [...timers]) if (timer.at <= elapsed && timers.delete(id)) timer.fn();
  }, drift: (ms: number) => { drift = ms; }, stall: (ms: number) => { elapsed = ms; } };
}

test('complete empty streams require both dispatches, ends and native close', async () => {
  const f = fixture(); f.socket.closeAcknowledged = false;
  const pending = runOwnerRecoveryAccountProbe(input, f.deps); let settled = false;
  void pending.then(() => { settled = true; });
  f.socket.ready(); f.socket.emit('positionEnd'); await Promise.resolve(); assert.equal(settled, false);
  f.socket.emit('openOrderEnd'); await Promise.resolve(); assert.equal(settled, false);
  assert.deepEqual(f.socket.calls, ['connect', 'managedAccounts', 'positions', 'allOpenOrders', 'disconnect']);
  f.socket.emit('transportClosed'); const result = await pending;
  assert.equal(result.outcome, 'FLAT'); assert.equal(result.error, null); assert.equal(result.clientId, 0);
  assert.equal(result.protocolVersion, 180); assert.equal(result.sdkVersion, '@stoqey/ib@1.6.10');
  for (const field of ['connectedAt', 'readyAt', 'positionsRequestedAt', 'openOrdersRequestedAt', 'positionsEndAt', 'openOrdersEndAt', 'completedAt', 'closedAt'] as const) assert.ok(result[field]);
  assert.equal(result.positionRows, 0); assert.equal(result.openOrderRows, 0); assert.match(result.rowsDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.transportClosed, true); assert.equal(f.timers.size, 0);
});

test('valid zero rows are digested with stable identity and exact duplicate rows accepted', async () => {
  const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps);
  f.socket.ready(); f.socket.position(); f.socket.position(0, { ...contract }); f.socket.complete();
  const result = await pending; assert.equal(result.outcome, 'FLAT'); assert.equal(result.positionRows, 2);
  assert.ok(!JSON.stringify(result).includes('XYZ'));
  const other = fixture(), repeat = runOwnerRecoveryAccountProbe(input, other.deps);
  other.socket.ready(); other.socket.position(); other.socket.position(); other.socket.complete();
  assert.equal((await repeat).rowsDigest, result.rowsDigest);
});

for (const scenario of ['nonzero', 'nonzero-then-zero', 'order-zero', 'order-positive', 'order-negative', 'status-only', 'foreign-order', 'malformed-order'] as const) {
  test(`exposure cannot become flat: ${scenario}`, async () => {
    const f = fixture(); f.socket.closeAcknowledged = false;
    const pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
    if (scenario === 'nonzero' || scenario === 'nonzero-then-zero') {
      f.socket.position(-1); if (scenario === 'nonzero-then-zero') f.socket.position(0);
    } else if (scenario === 'status-only') f.socket.emit('orderStatus', 0, 'Filled');
    else if (scenario === 'foreign-order') f.socket.emit('openOrder', 0, contract, { account: 'OTHER', totalQuantity: 1 }, { status: 'Submitted' });
    else if (scenario === 'malformed-order') f.socket.emit('openOrder', undefined, null, null, null);
    else f.socket.order(scenario === 'order-zero' ? 0 : scenario === 'order-negative' ? -1 : 1);
    f.socket.complete(); f.socket.emit('transportClosed');
    const result = await pending; assert.equal(result.outcome, 'NONFLAT'); assert.ok(result.error);
    assert.equal(f.socket.calls.filter(v => v === 'disconnect').length, 1);
  });
}

for (const scenario of ['foreign', 'missing-account', 'malformed-contract', 'bad-conid', 'infinite', 'nan', 'string-quantity', 'bad-cost', 'bad-contract-number', 'huge-symbol', 'conflict'] as const) {
  test(`malformed or conflicting position denies: ${scenario}`, async () => {
    const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
    if (scenario === 'foreign') f.socket.position(0, contract, 'OTHER');
    else if (scenario === 'missing-account') f.socket.emit('position', undefined, contract, 0, 0);
    else if (scenario === 'malformed-contract') f.socket.position(0, null);
    else if (scenario === 'bad-conid') f.socket.position(0, { ...contract, conId: 0 });
    else if (scenario === 'infinite') f.socket.position(Infinity);
    else if (scenario === 'nan') f.socket.position(NaN);
    else if (scenario === 'string-quantity') f.socket.emit('position', input.accountId, contract, '0', 0);
    else if (scenario === 'bad-cost') f.socket.emit('position', input.accountId, contract, 0, Infinity);
    else if (scenario === 'bad-contract-number') f.socket.position(0, { ...contract, strike: NaN });
    else if (scenario === 'huge-symbol') f.socket.position(0, { ...contract, symbol: 'X'.repeat(129) });
    else { f.socket.position(); f.socket.position(0, { ...contract, currency: 'PLN' }); }
    const result = await pending; assert.equal(result.outcome, 'INCOMPLETE'); assert.ok(result.error);
  });
}

for (const scenario of ['early-position-end', 'early-order-end', 'position-before-request', 'duplicate-position-end', 'duplicate-order-end', 'late-zero', 'late-exposure', 'late-order', 'late-status', 'late-error', 'late-account', 'late-server', 'late-ready'] as const) {
  test(`unexpected and late callbacks remain active through native close: ${scenario}`, async () => {
    const f = fixture(); f.socket.closeAcknowledged = false;
    const pending = runOwnerRecoveryAccountProbe(input, f.deps);
    if (scenario === 'early-position-end') f.socket.emit('positionEnd');
    else if (scenario === 'early-order-end') f.socket.emit('openOrderEnd');
    else if (scenario === 'position-before-request') f.socket.position();
    else {
      f.socket.ready(); f.socket.complete();
      if (scenario === 'duplicate-position-end') f.socket.emit('positionEnd');
      else if (scenario === 'duplicate-order-end') f.socket.emit('openOrderEnd');
      else if (scenario === 'late-zero') f.socket.position();
      else if (scenario === 'late-exposure') f.socket.position(1);
      else if (scenario === 'late-order') f.socket.order();
      else if (scenario === 'late-status') f.socket.emit('orderStatus', 0, 'Cancelled');
      else if (scenario === 'late-error') f.socket.emit('error', new Error('lost'), 1100);
      else if (scenario === 'late-account') f.socket.emit('managedAccounts', 'OTHER');
      else if (scenario === 'late-server') f.socket.emit('server', 180);
      else f.socket.emit('nextValidId', 1);
    }
    f.socket.emit('transportClosed'); assert.notEqual((await pending).outcome, 'FLAT');
  });
}

for (const scenario of ['missing-server', 'missing-ready', 'missing-account', 'missing-positions-end', 'missing-orders-end', 'both-missing'] as const) {
  test(`18 second timeout preserves positive closure and incomplete coverage: ${scenario}`, async () => {
    const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps);
    if (scenario !== 'missing-server') f.socket.emit('server', 180);
    if (scenario !== 'missing-ready') f.socket.emit('nextValidId', 1);
    if (scenario !== 'missing-account') f.socket.emit('managedAccounts', input.accountId);
    if (scenario === 'missing-positions-end') f.socket.emit('openOrderEnd');
    if (scenario === 'missing-orders-end') f.socket.emit('positionEnd');
    f.advance(18000); const result = await pending;
    assert.equal(result.outcome, 'INCOMPLETE'); assert.match(result.error!.code, /TIMEOUT/); assert.equal(result.transportClosed, true);
    assert.equal(f.socket.calls.filter(v => v === 'connect').length, 1); assert.equal(f.timers.size, 0);
  });
}

test('logical disconnect never proves close; early and total closure deadlines reject', async () => {
  for (const at of [0, 18000]) {
    const f = fixture(); f.socket.closeAcknowledged = false;
    const pending = runOwnerRecoveryAccountProbe(input, f.deps), denied = assert.rejects(pending, /CLOSURE_UNKNOWN/);
    if (at === 0) { f.socket.ready(); f.socket.complete(); } else f.advance(at);
    f.socket.emit('disconnected'); f.advance(at + 1999); assert.equal(f.timers.size > 0, true);
    f.advance(at + 2000); await denied; assert.equal(f.timers.size, 0);
    f.socket.emit('transportClosed'); assert.equal(f.socket.calls.filter(v => v === 'disconnect').length, 1);
  }
});

test('native close without logical disconnect is positive failure evidence', async () => {
  const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps);
  f.socket.emit('transportClosed'); const result = await pending;
  assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.transportClosed, true);
  assert.match(result.error!.code, /DISCONNECTED/);
});

test('each completion must follow its own dispatch, including reentrant callbacks', async () => {
  const f = fixture();
  f.socket.reqPositions = () => { f.socket.calls.push('positions'); f.socket.emit('openOrderEnd'); };
  const pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
  const result = await pending;
  assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.openOrdersRequestedAt, null);
  assert.equal(result.openOrdersEndAt, null); assert.ok(!f.socket.calls.includes('allOpenOrders'));
});

test('request and disconnect exceptions retain sanitized causes and require native closure', async () => {
  for (const phase of ['request', 'disconnect']) {
    const f = fixture(); f.socket.closeAcknowledged = false;
    if (phase === 'request') f.socket.reqPositions = () => { throw new TypeError('DU_FIXTURE request failed'); };
    else f.socket.disconnect = () => { f.socket.calls.push('disconnect'); throw new TypeError('DU_FIXTURE disconnect failed'); };
    const pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
    if (phase === 'disconnect') f.socket.complete();
    f.socket.emit('transportClosed'); const result = await pending;
    assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.error!.cause!.name, 'TypeError');
    assert.equal(result.error!.cause!.code, null); assert.ok(!result.error!.cause!.message!.includes('DU_FIXTURE'));
  }
});

test('factory/connect exceptions without observed native close reject; closed connect failure returns evidence', async () => {
  const f = fixture(); f.deps.socket = () => { throw new Error('factory'); };
  await assert.rejects(runOwnerRecoveryAccountProbe(input, f.deps), /CLOSURE_UNKNOWN/);
  for (const closed of [true, false]) {
    const next = fixture(); next.socket.closeAcknowledged = closed;
    next.socket.connect = () => { throw new Error('connect'); };
    const pending = runOwnerRecoveryAccountProbe(input, next.deps);
    if (closed) assert.match((await pending).error!.code, /CONNECT_FAILED/);
    else { const denied = assert.rejects(pending, /CLOSURE_UNKNOWN/); next.advance(2000); await denied; }
  }
});

test('unavailable SDK native socket cannot fabricate closure or retry', async () => {
  const originalConnect = IBApi.prototype.connect, originalDisconnect = IBApi.prototype.disconnect;
  let connects = 0;
  try {
    IBApi.prototype.connect = function () { connects++; return this; };
    IBApi.prototype.disconnect = function () { return this; };
    const f = fixture(); f.deps.socket = () => createOwnerRecoveryProbeSocket(input.endpoint);
    const pending = runOwnerRecoveryAccountProbe(input, f.deps), denied = assert.rejects(pending, /CLOSURE_UNKNOWN/);
    f.advance(2000); await denied; assert.equal(connects, 1);
  } finally { IBApi.prototype.connect = originalConnect; IBApi.prototype.disconnect = originalDisconnect; }
});

for (const version of [null, 0, 66, 194, NaN, Infinity, '180']) {
  test(`unsupported/unknown protocol ${String(version)} cannot dispatch snapshots`, async () => {
    const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.emit('server', version);
    assert.equal((await pending).outcome, 'INCOMPLETE'); assert.deepEqual(f.socket.calls, ['connect', 'disconnect']);
  });
}

for (const account of ['', 'OTHER', 'DU_FIXTURE,OTHER', 'DU_FIXTURE,DU_FIXTURE', 'DU_FIXTURE,']) {
  test(`exact one-account topology rejects ${JSON.stringify(account)}`, async () => {
    const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready(account);
    assert.equal((await pending).outcome, 'INCOMPLETE'); assert.ok(!f.socket.calls.includes('positions'));
  });
}

test('only explicit harmless farm codes are ignored; collisions and data loss deny with sanitized causes', async () => {
  const f = fixture(), pending = runOwnerRecoveryAccountProbe({ ...input, privacy: { secrets: ['private-token'] } }, f.deps);
  f.socket.ready();
  for (const code of [2104, 2106, 2107, 2108, 2158]) f.socket.emit('error', new Error('farm'), code);
  f.socket.emit('error', new Error('DU_FIXTURE private-token collision'), 326);
  const result = await pending;
  assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.error!.cause!.name, 'Error');
  assert.equal(result.error!.cause!.code, '326'); assert.ok(!result.error!.cause!.message!.includes('DU_FIXTURE'));
  assert.ok(!result.error!.cause!.message!.includes('private-token'));
  const other = fixture(), success = runOwnerRecoveryAccountProbe(input, other.deps);
  other.socket.ready(); other.socket.emit('error', new Error('farm'), 2104); other.socket.complete();
  assert.equal((await success).outcome, 'FLAT');
});

test('abort before socket creation opens nothing; abort during collection or close still records positive close', async () => {
  const before = new AbortController(); before.abort(); const first = fixture();
  first.deps.socket = () => { assert.fail('socket created'); };
  await assert.rejects(runOwnerRecoveryAccountProbe({ ...input, signal: before.signal }, first.deps), /ABORTED/);
  for (const complete of [false, true]) {
    const f = fixture(), signal = new AbortController(); f.socket.closeAcknowledged = false;
    const pending = runOwnerRecoveryAccountProbe({ ...input, signal: signal.signal }, f.deps);
    f.socket.ready(); if (complete) f.socket.complete(); signal.abort(); f.socket.emit('transportClosed');
    assert.equal((await pending).outcome, 'INCOMPLETE'); assert.equal(f.timers.size, 0);
  }
});

test('clock skew and backwards time invalidate data and closure', async () => {
  for (const phase of ['data', 'close', 'backwards']) {
    const f = fixture(); f.socket.closeAcknowledged = false;
    const pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
    if (phase === 'close') f.socket.complete();
    if (phase === 'backwards') f.advance(-1); else f.drift(1001);
    f.socket.emit('transportClosed'); assert.equal((await pending).outcome, 'INCOMPLETE');
  }
});

test('delayed timer callbacks cannot extend collection or native-close budgets', async () => {
  for (const phase of ['data', 'close', 'total']) {
    const f = fixture(); f.socket.closeAcknowledged = false;
    const pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
    if (phase !== 'data') f.socket.complete();
    f.stall(phase === 'data' ? 18000 : phase === 'close' ? 2000 : 20000);
    if (phase === 'data') f.socket.complete();
    f.socket.emit('transportClosed'); assert.equal((await pending).outcome, 'INCOMPLETE');
  }
});

test('reaching 4096 callbacks is incomplete and retained output stays bounded', async () => {
  const f = fixture(); f.socket.closeAcknowledged = false;
  const pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
  for (let i = 0; i < 4200; i++) f.socket.emit('error', new Error('farm'), 2104);
  f.socket.emit('transportClosed'); const result = await pending;
  assert.equal(result.outcome, 'INCOMPLETE'); assert.match(result.error!.code, /OUTPUT_LIMIT/); assert.equal(result.eventCount, 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024); assert.equal(f.timers.size, 0);
});

function frame(tokens: (string | number)[]): Buffer {
  const body = Buffer.from(tokens.join('\0') + '\0'), header = Buffer.alloc(4);
  header.writeInt32BE(body.length); return Buffer.concat([header, body]);
}
test('installed SDK client-0 wire path sends only startup and non-binding reads then observes native close', { timeout: 5000 }, async () => {
  assert.deepEqual(Object.keys(createOwnerRecoverySocket(input.endpoint)).sort(), ['connect', 'disconnect', 'on', 'reqManagedAccts']);
  assert.deepEqual(Object.keys(createOwnerRecoveryProbeSocket(input.endpoint)).sort(), ['connect', 'disconnect', 'on', 'reqAllOpenOrders', 'reqManagedAccts', 'reqPositions']);
  const codes: number[] = []; let peer: Socket | undefined;
  const server = createServer(socket => {
    peer = socket; let bytes = Buffer.alloc(0), hello = false;
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!hello) {
        if (bytes.length < 8 || bytes.length < 8 + bytes.readInt32BE(4)) return;
        assert.equal(bytes.subarray(0, 4).toString(), 'API\0'); bytes = bytes.subarray(8 + bytes.readInt32BE(4)); hello = true;
        socket.write(frame([180, '20261027 12:00:00']));
      }
      while (bytes.length >= 4 && bytes.length >= 4 + bytes.readInt32BE()) {
        const length = bytes.readInt32BE(), tokens = bytes.subarray(4, 4 + length).toString().split('\0');
        bytes = bytes.subarray(4 + length); codes.push(Number(tokens[0]));
        if (tokens[0] === '71') {
          assert.equal(tokens[2], '0'); socket.write(frame([15, 1, input.accountId])); socket.write(frame([9, 1, 1]));
        } else if (tokens[0] === '17') socket.write(frame([15, 1, input.accountId]));
        else if (tokens[0] === '61') {
          socket.write(frame([61, 3, input.accountId, 123, 'XYZ', 'STK', '', 0, '', '', 'SMART', 'USD', 'XYZ', 'XYZ', 0, 0]));
          socket.write(frame([62, 1]));
        } else if (tokens[0] === '16') socket.write(frame([53, 1]));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await runOwnerRecoveryAccountProbe({ ...input, endpoint: { host: '127.0.0.1', port: (server.address() as { port: number }).port } });
    assert.equal(result.outcome, 'FLAT', JSON.stringify(result.error)); assert.equal(result.positionRows, 1);
    assert.equal(result.transportClosed, true); assert.deepEqual(codes, [71, 17, 61, 16]);
  } finally { peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('positively closed failure diagnostics fit the strict persisted-proof bounds', async () => {
  const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps);
  f.socket.ready();
  const cause = Object.assign(new Error('message '.repeat(400)), { name: 'n'.repeat(400) });
  f.socket.emit('error', cause, 'c'.repeat(400));
  const result = await pending;
  assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.transportClosed, true);
  assert.equal(result.error?.cause?.name?.length, 200); assert.equal(result.error?.cause?.code?.length, 200);
  assert.ok(result.error?.cause?.message && result.error.cause.message.length <= 1000);
  assert.equal(result.error.cause.message, result.error.cause.message.trim());
  assert.equal(parseOwnerRecoveryAccountProbe({ version: 2, probeId: randomUUID(), operationId: randomUUID(), nonce: randomUUID(), sessionId: randomUUID(),
    dispatchEventId: randomUUID(), phase: 'pre-reset', endpoint: { ...input.endpoint, clientId: 0 }, result }).result.transportClosed, true);
});


test('empty or whitespace probe diagnostic causes remain unavailable rather than invalid proof text', async () => {
  for (const text of ['', '   ']) {
    const f = fixture(), pending = runOwnerRecoveryAccountProbe(input, f.deps); f.socket.ready();
    f.socket.emit('error', { name: text, message: text }, text);
    const result = await pending;
    assert.equal(result.outcome, 'INCOMPLETE'); assert.equal(result.transportClosed, true);
    assert.deepEqual(result.error?.cause, { name: null, code: null, message: null });
    assert.equal(parseOwnerRecoveryAccountProbe({ version: 2, probeId: randomUUID(), operationId: randomUUID(), nonce: randomUUID(), sessionId: randomUUID(),
      dispatchEventId: randomUUID(), phase: 'pre-reset', endpoint: { ...input.endpoint, clientId: 0 }, result }).result.transportClosed, true);
  }
});
