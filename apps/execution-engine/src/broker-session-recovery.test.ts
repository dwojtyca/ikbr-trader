import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AccountingSourceRuntime } from './accounting/source-runtime.js';
import type { AccountingSourceService } from './accounting/source-service.js';
import type { SourceSettingsV1 } from './accounting/types.js';
import { TwsExecutionClient } from './tws-execution-client.js';
import { BrokerSessionRecovery, readCurrentBrokerAccounts } from './broker-session-recovery.js';

class Socket extends EventEmitter {
  connects = 0;
  holdAccounts = false;
  connect() { this.connects++; queueMicrotask(() => this.emit('nextValidId', 10)); }
  disconnect() { this.emit('disconnected'); }
  reqManagedAccts() { if (!this.holdAccounts) queueMicrotask(() => this.emit('managedAccounts', 'PAPER')); }
}
function fixture() {
  const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: 'PAPER',
    endpoint: { host: 'localhost', port: 4002 }, sourceClientId: 0, executionTimeZone: 'UTC' };
  const losses: Array<() => void> = [], sockets = [new Socket(), new Socket()];
  let account: string | null = null, confirmedGeneration: number | null = null, captures = 0;
  const runtime = new AccountingSourceRuntime(settings, 'a'.repeat(64), (_session, lost) => {
    losses.push(lost); let held = false;
    return { initialize: async () => { held = true; }, start() {}, close: async () => { held = false; },
      status: () => ({ hold: null }), assertRuntimeOwnerCurrent: () => { if (!held) throw Error('OWNER_LOST'); },
    } as unknown as AccountingSourceService;
  }, { onOwnerLost: () => tws.disconnect() });
  const tws = new TwsExecutionClient({ host: 'unused', port: 0, clientId: 7, securityType: 'STK', exchange: 'SMART', currency: 'USD', orderTimeoutMs: 100 },
    () => {}, undefined, undefined, undefined, { ib: sockets[0], ibFactory: () => sockets[1], captureRuntimeOwner: () => runtime.captureRuntimeOwner() });
  const abort = new AbortController(), failures: number[] = [];
  const recovery = new BrokerSessionRecovery({ signal: abort.signal,
    current: () => { if (!tws.isConnected() || !account || confirmedGeneration !== tws.getConnectionGeneration()) return false; try { runtime.assertRuntimeOwnerCurrent(); return true; } catch { return false; } },
    hydrate: async () => {
      const evidence = await readCurrentBrokerAccounts(tws, runtime.captureRuntimeOwner());
      assert.ok(evidence.accounts.includes('PAPER')); evidence.assertCurrent(); abort.signal.throwIfAborted(); account = 'PAPER'; confirmedGeneration = evidence.generation;
    }, cancel: () => tws.disconnect(), recovered: () => { captures++; }, failed: (_error, retry) => failures.push(retry),
  });
  return { runtime, recovery, tws, sockets, losses, abort, failures, account: () => account, captures: () => captures };
}

test('actual runtime/Tws wiring retries initial uninitialized source and cached-account disconnect', async () => {
  const f = fixture();
  try {
    await f.recovery.tick(); assert.deepEqual(f.failures, [1000]); assert.equal(f.sockets[0].connects, 0);
    await f.runtime.initialize(); await f.recovery.tick();
    assert.equal(f.account(), 'PAPER'); assert.equal(f.captures(), 1);
    f.losses[0](); assert.equal(f.account(), 'PAPER'); assert.equal(f.tws.isConnected(), false);
    await f.runtime.tick(); await f.recovery.tick();
    assert.equal(f.captures(), 2); assert.equal(f.sockets[1].connects, 1);
    await f.recovery.tick(); assert.equal(f.captures(), 2);
  } finally { f.abort.abort(); await f.recovery.stop(); await f.runtime.close(); }
});

test('start automatically schedules recovery after source initialization without an external tick', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    f.recovery.start(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.failures, [1000]); assert.equal(f.captures(), 0);
    await f.runtime.initialize(); t.mock.timers.tick(1000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.account(), 'PAPER'); assert.equal(f.captures(), 1);
    f.abort.abort(); await f.recovery.stop(); t.mock.timers.tick(30000);
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.captures(), 1);
  } finally { f.abort.abort(); await f.recovery.stop(); await f.runtime.close(); }
});

test('cached account requires confirmation in the reconnected generation after managed-account timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  try {
    await f.runtime.initialize(); await f.recovery.tick(); assert.equal(f.captures(), 1);
    f.losses[0](); await f.runtime.tick(); f.sockets[1].holdAccounts = true;
    const failed = f.recovery.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.tws.isConnected(), true); t.mock.timers.tick(8000); await failed;
    assert.equal(f.account(), 'PAPER'); assert.equal(f.captures(), 1);
    f.sockets[1].holdAccounts = false; await f.recovery.tick(); assert.equal(f.captures(), 2);
  } finally { f.abort.abort(); await f.recovery.stop(); await f.runtime.close(); }
});

test('late predecessor managed accounts cannot hydrate after owner replacement or shutdown', async () => {
  for (const stopping of [false, true]) {
    const f = fixture(); f.sockets[0].holdAccounts = true;
    try {
      await f.runtime.initialize();
      const hydrating = f.recovery.tick(); assert.equal(f.recovery.tick(), hydrating);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (stopping) { f.abort.abort(); await f.recovery.stop(); }
      else { f.losses[0](); await f.runtime.tick(); }
      f.sockets[0].emit('managedAccounts', 'PAPER'); await hydrating;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(f.account(), null); assert.equal(f.captures(), 0);
      if (!stopping) { await f.recovery.tick(); assert.equal(f.account(), 'PAPER'); assert.equal(f.captures(), 1); }
    } finally { f.abort.abort(); await f.recovery.stop(); await f.runtime.close(); }
  }
});

test('hydration retry has bounded backoff and stop cancels an unresolved attempt', async () => {
  const delays: number[] = []; let calls = 0, cancelled = 0, recovered = 0;
  const loop = new BrokerSessionRecovery({ signal: new AbortController().signal, current: () => false,
    hydrate: async () => { if (++calls < 7) throw Error('unavailable'); await new Promise<void>(() => {}); },
    cancel: () => { cancelled++; }, recovered: () => { recovered++; }, failed: (_error, delay) => delays.push(delay) });
  for (let i = 0; i < 6; i++) await loop.tick();
  assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000, 30000]);
  const pending = loop.tick(); await loop.stop(); await pending; await loop.tick();
  assert.equal(calls, 7); assert.equal(cancelled, 1); assert.equal(recovered, 0);
});

test('attempt timeout cancels transport and ignores a late successful completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish!: () => void, cancelled = 0, recovered = 0, current = false;
  const errors: unknown[] = [];
  const loop = new BrokerSessionRecovery({ signal: new AbortController().signal, current: () => current,
    hydrate: () => new Promise<void>(resolve => { finish = resolve; }), cancel: () => { cancelled++; },
    recovered: () => { recovered++; }, failed: error => errors.push(error) });
  const pending = loop.tick(); t.mock.timers.tick(22000); await pending;
  assert.equal(cancelled, 1); assert.match((errors[0] as Error).message, /TIMEOUT/);
  current = true; finish(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(recovered, 0); await loop.stop();
});
