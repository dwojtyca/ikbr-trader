import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionNativeSource, sessionLocalMidnight, shiftSessionDate, type Candle, type InstrumentSessionIdentity } from '@ikbr/shared';
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
  f.deps.schedule = async () => evidence; f.deps.readSchedule = async () => evidence;
  f.deps.fetch = async (_sub, _identity, tf) => {
    evidence = { ...evidence, generation: evidence.generation + 1 };
    return [{ conid: String(identity.conId), symbol: identity.symbol, timeframe: tf, ts: new Date('2026-09-24T13:30:00Z'),
      open: 100, high: 101, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity) }];
  };
  const refresh = new SessionNativeRefresh(f.deps); await refresh.run(f.subscriptions);
  assert.equal(f.writes.length, 0);
  for (const status of refresh.status.values()) assert.equal(status.error, 'session_schedule_generation_changed');
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
