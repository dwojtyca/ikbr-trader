import { AAPL_NATIVE_SOURCE, newYorkMidnight, validClosedAaplCandle, type AaplTimeframe, type Candle } from '@ikbr/shared';

export const AAPL_FIXTURE_NOW = new Date('2026-09-24T18:00:00Z');

// Frozen synthetic RTH history for deterministic replay, not profitability evidence.
export function nativeAaplFixture(now = AAPL_FIXTURE_NOW): Record<AaplTimeframe, Candle[]> {
  const result = {} as Record<AaplTimeframe, Candle[]>;
  for (const tf of ['1m', '5m', '1h', '4h', '1d', '1w'] as const) {
    const bars: Candle[] = [];
    for (let days = ({ '1m': 3, '5m': 4, '1h': 20, '4h': 70, '1d': 100, '1w': 460 }[tf]); days >= 0; days--) {
      const day = new Date(Date.UTC(2026, 8, 24 - days));
      const weekday = day.getUTCDay();
      if (weekday === 0 || weekday === 6 || (tf === '1w' && weekday !== 1)) continue;
      const midnight = newYorkMidnight(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()).getTime();
      const step = { '1m': 1, '5m': 5, '1h': 60, '4h': 240, '1d': 0, '1w': 0 }[tf];
      const minutes = step ? Array.from({ length: Math.ceil(390 / step) }, (_, i) => 570 + i * step) : [0];
      for (const minute of minutes) {
        const close = 200 + bars.length * 0.0001 + Math.sin(bars.length / 12) * 0.05;
        const bar: Candle = { symbol: 'AAPL', conid: '265598', timeframe: tf,
          ts: new Date(midnight + minute * 60000), source: AAPL_NATIVE_SOURCE,
          open: close - .01, high: close + .05, low: close - .05, close, volume: 10000 + bars.length % 100 };
        if (validClosedAaplCandle(bar, now.getTime())) bars.push(bar);
      }
    }
    result[tf] = bars.slice(-(tf === '1m' ? 300 : 60));
  }
  return result;
}
