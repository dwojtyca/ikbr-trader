import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionScheduleEvidence } from '@ikbr/shared';
import { SessionScheduleRefresh } from './session-schedule-refresh.js';
import { sessionIdentityFixture, sessionEvidenceFixture } from './session-fixture.js';
const identity = sessionIdentityFixture();
const scheduleFixture = (now: number) => sessionEvidenceFixture(identity, now);
function fixture() {
  let now = Date.parse('2026-09-24T13:29:00Z'), evidence: SessionScheduleEvidence | null = null, calls = 0;
  const deps = { now: () => now, read: async () => evidence,
    begin: async (status: 'FAILED' | 'REFRESHING') => { evidence = { ...scheduleFixture(now), generation: (evidence?.generation ?? 0) + 1, status }; return evidence.generation; },
    finish: async (generation: number, schedule: SessionScheduleEvidence['schedule']) => {
      if (evidence?.generation !== generation || evidence.status !== 'REFRESHING') return false;
      evidence = { ...evidence, status: schedule ? 'READY' : 'FAILED', schedule, updatedAt: new Date(now).toISOString() }; return true;
    }, fetch: async () => { calls++; return scheduleFixture(now).schedule!; } };
  return { deps, get evidence() { return evidence; }, get calls() { return calls; }, advance: (ms: number) => { now += ms; } };
}
test('schedule startup invalidates old evidence, refreshes at open and hourly, singleflight coalesces', async () => {
  const f = fixture(), refresh = new SessionScheduleRefresh(identity, f.deps);
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
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, fetch: async () => { started(); await barrier; return scheduleFixture(f.deps.now()).schedule!; } });
  const pending = refresh.ensure(); await start; await refresh.invalidate(); release(); await pending;
  assert.equal(f.evidence?.status, 'FAILED');
});
test('failure remains durable and cannot be hidden by older READY evidence or immediate retry', async () => {
  const f = fixture(); let calls = 0;
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, fetch: async () => { calls++; throw new Error('broker failed'); } });
  await refresh.ensure(); assert.equal(f.evidence?.status, 'FAILED'); await refresh.ensure(); assert.equal(calls, 1);
  f.advance(60000); await refresh.ensure(); assert.equal(calls, 2);
});
test('failed durable invalidation blocks readiness and retries invalidation before recovery', async () => {
  const f = fixture(); let unavailable = false;
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, begin: async status => { if (unavailable) throw new Error('database_unavailable'); return f.deps.begin(status); } });
  await refresh.ensure(); assert.equal(f.evidence?.status, 'READY');
  unavailable = true; await assert.rejects(refresh.invalidate(), /database/);
  await assert.rejects(refresh.ensure(), /database/); assert.match(refresh.lastError ?? '', /database/);
  unavailable = false; await refresh.ensure(); assert.equal(f.evidence?.status, 'READY'); assert.equal(f.calls, 2);
});
test('database read failure is explicit and never returned as prior READY evidence', async () => {
  const f = fixture(); const refresh = new SessionScheduleRefresh(identity, { ...f.deps, read: async () => { throw new Error('read_failed'); } });
  await assert.rejects(refresh.ensure(), /read_failed/); assert.equal(refresh.lastError, 'read_failed');
});
test('historical evidence after close remains usable for warmup and retries missing current coverage once per minute', async () => {
  const f = fixture(); f.advance(9 * 3600000);
  const refresh = new SessionScheduleRefresh(identity, f.deps);
  await refresh.ensure(); assert.equal(f.evidence?.status, 'READY'); assert.equal(f.calls, 1);
  await refresh.ensure(); assert.equal(f.calls, 1);
  f.advance(60000); await refresh.ensure(); assert.equal(f.calls, 2);
});

function mondayPartial(now: number): SessionScheduleEvidence {
  const stamp = new Date(now).toISOString(), requested = new Date(now - 1000).toISOString();
  return { generation: 1, status: 'READY', updatedAt: stamp, schedule: {
    source: 'ibkr_session_schedule_v1', identity, requestedAt: requested, receivedAt: stamp,
    coverageStart: '2026-09-29T13:30:00.000Z', coverageEnd: '2026-10-16T20:00:00.000Z',
    sessions: [{ date: '2026-10-16', start: '2026-10-16T13:30:00.000Z', end: '2026-10-16T20:00:00.000Z' }],
    currentHours: { source: 'ibkr_contract_hours_v1', identity: { ...identity }, requestedAt: requested, receivedAt: requested,
      days: [{ date: '2026-10-19', intervals: [{ start: '2026-10-19T13:30:00.000Z', end: '2026-10-19T20:00:00.000Z' }] }] },
  } };
}
test('Monday partial is persisted distinctly, retains real bounds and retries through ordinary pacing floor', async () => {
  const f = fixture(); f.advance(Date.parse('2026-10-19T07:23:43.347Z') - f.deps.now());
  let calls = 0;
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, fetch: async () => { calls++; return mondayPartial(f.deps.now()).schedule!; } });
  await refresh.ensure(); assert.equal(f.evidence?.status, 'READY'); assert.equal(refresh.lastError, undefined);
  assert.equal(refresh.lastAttemptDiagnostic?.status, 'PARTIAL'); assert.equal(refresh.lastAttemptDiagnostic?.reason, 'session_history_partial');
  assert.equal(refresh.lastAttemptDiagnostic?.coverageEnd, '2026-10-16T20:00:00.000Z');
  assert.equal(refresh.lastAttemptDiagnostic?.required.currentMonday, '2026-10-19T04:00:00.000Z');
  f.advance(59999); await refresh.ensure(); assert.equal(calls, 1);
  f.advance(1); await refresh.ensure(); assert.equal(calls, 2);
});
test('rejected parsed response diagnostics are distinct from retained evidence; fetch failure has no envelope', async () => {
  const f = fixture(); f.advance(Date.parse('2026-10-19T07:23:43.347Z') - f.deps.now());
  let failure = false;
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, fetch: async () => {
    if (failure) throw new Error('session_schedule_timeout');
    const schedule = mondayPartial(f.deps.now()).schedule!; delete schedule.currentHours; return schedule;
  } });
  await refresh.ensure(); assert.equal(f.evidence?.status, 'FAILED'); assert.equal(refresh.lastAttemptDiagnostic?.status, 'FAILED');
  assert.equal(refresh.lastAttemptDiagnostic?.coverageEnd, '2026-10-16T20:00:00.000Z');
  assert.equal(refresh.lastAttemptDiagnostic?.reason, 'session_schedule_coverage_missing');
  failure = true; f.advance(60000); await refresh.ensure();
  assert.equal(refresh.lastAttemptDiagnostic?.coverageEnd, undefined); assert.equal(refresh.lastAttemptDiagnostic?.requestedAt, undefined);
  assert.equal(refresh.lastAttemptDiagnostic?.reason, 'session_schedule_timeout');
});
test('invalidation supersedes a pending partial response and never displays a successful generation', async () => {
  const f = fixture(); f.advance(Date.parse('2026-10-19T07:23:43.347Z') - f.deps.now());
  let release!: () => void, started!: () => void;
  const barrier = new Promise<void>(r => { release = r; }), start = new Promise<void>(r => { started = r; });
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, fetch: async () => { started(); await barrier; return mondayPartial(f.deps.now()).schedule!; } });
  const pending = refresh.ensure(); await start; await refresh.invalidate(); release(); await pending;
  assert.equal(f.evidence?.status, 'FAILED'); assert.equal(refresh.lastAttemptDiagnostic?.status, 'SUPERSEDED');
});
test('normal opening schedule replaces partial diagnostics without carrying the old reason', async () => {
  const f = fixture(); f.advance(Date.parse('2026-10-19T07:23:43.347Z') - f.deps.now());
  let open = false;
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, fetch: async () => {
    const schedule = mondayPartial(f.deps.now()).schedule!;
    if (open) { schedule.coverageEnd = '2026-10-19T20:00:00.000Z'; schedule.sessions.push({ date: '2026-10-19', start: '2026-10-19T13:30:00.000Z', end: schedule.coverageEnd }); }
    return schedule;
  } });
  await refresh.ensure(); open = true; f.advance(Date.parse('2026-10-19T13:30:00Z') - f.deps.now()); await refresh.ensure();
  assert.equal(refresh.lastAttemptDiagnostic?.status, 'COMPLETE'); assert.equal(refresh.lastAttemptDiagnostic?.reason, undefined);
  await refresh.invalidate(); assert.equal(refresh.lastAttemptDiagnostic?.status, 'SUPERSEDED');
});

test('retained prior DB schedule cannot replace the rejected envelope in diagnostics', async () => {
  const now = Date.parse('2026-10-19T07:23:43.347Z');
  const old = mondayPartial(now).schedule!; old.coverageStart = '2026-09-28T13:30:00.000Z';
  let evidence: SessionScheduleEvidence = { generation: 8, status: 'READY', updatedAt: new Date(now).toISOString(), schedule: old };
  const refresh = new SessionScheduleRefresh(identity, { now: () => now, read: async () => evidence,
    begin: async status => { evidence = { ...evidence, generation: evidence.generation + 1, status }; return evidence.generation; },
    finish: async (generation, schedule) => {
      if (generation !== evidence.generation || evidence.status !== 'REFRESHING') return false;
      evidence = { ...evidence, status: schedule ? 'READY' : 'FAILED', schedule: schedule ?? evidence.schedule }; return true;
    }, fetch: async () => { const schedule = mondayPartial(now).schedule!; delete schedule.currentHours; return schedule; } });
  await refresh.ensure();
  assert.equal(evidence.status, 'FAILED'); assert.equal(evidence.schedule?.coverageStart, '2026-09-28T13:30:00.000Z');
  assert.equal(refresh.lastAttemptDiagnostic?.coverageStart, '2026-09-29T13:30:00.000Z');
});
test('a database read failure after success cannot leave successful current diagnostics', async () => {
  const f = fixture(); let broken = false;
  const refresh = new SessionScheduleRefresh(identity, { ...f.deps, read: async () => {
    if (broken) throw new Error('read_failed'); return f.deps.read();
  } });
  await refresh.ensure(); assert.equal(refresh.lastAttemptDiagnostic?.status, 'COMPLETE');
  broken = true; await assert.rejects(refresh.ensure(), /read_failed/);
  assert.equal(refresh.lastAttemptDiagnostic?.status, 'FAILED');
});

for (const state of ['complete', 'partial'] as const) for (const mutation of ['superseded', 'failed', 'stale'] as const)
  test(`${state} response diagnostics reconcile ${mutation} final database evidence`, async () => {
    const f = fixture();
    if (state === 'partial') f.advance(Date.parse('2026-10-19T07:24:00Z') - f.deps.now());
    let reads = 0;
    const refresh: SessionScheduleRefresh = new SessionScheduleRefresh(identity, { ...f.deps,
      fetch: async () => state === 'partial' ? mondayPartial(f.deps.now()).schedule! : scheduleFixture(f.deps.now()).schedule!,
      read: async () => {
        const evidence = await f.deps.read();
        if (++reads !== 2) return evidence;
        assert.equal(refresh.lastAttemptDiagnostic?.status, 'FETCHING');
        if (mutation === 'stale') { f.advance(7 * 3600000); return evidence; }
        return { ...evidence!, generation: evidence!.generation + (mutation === 'superseded' ? 1 : 0), status: 'FAILED' };
      },
    });
    const result = await refresh.ensure();
    assert.equal(refresh.lastAttemptDiagnostic?.status, mutation === 'superseded' ? 'SUPERSEDED' : 'FAILED');
    assert.equal(refresh.lastAttemptDiagnostic?.reason, mutation === 'superseded' ? 'session_schedule_generation_changed'
      : mutation === 'stale' ? 'session_schedule_stale' : 'session_schedule_unavailable');
    if (mutation === 'superseded') assert.equal(result!.generation, refresh.lastAttemptDiagnostic!.generation + 1);
  });
test('cached diagnostics also observe external generation changes inside the retry floor', async () => {
  const f = fixture(); const refresh = new SessionScheduleRefresh(identity, f.deps);
  await refresh.ensure(); assert.equal(refresh.lastAttemptDiagnostic?.status, 'COMPLETE');
  await f.deps.begin('FAILED'); await refresh.ensure();
  assert.equal(f.calls, 1); assert.equal(refresh.lastAttemptDiagnostic?.status, 'SUPERSEDED');
});
