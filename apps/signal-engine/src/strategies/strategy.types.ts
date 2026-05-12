import type { AssetClass, Candle, CandleTimeframe, IndicatorSnapshot, MarketRegime, Side } from '@ikbr/shared';
import type { ExposureSnapshot } from '../repository.js';

export type StrategyDirection = 'LONG' | 'SHORT';

export interface StrategySignal {
  strategyId: string;
  symbol: string;
  side: Exclude<Side, 'HOLD'>;
  direction: StrategyDirection;
  confidenceScore: number;
  entryReason: string;
  invalidationLevel?: number;
  suggestedEntry?: number;
  stopLoss?: number;
  takeProfit?: number;
  metadata?: Record<string, unknown>;
  generatedFromCandleTs?: Date;
}

export interface StrategyContext {
  symbol: string;
  conid: string;
  assetClass: AssetClass;
  regime: MarketRegime;
  latestCandle: Candle;
  indicators: IndicatorSnapshot;
  candlesByTimeframe: Partial<Record<CandleTimeframe, Candle[]>>;
  marketState?: {
    bid?: number;
    ask?: number;
    lastPrice: number;
    spread?: number;
    ts?: Date | string;
  };
  currentPosition?: {
    quantity: number;
    averageCost?: number;
    marketPrice?: number;
    marketValue?: number;
  };
  exposureSnapshot?: ExposureSnapshot;
}

export interface ExitContext extends StrategyContext {
  entryPrice?: number;
  positionQuantity: number;
}

export interface ExitSignal {
  strategyId: string;
  symbol: string;
  side: Exclude<Side, 'HOLD'>;
  reason: string;
  confidenceScore: number;
  metadata?: Record<string, unknown>;
}

export interface Strategy {
  id: string;
  assetClasses: readonly AssetClass[];
  supportedDirections: readonly StrategyDirection[];
  allowedRegimes: readonly MarketRegime[];
  requiredTimeframes: readonly CandleTimeframe[];
  generateSignal(context: StrategyContext): StrategySignal | null;
  shouldExit?(context: ExitContext): ExitSignal | null;
}
