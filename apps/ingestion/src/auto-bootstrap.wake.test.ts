import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AutoBootstrapController, type AutoBootstrapDependencies } from './auto-bootstrap.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const state = { now: 1_000_000, ready: false, stopped: false, bootstraps: 0, probes: 0, revocations: 0,
    drain: { state: 'IDLE', since: null as string | null } };
  const deps: AutoBootstrapDependencies<void> = {
    enabled: true, now: () => state.now,
    ready: () => state.ready, readStopped: async () => state.stopped,
    writeStopped: async stopped => { state.stopped = stopped; },
    bootstrap: async current => { state.bootstraps++; if (current()) state.ready = true; },
    probe: async () => { state.probes++; },
    invalidateReads: () => { state.revocations++; state.ready = false; },
    stop: async () => { state.ready = false; }, drainStatus: () => state.drain,
  };
  const controller = new AutoBootstrapController(deps);
  const advance = async (milliseconds: number) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 5000) {
      state.now += Math.min(5000, milliseconds - elapsed); await controller.tick();
    }
  };
  return { state, deps, controller, advance };
}

test('a buffered event detects a wake before the overdue timer and coalesces invalidation', async () => {
  const f = fixture(); await f.controller.initialize(); await f.controller.tick();
  f.state.now += 30_000;
  assert.equal(f.controller.continuous(), false);
  assert.equal(f.controller.continuous(), false);
  assert.equal(f.state.revocations, 1);
  assert.equal(f.state.ready, false);
  assert.equal(f.controller.diagnostics().recoveryReason, 'SCHEDULING_INTERRUPTION');
  await f.controller.tick();
  assert.equal(f.state.bootstraps, 2);
  assert.equal(f.controller.continuous(), true);
});

test('wake during a deferred bootstrap revokes old work without starting a concurrent successor', async () => {
  const f = fixture(), entered = deferred(), finish = deferred();
  let publicationAllowed = true;
  f.deps.bootstrap = async current => {
    f.state.bootstraps++; entered.resolve(); await finish.promise;
    publicationAllowed = current(); if (current()) f.state.ready = true;
  };
  await f.controller.initialize();
  const running = assert.rejects(f.controller.tick(), /INGESTION_BOOTSTRAP_INTERRUPTED/);
  await entered.promise; f.state.now += 45_000; await f.controller.tick(); await f.controller.tick();
  assert.equal(f.state.bootstraps, 1); assert.equal(f.state.revocations, 1);
  finish.resolve(); await running;
  assert.equal(publicationAllowed, false); assert.equal(f.state.ready, false);
  assert.equal(f.controller.diagnostics().recoveryNeeded, true);
  f.deps.bootstrap = async current => { f.state.bootstraps++; if (current()) f.state.ready = true; };
  await f.advance(25_000); assert.equal(f.state.bootstraps, 1);
  await f.advance(5000); assert.equal(f.state.bootstraps, 2);
});

test('bootstrap continuation after sleep is rejected before the overdue watchdog tick', async () => {
  const f = fixture(), entered = deferred(), finish = deferred(); let publicationAllowed = true;
  f.deps.bootstrap = async current => {
    f.state.bootstraps++; entered.resolve(); await finish.promise;
    publicationAllowed = current(); if (current()) f.state.ready = true;
  };
  await f.controller.initialize();
  const running = assert.rejects(f.controller.tick(), /INGESTION_BOOTSTRAP_INTERRUPTED/);
  await entered.promise; f.state.now += 45_000; finish.resolve(); await running;
  assert.equal(publicationAllowed, false); assert.equal(f.state.ready, false);
  assert.equal(f.state.revocations, 1); assert.equal(f.controller.diagnostics().recoveryNeeded, true);
  assert.equal(f.controller.diagnostics().lastSchedulingInterruption, new Date(f.state.now).toISOString());
});

test('manual stop during an outstanding probe cannot record success or resume on later wake', async () => {
  const f = fixture(), probe = deferred();
  await f.controller.initialize(); await f.controller.tick(); await f.advance(25_000);
  f.deps.probe = async () => { f.state.probes++; await probe.promise; };
  f.state.now += 5000; const probing = f.controller.tick(); await Promise.resolve();
  assert.equal(f.state.probes, 1);
  const stopping = f.controller.stopManually();
  probe.resolve(); await Promise.all([probing, stopping]);
  f.state.now += 120_000; await f.controller.tick();
  assert.equal(f.state.stopped, true); assert.equal(f.state.ready, false);
  assert.equal(f.state.bootstraps, 1); assert.equal(f.state.probes, 1);
  assert.equal(f.controller.diagnostics().lastProbeSuccess, null);
  const restarted = new AutoBootstrapController(f.deps); await restarted.initialize(); await restarted.tick();
  assert.equal(f.state.bootstraps, 1);
});

test('failed liveness retains bounded recovery backoff when TWS remains unavailable', async () => {
  const f = fixture(); await f.controller.initialize(); await f.controller.tick(); await f.advance(25_000);
  f.deps.probe = async () => { f.state.probes++; throw new Error('probe_timeout'); };
  f.state.now += 5000; await assert.rejects(f.controller.tick(), /probe_timeout/);
  f.deps.bootstrap = async () => { f.state.bootstraps++; throw new Error('broker_unavailable'); };
  await f.advance(25_000); assert.equal(f.state.bootstraps, 1);
  f.state.now += 5000; await assert.rejects(f.controller.tick(), /broker_unavailable/);
  assert.equal(Date.parse(f.controller.diagnostics().nextAttemptAt!) - f.state.now, 60_000);
  await f.advance(55_000); assert.equal(f.state.bootstraps, 2);
  f.state.now += 5000; await assert.rejects(f.controller.tick(), /broker_unavailable/);
  assert.equal(Date.parse(f.controller.diagnostics().nextAttemptAt!) - f.state.now, 120_000);
  assert.equal(f.state.probes, 1);
});

test('probe completion after a scheduling gap cannot publish fresh liveness', async () => {
  const f = fixture(), probe = deferred();
  await f.controller.initialize(); await f.controller.tick(); await f.advance(25_000);
  f.deps.probe = () => probe.promise;
  f.state.now += 5000; const running = f.controller.tick(); await Promise.resolve();
  f.state.now += 45_000; probe.resolve(); await Promise.allSettled([running]);
  assert.equal(f.controller.diagnostics().lastProbeSuccess, null);
  assert.equal(f.controller.diagnostics().recoveryNeeded, true);
  assert.equal(f.state.ready, false);
});

test('health exposes unresolved storage drain without reporting recovery success', async () => {
  const f = fixture(), write = deferred(), entered = deferred();
  f.deps.bootstrap = async current => {
    f.state.bootstraps++; f.state.drain = { state: 'DRAIN_WAITING_STORAGE', since: new Date(f.state.now).toISOString() };
    entered.resolve(); await write.promise;
    f.state.drain = { state: 'IDLE', since: null }; if (current()) f.state.ready = true;
  };
  await f.controller.initialize(); const running = f.controller.tick(); await entered.promise;
  await f.advance(15_000);
  assert.equal(f.controller.diagnostics().inFlight, true);
  assert.equal(f.controller.diagnostics().drain?.state, 'DRAIN_WAITING_STORAGE');
  assert.equal(f.controller.diagnostics().recoveryNeeded, true);
  assert.equal(f.state.ready, false); assert.equal(f.state.bootstraps, 1);
  write.resolve(); await running; assert.equal(f.state.ready, true);
});

test('backward and invalid clocks revoke evidence without immediate retry floods', async () => {
  for (const invalidNow of [999_000, NaN]) {
    const f = fixture(); await f.controller.initialize(); await f.controller.tick();
    f.state.now = invalidNow; assert.equal(f.controller.continuous(), false);
    assert.equal(f.state.revocations, 1); assert.equal(f.state.ready, false);
    assert.equal(f.controller.continuous(), false); assert.equal(f.state.revocations, 1);
    if (!Number.isFinite(invalidNow)) { await f.controller.tick(); assert.equal(f.state.bootstraps, 1); }
  }
});
