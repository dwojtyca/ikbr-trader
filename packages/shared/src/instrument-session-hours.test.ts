import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySessionAvailability, parseBrokerContractSessionHours, requireSessionSchedule, type InstrumentSessionIdentity, type SessionScheduleEvidence } from './instrument-sessions.js';
const identity: InstrumentSessionIdentity = { instrumentId: 'aapl', conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', primaryExchange: 'NASDAQ', currency: 'USD', useRTH: true, timeZone: 'America/New_York' };
function fixture(now: string, hours = '20261013:0930-20261013:1600') {
  const stamp = new Date(Date.parse(now) - 1000).toISOString();
  const currentHours = parseBrokerContractSessionHours({ timeZoneId: 'US/Eastern', liquidHours: hours }, identity, stamp, stamp);
  const evidence: SessionScheduleEvidence = { generation: 1, status: 'READY', updatedAt: stamp, schedule: {
    source: 'ibkr_session_schedule_v1', identity, coverageStart: '2026-09-20T00:00:00.000Z', coverageEnd: '2026-10-12T20:00:00.000Z', requestedAt: stamp, receivedAt: stamp,
    sessions: [{ date: '2026-10-12', start: '2026-10-12T13:30:00.000Z', end: '2026-10-12T20:00:00.000Z' }], currentHours } };
  return { evidence, now: Date.parse(now) };
}
for (const [now, kind] of [['2026-10-13T12:00:00Z', 'CLOSED'], ['2026-10-13T13:30:00Z', 'OPEN'], ['2026-10-13T19:59:59Z', 'OPEN'], ['2026-10-13T20:00:00Z', 'CLOSED']])
  test(`day session inclusive open/exclusive close at ${now}`, () => {
    const f = fixture(now); assert.equal(classifySessionAvailability(f.evidence, identity, f.now).kind, kind);
    assert.throws(() => requireSessionSchedule(f.evidence, identity, f.now), /coverage_missing/);
  });
for (const [now, hours, kind] of [
  ['2026-10-13T16:30:00Z', '20261013:0930-1200,1300-1600', 'CLOSED'],
  ['2026-10-13T17:00:00Z', '20261013:0930-1200,1300-1600', 'OPEN'],
  ['2026-10-13T18:00:00Z', '20261013:0930-1300', 'CLOSED'],
  ['2026-10-17T16:00:00Z', '20261017:CLOSED', 'CLOSED'],
  ['2026-10-13T16:00:00Z', '20261014:CLOSED', 'UNKNOWN'],
  ['2026-11-02T14:29:59Z', '20261102:0930-1600', 'CLOSED'],
  ['2026-11-02T14:30:00Z', '20261102:0930-1600', 'OPEN'],
]) test(`explicit dates, gaps, early close and DST: ${hours} ${now}`, () => {
  const f = fixture(now, hours); assert.equal(classifySessionAvailability(f.evidence, identity, f.now).kind, kind);
});
for (const hours of ['20261013:', '20261013:CLOSED;20261013:CLOSED', '20261013:0930-1200,1100-1600', '20260230:CLOSED', '20261013:2300-20261014:0400', '20261101:0130-0230', '20260308:0230-0330', '20261013:930-1600'])
  test(`invalid or unsupported hours reject: ${hours}`, () => {
    assert.throws(() => parseBrokerContractSessionHours({ timeZoneId: 'US/Eastern', liquidHours: hours }, identity, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'));
  });
test('RTH never uses tradingHours and canonical timezone must agree', () => {
  assert.throws(() => parseBrokerContractSessionHours({ timeZoneId: 'US/Eastern', tradingHours: '20261013:CLOSED' }, identity, 'x', 'x'));
  assert.throws(() => parseBrokerContractSessionHours({ timeZoneId: 'Europe/Warsaw', liquidHours: '20261013:CLOSED' }, identity, 'x', 'x'));
  const f = fixture('2026-10-13T12:00:00Z');
  const hours = parseBrokerContractSessionHours({ timeZoneId: 'US/Eastern', tradingHours: '20261013:0400-2000', liquidHours: '20261013:CLOSED' }, { ...identity, useRTH: false }, f.evidence.updatedAt, f.evidence.updatedAt);
  assert.equal(hours.days[0].intervals.length, 1);
});
for (const mutation of ['stale', 'future', 'failed', 'refreshing', 'generation', 'identity', 'mode', 'zone', 'corrupt', 'hours-stale', 'hours-future', 'hours-request', 'missing-hours', 'null-hours'] as const)
  test(`unavailable evidence never proves closed: ${mutation}`, () => {
    const f = fixture('2026-10-13T12:00:00Z'), s = f.evidence.schedule!, h = s.currentHours!;
    if (mutation === 'stale') f.now += 7 * 3600000;
    if (mutation === 'future') f.evidence.updatedAt = '2026-10-13T12:01:00.000Z';
    if (mutation === 'failed') f.evidence.status = 'FAILED';
    if (mutation === 'refreshing') f.evidence.status = 'REFRESHING';
    if (mutation === 'generation') f.evidence.generation = 0;
    if (mutation === 'identity') h.identity.conId++;
    if (mutation === 'mode') h.identity.useRTH = false;
    if (mutation === 'zone') h.identity.timeZone = 'Europe/Warsaw';
    if (mutation === 'corrupt') h.days[0].intervals[0].start = 'bad';
    if (mutation === 'hours-stale') h.receivedAt = h.requestedAt = '2026-10-13T00:00:00.000Z';
    if (mutation === 'hours-future') h.receivedAt = '2026-10-13T12:01:00.000Z';
    if (mutation === 'hours-request') h.requestedAt = '2026-10-13T12:01:00.000Z';
    if (mutation === 'missing-hours') delete s.currentHours;
    if (mutation === 'null-hours') s.currentHours = null as never;
    assert.equal(classifySessionAvailability(f.evidence, identity, f.now).kind, 'UNKNOWN');
  });
test('legacy schedule with genuine current coverage retains strict historical fallback', () => {
  const f = fixture('2026-10-13T12:00:00Z'); delete f.evidence.schedule!.currentHours;
  f.evidence.schedule!.coverageEnd = '2026-10-14T00:00:00.000Z';
  assert.equal(classifySessionAvailability(f.evidence, identity, f.now).kind, 'CLOSED');
  f.evidence.schedule!.sessions.push({ date: '2026-10-13', start: '2026-10-13T11:00:00.000Z', end: '2026-10-13T20:00:00.000Z' });
  assert.equal(classifySessionAvailability(f.evidence, identity, f.now).kind, 'OPEN');
});
test('Warsaw local-date classification uses its own regular hours', () => {
  const f = fixture('2026-10-13T12:00:00Z');
  const warsaw = { ...identity, instrumentId: 'pko', conId: 35146360, symbol: 'PKO', exchange: 'WSE', primaryExchange: undefined, currency: 'PLN', timeZone: 'Europe/Warsaw' };
  f.evidence.schedule!.identity = warsaw;
  f.evidence.schedule!.currentHours = parseBrokerContractSessionHours({ timeZoneId: 'Poland', liquidHours: '20261013:0900-1705' }, warsaw, f.evidence.updatedAt, f.evidence.updatedAt);
  assert.equal(classifySessionAvailability(f.evidence, warsaw, f.now).kind, 'OPEN');
});

test('receipt later than database update is not trusted closure evidence', () => {
  const f = fixture('2026-10-13T12:00:00Z');
  f.evidence.updatedAt = '2026-10-13T11:00:00.000Z';
  assert.equal(classifySessionAvailability(f.evidence,identity,f.now).kind,'UNKNOWN');
});
test('availability carries the observed clock and exact active interval end', () => {
  const f = fixture('2026-10-13T14:00:00Z');
  const result = classifySessionAvailability(f.evidence,identity,f.now);
  assert.equal(result.checkedAt,f.now);assert.equal(result.activeIntervalEnd,Date.parse('2026-10-13T20:00:00Z'));
});
