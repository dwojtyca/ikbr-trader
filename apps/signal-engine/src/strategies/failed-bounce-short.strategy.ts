import type { Candle, SecType } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "./strategy.types.js";

interface FailedBounceShortParams {
  dailyReturn20MaxPct: number;
  h1Return4MaxPct: number;
  h4RsiMax: number;
  d1AdxMin: number;
  rsiMin: number;
  rsiMax: number;
  return20MinPct: number;
  return20MaxPct: number;
  return60MinPct: number;
  return60MaxPct: number;
  bbWidthMaxPct: number;
  volumeMultiplier: number;
  resistanceTolerancePct: number;
  maxDistanceBelowEma20Pct: number;
  triggerBufferAtrMult: number;
  triggerBufferBps: number;
  closeLocationMin: number;
  bodyMin: number;
  upperWickMin: number;
  setupCloseLocationMin: number;
  setupUpperWickMin: number;
  stopAtrMult: number;
  structureStopAtrMult: number;
  takeProfitR: number;
  tp1R: number;
  plannedRewardMinPct: number;
  minAverageVolume: number;
  minAverageNotional: number;
  sessionUtcStartHour: number;
  sessionUtcEndHour: number;
  minScore: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function paramsForSecType(_secType: SecType): FailedBounceShortParams {
  return {
    dailyReturn20MaxPct: -5,
    h1Return4MaxPct: 1,
    h4RsiMax: 48,
    d1AdxMin: 22,
    rsiMin: 30,
    rsiMax: 50,
    return20MinPct: -1.4,
    return20MaxPct: 1.2,
    return60MinPct: -2.5,
    return60MaxPct: 2,
    bbWidthMaxPct: 0.1,
    volumeMultiplier: 0.8,
    resistanceTolerancePct: 0.35,
    maxDistanceBelowEma20Pct: 1.2,
    triggerBufferAtrMult: 0.05,
    triggerBufferBps: 3,
    closeLocationMin: 0.55,
    bodyMin: 0.1,
    upperWickMin: 0.12,
    setupCloseLocationMin: 0.35,
    setupUpperWickMin: 0.12,
    stopAtrMult: 1.6,
    structureStopAtrMult: 2.6,
    takeProfitR: 2.5,
    tp1R: 1,
    plannedRewardMinPct: 0.45,
    minAverageVolume: 1_000,
    minAverageNotional: 50_000,
    sessionUtcStartHour: 8,
    sessionUtcEndHour: 19,
    minScore: 7,
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

function averageVolume(
  candles: Candle[],
  lookback: number,
): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  const total = slice.reduce((sum, candle) => sum + candle.volume, 0);
  return total / slice.length;
}

function recentHigh(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  return Math.max(...slice.map((candle) => candle.high));
}

function recentPivotSupport(
  candles: Candle[],
  lookback: number,
  excludeRecent: number,
): number | undefined {
  const end = Math.max(0, candles.length - excludeRecent);
  const start = Math.max(2, end - lookback);
  const pivots: number[] = [];

  for (let i = start; i < end - 2; i += 1) {
    const low = candles[i].low;
    if (
      low <= candles[i - 1].low &&
      low <= candles[i - 2].low &&
      low <= candles[i + 1].low &&
      low <= candles[i + 2].low
    ) {
      pivots.push(low);
    }
  }

  return pivots[pivots.length - 1];
}

function candleQuality(candle: Candle): {
  closeLocationPct: number;
  bodyPct: number;
  upperWickPct: number;
  bearishBody: boolean;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 0) {
    return {
      closeLocationPct: 0,
      bodyPct: 0,
      upperWickPct: 0,
      bearishBody: false,
    };
  }

  const bodyHigh = Math.max(candle.open, candle.close);
  return {
    closeLocationPct: (candle.high - candle.close) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    upperWickPct: (candle.high - bodyHigh) / range,
    bearishBody: candle.close < candle.open,
  };
}

export class FailedBounceShortStrategy implements Strategy {
  readonly id = "failed_bounce_short_v1";
  readonly secTypes = ["STK", "IND", "ETF", "CMDTY", "FUT"] as const;
  readonly supportedDirections = ["SHORT"] as const;
  readonly allowedDirectionalRegimes = ["bear_trend"] as const;
  readonly allowedVolatilityRegimes = ["normal_volatility", "high_volatility"] as const;
  readonly requiredTimeframes = ["1m", "1h", "4h", "1d"] as const;
  private lastRejectionReason: string | undefined;

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason;
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    this.lastRejectionReason = undefined;

    if (
      !this.secTypes.includes(
        context.secType as (typeof this.secTypes)[number],
      )
    )
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
    const sma200 = indicators.sma200;
    const rsi14 = indicators.rsi14;
    const rsi14Prev = indicators.rsi14Prev;
    const atr14 = indicators.atr14;
    const macdHist = indicators.macdHist;
    const macdHistPrev = indicators.macdHistPrev;
    const macdHistPrev2 = indicators.macdHistPrev2;
    const cmf20 = indicators.cmf20;
    const cmf20Prev = indicators.cmf20Prev;
    const mfi14 = indicators.mfi14;
    const mfi14Prev = indicators.mfi14Prev;

    if (
      ema20 === undefined ||
      ema50 === undefined ||
      ema200 === undefined ||
      sma200 === undefined ||
      rsi14 === undefined ||
      rsi14Prev === undefined ||
      atr14 === undefined ||
      macdHist === undefined ||
      macdHistPrev === undefined ||
      macdHistPrev2 === undefined ||
      cmf20 === undefined ||
      mfi14 === undefined
    ) {
      return this.reject("missing_required_indicators");
    }

    const h1 = indicators.timeframes?.["1h"];
    const h4 = indicators.timeframes?.["4h"];
    const d1 = indicators.timeframes?.["1d"];
    if (!h1 || !h4 || !d1) return this.reject("higher_timeframe_unavailable");
    if (
      d1.close === undefined ||
      d1.ema20 === undefined ||
      d1.ema50 === undefined ||
      d1.sma200 === undefined ||
      d1.adx14 === undefined ||
      d1.ema50Slope10Pct === undefined
    )
      return this.reject("daily_trend_indicators_unavailable");
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
      return this.reject("hourly_bounce_too_strong");

    if (d1.close >= d1.sma200) return this.reject("daily_close_above_sma200");
    if (d1.close >= d1.ema50) return this.reject("daily_close_above_ema50");
    if (d1.ema20 >= d1.ema50) return this.reject("daily_ema20_not_below_ema50");
    if (d1.ema50Slope10Pct >= 0)
      return this.reject("daily_ema50_not_falling");
    if (d1.adx14 < params.d1AdxMin) return this.reject("daily_adx_too_low");
    if (close >= ema200) return this.reject("close_above_ema200");
    if (close >= ema50) return this.reject("close_above_ema50");
    if (ema20 >= ema50) return this.reject("ema20_not_below_ema50");
    if (close >= ema20) return this.reject("close_not_back_below_ema20");

    const distanceBelowEma20Pct = ((ema20 - close) / close) * 100;
    if (distanceBelowEma20Pct > params.maxDistanceBelowEma20Pct)
      return this.reject("too_far_below_ema20");

    if (rsi14 <= params.rsiMin) return this.reject("rsi_oversold");
    if (rsi14 >= params.rsiMax) return this.reject("rsi_too_strong");
    if (rsi14 >= 50) return this.reject("rsi_not_below_50");
    if (cmf20 > 0.08) return this.reject("money_flow_too_positive");
    if (mfi14 > 65) return this.reject("mfi_too_strong");
    if (!(macdHist < macdHistPrev && macdHistPrev < macdHistPrev2))
      return this.reject("macd_hist_not_falling_two_bars");
    if ((indicators.return20mPct ?? 0) < params.return20MinPct)
      return this.reject("overextended_20m");
    if ((indicators.return20mPct ?? 0) > params.return20MaxPct)
      return this.reject("bounce_too_strong_20m");
    if ((indicators.return60mPct ?? 0) < params.return60MinPct)
      return this.reject("overextended_60m");
    if ((indicators.return60mPct ?? 0) > params.return60MaxPct)
      return this.reject("bounce_too_strong_60m");
    if (
      indicators.bbWidthPct !== undefined &&
      indicators.bbWidthPct > params.bbWidthMaxPct
    )
      return this.reject("volatility_too_wide");

    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    if (candles1m.length < 22) return this.reject("not_enough_1m_candles");
    const setupCandle = candles1m[candles1m.length - 2];
    const triggerCandle = latestCandle;
    const rejectionHigh = recentHigh(candles1m.slice(0, -1), 10);
    if (rejectionHigh === undefined)
      return this.reject("rejection_high_unavailable");

    const h1Candles = context.candlesByTimeframe["1h"] ?? [];
    const priorSupport = recentPivotSupport(h1Candles, 48, 4);
    const emaResistance = Math.min(ema20, ema50);
    const bbMiddle = indicators.bbMiddle;
    const bbUpper = indicators.bbUpper;
    const tolerance = params.resistanceTolerancePct / 100;
    const touchedEmaResistance =
      setupCandle.high >= emaResistance * (1 - tolerance);
    const touchedPriorSupport =
      priorSupport !== undefined &&
      close < priorSupport &&
      setupCandle.high >= priorSupport * (1 - tolerance);
    const touchedBollingerResistance =
      (bbMiddle !== undefined && setupCandle.high >= bbMiddle * (1 - tolerance)) ||
      (bbUpper !== undefined && setupCandle.high >= bbUpper * (1 - tolerance));
    if (
      !touchedEmaResistance &&
      !touchedPriorSupport &&
      !touchedBollingerResistance
    )
      return this.reject("no_resistance_retest");

    const setupQuality = candleQuality(setupCandle);
    if (setupQuality.closeLocationPct < params.setupCloseLocationMin)
      return this.reject("setup_close_not_rejecting_highs");
    if (setupQuality.upperWickPct < params.setupUpperWickMin)
      return this.reject("setup_upper_wick_too_small");

    if (triggerCandle.close >= setupCandle.low)
      return this.reject("trigger_close_not_below_setup_low");

    const previousAverageVolume = averageVolume(candles1m.slice(0, -1), 20);
    if (previousAverageVolume === undefined || previousAverageVolume <= 0)
      return this.reject("volume_baseline_unavailable");
    if (previousAverageVolume < params.minAverageVolume)
      return this.reject("average_volume_too_low");
    if (previousAverageVolume * close < params.minAverageNotional)
      return this.reject("average_notional_too_low");
    if (latestCandle.volume < previousAverageVolume * params.volumeMultiplier)
      return this.reject("volume_not_confirmed");

    const quality = candleQuality(triggerCandle);
    if (!quality.bearishBody) return this.reject("rejection_candle_not_bearish");
    if (quality.closeLocationPct < params.closeLocationMin)
      return this.reject("rejection_close_not_near_low");
    if (quality.bodyPct < params.bodyMin)
      return this.reject("rejection_body_too_small");
    if (quality.upperWickPct < params.upperWickMin)
      return this.reject("rejection_upper_wick_too_small");

    const triggerBuffer = Math.max(
      atr14 * params.triggerBufferAtrMult,
      close * (params.triggerBufferBps / 10000),
    );
    const entryStop = triggerCandle.low - triggerBuffer;
    if (!Number.isFinite(entryStop) || entryStop <= 0)
      return this.reject("invalid_entry_stop");

    const rejectionBuffer = Math.max(atr14 * 0.1, entryStop * 0.0005);
    const atrStop = entryStop + atr14 * params.stopAtrMult;
    const structureStop = rejectionHigh + rejectionBuffer;
    const stopLoss = Math.max(atrStop, structureStop);
    const maxStop = entryStop + atr14 * params.structureStopAtrMult;
    if (!Number.isFinite(stopLoss) || stopLoss <= entryStop)
      return this.reject("invalid_stop_loss");
    if (stopLoss > maxStop) return this.reject("stop_too_wide");

    const riskPerShare = stopLoss - entryStop;
    const tp1 = entryStop - riskPerShare * params.tp1R;
    const takeProfit = entryStop - riskPerShare * params.takeProfitR;
    const plannedRewardPct = ((entryStop - takeProfit) / entryStop) * 100;
    if (takeProfit <= 0) return this.reject("invalid_take_profit");
    if (plannedRewardPct < params.plannedRewardMinPct)
      return this.reject("planned_reward_too_small");

    const scoreParts = {
      dailyBearTrend: 2,
      dailyEmaAlignment: 1.25,
      dailyEma50Falling: d1.ema50Slope10Pct < 0 ? 1 : 0,
      dailyAdxTrend: d1.adx14 >= 25 ? 1 : 0.6,
      intradayEmaAlignment: 1,
      resistanceRetest:
        (touchedEmaResistance ? 0.6 : 0) +
        (touchedPriorSupport ? 0.45 : 0) +
        (touchedBollingerResistance ? 0.35 : 0),
      confirmedBreakBelowSetupLow: triggerCandle.close < setupCandle.low ? 1 : 0,
      closeBackBelowEma20: close < ema20 ? 0.75 : 0,
      bearishRejection:
        quality.closeLocationPct >= 0.7 && quality.upperWickPct >= 0.2
          ? 1
          : 0.6,
      rsiRollingOver: rsi14 < rsi14Prev ? 0.75 : 0,
      macdWeakening: macdHist < macdHistPrev && macdHistPrev < macdHistPrev2 ? 1 : 0,
      moneyFlowBearish: cmf20 < 0 ? 0.8 : 0,
      mfiWeakening: mfi14Prev !== undefined && mfi14 < mfi14Prev ? 0.5 : 0,
      obvWeakening: (indicators.obvSlope ?? 0) < 0 ? 0.3 : 0,
    };
    const signalScore = Object.values(scoreParts).reduce(
      (sum, value) => sum + value,
      0,
    );
    if (signalScore < params.minScore) return this.reject("score_too_low");

    const confidenceScore = clamp(
      0.5 + signalScore / 20,
      0,
      0.88,
    );

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "SELL",
      direction: "SHORT",
      confidenceScore,
      entryOrderType: "STP",
      entryReason: `Failed bounce short: close=${close.toFixed(2)}, entryStop=${entryStop.toFixed(2)}, rejectionHigh=${rejectionHigh.toFixed(2)}, RSI14=${rsi14.toFixed(1)}, D1_ADX=${d1.adx14.toFixed(1)}, h1=${h1.trend}, h4=${h4.trend}, d1=${d1.trend}`,
      invalidationLevel: stopLoss,
      suggestedEntry: entryStop,
      stopLoss,
      takeProfit,
      metadata: {
        ema20,
        ema50,
        ema200,
        sma200,
        atr14,
        rsi14,
        rsi14Prev,
        macdHist,
        macdHistPrev,
        macdHistPrev2,
        cmf20,
        cmf20Prev,
        mfi14,
        mfi14Prev,
        obvSlope: indicators.obvSlope,
        h4Rsi14: h4.rsi14,
        emaResistance,
        priorSupport,
        bbMiddle,
        bbUpper,
        touchedEmaResistance,
        touchedPriorSupport,
        touchedBollingerResistance,
        setupCandleLow: setupCandle.low,
        setupCandleHigh: setupCandle.high,
        rejectionHigh,
        entryStop,
        entryOrderType: "STP",
        triggerBuffer,
        rejectionBuffer,
        distanceBelowEma20Pct,
        bbWidthPct: indicators.bbWidthPct,
        previousAverageVolume,
        requiredVolumeMultiplier: params.volumeMultiplier,
        latestVolume: latestCandle.volume,
        rejectionCloseLocationPct: quality.closeLocationPct,
        rejectionBodyPct: quality.bodyPct,
        rejectionUpperWickPct: quality.upperWickPct,
        setupCloseLocationPct: setupQuality.closeLocationPct,
        setupUpperWickPct: setupQuality.upperWickPct,
        tp1,
        breakevenAfterTp1: true,
        finalTarget: takeProfit,
        trailingPlan: "future: after TP1, trail remaining size by EMA20 or ATR",
        plannedRewardPct,
        stopAtrMult: params.stopAtrMult,
        structureStopAtrMult: params.structureStopAtrMult,
        takeProfitR: params.takeProfitR,
        score: signalScore,
        minScore: params.minScore,
        scoreParts,
        directionalRegime: indicators.directionalRegime,
        volatilityRegime: indicators.volatilityRegime,
        regimeScore: indicators.regimeScore,
        regimeConfidence: indicators.regimeConfidence,
        h1Trend: h1.trend,
        h4Trend: h4.trend,
        d1Trend: d1.trend,
        d1Close: d1.close,
        d1Ema20: d1.ema20,
        d1Ema50: d1.ema50,
        d1Sma200: d1.sma200,
        d1Adx14: d1.adx14,
        d1Ema50Slope10Pct: d1.ema50Slope10Pct,
        d1Return20Pct: d1.return20Pct,
      },
      generatedFromCandleTs: context.latestCandle.ts,
    };
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }
}
