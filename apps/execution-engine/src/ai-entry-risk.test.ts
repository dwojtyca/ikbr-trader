import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoundInstrument, ProposedOrder } from "@ikbr/shared";
import type { AccountSnapshot } from "./tws-execution-client.js";
import { assessAiEntryRisk } from "./ai-entry-risk.js";

const nowMs = Date.parse("2026-09-23T12:00:00Z");
const stamp = (delta = 0) => new Date(nowMs + delta).toISOString();
function fixture() {
  const bound: BoundInstrument = {
    instrumentId: "test", conId: 123, brokerSymbol: "TEST", currency: "USD",
    broker: "ibkr", localSymbol: "TEST", tradingClass: "TEST", exchange: "SMART", minTick: 0.01,
    instrument: { id: "test", displayName: "Synthetic test", broker: "ibkr", brokerSymbol: "TEST", exchange: "SMART",
      session: { useRegularTradingHours: true, timezone: "America/New_York", sessionTemplate: "us_stock_rth" }, metadata: { tags: [] }, assetClass: "stock", currency: "USD", trading: { executionEnabled: true, signalGenerationEnabled: true, aiAnalysisEnabled: true, monitoringEnabled: true },
      risk: { maxLeverage: 1, allowOvernight: false, quantityUnit: "shares", maxQuantity: 1, maxSpread: 1, maxSlippage: 1 },
      executionPolicy: { timeframe: "1m", defaultOrderType: "LMT", timeInForce: "DAY", outsideRth: false, transmit: true, priceTickSize: 0.01, priceRoundingMode: "nearest", strategyId: "test_strategy", expectedDirection: "LONG", quantityUnit: "shares",
        quantity: 1, maxQuantity: 1, allowedOrderTypes: ["LMT"] } },
  };
  const order = { instrument: "TEST", instrumentId: "test", conid: "123", side: "BUY", orderType: "LMT",
    quantity: 1, entry: 100, stop: 99, takeProfit: 102, strategy: "test_strategy", status: "PROPOSED" } as ProposedOrder;
  const snapshot = { accountId: "PAPER_TEST", riskEvidence: { requestStartedAt: stamp(-100), completedAt: stamp(),
    complete: true, configuredBaseCurrency: "USD", usdMetrics: { netLiquidation: 10000, availableFunds: 5000, grossPositionValue: 1000 } } } as AccountSnapshot;
  const watchlist = { connected: true, watchlist: [{ instrumentId: "test", conid: "123", subscribed: true,
    marketState: { conid: "123", bid: 99.5, ask: 100, marketDataType: 1, bidObservedAt: stamp(-200), askObservedAt: stamp(-50) } }] };
  return { order, bound, snapshot, watchlist, accountId: "PAPER_TEST", sessionId: "session", nowMs,
    limits: { maxNotionalPct: 10, maxStopRiskPct: 0.5, maxExposurePct: 25 } };
}

test("fresh exact USD stock entry has account/session-bound evidence and oldest-input expiry", () => {
  const result = assessAiEntryRisk(fixture());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.evidence.validUntilMs, nowMs + 9800);
  assert.equal(result.evidence.accountId, "PAPER_TEST");
  assert.equal(result.evidence.sessionId, "session");
  assert.equal(result.evidence.notional, 100);
  assert.equal(result.evidence.stopRisk, 1);
});

type Fixture = ReturnType<typeof fixture>;
const cases: Array<[string, (f: Fixture) => void]> = [
  ["nonstock asset", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument, assetClass: "future" } }; }],
  ["nonUSD contract", f => { f.bound = { ...f.bound, currency: "EUR" }; }],
  ["disabled execution", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument,
    trading: { ...f.bound.instrument.trading, executionEnabled: false } } }; }],
  ["registry quantity cap", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument,
    risk: { ...f.bound.instrument.risk, maxQuantity: 0 } } }; }],
  ["policy quantity cap", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument,
    executionPolicy: { ...f.bound.instrument.executionPolicy!, quantity: 0.5 } } }; }],
  ["policy max quantity cap", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument,
    executionPolicy: { ...f.bound.instrument.executionPolicy!, maxQuantity: 0.5 } } }; }],
  ["missing expected direction", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument,
    executionPolicy: { ...f.bound.instrument.executionPolicy!, expectedDirection: undefined } } }; }],
  ["disabled bracket", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument,
    executionPolicy: { ...f.bound.instrument.executionPolicy!, bracketDisabled: true } } }; }],
  ["wrong account", f => { f.snapshot.accountId = "OTHER"; }],
  ["missing account evidence", f => { delete f.snapshot.riskEvidence; }],
  ["non USD account", f => { f.snapshot.riskEvidence!.configuredBaseCurrency = "EUR"; }],
  ["stale request start despite fresh completion", f => { f.snapshot.riskEvidence!.requestStartedAt = stamp(-10000); }],
  ["future completion", f => { f.snapshot.riskEvidence!.completedAt = stamp(1); }],
  ["inverted completion", f => { f.snapshot.riskEvidence!.completedAt = stamp(-101); }],
  ["missing USD metric", f => { delete f.snapshot.riskEvidence!.usdMetrics.netLiquidation; }],
  ["infinite exposure", f => { f.snapshot.riskEvidence!.usdMetrics.grossPositionValue = Infinity; }],
  ["negative exposure", f => { f.snapshot.riskEvidence!.usdMetrics.grossPositionValue = -1; }],
  ["insufficient funds", f => { f.snapshot.riskEvidence!.usdMetrics.availableFunds = 99; }],
  ["notional cap", f => { f.limits.maxNotionalPct = 0.99; }],
  ["stop risk cap", f => { f.limits.maxStopRiskPct = 0.009; }],
  ["exposure cap", f => { f.snapshot.riskEvidence!.usdMetrics.grossPositionValue = 2401; }],
  ["zero limit", f => { f.limits.maxNotionalPct = 0; }],
  ["over 100 limit", f => { f.limits.maxExposurePct = 101; }],
  ["wrong bound id", f => { f.order.instrumentId = "other"; }],
  ["wrong contract", f => { f.order.conid = "456"; }],
  ["wrong symbol", f => { f.order.instrument = "OTHER"; }],
  ["short", f => { f.order.side = "SELL"; }],
  ["market order", f => { f.order.orderType = "MKT"; }],
  ["close bypass", f => { f.order.positionEffect = "CLOSE_OR_REDUCE"; }],
  ["multiple shares", f => { f.order.quantity = 2; }],
  ["fractional shares", f => { f.order.quantity = 0.5; }],
  ["wrong strategy", f => { f.order.strategy = "other"; }],
  ["stop above entry", f => { f.order.stop = 101; }],
  ["missing stop", f => { delete f.order.stop; }],
  ["profit below entry", f => { f.order.takeProfit = 99; }],
  ["nonfinite price", f => { f.order.entry = Infinity; }],
  ["disconnected", f => { f.watchlist.connected = false; }],
  ["wrong quote contract", f => { f.watchlist.watchlist[0].conid = "456"; }],
  ["crossed quote", f => { f.watchlist.watchlist[0].marketState.bid = 101; }],
  ["wide spread", f => { f.watchlist.watchlist[0].marketState.bid = 98; }],
  ["slippage", f => { f.order.entry = 101.1; }],
  ["stale bid", f => { f.watchlist.watchlist[0].marketState.bidObservedAt = stamp(-10000); }],
  ["future ask", f => { f.watchlist.watchlist[0].marketState.askObservedAt = stamp(1); }],
  ["malformed bid timestamp", f => { f.watchlist.watchlist[0].marketState.bidObservedAt = "garbage"; }],
  ["frozen quote", f => { f.watchlist.watchlist[0].marketState.marketDataType = 2; }],
  ["delayed quote", f => { f.watchlist.watchlist[0].marketState.marketDataType = 3; }],
  ["duplicate quote", f => { f.watchlist.watchlist.push(f.watchlist.watchlist[0]); }],
];
for (const [name, modify] of cases) test(`risk rejects ${name}`, () => {
  const f = fixture(); modify(f); assert.equal(assessAiEntryRisk(f).ok, false);
});

test("risk rejects untrusted malformed HTTP values without throwing", () => {
  for (const watchlist of [null, undefined, [], {}, "bad", { connected: true, watchlist: [null, 1] }])
    assert.equal(assessAiEntryRisk({ ...fixture(), watchlist }).ok, false);
});
