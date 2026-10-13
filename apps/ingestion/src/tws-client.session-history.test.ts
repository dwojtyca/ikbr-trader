import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { sessionNativeSource, sessionLocalMidnight } from '@ikbr/shared';
import { TwsClient } from './tws-client.js';
import { sessionIdentityFixture } from './session-fixture.js';
const config = { host: 'unused', port: 0, clientId: 1, securityType: 'STK', exchange: 'SMART', currency: 'USD', marketDataType: 1 };
class Fake extends EventEmitter {
  requests: unknown[][] = []; cancelled: number[] = []; dates = ['20260923']; error = false; volume = 100; throwOnSend = false; hang = false;
  cancelHistoricalData(id: number) { this.cancelled.push(id); }
  reqHistoricalData(...args: unknown[]) { this.requests.push(args); queueMicrotask(() => {
    if (this.throwOnSend || this.hang) return;
    this.emit('historicalData', Number(args[0]) + 1, 'finished');
    if (this.error) { this.emit('error', new Error('broker history unavailable'), { id: args[0], code: 162 }); return; }
    for (const date of this.dates) this.emit('historicalData', args[0], date, 100, 101, 99, 100, this.volume);
    this.emit('historicalData', args[0], 'finished');
  }); if (this.throwOnSend) throw new Error('send failed'); }
}
for (const useRTH of [true, false]) test(`generic native history uses exact bound mode ${useRTH}, timezone and source`, async () => {
  const identity = sessionIdentityFixture({ timeZone: 'Asia/Kolkata', useRTH });
  const sub = { instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol,
    contract: { conId: identity.conId, symbol: identity.symbol, secType: identity.secType, exchange: identity.exchange, currency: identity.currency } };
  const ib = new Fake(), client = new TwsClient(config, () => {}, () => {}, { ib });
  const rows = await client.fetchSessionCandles(sub, identity, '1d', 60);
  assert.equal(rows[0].ts.getTime(), sessionLocalMidnight('2026-09-23', identity.timeZone));
  assert.equal(rows[0].source, sessionNativeSource(identity)); assert.equal(ib.requests[0][6], useRTH ? 1 : 0);
  assert.equal(ib.requests[0][5], 'TRADES');
  assert.deepEqual(ib.cancelled, []);
  ib.emit('historicalData', ib.requests[0][0], 'finished');
  assert.deepEqual(ib.cancelled, []);
  await assert.rejects(client.fetchSessionCandles(sub, identity, '12h' as never, 60), /invalid/);
});
test('FX requests MIDPOINT and preserves unknown volume rather than fabricating zero', async () => {
  const identity = sessionIdentityFixture({ instrumentId: 'currency', secType: 'CASH', symbol: 'EUR', conId: 321, exchange: 'IDEALPRO', useRTH: false });
  const sub = { instrumentId: identity.instrumentId, conid: '321', symbol: 'EUR', contract: { conId: 321, secType: 'CASH', symbol: 'EUR', exchange: 'IDEALPRO', currency: 'USD' } };
  const ib = new Fake(); ib.dates = [String(Date.parse('2026-09-24T13:30:00Z') / 1000)]; ib.volume = -1;
  const client = new TwsClient(config, () => {}, () => {}, { ib });
  const rows = await client.fetchSessionCandles(sub, identity, '1m', 230);
  assert.equal(ib.requests[0][5], 'MIDPOINT'); assert.equal(rows[0].volume, -1);
  assert.deepEqual(ib.cancelled, []);
});
test('generic broker errors and duplicate timestamps reject instead of successful empty or overwritten data', async () => {
  const identity = sessionIdentityFixture(), sub = { instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol };
  const ib = new Fake(), client = new TwsClient(config, () => {}, () => {}, { ib });
  ib.error = true; await assert.rejects(client.fetchSessionCandles(sub, identity, '1d', 60), /162/);
  assert.deepEqual(ib.cancelled, [ib.requests[0][0]]);
  ib.emit('historicalData', ib.requests[0][0], 'finished'); ib.emit('error', new Error('late'), { id: ib.requests[0][0], code: 162 });
  assert.equal(ib.cancelled.length, 1);
  ib.error = false; ib.dates = []; await assert.rejects(client.fetchSessionCandles(sub, identity, '1d', 60), /history_empty/);
  ib.dates = ['20260923', '20260923']; await assert.rejects(client.fetchSessionCandles(sub, identity, '1d', 60), /duplicate/);
  assert.equal(ib.cancelled.length, 1);
});
test('native history synchronous send failure releases listeners and cancels unfinished request once', async () => {
  const identity = sessionIdentityFixture(), sub = { instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol };
  const ib = new Fake(); ib.throwOnSend = true;
  const client = new TwsClient(config, () => {}, () => {}, { ib });
  const initialErrorListeners = ib.listenerCount('error');
  await assert.rejects(client.fetchSessionCandles(sub, identity, '1d', 60), /send failed/);
  assert.deepEqual(ib.cancelled, [ib.requests[0][0]]);
  assert.equal(ib.listenerCount('historicalData'), 0);
  assert.equal(ib.listenerCount('error'), initialErrorListeners);
});
test('native history timeout cancels unfinished request once and ignores late completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const identity = sessionIdentityFixture(), sub = { instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol };
  const ib = new Fake(); ib.hang = true;
  const client = new TwsClient(config, () => {}, () => {}, { ib });
  const initialErrorListeners = ib.listenerCount('error');
  const pending = client.fetchSessionCandles(sub, identity, '1d', 60);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(ib.requests.length, 1);
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /Timed out waiting historicalData/);
  ib.emit('historicalData', ib.requests[0][0], 'finished');
  assert.deepEqual(ib.cancelled, [ib.requests[0][0]]);
  assert.equal(ib.listenerCount('historicalData'), 0);
  assert.equal(ib.listenerCount('error'), initialErrorListeners);
});
