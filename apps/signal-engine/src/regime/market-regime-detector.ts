import type { AssetClass, IndicatorSnapshot, MarketRegime } from '@ikbr/shared';

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

export class MarketRegimeDetector {
  detect(assetClass: AssetClass, price: number, indicators: IndicatorSnapshot): MarketRegime {
    const atr14 = indicators.atr14 ?? 0;
    const ema50 = indicators.ema50 ?? price;
    const ema200 = indicators.ema200 ?? price;
    const atrPct = safeDiv(atr14, price, 0);
    const bbWidthPct = indicators.bbWidthPct ?? 0;
    const trendBps = Math.abs(safeDiv(ema50 - ema200, price, 0) * 10000);
    const macdMagnitude = Math.abs(indicators.macdHist ?? 0);

    const thresholds = {
      stock: { atrHigh: 0.01, bbHigh: 0.045, trendBps: 18 },
      commodity: { atrHigh: 0.014, bbHigh: 0.052, trendBps: 14 },
      index: { atrHigh: 0.0085, bbHigh: 0.04, trendBps: 12 }
    }[assetClass];

    if (atrPct >= thresholds.atrHigh || bbWidthPct >= thresholds.bbHigh) {
      return 'high_volatility';
    }

    const macdThreshold = Math.max(atr14 * 0.025, price * 0.0004);
    if (trendBps >= thresholds.trendBps && macdMagnitude >= macdThreshold) {
      return 'trend';
    }

    return 'range';
  }
}
