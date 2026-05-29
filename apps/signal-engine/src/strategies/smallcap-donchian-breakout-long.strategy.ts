import type { Candle } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
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
  /** Minimum gap above prior N-bar high (in % of close) to count as a true breakout. */
  breakoutBufferPct: number;
  /** Stop = entry - stopAtrMult * ATR(4h). */
  stopAtrMult: number;
  /** Take-profit = entry + takeProfitR * (entry - stop). */
  takeProfitR: number;
  /** Minimum planned reward in % of entry. */
  plannedRewardMinPct: number;
}

function defaultParams(): SmallcapDonchianLongParams {
  return {
    minRegimeScore: 4,
    donchianWindow: 20,
    rsiMin: 50,
    rsiMax: 75,
    breakoutBufferPct: 0.1,
    stopAtrMult: 2,
    takeProfitR: 3,
    plannedRewardMinPct: 1.5,
  };
}

function priorMaxHigh(candles: Candle[], lookback: number): number | undefined {
  // Exclude the most recent (current) 4h candle.
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  return Math.max(...slice.map((c) => c.high));
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
  // 1m needed for the latest fill price, 4h for the breakout setup itself.
  readonly requiredTimeframes = ["1m", "4h"] as const;
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
    const candles4h = context.candlesByTimeframe["4h"] ?? [];
    if (!h4Snapshot) return this.reject("h4_snapshot_unavailable");
    if (candles4h.length < params.donchianWindow + 2)
      return this.reject("h4_history_insufficient");

    const ema50h4 = h4Snapshot.ema50;
    const rsi14h4 = h4Snapshot.rsi14;
    const atr14h4 = h4Snapshot.atr14;
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

    // Momentum gate.
    if (rsi14h4 < params.rsiMin) return this.reject("h4_rsi_too_low");
    if (rsi14h4 > params.rsiMax) return this.reject("h4_rsi_overbought");

    // Donchian breakout on 4h.
    const priorHigh = priorMaxHigh(candles4h, params.donchianWindow);
    if (priorHigh === undefined) return this.reject("h4_donchian_unavailable");
    const breakoutLevel = priorHigh * (1 + params.breakoutBufferPct / 100);
    if (closeH4 <= breakoutLevel) return this.reject("h4_no_donchian_breakout");

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

    const regimeBonus = Math.min(
      0.05,
      Math.max(0, ((context.indicators.regimeScore ?? 10) - 10) / 200),
    );
    const breakoutCleanlinessBonus = Math.min(
      0.04,
      Math.max(0, ((closeH4 - priorHigh) / priorHigh) * 4),
    );
    const confidenceScore = Math.min(
      0.95,
      0.82 + regimeBonus + breakoutCleanlinessBonus,
    );

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "BUY",
      direction: "LONG",
      confidenceScore,
      entryReason: `Smallcap 4h Donchian long: closeH4=${closeH4.toFixed(2)} > priorHigh${params.donchianWindow}=${priorHigh.toFixed(2)} (+${(((closeH4 - priorHigh) / priorHigh) * 100).toFixed(2)}%), EMA50H4=${ema50h4.toFixed(2)}, RSI14H4=${rsi14h4.toFixed(1)}, regimeScore=${context.indicators.regimeScore ?? "n/a"}`,
      invalidationLevel: stopLoss,
      suggestedEntry: close,
      stopLoss,
      takeProfit,
      metadata: {
        timeframe: "4h",
        ema50h4,
        rsi14h4,
        atr14h4,
        closeH4,
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
