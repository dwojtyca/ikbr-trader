import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from './index.js';
import { AAPL_NATIVE_SOURCE, newYorkMidnight, type AaplTimeframe } from './aapl-candles.js';
import { aaplExpectedSlot, checkAaplSessionWindow, evaluateAaplCandles, filterClosedAaplCandles, parseBrokerAaplSchedule, requireAaplSchedule, type AaplSchedule, type AaplScheduleEvidence } from './aapl-sessions.js';
function schedule(date = '2026-09-24', omit: string[] = [], close = '16:00:00'): AaplSchedule {
  const today = new Date(`${date}T12:00:00Z`), start = new Date(today); start.setUTCDate(start.getUTCDate() - 20);
  const sessions = [];
  for (const d = new Date(start); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const ref = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || omit.includes(ref)) continue;
    const compact = ref.replaceAll('-', ''); sessions.push({ refDate: compact, startDateTime: `${compact}-09:30:00`, endDateTime: `${compact}-${ref === date ? close : '16:00:00'}` });
  }
  const end = new Date(today); end.setUTCDate(end.getUTCDate() + 1);
  return parseBrokerAaplSchedule({ startDateTime: `${start.toISOString().slice(0, 10).replaceAll('-', '')}-00:00:00`, endDateTime: `${end.toISOString().slice(0, 10).replaceAll('-', '')}-00:00:00`, timeZone: 'US/Eastern', sessions }, `${date}T12:00:00.000Z`, `${date}T12:00:00.000Z`);
}
const evidence = (s: AaplSchedule): AaplScheduleEvidence => ({ generation: 1, status: 'READY', updatedAt: s.receivedAt, schedule: s });
const row = (start: string, tf: AaplTimeframe): Candle => ({ symbol: 'AAPL', conid: '265598', source: AAPL_NATIVE_SOURCE, timeframe: tf, ts: new Date(start), open: 100, high: 101, low: 99, close: 100, volume: 1 });
const s = schedule(), e = evidence(s);
test('opening needs completed current minute, while higher frames use terminal previous session', () => {
  assert.equal(evaluateAaplCandles([row('2026-09-23T19:59:00Z', '1m')], '1m', e, Date.parse('2026-09-24T13:30:59Z')).reason, 'aapl_current_session_minute_missing');
  assert.equal(evaluateAaplCandles([row('2026-09-24T13:30:00Z', '1m')], '1m', e, Date.parse('2026-09-24T13:31:00Z')).reason, undefined);
  for (const [tf, start] of [['5m', '19:55'], ['1h', '19:00'], ['4h', '16:00']] as const) {
    const result = evaluateAaplCandles([row(`2026-09-23T${start}:00Z`, tf)], tf, e, Date.parse('2026-09-24T13:31:00Z'));
    assert.equal(result.reason, undefined); assert.equal(result.expectedEnd, '2026-09-23T20:00:00.000Z');
  }
});
for (const [tf, prior, boundary] of [['5m', '19:55', '13:35'], ['1h', '19:00', '14:00'], ['4h', '16:00', '16:00']] as const) test(`${tf} lattice transition exact boundary and bounded publication grace`, () => {
  const old = row(`2026-09-23T${prior}:00Z`, tf), current = row('2026-09-24T13:30:00Z', tf), at = Date.parse(`2026-09-24T${boundary}:00Z`);
  assert.equal(filterClosedAaplCandles([current], tf, s, at - 1).length, 0);
  assert.equal(filterClosedAaplCandles([current], tf, s, at).length, 1);
  assert.equal(evaluateAaplCandles([old], tf, e, at + 90000).reason, undefined);
  assert.equal(evaluateAaplCandles([old], tf, e, at + 90001).reason, 'aapl_expected_candle_missing');
  assert.equal(evaluateAaplCandles([old, current], tf, e, at).reason, undefined);
});
test('missing terminal previous slot is refused even though a prior same-day bar exists', () => {
  assert.equal(evaluateAaplCandles([row('2026-09-23T13:30:00Z', '4h')], '4h', e, Date.parse('2026-09-24T13:31:00Z')).reason, 'aapl_expected_candle_missing');
});
test('unsupported recent broker alignment blocks, never silently discards valid OHLC', () => {
  assert.throws(() => filterClosedAaplCandles([row('2026-09-24T17:30:00Z', '4h')], '4h', s, Date.parse('2026-09-24T20:00:00Z')), /alignment/);
});
test('wrong source, identity and invalid OHLC cannot satisfy freshness', () => {
  const c = row('2026-09-24T13:30:00Z', '1m'), now = Date.parse('2026-09-24T13:31:00Z');
  for (const patch of [{ source: 'legacy' }, { conid: '1' }, { symbol: 'OTHER' }, { high: 99 }, { volume: NaN }])
    assert.ok(evaluateAaplCandles([{ ...c, ...patch }], '1m', e, now).reason);
});
test('Monday and authoritative omitted holiday use exact previous trading session', () => {
  const holiday = schedule('2026-09-08', ['2026-09-07']);
  const result = evaluateAaplCandles([row('2026-09-04T16:00:00Z', '4h')], '4h', evidence(holiday), Date.parse('2026-09-08T13:31:00Z'));
  assert.equal(result.reason, undefined);
  const mon = schedule('2026-09-28');
  assert.equal(aaplExpectedSlot('4h', mon, Date.parse('2026-09-28T13:31:00Z'))?.start, '2026-09-25T16:00:00.000Z');
});
test('early close clips last 4h bucket, never admits it one millisecond early', () => {
  const short = schedule('2026-11-27', ['2026-11-26'], '13:00:00'), c = row('2026-11-27T16:00:00Z', '4h');
  assert.equal(filterClosedAaplCandles([c], '4h', short, Date.parse('2026-11-27T17:59:59.999Z')).length, 0);
  assert.equal(filterClosedAaplCandles([c], '4h', short, Date.parse('2026-11-27T18:00:00Z')).length, 1);
  assert.equal(evaluateAaplCandles([c], '4h', evidence(short), Date.parse('2026-11-27T18:00:00Z')).reason, 'aapl_session_closed');
});
for (const [date, utc] of [['2026-03-09', '13:31'], ['2026-10-26', '13:31'], ['2026-11-02', '14:31']] as const) test(`New York clock works across DST including differing European transition: ${date}`, () => {
  const calendar = schedule(date), now = Date.parse(`${date}T${utc}:00Z`), candle = row(new Date(now - 60000).toISOString(), '1m');
  assert.equal(evaluateAaplCandles([candle], '1m', evidence(calendar), now).reason, undefined);
  const opening4h = { ...candle, timeframe: '4h' as const };
  assert.equal(filterClosedAaplCandles([opening4h], '4h', calendar, Date.parse(`${date}T15:59:59.999Z`)).length, 0);
  assert.equal(filterClosedAaplCandles([opening4h], '4h', calendar, Date.parse(`${date}T16:00:00Z`)).length, 1);
});
test('daily and weekly retain midnight finality with Friday labeling and holiday selection', () => {
  const now = Date.parse('2026-09-24T13:31:00Z');
  assert.equal(evaluateAaplCandles([row('2026-09-23T04:00:00Z', '1d')], '1d', e, now).reason, undefined);
  assert.equal(evaluateAaplCandles([row('2026-09-18T04:00:00Z', '1w')], '1w', e, now).reason, undefined);
  assert.ok(evaluateAaplCandles([row('2026-09-11T04:00:00Z', '1w')], '1w', e, now).reason);
  const holiday = schedule('2026-09-08', ['2026-09-07']);
  assert.equal(evaluateAaplCandles([row('2026-09-04T04:00:00Z', '1d')], '1d', evidence(holiday), Date.parse('2026-09-08T13:31:00Z')).reason, undefined);
  const currentWeek = row('2026-09-25T04:00:00Z', '1w');
  assert.equal(filterClosedAaplCandles([currentWeek], '1w', s, now).length, 0);
});
test('older native history keeps existing conservative validation without fabricated calendar', () => {
  const older = row('2026-08-21T04:00:00Z', '1w');
  assert.equal(filterClosedAaplCandles([older], '1w', s, Date.parse('2026-09-24T13:31:00Z')).length, 1);
});
test('schedule malformed identity, stale proof, failed generation and insufficient coverage fail closed', () => {
  const now = Date.parse('2026-09-24T13:31:00Z');
  for (const value of [null, { ...e, generation: -1 }, { ...e, status: 'FAILED' as const }, { ...e, status: 'REFRESHING' as const }, { ...e, schedule: { ...s, conId: 1 } }, { ...e, schedule: { ...s, coverageStart: '2026-09-23T04:00:00.000Z', sessions: s.sessions.slice(-2) } }])
    assert.throws(() => requireAaplSchedule(value as AaplScheduleEvidence, now));
  assert.throws(() => requireAaplSchedule(e, Date.parse('2026-09-24T18:00:00.001Z')), /stale/);
  assert.throws(() => requireAaplSchedule({ ...e, schedule: { ...s, sessions: [...s.sessions].reverse() } }, now), /sessions/);
});
test('parser rejects calendar rollover, unknown timezone, DST nonexistent/ambiguous local instants and refDate mismatch', () => {
  const raw = { startDateTime: '20260901-00:00:00', endDateTime: '20260925-00:00:00', timeZone: 'US/Eastern', sessions: [{ refDate: '20260924', startDateTime: '20260924-09:30:00', endDateTime: '20260924-16:00:00' }] };
  for (const patch of [{ timeZone: 'UTC' }, { startDateTime: '20260230-00:00:00' }, { startDateTime: '20260308-02:30:00' }, { startDateTime: '20261101-01:30:00' }, { sessions: [{ ...raw.sessions[0], refDate: '20260923' }] }, { sessions: [...raw.sessions, ...raw.sessions] }])
    assert.throws(() => parseBrokerAaplSchedule({ ...raw, ...patch }, s.requestedAt, s.receivedAt));
});
test('entry window requires current active authoritative session and never crosses early close', () => {
  const now = Date.parse('2026-09-24T13:31:00Z');
  checkAaplSessionWindow(e, now, Date.parse('2026-09-24T13:30:00Z'), Date.parse('2026-09-24T14:30:00Z'));
  assert.throws(() => checkAaplSessionWindow(e, now, now, Date.parse('2026-09-24T20:01:00Z')));
  assert.throws(() => checkAaplSessionWindow(e, Date.parse('2026-09-24T13:29:00Z'), now, now + 60000));
  assert.equal(newYorkMidnight(2026, 9, 24).toISOString(), '2026-09-24T04:00:00.000Z');
});
test('partially covered first week retains conservative old history and partial current week is discarded', () => {
  const partial = { ...s, coverageStart: '2026-09-09T04:00:00.000Z', sessions: s.sessions.filter(x => x.date >= '2026-09-09') };
  const now = Date.parse('2026-09-24T13:31:00Z');
  assert.equal(filterClosedAaplCandles([row('2026-09-11T04:00:00Z', '1w')], '1w', partial, now).length, 1);
  assert.equal(filterClosedAaplCandles([row('2026-09-24T04:00:00Z', '1w')], '1w', s, now).length, 0);
});
test('pre-open evaluation retains warmed closed rows and expected slots while refusing entries', () => {
  const result = evaluateAaplCandles([row('2026-09-23T16:00:00Z', '4h')], '4h', e, Date.parse('2026-09-24T13:00:00Z'));
  assert.equal(result.reason, 'aapl_session_closed');
  assert.equal(result.candles.length, 1);
  assert.equal(result.expectedStart, '2026-09-23T16:00:00.000Z');
  assert.equal(result.latestEnd, '2026-09-23T20:00:00.000Z');
  assert.throws(() => requireAaplSchedule({ ...e, generation: 0 }, Date.parse('2026-09-24T13:00:00Z')));
});


test('observed IBKR winter 4h UTC starts and early-close sample stay on the UTC lattice', () => {
  const winter = schedule('2026-01-08');
  const expected = [['2026-01-08T14:30:00Z','2026-01-08T16:00:00Z'],['2026-01-08T16:00:00Z','2026-01-08T20:00:00Z'],['2026-01-08T20:00:00Z','2026-01-08T21:00:00Z']];
  for (const [start,end] of expected) {
    assert.equal(filterClosedAaplCandles([row(start,'4h')],'4h',winter,Date.parse(end)-1).length,0);
    assert.equal(filterClosedAaplCandles([row(start,'4h')],'4h',winter,Date.parse(end)).length,1);
  }
  const early = schedule('2025-11-28',['2025-11-27'],'13:00:00');
  for (const [start,end] of [['2025-11-28T14:30:00Z','2025-11-28T16:00:00Z'],['2025-11-28T16:00:00Z','2025-11-28T18:00:00Z']]) {
    assert.equal(filterClosedAaplCandles([row(start,'4h')],'4h',early,Date.parse(end)-1).length,0);
    assert.equal(filterClosedAaplCandles([row(start,'4h')],'4h',early,Date.parse(end)).length,1);
  }
  assert.throws(()=>filterClosedAaplCandles([row('2026-01-08T17:00:00Z','4h')],'4h',winter,Date.parse('2026-01-08T21:00:00Z')),/alignment/);
});
test('Good Friday weekly bar uses observed Thursday label and completes the following Monday', () => {
  const afterHoliday = schedule('2026-04-06',['2026-04-03']);
  const now=Date.parse('2026-04-06T13:31:00Z');
  assert.equal(evaluateAaplCandles([row('2026-04-02T04:00:00Z','1w')],'1w',evidence(afterHoliday),now).reason,undefined);
  assert.equal(aaplExpectedSlot('1w',afterHoliday,now)?.start,'2026-04-02T04:00:00.000Z');
  assert.throws(()=>filterClosedAaplCandles([row('2026-04-03T04:00:00Z','1w')],'1w',afterHoliday,now),/alignment/);
});
