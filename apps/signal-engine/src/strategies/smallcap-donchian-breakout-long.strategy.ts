import type { Candle } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  ExitContext,
  ExitSignal,
} from "./strategy.types.js";

interface SmallcapDonchianLongParams {
  /** Minimum regimeScore from MarketRegimeDetector. */
  minRegimeScore: number;
  /** Donchian breakout window measured in 4h candles. */
  donchianWindow: number;
  /** Minimum 4h RSI to allow entry. */
  rsiMin: number;
  /** Maximum 4h RSI to avoid late/overbought entries. */
  rsiMax: number;
  /** Minimum 4h ADX to require a real trending environment. */
  adxMin: number;
  /** Minimum gap above prior N-bar high (in % of close) to count as a true breakout. */
  breakoutBufferPct: number;
  /** Stop = entry - stopAtrMult * ATR(4h). */
  stopAtrMult: number;
  /** Take-profit = entry + takeProfitR * (entry - stop). */
  takeProfitR: number;
  /** Minimum planned reward in % of entry. */
  plannedRewardMinPct: number;
  /** Volume confirmation: latest 4h volume must exceed avg(prev N) * mult. */
  volumeLookback: number;
  volumeMultiplier: number;
  /** Quality of the breakout 4h candle. */
  closeLocationMin: number;
  bodyMin: number;
  upperWickMax: number;
  /** Exit ladder. */
  partialFraction: number;
  partialAtR: number;
  trailingStopPct: number;
  trailingStopActivationR: number;
}

function defaultParams(): SmallcapDonchianLongParams {
  return {
    minRegimeScore: 4,
    donchianWindow: 20,
    rsiMin: 50,
    rsiMax: 75,
    adxMin: 18,
    breakoutBufferPct: 0.1,
    stopAtrMult: 2,
    takeProfitR: 3,
    plannedRewardMinPct: 1.5,
    volumeLookback: 20,
    volumeMultiplier: 1.1,
    closeLocationMin: 0.6,
    bodyMin: 0.25,
    upperWickMax: 0.4,
    partialFraction: 0.5,
    partialAtR: 1.5,
    trailingStopPct: 4,
    trailingStopActivationR: 1.5,
  };
}

function priorMaxHigh(candles: Candle[], lookback: number): number | undefined {
  // Exclude the most recent (current) 4h candle.
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  return Math.max(...slice.map((c) => c.high));
}

function averageVolume(
  candles: Candle[],
  lookback: number,
): number | undefined {
  // Exclude the most recent (breakout) candle.
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  const total = slice.reduce((sum, c) => sum + c.volume, 0);
  return total / slice.length;
}

function candleQuality(candle: Candle): {
  closeLocationPct: number;
  bodyPct: number;
  upperWickPct: number;
  lowerWickPct: number;
  bullishBody: boolean;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 0) {
    return {
      closeLocationPct: 0,
      bodyPct: 0,
      upperWickPct: 1,
      lowerWickPct: 1,
      bullishBody: false,
    };
  }
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  return {
    closeLocationPct: (candle.close - candle.low) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    upperWickPct: (candle.high - bodyHigh) / range,
    lowerWickPct: (bodyLow - candle.low) / range,
    bullishBody: candle.close > candle.open,
  };
}

export class SmallcapDonchianBreakoutLongStrategy implements Strategy {
  readonly id = "smallcap_donchian_breakout_long_v1";
  readonly secTypes = ["STK"] as const;
  readonly supportedDirections = ["LONG"] as const;
  readonly allowedDirectionalRegimes = ["bull_trend"] as const;
  readonly allowedVolatilityRegimes = [
    "normal_volatility",
    "high_volatility",
  ] as const;
  // 1m needed for the latest fill price, 4h for the breakout setup itself,
  // 1d for the higher-timeframe trend gate.
  readonly requiredTimeframes = ["1m", "4h", "1d"] as const;
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

    if (context.secType !== "STK") return this.reject("sec_type_not_supported");
    if (context.directionalRegime !== "bull_trend")
      return this.reject("directional_regime_not_bull_trend");
    if (context.volatilityRegime === "low_volatility")
      return this.reject("volatility_regime_low_volatility");

    const params = defaultParams();

    if (
      params.minRegimeScore > 0 &&
      context.indicators.regimeScore !== undefined &&
      context.indicators.regimeScore < params.minRegimeScore
    ) {
      return this.reject("regime_score_below_minimum");
    }

    const h4Snapshot = context.indicators.timeframes?.["4h"];
    const d1Snapshot = context.indicators.timeframes?.["1d"];
    const candles4h = context.candlesByTimeframe["4h"] ?? [];
    if (!h4Snapshot) return this.reject("h4_snapshot_unavailable");
    if (!d1Snapshot) return this.reject("d1_snapshot_unavailable");
    if (candles4h.length < params.donchianWindow + 2)
      return this.reject("h4_history_insufficient");

    const ema50h4 = h4Snapshot.ema50;
    const rsi14h4 = h4Snapshot.rsi14;
    const atr14h4 = h4Snapshot.atr14;
    const adx14h4 = h4Snapshot.adx14;
    const macdHistH4 = h4Snapshot.macdHist;
    const macdHistPrevH4 = h4Snapshot.macdHistPrev;
    const closeH4 = h4Snapshot.close;
    if (
      ema50h4 === undefined ||
      rsi14h4 === undefined ||
      atr14h4 === undefined ||
      closeH4 === undefined
    ) {
      return this.reject("h4_indicators_incomplete");
    }
    if (atr14h4 <= 0) return this.reject("h4_atr_non_positive");

    // Trend gate.
    if (closeH4 <= ema50h4) return this.reject("h4_close_below_ema50");

    // Daily trend must not oppose.
    if (d1Snapshot.trend === "bearish") return this.reject("d1_trend_bearish");

    // Trend strength.
    if (adx14h4 === undefined) return this.reject("h4_adx_unavailable");
    if (adx14h4 < params.adxMin) return this.reject("h4_adx_too_weak");

    // MACD momentum confirmation (histogram positive & rising).
    if (macdHistH4 === undefined || macdHistPrevH4 === undefined)
      return this.reject("h4_macd_unavailable");
    if (macdHistH4 <= 0) return this.reject("h4_macd_hist_not_positive");
    if (macdHistH4 <= macdHistPrevH4)
      return this.reject("h4_macd_hist_not_rising");

    // Momentum gate.
    if (rsi14h4 < params.rsiMin) return this.reject("h4_rsi_too_low");
    if (rsi14h4 > params.rsiMax) return this.reject("h4_rsi_overbought");

    // Donchian breakout on 4h.
    const priorHigh = priorMaxHigh(candles4h, params.donchianWindow);
    if (priorHigh === undefined) return this.reject("h4_donchian_unavailable");
    const breakoutLevel = priorHigh * (1 + params.breakoutBufferPct / 100);
    if (closeH4 <= breakoutLevel) return this.reject("h4_no_donchian_breakout");

    // Volume confirmation on the breakout 4h candle.
    const avgVol = averageVolume(candles4h, params.volumeLookback);
    const breakoutCandle = candles4h[candles4h.length - 1];
    if (avgVol === undefined || avgVol <= 0)
      return this.reject("h4_volume_baseline_unavailable");
    if (!breakoutCandle) return this.reject("h4_breakout_candle_missing");
    if (breakoutCandle.volume < avgVol * params.volumeMultiplier)
      return this.reject("h4_volume_not_confirmed");

    // Quality of the breakout 4h candle.
    const quality = candleQuality(breakoutCandle);
    if (!quality.bullishBody)
      return this.reject("h4_breakout_candle_not_bullish");
    if (quality.closeLocationPct < params.closeLocationMin)
      return this.reject("h4_breakout_close_not_near_high");
    if (quality.bodyPct < params.bodyMin)
      return this.reject("h4_breakout_body_too_small");
    if (quality.upperWickPct > params.upperWickMax)
      return this.reject("h4_breakout_upper_wick_too_large");

    // Stop & TP off the live (1m) close so position sizing matches the actual
    // fill; ATR is taken from 4h to size the stop in intraday-noise units.
    const close = context.latestCandle.close;
    const stopLoss = close - atr14h4 * params.stopAtrMult;
    if (!Number.isFinite(stopLoss) || stopLoss >= close)
      return this.reject("invalid_stop_loss");

    const riskPerShare = close - stopLoss;
    const takeProfit = close + riskPerShare * params.takeProfitR;
    const plannedRewardPct = ((takeProfit - close) / close) * 100;
    if (plannedRewardPct < params.plannedRewardMinPct)
      return this.reject("planned_reward_too_small");

    const partialPrice = close + riskPerShare * params.partialAtR;

    const regimeBonus = Math.min(
      0.05,
      Math.max(0, ((context.indicators.regimeScore ?? 0) - 4) / 100),
    );
    const breakoutCleanlinessBonus = Math.min(
      0.04,
      Math.max(0, ((closeH4 - priorHigh) / priorHigh) * 4),
    );
    const adxBonus = Math.min(
      0.04,
      Math.max(0, (adx14h4 - params.adxMin) / 200),
    );
    const confidenceScore = Math.min(
      0.95,
      0.78 + regimeBonus + breakoutCleanlinessBonus + adxBonus,
    );

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "BUY",
      direction: "LONG",
      confidenceScore,
      entryReason: `Smallcap 4h Donchian long: closeH4=${closeH4.toFixed(2)} > priorHigh${params.donchianWindow}=${priorHigh.toFixed(2)} (+${(((closeH4 - priorHigh) / priorHigh) * 100).toFixed(2)}%), EMA50H4=${ema50h4.toFixed(2)}, RSI14H4=${rsi14h4.toFixed(1)}, ADX14H4=${adx14h4.toFixed(1)}, MACDh4=${macdHistH4.toFixed(3)}, d1=${d1Snapshot.trend ?? "n/a"}, regimeScore=${context.indicators.regimeScore ?? "n/a"}`,
      invalidationLevel: stopLoss,
      suggestedEntry: close,
      stopLoss,
      takeProfit,
      partialTakeProfits: [
        { fraction: params.partialFraction, price: partialPrice },
      ],
      trailingStopPct: params.trailingStopPct,
      trailingStopActivationR: params.trailingStopActivationR,
      metadata: {
        timeframe: "4h",
        ema50h4,
        rsi14h4,
        atr14h4,
        adx14h4,
        macdHistH4,
        macdHistPrevH4,
        closeH4,
        priorHighN: priorHigh,
        donchianWindow: params.donchianWindow,
        breakoutVolume: breakoutCandle.volume,
        avgVolumeN: avgVol,
        volumeMultiplier: params.volumeMultiplier,
        breakoutCloseLocationPct: quality.closeLocationPct,
        breakoutBodyPct: quality.bodyPct,
        breakoutUpperWickPct: quality.upperWickPct,
        d1Trend: d1Snapshot.trend,
        regimeScore: context.indicators.regimeScore,
        regimeConfidence: context.indicators.regimeConfidence,
        takeProfitR: params.takeProfitR,
        stopAtrMult: params.stopAtrMult,
        partialAtR: params.partialAtR,
        partialFraction: params.partialFraction,
        trailingStopPct: params.trailingStopPct,
        trailingStopActivationR: params.trailingStopActivationR,
      },
      generatedFromCandleTs: context.latestCandle.ts,
    };
  }

  shouldExit(context: ExitContext): ExitSignal | null {
    // All exit checks use 4h timeframe (consistent with entry TF).
    const candles4h = context.candlesByTimeframe["4h"] ?? [];
    const h4 = context.indicators.timeframes?.["4h"];
    const d1 = context.indicators.timeframes?.["1d"];
    if (!h4 || candles4h.length < 2) return null;

    const ema50h4 = h4.ema50;

    // Hard exit #1: Two consecutive 4h closes below EMA50(4h) on volume.
    // EMA50_4h is the core trend gate that entry required; losing it = thesis broken.
    if (ema50h4 !== undefined) {
      const last1 = candles4h.at(-1);
      const last2 = candles4h.at(-2);
      const avgVol = averageVolume(candles4h, 20);
      const volThreshold = (avgVol ?? 0) * 1.3;
      if (
        last1 &&
        last2 &&
        last1.close < ema50h4 &&
        last2.close < ema50h4 &&
        avgVol !== undefined &&
        last1.volume >= volThreshold
      ) {
        return {
          strategyId: this.id,
          symbol: context.symbol,
          side: "SELL",
          reason:
            "Hard exit: 4h close below EMA50 on 2 consecutive candles + volume",
          confidenceScore: 0.95,
          metadata: {
            exitReason: "h4_lost_ema50",
            ema50h4,
            last1Close: last1.close,
            last2Close: last2.close,
            volThreshold,
            last1Volume: last1.volume,
          },
        };
      }
    }

    // Hard exit #2: Regime flip from bull_trend or regimeScore < minRegimeScore/2.
    if (
      context.directionalRegime !== "bull_trend" ||
      (context.indicators.regimeScore !== undefined &&
        context.indicators.regimeScore < 4 / 2)
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

    // Hard exit #3: Daily trend flipped to bearish.
    if (d1 && d1.trend === "bearish") {
      return {
        strategyId: this.id,
        symbol: context.symbol,
        side: "SELL",
        reason: "Hard exit: 1d trend flipped to bearish",
        confidenceScore: 0.88,
        metadata: {
          exitReason: "d1_trend_bearish",
          d1Trend: d1.trend,
          d1Rsi: d1.rsi14,
        },
      };
    }

    return null;
  }
}
