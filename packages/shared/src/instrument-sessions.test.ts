import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Candle } from './index.js';
import { buildInstrumentSessionIdentity, canonicalSessionTimeZone, checkSessionWindow, matchesSessionSlot, evaluateSessionCandles, expectedSessionSlot, filterClosedSessionCandles, parseBrokerSessionSchedule, requireSessionSchedule, requireSessionHistorySchedule, sessionCandleSlots, sessionLocalMidnight, sessionLocalTime, sessionNativeSource, shiftSessionDate, type InstrumentSessionIdentity, type SessionSchedule, type SessionScheduleEvidence, type SessionTimeframe } from './instrument-sessions.js';

function fixture(zone = 'Europe/Warsaw', hour = 9, minute = 0, overrides: Partial<InstrumentSessionIdentity> = {}) {
  const identity: InstrumentSessionIdentity = { instrumentId: 'arbitrary_registered_contract', conId: 998877, symbol: 'OTHER', secType: 'STK', exchange: 'TEST', currency: 'PLN', useRTH: true, timeZone: zone, ...overrides };
  const instant = (date: string, h: number, m = 0) => new Date(sessionLocalTime(date, h, m, 0, zone)).toISOString();
  const sessions: SessionSchedule['sessions'] = [];
  for (let date = '2026-09-01'; date <= '2026-09-30'; date = shiftSessionDate(date, 1)) {
    const day = new Date(date+'T12:00:00Z').getUTCDay();
    if (day !== 0 && day !== 6) sessions.push({ date, start: instant(date, hour, minute), end: instant(date, Math.min(hour + 7, 23), minute) });
  }
  const now = sessionLocalTime('2026-09-24', hour, minute + 1, 0, zone);
  const schedule: SessionSchedule = { source: 'ibkr_session_schedule_v1', identity,
    coverageStart: instant('2026-09-01', 0), coverageEnd: instant('2026-10-01', 0),
    requestedAt: new Date(now - 10000).toISOString(), receivedAt: new Date(now - 5000).toISOString(), sessions };
  const evidence: SessionScheduleEvidence = { generation: 2, status: 'READY', updatedAt: new Date(now - 1000).toISOString(), schedule };
  return { identity, schedule, evidence, now, instant };
}
function candle(identity: InstrumentSessionIdentity, tf: SessionTimeframe, start: string, volume = 100): Candle {
  return { conid: String(identity.conId), symbol: identity.symbol, timeframe: tf, ts: new Date(start), open: 100, high: 102, low: 99, close: 101, volume, source: sessionNativeSource(identity) };
}
for (const [zone, hour, minute, symbol, exchange, currency] of [
  ['Europe/Warsaw', 9, 0, 'PKO', 'WSE', 'PLN'], ['America/New_York', 9, 30, 'AAPL', 'SMART', 'USD'],
  ['America/New_York', 9, 30, 'MSFT', 'SMART', 'USD'], ['Europe/London', 8, 0, 'VOD', 'LSE', 'GBP'],
  ['Asia/Kolkata', 9, 15, 'RANDOM', 'OTHER', 'INR'],
] as const) test(`same shared algorithm permits first closed minute for ${symbol}/${zone}`, () => {
  const f = fixture(zone, hour, minute, { symbol, exchange, currency });
  for (const tf of ['1m', '5m', '1h', '4h', '1d', '1w'] as const) {
    const slot = expectedSessionSlot(tf, f.schedule, f.now)!;
    assert.ok(slot);
    const result = evaluateSessionCandles([candle(f.identity, tf, slot.start)], tf, f.evidence, f.identity, f.now);
    assert.equal(result.reason, undefined, tf);
    if (tf !== '1m') assert.ok(Date.parse(slot.end) <= Date.parse(f.instant('2026-09-24', hour, minute)));
  }
});
test('premarket and before first minute never reuse yesterday minute', () => {
  const f = fixture(), prior = f.instant('2026-09-23', 15, 59);
  const rows = [candle(f.identity, '1m', prior)];
  assert.equal(evaluateSessionCandles(rows, '1m', f.evidence, f.identity, f.now - 30000).reason, 'session_schedule_stale');
  f.evidence.updatedAt = f.schedule.receivedAt = f.schedule.requestedAt = new Date(f.now - 3600000).toISOString();
  assert.equal(evaluateSessionCandles(rows, '1m', f.evidence, f.identity, f.now - 30000).reason, 'session_current_interval_minute_missing');
  assert.equal(evaluateSessionCandles(rows, '1m', f.evidence, f.identity, f.now - 120000).reason, 'session_closed');
});
test('newly due higher bar gets only immediate predecessor grace and excludes open bar', () => {
  const f = fixture(); const at = sessionLocalTime('2026-09-24', 10, 0, 0, f.identity.timeZone);
  f.schedule.receivedAt = f.schedule.requestedAt = f.evidence.updatedAt = new Date(at - 3000).toISOString();
  const previous = expectedSessionSlot('1h', f.schedule, at - 1)!;
  const open = candle(f.identity, '1h', new Date(at).toISOString());
  const rows = [candle(f.identity, '1h', previous.start), open];
  assert.equal(evaluateSessionCandles(rows, '1h', f.evidence, f.identity, at + 90000).reason, undefined);
  assert.equal(evaluateSessionCandles(rows, '1h', f.evidence, f.identity, at + 90001).reason, 'session_expected_candle_missing');
  assert.equal(filterClosedSessionCandles(rows, '1h', f.schedule, at + 90000).length, 1);
});
test('holiday and early close are schedule data, never weekday assumptions', () => {
  const f = fixture();
  f.schedule.sessions = f.schedule.sessions.filter(x => x.date !== '2026-09-23');
  const prior = f.schedule.sessions.find(x => x.date === '2026-09-22')!; prior.end = f.instant(prior.date, 12);
  const expected = expectedSessionSlot('4h', f.schedule, f.now)!;
  assert.equal(expected.end, prior.end);
  assert.equal(evaluateSessionCandles([candle(f.identity, '4h', expected.start)], '4h', f.evidence, f.identity, f.now).reason, undefined);
});
test('overnight futures preserve trading reference date across midnight', () => {
  const f = fixture('America/Chicago', 9, 0, { secType: 'FUT', useRTH: false, symbol: 'ES', exchange: 'CME', currency: 'USD' });
  f.schedule.sessions = f.schedule.sessions.map(x => ({ date: x.date, start: f.instant(shiftSessionDate(x.date, -1), 17), end: f.instant(x.date, 16) })).filter(x => Date.parse(x.start) >= Date.parse(f.schedule.coverageStart));
  const now = Date.parse(f.instant('2026-09-23', 17, 1));
  f.evidence.updatedAt = f.schedule.requestedAt = f.schedule.receivedAt = new Date(now - 1000).toISOString();
  const expected = expectedSessionSlot('1m', f.schedule, now)!;
  assert.equal(expected.start, f.instant('2026-09-23', 17));
  assert.equal(evaluateSessionCandles([candle(f.identity, '1m', expected.start)], '1m', f.evidence, f.identity, now).reason, undefined);
  const day = sessionCandleSlots(f.schedule, '1d').find(x => x.start === f.instant('2026-09-24', 0))!;
  assert.equal(day.end, f.instant('2026-09-25', 0));
});
test('lunch reopening requires a new interval minute; higher bars can come from before lunch', () => {
  const f = fixture('Asia/Tokyo');
  f.schedule.sessions = f.schedule.sessions.flatMap(x => [{ ...x, end: f.instant(x.date, 11, 30) }, { ...x, start: f.instant(x.date, 12, 30), end: f.instant(x.date, 15) }]);
  const now = Date.parse(f.instant('2026-09-24', 12, 31));
  f.evidence.updatedAt = f.schedule.requestedAt = f.schedule.receivedAt = new Date(now - 1000).toISOString();
  const beforeLunch = candle(f.identity, '1m', f.instant('2026-09-24', 11, 29));
  assert.equal(evaluateSessionCandles([beforeLunch], '1m', f.evidence, f.identity, now).reason, 'session_current_interval_minute_missing');
  const afterLunch = candle(f.identity, '1m', f.instant('2026-09-24', 12, 30));
  assert.equal(evaluateSessionCandles([beforeLunch, afterLunch], '1m', f.evidence, f.identity, now).reason, undefined);
  assert.equal(expectedSessionSlot('1h', f.schedule, now)?.end, f.instant('2026-09-24', 11, 30));
});
test('timezone aliases, nonhour offsets and distinct US/EU DST dates', () => {
  assert.equal(canonicalSessionTimeZone('US/Eastern'), canonicalSessionTimeZone('America/New_York'));
  assert.equal(new Date(sessionLocalTime('2026-03-20', 9, 30, 0, 'America/New_York')).toISOString(), '2026-03-20T13:30:00.000Z');
  assert.equal(new Date(sessionLocalTime('2026-03-20', 9, 0, 0, 'Europe/Warsaw')).toISOString(), '2026-03-20T08:00:00.000Z');
  assert.equal(new Date(sessionLocalTime('2026-03-30', 9, 0, 0, 'Europe/Warsaw')).toISOString(), '2026-03-30T07:00:00.000Z');
  assert.equal(new Date(sessionLocalTime('2026-09-24', 9, 15, 0, 'Asia/Kathmandu')).toISOString(), '2026-09-24T03:30:00.000Z');
  assert.throws(() => sessionLocalTime('2026-03-29', 2, 30, 0, 'Europe/Warsaw'), /dst_invalid/);
  assert.throws(() => sessionLocalTime('2026-10-25', 2, 30, 0, 'Europe/Warsaw'), /dst_invalid/);
  assert.throws(() => sessionLocalMidnight('2026-02-30', 'Europe/Warsaw'), /date_invalid/);
});
test('raw broker schedule correlates exact mode/identity and overnight reference dates', () => {
  const f = fixture('America/Chicago', 9, 0, { secType: 'FUT', useRTH: false });
  const raw = { startDateTime: '20260901-00:00:00', endDateTime: '20261001-00:00:00', timeZone: 'US/Central', sessions: [{ refDate: '20260924', startDateTime: '20260923-17:00:00', endDateTime: '20260924-16:00:00' }] };
  const s = parseBrokerSessionSchedule(raw, f.identity, f.schedule.requestedAt, f.schedule.receivedAt);
  assert.equal(s.sessions[0].date, '2026-09-24'); assert.equal(s.sessions[0].start, '2026-09-23T22:00:00.000Z');
  assert.throws(() => parseBrokerSessionSchedule({ ...raw, timeZone: 'Europe/Warsaw' }, f.identity, f.schedule.requestedAt, f.schedule.receivedAt), /timezone/);
});
for (const field of ['conId', 'instrumentId', 'symbol', 'secType', 'exchange', 'currency', 'localSymbol', 'tradingClass', 'primaryExchange', 'useRTH', 'timeZone'] as const) test(`wrong ${field} is not interchangeable calendar evidence`, () => {
  const f = fixture(); const identity = { ...f.identity, [field]: field === 'conId' ? 111 : field === 'useRTH' ? false : field === 'timeZone' ? 'UTC' : 'WRONG' };
  assert.throws(() => requireSessionSchedule(f.evidence, identity, f.now), /identity/);
});
test('stale/future/failed/generationless/incomplete calendar cannot authorize', () => {
  const f = fixture();
  assert.throws(() => requireSessionSchedule({ ...f.evidence, status: 'FAILED' }, f.identity, f.now), /unavailable/);
  assert.throws(() => requireSessionSchedule({ ...f.evidence, generation: 0 }, f.identity, f.now), /unavailable/);
  assert.throws(() => requireSessionSchedule(f.evidence, f.identity, f.now + 7 * 3600000), /stale/);
  assert.throws(() => requireSessionSchedule(f.evidence, f.identity, f.now - 20000), /stale/);
  f.schedule.coverageStart = f.instant('2026-09-14', 0); f.schedule.sessions = f.schedule.sessions.filter(x => Date.parse(x.start) >= Date.parse(f.schedule.coverageStart));
  assert.throws(() => requireSessionSchedule(f.evidence, f.identity, f.now), /coverage_missing/);
});
test('overlap, bad OHLC, duplicate bars, wrong mode provenance and invalid alignment refuse', () => {
  const f = fixture(); const slot = expectedSessionSlot('1m', f.schedule, f.now)!, row = candle(f.identity, '1m', slot.start);
  assert.throws(() => filterClosedSessionCandles([row, row], '1m', f.schedule, f.now), /duplicate/);
  assert.throws(() => filterClosedSessionCandles([{ ...row, high: 50 }], '1m', f.schedule, f.now), /values_invalid/);
  assert.throws(() => filterClosedSessionCandles([{ ...row, source: 'ibkr_session_full_native_v1' }], '1m', f.schedule, f.now), /identity_invalid/);
  assert.throws(() => filterClosedSessionCandles([{ ...row, ts: new Date(row.ts.getTime() + 1) }], '1m', f.schedule, f.now), /alignment/);
  f.schedule.sessions.splice(1, 0, { ...f.schedule.sessions[0] });
  assert.throws(() => requireSessionSchedule(f.evidence, f.identity, f.now), /intervals_invalid/);
});
test('unknown MIDPOINT volume remains unknown and negative futures prices are finite data', () => {
  const f = fixture('UTC', 9, 0, { secType: 'CASH', useRTH: false }), slot = expectedSessionSlot('1m', f.schedule, f.now)!;
  const row = candle(f.identity, '1m', slot.start, -1);
  assert.equal(filterClosedSessionCandles([row], '1m', f.schedule, f.now)[0].volume, -1);
  const negative = { ...row, open: -4, close: -3, low: -5, high: -2 };
  assert.equal(filterClosedSessionCandles([negative], '1m', f.schedule, f.now).length, 1);
});
test('window must fit one active interval and cache cannot hide changed session', () => {
  const f = fixture(); checkSessionWindow(f.evidence, f.identity, f.now, f.now, f.now + 1200000);
  assert.throws(() => checkSessionWindow(f.evidence, f.identity, f.now, f.now, f.now + 86400000), /window_invalid/);
  const before = expectedSessionSlot('4h', f.schedule, f.now)!;
  f.schedule.sessions.find(x => x.date === '2026-09-23')!.end = f.instant('2026-09-23', 12);
  const after = expectedSessionSlot('4h', f.schedule, f.now)!;
  assert.notEqual(before.end, after.end);
});
test('identity builder refuses wrong logical contract', async () => {
  const { defaultInstrumentRegistry, buildInstrumentBindingAuthority } = await import('./index.js');
  const i = defaultInstrumentRegistry.getInstrumentOrThrow('pko_wse');
  const a = buildInstrumentBindingAuthority(JSON.stringify([{ instrumentId: i.id, conId: 35146360, localSymbol: 'PKO', tradingClass: 'PKO', exchange: 'WSE', currency: 'PLN', minTick: 0.0001 }]), defaultInstrumentRegistry);
  assert.equal(a.ok, true); if (!a.ok) return;
  const b = a.authority.getBoundInstrument(i.id)!;
  assert.equal(buildInstrumentSessionIdentity(i, b).symbol, 'PKO');
  assert.throws(() => buildInstrumentSessionIdentity(i, { ...b, brokerSymbol: 'OTHER' }), /binding/);
});

test('after-hours history prewarm does not authorize context or extend broker coverage', () => {
  const f = fixture();
  f.schedule.sessions = f.schedule.sessions.filter(x => x.date <= '2026-09-24');
  f.schedule.coverageEnd = f.schedule.sessions.at(-1)!.end;
  const now = Date.parse(f.instant('2026-09-24', 22));
  f.evidence.updatedAt = f.schedule.requestedAt = f.schedule.receivedAt = new Date(now - 1000).toISOString();
  assert.equal(requireSessionHistorySchedule(f.evidence, f.identity, now).coverageEnd, f.schedule.coverageEnd);
  assert.throws(() => requireSessionSchedule(f.evidence, f.identity, now), /coverage_missing/);
  assert.throws(() => checkSessionWindow(f.evidence, f.identity, now, now, now + 60000), /coverage_missing/);
});


test('weekly Friday and Saturday native labels identify one closed period without relabeling', () => {
  const f = fixture(), expected = expectedSessionSlot('1w', f.schedule, f.now)!;
  assert.equal(expected.start, f.instant('2026-09-18', 0));
  assert.deepEqual(expected.alternativeStarts, [f.instant('2026-09-19', 0)]);
  assert.equal(expected.end, f.instant('2026-09-21', 0));
  for (const label of [expected.start, ...expected.alternativeStarts!]) {
    const row = candle(f.identity, '1w', label);
    assert.equal(matchesSessionSlot(label, expected), true);
    const result = evaluateSessionCandles([row], '1w', f.evidence, f.identity, f.now);
    assert.equal(result.reason, undefined);
    assert.equal(result.latestEnd, expected.end);
    assert.equal(result.latestStart, label);
    assert.equal(result.candles[0].ts.toISOString(), label);
  }
  assert.equal(matchesSessionSlot(f.instant('2026-09-20', 0), expected), false);
});

test('weekly holiday Thursday close accepts Friday midnight alias only for that proven period', () => {
  const f = fixture();
  f.schedule.sessions = f.schedule.sessions.filter(x => x.date !== '2026-09-18');
  const slot = expectedSessionSlot('1w', f.schedule, f.now)!;
  assert.equal(slot.start, f.instant('2026-09-17', 0));
  assert.deepEqual(slot.alternativeStarts, [f.instant('2026-09-18', 0)]);
  assert.equal(slot.end, f.instant('2026-09-21', 0));
  assert.equal(evaluateSessionCandles([candle(f.identity, '1w', slot.alternativeStarts![0])], '1w', f.evidence, f.identity, f.now).reason, undefined);
  assert.throws(() => filterClosedSessionCandles([candle(f.identity, '1w', f.instant('2026-09-19', 0))], '1w', f.schedule, f.now), /alignment_invalid/);
});

test('two native weekly aliases never inflate history counts, including older unambiguous weeks', () => {
  const f = fixture(), slot = expectedSessionSlot('1w', f.schedule, f.now)!;
  for (const labels of [[slot.start, slot.alternativeStarts![0]], [f.instant('2026-08-21', 0), f.instant('2026-08-22', 0)]]) {
    for (const order of [labels, [...labels].reverse()]) {
      assert.throws(() => filterClosedSessionCandles(order.map(label => candle(f.identity, '1w', label)), '1w', f.schedule, f.now), /duplicate_period/);
    }
  }
});

test('Sunday-to-Monday alias that matches another calendar period is ambiguous', () => {
  const f = fixture();
  f.schedule.sessions.push({ date: '2026-09-20', start: f.instant('2026-09-20', 9), end: f.instant('2026-09-20', 16) });
  f.schedule.sessions = f.schedule.sessions.filter(x => x.date < '2026-09-22' || x.date > '2026-09-25').sort((a,b) => a.start.localeCompare(b.start));
  const labels = sessionCandleSlots(f.schedule, '1w').filter(slot => matchesSessionSlot(f.instant('2026-09-21', 0), slot));
  assert.equal(labels.length, 2);
  assert.throws(() => filterClosedSessionCandles([candle(f.identity, '1w', f.instant('2026-09-21', 0))], '1w', f.schedule, f.now), /weekly_label_ambiguous/);
});

test('old Monday labels lacking calendar proof cannot be assigned to either adjacent week', () => {
  const f = fixture();
  assert.throws(() => filterClosedSessionCandles([candle(f.identity, '1w', f.instant('2026-08-24', 0))], '1w', f.schedule, f.now), /weekly_label_ambiguous/);
});

test('provisional current-week labels stay excluded until Monday even if a label matches the final slot', () => {
  const f = fixture(), current = sessionCandleSlots(f.schedule, '1w').find(x => x.start === f.instant('2026-09-25', 0))!;
  const partial = candle(f.identity, '1w', f.instant('2026-09-24', 0));
  const canonical = candle(f.identity, '1w', current.start), alias = candle(f.identity, '1w', current.alternativeStarts![0]);
  for (const row of [partial, canonical, alias]) {
    assert.deepEqual(filterClosedSessionCandles([row], '1w', f.schedule, f.now), []);
    assert.deepEqual(filterClosedSessionCandles([row], '1w', f.schedule, Date.parse(current.end) - 1), []);
  }
  for (const row of [canonical, alias]) assert.equal(filterClosedSessionCandles([row], '1w', f.schedule, Date.parse(current.end))[0].ts.toISOString(), row.ts.toISOString());
  assert.throws(() => filterClosedSessionCandles([partial], '1w', f.schedule, Date.parse(current.end)), /alignment_invalid/);
});

test('weekly alias and Monday finality use local dates across DST instead of fixed-day durations', () => {
  const f = fixture();
  f.schedule.coverageStart = f.instant('2026-10-01', 0); f.schedule.coverageEnd = f.instant('2026-11-10', 0);
  f.schedule.sessions = ['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23'].map(date => ({ date, start: f.instant(date, 9), end: f.instant(date, 16) }));
  const slot = sessionCandleSlots(f.schedule, '1w')[0];
  assert.equal(slot.start, '2026-10-22T22:00:00.000Z');
  assert.equal(slot.alternativeStarts![0], '2026-10-23T22:00:00.000Z');
  assert.equal(slot.end, '2026-10-25T23:00:00.000Z');
  const row = candle(f.identity, '1w', slot.alternativeStarts![0]);
  assert.deepEqual(filterClosedSessionCandles([row], '1w', f.schedule, Date.parse(slot.end) - 1), []);
  assert.equal(filterClosedSessionCandles([row], '1w', f.schedule, Date.parse(slot.end)).length, 1);
});
