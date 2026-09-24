import type { VerifiedStrategySession } from "../../strategies/strategy.types.js";
/**
 * PR15.4 — Indicator computation for `StrategyContext`.
 *
 * Extracted from the inline block in `SignalEngine.runForSymbol()`
 * so `StrategyContextLoader` can produce the same
 * `IndicatorSnapshot` shape without duplicating the logic. The
 * legacy `SignalEngine.runForSymbol()` continues to compute
 * indicators inline; PR15.4 does NOT swap it out — the extracted
 * helper simply mirrors that computation for the trading-loop
 * path.
 *
 * The output shape MUST equal what the inline path produces given
 * the same candle inputs; the equivalence is exercised by
 * `indicators.test.ts` (§14.10).
 */

import type {
  Candle,
  CandleTimeframe,
  IndicatorSnapshot,
  SecType,
  TimeframeIndicatorSnapshot,
} from "@ikbr/shared";
import {
  emaSlopePct,
  lastAdx,
  lastAtr,
  lastBollinger,
  lastCmf,
  lastDonchian,
  lastEma,
  lastMacd,
  lastMfi,
  lastObvSlope,
  lastRsi,
  lastSma,
} from "../../indicators.js";

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(denominator) || denominator === 0) return fallback;
  return numerator / denominator;
}

function returnPct(closes: number[], lookback: number): number | undefined {
  if (closes.length <= lookback) return undefined;
  const current = closes[closes.length - 1];
  const previous = closes[closes.length - 1 - lookback];
  if (!(previous > 0)) return undefined;
  return ((current - previous) / previous) * 100;
}

function buildTimeframeSnapshot(
  candles: Candle[],
): TimeframeIndicatorSnapshot | undefined {
  if (candles.length < 20) return undefined;
  const latest = candles[candles.length - 1];
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const ema20 = lastEma(closes, 20);
  const ema50 = lastEma(closes, 50);
  const ema200 = lastEma(closes, 200);
  const sma200 = lastSma(closes, 200);
  const macd = lastMacd(closes);
  const volumeAvailable = volumes.every(v => v >= 0);
  const cmf = volumeAvailable ? lastCmf(highs, lows, closes, volumes, 20) : undefined;
  const mfi = volumeAvailable ? lastMfi(highs, lows, closes, volumes, 14) : undefined;
  const bb = lastBollinger(closes, 20);
  let trend: TimeframeIndicatorSnapshot["trend"] = "neutral";
  if (
    ema20 !== undefined &&
    ema50 !== undefined &&
    latest.close > ema50 &&
    ema20 > ema50
  )
    trend = "bullish";
  if (
    ema20 !== undefined &&
    ema50 !== undefined &&
    latest.close < ema50 &&
    ema20 < ema50
  )
    trend = "bearish";
  return {
    close: latest.close,
    ema20,
    ema50,
    ema200,
    sma200,
    rsi14: lastRsi(closes, 14),
    atr14: lastAtr(highs, lows, closes, 14),
    adx14: lastAdx(highs, lows, closes, 14),
    macdHist: macd.histogram,
    macdHistPrev: macd.previousHistogram,
    macdHistPrev2: macd.previous2Histogram,
    cmf20: cmf?.value,
    mfi14: mfi?.value,
    bbWidthPct: bb.widthPct,
    volume: latest.volume >= 0 ? latest.volume : undefined,
    trend,
    priceVsEma50Bps:
      ema50 !== undefined
        ? safeDiv(latest.close - ema50, latest.close, 0) * 10000
        : undefined,
    ema50Slope10Pct: emaSlopePct(closes, 50, 10),
    return3Pct: returnPct(closes, 3),
    return4Pct: returnPct(closes, 4),
    return12Pct: returnPct(closes, 12),
    return18Pct: returnPct(closes, 18),
    return20Pct: returnPct(closes, 20),
    return24Pct: returnPct(closes, 24),
    return30Pct: returnPct(closes, 30),
    return48Pct: returnPct(closes, 48),
  };
}

function buildIntradaySnapshot(
  candles1m: Candle[],
  sessionGapMinutes = 60,
  verifiedSession?: VerifiedStrategySession,
): IndicatorSnapshot["intraday"] {
  if (candles1m.length < 2) return undefined;
  const latest = candles1m[candles1m.length - 1];
  const latestTs = new Date(latest.ts).getTime();
  let sessionStartIndex: number | undefined;
  let prevSessionCloseIndex: number | undefined;
  const gapMs = sessionGapMinutes * 60_000;
  if (verifiedSession) {
    const openMs = Date.parse(verifiedSession.sessionStart);
    const index = candles1m.findIndex(c => new Date(c.ts).getTime() === openMs);
    if (index < 1 || !verifiedSession.previousSessionCloseTs
      || candles1m[index - 1].ts.getTime() !== Date.parse(verifiedSession.previousSessionCloseTs)) return undefined;
    const observed = new Set(candles1m.map(c => c.ts.getTime()));
    for (const interval of verifiedSession.intervals) {
      for (let ts = Date.parse(interval.start); ts < Date.parse(interval.end) && ts <= latestTs; ts += 60000) {
        if (!observed.has(ts)) return undefined;
      }
    }
    sessionStartIndex = index;
    prevSessionCloseIndex = index - 1;
  } else {
  for (let i = candles1m.length - 1; i > 0; i -= 1) {
    const curTs = new Date(candles1m[i].ts).getTime();
    const prevTs = new Date(candles1m[i - 1].ts).getTime();
    if (curTs - prevTs >= gapMs) {
      sessionStartIndex = i;
      prevSessionCloseIndex = i - 1;
      break;
    }
  }
  }
  if (sessionStartIndex === undefined) return undefined;
  const sessionOpenCandle = candles1m[sessionStartIndex];
  const prevCloseCandle = candles1m[prevSessionCloseIndex!];
  const sessionOpen = sessionOpenCandle.open;
  const prevSessionClose = prevCloseCandle.close;
  const sessionOpenTs = sessionOpenCandle.ts;
  const minutesSinceSessionOpen = Math.max(
    0,
    Math.floor((latestTs - new Date(sessionOpenTs).getTime()) / 60_000),
  );
  const gapPct =
    prevSessionClose > 0
      ? ((sessionOpen - prevSessionClose) / prevSessionClose) * 100
      : undefined;
  const sessionCandles = candles1m.slice(sessionStartIndex).filter(c => !verifiedSession || verifiedSession.intervals.some(interval => {
    const ts = new Date(c.ts).getTime();
    return Date.parse(interval.start) <= ts && ts < Date.parse(interval.end);
  }));
  const orWindow = verifiedSession
    ? sessionCandles.filter(c => new Date(c.ts).getTime() < new Date(sessionOpenTs).getTime() + 30 * 60000)
    : sessionCandles.slice(0, 30);
  const openingRange30High =
    orWindow.length > 0 ? Math.max(...orWindow.map((c) => c.high)) : undefined;
  const openingRange30Low =
    orWindow.length > 0 ? Math.min(...orWindow.map((c) => c.low)) : undefined;
  let cumPv = 0;
  let cumVol = 0;
  for (const c of sessionCandles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPv += typical * c.volume;
    cumVol += c.volume;
  }
  const sessionVolumeAvailable = sessionCandles.every(c => c.volume >= 0);
  const vwap = sessionVolumeAvailable && cumVol > 0 ? cumPv / cumVol : undefined;
  const distanceFromVwapBps =
    vwap !== undefined && vwap > 0
      ? ((latest.close - vwap) / vwap) * 10000
      : undefined;
  return {
    prevSessionClose,
    sessionOpen,
    sessionOpenTs,
    minutesSinceSessionOpen,
    gapPct,
    openingRange30High,
    openingRange30Low,
    vwap,
    distanceFromVwapBps,
    sessionVolume: sessionVolumeAvailable && cumVol > 0 ? cumVol : undefined,
  };
}

export interface ComputeIndicatorsInput {
  readonly secType: SecType;
  readonly verifiedSession?: VerifiedStrategySession;
  readonly candlesByTimeframe: Partial<Record<CandleTimeframe, Candle[]>>;
}

/**
 * Pure-function equivalent of the inline indicator block in
 * `SignalEngine.runForSymbol()`. Given the same candle inputs it
 * yields the same `IndicatorSnapshot` (minus the regime fields,
 * which are populated later via `detectRegimeForContext`).
 */
export function computeIndicatorsForContext(
  input: ComputeIndicatorsInput,
): IndicatorSnapshot | null {
  const candles = input.candlesByTimeframe["1m"];
  if (!candles || candles.length === 0) return null;
  const candles1h = input.candlesByTimeframe["1h"] ?? [];
  const candles5m = input.candlesByTimeframe["5m"] ?? [];
  const candles4h = input.candlesByTimeframe["4h"] ?? [];
  const candles12h = input.candlesByTimeframe["12h"] ?? [];
  const candles1d = input.candlesByTimeframe["1d"] ?? [];
  const candles1w = input.candlesByTimeframe["1w"] ?? [];
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const trendFrom1h = lastEma(
    candles1h.map((c) => c.close),
    50,
  );
  const trendFrom1m = lastEma(closes, 200);
  const trendFilterValue = trendFrom1h ?? trendFrom1m;
  const macdSnapshot = lastMacd(closes);
  const volumeAvailable = volumes.every(v => v >= 0);
  const cmfSnapshot = volumeAvailable ? lastCmf(highs, lows, closes, volumes, 20) : undefined;
  const mfiSnapshot = volumeAvailable ? lastMfi(highs, lows, closes, volumes, 14) : undefined;
  const bbSnapshot = lastBollinger(closes, 20);
  const donchianSnapshot = lastDonchian(closes, 20);
  return {
    ema20: lastEma(closes, 20),
    ema50: lastEma(closes, 50),
    ema200: lastEma(closes, 200),
    sma200: lastSma(closes, 200),
    rsi14: lastRsi(closes, 14),
    rsi14Prev: lastRsi(closes.slice(0, -1), 14),
    atr14: lastAtr(highs, lows, closes, 14),
    adx14: lastAdx(highs, lows, closes, 14),
    macdLine: macdSnapshot.macdLine,
    macdSignal: macdSnapshot.signalLine,
    macdHist: macdSnapshot.histogram,
    macdHistPrev: macdSnapshot.previousHistogram,
    macdHistPrev2: macdSnapshot.previous2Histogram,
    cmf20: cmfSnapshot?.value,
    cmf20Prev: cmfSnapshot?.previous,
    mfi14: mfiSnapshot?.value,
    mfi14Prev: mfiSnapshot?.previous,
    bbUpper: bbSnapshot.upper,
    bbMiddle: bbSnapshot.middle,
    bbLower: bbSnapshot.lower,
    bbWidthPct: bbSnapshot.widthPct,
    dcUpper20: donchianSnapshot.upper,
    dcLower20: donchianSnapshot.lower,
    obvSlope: volumeAvailable ? lastObvSlope(closes, volumes, 8) : undefined,
    return5mPct: returnPct(closes, 5),
    return20mPct: returnPct(closes, 20),
    return60mPct: returnPct(closes, 60),
    trendFilterValue,
    trendFilterSource: trendFrom1h !== undefined ? "EMA50_1h" : "EMA200_1m",
    secType: input.secType,
    timeframes: {
      "5m": buildTimeframeSnapshot(candles5m),
      "1h": buildTimeframeSnapshot(candles1h),
      "4h": buildTimeframeSnapshot(candles4h),
      ...(input.candlesByTimeframe["12h"] ? { "12h": buildTimeframeSnapshot(candles12h) } : {}),
      "1d": buildTimeframeSnapshot(candles1d),
      "1w": buildTimeframeSnapshot(candles1w),
    },
    intraday: buildIntradaySnapshot(candles, 60, input.verifiedSession),
  };
}
