import type { Candle, IndicatorSnapshot, PartialTakeProfit, ProposedOrder, Side } from '@ikbr/shared';

export interface BacktestDataset {
  id: number;
  dateFrom: string;
  dateTo: string;
  status: string;
  symbols: string[];
  candlesCount: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface BacktestRun {
  id: number;
  datasetId: number;
  mode: 'bot' | 'isolated';
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  totalPnl?: number;
  trades?: number;
  winRate?: number;
  progressCurrent?: number;
  progressTotal?: number;
  progressLabel?: string;
  progressUpdatedAt?: string;
}

export interface BacktestOrderRecord {
  runId: number;
  instrument: string;
  conid?: string;
  side: Side;
  positionEffect?: 'OPEN_OR_ADD' | 'CLOSE_OR_REDUCE';
  orderType: 'MKT' | 'LMT' | 'STP';
  quantity: number;
  entry?: number;
  stop?: number;
  takeProfit?: number;
  reason: string;
  confidence: number;
  riskCheckStatus: 'PASS' | 'REJECT';
  status: ProposedOrder['status'];
  strategy?: string;
  indicatorSnapshot?: IndicatorSnapshot;
  partialTakeProfits?: PartialTakeProfit[];
  generatedFromCandleTs?: Date;
  createdAt: Date;
}

export interface BacktestFillRecord {
  runId: number;
  orderId: number;
  instrument: string;
  conid?: string;
  strategy: string;
  side: Side;
  directionalRegime: string;
  volatilityRegime: string;
  confidence: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryAt: Date;
  exitAt: Date;
  grossPnl: number;
  commission: number;
  netPnl: number;
  pnlPct: number;
  exitReason: string;
}

export interface BacktestSignalDiagnosticRecord {
  runId: number;
  strategy: string;
  instrument: string;
  side: string;
  stage: string;
  reasonGroup: string;
  samples: number;
}

export interface BacktestFxRate {
  date: string;
  baseCurrency: string;
  quoteCurrency: string;
  rateToBase: number;
  source: string;
}

export interface BacktestCandleSymbolSummary {
  symbol: string;
  candles: number;
  firstTs?: string;
  lastTs?: string;
}

export interface LoadedBacktestData {
  dataset: BacktestDataset;
  candles1m: Candle[];
  candles5m: Candle[];
  candles1h: Candle[];
  candles4h: Candle[];
  candles12h: Candle[];
  candles1d: Candle[];
  candles1w: Candle[];
  fxRates: BacktestFxRate[];
}
