import { AAPL_NATIVE_SOURCE, newYorkMidnight, filterClosedAaplCandles, type AaplScheduleEvidence, type AaplTimeframe, type Candle } from '@ikbr/shared';

export const AAPL_FIXTURE_NOW = new Date('2026-09-24T18:00:00Z');
const holidays = new Set(['2026-09-07', '2026-11-26', '2026-01-01', '2025-12-25']);
export function nativeAaplSchedule(now = AAPL_FIXTURE_NOW): AaplScheduleEvidence {
  const days: Array<{ date: string; start: string; end: string }> = [];
  const today = new Date(now.toISOString().slice(0, 10) + 'T12:00:00Z');
  for (let i = 22; i >= 0; i--) {
    const date = new Date(today.getTime() - i * 86400000), label = date.toISOString().slice(0, 10);
    if ([0, 6].includes(date.getUTCDay()) || holidays.has(label)) continue;
    const midnight = newYorkMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()).getTime();
    days.push({ date: label, start: new Date(midnight + 570 * 60000).toISOString(), end: new Date(midnight + (label === '2026-11-27' ? 780 : 960) * 60000).toISOString() });
  }
  return { generation: 1, status: 'READY', updatedAt: now.toISOString(), schedule: {
    source: 'ibkr_aapl_schedule_v1', conId: 265598, symbol: 'AAPL', exchange: 'SMART', currency: 'USD', secType: 'STK', timeZone: 'America/New_York',
    coverageStart: new Date(today.getTime() - 22 * 86400000 - 12 * 3600000).toISOString(),
    coverageEnd: new Date(today.getTime() + 86400000).toISOString(), requestedAt: now.toISOString(), receivedAt: now.toISOString(), sessions: days,
  } };
}

// Frozen synthetic RTH history for deterministic replay, not profitability evidence.
export function nativeAaplFixture(now = AAPL_FIXTURE_NOW): Record<AaplTimeframe, Candle[]> {
  const result = {} as Record<AaplTimeframe, Candle[]>;
  const today = new Date(now.toISOString().slice(0, 10) + 'T12:00:00Z');
  const schedule = nativeAaplSchedule(now).schedule!;
  for (const tf of ['1m', '5m', '1h', '4h', '1d', '1w'] as const) {
    const bars: Candle[] = [];
    for (let days = ({ '1m': 7, '5m': 7, '1h': 25, '4h': 80, '1d': 110, '1w': 480 }[tf]); days >= 0; days--) {
      const day = new Date(today.getTime() - days * 86400000), label = day.toISOString().slice(0, 10);
      const weekday = day.getUTCDay();
      if (weekday === 0 || weekday === 6 || holidays.has(label) || (tf === '1w' && weekday !== 5)) continue;
      const midnight = newYorkMidnight(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()).getTime();
      const minutes = tf === '1m' || tf === '5m' ? Array.from({ length: 390 / (tf === '1m' ? 1 : 5) }, (_, i) => 570 + i * (tf === '1m' ? 1 : 5))
        : tf === '1h' ? [570, 600, 660, 720, 780, 840, 900] : tf === '4h' ? [570, ...Array.from({ length: 7 }, (_, i) => ((Math.floor(midnight / 14400000) + i) * 14400000 - midnight) / 60000).filter(m => m > 570 && m < 960)] : [0];
      for (const minute of minutes.filter(m => m < (label === '2026-11-27' ? 780 : 960))) {
        const close = 200 + bars.length * 0.0001 + Math.sin(bars.length / 12) * 0.05;
        bars.push({ symbol: 'AAPL', conid: '265598', timeframe: tf, ts: new Date(midnight + minute * 60000), source: AAPL_NATIVE_SOURCE,
          open: close - .01, high: close + .05, low: close - .05, close, volume: 10000 + bars.length % 100 });
      }
    }
    result[tf] = filterClosedAaplCandles(bars.filter(c => tf !== '1w' || c.ts.getTime() + 3 * 86400000 <= now.getTime()), tf, schedule, now.getTime()).slice(-(tf === '1m' ? 300 : 60));
  }
  return result;
}
