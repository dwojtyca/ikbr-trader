export type Side = 'BUY' | 'SELL' | 'HOLD';
export type RiskCheckStatus = 'PASS' | 'REJECT';
export type ProposedOrderStatus =
  | 'PROPOSED'
  | 'REJECTED'
  | 'SUBMITTED'
  | 'FILLED'
  | 'CANCELLED'
  | 'SUPERSEDED'
  | 'EXPIRED';
export type AssetClass = 'stock' | 'commodity' | 'index';
export type MarketRegime = 'trend' | 'range' | 'high_volatility';
export type PositionEffect = 'OPEN_OR_ADD' | 'CLOSE_OR_REDUCE';
export type DecisionSource = 'signal' | 'llm' | 'user' | 'user_override';
export type AiDecision = 'EXECUTE' | 'REJECT';
export type CandleTimeframe = '1m' | '5m' | '1h' | '4h' | '12h' | '1d';

export interface Candle {
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
  spread?: number;
  ts: Date;
}

export interface SignalTicket {
  instrument: string;
  conid?: string;
  side: Side;
  positionEffect?: PositionEffect;
  orderType: 'MKT' | 'LMT';
  quantity: number;
  entry?: number;
  stop?: number;
  takeProfit?: number;
  reason: string;
  confidence: number;
  timestamp: string;
  riskCheckStatus: RiskCheckStatus;
  indicators?: IndicatorSnapshot;
}

export interface IndicatorSnapshot {
  ema20?: number;
  ema50?: number;
  ema200?: number;
  rsi14?: number;
  rsi14Prev?: number;
  atr14?: number;
  macdLine?: number;
  macdSignal?: number;
  macdHist?: number;
  macdHistPrev?: number;
  bbUpper?: number;
  bbMiddle?: number;
  bbLower?: number;
  bbWidthPct?: number;
  dcUpper20?: number;
  dcLower20?: number;
  obvSlope?: number;
  trendFilterValue?: number;
  trendFilterSource?: 'EMA50_1h' | 'EMA200_1m';
  assetClass?: AssetClass;
  regime?: MarketRegime;
  strategyProfile?: string;
  timeframes?: Partial<Record<Exclude<CandleTimeframe, '1m'>, TimeframeIndicatorSnapshot>>;
}

export interface TimeframeIndicatorSnapshot {
  close?: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  rsi14?: number;
  atr14?: number;
  macdHist?: number;
  bbWidthPct?: number;
  volume?: number;
  trend?: 'bullish' | 'bearish' | 'neutral';
  priceVsEma50Bps?: number;
}

export interface RiskLimits {
  accountEquity: number;
  maxRiskPerTradePct: number;
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
    | 'submitted_timeout'
    | 'locate_held'
    | 'broker_not_ready'
    | 'broker_rejected'
    | 'manual_cancel'
    | 'unknown';
  cancelReasonDetail?: string;
}

function normalizeDiagnosticText(value?: string | null): string {
  return String(value ?? '').trim();
}

function isGenericBrokerStatusMessage(value: string): boolean {
  return /^Broker order status update: (PRESUBMITTED|SUBMITTED|PENDINGSUBMIT|PENDINGCANCEL|CANCELLED|APICANCELLED|INACTIVE|FILLED)\b/i.test(
    value
  );
}

export function deriveOrderDiagnostics(order: Pick<
  ProposedOrder,
  'status' | 'executionMessage' | 'lastError' | 'sourceError' | 'aiReason'
>): Pick<ProposedOrder, 'brokerWarning' | 'cancelReasonCode' | 'cancelReasonDetail'> {
  const candidates = [
    normalizeDiagnosticText(order.lastError),
    normalizeDiagnosticText(order.executionMessage),
    normalizeDiagnosticText(order.sourceError),
    normalizeDiagnosticText(order.aiReason)
  ].filter(Boolean);

  const warningSource = candidates.find((value) => /will not be placed at the exchange until/i.test(value));
  const brokerWarning = warningSource
    ? warningSource.match(/Order Message:\s*(.+)$/i)?.[1]?.trim() ?? warningSource
    : undefined;

  if (order.status !== 'CANCELLED') {
    return { brokerWarning };
  }

  const specific = candidates.find((value) => !isGenericBrokerStatusMessage(value)) ?? candidates[0];
  const detail = specific || undefined;
  const text = (detail ?? '').toLowerCase();

  let cancelReasonCode: ProposedOrder['cancelReasonCode'] = 'unknown';
  if (text.includes('submitted-timeout')) {
    cancelReasonCode = 'submitted_timeout';
  } else if (text.includes('locate-held') || text.includes('securities are located')) {
    cancelReasonCode = 'locate_held';
  } else if (text.includes('will not be placed at the exchange until')) {
    cancelReasonCode = 'broker_not_ready';
  } else if (text.includes('cancel requested orderid=')) {
    cancelReasonCode = 'manual_cancel';
  } else if (text.includes('broker rejected order') || text.includes('was not accepted by broker')) {
    cancelReasonCode = 'broker_rejected';
  }

  return {
    brokerWarning,
    cancelReasonCode,
    cancelReasonDetail: detail
  };
}

export * from './strategy-profiles.js';
export * from './strategy-allowlist.js';
