import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { startAccountingDockerWatcher, AccountingRecoveryHostError, type AccountingDockerWatcherAdapters,
  type RecoveryHostCommandResult } from './accounting-owner-recovery-host.js';
import { accountingWatcherDiagnostic } from './accounting-owner-recovery-cli.js';
const hash = 'a'.repeat(64), base = Date.parse('2026-10-26T12:00:00.000Z');
const options = { project: 'fixture', imageId: `sha256:${hash}`, dockerHost: 'unix:///var/run/docker.sock', root: '/fixture', host: '127.0.0.1', port: 7497 };
const exception = { containerId: hash, imageId: options.imageId, name: 'accounting-owner-recovery-fixture', requestId: 'fixture' };
function fixture() {
  let clock = base, sequence = 0, calls = 0, killed = 0, failures = 0, concurrent = 0, maxConcurrent = 0, timerId = 0;
  const history: Array<{ at: number; line: string }> = [], timers = new Map<number, { at: number; fn: () => void }>();
  const stream = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { killed++; return true; } });
  let override: ((normal: RecoveryHostCommandResult, call: number) => Promise<RecoveryHostCommandResult> | RecoveryHostCommandResult) | undefined;
  const event = (type = 'container', action = 'exec_die', at = clock, name = 'infrastructure') => {
    const nano = (BigInt(at) * 1000000n + BigInt(sequence++)).toString();
    return JSON.stringify({ Type: type, Action: action, Actor: { ID: hash, Attributes: { name } }, time: Math.floor(at / 1000), timeNano: nano }).replace(`"${nano}"`, nano);
  };
  const add = (type = 'container', action = 'exec_die', at = clock, name = 'infrastructure') => {
    const line = event(type, action, at, name); history.push({ at, line }); if (history.length > 256) history.shift(); return line;
  };
  add('network', 'connect', clock - 1000);
  const adapters: AccountingDockerWatcherAdapters = {
    now: () => clock,
    spawnEvents: args => { assert.ok(args.includes('type=container')); return stream as unknown as ReturnType<typeof spawn>; },
    schedule: ((fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; }) as unknown as typeof setTimeout,
    unschedule: (id => { timers.delete(Number(id)); }) as typeof clearTimeout,
    run: async (_file, args) => {
      assert.equal(args.includes('--filter'), false, 'replay must inspect global retention');
      const since = Date.parse(args[args.indexOf('--since') + 1]), until = Date.parse(args[args.indexOf('--until') + 1]);
      const selected = history.filter(row => row.at >= since && row.at <= until);
      const normal = { stdout: selected.map(row => row.line).join('\n') + (selected.length ? '\n' : ''), stderr: '', exitCode: 0 };
      calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      try { return override ? await override(normal, calls) : normal; } finally { concurrent--; }
    },
  };
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));
  return { adapters, history, stream, event, add, timers, drain,
    override: (value: typeof override) => { override = value; },
    start: () => startAccountingDockerWatcher(options, () => { failures++; }, exception.name, adapters),
    stats: () => ({ calls, killed, failures, concurrent, maxConcurrent, clock }),
    advance: async (ms: number) => {
      const end = clock + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at; timers.delete(next[0]); next[1].fn(); await drain();
      }
      clock = end; await drain();
    },
  };
}
const reason = (value: string) => (error: unknown) => accountingWatcherDiagnostic(error)?.endsWith(`/${value}`) === true;
function paddedEvent(line: string, bytes: number): string {
  const empty = line.replace('"Attributes":{', '"Attributes":{"fixturePadding":"",');
  const result = empty.replace('"fixturePadding":""', `"fixturePadding":"${'x'.repeat(bytes - Buffer.byteLength(empty) - 1)}"`);
  assert.equal(Buffer.byteLength(result + '\n'), bytes);
  return result;
}

test('15-minute watcher retains exact checkpoints through repeated global eviction and fails at its deadline', async () => {
  const f = fixture(), watcher = await f.start(), original = f.history[0].line;
  try {
    assert.equal(watcher.startedAt, new Date(base).toISOString());
    for (let second = 0; second < 899; second++) {
      for (let event = 0; event < 20; event++) f.add(event % 2 ? 'container' : 'network', event % 2 ? 'exec_die' : 'connect');
      await f.advance(1000); watcher.check();
    }
    assert.equal(f.history.some(row => row.line === original), false);
    await watcher.flush(); assert.equal(f.stats().maxConcurrent, 1); assert.equal(f.stats().failures, 0);
    await f.advance(1000); assert.throws(watcher.check, reason('DEADLINE')); assert.equal(f.timers.size, 0);
  } finally { watcher.close(); }
});

test('15-minute realistic health stream exceeds one MiB while maintaining replay continuity and the deadline', async () => {
  const f = fixture(), watcher = await f.start(), original = f.history[0].line;
  let received = 0;
  try {
    for (let second = 0; second < 899; second++) {
      for (let n = 0; n < (second % 5 === 0 ? 2 : 1); n++) {
        const line = paddedEvent(f.add('container', ['exec_create', 'exec_start', 'exec_die'][second % 3]), 1600);
        f.history.at(-1)!.line = line;
        f.stream.stdout.write(line + '\n'); received += Buffer.byteLength(line + '\n');
      }
      await f.advance(1000); watcher.check();
    }
    assert.equal(received, 1079 * 1600); assert.ok(received > 1024 * 1024);
    assert.equal(f.history.some(row => row.line === original), false);
    await watcher.flush(); assert.equal(f.stats().failures, 0); assert.equal(f.stats().maxConcurrent, 1);
    await f.advance(1000); assert.throws(watcher.check, reason('DEADLINE')); assert.equal(f.timers.size, 0);
  } finally { watcher.close(); }
});

test('stream accepts exactly four MiB and latches output limit on the next byte', async () => {
  const f = fixture(), watcher = await f.start();
  try {
    for (let n = 0; n < 2048; n++) f.stream.stdout.write(paddedEvent(f.event(), 2048) + '\n');
    watcher.check(); assert.equal(f.stats().failures, 0); assert.equal(f.stats().killed, 0);
    f.stream.stdout.write('x');
    assert.throws(watcher.check, reason('OUTPUT_LIMIT'));
    assert.equal(f.stats().failures, 1); assert.equal(f.stats().killed, 1); assert.equal(f.timers.size, 0);
    f.stream.stdout.write('x'); await assert.rejects(watcher.flush(), reason('OUTPUT_LIMIT'));
    assert.equal(f.stats().failures, 1); assert.equal(f.stats().killed, 1);
  } finally { watcher.close(); }
});

test('stream partial buffer accepts exactly 64 KiB and fails closed on the next byte', async () => {
  const f = fixture(), watcher = await f.start();
  try {
    f.stream.stdout.write('x'.repeat(65536));
    watcher.check(); assert.equal(f.stats().failures, 0); assert.equal(f.stats().killed, 0);
    f.stream.stdout.write('x');
    assert.throws(watcher.check, error => accountingWatcherDiagnostic(error) === 'AccountingDockerEventWatcher:stream/OUTPUT_LIMIT');
    assert.equal(f.stats().failures, 1); assert.equal(f.stats().killed, 1); assert.equal(f.timers.size, 0);
    await assert.rejects(watcher.flush(), reason('OUTPUT_LIMIT'));
    assert.equal(f.stats().failures, 1); assert.equal(f.stats().killed, 1);
  } finally { watcher.close(); }
});

test('bootstrap accepts full old history but refuses absent, ambiguous or malformed initial anchor before returning a watcher', async () => {
  const f = fixture(); f.history.length = 0;
  for (let n = 0; n < 256; n++) f.add('container', 'start', base - (257 - n) * 1000);
  const watcher = await f.start(); await watcher.flush(); watcher.close();
  for (const mode of ['empty', 'duplicate', 'malformed', 'timestamp', 'partial', 'too-many']) {
    const g = fixture();
    g.override(normal => {
      const line = g.history[0].line;
      const stdout = mode === 'empty' ? '' : mode === 'duplicate' ? line + '\n' + line + '\n' : mode === 'malformed' ? '{}\n' :
        mode === 'timestamp' ? line.replace(/"time":\d+/, '"time":9007199254740991') + '\n' : mode === 'partial' ? line : (line + '\n').repeat(257);
      return { ...normal, stdout };
    });
    let inventoryStarted = false;
    await assert.rejects(g.start().then(() => { inventoryStarted = true; }), /INVENTORY_UNAVAILABLE/, mode);
    assert.equal(inventoryStarted, false); assert.equal(g.stats().failures, 1); assert.equal(g.timers.size, 0); assert.ok(g.stats().killed > 0);
  }
});

test('quiet daemon retains its anchor while missing, duplicate and overflow replay evidence still denies', async () => {
  const quiet = fixture(), watcher = await quiet.start();
  await quiet.advance(60000); await watcher.flush(); watcher.check(); watcher.close();
  for (const mode of ['missing', 'duplicate', 'overflow', 'partial', 'malformed', 'command', 'oversized']) {
    const f = fixture(), current = await f.start();
    f.override(normal => {
      const line = f.history[0].line;
      return mode === 'command' ? { ...normal, exitCode: 1, stderr: 'private-command-content' } : { ...normal,
        stdout: mode === 'missing' ? f.event('network', 'connect') + '\n' : mode === 'duplicate' ? line + '\n' + line + '\n' :
          mode === 'overflow' ? (line + '\n').repeat(256) : mode === 'partial' ? line : mode === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : '{}\n' };
    });
    await assert.rejects(current.flush(), /INVENTORY_UNAVAILABLE/, mode);
    const expected = { missing: 'ANCHOR_UNAVAILABLE', duplicate: 'ANCHOR_AMBIGUOUS', overflow: 'REPLAY_OVERFLOW', partial: 'MALFORMED_EVENT', malformed: 'MALFORMED_EVENT', command: 'COMMAND_FAILED', oversized: 'OUTPUT_LIMIT' }[mode]!;
    assert.throws(current.check, reason(expected)); assert.equal(f.stats().failures, 1); assert.equal(f.timers.size, 0);
    current.close(); assert.throws(current.check, reason(expected));
  }
});

test('same-second replay cannot round nanoseconds into a matching anchor and global churn cannot hide a producer', async () => {
  for (const mode of ['same-second-lost-anchor', 'start-stop', 'noncontainer-eviction']) {
    const f = fixture(), watcher = await f.start();
    if (mode === 'same-second-lost-anchor') {
      const original = f.history[0];
      original.line = original.line.replace(/"timeNano":(\d+)/, (_match, nano: string) => `"timeNano":${BigInt(nano) + 1n}`);
    } else if (mode === 'start-stop') {
      f.add('network', 'connect'); f.add('container', 'start'); f.add('container', 'die');
    } else {
      for (let n = 0; n < 257; n++) f.add('network', 'connect');
      f.history.splice(0, 250); // A subset shorter than the retention cap still lacks the pinned anchor.
    }
    await assert.rejects(watcher.flush(), reason(mode === 'start-stop' ? 'PRODUCER_ACTIVITY' : 'ANCHOR_UNAVAILABLE'));
    watcher.close();
  }
});

test('delayed stream startup is fenced by replay and reserved launch events require the inspected exact identity', async () => {
  const startup = fixture();
  startup.override((normal, call) => call === 2 ? { ...normal, stdout: normal.stdout + startup.event('container', 'start') + '\n' } : normal);
  await assert.rejects(startup.start(), reason('PRODUCER_ACTIVITY'));
  assert.equal(startup.stats().failures, 1); assert.equal(startup.timers.size, 0);
  for (const mode of ['valid', 'forged', 'delayed-stream-intruder']) {
    const f = fixture(), watcher = await f.start();
    if (mode === 'delayed-stream-intruder') {
      f.add('container', 'start'); await assert.rejects(watcher.flush(), reason('PRODUCER_ACTIVITY'));
    } else {
      const line = f.add('container', 'start', base, exception.name);
      f.stream.stdout.write(line + '\n'); await watcher.flush();
      watcher.allow(mode === 'valid' ? exception : { ...exception, containerId: 'b'.repeat(64) });
      if (mode === 'valid') watcher.check(); else assert.throws(watcher.check, reason('EXCEPTION_MISMATCH'));
    }
    watcher.close();
  }
});

test('invalid replay timestamps, backward ordering and ambiguous next anchors latch before advancement', async () => {
  for (const mode of ['timestamp', 'ordering', 'next-anchor']) {
    const f = fixture(), watcher = await f.start();
    f.override(normal => {
      const line = f.event('network', 'connect');
      return { ...normal, stdout: normal.stdout + (mode === 'timestamp' ? line.replace(/"time":\d+/, '"time":9007199254740991') + '\n' :
        mode === 'ordering' ? line + '\n' + f.event('network', 'connect', base - 2000) + '\n' : line + '\n' + line + '\n') };
    });
    await f.advance(1000);
    assert.throws(watcher.check, reason(mode === 'next-anchor' ? 'ANCHOR_AMBIGUOUS' : 'MALFORMED_EVENT'));
    assert.equal(f.stats().failures, 1); assert.equal(f.timers.size, 0); assert.ok(f.stats().killed > 0);
    watcher.close();
  }
});

test('stream loss is fatal during bootstrap and after initialization, preserving the first safe cause', async () => {
  for (const signal of ['close', 'error', 'stderr', 'malformed']) {
    const f = fixture(), watcher = await f.start();
    if (signal === 'stderr') f.stream.stderr.write('private-label-token-argv');
    else if (signal === 'malformed') f.stream.stdout.write('private-label-token-argv\n');
    else f.stream.emit(signal, new Error('private-label-token-argv'));
    const expected = { close: 'STREAM_CLOSED', error: 'STREAM_ERROR', stderr: 'STREAM_STDERR', malformed: 'MALFORMED_EVENT' }[signal]!;
    assert.throws(watcher.check, error => {
      assert.equal(JSON.stringify(error).includes('private-label-token-argv'), false);
      assert.ok(reason(expected)(error)); return true;
    });
    f.stream.emit('close'); watcher.close(); await assert.rejects(watcher.flush(), reason(expected));
    assert.equal(f.stats().failures, 1); assert.equal(f.timers.size, 0);
  }
  const f = fixture();
  f.override(normal => { f.stream.emit('close'); return normal; });
  await assert.rejects(f.start(), reason('STREAM_CLOSED'));
});

test('timer and concurrent explicit flush are serialized, with a fresh checkpoint after the pending one', async () => {
  const f = fixture(), watcher = await f.start();
  let release: (() => void) | undefined;
  f.override(async (normal, call) => { if (call === 3) await new Promise<void>(resolve => { release = resolve; }); return normal; });
  await f.advance(1000); assert.equal(f.stats().calls, 3);
  const first = watcher.flush(), second = watcher.flush(); assert.equal(first, second);
  release!(); await first;
  assert.equal(f.stats().calls, 4); assert.equal(f.stats().maxConcurrent, 1);
  watcher.close(); assert.equal(f.timers.size, 0);
});

test('late checkpoint results after close cannot advance observation or schedule more work', async () => {
  const f = fixture(), watcher = await f.start();
  let release: (() => void) | undefined;
  f.override(async normal => { await new Promise<void>(resolve => { release = resolve; }); return normal; });
  const pending = watcher.flush(); watcher.close(); release!();
  await assert.rejects(pending, reason('WATCHER_CLOSED')); await f.advance(5000);
  assert.equal(f.timers.size, 0); assert.equal(f.stats().calls, 3);
  await assert.rejects(watcher.flush(), reason('WATCHER_CLOSED')); assert.equal(f.stats().calls, 3);
});

test('command exceptions retain sanitized original cause while public diagnostic prints only fixed phase and reason', async () => {
  const f = fixture(), watcher = await f.start();
  f.override(() => { throw Object.assign(new Error('fixture command failed'), { code: 'ENOENT' }); });
  await assert.rejects(watcher.flush(), error => {
    assert.ok(error instanceof AccountingRecoveryHostError);
    const cause = error.cause as { original: { name: string; code: string; message: string } };
    assert.deepEqual(cause.original, { name: 'Error', code: 'ENOENT', message: 'fixture command failed' });
    assert.equal(accountingWatcherDiagnostic(error), 'AccountingDockerEventWatcher:replay/COMMAND_FAILED'); return true;
  });
  watcher.close();
  assert.equal(accountingWatcherDiagnostic(new Error('private-argv')), null);
  assert.equal(accountingWatcherDiagnostic(new AccountingRecoveryHostError('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE', { name: 'untrusted', code: 'private-token', message: 'private' })), null);
});
