import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ReconciliationScheduler, type SchedulerConfig } from './scheduler.js';
import type { ReconciliationRunner, RunReport, RunnerContext } from './runner.js';
import type { BrokerPhaseEvent } from './phase-diagnostics.js';

const config: SchedulerConfig = { enabled: true, intervalMs: 1000, startupDelayMs: 0, minIntervalMs: 0,
  sourceTimeoutMs: 100, runTimeoutMs: 100, executionSafetyMarginMs: 0 };
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext, beforeProof: () => Promise<void> = async () => {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const state = { mono: 0, wall: 100_000, captures: 0, proof: true, runDuration: 0,
    outcome: 'clean' as 'clean' | 'partial' | 'failed' | 'null' | 'holds', acquiredOffset: 0,
    identity: { connected: true, accountId: 'PAPER', sessionId: 'session', generation: 1 } };
  const receipts = new Map<number, { generation: number; acquiredAt: number }>();
  const events: BrokerPhaseEvent[] = [];
  const context = (): RunnerContext => ({ accountId: state.identity.accountId, sessionId: state.identity.sessionId, sessionStartedAt: new Date(0) });
  const scheduler = new ReconciliationScheduler({ runOnce: async () => {
    const runId = ++state.captures;
    receipts.set(runId, { generation: state.identity.generation, acquiredAt: state.wall + state.acquiredOffset });
    state.mono += state.runDuration; state.wall += state.runDuration;
    return state.outcome === 'null' ? null : { runId, status: state.outcome === 'failed' ? 'FAILED' : 'CLEAN', exposureComplete: state.outcome !== 'partial',
      recoveryComplete: true, matches: 0, mismatches: 0, holdsCreated: state.outcome === 'holds' ? 1 : 0, holdsResolved: 0, error: null } as RunReport;
  } } as unknown as ReconciliationRunner, { currentContext: context }, config, logger, {
    currentIdentity: () => state.identity, periodicProof: async (_context, runId) => { await beforeProof(); return state.proof ? receipts.get(runId) ?? null : null; },
    monotonicNow: () => state.mono, wallNow: () => state.wall, diagnostics: { emit: event => events.push(event) },
  });
  t.after(() => scheduler.stop());
  const tick = async (elapsed = 1000) => { state.mono += elapsed; state.wall += elapsed; t.mock.timers.tick(1000); await settle(); };
  return { state, scheduler, events, tick, start: async () => { scheduler.start(); t.mock.timers.tick(0); await settle(); } };
}
test('only periodic requests skip the recent complete capture; original attempt expiry is not renewed', async t => {
  const f = fixture(t); await f.start(); assert.equal(f.state.captures, 1);
  await f.tick(); assert.equal(f.state.captures, 1);
  assert.equal(f.events.filter(e => e.outcome === 'skipped').length, 1);
  await f.scheduler.triggerNow(); await f.scheduler.triggerFresh(); assert.equal(f.state.captures, 3);
  await f.tick(5000); assert.equal(f.state.captures, 3);
  await f.tick(1); assert.equal(f.state.captures, 4);
});
test('slow captures cannot gain a new skip lease from recent completion', async t => {
  const f = fixture(t); f.state.runDuration = 8000; await f.start(); await f.tick(); assert.equal(f.state.captures, 2);
});
for (const outcome of ['partial', 'failed', 'null', 'holds'] as const) test(`${outcome} run cannot qualify or preserve a prior receipt`, async t => {
  const f = fixture(t); await f.start(); f.state.outcome = outcome;
  await f.scheduler.triggerNow(); await f.tick(); assert.equal(f.state.captures, 3);
});
for (const change of ['gap', 'disconnected', 'generation', 'account', 'session', 'wall_rollback', 'monotonic_rollback', 'future', 'old_acquisition'] as const) {
  test(`${change} invalidates periodic skip`, async t => {
    const f = fixture(t);
    if (change === 'future') f.state.acquiredOffset = 1;
    if (change === 'old_acquisition') f.state.acquiredOffset = -1;
    await f.start();
    if (change === 'gap') f.state.proof = false;
    if (change === 'disconnected') f.state.identity.connected = false;
    if (change === 'generation') f.state.identity.generation++;
    if (change === 'account') f.state.identity.accountId = 'OTHER';
    if (change === 'session') f.state.identity.sessionId = 'OTHER';
    if (change === 'wall_rollback') f.state.wall -= 2000;
    if (change === 'monotonic_rollback') f.state.mono -= 2000;
    await f.tick(); assert.equal(f.state.captures, 2);
  });
}
test('missing live proof always executes periodic requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let captures = 0;
  const scheduler = new ReconciliationScheduler({ runOnce: async () => { captures++; return null; } } as unknown as ReconciliationRunner,
    { currentContext: () => ({ accountId: 'PAPER', sessionId: 'session', sessionStartedAt: new Date() }) }, config, logger);
  scheduler.start(); t.mock.timers.tick(0); await settle(); t.mock.timers.tick(1000); await settle();
  assert.equal(captures, 2); await scheduler.stop();
});
test('fresh caller waits for periodic proof validation then performs its own capture', async t => {
  let gate: Promise<void> | undefined = undefined, release!: () => void;
  const f = fixture(t, async () => { if (gate) await gate; }); await f.start();
  gate = new Promise<void>(resolve => { release = resolve; });
  await f.tick(); const fresh = f.scheduler.triggerFresh(); assert.equal(f.state.captures, 1);
  release(); await fresh; assert.equal(f.state.captures, 2);
});
test('stop during periodic proof validation prevents fallback capture', async t => {
  let gate: Promise<void> | undefined = undefined, release!: () => void;
  const f = fixture(t, async () => { if (gate) await gate; }); await f.start();
  gate = new Promise<void>(resolve => { release = resolve; });
  await f.tick(); f.state.proof = false;
  const stopped = f.scheduler.stop(); release(); await stopped; assert.equal(f.state.captures, 1);
});
