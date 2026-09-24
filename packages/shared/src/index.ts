export type Side = "BUY" | "SELL" | "HOLD";
export * from "./ibkr-bar-source.js";
export type RiskCheckStatus = "PASS" | "REJECT";
export type ProposedOrderStatus =
  | "PROPOSED"
  | "REJECTED"
  | "SUBMITTED"
  | "FILLED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "EXPIRED";
export type SecType = string;
export type DirectionalRegime =
  // Upside directional bias confirmed by the weighted timeframe trend model.
  | "bull_trend"
  // Downside directional bias confirmed by the weighted timeframe trend model.
  | "bear_trend"
  // No durable directional bias.
  | "range";
export type VolatilityRegime =
  // Volatility is compressed relative to fixed asset-class thresholds.
  | "low_volatility"
  // Volatility is neither compressed nor expanded.
  | "normal_volatility"
  // Volatility is expanded relative to fixed asset-class thresholds.
  | "high_volatility";
export interface TimeframeTrendVotes {
  bullish: number;
  bearish: number;
  neutral: number;
}
export interface RegimeAnalysis {
  directionalRegime: DirectionalRegime;
  volatilityRegime: VolatilityRegime;
  score: number;
  confidence: number;
  reasons: string[];
  timeframeTrendScores: Partial<Record<CandleTimeframe, number>>;
  timeframeTrendVotes: TimeframeTrendVotes;
}
export type PositionEffect = "OPEN_OR_ADD" | "CLOSE_OR_REDUCE";
export type DecisionSource = "signal" | "llm" | "user" | "user_override";
export type AiDecision = "EXECUTE" | "REJECT";
export type CandleTimeframe = "1m" | "5m" | "1h" | "4h" | "12h" | "1d" | "1w";

export interface Candle {
  source?: string;
  conid: string;
  symbol: string;
  timeframe: CandleTimeframe;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketState {
  conid: string;
  symbol: string;
  lastPrice: number;
  bid?: number;
  ask?: number;
  bidObservedAt?: string;
  askObservedAt?: string;
  marketDataType?: number;
  spread?: number;
  ts: Date;
}

export interface InstrumentContract {
  symbol: string;
  conid: string;
  secType: SecType;
  exchange?: string;
  primaryExchange?: string;
  currency?: string;
  localSymbol?: string;
  tradingClass?: string;
  minTick?: number;
  displayName?: string;
  contractJson?: Record<string, unknown>;
  detailsJson?: Record<string, unknown>;
  source: "ibkr" | "override_fallback";
  resolvedAt?: Date;
}

/**
 * Optional intermediate take-profit level for scaling out of a position.
 * `fraction` of the ORIGINAL filled quantity is closed at `price`. Remaining
 * quantity continues toward the main `takeProfit` (or stop). Multiple levels
 * are supported (e.g. 1/3 at 1R, 1/3 at 2R, 1/3 runner).
 */
export interface PartialTakeProfit {
  fraction: number;
  price: number;
}

export interface SignalTicket {
  instrument: string;
  /**
   * PR15.2 — optional logical instrument id from the shared
   * `InstrumentRegistry`. Required by the Phase 2 write endpoint
   * `POST /execution/execute-ticket` so execution-engine can
   * resolve the authoritative binding server-side and verify
   * `instrument`/`conid` identity. Legacy paths (llm-agent
   * proposal → `/execution/execute-proposed/:id`, backtest ticket
   * simulator, older `proposed_orders` rows) omit it and keep
   * working — `instrument_id IS NULL` is a first-class legacy
   * state. Deliberately excluded from `computeClientOrderHash`
   * (v1) so legacy hashes still validate; execution-engine
   * checks identity by comparing the persisted `instrument_id`
   * against the payload directly.
   */
  instrumentId?: string;
  conid?: string;
  side: Side;
  positionEffect?: PositionEffect;
  orderType: "MKT" | "LMT" | "STP";
  quantity: number;
  entry?: number;
  stop?: number;
  takeProfit?: number;
  /**
   * Optional partial take-profit ladder. Currently honoured by the backtest
   * simulator only; the live execution-engine treats this as advisory metadata
   * until the cascade-resize support is implemented (parent `takeProfit` keeps
   * the legacy single-target behaviour in live).
   */
  partialTakeProfits?: PartialTakeProfit[];
  /**
   * Optional trailing-stop offset, expressed in percent of the last price
   * (e.g. 1.5 for 1.5%). When set, the bracket's protective stop child is
   * placed as an IBKR `TRAIL` order with `trailingPercent = trailingStopPct`
   * and `trailStopPrice = stop` (the initial stop). The backtest simulator
   * mirrors this by ratcheting the in-memory stop up to
   * `peakPrice * (1 - trailingStopPct/100)` (long) on each candle.
   */
  trailingStopPct?: number;
  /**
   * Optional R-multiple offset that delays trailing-stop activation until
   * unrealized profit reaches `entry + activationR * (entry - initialStop)`
   * (long). Until then the protective stop stays at `initialStop`. Once
   * activated, the trail follows `trailingStopPct` rules from the highest
   * price seen since activation. Live execution-engine currently logs a
   * warning and falls back to plain trailing/static stop because IBKR's
   * `ib@0.2.x` lacks native Adjustable Order support; backtest fully
   * implements the activation gate.
   */
  trailingStopActivationR?: number;
  reason: string;
  confidence: number;
  timestamp: string;
  riskCheckStatus: RiskCheckStatus;
  indicators?: IndicatorSnapshot;
}

export interface IndicatorSnapshot {
  strategyPriceEvidence?: import("./wse-market-rules.js").WseStrategyPriceEvidence;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  sma200?: number;
  rsi14?: number;
  rsi14Prev?: number;
  atr14?: number;
  macdLine?: number;
  macdSignal?: number;
  macdHist?: number;
  macdHistPrev?: number;
  macdHistPrev2?: number;
  adx14?: number;
  cmf20?: number;
  cmf20Prev?: number;
  mfi14?: number;
  mfi14Prev?: number;
  bbUpper?: number;
  bbMiddle?: number;
  bbLower?: number;
  bbWidthPct?: number;
  dcUpper20?: number;
  dcLower20?: number;
  obvSlope?: number;
  return5mPct?: number;
  return20mPct?: number;
  return60mPct?: number;
  trendFilterValue?: number;
  trendFilterSource?: "EMA50_1h" | "EMA200_1m";
  secType?: SecType;
  directionalRegime?: DirectionalRegime;
  volatilityRegime?: VolatilityRegime;
  regimeScore?: number;
  regimeConfidence?: number;
  regimeReasons?: string[];
  timeframeTrendScores?: Partial<Record<CandleTimeframe, number>>;
  timeframeTrendVotes?: TimeframeTrendVotes;
  strategyProfile?: string;
  /**
   * Intraday session metadata derived from 1m candles. Populated by the
   * SignalEngine before strategies run. Optional because some symbols may
   * not have a clear session boundary (e.g. 24/7 instruments).
   */
  intraday?: IntradaySessionSnapshot;
  timeframes?: Partial<
    Record<Exclude<CandleTimeframe, "1m">, TimeframeIndicatorSnapshot>
  >;
}

export interface IntradaySessionSnapshot {
  /** Close of the previous trading session (last candle before today's session gap). */
  prevSessionClose?: number;
  /** Open of the first candle of the current session. */
  sessionOpen?: number;
  /** Timestamp of the first candle of the current session. */
  sessionOpenTs?: Date | string;
  /** Number of minutes elapsed since session open at the latest candle. */
  minutesSinceSessionOpen?: number;
  /** Overnight gap pct: (sessionOpen - prevSessionClose) / prevSessionClose * 100. */
  gapPct?: number;
  /** High of the first 30 minutes of the session (opening range). */
  openingRange30High?: number;
  /** Low of the first 30 minutes of the session (opening range). */
  openingRange30Low?: number;
  /** Session VWAP using typical price ((H+L+C)/3) weighted by volume. */
  vwap?: number;
  /** Distance of latest close from session VWAP, in basis points (signed). */
  distanceFromVwapBps?: number;
  /** Cumulative volume since session open. */
  sessionVolume?: number;
}

export interface TimeframeIndicatorSnapshot {
  close?: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  sma200?: number;
  rsi14?: number;
  atr14?: number;
  macdHist?: number;
  macdHistPrev?: number;
  macdHistPrev2?: number;
  adx14?: number;
  cmf20?: number;
  mfi14?: number;
  bbWidthPct?: number;
  volume?: number;
  trend?: "bullish" | "bearish" | "neutral";
  priceVsEma50Bps?: number;
  ema50Slope10Pct?: number;
  return3Pct?: number;
  return4Pct?: number;
  return12Pct?: number;
  return18Pct?: number;
  return20Pct?: number;
  return24Pct?: number;
  return30Pct?: number;
  return48Pct?: number;
}

export interface RiskLimits {
  accountEquity: number;
  /**
   * Hard ceiling on risk per single trade as a percentage of equity.
   * The engine guarantees that no single trade risks more than this,
   * regardless of per-strategy quantityFactor.
   */
  maxRiskPerTradePct: number;
  /**
   * Optional baseline target risk per trade as a percentage of equity.
   * If unset, defaults to `maxRiskPerTradePct` (preserves legacy behavior
   * where strategies sized to the cap).
   * Per-strategy `quantityFactor` scales THIS target, then the result is
   * clamped to `maxRiskPerTradePct`. This prevents quantityFactor > 1 from
   * silently breaching the global per-trade risk cap.
   */
  targetRiskPerTradePct?: number;
  maxExposurePct: number;
  maxNotionalPerTradePct?: number;
  maxOpenPositions: number;
}

export interface ProposedOrder extends SignalTicket {
  id?: number;
  status: ProposedOrderStatus;
  strategy?: string;
  decisionSource?: DecisionSource;
  aiDecision?: AiDecision;
  aiReason?: string;
  aiModel?: string;
  aiDecisionConfidence?: number;
  llmDecisionId?: number;
  sourceError?: string;
  brokerOrderId?: string;
  executionAccountId?: string;
  executionMessage?: string;
  lastError?: string;
  executionAttemptedAt?: Date;
  executedAt?: Date;
  createdAt?: Date;
  generatedFromCandleTs?: Date;
  lifecycleReason?: string;
  supersededByOrderId?: number;
  brokerWarning?: string;
  cancelReasonCode?:
    | "submitted_timeout"
    | "locate_held"
    | "broker_not_ready"
    | "broker_rejected"
    | "manual_cancel"
    | "unknown";
  cancelReasonDetail?: string;
}

function normalizeDiagnosticText(value?: string | null): string {
  return String(value ?? "").trim();
}

function isGenericBrokerStatusMessage(value: string): boolean {
  return /^Broker order status update: (PRESUBMITTED|SUBMITTED|PENDINGSUBMIT|PENDINGCANCEL|CANCELLED|APICANCELLED|INACTIVE|FILLED)\b/i.test(
    value,
  );
}

export function deriveOrderDiagnostics(
  order: Pick<
    ProposedOrder,
    "status" | "executionMessage" | "lastError" | "sourceError" | "aiReason"
  >,
): Pick<
  ProposedOrder,
  "brokerWarning" | "cancelReasonCode" | "cancelReasonDetail"
> {
  const candidates = [
    normalizeDiagnosticText(order.lastError),
    normalizeDiagnosticText(order.executionMessage),
    normalizeDiagnosticText(order.sourceError),
    normalizeDiagnosticText(order.aiReason),
  ].filter(Boolean);

  const warningSource = candidates.find((value) =>
    /will not be placed at the exchange until/i.test(value),
  );
  const brokerWarning = warningSource
    ? (warningSource.match(/Order Message:\s*(.+)$/i)?.[1]?.trim() ??
      warningSource)
    : undefined;

  if (order.status !== "CANCELLED") {
    return { brokerWarning };
  }

  const specific =
    candidates.find((value) => !isGenericBrokerStatusMessage(value)) ??
    candidates[0];
  const detail = specific || undefined;
  const text = (detail ?? "").toLowerCase();

  let cancelReasonCode: ProposedOrder["cancelReasonCode"] = "unknown";
  if (text.includes("submitted-timeout")) {
    cancelReasonCode = "submitted_timeout";
  } else if (
    text.includes("locate-held") ||
    text.includes("securities are located")
  ) {
    cancelReasonCode = "locate_held";
  } else if (text.includes("will not be placed at the exchange until")) {
    cancelReasonCode = "broker_not_ready";
  } else if (text.includes("cancel requested orderid=")) {
    cancelReasonCode = "manual_cancel";
  } else if (
    text.includes("broker rejected order") ||
    text.includes("was not accepted by broker")
  ) {
    cancelReasonCode = "broker_rejected";
  }

  return {
    brokerWarning,
    cancelReasonCode,
    cancelReasonDetail: detail,
  };
}

export * from "./strategy-profiles.js";
export * from "./instruments/types.js";
export { InstrumentRegistry } from "./instruments/registry.js";
export {
  INSTRUMENT_DEFINITIONS,
  defaultInstrumentRegistry,
} from "./instruments/definitions.js";
export {
  InstrumentBindingAuthority,
  buildInstrumentBindingAuthority,
  parseInstrumentBindings,
  MIN_TICK_EPSILON,
  tickSizesEqual,
  mapAssetClassToIbkrSecType,
} from "./instruments/bindings.js";
export type {
  BoundInstrument,
  InstrumentBinding,
  InstrumentBindingParseError,
  InstrumentBindingParseResult,
} from "./instruments/bindings.js";
export * from "./market-context/index.js";
export * from "./decision-engine/index.js";
export * from "./risk-engine/index.js";
export * from "./signal-engine/index.js";
export * from "./execution-ticket/index.js";
export * from "./trading-pipeline/index.js";

export * from "./wse-market-rules.js";

export { buildConfiguredInstrumentRegistry } from "./instruments/configured-registry.js";

export * from "./wse-candles.js";

export { isAaplBound } from './instruments/aapl.js';

export * from "./aapl-candles.js";
