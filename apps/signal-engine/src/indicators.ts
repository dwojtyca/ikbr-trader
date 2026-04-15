import { atr, bb, dc, ema, macd, obv, rsi } from 'indicatorts';

export interface MacdSnapshot {
  macdLine?: number;
  signalLine?: number;
  histogram?: number;
  previousHistogram?: number;
}

export interface BollingerSnapshot {
  upper?: number;
  middle?: number;
  lower?: number;
  widthPct?: number;
}

export interface DonchianSnapshot {
  upper?: number;
  lower?: number;
}

function lastFinite(values: number[]): number | undefined {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function lastTwoFinite(values: number[]): { prev?: number; last?: number } {
  let last: number | undefined;
  let prev: number | undefined;

  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (!Number.isFinite(values[i])) continue;
    if (last === undefined) {
      last = values[i];
      continue;
    }
    prev = values[i];
    break;
  }

  return { prev, last };
}

export function lastEma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  return lastFinite(ema(values, { period }));
}

export function lastRsi(values: number[], period: number): number | undefined {
  if (values.length < period + 1) return undefined;
  return lastFinite(rsi(values, { period }));
}

export function lastAtr(highs: number[], lows: number[], closes: number[], period: number): number | undefined {
  if (highs.length !== lows.length || lows.length !== closes.length) return undefined;
  if (closes.length < period + 1) return undefined;

  const { atrLine } = atr(highs, lows, closes, { period });
  return lastFinite(atrLine);
}

export function lastMacd(values: number[], fast = 12, slow = 26, signal = 9): MacdSnapshot {
  if (values.length < Math.max(fast, slow) + signal) return {};

  const result = macd(values, { fast, slow, signal });
  const macdPair = lastTwoFinite(result.macdLine);
  const signalPair = lastTwoFinite(result.signalLine);

  const histogram =
    macdPair.last !== undefined && signalPair.last !== undefined
      ? macdPair.last - signalPair.last
      : undefined;
  const previousHistogram =
    macdPair.prev !== undefined && signalPair.prev !== undefined
      ? macdPair.prev - signalPair.prev
      : undefined;

  return {
    macdLine: macdPair.last,
    signalLine: signalPair.last,
    histogram,
    previousHistogram
  };
}

export function lastBollinger(values: number[], period = 20): BollingerSnapshot {
  if (values.length < period) return {};
  const result = bb(values, { period });
  const upper = lastFinite(result.upper);
  const middle = lastFinite(result.middle);
  const lower = lastFinite(result.lower);
  const widthPct =
    upper !== undefined && lower !== undefined && middle !== undefined && middle !== 0
      ? (upper - lower) / middle
      : undefined;

  return { upper, middle, lower, widthPct };
}

export function lastDonchian(values: number[], period = 20): DonchianSnapshot {
  if (values.length < period) return {};
  const result = dc(values, { period });
  return {
    upper: lastFinite(result.upper),
    lower: lastFinite(result.lower)
  };
}

export function lastObvSlope(closes: number[], volumes: number[], lookback = 8): number | undefined {
  if (closes.length !== volumes.length) return undefined;
  if (closes.length < lookback + 2) return undefined;

  const line = obv(closes, volumes);
  const last = line[line.length - 1];
  const previous = line[line.length - 1 - lookback];
  if (!Number.isFinite(last) || !Number.isFinite(previous)) return undefined;
  if (previous === 0) return 0;

  return (last - previous) / Math.abs(previous);
}
