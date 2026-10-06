import { normalizeStrategyPriceBands } from "./wse-market-rules.js";
import type { BoundInstrument } from './instruments/bindings.js';
import type { SignalTicket } from './index.js';
import { tickSizesEqual } from './instruments/bindings.js';
import { buildInstrumentSessionIdentity, requireSessionSchedule, type SessionScheduleEvidence } from './instrument-sessions.js';

export interface SupportedStockCapability {
  quoteCurrency: 'PLN' | 'USD'; exchange: 'WSE' | 'SMART';
  primaryExchange: 'WSE' | 'NASDAQ' | 'NYSE' | 'AMEX'; timeZone: 'Europe/Warsaw' | 'America/New_York';
}
export function getSupportedStockCapability(bound: BoundInstrument): SupportedStockCapability | null {
  const i = bound.instrument;
  if (bound.broker !== 'ibkr' || i.broker !== 'ibkr' || i.assetClass !== 'stock' || bound.instrumentId !== i.id ||
      !bound.brokerSymbol || bound.brokerSymbol !== i.brokerSymbol || !Number.isSafeInteger(bound.conId) || bound.conId <= 0 ||
      i.conId !== bound.conId || !bound.localSymbol || i.localSymbol !== bound.localSymbol ||
      !bound.tradingClass || i.tradingClass !== bound.tradingClass || i.currency !== bound.currency || i.exchange !== bound.exchange ||
      !Number.isFinite(bound.minTick) || bound.minTick <= 0 || i.session.useRegularTradingHours !== true) return null;
  if (bound.exchange === 'WSE' && i.primaryExchange === 'WSE' && bound.currency === 'PLN' && i.session.timezone === 'Europe/Warsaw')
    return { quoteCurrency: 'PLN', exchange: 'WSE', primaryExchange: 'WSE', timeZone: 'Europe/Warsaw' };
  if (bound.exchange === 'SMART' && ['NASDAQ', 'NYSE', 'AMEX'].includes(i.primaryExchange ?? '') && bound.currency === 'USD' && i.session.timezone === 'America/New_York')
    return { quoteCurrency: 'USD', exchange: 'SMART', primaryExchange: i.primaryExchange as 'NASDAQ' | 'NYSE' | 'AMEX', timeZone: 'America/New_York' };
  return null;
}
export function isSupportedLegacyStockManagementBound(bound: BoundInstrument): boolean {
  const i = bound.instrument;
  if (bound.broker !== 'ibkr' || i.broker !== 'ibkr' || i.assetClass !== 'stock' || i.id !== bound.instrumentId ||
      i.brokerSymbol !== bound.brokerSymbol || i.exchange !== bound.exchange || i.currency !== bound.currency ||
      (i.conId !== undefined && i.conId !== bound.conId) || (i.localSymbol !== undefined && i.localSymbol !== bound.localSymbol) ||
      (i.tradingClass !== undefined && i.tradingClass !== bound.tradingClass) || i.session.useRegularTradingHours !== true) return false;
  return (bound.instrumentId === 'pko_wse' && bound.conId === 35146360 && bound.brokerSymbol === 'PKO' && bound.localSymbol === 'PKO' && bound.tradingClass === 'PKO' &&
      bound.exchange === 'WSE' && bound.currency === 'PLN' && (!i.primaryExchange || i.primaryExchange === 'WSE') && i.session.timezone === 'Europe/Warsaw') ||
    (bound.instrumentId === 'aapl_nasdaq' && bound.conId === 265598 && bound.brokerSymbol === 'AAPL' && bound.localSymbol === 'AAPL' && bound.tradingClass === 'NMS' &&
      bound.exchange === 'SMART' && bound.currency === 'USD' && (!i.primaryExchange || i.primaryExchange === 'NASDAQ') && i.session.timezone === 'America/New_York');
}
export interface StockMarketMetadata {
  accountId: string; instrumentId: string; conId: number; symbol: string; localSymbol: string; tradingClass: string;
  exchange: 'WSE' | 'SMART'; primaryExchange: 'WSE' | 'NASDAQ' | 'NYSE' | 'AMEX'; currency: 'PLN' | 'USD'; secType: 'STK'; minTick: number;
  marketRuleId: number; priceIncrements: Array<{ lowEdge: number; increment: number }>;
  requestStartedAtMs: number; receivedAtMs: number; sessionEvidence: SessionScheduleEvidence;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function validateStockOrder(metadata: unknown, bound: BoundInstrument, accountId: string, ticket: SignalTicket, nowMs: number):
  { ok: true; expiresAtMs: number; metadata: StockMarketMetadata } | { ok: false; reason: string } {
  try {
    const capability = getSupportedStockCapability(bound);
    if (!capability || !record(metadata)) throw new Error('stock_metadata_identity_invalid');
    const expected = { accountId, instrumentId: bound.instrumentId, conId: bound.conId, symbol: bound.brokerSymbol,
      localSymbol: bound.localSymbol, tradingClass: bound.tradingClass, exchange: capability.exchange,
      primaryExchange: capability.primaryExchange, currency: capability.quoteCurrency, secType: 'STK' };
    if (!accountId || Object.entries(expected).some(([key, value]) => metadata[key] !== value) ||
        !finite(metadata.minTick) || metadata.minTick <= 0 || !tickSizesEqual(metadata.minTick, bound.minTick)) throw new Error('stock_metadata_identity_invalid');
    if (!finite(nowMs) || !finite(metadata.requestStartedAtMs) || !finite(metadata.receivedAtMs) || metadata.requestStartedAtMs <= 0 ||
        metadata.requestStartedAtMs > metadata.receivedAtMs || metadata.receivedAtMs > nowMs || nowMs >= metadata.requestStartedAtMs + 60_000) throw new Error('stock_metadata_stale');
    if (!Number.isSafeInteger(metadata.marketRuleId) || Number(metadata.marketRuleId) <= 0 || !Array.isArray(metadata.priceIncrements) ||
        metadata.priceIncrements.length === 0 || metadata.priceIncrements.length > 256) throw new Error('stock_market_rule_invalid');
    let prior = -1;
    for (const band of metadata.priceIncrements) {
      if (!record(band) || !finite(band.lowEdge) || !finite(band.increment) || band.lowEdge < 0 || band.lowEdge <= prior ||
          band.increment <= 0 || (prior === -1 && band.lowEdge !== 0)) throw new Error('stock_market_rule_invalid');
      prior = band.lowEdge;
    }
    const close = ticket.side === 'SELL' && ticket.positionEffect === 'CLOSE_OR_REDUCE';
    const entry = ticket.side === 'BUY' && (ticket.positionEffect === undefined || ticket.positionEffect === 'OPEN_OR_ADD');
    if (ticket.instrumentId !== bound.instrumentId || ticket.instrument !== bound.brokerSymbol || ticket.conid !== String(bound.conId) ||
        ticket.quantity !== 1 || ticket.orderType !== 'LMT' || (!close && !entry) || ticket.trailingStopPct !== undefined || ticket.trailingStopActivationR !== undefined ||
        (ticket.partialTakeProfits !== undefined && (!Array.isArray(ticket.partialTakeProfits) || ticket.partialTakeProfits.length !== 0)) ||
        (close && (ticket.stop !== undefined || ticket.takeProfit !== undefined)) ||
        (entry && (!finite(ticket.entry) || !finite(ticket.stop) || !finite(ticket.takeProfit) || ticket.stop >= ticket.entry || ticket.takeProfit <= ticket.entry))) throw new Error('stock_order_shape_invalid');
    const bands = metadata.priceIncrements as StockMarketMetadata['priceIncrements'];
    for (const price of close ? [ticket.entry] : [ticket.entry, ticket.stop, ticket.takeProfit]) {
      if (!finite(price) || price <= 0) throw new Error('stock_price_invalid');
      const band = [...bands].reverse().find(b => price >= b.lowEdge)!;
      const ticks = (price - band.lowEdge) / band.increment;
      if (!finite(ticks) || Math.abs(ticks - Math.round(ticks)) > Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(price / band.increment), Math.abs(band.lowEdge / band.increment)) * 8)) throw new Error('stock_price_off_band');
    }
    const evidence = metadata.sessionEvidence as SessionScheduleEvidence;
    const schedule = requireSessionSchedule(evidence, buildInstrumentSessionIdentity(bound.instrument, bound), nowMs);
    const active = schedule.sessions.find(s => Date.parse(s.start) <= nowMs && nowMs < Date.parse(s.end));
    if (!active || Date.parse(schedule.coverageStart) > nowMs) throw new Error('stock_session_closed');
    const expiresAtMs = Math.min(metadata.requestStartedAtMs + 60_000, Date.parse(active.end), Date.parse(schedule.coverageEnd),
      Date.parse(schedule.receivedAt) + 6 * 3_600_000, Date.parse(evidence.updatedAt) + 6 * 3_600_000);
    if (!finite(expiresAtMs) || expiresAtMs <= nowMs) throw new Error('stock_session_stale');
    const saved = JSON.parse(JSON.stringify(metadata)) as StockMarketMetadata;
    return { ok: true, expiresAtMs, metadata: saved };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'stock_metadata_invalid' }; }
}

export interface StockStrategyPriceEvidence {
  raw: { entry: number; stopLoss: number; takeProfit: number };
  final: { entry: number; stopLoss: number; takeProfit: number };
  metadata: StockMarketMetadata;
  normalizedAtMs: number;
}
export function normalizeStockStrategyLevels(metadata: unknown, bound: BoundInstrument, accountId: string,
  raw: StockStrategyPriceEvidence['raw'], nowMs: number): StockStrategyPriceEvidence {
  const final = normalizeStrategyPriceBands(metadata, raw);
  const validated = validateStockOrder(metadata, bound, accountId, {
    instrument: bound.brokerSymbol, instrumentId: bound.instrumentId, conid: String(bound.conId),
    side: 'BUY', quantity: 1, orderType: 'LMT', entry: final.entry, stop: final.stopLoss, takeProfit: final.takeProfit,
    reason: 'strategy price validation', confidence: 1, timestamp: new Date(nowMs).toISOString(), riskCheckStatus: 'PASS',
  }, nowMs);
  if (!validated.ok) throw new Error(validated.reason);
  return Object.freeze({ raw: Object.freeze({...raw}), final: Object.freeze(final), metadata: validated.metadata, normalizedAtMs: nowMs });
}
