import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReadRecoverySession } from './read-recovery-session.js';
import { AutoBootstrapController } from './auto-bootstrap.js';

function fixture() {
  const events: string[] = [];
  let now = 1000;
  const deps: ConstructorParameters<typeof ReadRecoverySession>[0] = {
    pause: () => { events.push('pause'); }, invalidatePublications: () => { events.push('publications'); },
    invalidateNativeRefresh: () => { events.push('native'); }, invalidateScheduleRequests: () => { events.push('schedule-requests'); },
    disconnect: () => { events.push('disconnect'); }, clearLocalState: () => { events.push('clear'); },
    invalidateSchedules: async () => { events.push('schedules'); },
    drainPublications: async () => { events.push('drain-publications'); }, drainNativeRefresh: async () => {}, drainSchedules: async () => {},
    connect: async () => { events.push('connect'); }, probe: async () => { events.push('probe'); },
    onInvalidationError: () => { events.push('invalidation-failed'); }, now: () => now,
  };
  return { deps, events, setNow: (value: number) => { now = value; }, now: () => now };
}

test('shared production bootstrap pauses before draining and cannot publish while old storage is pending', async () => {
  const f = fixture(); let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  f.deps.drainPublications = () => wait;
  const recovery = new ReadRecoverySession(f.deps);
  recovery.invalidate(); assert.deepEqual(f.events, ['pause', 'publications', 'native', 'schedule-requests', 'disconnect', 'clear', 'schedules']);
  f.events.length = 0;
  const pending = recovery.bootstrap(() => true, async () => { f.events.push('native-prepare'); return 1; }, () => { f.events.push('subscribe'); });
  await Promise.resolve(); assert.deepEqual(f.events, ['pause']);
  f.setNow(5000); assert.deepEqual(recovery.diagnostics(), { state: 'DRAIN_WAITING_STORAGE', since: new Date(1000).toISOString(), elapsedMs: 4000 });
  release(); await pending;
  assert.deepEqual(f.events, ['pause', 'connect', 'probe', 'native-prepare', 'subscribe']);
  assert.equal(recovery.diagnostics().state, 'IDLE');
});

test('failed durable invalidation stays unavailable then recovers through ordinary backoff without manual resume', async () => {
  const f = fixture(); let fail = true, connected = false;
  f.deps.invalidateSchedules = async () => { if (fail) { fail = false; throw new Error('DB_UNAVAILABLE'); } };
  f.deps.connect = async () => { connected = true; };
  f.deps.disconnect = () => { connected = false; };
  const recovery = new ReadRecoverySession(f.deps);
  const controller = new AutoBootstrapController({ enabled: true, now: f.now, readStopped: async () => false, writeStopped: async () => {},
    ready: () => connected, invalidateReads: () => recovery.invalidate(), stop: () => recovery.drain(),
    drainStatus: () => recovery.diagnostics(), bootstrap: current => recovery.bootstrap(current, async () => {}, () => {}) });
  await controller.initialize(); await controller.tick();
  controller.invalidate(); await assert.rejects(controller.tick(), /DB_UNAVAILABLE/);
  assert.equal(controller.diagnostics().recoveryNeeded, true); assert.equal(connected, false);
  for (let n = 0; n < 6; n++) { f.setNow(f.now() + 5000); await controller.tick(); }
  assert.equal(connected, true); assert.equal(controller.diagnostics().recoveryNeeded, false);
  await controller.shutdown();
});

for (const now of [NaN, Infinity, 1e20]) test(`drain health remains readable with invalid clock ${now}`, () => {
  const f = fixture(); f.setNow(now); const recovery = new ReadRecoverySession(f.deps); recovery.invalidate();
  assert.deepEqual(recovery.diagnostics(), { state: 'DRAIN_WAITING_STORAGE', since: null, elapsedMs: null });
});
