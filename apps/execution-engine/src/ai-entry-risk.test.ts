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

function plnFixture() {
  const f = fixture();
  f.bound = { ...f.bound, currency: "PLN", exchange: "WSE", instrument: {
    ...f.bound.instrument, currency: "PLN", exchange: "WSE",
    session: { useRegularTradingHours: true, timezone: "Europe/Warsaw", sessionTemplate: "wse_stock_rth" },
  } };
  f.snapshot.riskEvidence!.exchangeRatesToBase = { USD: 1, PLN: .25 };
  f.snapshot.riskEvidence!.cashByCurrency = { PLN: 500 };
  return { ...f, limits: { ...f.limits, pln: { maxNotional: 500, maxStopRisk: 5, feeReserve: 30 } } };
}

test("PLN risk compares buffered USD valuation and preserves raw PLN evidence", () => {
  const f = plnFixture(); const result = assessAiEntryRisk(f);
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.evidence.quoteCurrency, "PLN");
  assert.equal(result.evidence.valuationCurrency, "USD");
  assert.equal(result.evidence.quoteNotional, 100);
  assert.equal(result.evidence.quoteStopRisk, 1);
  assert.equal(result.evidence.notional, 25.5);
  assert.equal(result.evidence.stopRisk, .255);
  assert.equal(result.evidence.fxToUsd, .25);
  assert.equal(result.evidence.fxValuationBuffer, 1.02);
  assert.equal(result.evidence.quoteFeeReserve, 30);
  assert.equal(result.evidence.quoteCashBalance, 500);
  assert.equal(result.evidence.fxSource, "ib_account_exchange_rate");
  f.limits.pln.maxNotional = 900;
  assert.equal(result.evidence.limits.pln?.maxNotional, 500);
});

type PlnFixture = ReturnType<typeof plnFixture>;
const plnCases: Array<[string, (f: PlnFixture) => void, string]> = [
  ["foreign venue", f => { f.bound = { ...f.bound, exchange: "SMART" }; }, "risk_unsupported_shape"],
  ["wrong registry currency", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument, currency: "USD" } }; }, "risk_unsupported_shape"],
  ["wrong registry venue", f => { f.bound = { ...f.bound, instrument: { ...f.bound.instrument, exchange: "SMART" } }; }, "risk_unsupported_shape"],
  ["missing rates", f => { delete f.snapshot.riskEvidence!.exchangeRatesToBase; }, "risk_pln_fx_missing_or_invalid"],
  ["missing USD parity", f => { delete f.snapshot.riskEvidence!.exchangeRatesToBase!.USD; }, "risk_pln_fx_missing_or_invalid"],
  ["non USD base", f => { f.snapshot.riskEvidence!.configuredBaseCurrency = "PLN"; }, "risk_account_incomplete"],
  ["USD not base", f => { f.snapshot.riskEvidence!.exchangeRatesToBase!.USD = 4; }, "risk_pln_fx_missing_or_invalid"],
  ["missing PLN rate", f => { delete f.snapshot.riskEvidence!.exchangeRatesToBase!.PLN; }, "risk_pln_fx_missing_or_invalid"],
  ["zero FX", f => { f.snapshot.riskEvidence!.exchangeRatesToBase!.PLN = 0; }, "risk_pln_fx_missing_or_invalid"],
  ["negative FX", f => { f.snapshot.riskEvidence!.exchangeRatesToBase!.PLN = -.25; }, "risk_pln_fx_missing_or_invalid"],
  ["NaN FX", f => { f.snapshot.riskEvidence!.exchangeRatesToBase!.PLN = NaN; }, "risk_pln_fx_missing_or_invalid"],
  ["infinite FX", f => { f.snapshot.riskEvidence!.exchangeRatesToBase!.PLN = Infinity; }, "risk_pln_fx_missing_or_invalid"],
  ["cash absent", f => { delete f.snapshot.riskEvidence!.cashByCurrency; }, "risk_pln_cash_insufficient"],
  ["no PLN cash", f => { f.snapshot.riskEvidence!.cashByCurrency = { USD: 10000 }; }, "risk_pln_cash_insufficient"],
  ["cash negative", f => { f.snapshot.riskEvidence!.cashByCurrency!.PLN = -1; }, "risk_pln_cash_insufficient"],
  ["cash excludes fee reserve", f => { f.snapshot.riskEvidence!.cashByCurrency!.PLN = 129.99; }, "risk_pln_cash_insufficient"],
  ["infinite cash", f => { f.snapshot.riskEvidence!.cashByCurrency!.PLN = Infinity; }, "risk_pln_cash_insufficient"],
  ["quote notional cap", f => { f.limits.pln.maxNotional = 99; }, "risk_pln_notional_exceeded"],
  ["quote stop cap", f => { f.limits.pln.maxStopRisk = .99; }, "risk_pln_stop_loss_exceeded"],
  ["invalid cap", f => { f.limits.pln.maxNotional = Infinity; }, "risk_pln_limits_invalid"],
  ["zero fee reserve", f => { f.limits.pln.feeReserve = 0; }, "risk_pln_limits_invalid"],
  ["overflow", f => { f.snapshot.riskEvidence!.exchangeRatesToBase!.PLN = 1e308; }, "risk_valuation_invalid"],
  ["USD available funds", f => { f.snapshot.riskEvidence!.usdMetrics.availableFunds = 25.49; }, "risk_available_funds_exceeded"],
  ["USD notional cap", f => { f.limits.maxNotionalPct = .2549; }, "risk_notional_exceeded"],
  ["USD stop cap", f => { f.limits.maxStopRiskPct = .002549; }, "risk_stop_loss_exceeded"],
  ["USD exposure cap", f => { f.snapshot.riskEvidence!.usdMetrics.grossPositionValue = 2474.51; }, "risk_exposure_exceeded"],
  ["stale account", f => { f.snapshot.riskEvidence!.requestStartedAt = stamp(-10000); }, "risk_account_stale"],
  ["stale BBO", f => { f.watchlist.watchlist[0].marketState.bidObservedAt = stamp(-10000); }, "risk_quote_stale"],
];
for (const [name, modify, reason] of plnCases) test(`PLN rejects ${name}`, () => {
  const f = plnFixture(); modify(f);
  assert.deepEqual(assessAiEntryRisk(f), { ok: false, reason });
});

test("PLN requires explicit server caps; same-currency USD never requires FX or PLN cash", () => {
  const f = plnFixture();
  assert.deepEqual(assessAiEntryRisk({ ...f, limits: fixture().limits }), { ok: false, reason: "risk_pln_limits_invalid" });
  const usd = assessAiEntryRisk(fixture()); assert.equal(usd.ok, true);
  if (usd.ok) { assert.equal(usd.evidence.fxToUsd, 1); assert.equal(usd.evidence.fxSource, "same_currency"); }
});

test("PLN cash and absolute caps accept their exact boundary", () => {
  const f = plnFixture(); f.snapshot.riskEvidence!.cashByCurrency!.PLN = 130;
  f.limits.pln.maxNotional = 100; f.limits.pln.maxStopRisk = 1;
  assert.equal(assessAiEntryRisk(f).ok, true);
});


test("finite account values cannot overflow percentage caps before division", () => {
  const f = plnFixture();
  f.snapshot.riskEvidence!.usdMetrics = { netLiquidation: 9e306, availableFunds: 9e306, grossPositionValue: 0 };
  f.snapshot.riskEvidence!.exchangeRatesToBase!.PLN = 5e304;
  f.limits.maxNotionalPct = 25; f.limits.maxStopRiskPct = 25; f.limits.maxExposurePct = 25;
  assert.deepEqual(assessAiEntryRisk(f), { ok: false, reason: "risk_notional_exceeded" });
  f.limits.maxNotionalPct = 100;
  assert.deepEqual(assessAiEntryRisk(f), { ok: false, reason: "risk_exposure_exceeded" });
  f.limits.maxExposurePct = 100;
  f.limits.pln.maxStopRisk = 99; f.order.stop = 1;
  assert.deepEqual(assessAiEntryRisk(f), { ok: false, reason: "risk_stop_loss_exceeded" });
});
