import type { Candle, SecType } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "./strategy.types.js";

interface MomentumBreakdownParams {
  dailyReturn20MaxPct: number;
  h1Return4MaxPct: number;
  return20MinPct: number;
  return60MinPct: number;
  return60MaxPct: number;
  consolidationDriftMinPct: number;
  rsiMin: number;
  bbWidthMaxPct: number;
  volumeMultiplier: number;
  closeLocationMin: number;
  bodyMin: number;
  lowerWickMax: number;
  plannedRewardMinPct: number;
  stopAtrMult: number;
  structureStopAtrMult: number;
  takeProfitR: number;
  h4RsiMax: number;
  sessionUtcStartHour: number;
  sessionUtcEndHour: number;
  maxDistanceBelowEma20Pct: number;
  maxDistanceBelowEma50Pct: number;
  adxMin: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function localConsolidationHigh(
  candles: Candle[],
  lookback: number,
): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  return Math.max(...slice.map((candle) => candle.high));
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

function previousLow(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  return Math.min(...slice.map((candle) => candle.low));
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

function paramsForSecType(_secType: SecType): MomentumBreakdownParams {
  return {
    dailyReturn20MaxPct: -8,
    // Stage 7: stronger 4h hourly context required.
    h1Return4MaxPct: -1.5,
    return20MinPct: -1.2,
    return60MinPct: -3,
    return60MaxPct: -0.2,
    consolidationDriftMinPct: -0.8,
    rsiMin: 28,
    bbWidthMaxPct: 0.08,
    // Stage 9: bumped 1.3 → 1.5 — only real sell-offs survive (cuts commission drag).
    volumeMultiplier: 1.5,
    closeLocationMin: 0.6,
    bodyMin: 0.12,
    lowerWickMax: 0.45,
    // Stage 9: bumped 1.0 → 1.4% — must clear ~0.13% commish + leave room for drift.
    plannedRewardMinPct: 1.4,
    stopAtrMult: 1.5,
    structureStopAtrMult: 2.5,
    takeProfitR: 3,
    h4RsiMax: 38,
    sessionUtcStartHour: 8,
    sessionUtcEndHour: 19,
    maxDistanceBelowEma20Pct: 1.5,
    maxDistanceBelowEma50Pct: 5,
    // Stage 9: short only when there's actual directional movement.
    adxMin: 20,
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
  lowerWickPct: number;
  bearishBody: boolean;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 0) {
    return {
      closeLocationPct: 0,
      bodyPct: 0,
      lowerWickPct: 1,
      bearishBody: false,
    };
  }

  const bodyLow = Math.min(candle.open, candle.close);
  return {
    closeLocationPct: (candle.high - candle.close) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    lowerWickPct: (bodyLow - candle.low) / range,
    bearishBody: candle.close < candle.open,
  };
}

export class MomentumBreakdownShortStrategy implements Strategy {
  readonly id = "momentum_breakdown_short_v1";
  readonly secTypes = ["STK", "IND"] as const;
  readonly supportedDirections = ["SHORT"] as const;
  readonly allowedDirectionalRegimes = ["bear_trend"] as const;
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
    if (context.directionalRegime !== "bear_trend")
      return this.reject("directional_regime_not_bear_trend");
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
    const donchianLower = indicators.dcLower20;

    if (
      ema20 === undefined ||
      ema50 === undefined ||
      ema200 === undefined ||
      rsi14 === undefined ||
      atr14 === undefined ||
      donchianLower === undefined
    ) {
      return this.reject("missing_required_indicators");
    }

    // Stage 9: require trending market for shorts — ADX < 20 = chop, commission drag dominates.
    if (indicators.adx14 !== undefined && indicators.adx14 < params.adxMin)
      return this.reject("adx_too_low");

    const h1 = indicators.timeframes?.["1h"];
    const h4 = indicators.timeframes?.["4h"];
    const d1 = indicators.timeframes?.["1d"];
    if (!h1 || !h4 || !d1) return this.reject("higher_timeframe_unavailable");
    if (h1.trend === "bullish")
      return this.reject("higher_timeframe_1h_bullish");
    if (h4.trend === "bullish")
      return this.reject("higher_timeframe_4h_bullish");
    if (d1.trend === "bullish")
      return this.reject("higher_timeframe_1d_bullish");
    if (h4.rsi14 === undefined) return this.reject("h4_rsi_unavailable");
    if (h4.rsi14 > params.h4RsiMax) return this.reject("h4_rsi_too_high");
    if ((d1.return20Pct ?? 0) > params.dailyReturn20MaxPct)
      return this.reject("daily_momentum_too_weak");
    if ((h1.return4Pct ?? 0) > params.h1Return4MaxPct)
      return this.reject("hourly_momentum_too_weak");

    if (close >= ema200) return this.reject("close_above_ema200");
    if (close >= ema50) return this.reject("close_above_ema50");
    if (ema20 >= ema50) return this.reject("ema20_not_below_ema50");
    const distanceBelowEma20Pct = ((ema20 - close) / close) * 100;
    const distanceBelowEma50Pct = ((ema50 - close) / close) * 100;
    if (distanceBelowEma20Pct > params.maxDistanceBelowEma20Pct)
      return this.reject("too_far_below_ema20");
    if (distanceBelowEma50Pct > params.maxDistanceBelowEma50Pct)
      return this.reject("too_far_below_ema50");
    if (rsi14 <= params.rsiMin) return this.reject("rsi_oversold");
    // Stage 7: require RSI to still be falling (momentum continuation, not exhaustion).
    if (indicators.rsi14Prev !== undefined && rsi14 >= indicators.rsi14Prev)
      return this.reject("rsi_not_falling");
    if ((indicators.return20mPct ?? 0) < params.return20MinPct)
      return this.reject("overextended_20m");
    if ((indicators.return60mPct ?? 0) < params.return60MinPct)
      return this.reject("overextended_60m");
    if ((indicators.return60mPct ?? 0) > params.return60MaxPct)
      return this.reject("intraday_momentum_too_weak");
    if (
      indicators.bbWidthPct !== undefined &&
      indicators.bbWidthPct > params.bbWidthMaxPct
    )
      return this.reject("volatility_not_compressed");

    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    const priorLow20 = previousLow(candles1m, 20);
    if (priorLow20 === undefined) return this.reject("prior_low_unavailable");
    const breakdownBuffer = Math.max(atr14 * 0.015, close * 0.00025);
    const confirmedBreakdown20 = close <= priorLow20 - breakdownBuffer;
    if (!confirmedBreakdown20) return this.reject("no_confirmed_breakdown");
    const preBreakdownDriftPct = consolidationDriftPct(candles1m, 20);
    if (preBreakdownDriftPct === undefined)
      return this.reject("consolidation_drift_unavailable");
    if (preBreakdownDriftPct < params.consolidationDriftMinPct)
      return this.reject("pre_breakdown_drift_too_low");

    const previousAverageVolume = averageVolume(candles1m.slice(0, -1), 20);
    if (previousAverageVolume === undefined || previousAverageVolume <= 0)
      return this.reject("volume_baseline_unavailable");
    if (latestCandle.volume < previousAverageVolume * params.volumeMultiplier)
      return this.reject("volume_not_confirmed");

    const quality = candleQuality(latestCandle);
    if (!quality.bearishBody)
      return this.reject("breakdown_candle_not_bearish");
    if (quality.closeLocationPct < params.closeLocationMin)
      return this.reject("breakdown_close_not_near_low");
    if (quality.bodyPct < params.bodyMin)
      return this.reject("breakdown_body_too_small");
    if (quality.lowerWickPct > params.lowerWickMax)
      return this.reject("breakdown_lower_wick_too_large");

    const consolidationHigh = localConsolidationHigh(candles1m, 20);
    const atrStop = close + atr14 * params.stopAtrMult;
    const structureStop =
      consolidationHigh !== undefined && consolidationHigh > close
        ? Math.min(
            consolidationHigh,
            close + atr14 * params.structureStopAtrMult,
          )
        : undefined;
    const stopLoss = Math.max(atrStop, structureStop ?? atrStop);
    if (!Number.isFinite(stopLoss) || stopLoss <= close)
      return this.reject("invalid_stop_loss");

    const riskPerShare = stopLoss - close;
    const takeProfit = close - riskPerShare * params.takeProfitR;
    const plannedRewardPct = ((close - takeProfit) / close) * 100;
    if (takeProfit <= 0) return this.reject("invalid_take_profit");
    if (plannedRewardPct < params.plannedRewardMinPct)
      return this.reject("planned_reward_too_small");

    const trendScore = clamp(((ema50 - ema20) / close) * 150, 0, 0.18);
    const breakdownScore = clamp(
      ((priorLow20 - close) / close) * 3500,
      0,
      0.12,
    );
    const rsiScore =
      rsi14 <= 45 && rsi14 > params.rsiMin ? 0.1 : rsi14 < 50 ? 0.06 : 0;
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
      0.58 + trendScore + breakdownScore + rsiScore + compressionScore,
      0,
      0.88,
    );
    const entryMode = "breakdown_20";

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "SELL",
      direction: "SHORT",
      confidenceScore,
      entryReason: `Momentum breakdown short: mode=${entryMode}, close=${close.toFixed(2)}, priorLow20=${priorLow20.toFixed(2)}, EMA50/EMA200 aligned, RSI14=${rsi14.toFixed(1)}, h1=${h1.trend}, h4=${h4.trend}, d1=${d1.trend}`,
      invalidationLevel: stopLoss,
      suggestedEntry: close,
      stopLoss,
      takeProfit,
      metadata: {
        ema20,
        ema50,
        ema200,
        atr14,
        rsi14,
        donchianLower,
        priorLow20,
        breakdownBuffer,
        preBreakdownDriftPct,
        consolidationDriftMinPct: params.consolidationDriftMinPct,
        entryMode,
        confirmedBreakdown20,
        bbWidthPct: indicators.bbWidthPct,
        previousAverageVolume,
        requiredVolumeMultiplier: params.volumeMultiplier,
        latestVolume: latestCandle.volume,
        breakdownCloseLocationPct: quality.closeLocationPct,
        breakdownBodyPct: quality.bodyPct,
        breakdownLowerWickPct: quality.lowerWickPct,
        plannedRewardPct,
        stopAtrMult: params.stopAtrMult,
        structureStopAtrMult: params.structureStopAtrMult,
        takeProfitR: params.takeProfitR,
        maxDistanceBelowEma20Pct: params.maxDistanceBelowEma20Pct,
        maxDistanceBelowEma50Pct: params.maxDistanceBelowEma50Pct,
        distanceBelowEma20Pct,
        distanceBelowEma50Pct,
        h4RsiMax: params.h4RsiMax,
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
        consolidationHigh,
      },
      generatedFromCandleTs: context.latestCandle.ts,
    };
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }
}
