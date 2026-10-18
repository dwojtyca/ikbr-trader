import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AccountingClockRecoveryCoordinator } from './clock-recovery-coordinator.js';
import type { AccountingSourceService } from './source-service.js';
import type { AutomaticClockRecoveryStatus, ClockRecoveryReceipt } from './types.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const time = { wall: 1_800_000_000_000, mono: 1000, database: 1_800_000_000_000 };
  t.mock.method(Date, 'now', () => time.wall);
  const status: AutomaticClockRecoveryStatus = { enabled: true, episodeId: 'episode', state: 'WAITING', attemptCount: 0,
    attemptLimit: 3, nextAttemptAt: null, firstErrorAt: null, lastError: null, receiptId: null, captureId: null, entryBlocked: true };
  const identity = { connected: true, accountId: 'TEST', sessionId: 'execution-session', generation: 1, settingsHash: 'settings' };
  const calls = { refresh: 0, automatic: 0, charged: 0, captures: 0, notifications: 0, reasons: [] as string[] };
  let busy = false, verificationStart = time.database;
  const behavior = {
    recover: async (_signal: AbortSignal): Promise<ClockRecoveryReceipt | null> => null,
    capture: async (): Promise<unknown> => undefined,
    notify: async (_snapshot: AutomaticClockRecoveryStatus): Promise<void> => undefined,
  };
  const stub = {
    settings: { accountId: 'TEST' },
    status: () => ({ automaticClockRecovery: { ...status } }),
    refreshRecoveryState: async () => { calls.refresh++; },
    recoveryDatabaseTime: async () => time.database,
    recoveryIdentity: () => ({ ...identity }),
    verificationExpired: async (now: number) => now - verificationStart >= 60_000,
    requireRecoveryOperator: async (reason: string) => { calls.reasons.push(reason); status.state = 'OPERATOR_REQUIRED'; },
    automaticRecovery: async (signal: AbortSignal) => {
      calls.automatic++; if (busy) throw Error('ACCOUNTING_SOURCE_BUSY'); calls.charged++;
      return behavior.recover(signal);
    },
  };
  const source = new Proxy(stub, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `unexpected source API access: ${String(key)}`);
    return Reflect.get(target, key);
  } }) as unknown as AccountingSourceService;
  const coordinator = new AccountingClockRecoveryCoordinator({ source, monotonicNow: () => time.mono,
    requestFreshCapture: () => { calls.captures++; return behavior.capture(); },
    onState: snapshot => { calls.notifications++; return behavior.notify(snapshot); } });
  t.after(() => coordinator.stop());
  return { time, status, identity, calls, behavior, coordinator,
    busy: (value: boolean) => { busy = value; },
    verificationStart: (value: number) => { verificationStart = value; },
    advance: (ms: number) => { time.wall += ms; time.database += ms; time.mono += ms; } };
}

test('recovery requires ten stable monotonic seconds and resets on execution identity change', async t => {
  const f = fixture(t); await f.coordinator.tick(); f.advance(9999); await f.coordinator.tick(); assert.equal(f.calls.automatic, 0);
  f.identity.generation++; f.advance(1); await f.coordinator.tick(); f.advance(9999); await f.coordinator.tick(); assert.equal(f.calls.automatic, 0);
  f.advance(1); await f.coordinator.tick(); assert.equal(f.calls.automatic, 1);
});
test('disconnection or foreign account never becomes stable and operator pause APIs are never accessed', async t => {
  const f = fixture(t); f.identity.connected = false; await f.coordinator.tick(); f.advance(20_000); await f.coordinator.tick();
  f.identity.connected = true; f.identity.accountId = 'FOREIGN'; f.advance(20_000); await f.coordinator.tick();
  assert.equal(f.calls.automatic, 0); f.identity.accountId = 'TEST'; await f.coordinator.tick(); f.advance(10_000); await f.coordinator.tick();
  assert.equal(f.calls.charged, 1);
});
test('source busy consumes no attempt and requests no fresh capture', async t => {
  const f = fixture(t); await f.coordinator.tick(); f.advance(10_000); f.busy(true); await f.coordinator.tick();
  assert.equal(f.calls.automatic, 1); assert.equal(f.calls.charged, 0); assert.equal(f.calls.captures, 0); assert.deepEqual(f.calls.reasons, []);
  f.busy(false); f.advance(5000); await f.coordinator.tick(); assert.equal(f.calls.charged, 1);
});
test('concurrent ticks share one recovery and capture starts only after recovery releases', async t => {
  const f = fixture(t); let complete!: (value: ClockRecoveryReceipt | null) => void;
  f.behavior.recover = () => new Promise(resolve => { complete = resolve; });
  await f.coordinator.tick(); f.advance(10_000); const first = f.coordinator.tick(); await flush();
  assert.equal(f.coordinator.tick(), first); assert.equal(f.calls.automatic, 1); assert.equal(f.calls.captures, 0);
  complete({ id: 'receipt' } as unknown as ClockRecoveryReceipt); await first; assert.equal(f.calls.captures, 1);
});
test('disabled and terminal episodes do no broker work but retry failed notification delivery', async t => {
  const f = fixture(t);
  for (const state of ['WAITING', 'OPERATOR_REQUIRED', 'OUTCOME_UNKNOWN'] as const) {
    f.status.state = state; f.status.enabled = state !== 'WAITING'; let fail = true;
    f.behavior.notify = async () => { if (fail) throw Error('delivery unavailable'); };
    const before = f.calls.notifications; await assert.rejects(f.coordinator.tick(), /delivery unavailable/);
    fail = false; await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.calls.notifications, before + 2);
  }
  assert.equal(f.calls.automatic, 0); assert.equal(f.calls.captures, 0);
});
test('VERIFYING uses fresh capture and becomes operator required at the sixty second deadline', async t => {
  const f = fixture(t); f.status.state = 'VERIFYING'; f.verificationStart(f.time.database);
  await f.coordinator.tick(); f.advance(59_999); await f.coordinator.tick(); assert.equal(f.calls.captures, 1);
  f.advance(1); await f.coordinator.tick(); assert.deepEqual(f.calls.reasons, ['ACCOUNTING_CLOCK_RECOVERY_VERIFY_TIMEOUT']);
  assert.equal(f.calls.captures, 1); assert.equal(f.calls.automatic, 0);
});
test('stuck fresh capture is bounded, never overlaps another capture, and stop drains after the bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.status.state = 'VERIFYING'; f.behavior.capture = () => new Promise(() => {});
  await f.coordinator.tick(); f.advance(5000); const first = f.coordinator.tick(); await flush(); assert.equal(f.calls.captures, 1);
  let completed = false; void first.then(() => { completed = true; }); t.mock.timers.tick(1999); await flush(); assert.equal(completed, false);
  t.mock.timers.tick(1); await first; f.advance(5000); await f.coordinator.tick(); assert.equal(f.calls.captures, 1);
  await f.coordinator.stop(); await f.coordinator.tick(); assert.equal(f.calls.captures, 1);
});
test('stop aborts running recovery without initiating a capture or another acquisition', async t => {
  const f = fixture(t); let aborted = false;
  f.behavior.recover = signal => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true }); });
  await f.coordinator.tick(); f.advance(10_000); const running = f.coordinator.tick(); await flush(); await f.coordinator.stop(); await running;
  assert.equal(aborted, true); await f.coordinator.tick(); assert.equal(f.calls.automatic, 1); assert.equal(f.calls.captures, 0);
});
test('forward or backward process and database wall jumps fail closed before an acquisition', async t => {
  for (const clock of ['wall', 'database'] as const) for (const jump of [-5000, 5000]) {
    const f = fixture(t); await f.coordinator.tick(); f.advance(10_000); f.time[clock] += jump; await f.coordinator.tick();
    assert.deepEqual(f.calls.reasons, ['ACCOUNTING_CLOCK_RECOVERY_TIME_DISCONTINUITY']); assert.equal(f.calls.automatic, 0); assert.equal(f.calls.captures, 0);
    await f.coordinator.stop();
  }
});

test('VERIFYING deadline is enforced even when execution identity is disconnected or foreign', async t => {
  for (const disconnected of [true, false]) {
    const f = fixture(t); f.status.state = 'VERIFYING'; f.verificationStart(f.time.database - 60_000);
    f.identity.connected = !disconnected; if (!disconnected) f.identity.accountId = 'FOREIGN';
    await f.coordinator.tick();
    assert.deepEqual(f.calls.reasons, ['ACCOUNTING_CLOCK_RECOVERY_VERIFY_TIMEOUT']);
    assert.equal(f.calls.captures, 0); assert.equal(f.calls.automatic, 0); await f.coordinator.stop();
  }
});

test('stop waits only for bounded in-flight capture and leaves its unresolved promise fenced', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.status.state = 'VERIFYING'; f.behavior.capture = () => new Promise(() => {});
  await f.coordinator.tick(); f.advance(5000); const running = f.coordinator.tick(); await flush();
  let stopped = false; const stop = f.coordinator.stop().then(() => { stopped = true; });
  t.mock.timers.tick(1999); await flush(); assert.equal(stopped, false);
  t.mock.timers.tick(1); await Promise.all([stop, running]); assert.equal(stopped, true);
  await f.coordinator.tick(); assert.equal(f.calls.captures, 1); assert.equal(f.calls.automatic, 0);
});

test('timed out notification stays single-flight and later delivers newest episode', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.status.state = 'OPERATOR_REQUIRED';
  let release!: () => void;
  const delivered: Array<string | null> = [];
  f.behavior.notify = snapshot => new Promise<void>(resolve => { release = () => { delivered.push(snapshot.episodeId); resolve(); }; });
  const first = f.coordinator.tick(); await flush(); t.mock.timers.tick(2000); await first;
  f.status.episodeId = 'new-episode';
  await f.coordinator.tick(); await f.coordinator.tick(); assert.equal(f.calls.notifications,1);
  release(); await flush();
  f.behavior.notify = async snapshot => { delivered.push(snapshot.episodeId); };
  await f.coordinator.tick(); await f.coordinator.tick();
  assert.equal(f.calls.notifications,2); assert.deepEqual(delivered,['episode','new-episode']);
});
