import type { SecType, Candle } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "./strategy.types.js";

interface MomentumBreakoutParams {
  dailyReturn20MinPct: number;
  h1Return4MinPct: number;
  return20MaxPct: number;
  return60MinPct: number;
  return60MaxPct: number;
  consolidationDriftMaxPct: number;
  rsiMax: number;
  bbWidthMaxPct: number;
  volumeMultiplier: number;
  closeLocationMin: number;
  bodyMin: number;
  upperWickMax: number;
  plannedRewardMinPct: number;
  stopAtrMult: number;
  structureStopAtrMult: number;
  takeProfitR: number;
  sessionUtcStartHour: number;
  sessionUtcEndHour: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function localConsolidationLow(
  candles: Candle[],
  lookback: number,
): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  return Math.min(...slice.map((candle) => candle.low));
}

function averageVolume(
  candles: Candle[],
  lookback: number,
): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  const total = slice.reduce((sum, candle) => sum + candle.volume, 0);
  return total / slice.length;
}

function previousHigh(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  return Math.max(...slice.map((candle) => candle.high));
}

function consolidationDriftPct(
  candles: Candle[],
  lookback: number,
): number | undefined {
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  const firstClose = slice[0]?.close;
  const lastClose = slice.at(-1)?.close;
  if (
    firstClose === undefined ||
    lastClose === undefined ||
    !Number.isFinite(firstClose) ||
    !Number.isFinite(lastClose) ||
    firstClose <= 0
  )
    return undefined;
  return ((lastClose - firstClose) / firstClose) * 100;
}

function paramsForSecType(secType: SecType): MomentumBreakoutParams {
  return {
    dailyReturn20MinPct: 8,
    h1Return4MinPct: 1,
    return20MaxPct: 1.2,
    return60MinPct: 0.2,
    return60MaxPct: 3,
    consolidationDriftMaxPct: 0.8,
    rsiMax: 72,
    bbWidthMaxPct: 0.08,
    // Stage 8: real breakouts come with real volume; 0.95x avg let in noise breakouts.
    volumeMultiplier: 1.2,
    closeLocationMin: 0.6,
    bodyMin: 0.12,
    upperWickMax: 0.45,
    plannedRewardMinPct: 0.6,
    stopAtrMult: 2,
    structureStopAtrMult: 3,
    takeProfitR: 5,
    sessionUtcStartHour: 8,
    sessionUtcEndHour: 20,
  };
}

function utcHour(ts: Date | string): number {
  return new Date(ts).getUTCHours();
}

function isWithinUtcSession(
  ts: Date | string,
  startHour: number,
  endHour: number,
): boolean {
  const hour = utcHour(ts);
  return hour >= startHour && hour <= endHour;
}

function candleQuality(candle: Candle): {
  closeLocationPct: number;
  bodyPct: number;
  upperWickPct: number;
  bullishBody: boolean;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 0) {
    return {
      closeLocationPct: 0,
      bodyPct: 0,
      upperWickPct: 1,
      bullishBody: false,
    };
  }

  const bodyHigh = Math.max(candle.open, candle.close);
  return {
    closeLocationPct: (candle.close - candle.low) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    upperWickPct: (candle.high - bodyHigh) / range,
    bullishBody: candle.close > candle.open,
  };
}

export class MomentumBreakoutLongStrategy implements Strategy {
  readonly id = "momentum_breakout_long_v1";
  readonly secTypes = ["STK", "IND"] as const;
  readonly supportedDirections = ["LONG"] as const;
  readonly allowedDirectionalRegimes = ["bull_trend"] as const;
  readonly allowedVolatilityRegimes = [
    "normal_volatility",
    "high_volatility",
  ] as const;
  readonly requiredTimeframes = ["1m", "1h", "4h", "1d"] as const;
  private lastRejectionReason: string | undefined;

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason;
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    this.lastRejectionReason = undefined;

    if (context.secType !== "STK" && context.secType !== "IND")
      return this.reject("sec_type_not_supported");
    if (context.directionalRegime !== "bull_trend")
      return this.reject("directional_regime_not_bull_trend");
    if (context.volatilityRegime === "low_volatility")
      return this.reject("volatility_regime_low_volatility");

    const params = paramsForSecType(context.secType);
    if (
      !isWithinUtcSession(
        context.latestCandle.ts,
        params.sessionUtcStartHour,
        params.sessionUtcEndHour,
      )
    ) {
      return this.reject("outside_strategy_session");
    }

    const { indicators, latestCandle } = context;
    const close = latestCandle.close;
    const ema20 = indicators.ema20;
    const ema50 = indicators.ema50;
    const ema200 = indicators.ema200;
    const rsi14 = indicators.rsi14;
    const atr14 = indicators.atr14;
    const donchianUpper = indicators.dcUpper20;

    if (
      ema20 === undefined ||
      ema50 === undefined ||
      ema200 === undefined ||
      rsi14 === undefined ||
      atr14 === undefined ||
      donchianUpper === undefined
    ) {
      return this.reject("missing_required_indicators");
    }

    const h1 = indicators.timeframes?.["1h"];
    const h4 = indicators.timeframes?.["4h"];
    const d1 = indicators.timeframes?.["1d"];
    if (!h1 || !h4 || !d1) return this.reject("higher_timeframe_unavailable");
    if (h1.trend === "bearish")
      return this.reject("higher_timeframe_1h_bearish");
    if (h4.trend === "bearish")
      return this.reject("higher_timeframe_4h_bearish");
    if (d1.trend === "bearish")
      return this.reject("higher_timeframe_1d_bearish");
    if ((d1.return20Pct ?? 0) < params.dailyReturn20MinPct)
      return this.reject("daily_momentum_too_weak");
    if ((h1.return4Pct ?? 0) < params.h1Return4MinPct)
      return this.reject("hourly_momentum_too_weak");

    if (close <= ema200) return this.reject("close_below_ema200");
    if (close <= ema50) return this.reject("close_below_ema50");
    if (ema20 <= ema50) return this.reject("ema20_not_above_ema50");
    if (rsi14 >= params.rsiMax) return this.reject("rsi_overheated");
    // Stage 8: require RSI to still be rising (momentum continuation, not exhaustion).
    if (indicators.rsi14Prev !== undefined && rsi14 <= indicators.rsi14Prev)
      return this.reject("rsi_not_rising");
    if ((indicators.return20mPct ?? 0) > params.return20MaxPct)
      return this.reject("overextended_20m");
    if ((indicators.return60mPct ?? 0) > params.return60MaxPct)
      return this.reject("overextended_60m");
    if ((indicators.return60mPct ?? 0) < params.return60MinPct)
      return this.reject("intraday_momentum_too_weak");
    if (
      indicators.bbWidthPct !== undefined &&
      indicators.bbWidthPct > params.bbWidthMaxPct
    )
      return this.reject("volatility_not_compressed");

    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    const priorHigh20 = previousHigh(candles1m, 20);
    if (priorHigh20 === undefined) return this.reject("prior_high_unavailable");
    const breakoutBuffer = Math.max(atr14 * 0.015, close * 0.00025);
    const confirmedBreakout20 = close >= priorHigh20 + breakoutBuffer;
    if (!confirmedBreakout20) return this.reject("no_confirmed_breakout");
    const preBreakoutDriftPct = consolidationDriftPct(candles1m, 20);
    if (preBreakoutDriftPct === undefined)
      return this.reject("consolidation_drift_unavailable");
    if (preBreakoutDriftPct > params.consolidationDriftMaxPct)
      return this.reject("pre_breakout_drift_too_high");

    const previousAverageVolume = averageVolume(candles1m.slice(0, -1), 20);
    if (previousAverageVolume === undefined || previousAverageVolume <= 0)
      return this.reject("volume_baseline_unavailable");
    if (latestCandle.volume < previousAverageVolume * params.volumeMultiplier)
      return this.reject("volume_not_confirmed");

    const quality = candleQuality(latestCandle);
    if (!quality.bullishBody) return this.reject("breakout_candle_not_bullish");
    if (quality.closeLocationPct < params.closeLocationMin)
      return this.reject("breakout_close_not_near_high");
    if (quality.bodyPct < params.bodyMin)
      return this.reject("breakout_body_too_small");
    if (quality.upperWickPct > params.upperWickMax)
      return this.reject("breakout_upper_wick_too_large");

    const consolidationLow = localConsolidationLow(candles1m, 20);
    const atrStop = close - atr14 * params.stopAtrMult;
    const structureStop =
      consolidationLow !== undefined && consolidationLow < close
        ? Math.max(
            consolidationLow,
            close - atr14 * params.structureStopAtrMult,
          )
        : undefined;
    const stopLoss = Math.min(atrStop, structureStop ?? atrStop);
    if (!Number.isFinite(stopLoss) || stopLoss >= close)
      return this.reject("invalid_stop_loss");

    const riskPerShare = close - stopLoss;
    const takeProfit = close + riskPerShare * params.takeProfitR;
    const plannedRewardPct = ((takeProfit - close) / close) * 100;
    if (plannedRewardPct < params.plannedRewardMinPct)
      return this.reject("planned_reward_too_small");

    const trendScore = clamp(((ema20 - ema50) / close) * 150, 0, 0.18);
    const breakoutScore = clamp(
      ((close - priorHigh20) / close) * 3500,
      0,
      0.12,
    );
    const rsiScore =
      rsi14 >= 55 && rsi14 < params.rsiMax ? 0.1 : rsi14 > 50 ? 0.06 : 0;
    const compressionScore =
      indicators.bbWidthPct !== undefined
        ? clamp(
            (params.bbWidthMaxPct - indicators.bbWidthPct) /
              params.bbWidthMaxPct,
            0,
            1,
          ) * 0.08
        : 0.03;
    const confidenceScore = clamp(
      0.58 + trendScore + breakoutScore + rsiScore + compressionScore,
      0,
      0.88,
    );
    const entryMode = "breakout_20";

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "BUY",
      direction: "LONG",
      confidenceScore,
      entryReason: `Momentum breakout long: mode=${entryMode}, close=${close.toFixed(2)}, priorHigh20=${priorHigh20.toFixed(2)}, EMA50/EMA200 aligned, RSI14=${rsi14.toFixed(1)}, h1=${h1.trend}, h4=${h4.trend}, d1=${d1.trend}`,
      invalidationLevel: stopLoss,
      suggestedEntry: close,
      stopLoss,
      takeProfit,
      // Trailing-stop infrastructure (trailingStopPct -> live IBKR TRAIL +
      // simulator peak/trough ratchet) is wired end-to-end. Tested at 1.5%
      // on this strategy: run #22 = $1840.70 vs baseline #21 = $2406.40
      // (-23.5%). Winners on momentum_breakout_long_v1 run all the way to
      // the +4R take-profit and a 1.5% trail clips them on intraday wicks
      // (stop hits 153 vs baseline; TP hits dropped). Left disabled here
      // until a different strategy/regime warrants it.
      // trailingStopPct: 1.5,
      // NOTE: partial take-profit infrastructure (PartialTakeProfit) is wired
      // through the simulator + live ProposedOrder pipeline, but for this
      // strategy every tested ladder (50%/+2R, 33%/+2R, 50%/+3R) regressed
      // on the dataset because winners overwhelmingly run to the +4R target.
      // Left disabled until a different strategy/regime warrants it.
      // partialTakeProfits: [
      //   { fraction: 0.33, price: close + riskPerShare * 1 }, // +1R
      //   { fraction: 0.33, price: close + riskPerShare * 2 }, // +2R
      // ],
      metadata: {
        ema20,
        ema50,
        ema200,
        atr14,
        rsi14,
        donchianUpper,
        priorHigh20,
        breakoutBuffer,
        preBreakoutDriftPct,
        consolidationDriftMaxPct: params.consolidationDriftMaxPct,
        entryMode,
        confirmedBreakout20,
        bbWidthPct: indicators.bbWidthPct,
        previousAverageVolume,
        requiredVolumeMultiplier: params.volumeMultiplier,
        latestVolume: latestCandle.volume,
        breakoutCloseLocationPct: quality.closeLocationPct,
        breakoutBodyPct: quality.bodyPct,
        breakoutUpperWickPct: quality.upperWickPct,
        plannedRewardPct,
        stopAtrMult: params.stopAtrMult,
        structureStopAtrMult: params.structureStopAtrMult,
        takeProfitR: params.takeProfitR,
        sessionUtcStartHour: params.sessionUtcStartHour,
        sessionUtcEndHour: params.sessionUtcEndHour,
        directionalRegime: indicators.directionalRegime,
        volatilityRegime: indicators.volatilityRegime,
        regimeScore: indicators.regimeScore,
        regimeConfidence: indicators.regimeConfidence,
        h1Trend: h1.trend,
        h4Trend: h4.trend,
        d1Trend: d1.trend,
        d1Return20Pct: d1.return20Pct,
        consolidationLow,
      },
      generatedFromCandleTs: context.latestCandle.ts,
    };
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }
}
