import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { sessionNativeSource, sessionLocalMidnight } from '@ikbr/shared';
import { TwsClient } from './tws-client.js';
import { sessionIdentityFixture } from './session-fixture.js';
const config = { host: 'unused', port: 0, clientId: 1, securityType: 'STK', exchange: 'SMART', currency: 'USD', marketDataType: 1 };
class Fake extends EventEmitter {
  requests: unknown[][] = []; dates = ['20260923']; error = false; volume = 100;
  reqHistoricalData(...args: unknown[]) { this.requests.push(args); queueMicrotask(() => {
    if (this.error) { this.emit('error', new Error('broker history unavailable'), { id: args[0], code: 162 }); return; }
    for (const date of this.dates) this.emit('historicalData', args[0], date, 100, 101, 99, 100, this.volume);
    this.emit('historicalData', args[0], 'finished');
  }); }
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
  await assert.rejects(client.fetchSessionCandles(sub, identity, '12h' as never, 60), /invalid/);
});
test('FX requests MIDPOINT and preserves unknown volume rather than fabricating zero', async () => {
  const identity = sessionIdentityFixture({ instrumentId: 'currency', secType: 'CASH', symbol: 'EUR', conId: 321, exchange: 'IDEALPRO', useRTH: false });
  const sub = { instrumentId: identity.instrumentId, conid: '321', symbol: 'EUR', contract: { conId: 321, secType: 'CASH', symbol: 'EUR', exchange: 'IDEALPRO', currency: 'USD' } };
  const ib = new Fake(); ib.dates = [String(Date.parse('2026-09-24T13:30:00Z') / 1000)]; ib.volume = -1;
  const client = new TwsClient(config, () => {}, () => {}, { ib });
  const rows = await client.fetchSessionCandles(sub, identity, '1m', 230);
  assert.equal(ib.requests[0][5], 'MIDPOINT'); assert.equal(rows[0].volume, -1);
});
test('generic broker errors and duplicate timestamps reject instead of successful empty or overwritten data', async () => {
  const identity = sessionIdentityFixture(), sub = { instrumentId: identity.instrumentId, conid: String(identity.conId), symbol: identity.symbol };
  const ib = new Fake(), client = new TwsClient(config, () => {}, () => {}, { ib });
  ib.error = true; await assert.rejects(client.fetchSessionCandles(sub, identity, '1d', 60), /162/);
  ib.error = false; ib.dates = []; await assert.rejects(client.fetchSessionCandles(sub, identity, '1d', 60), /history_empty/);
  ib.dates = ['20260923', '20260923']; await assert.rejects(client.fetchSessionCandles(sub, identity, '1d', 60), /duplicate/);
});
