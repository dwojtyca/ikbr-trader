import type {
  SecType,
  InstrumentSessionIdentity,
  MomentumBreakoutProfile,
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
  /**
   * Optional R-multiple offset for delayed trailing-stop activation.
   * Forwarded to `SignalTicket.trailingStopActivationR`.
   */
  trailingStopActivationR?: number;
  metadata?: Record<string, unknown>;
  generatedFromCandleTs?: Date;
}

export interface VerifiedStrategySession {
  identity: InstrumentSessionIdentity;
  generation: number;
  referenceDate: string;
  start: string;
  end: string;
  sessionStart: string;
  previousSessionCloseTs?: string;
  intervals: readonly { date: string; start: string; end: string }[];
}

export interface StrategyContext {
  verifiedSession?: VerifiedStrategySession;
  momentumBreakoutProfile?: MomentumBreakoutProfile;
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
  entryAt?: Date;
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
  /**
   * Lane priority for portfolio-level conflict resolution. Higher wins when
   * multiple strategies emit a signal for the same symbol on the same tick.
   * Use this to enforce hard lane separation (e.g. an intraday breakout lane
   * should beat a daily swing lane regardless of confidence). Defaults to 0.
   */
  lanePriority?: number;
  generateSignal(context: StrategyContext): StrategySignal | null;
  shouldExit?(context: ExitContext): ExitSignal | null;
  getLastRejectionReason?(): string | undefined;
}
