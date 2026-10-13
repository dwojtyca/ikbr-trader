import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SessionScheduleAdapter } from './session-schedule-adapter.js';
import { sessionIdentityFixture } from './session-fixture.js';
class Fake extends EventEmitter {
  serverVersion = 180;
  contract: Record<string, unknown> = { conId: 1234567, symbol: 'XYZ', localSymbol: 'XYZ', tradingClass: 'NMS', secType: 'STK', exchange: 'SMART', primaryExch: 'NASDAQ', currency: 'USD' };
  requests: unknown[][] = []; disconnected = false; cancelled: number[] = [];
  hours: Record<string,unknown> = { timeZoneId: 'US/Eastern', liquidHours: '20260924:0930-20260924:1600', tradingHours: '20260924:0400-20260924:2000' };
  hang = false; duplicate = false; wrongTimezone = false; error = false; throwOnSend = false;
  connect() { queueMicrotask(() => this.emit('nextValidId', 1)); }
  disconnect() { this.disconnected = true; this.emit('disconnected'); }
  reqContractDetails(id: number) { queueMicrotask(() => {
    this.emit('contractDetails', id + 1, { contract: {} });
    this.emit('contractDetails', id, { contract: this.contract, ...this.hours });
    if (this.duplicate) this.emit('contractDetails', id, { contract: this.contract, ...this.hours });
    this.emit('contractDetailsEnd', id);
  }); }
  reqHistoricalData(...args: unknown[]) { this.requests.push(args); if (this.throwOnSend) throw new Error('send failed'); queueMicrotask(() => {
    if (this.hang) return;
    if (this.error) { this.emit('error', new Error('fixture'), 162, args[0]); return; }
    const session = { refDate: '20260924', startDateTime: '20260924-09:30:00', endDateTime: '20260924-16:00:00' };
    this.emit('historicalSchedule', 999, 'bad', 'bad', 'bad', []);
    this.emit('historicalSchedule', args[0], session.startDateTime, session.endDateTime, this.wrongTimezone ? 'Europe/Warsaw' : 'US/Eastern', [session]);
  }); }
  cancelHistoricalData(id: number) { this.cancelled.push(id); }
}
const options = { host: 'unused', port: 0, clientId: 156, now: () => Date.parse('2026-09-24T18:00:00Z') };
test('schedule production adapter waits for pacing, exact contract completion and correlated SCHEDULE envelope', async () => {
  const ib = new Fake(); let paced = false;
  const adapter = new SessionScheduleAdapter({ ...options, socket: () => { assert.equal(paced, true); return ib; }, acquirePacing: async () => { paced = true; } });
  const result = await adapter.fetch(sessionIdentityFixture());
  assert.equal(result.currentHours?.source, 'ibkr_contract_hours_v1'); assert.equal(result.currentHours?.days[0].intervals[0].start, '2026-09-24T13:30:00.000Z');
  assert.equal(result.identity.conId, 1234567); assert.equal(result.identity.timeZone, 'America/New_York');
  assert.deepEqual(ib.requests[0].slice(2), ['', '14 D', '1 day', 'SCHEDULE', true, 1, false]);
  ib.emit("error", new Error("late retired socket error"));
  assert.equal(ib.disconnected, true); assert.deepEqual(ib.eventNames(), ["error"]); assert.equal(ib.listenerCount("error"), 1); assert.deepEqual(ib.cancelled, []);
});
for (const failure of ['server', 'missing-server', 'identity', 'duplicate', 'timezone', 'error', 'timeout'] as const)
  test(`schedule adapter fails closed and removes listeners: ${failure}`, async () => {
    const ib = new Fake();
    if (failure === 'server') ib.serverVersion = 164;
    if (failure === 'missing-server') ib.serverVersion = NaN;
    if (failure === 'identity') ib.contract.currency = 'PLN';
    if (failure === 'duplicate') ib.duplicate = true;
    if (failure === 'timezone') ib.wrongTimezone = true;
    if (failure === 'error') ib.error = true;
    if (failure === 'timeout') ib.hang = true;
    const adapter = new SessionScheduleAdapter({ ...options, socket: () => ib, acquirePacing: async () => {}, timeoutMs: 20 });
    await assert.rejects(adapter.fetch(sessionIdentityFixture()), /session_schedule/);
    ib.emit("error", new Error("late retired socket error"));
    assert.equal(ib.disconnected, true); assert.deepEqual(ib.eventNames(), ["error"]); assert.equal(ib.listenerCount("error"), 1);
    if (['server', 'missing-server', 'identity', 'duplicate'].includes(failure)) assert.equal(ib.requests.length, 0);
    assert.deepEqual(ib.cancelled, ['error', 'timeout'].includes(failure) ? [91002] : []);
  });
test('synchronous schedule send failure cancels unfinished history once and retires socket', async () => {
  const ib = new Fake(); ib.throwOnSend = true;
  const adapter = new SessionScheduleAdapter({ ...options, socket: () => ib, acquirePacing: async () => {} });
  await assert.rejects(adapter.fetch(sessionIdentityFixture()), /session_schedule_request_failed/);
  assert.deepEqual(ib.cancelled, [91002]); assert.equal(ib.disconnected, true);
  assert.deepEqual(ib.eventNames(), ['error']);
  ib.emit('historicalSchedule', 91002, 'late', 'late', 'late', []);
  assert.deepEqual(ib.cancelled, [91002]);
});

test('generic schedule preserves full-session mode and exact arbitrary futures identity', async () => {
  const identity = sessionIdentityFixture({ instrumentId: 'future', conId: 888, symbol: 'GC', secType: 'FUT', exchange: 'COMEX',
    localSymbol: 'GCZ6', tradingClass: 'GC', primaryExchange: undefined, useRTH: false });
  const ib = new Fake(); ib.contract = { conId: identity.conId, symbol: identity.symbol, secType: identity.secType,
    exchange: identity.exchange, localSymbol: identity.localSymbol, tradingClass: identity.tradingClass, currency: identity.currency };
  const adapter = new SessionScheduleAdapter({ ...options, socket: () => ib, acquirePacing: async () => {} });
  const result = await adapter.fetch(identity); assert.equal(result.identity.useRTH, false); assert.equal(ib.requests[0][6], false);
});
test('shared SDK client id is serialized even when callers submit two contracts concurrently', async () => {
  let active = 0, maximum = 0;
  const adapter = new SessionScheduleAdapter({ ...options, socket: () => {
    const ib = new Fake(); const disconnect = ib.disconnect.bind(ib); active++; maximum = Math.max(maximum, active);
    ib.disconnect = () => { active--; disconnect(); }; return ib;
  }, acquirePacing: async () => {} });
  await Promise.all([adapter.fetch(sessionIdentityFixture()), adapter.fetch(sessionIdentityFixture())]);
  assert.equal(maximum, 1); assert.equal(active, 0);
});

for (const hours of [{}, { timeZoneId: 'US/Eastern', tradingHours: '20260924:CLOSED' }, { timeZoneId: 'Europe/Warsaw', liquidHours: '20260924:CLOSED' }, { timeZoneId: 'US/Eastern', liquidHours: '20260924:2300-20260925:0400' }])
  test(`unusable optional contract hours do not alter historical coverage: ${JSON.stringify(hours)}`, async () => {
    const ib = new Fake(); ib.hours = hours;
    const adapter = new SessionScheduleAdapter({ ...options, socket: () => ib, acquirePacing: async () => {} });
    const schedule = await adapter.fetch(sessionIdentityFixture());
    assert.equal(schedule.currentHours, undefined); assert.equal(schedule.coverageEnd, '2026-09-24T20:00:00.000Z');
    assert.equal(ib.requests.length, 1);
  });
test('contract hours extend no historical envelope even when they include later dates', async () => {
  const ib = new Fake(); ib.hours.liquidHours = '20260924:0930-1600;20260925:CLOSED';
  const schedule = await new SessionScheduleAdapter({ ...options, socket: () => ib, acquirePacing: async () => {} }).fetch(sessionIdentityFixture());
  assert.equal(schedule.currentHours?.days[1].date, '2026-09-25');
  assert.equal(schedule.coverageEnd, '2026-09-24T20:00:00.000Z'); assert.equal(schedule.sessions.length, 1);
});
