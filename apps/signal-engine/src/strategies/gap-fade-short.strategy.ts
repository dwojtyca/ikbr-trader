import type { Candle, SecType } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "./strategy.types.js";

interface GapFadeShortParams {
  /** Minimum gap-up percent vs previous session close. */
  gapMinPct: number;
  /** Reject extreme gaps (likely news-driven, fade is dangerous). */
  gapMaxPct: number;
  /** Minimum minutes since session open before fading is allowed. */
  minMinutesSinceOpen: number;
  /** Maximum minutes since session open (fade window typically <= 90 min). */
  maxMinutesSinceOpen: number;
  /** RSI must be elevated to confirm overbought intraday. */
  rsiMin: number;
  /** RSI ceiling — above this, the move is a true breakout, not a gap to fade. */
  rsiMax: number;
  /** Minimum volume-vs-average multiplier on the trigger candle. */
  volumeMultiplier: number;
  /** Trigger candle close-location-of-range threshold (low quality required). */
  closeLocationMaxPct: number;
  /** Trigger candle minimum body fraction (avoid tiny dojis). */
  bodyMin: number;
  /** Stop = max(sessionOpen, close + atr * stopAtrMult). */
  stopAtrMult: number;
  /** Distance-from-VWAP minimum in bps (must be meaningfully above VWAP). */
  distanceFromVwapMinBps: number;
  /** Minimum planned reward percent (must clear commission drag). */
  plannedRewardMinPct: number;
  /** Take-profit target as a fraction of the gap (1.0 = full gap fill). */
  takeProfitGapFraction: number;
  /** Session window — only fade during liquid hours. */
  sessionUtcStartHour: number;
  sessionUtcEndHour: number;
}

function paramsForSecType(_secType: SecType): GapFadeShortParams {
  return {
    gapMinPct: 1.0,
    gapMaxPct: 5.0,
    minMinutesSinceOpen: 5,
    maxMinutesSinceOpen: 90,
    rsiMin: 55,
    rsiMax: 75,
    volumeMultiplier: 1.3,
    closeLocationMaxPct: 0.4,
    bodyMin: 0.15,
    stopAtrMult: 1.2,
    distanceFromVwapMinBps: 20,
    plannedRewardMinPct: 0.4,
    takeProfitGapFraction: 0.7,
    sessionUtcStartHour: 8,
    sessionUtcEndHour: 19,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

function candleQuality(candle: Candle): {
  closeLocationPct: number;
  bodyPct: number;
  bearishBody: boolean;
} {
  const range = candle.high - candle.low;
  if (!Number.isFinite(range) || range <= 0) {
    return { closeLocationPct: 0.5, bodyPct: 0, bearishBody: false };
  }
  return {
    // 0 = close at low, 1 = close at high
    closeLocationPct: (candle.close - candle.low) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    bearishBody: candle.close < candle.open,
  };
}

/**
 * Gap-fade short: enters SHORT after a gap-up that fails to follow through
 * within the first ~90 minutes of the session. Targets a partial gap fill.
 *
 * Rationale: in bullish/range markets, gap-ups are common but only ~40-50%
 * extend; the rest fade to VWAP or partially fill. This strategy captures
 * those fades using intraday session metadata (gap %, VWAP, opening range).
 *
 * Entry checklist:
 *   - Overnight gap-up of [1%, 5%] vs previous session close
 *   - Latest candle is bearish, near its low, with elevated volume
 *   - Price still above session VWAP (room to fade) and above prevSessionClose
 *   - RSI between 55 and 75 (overbought but not blow-off)
 *   - Time window: 5-90 min after session open
 *   - Within UTC liquid hours
 *
 * Exit:
 *   - Stop = max(session open, close + atr * 1.2)
 *   - TP = prevSessionClose + (1 - takeProfitGapFraction) * gap (default: 70% fill)
 */
export class GapFadeShortStrategy implements Strategy {
  readonly id = "gap_fade_short_v1";
  readonly secTypes = ["STK", "IND", "ETF"] as const;
  readonly supportedDirections = ["SHORT"] as const;
  readonly allowedDirectionalRegimes = [
    "bull_trend",
    "range",
    "bear_trend",
  ] as const;
  readonly allowedVolatilityRegimes = [
    "normal_volatility",
    "high_volatility",
  ] as const;
  readonly requiredTimeframes = ["1m"] as const;
  private lastRejectionReason: string | undefined;

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason;
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    this.lastRejectionReason = undefined;

    if (
      !this.secTypes.includes(context.secType as (typeof this.secTypes)[number])
    )
      return this.reject("sec_type_not_supported");

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
    const rsi14 = indicators.rsi14;
    const atr14 = indicators.atr14;
    if (rsi14 === undefined || atr14 === undefined)
      return this.reject("missing_required_indicators");

    const intraday = indicators.intraday;
    if (!intraday) return this.reject("intraday_metadata_unavailable");

    const {
      sessionOpen,
      prevSessionClose,
      gapPct,
      minutesSinceSessionOpen,
      vwap,
      distanceFromVwapBps,
    } = intraday;

    if (
      sessionOpen === undefined ||
      prevSessionClose === undefined ||
      gapPct === undefined ||
      minutesSinceSessionOpen === undefined ||
      vwap === undefined ||
      distanceFromVwapBps === undefined
    ) {
      return this.reject("intraday_fields_incomplete");
    }

    if (gapPct < params.gapMinPct) return this.reject("gap_too_small");
    if (gapPct > params.gapMaxPct)
      return this.reject("gap_too_large_news_risk");

    if (minutesSinceSessionOpen < params.minMinutesSinceOpen)
      return this.reject("too_early_in_session");
    if (minutesSinceSessionOpen > params.maxMinutesSinceOpen)
      return this.reject("fade_window_expired");

    if (rsi14 < params.rsiMin) return this.reject("rsi_not_elevated");
    if (rsi14 > params.rsiMax) return this.reject("rsi_blowoff_avoid");

    // Price must still be above prevSessionClose (otherwise gap is already filled).
    if (close <= prevSessionClose) return this.reject("gap_already_filled");
    // Price must be above VWAP — that's the space we fade into.
    if (distanceFromVwapBps < params.distanceFromVwapMinBps)
      return this.reject("price_too_close_to_vwap");

    const candles1m = context.candlesByTimeframe["1m"] ?? [];
    const previousAverageVolume = averageVolume(candles1m.slice(0, -1), 20);
    if (previousAverageVolume === undefined || previousAverageVolume <= 0)
      return this.reject("volume_baseline_unavailable");
    if (latestCandle.volume < previousAverageVolume * params.volumeMultiplier)
      return this.reject("volume_not_confirmed");

    const quality = candleQuality(latestCandle);
    if (!quality.bearishBody) return this.reject("trigger_candle_not_bearish");
    if (quality.closeLocationPct > params.closeLocationMaxPct)
      return this.reject("trigger_close_not_near_low");
    if (quality.bodyPct < params.bodyMin)
      return this.reject("trigger_body_too_small");

    // Stop above session open + ATR cushion.
    const atrStop = close + atr14 * params.stopAtrMult;
    const stopLoss = Math.max(sessionOpen, atrStop);
    if (!Number.isFinite(stopLoss) || stopLoss <= close)
      return this.reject("invalid_stop_loss");

    // Target: partial gap fill. e.g. takeProfitGapFraction=0.7 = fade 70% of gap.
    const gapAbs = sessionOpen - prevSessionClose;
    const takeProfit = sessionOpen - gapAbs * params.takeProfitGapFraction;
    if (takeProfit <= 0 || takeProfit >= close)
      return this.reject("invalid_take_profit");

    const plannedRewardPct = ((close - takeProfit) / close) * 100;
    if (plannedRewardPct < params.plannedRewardMinPct)
      return this.reject("planned_reward_too_small");

    const riskPerShare = stopLoss - close;
    const rMultiple =
      riskPerShare > 0 ? (close - takeProfit) / riskPerShare : 0;
    if (rMultiple < 1) return this.reject("reward_to_risk_below_1");

    // Confidence:
    //   - bigger gap (within bounds) = stronger fade signal
    //   - higher RSI = more overbought
    //   - more distance from VWAP = more room to fade
    //   - better candle quality = stronger trigger
    const gapScore = clamp((gapPct - params.gapMinPct) / 3, 0, 0.12);
    const rsiScore = clamp((rsi14 - params.rsiMin) / 25, 0, 0.1);
    const vwapScore = clamp(distanceFromVwapBps / 200, 0, 0.08);
    const qualityScore = clamp(
      (1 - quality.closeLocationPct) * 0.06 + quality.bodyPct * 0.04,
      0,
      0.1,
    );
    const confidenceScore = clamp(
      0.6 + gapScore + rsiScore + vwapScore + qualityScore,
      0,
      0.9,
    );

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "SELL",
      direction: "SHORT",
      confidenceScore,
      entryReason: `Gap fade short: gap=${gapPct.toFixed(2)}%, minutesSinceOpen=${minutesSinceSessionOpen}, RSI14=${rsi14.toFixed(1)}, distFromVWAP=${distanceFromVwapBps.toFixed(0)}bps, close=${close.toFixed(2)}`,
      invalidationLevel: stopLoss,
      suggestedEntry: close,
      stopLoss,
      takeProfit,
      metadata: {
        gapPct,
        sessionOpen,
        prevSessionClose,
        vwap,
        distanceFromVwapBps,
        minutesSinceSessionOpen,
        atr14,
        rsi14,
        rMultiple,
        plannedRewardPct,
      },
      generatedFromCandleTs: latestCandle.ts as Date,
    };
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }
}
