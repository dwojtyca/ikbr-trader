import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketRegimeDetector } from './market-regime-detector.js';

test('MarketRegimeDetector returns high_volatility when ATR threshold is exceeded', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('stock', 100, {
    atr14: 1.2,
    bbWidthPct: 0.02,
    ema50: 101,
    ema200: 100,
    macdHist: 0.2
  });

  assert.equal(regime, 'high_volatility');
});

test('MarketRegimeDetector returns trend when EMA spread and MACD magnitude confirm trend', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('stock', 100, {
    atr14: 0.6,
    bbWidthPct: 0.02,
    ema50: 101,
    ema200: 100,
    macdHist: 0.2
  });

  assert.equal(regime, 'trend');
});

test('MarketRegimeDetector returns range when volatility and trend thresholds are not met', () => {
  const detector = new MarketRegimeDetector();

  const regime = detector.detect('index', 5000, {
    atr14: 15,
    bbWidthPct: 0.015,
    ema50: 5002,
    ema200: 5000,
    macdHist: 0.1
  });

  assert.equal(regime, 'range');
});
