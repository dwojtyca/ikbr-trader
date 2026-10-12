import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoBootstrapController } from './auto-bootstrap.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(enabled = true) {
  const state = { stopped: false, ready: false, calls: 0, stops: 0, now: 0, failWrite: false, failRead: false };
  const deps = {
    enabled, now: () => state.now,
    readStopped: async () => { if (state.failRead) throw new Error('read'); return state.stopped; },
    writeStopped: async (stopped: boolean) => { if (state.failWrite) throw new Error('write'); state.stopped = stopped; },
    bootstrap: async (current: () => boolean) => { state.calls++; if (current()) state.ready = true; return state.calls; },
    ready: () => state.ready,
    stop: async () => { state.stops++; state.ready = false; },
  };
  return { state, deps, make: () => new AutoBootstrapController(deps) };
}

test('automatic startup is opt-in; successful bootstrap is not repeated until invalidated', async () => {
  const f = fixture(false), disabled = f.make(); await disabled.initialize(); await disabled.tick();
  assert.equal(f.state.calls, 0); await disabled.startManually(); assert.equal(f.state.calls, 1);
  const g = fixture(), c = g.make(); await c.initialize(); await c.tick(); await c.tick();
  assert.equal(g.state.calls, 1); c.invalidate(); await c.tick(); assert.equal(g.state.calls, 2);
});

test('manual stop persists across a new process; only explicit start clears it', async () => {
  const f = fixture(), c = f.make(); await c.initialize(); await c.tick(); await c.stopManually();
  const restarted = f.make(); await restarted.initialize(); restarted.invalidate(); await restarted.tick();
  assert.equal(f.state.calls, 1); assert.equal(f.state.stopped, true);
  await restarted.startManually(); assert.equal(f.state.stopped, false); assert.equal(f.state.calls, 2);
});

test('stop during bootstrap prevents late subscription and joins one in-flight operation', async () => {
  const f = fixture(), started = deferred(), finish = deferred();
  f.deps.bootstrap = async current => { f.state.calls++; started.resolve(); await finish.promise;
    if (current()) f.state.ready = true; return 1; };
  const c = f.make(); await c.initialize();
  const running = assert.rejects(c.tick(), /INTERRUPTED/); await started.promise;
  const stopped = c.stopManually(); await c.tick(); c.invalidate(); finish.resolve();
  await Promise.all([running, stopped]); await c.tick();
  assert.equal(f.state.calls, 1); assert.equal(f.state.ready, false); assert.equal(f.state.stopped, true);
});

test('concurrent explicit start then stop is ordered, with stop as final durable state', async () => {
  const f = fixture(), c = f.make(), finish = deferred(), started = deferred();
  f.deps.bootstrap = async current => { f.state.calls++; started.resolve(); await finish.promise;
    if (current()) f.state.ready = true; return 1; };
  await c.initialize(); const starting = assert.rejects(c.startManually(), /INTERRUPTED/); await started.promise;
  const stopping = c.stopManually(); finish.resolve(); await Promise.all([starting, stopping]);
  assert.equal(f.state.stopped, true); assert.equal(f.state.ready, false); await c.tick(); assert.equal(f.state.calls, 1);
});

test('read/resume/stop persistence failures inhibit automatic work and remain observable', async () => {
  const f = fixture(), c = f.make(); f.state.failRead = true; await assert.rejects(c.initialize(), /read/);
  await c.tick(); assert.equal(f.state.calls, 0); f.state.failRead = false; await c.initialize();
  f.state.failWrite = true; await assert.rejects(c.startManually(), /write/); await c.tick();
  assert.equal(f.state.calls, 0); assert.equal(c.diagnostics().error, 'INGESTION_CONTROL_PERSISTENCE_FAILED');
  f.state.failWrite = false; await c.startManually(); f.state.failWrite = true;
  await assert.rejects(c.stopManually(), /write/); await c.tick();
  assert.equal(f.state.ready, false); assert.equal(f.state.calls, 1);
});

test('incomplete bootstrap backs off from 30 seconds to at most five minutes; no concurrent retries', async () => {
  const f = fixture(), c = f.make(); f.deps.bootstrap = async () => ++f.state.calls;
  await c.initialize();
  for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
    await assert.rejects(c.tick(), /INCOMPLETE/);
    assert.equal(Date.parse(c.diagnostics().nextAttemptAt!), f.state.now + delay);
    const calls = f.state.calls; await c.tick(); assert.equal(f.state.calls, calls);
    f.state.now += delay;
  }
});

test('failed explicit start persistence drains already running subscriptions', async () => {
  const f = fixture(), c = f.make(); await c.initialize(); await c.tick();
  assert.equal(f.state.ready, true); f.state.failWrite = true;
  await assert.rejects(c.startManually(), /write/);
  assert.equal(f.state.ready, false); assert.equal(f.state.stops, 1);
  assert.equal(c.diagnostics().error, 'INGESTION_CONTROL_PERSISTENCE_FAILED');
  await c.tick(); assert.equal(f.state.calls, 1);
});

test('shutdown inhibits in-flight completion without persisting stop, allowing next process recovery', async () => {
  const f = fixture(), c = f.make(), started = deferred(), finish = deferred();
  f.deps.bootstrap = async current => { f.state.calls++; started.resolve(); await finish.promise;
    if (current()) f.state.ready = true; return 1; };
  await c.initialize(); const running = assert.rejects(c.tick(), /INTERRUPTED/); await started.promise;
  const shutdown = c.shutdown(); finish.resolve(); await Promise.all([running, shutdown]);
  c.invalidate(); await c.tick(); await assert.rejects(c.startManually(), /UNAVAILABLE/);
  assert.equal(f.state.stopped, false); assert.equal(f.state.ready, false);
  const restarted = f.make(); await restarted.initialize(); await restarted.tick(); assert.equal(f.state.calls, 2);
});

test('connection invalidation during acquisition cannot certify that bootstrap generation', async () => {
  const f = fixture(), c = f.make(), started = deferred(), finish = deferred();
  f.deps.bootstrap = async current => { f.state.calls++; started.resolve(); await finish.promise;
    if (current()) f.state.ready = true; return 1; };
  await c.initialize(); const running = assert.rejects(c.tick(), /INTERRUPTED/); await started.promise;
  await c.tick(); c.invalidate(); finish.resolve(); await running;
  assert.equal(f.state.calls, 1); assert.equal(f.state.ready, false);
  f.state.now += 30_000; await c.tick(); assert.equal(f.state.calls, 2);
});
