import type { Candle } from '@ikbr/shared';
import type { Strategy, StrategyContext, StrategySignal } from './strategy.types.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function localConsolidationLow(candles: Candle[], lookback: number): number | undefined {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return undefined;
  return Math.min(...slice.map((candle) => candle.low));
}

function averageVolume(candles: Candle[], lookback: number): number | undefined {
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
      bullishBody: false
    };
  }

  const bodyHigh = Math.max(candle.open, candle.close);
  return {
    closeLocationPct: (candle.close - candle.low) / range,
    bodyPct: Math.abs(candle.close - candle.open) / range,
    upperWickPct: (candle.high - bodyHigh) / range,
    bullishBody: candle.close > candle.open
  };
}

export class MomentumBreakoutLongStrategy implements Strategy {
  readonly id = 'momentum_breakout_long_v1';
  readonly assetClasses = ['stock'] as const;
  readonly supportedDirections = ['LONG'] as const;
  readonly allowedRegimes = ['bull_trend'] as const;
  readonly requiredTimeframes = ['1m', '1h', '4h', '1d'] as const;
  private lastRejectionReason: string | undefined;

  getLastRejectionReason(): string | undefined {
    return this.lastRejectionReason;
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    this.lastRejectionReason = undefined;

    if (context.assetClass !== 'stock') return this.reject('asset_class_not_stock');
    if (context.regime !== 'bull_trend') return this.reject('regime_not_bull_trend');

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
      return this.reject('missing_required_indicators');
    }

    const h1 = indicators.timeframes?.['1h'];
    const h4 = indicators.timeframes?.['4h'];
    const d1 = indicators.timeframes?.['1d'];
    if (!h1 || !h4 || !d1) return this.reject('higher_timeframe_unavailable');
    if (h1.trend !== 'bullish') return this.reject('higher_timeframe_1h_not_bullish');
    if (h4.trend === 'bearish') return this.reject('higher_timeframe_4h_bearish');
    if (d1.trend === 'bearish') return this.reject('higher_timeframe_1d_bearish');
    if ((d1.return20Pct ?? 0) < 10) return this.reject('daily_momentum_too_weak');

    if (close <= ema200) return this.reject('close_below_ema200');
    if (close <= ema50) return this.reject('close_below_ema50');
    if (ema20 <= ema50) return this.reject('ema20_not_above_ema50');
    if (rsi14 >= 65) return this.reject('rsi_overheated');
    if ((indicators.return20mPct ?? 0) > 1.2) return this.reject('overextended_20m');
    if ((indicators.return60mPct ?? 0) > 2.5) return this.reject('overextended_60m');
    if ((indicators.return60mPct ?? 0) < 1) return this.reject('intraday_momentum_too_weak');
    if (indicators.bbWidthPct !== undefined && indicators.bbWidthPct > 0.04) return this.reject('volatility_not_compressed');

    const candles1m = context.candlesByTimeframe['1m'] ?? [];
    const priorHigh20 = previousHigh(candles1m, 20);
    if (priorHigh20 === undefined) return this.reject('prior_high_unavailable');
    const breakoutBuffer = Math.max(atr14 * 0.03, close * 0.0005);
    if (close < priorHigh20 + breakoutBuffer) return this.reject('no_confirmed_breakout');
    if (close < donchianUpper) return this.reject('no_donchian_breakout');

    const previousAverageVolume = averageVolume(candles1m.slice(0, -1), 20);
    if (previousAverageVolume === undefined || previousAverageVolume <= 0) return this.reject('volume_baseline_unavailable');
    if (latestCandle.volume < previousAverageVolume * 1.05) return this.reject('volume_not_confirmed');

    const quality = candleQuality(latestCandle);
    if (!quality.bullishBody) return this.reject('breakout_candle_not_bullish');
    if (quality.closeLocationPct < 0.72) return this.reject('breakout_close_not_near_high');
    if (quality.bodyPct < 0.25) return this.reject('breakout_body_too_small');
    if (quality.upperWickPct > 0.35) return this.reject('breakout_upper_wick_too_large');

    const consolidationLow = localConsolidationLow(candles1m, 20);
    const atrStop = close - atr14 * 2;
    const structureStop =
      consolidationLow !== undefined && consolidationLow < close
        ? Math.max(consolidationLow, close - atr14 * 3)
        : undefined;
    const stopLoss = Math.min(atrStop, structureStop ?? atrStop);
    if (!Number.isFinite(stopLoss) || stopLoss >= close) return this.reject('invalid_stop_loss');

    const riskPerShare = close - stopLoss;
    const takeProfit = close + riskPerShare * 2;
    const plannedRewardPct = ((takeProfit - close) / close) * 100;
    if (plannedRewardPct < 1) return this.reject('planned_reward_too_small');

    const trendScore = clamp((ema20 - ema50) / close * 150, 0, 0.18);
    const breakoutScore = clamp((close - priorHigh20) / close * 3500, 0, 0.12);
    const rsiScore = rsi14 >= 55 && rsi14 < 65 ? 0.1 : rsi14 > 50 ? 0.06 : 0;
    const compressionScore =
      indicators.bbWidthPct !== undefined
        ? clamp((0.045 - indicators.bbWidthPct) / 0.045, 0, 1) * 0.08
        : 0.03;
    const confidenceScore = clamp(0.58 + trendScore + breakoutScore + rsiScore + compressionScore, 0, 0.88);

    return {
      strategyId: this.id,
      symbol: context.symbol,
      side: 'BUY',
      direction: 'LONG',
      confidenceScore,
      entryReason: `Momentum breakout long: close=${close.toFixed(2)} above priorHigh20=${priorHigh20.toFixed(2)} and EMA50/EMA200, RSI14=${rsi14.toFixed(1)}, h1=${h1.trend}, h4=${h4.trend}, d1=${d1.trend}`,
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
        donchianUpper,
        priorHigh20,
        breakoutBuffer,
        bbWidthPct: indicators.bbWidthPct,
        previousAverageVolume,
        latestVolume: latestCandle.volume,
        breakoutCloseLocationPct: quality.closeLocationPct,
        breakoutBodyPct: quality.bodyPct,
        breakoutUpperWickPct: quality.upperWickPct,
        plannedRewardPct,
        regime: context.regime,
        directionalRegime: indicators.directionalRegime,
        volatilityRegime: indicators.volatilityRegime,
        regimeScore: indicators.regimeScore,
        regimeConfidence: indicators.regimeConfidence,
        h1Trend: h1.trend,
        h4Trend: h4.trend,
        d1Trend: d1.trend,
        d1Return20Pct: d1.return20Pct,
        consolidationLow
      },
      generatedFromCandleTs: context.latestCandle.ts
    };
  }

  private reject(reason: string): null {
    this.lastRejectionReason = reason;
    return null;
  }
}
