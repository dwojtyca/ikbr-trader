import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { AaplScheduleAdapter } from './aapl-schedule-adapter.js';
class Fake extends EventEmitter {
  serverVersion = 180;
  contract: Record<string, unknown> = { conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'SMART', primaryExch: 'NASDAQ', currency: 'USD' };
  requests: unknown[][] = []; disconnected = false; cancelled: number[] = [];
  hang = false; duplicate = false; wrongTimezone = false; error = false;
  connect() { queueMicrotask(() => this.emit('nextValidId', 1)); }
  disconnect() { this.disconnected = true; this.emit('disconnected'); }
  reqContractDetails(id: number) { queueMicrotask(() => {
    this.emit('contractDetails', id + 1, { contract: {} });
    this.emit('contractDetails', id, { contract: this.contract });
    if (this.duplicate) this.emit('contractDetails', id, { contract: this.contract });
    this.emit('contractDetailsEnd', id);
  }); }
  reqHistoricalData(...args: unknown[]) { this.requests.push(args); queueMicrotask(() => {
    if (this.hang) return;
    if (this.error) { this.emit('error', new Error('fixture'), 162, args[0]); return; }
    const session = { refDate: '20260924', startDateTime: '20260924-09:30:00', endDateTime: '20260924-16:00:00' };
    this.emit('historicalSchedule', 999, 'bad', 'bad', 'bad', []);
    this.emit('historicalSchedule', args[0], session.startDateTime, session.endDateTime, this.wrongTimezone ? 'Europe/Warsaw' : 'US/Eastern', [session]);
  }); }
  cancelHistoricalData(id: number) { this.cancelled.push(id); }
}
const options = { host: 'unused', port: 0, clientId: 154, now: () => Date.parse('2026-09-24T18:00:00Z') };
test('schedule production adapter waits for pacing, exact contract completion and correlated SCHEDULE envelope', async () => {
  const ib = new Fake(); let paced = false;
  const adapter = new AaplScheduleAdapter({ ...options, socket: () => { assert.equal(paced, true); return ib; }, acquirePacing: async () => { paced = true; } });
  const result = await adapter.fetch();
  assert.equal(result.conId, 265598); assert.equal(result.timeZone, 'America/New_York');
  assert.deepEqual(ib.requests[0].slice(2), ['', '14 D', '1 day', 'SCHEDULE', true, 1, false]);
  ib.emit("error", new Error("late retired socket error"));
  assert.equal(ib.disconnected, true); assert.deepEqual(ib.eventNames(), ["error"]); assert.equal(ib.listenerCount("error"), 1); assert.deepEqual(ib.cancelled, [91002]);
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
    const adapter = new AaplScheduleAdapter({ ...options, socket: () => ib, acquirePacing: async () => {}, timeoutMs: 20 });
    await assert.rejects(adapter.fetch(), /aapl_schedule/);
    ib.emit("error", new Error("late retired socket error"));
  assert.equal(ib.disconnected, true); assert.deepEqual(ib.eventNames(), ["error"]); assert.equal(ib.listenerCount("error"), 1);
    if (['server', 'missing-server', 'identity', 'duplicate'].includes(failure)) assert.equal(ib.requests.length, 0);
  });
