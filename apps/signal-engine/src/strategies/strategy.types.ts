import type {
  SecType,
  Candle,
  CandleTimeframe,
  DirectionalRegime,
  IndicatorSnapshot,
  PartialTakeProfit,
  Side,
  VolatilityRegime,
} from "@ikbr/shared";
import type { ExposureSnapshot } from "../repository.js";

export type StrategyDirection = "LONG" | "SHORT";

export interface StrategySignal {
  strategyId: string;
  symbol: string;
  side: Exclude<Side, "HOLD">;
  direction: StrategyDirection;
  confidenceScore: number;
  entryReason: string;
  entryOrderType?: "MKT" | "LMT" | "STP";
  invalidationLevel?: number;
  suggestedEntry?: number;
  stopLoss?: number;
  takeProfit?: number;
  /**
   * Optional partial take-profit ladder (price levels). The simulator and
   * execution layers consume this through the corresponding `SignalTicket`
   * field on the resulting `ProposedOrder`.
   */
  partialTakeProfits?: PartialTakeProfit[];
  /**
   * Optional trailing-stop offset in percent (e.g. 1.5). Forwarded to the
   * `SignalTicket.trailingStopPct` field on the resulting `ProposedOrder`.
   */
  trailingStopPct?: number;
  metadata?: Record<string, unknown>;
  generatedFromCandleTs?: Date;
}

export interface StrategyContext {
  symbol: string;
  conid: string;
  secType: SecType;
  directionalRegime: DirectionalRegime;
  volatilityRegime: VolatilityRegime;
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
  side: Exclude<Side, "HOLD">;
  reason: string;
  confidenceScore: number;
  metadata?: Record<string, unknown>;
}

export interface Strategy {
  id: string;
  secTypes: readonly SecType[];
  supportedDirections: readonly StrategyDirection[];
  allowedDirectionalRegimes: readonly DirectionalRegime[];
  allowedVolatilityRegimes: readonly VolatilityRegime[];
  requiredTimeframes: readonly CandleTimeframe[];
  generateSignal(context: StrategyContext): StrategySignal | null;
  shouldExit?(context: ExitContext): ExitSignal | null;
  getLastRejectionReason?(): string | undefined;
}
