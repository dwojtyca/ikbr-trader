import type { Candle } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
  ExitContext,
  ExitSignal,
} from "./strategy.types.js";

interface SmallcapDonchianShortParams {
  minRegimeScore: number;
  donchianWindow: number;
  /** Maximum 4h RSI to allow short entry (overbought = no short). */
  rsiMax: number;
  /** Minimum 4h RSI to avoid late/oversold entries. */
  rsiMin: number;
  /** Minimum 4h ADX to require a real trending environment. */
  adxMin: number;
  /** Minimum gap below prior N-bar low (in % of close). */
  breakdownBufferPct: number;
  /** Stop = entry + stopAtrMult * ATR(4h). */
  stopAtrMult: number;
  /** Take-profit = entry - takeProfitR * (stop - entry). */
  takeProfitR: number;
  plannedRewardMinPct: number;
  volumeLookback: number;
  volumeMultiplier: number;
  closeLocationMax: number;
  bodyMin: number;
  lowerWickMax: number;
  partialFraction: number;
  partialAtR: number;
  trailingStopPct: number;
  trailingStopActivationR: number;
}

function defaultParams(): SmallcapDonchianShortParams {
  return {
    minRegimeScore: 4,
    donchianWindow: 20,
    rsiMax: 50,
    rsiMin: 25,
    adxMin: 18,
    breakdownBufferPct: 0.1,
    stopAtrMult: 2,
    takeProfitR: 3,
    plannedRewardMinPct: 1.5,
    volumeLookback: 20,
    volumeMultiplier: 1.1,
    closeLocationMax: 0.4,
    bodyMin: 0.25,
    lowerWickMax: 0.4,
    partialFraction: 0.5,
    partialAtR: 1.5,
    trailingStopPct: 4,
    trailingStopActivationR: 1.5,
  };
}

function priorMinLow(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  return Math.min(...slice.map((c) => c.low));
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

function candleQuality(candle: Candle): {
  closeLocationPct: number;
  bodyPct: number;
  upperWickPct: number;
  lowerWickPct: number;
  bearishBody: boolean;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 0) {
    return {
      closeLocationPct: 0,
      bodyPct: 0,
      upperWickPct: 1,
      lowerWickPct: 1,
      bearishBody: false,
    };
  }
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  return {
    closeLocationPct: (candle.close - candle.low) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    upperWickPct: (candle.high - bodyHigh) / range,
    lowerWickPct: (bodyLow - candle.low) / range,
    bearishBody: candle.close < candle.open,
  };
}

export class SmallcapDonchianBreakdownShortStrategy implements Strategy {
  readonly id = "smallcap_donchian_breakdown_short_v1";
  readonly secTypes = ["STK"] as const;
  readonly supportedDirections = ["SHORT"] as const;
  readonly allowedDirectionalRegimes = ["bear_trend"] as const;
  readonly allowedVolatilityRegimes = [
    "normal_volatility",
    "high_volatility",
  ] as const;
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
    if (context.directionalRegime !== "bear_trend")
      return this.reject("directional_regime_not_bear_trend");
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

    // Downtrend gate.
    if (closeH4 >= ema50h4) return this.reject("h4_close_above_ema50");

    // Daily trend must not oppose.
    if (d1Snapshot.trend === "bullish")
      return this.reject("d1_trend_bullish");

    // Trend strength.
    if (adx14h4 === undefined) return this.reject("h4_adx_unavailable");
    if (adx14h4 < params.adxMin) return this.reject("h4_adx_too_weak");

    // MACD momentum confirmation (histogram negative & falling).
    if (macdHistH4 === undefined || macdHistPrevH4 === undefined)
      return this.reject("h4_macd_unavailable");
    if (macdHistH4 >= 0) return this.reject("h4_macd_hist_not_negative");
    if (macdHistH4 >= macdHistPrevH4)
      return this.reject("h4_macd_hist_not_falling");

    // Momentum gate (avoid shorting into oversold capitulation).
    if (rsi14h4 > params.rsiMax) return this.reject("h4_rsi_too_high");
    if (rsi14h4 < params.rsiMin) return this.reject("h4_rsi_oversold");

    // Donchian breakdown on 4h.
    const priorLow = priorMinLow(candles4h, params.donchianWindow);
    if (priorLow === undefined) return this.reject("h4_donchian_unavailable");
    const breakdownLevel = priorLow * (1 - params.breakdownBufferPct / 100);
    if (closeH4 >= breakdownLevel)
      return this.reject("h4_no_donchian_breakdown");

    // Volume confirmation on the breakdown 4h candle.
    const avgVol = averageVolume(candles4h, params.volumeLookback);
    const breakdownCandle = candles4h[candles4h.length - 1];
    if (avgVol === undefined || avgVol <= 0)
      return this.reject("h4_volume_baseline_unavailable");
    if (!breakdownCandle) return this.reject("h4_breakdown_candle_missing");
    if (breakdownCandle.volume < avgVol * params.volumeMultiplier)
      return this.reject("h4_volume_not_confirmed");

    // Quality of the breakdown 4h candle.
    const quality = candleQuality(breakdownCandle);
    if (!quality.bearishBody)
      return this.reject("h4_breakdown_candle_not_bearish");
    if (quality.closeLocationPct > params.closeLocationMax)
      return this.reject("h4_breakdown_close_not_near_low");
    if (quality.bodyPct < params.bodyMin)
      return this.reject("h4_breakdown_body_too_small");
    if (quality.lowerWickPct > params.lowerWickMax)
      return this.reject("h4_breakdown_lower_wick_too_large");

    const close = context.latestCandle.close;
    const stopLoss = close + atr14h4 * params.stopAtrMult;
    if (!Number.isFinite(stopLoss) || stopLoss <= close)
      return this.reject("invalid_stop_loss");

    const riskPerShare = stopLoss - close;
    const takeProfit = close - riskPerShare * params.takeProfitR;
    if (takeProfit <= 0) return this.reject("invalid_take_profit");
    const plannedRewardPct = ((close - takeProfit) / close) * 100;
    if (plannedRewardPct < params.plannedRewardMinPct)
      return this.reject("planned_reward_too_small");

    const partialPrice = close - riskPerShare * params.partialAtR;

    const regimeBonus = Math.min(
      0.05,
      Math.max(0, ((context.indicators.regimeScore ?? 0) - 4) / 100),
    );
    const breakdownCleanlinessBonus = Math.min(
      0.04,
      Math.max(0, ((priorLow - closeH4) / priorLow) * 4),
    );
    const adxBonus = Math.min(
      0.04,
      Math.max(0, (adx14h4 - params.adxMin) / 200),
    );
    const confidenceScore = Math.min(
      0.95,
      0.78 + regimeBonus + breakdownCleanlinessBonus + adxBonus,
    );

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "SELL",
      direction: "SHORT",
      confidenceScore,
      entryReason: `Smallcap 4h Donchian short: closeH4=${closeH4.toFixed(2)} < priorLow${params.donchianWindow}=${priorLow.toFixed(2)} (-${(((priorLow - closeH4) / priorLow) * 100).toFixed(2)}%), EMA50H4=${ema50h4.toFixed(2)}, RSI14H4=${rsi14h4.toFixed(1)}, ADX14H4=${adx14h4.toFixed(1)}, MACDh4=${macdHistH4.toFixed(3)}, d1=${d1Snapshot.trend ?? "n/a"}, regimeScore=${context.indicators.regimeScore ?? "n/a"}`,
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
        priorLowN: priorLow,
        donchianWindow: params.donchianWindow,
        breakdownVolume: breakdownCandle.volume,
        avgVolumeN: avgVol,
        volumeMultiplier: params.volumeMultiplier,
        breakdownCloseLocationPct: quality.closeLocationPct,
        breakdownBodyPct: quality.bodyPct,
        breakdownLowerWickPct: quality.lowerWickPct,
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

    // Hard exit #1: Two consecutive 4h closes above EMA50(4h) on volume.
    // EMA50_4h is the core downtrend gate that entry required; regaining it = thesis broken.
    if (ema50h4 !== undefined) {
      const last1 = candles4h.at(-1);
      const last2 = candles4h.at(-2);
      const avgVol = averageVolume(candles4h, 20);
      const volThreshold = (avgVol ?? 0) * 1.3;
      if (
        last1 &&
        last2 &&
        last1.close > ema50h4 &&
        last2.close > ema50h4 &&
        avgVol !== undefined &&
        last1.volume >= volThreshold
      ) {
        return {
          strategyId: this.id,
          symbol: context.symbol,
          side: "BUY",
          reason:
            "Hard exit: 4h close above EMA50 on 2 consecutive candles + volume",
          confidenceScore: 0.95,
          metadata: {
            exitReason: "h4_reclaimed_ema50",
            ema50h4,
            last1Close: last1.close,
            last2Close: last2.close,
            volThreshold,
            last1Volume: last1.volume,
          },
        };
      }
    }

    // Hard exit #2: Regime flip from bear_trend or regimeScore > -minRegimeScore/2.
    if (
      context.directionalRegime !== "bear_trend" ||
      (context.indicators.regimeScore !== undefined &&
        context.indicators.regimeScore > -4 / 2)
    ) {
      return {
        strategyId: this.id,
        symbol: context.symbol,
        side: "BUY",
        reason:
          context.directionalRegime !== "bear_trend"
            ? `Hard exit: Regime flip detected (now ${context.directionalRegime})`
            : `Hard exit: Regime score bullish (${context.indicators.regimeScore?.toFixed(1)})`,
        confidenceScore: 0.9,
        metadata: {
          exitReason: "regime_flipped_bullish",
          newDirectionalRegime: context.directionalRegime,
          regimeScore: context.indicators.regimeScore,
          regimeConfidence: context.indicators.regimeConfidence,
        },
      };
    }

    // Hard exit #3: Daily trend flipped to bullish.
    if (d1 && d1.trend === "bullish") {
      return {
        strategyId: this.id,
        symbol: context.symbol,
        side: "BUY",
        reason: "Hard exit: 1d trend flipped to bullish",
        confidenceScore: 0.88,
        metadata: {
          exitReason: "d1_trend_bullish",
          d1Trend: d1.trend,
          d1Rsi: d1.rsi14,
        },
      };
    }

    return null;
  }
}
