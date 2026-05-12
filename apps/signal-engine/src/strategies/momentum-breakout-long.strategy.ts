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

export class MomentumBreakoutLongStrategy implements Strategy {
  readonly id = 'momentum_breakout_long_v1';
  readonly assetClasses = ['stock'] as const;
  readonly supportedDirections = ['LONG'] as const;
  readonly allowedRegimes = ['trend'] as const;
  readonly requiredTimeframes = ['1m'] as const;

  generateSignal(context: StrategyContext): StrategySignal | null {
    if (context.assetClass !== 'stock') return null;
    if (context.regime !== 'trend') return null;

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
      return null;
    }

    if (close <= ema200) return null;
    if (close <= ema50) return null;
    if (ema20 <= ema50) return null;
    if (close < donchianUpper) return null;
    if (rsi14 >= 72) return null;

    const candles1m = context.candlesByTimeframe['1m'] ?? [];
    const consolidationLow = localConsolidationLow(candles1m, 20);
    const atrStop = close - atr14 * 2;
    const structureStop =
      consolidationLow !== undefined && consolidationLow < close
        ? Math.max(consolidationLow, close - atr14 * 3)
        : undefined;
    const stopLoss = Math.min(atrStop, structureStop ?? atrStop);
    if (!Number.isFinite(stopLoss) || stopLoss >= close) return null;

    const riskPerShare = close - stopLoss;
    const takeProfit = close + riskPerShare * 2;
    const trendScore = clamp((ema20 - ema50) / close * 150, 0, 0.18);
    const breakoutScore = clamp((close - donchianUpper) / close * 5000, 0, 0.12);
    const rsiScore = rsi14 >= 55 && rsi14 <= 68 ? 0.1 : rsi14 > 50 ? 0.06 : 0;
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
      entryReason: `Momentum breakout long: close=${close.toFixed(2)} above EMA50/EMA200 and Donchian20=${donchianUpper.toFixed(2)}, RSI14=${rsi14.toFixed(1)}`,
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
        bbWidthPct: indicators.bbWidthPct,
        consolidationLow
      },
      generatedFromCandleTs: context.latestCandle.ts
    };
  }
}
