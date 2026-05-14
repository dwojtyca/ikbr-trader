import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "@ikbr/shared";
import { MomentumBreakdownShortStrategy } from "./momentum-breakdown-short.strategy.js";
import type { StrategyContext } from "./strategy.types.js";

function candle(index: number, close: number, volume = 10000): Candle {
  return {
    conid: "123",
    symbol: "AAPL",
    timeframe: "1m",
    ts: new Date(Date.UTC(2024, 0, 1, 9, 30 + index)),
    open: close + 0.7,
    high: close + 1.0,
    low: close - 0.2,
    close,
    volume,
  };
}

function consolidationCandles(length = 25): Candle[] {
  return Array.from({ length }, (_, index) =>
    candle(index, 103 + Math.sin(index) * 0.03),
  );
}

function baseContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const candles = consolidationCandles();
  const latestCandle = candle(25, 101, 12500);
  return {
    symbol: "AAPL",
    conid: "123",
    secType: "STK",
    regime: "bear_trend",
    latestCandle,
    indicators: {
      ema20: 102,
      ema50: 104,
      ema200: 110,
      rsi14: 36,
      atr14: 1.2,
      dcLower20: 101,
      bbWidthPct: 0.025,
      return20mPct: -0.9,
      return60mPct: -1.2,
      timeframes: {
        "1h": {
          close: 101,
          ema20: 102,
          ema50: 104,
          trend: "bearish",
          return4Pct: -1.2,
        },
        "4h": {
          close: 102,
          ema20: 103,
          ema50: 105,
          rsi14: 36,
          trend: "bearish",
          return18Pct: -2,
        },
        "1d": {
          close: 103,
          ema20: 104,
          ema50: 106,
          trend: "bearish",
          return20Pct: -14,
        },
      },
    },
    candlesByTimeframe: {
      "1m": [...candles, latestCandle],
    },
    ...overrides,
  };
}

test("MomentumBreakdownShortStrategy emits SELL signal for STK bear breakdown", () => {
  const strategy = new MomentumBreakdownShortStrategy();

  const signal = strategy.generateSignal(baseContext());

  assert.ok(signal);
  assert.equal(signal.strategyId, "momentum_breakdown_short_v1");
  assert.equal(signal.side, "SELL");
  assert.equal(signal.direction, "SHORT");
  assert.equal(signal.symbol, "AAPL");
  assert.ok(signal.confidenceScore >= 0.58);
  assert.ok(signal.stopLoss !== undefined && signal.stopLoss > 101);
  assert.ok(signal.takeProfit !== undefined && signal.takeProfit < 101);
});

test("MomentumBreakdownShortStrategy emits SELL signal for IND bear breakdown", () => {
  const strategy = new MomentumBreakdownShortStrategy();

  const signal = strategy.generateSignal(baseContext({ secType: "IND" }));

  assert.ok(signal);
  assert.equal(signal.side, "SELL");
  assert.equal(signal.direction, "SHORT");
});

test("MomentumBreakdownShortStrategy rejects non-bear-trend regime", () => {
  const strategy = new MomentumBreakdownShortStrategy();

  const signal = strategy.generateSignal(baseContext({ regime: "range" }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "regime_not_bear_trend");
});

test("MomentumBreakdownShortStrategy rejects signals outside UTC strategy session", () => {
  const strategy = new MomentumBreakdownShortStrategy();
  const latestCandle = candle(25, 101, 12500);

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle: {
        ...latestCandle,
        ts: new Date(Date.UTC(2024, 0, 1, 20, 30)),
      },
      candlesByTimeframe: {
        "1m": [
          ...consolidationCandles(),
          {
            ...latestCandle,
            ts: new Date(Date.UTC(2024, 0, 1, 20, 30)),
          },
        ],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "outside_strategy_session");
});

test("MomentumBreakdownShortStrategy rejects weak 4h downside momentum", () => {
  const strategy = new MomentumBreakdownShortStrategy();
  const context = baseContext();

  const signal = strategy.generateSignal({
    ...context,
    indicators: {
      ...context.indicators,
      timeframes: {
        ...context.indicators.timeframes,
        "4h": {
          ...context.indicators.timeframes?.["4h"],
          rsi14: 42,
        },
      },
    },
  });

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "h4_rsi_too_high");
});

test("MomentumBreakdownShortStrategy rejects entries too far below EMA20", () => {
  const strategy = new MomentumBreakdownShortStrategy();

  const signal = strategy.generateSignal(
    baseContext({
      indicators: {
        ...baseContext().indicators,
        ema20: 103,
        ema50: 104,
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "too_far_below_ema20");
});

test("MomentumBreakdownShortStrategy rejects entries too far below EMA50", () => {
  const strategy = new MomentumBreakdownShortStrategy();

  const signal = strategy.generateSignal(
    baseContext({
      indicators: {
        ...baseContext().indicators,
        ema20: 102,
        ema50: 107,
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "too_far_below_ema50");
});

test("MomentumBreakdownShortStrategy rejects breakdown without 20-candle low break", () => {
  const strategy = new MomentumBreakdownShortStrategy();
  const latestCandle = candle(25, 102.9, 12500);

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      candlesByTimeframe: {
        "1m": [...consolidationCandles(), latestCandle],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "no_confirmed_breakdown");
});

test("MomentumBreakdownShortStrategy rejects oversold RSI", () => {
  const strategy = new MomentumBreakdownShortStrategy();

  const signal = strategy.generateSignal(
    baseContext({
      indicators: {
        ...baseContext().indicators,
        rsi14: 24,
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "rsi_oversold");
});

test("MomentumBreakdownShortStrategy rejects overextended 20m selloff", () => {
  const strategy = new MomentumBreakdownShortStrategy();

  const signal = strategy.generateSignal(
    baseContext({
      indicators: {
        ...baseContext().indicators,
        return20mPct: -1.25,
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "overextended_20m");
});

test("MomentumBreakdownShortStrategy rejects breakdown after strong pre-breakdown drift", () => {
  const strategy = new MomentumBreakdownShortStrategy();
  const driftingCandles = Array.from({ length: 25 }, (_, index) =>
    candle(index, 104 - index * 0.12),
  );
  const latestCandle = candle(25, 100.5, 12500);

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      candlesByTimeframe: {
        "1m": [...driftingCandles, latestCandle],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "pre_breakdown_drift_too_low");
});
