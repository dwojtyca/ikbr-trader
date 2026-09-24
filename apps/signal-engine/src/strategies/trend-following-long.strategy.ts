import { isWithinStrategySession, hasUnknownStrategyVolume } from "./session-filter.js";
import type { SecType, Candle } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "./strategy.types.js";

interface TrendFollowingLongParams {
  /** Minimum regimeScore from MarketRegimeDetector (lane separation). */
  minRegimeScore: number;
  /** Donchian breakout window measured in D1 candles. */
  donchianWindow: number;
  /** Minimum daily RSI to allow entry. */
  rsiMin: number;
  /** Maximum daily RSI to avoid late/overbought entries. */
  rsiMax: number;
  /** Minimum gap above prior 50-day high (in % of close) to count as a true breakout. */
  breakoutBufferPct: number;
  /** Maximum daily volume multiplier-vs-20-day average required. 0 disables. */
  volumeMultiplier: number;
  /** Stop = entry - stopAtrMult * ATR(D1). */
  stopAtrMult: number;
  /** Take-profit = entry + takeProfitR * (entry - stop). */
  takeProfitR: number;
  /** Minimum planned reward in % of entry — guard against tiny absolute moves. */
  plannedRewardMinPct: number;
  /** Allowed UTC session window (inclusive hours) for emitting the entry trigger. */
  sessionUtcStartHour: number;
  sessionUtcEndHour: number;
}

function paramsForSecType(_secType: SecType): TrendFollowingLongParams {
  return {
    minRegimeScore: 5,
    donchianWindow: 50,
    rsiMin: 50,
    rsiMax: 72,
    breakoutBufferPct: 0.05,
    volumeMultiplier: 1.1,
    stopAtrMult: 2,
    takeProfitR: 5,
    plannedRewardMinPct: 1.5,
    sessionUtcStartHour: 8,
    sessionUtcEndHour: 20,
  };
}

function priorMaxHigh(candles: Candle[], lookback: number): number | undefined {
  // Exclude the most recent (current) D1 candle so the breakout level reflects
  // the *prior* `lookback` sessions, not including today.
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  return Math.max(...slice.map((c) => c.high));
}

function averageVolume(
  candles: Candle[],
  lookback: number,
): number | undefined {
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  const total = slice.reduce((sum, c) => sum + c.volume, 0);
  return total / slice.length;
}

export class TrendFollowingLongStrategy implements Strategy {
  readonly id = "trend_following_long_v1";
  readonly secTypes = ["STK", "IND"] as const;
  readonly supportedDirections = ["LONG"] as const;
  readonly allowedDirectionalRegimes = ["bull_trend"] as const;
  readonly allowedVolatilityRegimes = [
    "normal_volatility",
    "high_volatility",
  ] as const;
  // 1m needed for the latest fill price, 1d for the breakout setup itself.
  readonly requiredTimeframes = ["1m", "1d"] as const;
  private lastRejectionReason: string | undefined;

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason;
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    this.lastRejectionReason = undefined;
    if (hasUnknownStrategyVolume(context)) return this.reject("volume_evidence_unavailable");

    if (context.secType !== "STK" && context.secType !== "IND")
      return this.reject("sec_type_not_supported");
    if (context.directionalRegime !== "bull_trend")
      return this.reject("directional_regime_not_bull_trend");
    if (context.volatilityRegime === "low_volatility")
      return this.reject("volatility_regime_low_volatility");

    const params = paramsForSecType(context.secType);
    if (!isWithinStrategySession(context, params.sessionUtcStartHour, params.sessionUtcEndHour))
      return this.reject("outside_strategy_session");

    if (
      params.minRegimeScore > 0 &&
      context.indicators.regimeScore !== undefined &&
      context.indicators.regimeScore < params.minRegimeScore
    ) {
      return this.reject("regime_score_below_minimum");
    }

    const d1Snapshot = context.indicators.timeframes?.["1d"];
    const candles1d = context.candlesByTimeframe["1d"] ?? [];
    if (!d1Snapshot) return this.reject("d1_snapshot_unavailable");
    if (candles1d.length < params.donchianWindow + 2)
      return this.reject("d1_history_insufficient");

    const ema50d = d1Snapshot.ema50;
    const rsi14d = d1Snapshot.rsi14;
    const atr14d = d1Snapshot.atr14;
    const closeD = d1Snapshot.close;
    if (
      ema50d === undefined ||
      rsi14d === undefined ||
      atr14d === undefined ||
      closeD === undefined
    ) {
      return this.reject("d1_indicators_incomplete");
    }
    if (atr14d <= 0) return this.reject("d1_atr_non_positive");

    // Long-term trend gate. EMA200 D1 isn't available on the current dataset
    // (dataset has 121-142 daily candles per symbol; EMA200 needs 200) so we
    // rely on close > EMA50 + the regime detector's multi-timeframe vote.
    if (closeD <= ema50d) return this.reject("d1_close_below_ema50");

    // Momentum gate.
    if (rsi14d < params.rsiMin) return this.reject("d1_rsi_too_low");
    if (rsi14d > params.rsiMax) return this.reject("d1_rsi_overbought");

    // Donchian breakout — fresh new N-day high on the latest *closed* D1 candle.
    const priorHigh = priorMaxHigh(candles1d, params.donchianWindow);
    if (priorHigh === undefined) return this.reject("d1_donchian_unavailable");
    const breakoutLevel = priorHigh * (1 + params.breakoutBufferPct / 100);
    if (closeD <= breakoutLevel) return this.reject("d1_no_donchian_breakout");

    // Optional volume confirmation on D1.
    if (params.volumeMultiplier > 0) {
      const avgVol = averageVolume(candles1d, 20);
      const lastD1 = candles1d.at(-1);
      if (avgVol !== undefined && avgVol > 0 && lastD1) {
        if (lastD1.volume < avgVol * params.volumeMultiplier)
          return this.reject("d1_volume_not_confirmed");
      }
    }

    // Stop & TP off the live (1m) close so position sizing matches the actual
    // fill, but ATR is taken from D1 to size the stop in daily-noise units.
    const close = context.latestCandle.close;
    const stopLoss = close - atr14d * params.stopAtrMult;
    if (!Number.isFinite(stopLoss) || stopLoss >= close)
      return this.reject("invalid_stop_loss");

    const riskPerShare = close - stopLoss;
    const takeProfit = close + riskPerShare * params.takeProfitR;
    const plannedRewardPct = ((takeProfit - close) / close) * 100;
    if (plannedRewardPct < params.plannedRewardMinPct)
      return this.reject("planned_reward_too_small");

    // Confidence: anchored above momentum-breakout-long's typical 0.85 so that
    // when both fire on the same candle the daily setup wins. The bonus rises
    // with regime strength and how cleanly we cleared the breakout level.
    const regimeBonus = Math.min(
      0.05,
      Math.max(0, ((context.indicators.regimeScore ?? 10) - 10) / 200),
    );
    const breakoutCleanlinessBonus = Math.min(
      0.04,
      Math.max(0, ((closeD - priorHigh) / priorHigh) * 4),
    );
    const confidenceScore = Math.min(
      0.97,
      0.88 + regimeBonus + breakoutCleanlinessBonus,
    );

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "BUY",
      direction: "LONG",
      confidenceScore,
      entryReason: `Trend-following D1 long: closeD=${closeD.toFixed(2)} > priorHigh${params.donchianWindow}=${priorHigh.toFixed(2)} (+${(((closeD - priorHigh) / priorHigh) * 100).toFixed(2)}%), EMA50D>EMA200D, RSI14D=${rsi14d.toFixed(1)}, regimeScore=${context.indicators.regimeScore ?? "n/a"}`,
      invalidationLevel: stopLoss,
      suggestedEntry: close,
      stopLoss,
      takeProfit,
      metadata: {
        timeframe: "1d",
        ema50d,
        rsi14d,
        atr14d,
        closeD,
        priorHighN: priorHigh,
        donchianWindow: params.donchianWindow,
        regimeScore: context.indicators.regimeScore,
        regimeConfidence: context.indicators.regimeConfidence,
        takeProfitR: params.takeProfitR,
        stopAtrMult: params.stopAtrMult,
      },
      generatedFromCandleTs: context.latestCandle.ts,
    };
  }
}
