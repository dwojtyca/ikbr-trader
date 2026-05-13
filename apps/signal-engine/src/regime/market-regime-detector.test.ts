import assert from 'node:assert/strict';
import test from 'node:test';
import type { IndicatorSnapshot, TimeframeIndicatorSnapshot } from '@ikbr/shared';
import { MarketRegimeDetector } from './market-regime-detector.js';

function tf(trend: TimeframeIndicatorSnapshot['trend'], close: number, return20Pct: number): TimeframeIndicatorSnapshot {
  const ema20 = trend === 'bearish' ? close + 1 : trend === 'bullish' ? close - 1 : close;
  const ema50 = trend === 'bearish' ? close + 2 : trend === 'bullish' ? close - 2 : close;
  const ema200 = trend === 'bearish' ? close + 4 : trend === 'bullish' ? close - 4 : close;
  return {
    close,
    ema20,
    ema50,
    ema200,
    macdHist: trend === 'bearish' ? -0.4 : trend === 'bullish' ? 0.4 : 0,
    bbWidthPct: 0.02,
    trend,
    return20Pct
  };
}

function baseIndicators(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    ema20: 103,
    ema50: 101,
    ema200: 95,
    atr14: 0.7,
    bbWidthPct: 0.025,
    macdHist: 0.35,
    return60mPct: 1.2,
    timeframes: {
      '1h': tf('bullish', 104, 2),
      '4h': tf('bullish', 106, 4),
      '1d': tf('bullish', 110, 8),
      '1w': tf('neutral', 112, 3)
    },
    ...overrides
  };
}

test('MarketRegimeDetector returns bull_trend when higher timeframes confirm upside direction', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('STK', 104, baseIndicators());

  assert.equal(regime, 'bull_trend');
});

test('MarketRegimeDetector returns bear_trend when higher timeframes confirm downside direction', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('STK', 96, baseIndicators({
    ema20: 97,
    ema50: 99,
    ema200: 104,
    macdHist: -0.35,
    return60mPct: -1.1,
    timeframes: {
      '1h': tf('bearish', 96, -2),
      '4h': tf('bearish', 94, -4),
      '1d': tf('bearish', 90, -8),
      '1w': tf('neutral', 88, -3)
    }
  }));

  assert.equal(regime, 'bear_trend');
});

test('MarketRegimeDetector returns high_volatility when volatility is elevated without directional consensus', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('STK', 100, baseIndicators({
    ema20: 100.2,
    ema50: 100,
    ema200: 99.8,
    atr14: 1.6,
    bbWidthPct: 0.03,
    macdHist: 0.02,
    return60mPct: 0.1,
    timeframes: {
      '1h': tf('neutral', 100, 0.2),
      '4h': tf('bearish', 99, -0.5),
      '1d': tf('bullish', 101, 0.5)
    }
  }));

  assert.equal(regime, 'high_volatility');
});

test('MarketRegimeDetector returns low_volatility when price is compressed without trend consensus', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('STK', 100, baseIndicators({
    ema20: 100.1,
    ema50: 100,
    ema200: 99.9,
    atr14: 0.15,
    bbWidthPct: 0.008,
    macdHist: 0.01,
    return60mPct: 0.05,
    timeframes: {
      '1h': tf('neutral', 100, 0.1),
      '4h': tf('neutral', 100.1, 0.1),
      '1d': tf('neutral', 99.9, -0.1)
    }
  }));

  assert.equal(regime, 'low_volatility');
});

test('MarketRegimeDetector returns range when neither trend nor volatility conditions dominate', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('IND', 5000, {
    ema20: 5003,
    ema50: 5002,
    ema200: 5000,
    atr14: 15,
    bbWidthPct: 0.015,
    macdHist: 0.1,
    return60mPct: 0.05,
    timeframes: {
      '1h': tf('neutral', 5000, 0.1),
      '4h': tf('neutral', 5001, 0.2),
      '1d': tf('neutral', 4998, -0.1)
    }
  });

  assert.equal(regime, 'range');
});
