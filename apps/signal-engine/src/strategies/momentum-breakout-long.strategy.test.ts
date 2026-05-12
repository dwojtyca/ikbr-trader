import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '@ikbr/shared';
import { MomentumBreakoutLongStrategy } from './momentum-breakout-long.strategy.js';
import type { StrategyContext } from './strategy.types.js';

function candle(index: number, close: number): Candle {
  return {
    conid: '123',
    symbol: 'AAPL',
    timeframe: '1m',
    ts: new Date(Date.UTC(2024, 0, 1, 9, 30 + index)),
    open: close - 0.2,
    high: close + 0.5,
    low: close - 0.8,
    close,
    volume: 10000
  };
}

function baseContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const candles = Array.from({ length: 25 }, (_, index) => candle(index, 100 + index * 0.1));
  const latestCandle = candle(25, 105);
  return {
    symbol: 'AAPL',
    conid: '123',
    assetClass: 'stock',
    regime: 'trend',
    latestCandle,
    indicators: {
      ema20: 103,
      ema50: 101,
      ema200: 95,
      rsi14: 64,
      atr14: 1.2,
      dcUpper20: 105,
      bbWidthPct: 0.025
    },
    candlesByTimeframe: {
      '1m': [...candles, latestCandle]
    },
    ...overrides
  };
}

test('MomentumBreakoutLongStrategy emits BUY signal for stock trend breakout', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext());

  assert.ok(signal);
  assert.equal(signal.strategyId, 'momentum_breakout_long_v1');
  assert.equal(signal.side, 'BUY');
  assert.equal(signal.direction, 'LONG');
  assert.equal(signal.symbol, 'AAPL');
  assert.ok(signal.confidenceScore >= 0.58);
  assert.ok(signal.stopLoss !== undefined && signal.stopLoss < 105);
  assert.ok(signal.takeProfit !== undefined && signal.takeProfit > 105);
});

test('MomentumBreakoutLongStrategy rejects overbought RSI', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({
    indicators: {
      ...baseContext().indicators,
      rsi14: 74
    }
  }));

  assert.equal(signal, null);
});

test('MomentumBreakoutLongStrategy rejects non-trend regime', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({ regime: 'range' }));

  assert.equal(signal, null);
});
