import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  Candle,
  CandleTimeframe,
  IndicatorSnapshot,
  SecType,
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
import { computeIndicatorsForContext } from "./indicators.js";

// ---------------------------------------------------------------------------
// PR15.4 §14.10 — equivalence with the legacy inline block in
// `SignalEngine.runForSymbol`. Given identical candle inputs the extracted
// helper MUST reproduce every field of the inline IndicatorSnapshot.
//
// We rebuild the legacy inline computation here for a controlled fixture and
// compare field-by-field with the extracted helper.
// ---------------------------------------------------------------------------

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

function inlineTimeframeSnapshot(candles: Candle[]) {
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
  const cmf = lastCmf(highs, lows, closes, volumes, 20);
  const mfi = lastMfi(highs, lows, closes, volumes, 14);
  const bb = lastBollinger(closes, 20);
  let trend: "bullish" | "bearish" | "neutral" = "neutral";
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
    cmf20: cmf.value,
    mfi14: mfi.value,
    bbWidthPct: bb.widthPct,
    volume: latest.volume,
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

function inlineIntradaySnapshot(
  candles1m: Candle[],
  sessionGapMinutes = 60,
): IndicatorSnapshot["intraday"] {
  if (candles1m.length < 2) return undefined;
  const latest = candles1m[candles1m.length - 1];
  const latestTs = new Date(latest.ts).getTime();
  let sessionStartIndex: number | undefined;
  let prevSessionCloseIndex: number | undefined;
  const gapMs = sessionGapMinutes * 60_000;
  for (let i = candles1m.length - 1; i > 0; i -= 1) {
    const curTs = new Date(candles1m[i].ts).getTime();
    const prevTs = new Date(candles1m[i - 1].ts).getTime();
    if (curTs - prevTs >= gapMs) {
      sessionStartIndex = i;
      prevSessionCloseIndex = i - 1;
      break;
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
  const sessionCandles = candles1m.slice(sessionStartIndex);
  const orWindow = sessionCandles.slice(0, 30);
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
  const vwap = cumVol > 0 ? cumPv / cumVol : undefined;
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
    sessionVolume: cumVol > 0 ? cumVol : undefined,
  };
}

function inlineIndicators(
  candlesByTimeframe: Partial<Record<CandleTimeframe, Candle[]>>,
  secType: SecType,
): IndicatorSnapshot {
  const candles = candlesByTimeframe["1m"]!;
  const candles1h = candlesByTimeframe["1h"] ?? [];
  const candles5m = candlesByTimeframe["5m"] ?? [];
  const candles4h = candlesByTimeframe["4h"] ?? [];
  const candles12h = candlesByTimeframe["12h"] ?? [];
  const candles1d = candlesByTimeframe["1d"] ?? [];
  const candles1w = candlesByTimeframe["1w"] ?? [];
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
  const cmfSnapshot = lastCmf(highs, lows, closes, volumes, 20);
  const mfiSnapshot = lastMfi(highs, lows, closes, volumes, 14);
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
    cmf20: cmfSnapshot.value,
    cmf20Prev: cmfSnapshot.previous,
    mfi14: mfiSnapshot.value,
    mfi14Prev: mfiSnapshot.previous,
    bbUpper: bbSnapshot.upper,
    bbMiddle: bbSnapshot.middle,
    bbLower: bbSnapshot.lower,
    bbWidthPct: bbSnapshot.widthPct,
    dcUpper20: donchianSnapshot.upper,
    dcLower20: donchianSnapshot.lower,
    obvSlope: lastObvSlope(closes, volumes, 8),
    return5mPct: returnPct(closes, 5),
    return20mPct: returnPct(closes, 20),
    return60mPct: returnPct(closes, 60),
    trendFilterValue,
    trendFilterSource: trendFrom1h !== undefined ? "EMA50_1h" : "EMA200_1m",
    secType,
    timeframes: {
      "5m": inlineTimeframeSnapshot(candles5m),
      "1h": inlineTimeframeSnapshot(candles1h),
      "4h": inlineTimeframeSnapshot(candles4h),
      "12h": inlineTimeframeSnapshot(candles12h),
      "1d": inlineTimeframeSnapshot(candles1d),
      "1w": inlineTimeframeSnapshot(candles1w),
    },
    intraday: inlineIntradaySnapshot(candles),
  };
}

function makeSyntheticCandles(count: number, tfMs: number): Candle[] {
  const now = 1_760_000_000_000;
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(now - (count - 1 - i) * tfMs);
    const base = 100 + Math.sin(i / 5) * 3 + i * 0.02;
    out.push({
      conid: "42",
      symbol: "TEST",
      timeframe: "1m",
      ts,
      open: base,
      high: base + 0.5,
      low: base - 0.5,
      close: base + 0.1,
      volume: 1000 + (i % 50),
    } as Candle);
  }
  return out;
}

describe("computeIndicatorsForContext — §14.10 equivalence", () => {
  it("matches legacy inline computation across all IndicatorSnapshot fields", () => {
    const candlesByTimeframe: Partial<Record<CandleTimeframe, Candle[]>> = {
      "1m": makeSyntheticCandles(400, 60_000),
      "5m": makeSyntheticCandles(80, 300_000),
      "1h": makeSyntheticCandles(80, 3_600_000),
      "4h": makeSyntheticCandles(80, 14_400_000),
      "12h": makeSyntheticCandles(80, 43_200_000),
      "1d": makeSyntheticCandles(80, 86_400_000),
      "1w": makeSyntheticCandles(40, 604_800_000),
    };
    const expected = inlineIndicators(candlesByTimeframe, "STK");
    const actual = computeIndicatorsForContext({
      secType: "STK",
      candlesByTimeframe,
    });
    assert.ok(actual);
    if (!actual) return;
    assert.deepEqual(actual, expected);
  });

  it("returns null when 1m candles are missing", () => {
    const result = computeIndicatorsForContext({
      secType: "STK",
      candlesByTimeframe: {},
    });
    assert.equal(result, null);
  });
});
