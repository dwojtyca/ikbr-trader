import type { Candle } from "@ikbr/shared";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "./strategy.types.js";

interface SmallcapDonchianShortParams {
  minRegimeScore: number;
  donchianWindow: number;
  /** Maximum 4h RSI to allow short entry (overbought = no short). */
  rsiMax: number;
  /** Minimum 4h RSI to avoid late/oversold entries. */
  rsiMin: number;
  /** Minimum gap below prior N-bar low (in % of close). */
  breakdownBufferPct: number;
  /** Stop = entry + stopAtrMult * ATR(4h). */
  stopAtrMult: number;
  /** Take-profit = entry - takeProfitR * (stop - entry). */
  takeProfitR: number;
  plannedRewardMinPct: number;
}

function defaultParams(): SmallcapDonchianShortParams {
  return {
    minRegimeScore: 4,
    donchianWindow: 20,
    rsiMax: 50,
    rsiMin: 25,
    breakdownBufferPct: 0.1,
    stopAtrMult: 2,
    takeProfitR: 3,
    plannedRewardMinPct: 1.5,
  };
}

function priorMinLow(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-(lookback + 1), -1);
  if (slice.length < lookback) return undefined;
  return Math.min(...slice.map((c) => c.low));
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

    // Downtrend gate.
    if (closeH4 >= ema50h4) return this.reject("h4_close_above_ema50");

    // Momentum gate (avoid shorting into oversold capitulation).
    if (rsi14h4 > params.rsiMax) return this.reject("h4_rsi_too_high");
    if (rsi14h4 < params.rsiMin) return this.reject("h4_rsi_oversold");

    // Donchian breakdown on 4h.
    const priorLow = priorMinLow(candles4h, params.donchianWindow);
    if (priorLow === undefined) return this.reject("h4_donchian_unavailable");
    const breakdownLevel = priorLow * (1 - params.breakdownBufferPct / 100);
    if (closeH4 >= breakdownLevel)
      return this.reject("h4_no_donchian_breakdown");

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

    const regimeBonus = Math.min(
      0.05,
      Math.max(0, ((context.indicators.regimeScore ?? 10) - 10) / 200),
    );
    const breakdownCleanlinessBonus = Math.min(
      0.04,
      Math.max(0, ((priorLow - closeH4) / priorLow) * 4),
    );
    const confidenceScore = Math.min(
      0.95,
      0.82 + regimeBonus + breakdownCleanlinessBonus,
    );

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: "SELL",
      direction: "SHORT",
      confidenceScore,
      entryReason: `Smallcap 4h Donchian short: closeH4=${closeH4.toFixed(2)} < priorLow${params.donchianWindow}=${priorLow.toFixed(2)} (-${(((priorLow - closeH4) / priorLow) * 100).toFixed(2)}%), EMA50H4=${ema50h4.toFixed(2)}, RSI14H4=${rsi14h4.toFixed(1)}, regimeScore=${context.indicators.regimeScore ?? "n/a"}`,
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
        priorLowN: priorLow,
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
