import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { OfficialAccountingSocket, OFFICIAL_SDK_SHA256 } from './official-sdk-bridge.js';

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (_signal: string) => true });
  const commands: Array<Record<string, unknown>> = [], errors: unknown[] = [], launches: unknown[][] = [];
  child.stdin.on('data', chunk => commands.push(JSON.parse(chunk.toString())));
  const socket = new OfficialAccountingSocket({ host: 'localhost', port: 1 }, 'TEST', ((...args: unknown[]) => { launches.push(args); return child; }) as unknown as typeof spawn);
  socket.on('error', error => errors.push(error));
  let seq = 0;
  function frame(type: string, payload: unknown, command = commands.at(-1), overrides: Record<string, unknown> = {}) {
    const first = commands[0];
    return JSON.stringify({ v: 1, sessionId: first.sessionId, generation: 1, seq: ++seq, type, payload,
      ...(command ? { commandId: command.commandId, requestId: command.requestId } : {}), ...overrides }) + '\n';
  }
  function send(type: string, payload: unknown, command = commands.at(-1), overrides: Record<string, unknown> = {}) { child.stdout.write(frame(type, payload, command, overrides)); }
  function connect() { socket.connect(); send('connected', { sdkVersion: '1051.1', protobufVersion: '5.29.5', sdkSha256: OFFICIAL_SDK_SHA256, serverVersion: 226, connectionTime: 'test' }); }
  function close() { socket.disconnect(); child.emit('close', 0); }
  return { child, socket, commands, errors, launches, frame, send, connect, close };
}

test('official bridge fixes executable/env, correlates config and projects millis', async () => {
  const f = fixture(); f.connect();
  const [exe, args, options] = f.launches[0] as [string, string[], { env: Record<string,string>; shell: boolean }];
  assert.equal(exe, '/opt/ikbr-sdk/bin/python'); assert.equal(options.shell, false); assert.ok(args.includes('-I'));
  assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'PATH']);
  const config = f.socket.reqConfig(); f.send('config', { masterClientIdPresent: true, masterClientId: 0 });
  assert.equal((await config).masterClientId, 0);
  let millis = 0; f.socket.on('currentTimeInMillis', v => { millis = v; });
  f.socket.reqCurrentTime(); const line = f.frame('clock', { milliseconds: 1234567890000 });
  f.child.stdout.write(line.slice(0, 20)); f.child.stdout.write(line.slice(20));
  assert.equal(millis, 1234567890000); assert.equal(f.errors.length, 0); f.close();
});

test('execution request correlation translates child IDs and keeps late fees', () => {
  const f = fixture(); f.connect(); const events: unknown[][] = [];
  f.socket.on('execDetails', (...v) => events.push(v));
  f.socket.on('commissionReport', (...v) => events.push(v));
  f.socket.reqExecutions(42, { clientId: 0, acctCode: 'TEST', time: '20261026-12:00:00', lastNDays: 7, symbol: '', secType: '', exchange: '', side: '' });
  f.send('execution', { ibRequestId: f.commands.at(-1)!.requestId, contract: { conId: 1, symbol: 'TEST', secType: 'STK', currency: 'USD' },
    execution: { orderId: 1, execId: 'fill', time: '20261028 12:00:00Z', acctNumber: 'TEST', exchange: 'SMART', side: 'BOT', shares: '1.0', price: 5 } });
  f.send('executionsEnd', {});
  f.send('commission', { execId: 'fill', currency: 'USD', commission: null, realizedPNL: null }, undefined, { commandId: undefined, requestId: undefined });
  assert.equal(events[0][0], 42); assert.equal((events[0][2] as {shares:number}).shares, 1);
  assert.deepEqual(events[1][0], { execId: 'fill', currency: 'USD', commission: null, realizedPNL: null }); f.close();
});

for (const fault of ['stale', 'duplicate', 'unknown', 'oversize', 'invalidUtf8', 'stderr', 'unexpectedEnd', 'missingMaster'] as const) {
  test(`bridge fences ${fault} output`, async () => {
    const f = fixture(); f.connect();
    let pending: Promise<unknown> | undefined;
    if (fault === 'stale') f.send('disconnected', {}, undefined, { sessionId: 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb' });
    if (fault === 'duplicate') f.send('disconnected', {}, undefined, { seq: 1 });
    if (fault === 'unknown') f.send('placeOrder', {});
    if (fault === 'oversize') f.child.stdout.write(Buffer.alloc(65537, 65));
    if (fault === 'invalidUtf8') f.child.stdout.write(Buffer.from([255, 10]));
    if (fault === 'stderr') f.child.stderr.write('private data');
    if (fault === 'unexpectedEnd') f.send('executionsEnd', {});
    if (fault === 'missingMaster') { pending = f.socket.reqConfig(); f.send('config', { masterClientId: 0 }); await assert.rejects(pending); }
    assert.ok(f.errors.length); assert.equal(f.child.stdin.writableEnded, true);
    assert.ok(!JSON.stringify(f.errors).includes('private data')); f.close();
  });
}

test('EOF alone is not closure; bounded signals target only the spawned child', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), signals: string[] = []; let closed = false;
  f.child.kill = signal => { signals.push(signal); return true; };
  f.socket.on('transportClosed', () => { closed = true; }); f.connect(); f.socket.disconnect();
  assert.equal(closed, false); t.mock.timers.tick(2000); assert.deepEqual(signals, ['SIGTERM']);
  t.mock.timers.tick(2000); assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']); assert.equal(closed, false);
  f.child.emit('close', 0); assert.equal(closed, true);
});

test('command deadline retires generation and rejects pending configuration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(); f.connect();
  const pending = f.socket.reqConfig(); t.mock.timers.tick(30000); await assert.rejects(pending);
  assert.ok(f.errors.length); f.close();
});
