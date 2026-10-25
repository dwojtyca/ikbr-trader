import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { runOwnerRecoveryHandshake, type OwnerRecoverySocket, type OwnerRecoveryTransportDependencies } from './owner-recovery-transport.js';

const input = { endpoint: { host: '127.0.0.1', port: 12345 }, accountId: 'DU_FIXTURE' };
class Fake extends EventEmitter implements OwnerRecoverySocket {
  connects = 0; disconnects = 0; requests = 0; closeAcknowledged = true;
  connect() { this.connects++; }
  disconnect() { this.disconnects++; this.emit('disconnected'); if (this.closeAcknowledged) this.emit('transportClosed'); }
  reqManagedAccts() { this.requests++; }
  ready(account = input.accountId) { this.emit('server', 180); this.emit('nextValidId', 1); this.emit('managedAccounts', account); }
}
function fixture() {
  const socket = new Fake(), timers = new Map<number, () => void>();
  let elapsed = 0, drift = 0;
  const deps: OwnerRecoveryTransportDependencies = { socket: () => socket, now: () => 1800000000000 + elapsed + drift,
    monotonicNow: () => elapsed, schedule: (fn, ms) => { timers.set(ms, fn); return ms; }, cancel: key => { timers.delete(key as number); } };
  return { socket, deps, timers, advance: (ms: number) => { elapsed = ms; timers.get(ms)?.(); }, drift: (ms: number) => { drift = ms; } };
}

test('handshake waits for exact native closure and exposes only read-only methods', async () => {
  const f = fixture(); f.socket.closeAcknowledged = false;
  const pending = runOwnerRecoveryHandshake(input, f.deps); let settled = false;
  void pending.then(() => { settled = true; });
  f.socket.ready(); await Promise.resolve(); assert.equal(settled, false);
  assert.equal(f.socket.disconnects, 1); assert.equal(f.socket.requests, 1);
  f.socket.emit('disconnected'); await Promise.resolve(); assert.equal(settled, false);
  f.socket.emit('transportClosed'); const result = await pending;
  assert.equal(result.transportClosed, true); assert.equal(result.clientId, 0); assert.equal(result.protocolVersion, 180);
  f.socket.ready('WRONG'); assert.equal(f.socket.connects, 1); assert.equal(f.socket.disconnects, 1);
  assert.equal(f.timers.size, 0);
});

for (const scenario of ['wrong-account', 'multiple-accounts', 'duplicate-account', 'missing-server', 'missing-ready', 'bad-ready', 'disconnect', 'error', 'drift', 'backwards'] as const) {
  test(`handshake rejects ${scenario} and cannot be revived`, async () => {
    const f = fixture(), pending = runOwnerRecoveryHandshake(input, f.deps);
    const denied = assert.rejects(pending, /ACCOUNTING_OWNER_RECOVERY_(HANDSHAKE_UNKNOWN|ACCOUNT_MISMATCH|CLOCK_UNCERTAIN)/);
    if (scenario === 'wrong-account') f.socket.ready('OTHER');
    else if (scenario === 'multiple-accounts') f.socket.ready('DU_FIXTURE,OTHER');
    else if (scenario === 'duplicate-account') f.socket.ready('DU_FIXTURE,DU_FIXTURE');
    else if (scenario === 'missing-server') { f.socket.emit('nextValidId', 1); f.socket.emit('managedAccounts', input.accountId); f.advance(8000); }
    else if (scenario === 'missing-ready') { f.socket.emit('server', 180); f.socket.emit('managedAccounts', input.accountId); f.advance(8000); }
    else if (scenario === 'bad-ready') f.socket.emit('nextValidId', -1);
    else if (scenario === 'disconnect') f.socket.emit('disconnected');
    else if (scenario === 'error') f.socket.emit('error', new Error('test'), 1100);
    else if (scenario === 'drift') { f.drift(1001); f.socket.ready(); }
    else { f.advance(-1); f.socket.ready(); }
    await denied; f.socket.ready(); assert.equal(f.socket.connects, 1); assert.equal(f.socket.disconnects, 1);
  });
}

test('handshake reserves close budget and denies absent close acknowledgement', async () => {
  const f = fixture(); f.socket.closeAcknowledged = false;
  const pending = runOwnerRecoveryHandshake(input, f.deps), denied = assert.rejects(pending, /CLOSURE_UNKNOWN/);
  f.advance(8000); assert.equal(f.socket.disconnects, 1);
  f.socket.ready(); f.advance(10000); await denied;
  f.socket.emit('transportClosed'); assert.equal(f.socket.connects, 1);
});

test('cancellation before open never creates a transport; cancellation after open still closes', async () => {
  const f = fixture(), first = new AbortController(); first.abort();
  await assert.rejects(runOwnerRecoveryHandshake({ ...input, signal: first.signal }, f.deps), /HANDSHAKE_UNKNOWN/);
  assert.equal(f.socket.connects, 0);
  const second = new AbortController();
  const pending = runOwnerRecoveryHandshake({ ...input, signal: second.signal }, f.deps);
  const denied = assert.rejects(pending, /HANDSHAKE_UNKNOWN/); second.abort(); await denied;
  assert.equal(f.socket.disconnects, 1);
});

test('sanitized broker cause preserves original name/code without account or token', async () => {
  const f = fixture(), pending = runOwnerRecoveryHandshake({ ...input, privacy: { secrets: ['super-private-token'] } }, f.deps);
  const denied = assert.rejects(pending, error => {
    const cause = (error as Error).cause as { name: string; code: string; message: string };
    assert.equal(cause.name, 'Error'); assert.equal(cause.code, '1100');
    assert.ok(!cause.message.includes('DU_FIXTURE')); assert.ok(!cause.message.includes('super-private-token')); return true;
  });
  f.socket.emit('error', new Error('DU_FIXTURE super-private-token disconnected'), 1100); await denied;
});

function frame(tokens: (string | number)[]): Buffer {
  const body = Buffer.from(tokens.join('\0') + '\0'), header = Buffer.alloc(4);
  header.writeInt32BE(body.length); return Buffer.concat([header, body]);
}
test('installed SDK against fake TCP peer sends only client-0 startup and optional account request, then closes', { timeout: 5000 }, async () => {
  const codes: number[] = []; let peer: Socket | undefined;
  const server = createServer(socket => {
    peer = socket; let bytes = Buffer.alloc(0), hello = false;
    socket.on('error', () => undefined);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!hello) {
        if (bytes.length < 8 || bytes.length < 8 + bytes.readInt32BE(4)) return;
        assert.equal(bytes.subarray(0, 4).toString(), 'API\0');
        bytes = bytes.subarray(8 + bytes.readInt32BE(4)); hello = true;
        socket.write(frame([180, '20261019 12:00:00']));
      }
      while (bytes.length >= 4 && bytes.length >= 4 + bytes.readInt32BE()) {
        const length = bytes.readInt32BE(), tokens = bytes.subarray(4, 4 + length).toString().split('\0');
        bytes = bytes.subarray(4 + length); codes.push(Number(tokens[0]));
        if (tokens[0] === '71') {
          assert.equal(tokens[2], '0');
          socket.write(frame([15, 1, input.accountId])); socket.write(frame([9, 1, 1]));
        }
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const result = await runOwnerRecoveryHandshake({ ...input, endpoint: { host: '127.0.0.1', port: (server.address() as { port: number }).port } });
    assert.equal(result.transportClosed, true); assert.equal(result.protocolVersion, 180);
    assert.equal(codes[0], 71); assert.ok(codes.every(code => code === 71 || code === 17));
  } finally { peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
