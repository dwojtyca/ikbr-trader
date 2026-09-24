import type { SecType, Candle } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  ExitContext,
  ExitSignal,
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
  /**
   * Minimum regimeScore (from MarketRegimeDetector) required to emit a
   * signal. Tuned on backtest run #25: scores 0..8 form a stagnant
   * "no man's land" with negative expectancy, while scores >= 9 carry
   * the bulk of profits. Set to 0 to disable.
   */
  minRegimeScore: number;
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

export const MOMENTUM_PROFILE_THRESHOLDS = Object.freeze({
  default: Object.freeze({ dailyReturn20MinPct: 8, h1Return4MinPct: 1, return60MinPct: 0.2 }),
  pko_mild_v1: Object.freeze({ dailyReturn20MinPct: 5, h1Return4MinPct: 0.5, return60MinPct: 0.15 }),
  pko_moderate_v1: Object.freeze({ dailyReturn20MinPct: 3, h1Return4MinPct: 0.3, return60MinPct: 0.1 }),
});

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
    minRegimeScore: 5,
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

export interface MomentumBreakoutLongEvaluation {
  signal: StrategySignal | null;
  rejectionReason?: string;
}

export function evaluateMomentumBreakoutLong(
  context: StrategyContext,
  allowedSecTypes: readonly SecType[] = ["STK", "IND"],
): MomentumBreakoutLongEvaluation {
  const evaluator = new MomentumBreakoutLongStrategy();
  const signal = evaluator.evaluateForAllowedSecTypes(context, allowedSecTypes);
  return { signal, rejectionReason: evaluator.getLastRejectionReason() };
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
  // Hard lane separation: intraday breakout lane is the proven primary lane
  // and must beat any swing-style strategy (e.g. trend_following_long_v1) when
  // both fire on the same symbol/tick, regardless of confidence score.
  readonly lanePriority = 10;
  private lastRejectionReason: string | undefined;

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason;
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    const evaluation = evaluateMomentumBreakoutLong(context, this.secTypes);
    this.lastRejectionReason = evaluation.rejectionReason;
    return evaluation.signal;
  }

  evaluateForAllowedSecTypes(
    context: StrategyContext,
    allowedSecTypes: readonly SecType[],
  ): StrategySignal | null {
    this.lastRejectionReason = undefined;

    if (!allowedSecTypes.includes(context.secType))
      return this.reject("sec_type_not_supported");
    if (context.directionalRegime !== "bull_trend")
      return this.reject("directional_regime_not_bull_trend");
    if (context.volatilityRegime === "low_volatility")
      return this.reject("volatility_regime_low_volatility");

    const profile = context.momentumBreakoutProfile ?? "default";
    if (!["default", "pko_mild_v1", "pko_moderate_v1"].includes(profile)) return this.reject("invalid_momentum_profile");
    if (profile !== "default" && (context.symbol !== "PKO" || context.conid !== "35146360" || context.secType !== "STK"))
      return this.reject("momentum_profile_identity_mismatch");
    const params = { ...paramsForSecType(context.secType), ...MOMENTUM_PROFILE_THRESHOLDS[profile] };
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

    if (
      params.minRegimeScore > 0 &&
      indicators.regimeScore !== undefined &&
      indicators.regimeScore < params.minRegimeScore
    ) {
      return this.reject("regime_score_below_minimum");
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
      // BE+trail (trailingStopActivationR + trailingStopPct) infrastructure
      // is wired end-to-end (commit 2eb2772). Tested 3 variants vs baseline
      // #29 (\$2576.17): 2R/3% = \$1834 (-29%), 3R/5% = \$1834 (-29%),
      // 2R/8% = \$1781 (-31%). All lose because the dataset is bimodal —
      // out of 174 long trades, 39 reach >=+4R (TP) and only 2 land in
      // the +2R..+4R band. There is essentially no "give-back" pool to
      // protect; activating BE just clips the runners that briefly tag
      // +2R, dip, then run to +4R. Left disabled here.
      // trailingStopPct: 3,
      // trailingStopActivationR: 2,
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
        ...(profile !== "default" ? { momentumBreakoutProfile: profile } : {}),
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

  shouldExit(context: ExitContext): ExitSignal | null {
    // Hard exit #1: Lose prior breakout level + EMA20 on volume
    // If price closes below min(priorHigh20, EMA20) for 2 consecutive 1m candles
    // with volume >= avg20 * 1.3, the breakout is invalidated. Mirrors
    // momentum_breakdown_short_v1.shouldExit().
    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    const { ema20, ema50, ema200 } = context.indicators;
    const { latestCandle } = context;
    const close = latestCandle.close;

    if (
      ema20 === undefined ||
      ema50 === undefined ||
      ema200 === undefined ||
      candles1m.length < 2
    ) {
      return null;
    }

    const priorHigh20 = previousHigh(candles1m, 20);
    const lossLevel = Math.min(priorHigh20 ?? close, ema20);
    const avgVolume20 = averageVolume(candles1m, 20) ?? 0;
    const lossThresholdVolume = avgVolume20 * 1.3;

    const last1 = candles1m.at(-1);
    const last2 = candles1m.at(-2);
    if (
      last1 &&
      last2 &&
      last1.close < lossLevel &&
      last2.close < lossLevel &&
      last1.volume >= lossThresholdVolume
    ) {
      return {
        strategyId: this.id,
        symbol: context.symbol,
        side: "SELL", // Inverse of LONG
        reason:
          "Hard exit: Prior high + EMA20 lost on 2 candles and volume confirmation",
        confidenceScore: 0.95,
        metadata: {
          exitReason: "lost_priorhigh_ema20",
          lossLevel,
          last1Close: last1.close,
          last2Close: last2.close,
          lossThresholdVolume,
          last1Volume: last1.volume,
        },
      };
    }

    // Hard exit #2: Regime flip — directionalRegime is no longer bull_trend or
    // regimeScore has crossed to bearish (below +minRegimeScore/2). Entry
    // minRegimeScore is 5 (see paramsForSecType), so threshold is 2.5.
    if (
      context.directionalRegime !== "bull_trend" ||
      (context.indicators.regimeScore !== undefined &&
        context.indicators.regimeScore < 5 / 2)
    ) {
      return {
        strategyId: this.id,
        symbol: context.symbol,
        side: "SELL",
        reason:
          context.directionalRegime !== "bull_trend"
            ? `Hard exit: Regime flip detected (now ${context.directionalRegime})`
            : `Hard exit: Regime score bearish (${context.indicators.regimeScore?.toFixed(1)})`,
        confidenceScore: 0.9,
        metadata: {
          exitReason: "regime_flipped_bearish",
          newDirectionalRegime: context.directionalRegime,
          regimeScore: context.indicators.regimeScore,
          regimeConfidence: context.indicators.regimeConfidence,
        },
      };
    }

    // Hard exit #3: 1h trend flipped to bearish
    const h1 = context.indicators.timeframes?.["1h"];
    if (h1 && h1.trend === "bearish") {
      return {
        strategyId: this.id,
        symbol: context.symbol,
        side: "SELL",
        reason: "Hard exit: 1h trend flipped to bearish",
        confidenceScore: 0.88,
        metadata: {
          exitReason: "h1_trend_bearish",
          h1Trend: h1.trend,
          h1Rsi: h1.rsi14,
        },
      };
    }

    return null;
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }
}
