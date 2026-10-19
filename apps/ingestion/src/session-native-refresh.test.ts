import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedSessionSlot, sessionNativeSource, sessionLocalMidnight, shiftSessionDate, type SessionTimeframe, type Candle, type InstrumentSessionIdentity } from '@ikbr/shared';
import { SessionNativeRefresh, SESSION_POLLING_CAPACITY } from './session-native-refresh.js';
import { sessionIdentityFixture, sessionEvidenceFixture } from './session-fixture.js';
const at = Date.parse('2026-09-24T18:00:00Z');
function fixture(identities: InstrumentSessionIdentity[]) {
  let clock = at;
  const calls: string[] = [], invalidations: string[] = [], writes: Candle[] = [];
  const subscriptions = identities.map(i => ({ instrumentId: i.instrumentId, conid: String(i.conId), symbol: i.symbol }));
  const deps: ConstructorParameters<typeof SessionNativeRefresh>[0] = {
    now: () => clock, identity: sub => identities.find(i => i.instrumentId === sub.instrumentId)!,
    schedule: async identity => sessionEvidenceFixture(identity, clock), readSchedule: async identity => sessionEvidenceFixture(identity, clock),
    invalidate: async identity => { invalidations.push(identity.instrumentId); }, read: async () => [],
    fetch: async (_sub, identity, tf) => { calls.push(`${identity.instrumentId}:${tf}`); return []; }, write: async c => { writes.push(c); },
  };
  return { deps, calls, invalidations, writes, subscriptions, advance: (ms: number) => { clock += ms; } };
}
test('all instruments use the same six-frame path, due minutes precede higher work and rotation is fair', async () => {
  const f = fixture([sessionIdentityFixture(), sessionIdentityFixture({ instrumentId: 'second', conId: 77, symbol: 'OTHER' })]);
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.deepEqual(f.calls.slice(0, 4), ['arbitrary_stock:1m', 'second:1m', 'arbitrary_stock:5m', 'second:5m']);
  assert.equal(f.calls.length, 12); assert.equal(refresh.status.size, 12);
  f.advance(60000); await refresh.run(f.subscriptions); assert.deepEqual(f.calls.slice(12, 14), ['second:1m', 'arbitrary_stock:1m']);
});
test('unsustainable polling sets are invalidated and rejected before historical requests', async () => {
  assert.equal(SESSION_POLLING_CAPACITY, 2);
  const f = fixture([1, 2, 3].map(n => sessionIdentityFixture({ instrumentId: `instrument${n}`, conId: n })));
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.equal(f.calls.length, 0); assert.equal(f.invalidations.length, 3);
  for (const status of refresh.status.values()) assert.equal(status.error, 'session_polling_capacity_exceeded');
});
test('same contract mixed modes are rejected and unbound subscriptions never acquire calendar history', async () => {
  const f = fixture([sessionIdentityFixture(), sessionIdentityFixture({ instrumentId: 'other_mode', useRTH: false })]);
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run([...f.subscriptions, { symbol: 'LEGACY', conid: '99' }]);
  assert.equal(f.calls.length, 0); assert.equal(f.invalidations.length, 2);
  assert.ok([...refresh.status.values()].some(s => s.error === 'session_binding_required'));
  assert.ok([...refresh.status.values()].some(s => s.error === 'session_mode_conflict'));
});
test('one calendar failure does not suppress another contract and cannot persist foreign bars', async () => {
  const a = sessionIdentityFixture(), b = sessionIdentityFixture({ instrumentId: 'second', conId: 77, symbol: 'OTHER' });
  const f = fixture([a, b]);
  f.deps.schedule = async identity => { if (identity.instrumentId === a.instrumentId) throw new Error('calendar_unavailable'); return sessionEvidenceFixture(identity, at); };
  f.deps.fetch = async (_sub, identity, tf) => { f.calls.push(identity.instrumentId); return [{ conid: String(a.conId), symbol: a.symbol,
    ts: new Date('2026-09-24T13:30:00Z'), timeframe: tf, open: 100, high: 101, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity) }]; };
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.ok(f.calls.length > 0); assert.ok(f.calls.every(x => x === 'second')); assert.equal(f.writes.length, 0);
});
test('slow cold bootstrap services newly due minutes before proceeding with more higher-timeframe work', async () => {
  const f = fixture([sessionIdentityFixture()]);
  f.deps.fetch = async (_sub, identity, tf) => { f.calls.push(`${identity.instrumentId}:${tf}`); f.advance(60001); return []; };
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.deepEqual(f.calls.slice(0, 5), ['arbitrary_stock:1m', 'arbitrary_stock:1m', 'arbitrary_stock:5m', 'arbitrary_stock:1m', 'arbitrary_stock:1h']);
});
test('a newer schedule generation during native fetch prevents persistence and readiness under the old proof', async () => {
  const identity = sessionIdentityFixture(), f = fixture([identity]);
  let evidence = sessionEvidenceFixture(identity, at);
  let fetches = 0;
  f.deps.schedule = async () => evidence; f.deps.readSchedule = async () => evidence;
  f.deps.fetch = async (_sub, _identity, tf) => {
    fetches++;
    evidence = { ...evidence, generation: evidence.generation + 1 };
    return [{ conid: String(identity.conId), symbol: identity.symbol, timeframe: tf, ts: new Date('2026-09-24T13:30:00Z'),
      open: 100, high: 101, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity) }];
  };
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.equal(f.writes.length, 0);
  for (const status of refresh.status.values()) assert.equal(status.error, 'session_schedule_generation_changed');
  assert.equal(fetches, 6);
  f.advance(59999); await refresh.run(f.subscriptions); assert.equal(fetches, 6);
  f.advance(1); await refresh.run(f.subscriptions); assert.equal(fetches, 12);
});

test('a native following-date weekly label satisfies the expected period without repeated history fetches', async () => {
  const identity = sessionIdentityFixture(), f = fixture([identity]);
  const rows: Candle[] = Array.from({ length: 50 }, (_, n) => ({
    conid: String(identity.conId), symbol: identity.symbol, timeframe: '1w',
    ts: new Date(sessionLocalMidnight(shiftSessionDate('2026-09-19', -(49 - n) * 7), identity.timeZone)),
    open: 100, high: 101, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity),
  }));
  f.deps.read = async (_identity, tf) => tf === '1w' ? rows : [];
  const refresh = new SessionNativeRefresh(f.deps);
  await refresh.run(f.subscriptions); f.advance(60001); await refresh.run(f.subscriptions);
  assert.equal(f.calls.filter(x => x.endsWith(':1w')).length, 0);
  const status = [...refresh.status.values()].find(x => x.timeframe === '1w')!;
  assert.equal(status.error, undefined);
  assert.equal(status.nativeClosed, 50);
  assert.equal(status.latest, '2026-09-19T04:00:00.000Z');
  assert.equal(status.latestEnd, '2026-09-21T04:00:00.000Z');
});

function minuteRows(identity: InstrumentSessionIdentity, expectedEnd: number, count = 220): Candle[] {
  return Array.from({ length: count }, (_, n) => ({
    conid: String(identity.conId), symbol: identity.symbol, timeframe: '1m' as const,
    ts: new Date(expectedEnd - (count - n) * 60000), open: 100, high: 101, low: 99, close: 100,
    volume: 1, source: sessionNativeSource(identity),
  }));
}
function upsertRow(rows: Candle[], candle: Candle): Candle[] {
  return [...rows.filter(row => row.ts.getTime() !== candle.ts.getTime()), candle]
    .sort((a, b) => a.ts.getTime() - b.ts.getTime()).slice(-230);
}

test('rotation cannot skip a newly closed minute when the prior successful fetch started 59.7s earlier', async () => {
  const start = Date.parse('2026-09-24T18:00:09Z');
  let clock = start;
  const first = sessionIdentityFixture({ instrumentId: 'first', conId: 1, symbol: 'FIRST' });
  const aapl = sessionIdentityFixture({ instrumentId: 'aapl_nasdaq', conId: 265598, symbol: 'AAPL' });
  const identities = [first, aapl], calls: string[] = [];
  const rows = new Map(identities.map(identity => [identity.instrumentId, minuteRows(identity, Math.floor(start / 60000) * 60000 - 60000)]));
  const refresh = new SessionNativeRefresh({
    now: () => clock, identity: sub => identities.find(identity => identity.instrumentId === sub.instrumentId)!,
    schedule: async identity => sessionEvidenceFixture(identity, clock), readSchedule: async identity => sessionEvidenceFixture(identity, clock),
    invalidate: async () => {}, read: async (identity, tf) => tf === '1m' ? rows.get(identity.instrumentId)! : [],
    fetch: async (_sub, identity, tf) => {
      if (tf !== '1m') return [];
      calls.push(`${identity.symbol}@${new Date(clock).toISOString()}`);
      const expected = expectedSessionSlot('1m', sessionEvidenceFixture(identity, clock).schedule!, clock)!;
      clock += 300;
      return minuteRows(identity, Date.parse(expected.end));
    },
    write: async candle => { const id = candle.symbol === 'AAPL' ? aapl.instrumentId : first.instrumentId;
      rows.set(id, upsertRow(rows.get(id) ?? [], candle)); },
  });
  const subs = identities.map(identity => ({ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }));
  for (let n = 0; n < 3; n++) { clock = start + n * 60000; await refresh.run(subs); }
  assert.deepEqual(calls.filter(call => call.startsWith('AAPL@')), [
    'AAPL@2026-09-24T18:00:09.300Z', 'AAPL@2026-09-24T18:01:09.000Z', 'AAPL@2026-09-24T18:02:09.300Z',
  ]);
  assert.equal(refresh.status.get('aapl_nasdaq:265598:rth:1m')?.error, undefined);
});

test('successful acquisition requires expected fetched and persisted slot plus complete warmup', async () => {
  const identity = sessionIdentityFixture();
  const start = Date.parse('2026-09-24T18:00:00Z');
  for (const mode of ['empty', 'missing_target', 'insufficient_warmup', 'not_persisted'] as const) {
    let clock = start, calls = 0;
    const expectedEnd = start;
    let rows = minuteRows(identity, start - 60000);
    const refresh = new SessionNativeRefresh({
      now: () => clock, identity: () => identity,
      schedule: async () => sessionEvidenceFixture(identity, clock), readSchedule: async () => sessionEvidenceFixture(identity, clock),
      invalidate: async () => {}, read: async (_identity, tf) => tf === '1m' ? rows : [],
      fetch: async (_sub, _identity, tf) => {
        if (tf !== '1m') return [];
        calls++;
        if (mode === 'empty') return [];
        if (mode === 'missing_target') return minuteRows(identity, start - 60000);
        if (mode === 'insufficient_warmup') return minuteRows(identity, expectedEnd, 1);
        return minuteRows(identity, expectedEnd);
      },
      write: async candle => { if (mode !== 'not_persisted') rows = upsertRow(rows, candle);
        if (mode === 'insufficient_warmup') rows = rows.slice(-1); },
    });
    const sub = [{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }];
    await refresh.run(sub);
    clock = start + 59000; await refresh.run(sub);
    assert.equal(calls, 1, `${mode}: early retry`);
    clock = start + 60000; await refresh.run(sub);
    assert.equal(calls, 2, `${mode}: ordinary retry`);
  }
});

test('success completion floor, same-slot suppression and backwards catch clock preserve retry bounds', async () => {
  const identity = sessionIdentityFixture(), sub = [{ instrumentId: 'arbitrary_stock', conid: '1234567', symbol: 'XYZ' }];
  const start = Date.parse('2026-09-24T18:00:00Z');
  let clock = start, calls = 0, rows = minuteRows(identity, start - 60000);
  let fail = false;
  const refresh = new SessionNativeRefresh({
    now: () => clock, identity: () => identity,
    schedule: async () => sessionEvidenceFixture(identity, clock), readSchedule: async () => sessionEvidenceFixture(identity, clock),
    invalidate: async () => {}, read: async (_identity, tf) => tf === '1m' ? rows : [],
    fetch: async (_sub, _identity, tf) => {
      if (tf !== '1m') return [];
      calls++;
      if (fail) { clock -= 10000; throw new Error('fetch_failed'); }
      const target = Date.parse(expectedSessionSlot('1m', sessionEvidenceFixture(identity, clock).schedule!, clock)!.end);
      if (calls === 1) clock += 55000;
      return minuteRows(identity, target);
    },
    write: async candle => { rows = upsertRow(rows, candle); },
  });
  await refresh.run(sub);
  rows = rows.slice(0, -1);
  clock = start + 60000; await refresh.run(sub);
  assert.equal(calls, 1, 'ordinary 60s branch must still wait 15s from slow completion');
  clock = start + 70000; await refresh.run(sub);
  assert.equal(calls, 2);
  clock = start + 75000; await refresh.run(sub);
  assert.equal(calls, 2, 'same expected slot cannot rapidly repeat');
  fail = true;
  clock = start + 130000; await refresh.run(sub);
  assert.equal(calls, 3);
  clock = start + 179999; await refresh.run(sub);
  assert.equal(calls, 3, 'rewound catch clock must not shorten failed-attempt backoff');
  clock = start + 190000; await refresh.run(sub);
  assert.equal(calls, 4);
});

test('a newer slot inside the 15s completion floor waits; an invalid clock never requests history', async () => {
  const identity = sessionIdentityFixture(), start = Date.parse('2026-09-24T18:00:55Z');
  let clock = start, calls = 0, rows = minuteRows(identity, Date.parse('2026-09-24T17:59:00Z'));
  const refresh = new SessionNativeRefresh({
    now: () => clock, identity: () => identity,
    schedule: async () => sessionEvidenceFixture(identity, start), readSchedule: async () => sessionEvidenceFixture(identity, start),
    invalidate: async () => {}, read: async (_identity, tf) => tf === '1m' ? rows : [],
    fetch: async (_sub, _identity, tf) => {
      if (tf !== '1m') return [];
      calls++;
      const end = Date.parse(expectedSessionSlot('1m', sessionEvidenceFixture(identity, start).schedule!, clock)!.end);
      return minuteRows(identity, end);
    },
    write: async candle => { rows = upsertRow(rows, candle); },
  });
  const sub = [{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }];
  await refresh.run(sub);
  assert.equal(calls, 1);
  clock = Date.parse('2026-09-24T18:01:00Z'); await refresh.run(sub);
  assert.equal(calls, 1);
  clock = Date.parse('2026-09-24T18:01:10Z'); await refresh.run(sub);
  assert.equal(calls, 2);
  clock = NaN; await refresh.run(sub);
  assert.equal(calls, 2);
  assert.equal(refresh.status.get(`${identity.instrumentId}:${identity.conId}:rth:1m`)?.error, 'session_timestamp_invalid');
});

test('clock regression during a completed fetch cannot qualify that acquisition for the fast path', async () => {
  const identity = sessionIdentityFixture(), start = Date.parse('2026-09-24T18:00:30Z');
  let clock = start, calls = 0, rows = minuteRows(identity, Date.parse('2026-09-24T17:59:00Z'));
  const refresh = new SessionNativeRefresh({
    now: () => clock, identity: () => identity,
    schedule: async () => sessionEvidenceFixture(identity, start), readSchedule: async () => sessionEvidenceFixture(identity, start),
    invalidate: async () => {}, read: async (_identity, tf) => tf === '1m' ? rows : [],
    fetch: async (_sub, _identity, tf) => {
      if (tf !== '1m') return [];
      calls++;
      if (calls === 1) clock -= 1000;
      return minuteRows(identity, Date.parse('2026-09-24T18:00:00Z'));
    },
    write: async candle => { rows = upsertRow(rows, candle); },
  });
  const sub = [{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }];
  await refresh.run(sub);
  clock = start + 59000; await refresh.run(sub);
  assert.equal(calls, 1);
  clock = start + 60000; await refresh.run(sub);
  assert.equal(calls, 2);
});

test('slow prefetch read timestamps an empty acquisition at actual request time', async () => {
  const identity = sessionIdentityFixture(), start = Date.parse('2026-09-24T18:00:00Z');
  let clock = start, calls = 0, slowRead = true;
  const refresh = new SessionNativeRefresh({
    now: () => clock, identity: () => identity,
    schedule: async () => sessionEvidenceFixture(identity, start), readSchedule: async () => sessionEvidenceFixture(identity, start),
    invalidate: async () => {}, read: async (_identity, tf) => {
      if (tf === '1m' && slowRead) { slowRead = false; clock += 55000; }
      return [];
    },
    fetch: async (_sub, _identity, tf) => { if (tf === '1m') calls++; return []; },
    write: async () => {},
  });
  const sub = [{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }];
  await refresh.run(sub);
  assert.equal(calls, 1);
  clock = start + 60000; await refresh.run(sub);
  assert.equal(calls, 1, 'five seconds after actual request is not a 60s retry');
  clock = start + 115000; await refresh.run(sub);
  assert.equal(calls, 2);
});

test('nonfinite or regressing clock after prefetch read cannot reach broker fetch', async () => {
  const identity = sessionIdentityFixture(), start = Date.parse('2026-09-24T18:00:00Z');
  for (const changed of [NaN, start - 1000]) {
    let clock = start, calls = 0;
    const refresh = new SessionNativeRefresh({
      now: () => clock, identity: () => identity,
      schedule: async () => sessionEvidenceFixture(identity, start), readSchedule: async () => sessionEvidenceFixture(identity, start),
      invalidate: async () => {}, read: async (_identity, tf) => { if (tf === '1m') clock = changed; return []; },
      fetch: async () => { calls++; return []; }, write: async () => {},
    });
    await refresh.run([{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }]);
    assert.equal(calls, 0);
    assert.equal(refresh.status.get(`${identity.instrumentId}:${identity.conId}:rth:1m`)?.error, 'session_timestamp_invalid');
  }
});

test('a missing target in the same slot cannot use the 15s successful-acquisition path', async () => {
  const identity = sessionIdentityFixture(), start = Date.parse('2026-09-24T18:00:00Z');
  let clock = start, calls = 0, rows = minuteRows(identity, start - 60000);
  const refresh = new SessionNativeRefresh({
    now: () => clock, identity: () => identity,
    schedule: async () => sessionEvidenceFixture(identity, start), readSchedule: async () => sessionEvidenceFixture(identity, start),
    invalidate: async () => {}, read: async (_identity, tf) => tf === '1m' ? rows : [],
    fetch: async (_sub, _identity, tf) => { if (tf !== '1m') return []; calls++; return minuteRows(identity, start); },
    write: async candle => { rows = upsertRow(rows, candle); },
  });
  const sub = [{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }];
  await refresh.run(sub);
  assert.equal(calls, 1);
  rows = rows.filter(row => row.ts.getTime() !== start - 60000);
  clock = start + 30000; await refresh.run(sub);
  assert.equal(calls, 1, 'same expected slot remains rate-limited after the 15s floor');
});

test('concurrent callers share one in-flight native refresh', async () => {
  const identity = sessionIdentityFixture(), start = Date.parse('2026-09-24T18:00:00Z');
  let calls = 0, release!: () => void, signalStarted!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const refresh = new SessionNativeRefresh({
    now: () => start, identity: () => identity,
    schedule: async () => sessionEvidenceFixture(identity, start), readSchedule: async () => sessionEvidenceFixture(identity, start),
    invalidate: async () => {}, read: async () => [],
    fetch: async (_sub, _identity, tf) => { if (tf === '1m') { calls++; signalStarted(); await barrier; } return []; },
    write: async () => {},
  });
  const sub = [{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }];
  const first = refresh.run(sub);
  await started;
  const second = refresh.run(sub);
  assert.strictEqual(second, first);
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('schedule generation changing after persistence does not qualify a rapid retry', async () => {
  const identity = sessionIdentityFixture(), start = Date.parse('2026-09-24T18:00:00Z');
  let clock = start, calls = 0, scheduleReads = 0, rows = minuteRows(identity, start - 60000);
  const original = sessionEvidenceFixture(identity, start);
  let evidence = original;
  const refresh = new SessionNativeRefresh({
    now: () => clock, identity: () => identity,
    schedule: async () => evidence,
    readSchedule: async () => {
      scheduleReads++;
      if (scheduleReads === 2) evidence = { ...original, generation: original.generation + 1 };
      return evidence;
    },
    invalidate: async () => {}, read: async (_identity, tf) => tf === '1m' ? rows : [],
    fetch: async (_sub, _identity, tf) => { if (tf !== '1m') return []; calls++; return minuteRows(identity, start); },
    write: async candle => { rows = upsertRow(rows, candle); },
  });
  const sub = [{ instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol }];
  await refresh.run(sub);
  assert.equal(calls, 1);
  assert.equal(refresh.status.get(`${identity.instrumentId}:${identity.conId}:rth:1m`)?.error, 'session_schedule_generation_changed');
  rows = minuteRows(identity, start - 60000);
  clock = start + 59999; await refresh.run(sub);
  assert.equal(calls, 1);
  clock = start + 60000; await refresh.run(sub);
  assert.equal(calls, 2);
});

function mondayEvidence(identity: InstrumentSessionIdentity, now: number, complete = false) {
  const stamp = new Date(now).toISOString(), requested = new Date(now - 1).toISOString();
  const schedule = { source: 'ibkr_session_schedule_v1' as const, identity,
    coverageStart: '2026-09-29T13:30:00.000Z', coverageEnd: complete ? '2026-10-19T20:00:00.000Z' : '2026-10-16T20:00:00.000Z',
    requestedAt: requested, receivedAt: stamp,
    sessions: [{ date: '2026-10-16', start: '2026-10-16T13:30:00.000Z', end: '2026-10-16T20:00:00.000Z' }],
    currentHours: { source: 'ibkr_contract_hours_v1' as const, identity: { ...identity }, requestedAt: requested, receivedAt: requested,
      days: [{ date: '2026-10-19', intervals: [{ start: '2026-10-19T13:30:00.000Z', end: '2026-10-19T20:00:00.000Z' }] }] },
  };
  if (complete) schedule.sessions.push({ date: '2026-10-19', start: '2026-10-19T13:30:00.000Z', end: '2026-10-19T20:00:00.000Z' });
  return { generation: complete ? 2 : 1, status: 'READY' as const, updatedAt: stamp, schedule };
}
test('partial Monday preloads five genuine timeframes, leaves weekly unmeasured, and completes on normal opening refresh', async () => {
  const identity = sessionIdentityFixture(), f = fixture([identity]);
  let now = Date.parse('2026-10-19T07:23:43.347Z'), complete = false;
  const rows = new Map<SessionTimeframe, Candle[]>();
  f.deps.now = () => now;
  f.deps.schedule = f.deps.readSchedule = async () => mondayEvidence(identity, now, complete);
  f.deps.read = async (_identity, tf) => rows.get(tf) ?? [];
  f.deps.fetch = async (_sub, identity, tf) => {
    f.calls.push(tf);
    const slot = expectedSessionSlot(tf, mondayEvidence(identity, now, complete).schedule, now)!;
    return [{ conid: String(identity.conId), symbol: identity.symbol, timeframe: tf, ts: new Date(slot.start),
      open: 100, high: 101, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity) }];
  };
  f.deps.write = async row => { f.writes.push(row); rows.set(row.timeframe as SessionTimeframe, [row]); };
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.deepEqual(f.calls, ['1m', '5m', '1h', '4h', '1d']); assert.equal(f.writes.length, 5);
  for (const status of refresh.status.values()) {
    assert.equal(status.preparationState, 'WAITING'); assert.equal(status.historyCoverage, 'PARTIAL');
    assert.equal(status.countsMeasured, status.timeframe !== '1w');
    assert.equal(status.preparationReason, status.timeframe === '1w' ? 'session_weekly_coverage_pending' : 'session_history_partial');
  }
  complete = true; now = Date.parse('2026-10-19T13:30:30Z'); await refresh.run(f.subscriptions);
  assert.ok(f.calls.includes('1w'));
  const minute = [...refresh.status.values()].find(s => s.timeframe === '1m')!;
  assert.equal(minute.historyCoverage, 'COMPLETE'); assert.equal(minute.preparationState, 'WAITING');
  assert.ok(minute.latest! < '2026-10-19T13:30:00.000Z');
  now = Date.parse('2026-10-19T13:31:30Z'); await refresh.run(f.subscriptions);
  assert.equal([...refresh.status.values()].find(s => s.timeframe === '1m')!.latest, '2026-10-19T13:30:00.000Z');
});
test('partial history still rejects generation changes and invalid candle values before persistence', async () => {
  for (const failure of ['generation', 'values'] as const) {
    const identity = sessionIdentityFixture(), f = fixture([identity]); const now = Date.parse('2026-10-19T07:23:43.347Z');
    f.deps.now = () => now; f.deps.schedule = async () => mondayEvidence(identity, now);
    f.deps.readSchedule = async () => ({ ...mondayEvidence(identity, now), generation: failure === 'generation' ? 2 : 1 });
    f.deps.fetch = async (_sub, _identity, tf) => {
      const slot = expectedSessionSlot(tf, mondayEvidence(identity, now).schedule, now)!;
      return [{ conid: String(identity.conId), symbol: identity.symbol, timeframe: tf, ts: new Date(slot.start),
        open: 100, high: 90, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity) }];
    };
    const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
    assert.equal(f.writes.length, 0);
    for (const status of refresh.status.values()) if (status.timeframe !== '1w') {
      assert.equal(status.preparationState, 'HOLD');
      assert.equal(status.error, failure === 'generation' ? 'session_schedule_generation_changed' : 'session_candle_values_invalid');
    }
  }
});

test('a partial instrument cannot block independent complete-history preparation', async () => {
  const a = sessionIdentityFixture(), b = sessionIdentityFixture({ instrumentId: 'second', conId: 77 });
  const f = fixture([a, b]), now = Date.parse('2026-10-19T07:23:43.347Z'); f.deps.now = () => now;
  f.deps.schedule = f.deps.readSchedule = async identity => mondayEvidence(identity, now, identity.instrumentId === b.instrumentId);
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.equal(f.calls.filter(x => x.startsWith(`${a.instrumentId}:`)).length, 5);
  assert.equal(f.calls.filter(x => x.startsWith(`${b.instrumentId}:`)).length, 6);
  assert.equal([...refresh.status.values()].find(s => s.instrumentId === b.instrumentId && s.timeframe === '1w')?.historyCoverage, 'COMPLETE');
});
test('partial history that becomes stale during fetch cannot persist late results', async () => {
  const identity = sessionIdentityFixture(), f = fixture([identity]); let now = Date.parse('2026-10-19T07:23:43.347Z');
  const evidence = mondayEvidence(identity, now); f.deps.now = () => now;
  f.deps.schedule = f.deps.readSchedule = async () => evidence;
  f.deps.fetch = async (_sub, _identity, tf) => {
    now += 7 * 3600000;
    return [{ conid: String(identity.conId), symbol: identity.symbol, timeframe: tf, ts: new Date('2026-10-16T19:59:00Z'),
      open: 100, high: 101, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity) }];
  };
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.equal(f.writes.length, 0);
  for (const status of refresh.status.values()) { assert.equal(status.preparationState, 'HOLD'); assert.equal(status.error, 'session_schedule_stale'); }
});

for (const stage of ['fetch', 'final-read', 'between-writes'] as const)
  test(`older valid partial evidence cannot hide clock regression at ${stage}`, async () => {
    const identity = sessionIdentityFixture(), f = fixture([identity]);
    const receivedAt = Date.parse('2026-10-19T07:23:00Z');
    let now = Date.parse('2026-10-19T07:24:00Z'), minuteReads = 0, minuteWrites = 0;
    const evidence = mondayEvidence(identity, receivedAt);
    f.deps.now = () => now;
    f.deps.schedule = f.deps.readSchedule = async () => evidence;
    f.deps.read = async (_identity, tf) => {
      if (tf === '1m' && ++minuteReads === 2 && stage === 'final-read') now -= 1000;
      return [];
    };
    f.deps.fetch = async (_sub, _identity, tf) => {
      if (tf !== '1m') return [];
      if (stage === 'fetch') now -= 1000;
      return minuteRows(identity, Date.parse('2026-10-16T20:00:00Z'), stage === 'between-writes' ? 2 : 1);
    };
    f.deps.write = async candle => {
      if (candle.timeframe === '1m') { minuteWrites++; if (stage === 'between-writes') now -= 1000; }
    };
    const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
    const status = [...refresh.status.values()].find(s => s.timeframe === '1m')!;
    assert.equal(status.error, 'session_timestamp_invalid'); assert.equal(status.preparationState, 'HOLD');
    assert.equal(status.historyCoverage, 'UNAVAILABLE'); assert.equal(status.countsMeasured, false);
    assert.equal(minuteWrites, stage === 'fetch' ? 0 : 1);
  });
