import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "@ikbr/shared";
import { RangeReversalStrategy } from "./range-reversal.strategy.js";
import type { StrategyContext } from "./strategy.types.js";

function candle(
  index: number,
  close: number,
  overrides: Partial<Candle> = {},
): Candle {
  return {
    conid: "123",
    symbol: "AAPL",
    timeframe: "1m",
    ts: new Date(Date.UTC(2024, 0, 1, 9, 30 + index)),
    open: close,
    high: close + 0.3,
    low: close - 0.3,
    close,
    volume: 10000,
    ...overrides,
  };
}

function rangeCandles(length = 25): Candle[] {
  return Array.from({ length }, (_, index) =>
    candle(index, 101.5 + Math.sin(index / 2) * 1.2),
  );
}

function baseContext(
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  const candles = rangeCandles();
  const latestCandle = candle(25, 100, {
    open: 99.4,
    high: 100.4,
    low: 98.8,
    volume: 12000,
  });

  return {
    symbol: "AAPL",
    conid: "123",
    secType: "STK",
    directionalRegime: "range",
    volatilityRegime: "normal_volatility",
    latestCandle,
    indicators: {
      atr14: 0.8,
      rsi14: 28,
      rsi14Prev: 24,
      bbUpper: 103.5,
      bbMiddle: 103,
      bbLower: 99.9,
      dcUpper20: 104,
      dcLower20: 99,
      bbWidthPct: 0.04,
      cmf20: 0.02,
      mfi14: 35,
      directionalRegime: "range",
      volatilityRegime: "normal_volatility",
      timeframes: {
        "1h": {
          close: 101,
          ema20: 101,
          ema50: 101.2,
          trend: "neutral",
          rsi14: 45,
        },
        "4h": {
          close: 101.5,
          ema20: 101.4,
          ema50: 101.6,
          trend: "neutral",
          rsi14: 47,
        },
      },
    },
    candlesByTimeframe: {
      "1m": [...candles, latestCandle],
    },
    ...overrides,
  };
}

test("RangeReversalStrategy emits BUY signal near lower range edge", () => {
  const strategy = new RangeReversalStrategy();

  const signal = strategy.generateSignal(baseContext());

  assert.ok(signal);
  assert.equal(signal.strategyId, "range_reversal_v1");
  assert.equal(signal.side, "BUY");
  assert.equal(signal.direction, "LONG");
  assert.ok(signal.stopLoss !== undefined && signal.stopLoss < 100);
  assert.ok(signal.takeProfit !== undefined && signal.takeProfit > 100);
  assert.ok(signal.confidenceScore >= 0.6);
});

test("RangeReversalStrategy emits SELL signal near upper range edge", () => {
  const strategy = new RangeReversalStrategy();
  const latestCandle = candle(25, 103, {
    open: 103.6,
    high: 104.2,
    low: 102.8,
    volume: 12000,
  });

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      indicators: {
        ...baseContext().indicators,
        rsi14: 70,
        rsi14Prev: 75,
        bbUpper: 103.15,
        bbMiddle: 100,
        bbLower: 99,
        cmf20: -0.02,
        mfi14: 68,
      },
      candlesByTimeframe: {
        "1m": [...rangeCandles(), latestCandle],
      },
    }),
  );

  assert.ok(signal);
  assert.equal(signal.side, "SELL");
  assert.equal(signal.direction, "SHORT");
  assert.ok(signal.stopLoss !== undefined && signal.stopLoss > 103);
  assert.ok(signal.takeProfit !== undefined && signal.takeProfit < 103);
});

test("RangeReversalStrategy accepts high volatility range", () => {
  const strategy = new RangeReversalStrategy();

  const signal = strategy.generateSignal(
    baseContext({
      volatilityRegime: "high_volatility",
      indicators: {
        ...baseContext().indicators,
        atr14: 0.6,
        volatilityRegime: "high_volatility",
        bbMiddle: 103.5,
      },
    }),
  );

  assert.ok(signal);
});

test("RangeReversalStrategy rejects non-range directional regime", () => {
  const strategy = new RangeReversalStrategy();

  const signal = strategy.generateSignal(
    baseContext({ directionalRegime: "bull_trend" }),
  );

  assert.equal(signal, null);
  assert.equal(
    strategy.getLastRejectionReason(),
    "directional_regime_not_range",
  );
});

test("RangeReversalStrategy rejects low volatility", () => {
  const strategy = new RangeReversalStrategy();

  const signal = strategy.generateSignal(
    baseContext({ volatilityRegime: "low_volatility" }),
  );

  assert.equal(signal, null);
  assert.equal(
    strategy.getLastRejectionReason(),
    "volatility_regime_low_volatility",
  );
});

test("RangeReversalStrategy rejects middle-of-range candles", () => {
  const strategy = new RangeReversalStrategy();
  const latestCandle = candle(25, 101.6, {
    open: 101.2,
    high: 101.9,
    low: 101,
    volume: 12000,
  });

  const signal = strategy.generateSignal(
    baseContext({
      latestCandle,
      candlesByTimeframe: {
        "1m": [...rangeCandles(), latestCandle],
      },
    }),
  );

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), "no_range_reversal_setup");
});
