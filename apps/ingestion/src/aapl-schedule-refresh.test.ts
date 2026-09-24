import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AaplScheduleEvidence } from '@ikbr/shared';
import { AaplScheduleRefresh } from './aapl-schedule-refresh.js';
import { scheduleFixture } from './aapl-schedule-fixture.js';
function fixture() {
  let now = Date.parse('2026-09-24T13:29:00Z'), evidence: AaplScheduleEvidence | null = null, calls = 0;
  const deps = { now: () => now, read: async () => evidence,
    begin: async (status: 'FAILED' | 'REFRESHING') => { evidence = { ...scheduleFixture(now), generation: (evidence?.generation ?? 0) + 1, status }; return evidence.generation; },
    finish: async (generation: number, schedule: AaplScheduleEvidence['schedule']) => {
      if (evidence?.generation !== generation || evidence.status !== 'REFRESHING') return false;
      evidence = { ...evidence, status: schedule ? 'READY' : 'FAILED', schedule, updatedAt: new Date(now).toISOString() }; return true;
    }, fetch: async () => { calls++; return scheduleFixture(now).schedule!; } };
  return { deps, get evidence() { return evidence; }, get calls() { return calls; }, advance: (ms: number) => { now += ms; } };
}
test('schedule startup invalidates old evidence, refreshes at open and hourly, singleflight coalesces', async () => {
  const f = fixture(), refresh = new AaplScheduleRefresh(f.deps);
  const first = refresh.ensure(); assert.equal(refresh.ensure(), first); await first;
  assert.equal(f.evidence?.status, 'READY'); assert.equal(f.calls, 1);
  f.advance(60000); await refresh.ensure(); assert.equal(f.calls, 2);
  f.advance(3599999); await refresh.ensure(); assert.equal(f.calls, 2);
  f.advance(1); await refresh.ensure(); assert.equal(f.calls, 3);
});
test('a reconnect during schedule fetch fences out the older callback', async () => {
  const f = fixture(); let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  let started!: () => void; const start = new Promise<void>(r => { started = r; });
  const refresh = new AaplScheduleRefresh({ ...f.deps, fetch: async () => { started(); await barrier; return scheduleFixture(f.deps.now()).schedule!; } });
  const pending = refresh.ensure(); await start; await refresh.invalidate(); release(); await pending;
  assert.equal(f.evidence?.status, 'FAILED');
});
test('failure remains durable and cannot be hidden by older READY evidence or immediate retry', async () => {
  const f = fixture(); let calls = 0;
  const refresh = new AaplScheduleRefresh({ ...f.deps, fetch: async () => { calls++; throw new Error('broker failed'); } });
  await refresh.ensure(); assert.equal(f.evidence?.status, 'FAILED'); await refresh.ensure(); assert.equal(calls, 1);
  f.advance(60000); await refresh.ensure(); assert.equal(calls, 2);
});
test('failed durable invalidation blocks readiness and retries invalidation before recovery', async () => {
  const f = fixture(); let unavailable = false;
  const refresh = new AaplScheduleRefresh({ ...f.deps, begin: async status => { if (unavailable) throw new Error('database_unavailable'); return f.deps.begin(status); } });
  await refresh.ensure(); assert.equal(f.evidence?.status, 'READY');
  unavailable = true; await assert.rejects(refresh.invalidate(), /database/);
  await assert.rejects(refresh.ensure(), /database/); assert.match(refresh.lastError ?? '', /database/);
  unavailable = false; await refresh.ensure(); assert.equal(f.evidence?.status, 'READY'); assert.equal(f.calls, 2);
});
test('database read failure is explicit and never returned as prior READY evidence', async () => {
  const f = fixture(); const refresh = new AaplScheduleRefresh({ ...f.deps, read: async () => { throw new Error('read_failed'); } });
  await assert.rejects(refresh.ensure(), /read_failed/); assert.equal(refresh.lastError, 'read_failed');
});
