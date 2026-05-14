import { atr, bb, cmf, dc, ema, macd, mfi, obv, rsi, sma } from 'indicatorts';

export interface MacdSnapshot {
  macdLine?: number;
  signalLine?: number;
  histogram?: number;
  previousHistogram?: number;
  previous2Histogram?: number;
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

function lastThreeFinite(values: number[]): {
  prev2?: number;
  prev?: number;
  last?: number;
} {
  const found: number[] = [];
  for (let i = values.length - 1; i >= 0 && found.length < 3; i -= 1) {
    if (Number.isFinite(values[i])) found.push(values[i]);
  }
  return {
    last: found[0],
    prev: found[1],
    prev2: found[2],
  };
}

export function lastEma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  return lastFinite(ema(values, { period }));
}

export function emaSlopePct(
  values: number[],
  period: number,
  lookback: number,
): number | undefined {
  if (values.length < period + lookback) return undefined;
  const line = ema(values, { period }).filter((value) => Number.isFinite(value));
  if (line.length <= lookback) return undefined;
  const current = line[line.length - 1];
  const previous = line[line.length - 1 - lookback];
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0)
    return undefined;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function lastSma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  return lastFinite(sma(values, { period }));
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

export function lastAdx(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number,
): number | undefined {
  if (highs.length !== lows.length || lows.length !== closes.length)
    return undefined;
  if (closes.length < period * 2 + 1) return undefined;

  const trs: number[] = [];
  const plusDms: number[] = [];
  const minusDms: number[] = [];

  for (let i = 1; i < closes.length; i += 1) {
    const highMove = highs[i] - highs[i - 1];
    const lowMove = lows[i - 1] - lows[i];
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
    plusDms.push(highMove > lowMove && highMove > 0 ? highMove : 0);
    minusDms.push(lowMove > highMove && lowMove > 0 ? lowMove : 0);
  }

  let trSmooth = trs.slice(0, period).reduce((sum, value) => sum + value, 0);
  let plusSmooth = plusDms
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0);
  let minusSmooth = minusDms
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0);

  const dxs: number[] = [];
  for (let i = period; i < trs.length; i += 1) {
    trSmooth = trSmooth - trSmooth / period + trs[i];
    plusSmooth = plusSmooth - plusSmooth / period + plusDms[i];
    minusSmooth = minusSmooth - minusSmooth / period + minusDms[i];

    if (trSmooth <= 0) continue;
    const plusDi = (100 * plusSmooth) / trSmooth;
    const minusDi = (100 * minusSmooth) / trSmooth;
    const diSum = plusDi + minusDi;
    if (diSum <= 0) continue;
    dxs.push((100 * Math.abs(plusDi - minusDi)) / diSum);
  }

  if (dxs.length < period) return undefined;
  let adxValue = dxs.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (let i = period; i < dxs.length; i += 1) {
    adxValue = (adxValue * (period - 1) + dxs[i]) / period;
  }
  return Number.isFinite(adxValue) ? adxValue : undefined;
}

export function lastMacd(values: number[], fast = 12, slow = 26, signal = 9): MacdSnapshot {
  if (values.length < Math.max(fast, slow) + signal) return {};

  const result = macd(values, { fast, slow, signal });
  const macdPair = lastThreeFinite(result.macdLine);
  const signalPair = lastThreeFinite(result.signalLine);

  const histogram =
    macdPair.last !== undefined && signalPair.last !== undefined
      ? macdPair.last - signalPair.last
      : undefined;
  const previousHistogram =
    macdPair.prev !== undefined && signalPair.prev !== undefined
      ? macdPair.prev - signalPair.prev
      : undefined;
  const previous2Histogram =
    macdPair.prev2 !== undefined && signalPair.prev2 !== undefined
      ? macdPair.prev2 - signalPair.prev2
      : undefined;

  return {
    macdLine: macdPair.last,
    signalLine: signalPair.last,
    histogram,
    previousHistogram,
    previous2Histogram
  };
}

export function lastCmf(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  period = 20
): { value?: number; previous?: number } {
  if (highs.length !== lows.length || lows.length !== closes.length || closes.length !== volumes.length) return {};
  if (closes.length < period + 1) return {};

  const pair = lastTwoFinite(cmf(highs, lows, closes, volumes, { period }));
  return { value: pair.last, previous: pair.prev };
}

export function lastMfi(
  highs: number[],
  lows: number[],
  closes: number[],
  volumes: number[],
  period = 14
): { value?: number; previous?: number } {
  if (highs.length !== lows.length || lows.length !== closes.length || closes.length !== volumes.length) return {};
  if (closes.length < period + 1) return {};

  const pair = lastTwoFinite(mfi(highs, lows, closes, volumes, { period }));
  return { value: pair.last, previous: pair.prev };
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
