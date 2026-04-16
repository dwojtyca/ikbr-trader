export type Side = 'BUY' | 'SELL' | 'HOLD';
export type RiskCheckStatus = 'PASS' | 'REJECT';
export type ProposedOrderStatus = 'PROPOSED' | 'REJECTED' | 'SUBMITTED' | 'FILLED' | 'CANCELLED';
export type AssetClass = 'stock' | 'commodity' | 'index';
export type MarketRegime = 'trend' | 'range' | 'high_volatility';
export type PositionEffect = 'OPEN_OR_ADD' | 'CLOSE_OR_REDUCE';

export interface Candle {
  conid: string;
  symbol: string;
  timeframe: '1m' | '5m' | '1h';
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
  brokerOrderId?: string;
  executionAccountId?: string;
  executionMessage?: string;
  lastError?: string;
  executionAttemptedAt?: Date;
  executedAt?: Date;
  createdAt?: Date;
}
