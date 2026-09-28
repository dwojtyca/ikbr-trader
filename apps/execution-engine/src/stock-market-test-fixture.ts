import { buildInstrumentSessionIdentity, sessionDateAt, type BoundInstrument, type StockMarketMetadata } from '@ikbr/shared';
export function stockMetadataFixture(bound: BoundInstrument, accountId: string, nowMs: number): StockMarketMetadata {
  const iso = (delta: number) => new Date(nowMs + delta).toISOString();
  return { accountId, instrumentId: bound.instrumentId, conId: bound.conId, symbol: bound.brokerSymbol, localSymbol: bound.localSymbol,
    tradingClass: bound.tradingClass, exchange: bound.exchange as 'SMART' | 'WSE', primaryExchange: bound.instrument.primaryExchange as 'NASDAQ' | 'NYSE' | 'AMEX' | 'WSE',
    currency: bound.currency as 'USD' | 'PLN', secType: 'STK', minTick: bound.minTick, marketRuleId: 1, priceIncrements: [{ lowEdge: 0, increment: .01 }],
    requestStartedAtMs: nowMs - 100, receivedAtMs: nowMs, sessionEvidence: { status: 'READY', generation: 1, updatedAt: iso(0),
      schedule: { source: 'ibkr_session_schedule_v1', identity: buildInstrumentSessionIdentity(bound.instrument, bound), requestedAt: iso(-100), receivedAt: iso(0),
        coverageStart: iso(-30 * 86400000), coverageEnd: iso(86400000), sessions: [{ date: sessionDateAt(nowMs, bound.instrument.session.timezone), start: iso(-3600000), end: iso(3600000) }] } } };
}
