import { isAaplBound } from '@ikbr/shared';
import { validateWseOrder, type WseMarketMetadata } from "./wse-market-rules.js";
import type { BoundInstrument, ProposedOrder } from "@ikbr/shared";
import type { AccountSnapshot } from "./tws-execution-client.js";

export interface AiEntryRiskLimits {
  maxNotionalPct: number;
  maxStopRiskPct: number;
  maxExposurePct: number;
  aaplUsd?: { maxNotional: number; maxStopRisk: number; feeReserve: number };
  pln?: { maxNotional: number; maxStopRisk: number; feeReserve: number };
}

export interface AiEntryRiskEvidence {
  accountId: string;
  sessionId: string;
  instrumentId: string;
  conid: string;
  assessedAtMs: number;
  validUntilMs: number;
  accountRequestStartedAt: string;
  accountCompletedAt: string;
  bidObservedAt: string;
  askObservedAt: string;
  bid: number;
  ask: number;
  netLiquidation: number;
  availableFunds: number;
  grossPositionValue: number;
  notional: number;
  stopRisk: number;
  quoteCurrency: "USD" | "PLN";
  valuationCurrency: "USD";
  quoteNotional: number;
  quoteStopRisk: number;
  fxToUsd: number;
  fxValuationBuffer: number;
  quoteCashBalance?: number;
  quoteFeeReserve?: number;
  fxSource: "same_currency" | "ib_account_exchange_rate";
  limits: AiEntryRiskLimits;
  wseMetadata?: WseMarketMetadata;
}

const MAX_AGE_MS = 10_000;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

export function assessAiEntryRisk(input: {
  order: ProposedOrder;
  bound: BoundInstrument;
  accountId: string;
  sessionId: string;
  snapshot: AccountSnapshot;
  watchlist: unknown;
  limits: AiEntryRiskLimits;
  nowMs: number;
  wseMetadata?: unknown;
}): { ok: true; evidence: AiEntryRiskEvidence } | { ok: false; reason: string } {
  const { order, bound, accountId, sessionId, snapshot, limits, nowMs } = input;
  const reject = (reason: string) => ({ ok: false as const, reason });
  if (!accountId || !sessionId || !Number.isFinite(nowMs)) return reject("risk_identity_missing");
  if (![limits.maxNotionalPct, limits.maxStopRiskPct, limits.maxExposurePct]
      .every(value => positive(value) && value <= 100))
    return reject("risk_limits_invalid");
  const instrument = bound.instrument;
  const policy = instrument.executionPolicy;
  if (order.instrumentId !== bound.instrumentId || order.conid !== String(bound.conId) ||
      order.instrument !== bound.brokerSymbol || !instrument.trading.executionEnabled)
    return reject("risk_binding_mismatch");
  if ((bound.instrumentId === "aapl_nasdaq" || bound.conId === 265598 || bound.brokerSymbol === "AAPL")
    && !isAaplBound(bound)) return reject("risk_binding_mismatch");
  const isPln = bound.currency === "PLN" && instrument.currency === "PLN" &&
    bound.exchange === "WSE" && instrument.exchange === "WSE";
  if (instrument.assetClass !== "stock" || !(isPln || (bound.currency === "USD" && instrument.currency === "USD")) ||
      order.side !== "BUY" || order.orderType !== "LMT" ||
      (order.positionEffect !== undefined && order.positionEffect !== "OPEN_OR_ADD"))
    return reject("risk_unsupported_shape");
  if (!policy || policy.strategyId !== order.strategy || policy.expectedDirection !== "LONG" ||
      policy.quantityUnit !== "shares" || instrument.risk.quantityUnit !== "shares" ||
      !policy.allowedOrderTypes.includes("LMT") || policy.bracketDisabled === true)
    return reject("risk_policy_mismatch");
  if (!positive(order.quantity) || !Number.isInteger(order.quantity) || order.quantity > 1 ||
      !positive(policy.quantity) || !positive(policy.maxQuantity) || !positive(instrument.risk.maxQuantity) ||
      order.quantity > policy.quantity || order.quantity > policy.maxQuantity || order.quantity > instrument.risk.maxQuantity)
    return reject("risk_quantity_exceeded");
  if (!positive(order.entry) || !positive(order.stop) || !positive(order.takeProfit) ||
      order.stop >= order.entry || order.takeProfit <= order.entry || order.trailingStopPct !== undefined ||
      (order.partialTakeProfits?.length ?? 0) > 0)
    return reject("risk_protection_invalid");
  const account = snapshot.riskEvidence;
  if (snapshot.accountId !== accountId || !account || account.complete !== true || account.configuredBaseCurrency !== "USD")
    return reject("risk_account_incomplete");
  const fresh = (value: unknown): number | undefined => {
    if (typeof value !== "string") return undefined;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && ms <= nowMs && nowMs - ms < MAX_AGE_MS ? ms : undefined;
  };
  const started = fresh(account.requestStartedAt);
  const completed = fresh(account.completedAt);
  if (started === undefined || completed === undefined || started > completed)
    return reject("risk_account_stale");
  const { netLiquidation, availableFunds, grossPositionValue } = account.usdMetrics;
  if (!positive(netLiquidation) || !nonnegative(availableFunds) || !nonnegative(grossPositionValue))
    return reject("risk_account_metrics_invalid");
  const body = record(input.watchlist);
  if (body?.connected !== true || !Array.isArray(body.watchlist)) return reject("risk_market_disconnected");
  const matches = body.watchlist.map(record).filter(row => row?.instrumentId === bound.instrumentId);
  if (matches.length !== 1) return reject("risk_quote_missing");
  const row = matches[0]!;
  const quote = record(row.marketState);
  if (row.conid !== order.conid || row.subscribed !== true || !quote || quote.conid !== order.conid ||
      quote.marketDataType !== 1) return reject("risk_quote_identity_or_live_missing");
  const bidTime = fresh(quote.bidObservedAt);
  const askTime = fresh(quote.askObservedAt);
  if (bidTime === undefined || askTime === undefined) return reject("risk_quote_stale");
  const { bid, ask } = quote;
  if (!positive(bid) || !positive(ask) || ask < bid) return reject("risk_quote_invalid");
  if (!nonnegative(instrument.risk.maxSpread) || !nonnegative(instrument.risk.maxSlippage) ||
      ask - bid > instrument.risk.maxSpread || Math.abs(order.entry - ask) > instrument.risk.maxSlippage)
    return reject("risk_spread_or_slippage_exceeded");
  const quoteNotional = order.entry * order.quantity;
  const quoteStopRisk = (order.entry - order.stop) * order.quantity;
  let fxToUsd = 1;
  const fxValuationBuffer = isPln ? 1.02 : 1;
  let quoteCashBalance: number | undefined;
  let quoteFeeReserve: number | undefined;
  if (isPln) {
    const caps = limits.pln;
    if (!caps || ![caps.maxNotional, caps.maxStopRisk, caps.feeReserve].every(positive))
      return reject("risk_pln_limits_invalid");
    if (account.exchangeRatesToBase?.USD !== 1 || !positive(account.exchangeRatesToBase?.PLN))
      return reject("risk_pln_fx_missing_or_invalid");
    fxToUsd = account.exchangeRatesToBase.PLN;
    quoteCashBalance = account.cashByCurrency?.PLN;
    quoteFeeReserve = caps.feeReserve;
    if (!nonnegative(quoteCashBalance) || !Number.isFinite(quoteNotional + quoteFeeReserve) ||
        quoteNotional + quoteFeeReserve > quoteCashBalance) return reject("risk_pln_cash_insufficient");
    if (quoteNotional > caps.maxNotional) return reject("risk_pln_notional_exceeded");
    if (quoteStopRisk > caps.maxStopRisk) return reject("risk_pln_stop_loss_exceeded");
  }
  if (isAaplBound(bound)) {
    const caps = limits.aaplUsd;
    if (!caps || ![caps.maxNotional, caps.maxStopRisk, caps.feeReserve].every(positive))
      return reject("risk_aapl_limits_invalid");
    quoteCashBalance = account.cashByCurrency?.USD;
    quoteFeeReserve = caps.feeReserve;
    if (!nonnegative(quoteCashBalance) || !Number.isFinite(quoteNotional + quoteFeeReserve)
      || quoteNotional + quoteFeeReserve > quoteCashBalance) return reject("risk_aapl_cash_insufficient");
    if (quoteNotional > caps.maxNotional) return reject("risk_aapl_notional_exceeded");
    if (quoteStopRisk > caps.maxStopRisk) return reject("risk_aapl_stop_loss_exceeded");
  }
  const notional = quoteNotional * fxToUsd * fxValuationBuffer;
  const stopRisk = quoteStopRisk * fxToUsd * fxValuationBuffer;
  if (!positive(notional) || !positive(stopRisk) || !Number.isFinite(grossPositionValue + notional))
    return reject("risk_valuation_invalid");
  if (notional > availableFunds) return reject("risk_available_funds_exceeded");
  if (notional > netLiquidation * (limits.maxNotionalPct / 100)) return reject("risk_notional_exceeded");
  if (stopRisk > netLiquidation * (limits.maxStopRiskPct / 100)) return reject("risk_stop_loss_exceeded");
  if (grossPositionValue + notional > netLiquidation * (limits.maxExposurePct / 100))
    return reject("risk_exposure_exceeded");
  const wse = isPln ? validateWseOrder(input.wseMetadata, bound, accountId, order, nowMs) : undefined;
  if (wse && !wse.ok) return reject(wse.reason);
  return { ok: true, evidence: {
    accountId, sessionId, instrumentId: bound.instrumentId, conid: order.conid,
    assessedAtMs: nowMs, validUntilMs: Math.min(Math.min(started, completed, bidTime, askTime) + MAX_AGE_MS,
      wse?.ok ? wse.expiresAtMs : Infinity),
    ...(wse?.ok ? { wseMetadata: wse.metadata } : {}),
    accountRequestStartedAt: account.requestStartedAt, accountCompletedAt: account.completedAt,
    bidObservedAt: quote.bidObservedAt as string, askObservedAt: quote.askObservedAt as string,
    bid, ask, netLiquidation, availableFunds, grossPositionValue, notional, stopRisk,
    quoteCurrency: isPln ? "PLN" : "USD", valuationCurrency: "USD", quoteNotional, quoteStopRisk,
    fxToUsd, fxValuationBuffer, quoteCashBalance, quoteFeeReserve,
    fxSource: isPln ? "ib_account_exchange_rate" : "same_currency",
    limits: { ...limits, ...(limits.aaplUsd ? { aaplUsd: { ...limits.aaplUsd } } : {}), ...(limits.pln ? { pln: { ...limits.pln } } : {}) },
  } };
}
