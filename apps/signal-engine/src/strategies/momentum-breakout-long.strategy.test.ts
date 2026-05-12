import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '@ikbr/shared';
import { MomentumBreakoutLongStrategy } from './momentum-breakout-long.strategy.js';
import type { StrategyContext } from './strategy.types.js';

function candle(index: number, close: number, volume = 10000): Candle {
  return {
    conid: '123',
    symbol: 'AAPL',
    timeframe: '1m',
    ts: new Date(Date.UTC(2024, 0, 1, 9, 30 + index)),
    open: close - 0.7,
    high: close + 0.2,
    low: close - 1.0,
    close,
    volume
  };
}

function baseContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const candles = Array.from({ length: 25 }, (_, index) => candle(index, 100 + index * 0.1));
  const latestCandle = candle(25, 105, 12500);
  return {
    symbol: 'AAPL',
    conid: '123',
    assetClass: 'stock',
    regime: 'bull_trend',
    latestCandle,
    indicators: {
      ema20: 103,
      ema50: 101,
      ema200: 95,
      rsi14: 64,
      atr14: 1.2,
      dcUpper20: 105,
      bbWidthPct: 0.025,
      return20mPct: 0.9,
      return60mPct: 1.7,
      timeframes: {
        '1h': {
          close: 104,
          ema20: 103,
          ema50: 101,
          trend: 'bullish',
          return4Pct: 0.8
        },
        '4h': {
          close: 103,
          ema20: 102,
          ema50: 100,
          trend: 'bullish',
          return18Pct: 2
        },
        '1d': {
          close: 102,
          ema20: 101,
          ema50: 99,
          trend: 'bullish',
          return20Pct: 14
        }
      }
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
  assert.equal(strategy.getLastRejectionReason(), 'rsi_overheated');
});

test('MomentumBreakoutLongStrategy rejects non-bull-trend regime', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({ regime: 'range' }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'regime_not_bull_trend');
});

test('MomentumBreakoutLongStrategy rejects weak higher timeframe alignment', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const context = baseContext();
  const signal = strategy.generateSignal({
    ...context,
    indicators: {
      ...context.indicators,
      timeframes: {
        ...context.indicators.timeframes,
        '1h': {
          ...context.indicators.timeframes?.['1h'],
          trend: 'neutral'
        }
      }
    }
  });

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'higher_timeframe_1h_not_bullish');
});

test('MomentumBreakoutLongStrategy rejects unconfirmed volume', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({
    latestCandle: candle(25, 105, 9000),
    candlesByTimeframe: {
      '1m': [
        ...Array.from({ length: 25 }, (_, index) => candle(index, 100 + index * 0.1)),
        candle(25, 105, 9000)
      ]
    }
  }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'volume_not_confirmed');
});

test('MomentumBreakoutLongStrategy rejects weak breakout candle quality', () => {
  const strategy = new MomentumBreakoutLongStrategy();
  const weakCandle: Candle = {
    ...candle(25, 105, 12500),
    open: 104.95,
    high: 105.6,
    low: 104.2,
    close: 105
  };

  const signal = strategy.generateSignal(baseContext({
    latestCandle: weakCandle,
    candlesByTimeframe: {
      '1m': [
        ...Array.from({ length: 25 }, (_, index) => candle(index, 100 + index * 0.1)),
        weakCandle
      ]
    }
  }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'breakout_close_not_near_high');
});
