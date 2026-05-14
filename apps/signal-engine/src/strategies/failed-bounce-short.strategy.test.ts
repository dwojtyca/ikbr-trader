import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "@ikbr/shared";
import { FailedBounceShortStrategy } from "./failed-bounce-short.strategy.js";
import type { StrategyContext } from "./strategy.types.js";

function candle(index: number, close: number, volume = 10000): Candle {
  return {
    conid: "123",
    symbol: "AAPL",
    timeframe: "1m",
    ts: new Date(Date.UTC(2024, 0, 1, 9, 30 + index)),
    open: close + 0.2,
    high: close + 0.35,
    low: close - 0.25,
    close,
    volume,
  };
}

function pullbackCandles(length = 25): Candle[] {
  return Array.from({ length }, (_, index) =>
    candle(index, 101.1 + Math.sin(index) * 0.05),
  );
}

function rejectionCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    ...candle(25, 101, 12500),
    open: 101.8,
    high: 102.3,
    low: 100.7,
    close: 101,
    ...overrides,
  };
}

function setupCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    ...candle(24, 101.7, 11800),
    open: 101.5,
    high: 102.25,
    low: 101.2,
    close: 101.45,
    ...overrides,
  };
}

function baseContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const latestCandle = rejectionCandle();
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
      sma200: 112,
      rsi14: 42,
      rsi14Prev: 45,
      atr14: 1.2,
      macdHist: -0.18,
      macdHistPrev: -0.1,
      macdHistPrev2: -0.03,
      cmf20: -0.06,
      cmf20Prev: -0.03,
      mfi14: 44,
      mfi14Prev: 50,
      bbMiddle: 102,
      bbUpper: 103,
      bbWidthPct: 0.03,
      obvSlope: -0.04,
      return20mPct: -0.3,
      return60mPct: 0.4,
      timeframes: {
        "1h": {
          close: 101.5,
          ema20: 102,
          ema50: 104,
          trend: "bearish",
          return4Pct: 0.2,
        },
        "4h": {
          close: 102,
          ema20: 103,
          ema50: 105,
          rsi14: 40,
          trend: "bearish",
          return18Pct: -2,
        },
        "1d": {
          close: 103,
          ema20: 104,
          ema50: 106,
          sma200: 112,
          adx14: 28,
          ema50Slope10Pct: -1.2,
          trend: "bearish",
          return20Pct: -10,
        },
      },
    },
    candlesByTimeframe: {
      "1m": [...pullbackCandles(24), setupCandle(), latestCandle],
      "1h": [
        candle(0, 108),
        candle(1, 106),
        candle(2, 103.5),
        candle(3, 104.5),
        candle(4, 102.5),
        candle(5, 101.5),
      ],
    },
    ...overrides,
  };
}

test("FailedBounceShortStrategy emits SELL signal after failed EMA retest", () => {
  const strategy = new FailedBounceShortStrategy();

  const signal = strategy.generateSignal(baseContext());

  assert.ok(signal);
  assert.equal(signal.strategyId, "failed_bounce_short_v1");
  assert.equal(signal.side, "SELL");
  assert.equal(signal.direction, "SHORT");
  assert.equal(signal.symbol, "AAPL");
  assert.equal(signal.entryOrderType, "STP");
  assert.ok(signal.confidenceScore >= 0.58);
  assert.ok(signal.suggestedEntry !== undefined && signal.suggestedEntry < 100.7);
  assert.ok(signal.stopLoss !== undefined && signal.stopLoss > signal.suggestedEntry);
  assert.ok(signal.takeProfit !== undefined && signal.takeProfit < signal.suggestedEntry);
});

test("FailedBounceShortStrategy emits SELL signal for IND failed bounce", () => {
  const strategy = new FailedBounceShortStrategy();

  const signal = strategy.generateSignal(baseContext({ secType: "IND" }));

  assert.ok(signal);
  assert.equal(signal.side, "SELL");
});

test("FailedBounceShortStrategy rejects non-bear-trend regime", () => {
  const strategy = new FailedBounceShortStrategy();

  const signal = strategy.generateSignal(baseContext({ regime: "range" }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "regime_not_bear_trend");
});

test("FailedBounceShortStrategy rejects bounce without resistance retest", () => {
  const strategy = new FailedBounceShortStrategy();
  const latestCandle = rejectionCandle({ high: 101.4 });

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      candlesByTimeframe: {
        "1m": [...pullbackCandles(24), setupCandle({ high: 101.4 }), latestCandle],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "no_resistance_retest");
});

test("FailedBounceShortStrategy rejects close too far below EMA20", () => {
  const strategy = new FailedBounceShortStrategy();
  const latestCandle = rejectionCandle({ close: 100, high: 102.3 });

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      candlesByTimeframe: {
        "1m": [
          ...pullbackCandles(24),
          setupCandle({ low: 101.6 }),
          latestCandle,
        ],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "too_far_below_ema20");
});

test("FailedBounceShortStrategy rejects bullish rejection candle", () => {
  const strategy = new FailedBounceShortStrategy();
  const latestCandle = rejectionCandle({ open: 100.9, close: 101.4 });

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      candlesByTimeframe: {
        "1m": [
          ...pullbackCandles(24),
          setupCandle({ low: 101.6 }),
          latestCandle,
        ],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "rejection_candle_not_bearish");
});

test("FailedBounceShortStrategy rejects low daily ADX", () => {
  const strategy = new FailedBounceShortStrategy();
  const context = baseContext();

  const signal = strategy.generateSignal({
    ...context,
    indicators: {
      ...context.indicators,
      timeframes: {
        ...context.indicators.timeframes,
        "1d": {
          ...context.indicators.timeframes?.["1d"],
          adx14: 18,
        },
      },
    },
  });

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "daily_adx_too_low");
});

test("FailedBounceShortStrategy rejects trigger candle that does not close below setup low", () => {
  const strategy = new FailedBounceShortStrategy();
  const latestCandle = rejectionCandle({ close: 101.35 });

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      candlesByTimeframe: {
        "1m": [...pullbackCandles(24), setupCandle(), latestCandle],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "trigger_close_not_below_setup_low");
});

test("FailedBounceShortStrategy rejects strong 4h RSI", () => {
  const strategy = new FailedBounceShortStrategy();
  const context = baseContext();

  const signal = strategy.generateSignal({
    ...context,
    indicators: {
      ...context.indicators,
      timeframes: {
        ...context.indicators.timeframes,
        "4h": {
          ...context.indicators.timeframes?.["4h"],
          rsi14: 52,
        },
      },
    },
  });

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "h4_rsi_too_high");
});
