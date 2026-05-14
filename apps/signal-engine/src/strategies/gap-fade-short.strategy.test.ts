import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "@ikbr/shared";
import { GapFadeShortStrategy } from "./gap-fade-short.strategy.js";
import type { StrategyContext } from "./strategy.types.js";

function candle(
  index: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume = 10000,
): Candle {
  return {
    conid: "123",
    symbol: "AAPL",
    timeframe: "1m",
    // Session at 14:30 UTC + index minutes.
    ts: new Date(Date.UTC(2024, 0, 2, 14, 30 + index)),
    open,
    high,
    low,
    close,
    volume,
  };
}

/**
 * Builds a 1m candle history that simulates:
 *   - 30 "previous session" candles ending at prevSessionClose=100 (yesterday 20:30 UTC)
 *   - overnight gap of 18+ hours
 *   - 30 "current session" candles starting at sessionOpen=102 (today 14:30 UTC)
 *   - latest candle at index 30 of session: bearish, near low, high volume
 */
function buildCandles(
  opts: {
    prevClose?: number;
    sessionOpen?: number;
    latestOpen?: number;
    latestClose?: number;
    latestHigh?: number;
    latestLow?: number;
    latestVolume?: number;
    sessionMinutes?: number;
  } = {},
): { candles: Candle[]; latest: Candle } {
  const prevClose = opts.prevClose ?? 100;
  const sessionOpen = opts.sessionOpen ?? 102; // 2% gap up
  const sessionMinutes = opts.sessionMinutes ?? 30;

  const yesterday: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    conid: "123",
    symbol: "AAPL",
    timeframe: "1m" as const,
    ts: new Date(Date.UTC(2024, 0, 1, 20, i)),
    open: prevClose - 0.05,
    high: prevClose + 0.1,
    low: prevClose - 0.15,
    close: prevClose,
    volume: 8000,
  }));

  // Today: drift slightly up then a final bearish candle.
  const todayCount = sessionMinutes - 1;
  const today: Candle[] = Array.from({ length: todayCount }, (_, i) => {
    const c = sessionOpen + Math.min(i, 5) * 0.05;
    return {
      conid: "123",
      symbol: "AAPL",
      timeframe: "1m" as const,
      ts: new Date(Date.UTC(2024, 0, 2, 14, 30 + i)),
      open: c - 0.02,
      high: c + 0.1,
      low: c - 0.05,
      close: c,
      volume: 9000,
    };
  });

  const latest: Candle = {
    conid: "123",
    symbol: "AAPL",
    timeframe: "1m",
    ts: new Date(Date.UTC(2024, 0, 2, 14, 30 + todayCount)),
    open: opts.latestOpen ?? 102.4,
    high: opts.latestHigh ?? 102.5,
    low: opts.latestLow ?? 101.8,
    close: opts.latestClose ?? 101.85,
    volume: opts.latestVolume ?? 16000,
  };

  return { candles: [...yesterday, ...today, latest], latest };
}

function baseContext(
  overrides: Partial<StrategyContext> = {},
  candleOverrides: Parameters<typeof buildCandles>[0] = {},
): StrategyContext {
  const { candles, latest } = buildCandles(candleOverrides);
  // Hand-computed intraday values matching default buildCandles output:
  const sessionOpen = candleOverrides.sessionOpen ?? 102;
  const prevSessionClose = candleOverrides.prevClose ?? 100;
  const gapPct = ((sessionOpen - prevSessionClose) / prevSessionClose) * 100;
  // VWAP slightly below latest close so distance is positive (~34 bps).
  // This represents the early-session pattern where price gapped up, drifted
  // a bit higher building VWAP, then started rolling back.
  const vwap = 101.5;
  const distanceFromVwapBps = ((latest.close - vwap) / vwap) * 10000;

  return {
    symbol: "AAPL",
    conid: "123",
    secType: "STK",
    directionalRegime: "bull_trend",
    volatilityRegime: "normal_volatility",
    latestCandle: latest,
    indicators: {
      rsi14: 65,
      atr14: 0.4,
      intraday: {
        prevSessionClose,
        sessionOpen,
        sessionOpenTs: new Date(Date.UTC(2024, 0, 2, 14, 30)),
        minutesSinceSessionOpen: candleOverrides.sessionMinutes
          ? candleOverrides.sessionMinutes - 1
          : 29,
        gapPct,
        openingRange30High: sessionOpen + 0.3,
        openingRange30Low: sessionOpen - 0.1,
        vwap,
        distanceFromVwapBps,
        sessionVolume: 270000,
      },
    },
    candlesByTimeframe: {
      "1m": candles,
    },
    ...overrides,
  };
}

test("GapFadeShortStrategy emits SELL signal on a clean gap-up failure", () => {
  const strategy = new GapFadeShortStrategy();
  const signal = strategy.generateSignal(baseContext());

  assert.ok(
    signal,
    `expected signal, got reject=${strategy.getLastRejectionReason()}`,
  );
  assert.equal(signal.strategyId, "gap_fade_short_v1");
  assert.equal(signal.side, "SELL");
  assert.equal(signal.direction, "SHORT");
  assert.ok(signal.stopLoss !== undefined && signal.stopLoss > 101.85);
  assert.ok(signal.takeProfit !== undefined && signal.takeProfit < 101.85);
  assert.ok(signal.confidenceScore >= 0.6);
});

test("GapFadeShortStrategy rejects when gap is too small", () => {
  const strategy = new GapFadeShortStrategy();
  // 0.5% gap (below 1% minimum)
  const context = baseContext({}, { prevClose: 100, sessionOpen: 100.5 });
  // adjust latest to stay above prevClose
  context.latestCandle = {
    ...context.latestCandle,
    open: 100.4,
    close: 100.35,
    high: 100.5,
    low: 100.3,
  };
  const signal = strategy.generateSignal(context);
  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "gap_too_small");
});

test("GapFadeShortStrategy rejects when gap is too large (news risk)", () => {
  const strategy = new GapFadeShortStrategy();
  const context = baseContext({}, { prevClose: 100, sessionOpen: 108 });
  const signal = strategy.generateSignal(context);
  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "gap_too_large_news_risk");
});

test("GapFadeShortStrategy rejects when fade window expired (>90 min)", () => {
  const strategy = new GapFadeShortStrategy();
  const context = baseContext();
  context.indicators = {
    ...context.indicators,
    intraday: { ...context.indicators.intraday!, minutesSinceSessionOpen: 120 },
  };
  const signal = strategy.generateSignal(context);
  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "fade_window_expired");
});

test("GapFadeShortStrategy rejects when gap is already filled", () => {
  const strategy = new GapFadeShortStrategy();
  const context = baseContext();
  // Push latest close below prevSessionClose=100
  context.latestCandle = {
    ...context.latestCandle,
    close: 99.5,
    low: 99.3,
  };
  const signal = strategy.generateSignal(context);
  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "gap_already_filled");
});

test("GapFadeShortStrategy rejects when intraday metadata missing", () => {
  const strategy = new GapFadeShortStrategy();
  const context = baseContext();
  context.indicators = { ...context.indicators, intraday: undefined };
  const signal = strategy.generateSignal(context);
  assert.equal(signal, null);
  assert.equal(
    strategy.getLastRejectionReason(),
    "intraday_metadata_unavailable",
  );
});

test("GapFadeShortStrategy rejects RSI blow-off", () => {
  const strategy = new GapFadeShortStrategy();
  const context = baseContext();
  context.indicators = { ...context.indicators, rsi14: 82 };
  const signal = strategy.generateSignal(context);
  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "rsi_blowoff_avoid");
});

test("GapFadeShortStrategy rejects bullish trigger candle", () => {
  const strategy = new GapFadeShortStrategy();
  const context = baseContext();
  context.latestCandle = {
    ...context.latestCandle,
    open: 101.85,
    close: 102.4, // bullish
    high: 102.5,
    low: 101.8,
  };
  const signal = strategy.generateSignal(context);
  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "trigger_candle_not_bearish");
});
