import type { BoundInstrument, SignalTicket } from "@ikbr/shared";
import type { WseMarketMetadata } from "./wse-market-rules.js";
export function wseMetadataFixture(bound: BoundInstrument, accountId: string, nowMs: number): WseMarketMetadata {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(nowMs).map(x => [x.type, x.value]));
  const day = `${parts.year}${parts.month}${parts.day}`;
  return { accountId, instrumentId: bound.instrumentId, conId: bound.conId, symbol: bound.brokerSymbol,
    localSymbol: bound.localSymbol, tradingClass: bound.tradingClass, exchange: "WSE", currency: "PLN", secType: "STK",
    marketRuleId: 1, priceIncrements: [{ lowEdge: 0, increment: 0.01 }], timeZoneId: "Europe/Warsaw",
    liquidHours: `${day}:0900-${day}:1700`, requestStartedAtMs: nowMs - 100, receivedAtMs: nowMs - 50 };
}

export const wseTestBound: BoundInstrument = {
  instrumentId: "pko_wse", broker: "ibkr", brokerSymbol: "PKO", conId: 35146360, localSymbol: "PKO", tradingClass: "PKO", exchange: "WSE", currency: "PLN", minTick: 0.0001,
  instrument: { id: "pko_wse", displayName: "PKO", broker: "ibkr", brokerSymbol: "PKO", assetClass: "stock", exchange: "WSE", currency: "PLN",
    session: { useRegularTradingHours: true, timezone: "Europe/Warsaw", sessionTemplate: "wse_stock_rth" }, metadata: { tags: [] },
    trading: { executionEnabled: false, monitoringEnabled: false, signalGenerationEnabled: false, aiAnalysisEnabled: false },
    risk: { maxQuantity: 1, quantityUnit: "shares", maxLeverage: 1, allowOvernight: false, maxSpread: 0.05, maxSlippage: 0.05 } },
};
export const wseTestTicket: SignalTicket = { instrumentId: wseTestBound.instrumentId, instrument: "PKO", conid: String(wseTestBound.conId), side: "BUY", orderType: "LMT", quantity: 1,
  entry: 100, stop: 99.99, takeProfit: 101, reason: "test", confidence: 1, timestamp: "2026-09-24T12:00:00Z", riskCheckStatus: "PASS" };
