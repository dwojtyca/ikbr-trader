import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { evaluateSessionCandles, sessionNativeSource, type Candle, type InstrumentSessionIdentity } from '@ikbr/shared';
import { AutoBootstrapController } from './auto-bootstrap.js';
import { TwsClient } from './tws-client.js';
import { SessionNativeRefresh } from './session-native-refresh.js';
import { ReadRecoverySession } from "./read-recovery-session.js";
import { PublicationFence } from './publication-fence.js';
import { sessionEvidenceFixture, sessionIdentityFixture } from './session-fixture.js';

test('production recovery components restore fresh PKO/AAPL native evaluation after a wake with no disconnect event', async () => {
  let now = Date.parse('2026-09-24T13:45:10Z'), stopped = false, bootstraps = 0;
  const identities = [
    sessionIdentityFixture({ instrumentId: 'pko', conId: 101, symbol: 'PKO', exchange: 'WSE', currency: 'PLN',
      localSymbol: 'PKO', tradingClass: 'PKO', primaryExchange: undefined, timeZone: 'Europe/Warsaw' }),
    sessionIdentityFixture({ instrumentId: 'aapl', conId: 102, symbol: 'AAPL', localSymbol: 'AAPL' }),
  ];
  const subscriptions = identities.map(i => ({ symbol: i.symbol, conid: String(i.conId), instrumentId: i.instrumentId }));
  const rows = new Map<string, Candle[]>(), receivedTicks: Date[] = [];
  const candles = (identity: InstrumentSessionIdentity) => {
    const schedule = sessionEvidenceFixture(identity, now).schedule!;
    const result: Candle[] = [];
    for (const session of schedule.sessions) for (let time = Date.parse(session.start); time + 60_000 <= Math.min(now, Date.parse(session.end)); time += 60_000)
      result.push({ conid: String(identity.conId), symbol: identity.symbol, timeframe: '1m', ts: new Date(time),
        open: 100, high: 101, low: 99, close: 100, volume: 1, source: sessionNativeSource(identity) });
    return result.slice(-220);
  };
  class Broker extends EventEmitter {
    ticker = 0; readRequests = 0; disconnected = false;
    connect() { this.emit('nextValidId', 1); }
    disconnect() { this.disconnected = true; this.emit('disconnected'); }
    reqMarketDataType() {}
    reqCurrentTime() { this.emit('currentTime', Math.floor(now / 1000)); }
    reqMktData(id: number) { this.ticker = id; }
    cancelHistoricalData() {}
    reqHistoricalData(id: number, contract: { conId: number }, _end: string, _duration: string, barSize: string) {
      this.readRequests++;
      const identity = identities.find(i => i.conId === contract.conId)!;
      if (barSize === '1 min') for (const candle of candles(identity))
        this.emit('historicalData', id, String(candle.ts.getTime() / 1000), candle.open, candle.high, candle.low, candle.close, candle.volume);
      this.emit('historicalData', id, 'finished');
    }
  }
  const brokers: Broker[] = [];
  const publications = new PublicationFence(() => controller.continuous());
  const client: TwsClient = new TwsClient({ host: 'unused', port: 0, clientId: 1, securityType: 'STK', exchange: 'SMART', currency: 'USD', marketDataType: 1 },
    tick => publications.run(async current => { if (current()) receivedTicks.push(tick.ts); }), () => {}, {
      ibFactory: () => { const broker = new Broker(); brokers.push(broker); return broker; }, now: () => now,
      continuous: () => controller.continuous(), onConnectionInvalidated: () => controller.invalidate(),
    });
  const refresh = new SessionNativeRefresh({ now: () => now, current: () => controller.continuous(),
    identity: sub => identities.find(i => i.instrumentId === sub.instrumentId)!,
    schedule: async identity => sessionEvidenceFixture(identity, now), readSchedule: async identity => sessionEvidenceFixture(identity, now),
    invalidate: async () => {}, read: async (identity, tf) => rows.get(`${identity.instrumentId}:${tf}`) ?? [],
    fetch: (sub, identity, tf, count) => client.fetchSessionCandles(sub, identity, tf, count),
    write: async candle => {
      const identity = identities.find(i => String(i.conId) === candle.conid)!;
      const key = `${identity.instrumentId}:${candle.timeframe}`, prior = rows.get(key) ?? [];
      rows.set(key, [...prior.filter(row => row.ts.getTime() !== candle.ts.getTime()), candle].sort((a, b) => +a.ts - +b.ts));
    },
  });
  const recovery = new ReadRecoverySession({ pause: () => {}, now: () => now,
    invalidatePublications: () => publications.invalidate(), invalidateNativeRefresh: () => refresh.invalidate(),
    invalidateScheduleRequests: () => {}, disconnect: () => client.disconnect(), clearLocalState: () => {},
    invalidateSchedules: async () => {}, drainSchedules: async () => {},
    drainPublications: () => publications.idle(), drainNativeRefresh: () => refresh.idle(),
    connect: () => client.connect(), probe: () => client.probe(), onInvalidationError: error => { throw error; },
  });
  const controller: AutoBootstrapController<void> = new AutoBootstrapController({ enabled: true, now: () => now,
    readStopped: async () => stopped, writeStopped: async value => { stopped = value; },
    ready: () => client.isConnected(), probe: () => client.probe(),
    invalidateReads: () => recovery.invalidate(), drainStatus: () => recovery.diagnostics(),
    stop: () => recovery.drain(),
    bootstrap: async current => {
      bootstraps++;
      await recovery.bootstrap(current, () => refresh.run(subscriptions, current), () => client.addSubscriptions(subscriptions));
    },
  });
  await controller.initialize(); await controller.tick();
  for (const identity of identities) assert.equal(evaluateSessionCandles(rows.get(`${identity.instrumentId}:1m`)!, '1m',
    sessionEvidenceFixture(identity, now), identity, now).reason, undefined);
  now += 180_000;
  for (const identity of identities) assert.notEqual(evaluateSessionCandles(rows.get(`${identity.instrumentId}:1m`)!, '1m',
    sessionEvidenceFixture(identity, now), identity, now).reason, undefined);
  const old = brokers[0]; old.emit('tickPrice', old.ticker, 1, 999);
  assert.equal(receivedTicks.length, 0); assert.equal(old.disconnected, true);
  await controller.tick();
  assert.equal(bootstraps, 2); assert.equal(brokers.length, 2); assert.ok(brokers[1].readRequests > 0);
  for (const identity of identities) {
    const result = evaluateSessionCandles(rows.get(`${identity.instrumentId}:1m`)!, '1m', sessionEvidenceFixture(identity, now), identity, now);
    assert.equal(result.reason, undefined);
    assert.equal(Date.parse(result.latestEnd!), Math.floor(now / 60_000) * 60_000);
  }
  // Missing higher-timeframe history remains a truthful separate hold even after socket recovery.
  assert.ok([...refresh.status.values()].some(status => status.timeframe !== '1m' && status.preparationState !== 'READY'));
  await controller.stopManually(); now += 120_000; await controller.tick(); assert.equal(bootstraps, 2);
  await controller.shutdown();
});
