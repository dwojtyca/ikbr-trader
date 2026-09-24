import assert from 'node:assert/strict';
import test from 'node:test';
import type { Candle } from '@ikbr/shared';
import {
  MomentumBreakoutLongStrategy,
  evaluateMomentumBreakoutLong,
} from './momentum-breakout-long.strategy.js';
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

function consolidationCandles(length = 25): Candle[] {
  return Array.from({ length }, (_, index) => candle(index, 103 + Math.sin(index) * 0.03));
}

function baseContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  const candles = consolidationCandles();
  const latestCandle = candle(25, 105, 12500);
  return {
    symbol: 'AAPL',
    conid: '123',
    secType: 'STK',
    directionalRegime: 'bull_trend',
    volatilityRegime: 'normal_volatility',
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
      return60mPct: 1.2,
      timeframes: {
        '1h': {
          close: 104,
          ema20: 103,
          ema50: 101,
          trend: 'bullish',
          return4Pct: 1.2
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

test('MomentumBreakoutLongStrategy emits BUY signal for STK trend breakout', () => {
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

test('MomentumBreakoutLongStrategy emits BUY signal for IND trend breakout', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({
    secType: 'IND'
  }));

  assert.ok(signal);
  assert.equal(signal.side, 'BUY');
});

test('pure momentum evaluator preserves production behavior and does not enable FUT', () => {
  const context = baseContext();
  const strategy = new MomentumBreakoutLongStrategy();
  const productionSignal = strategy.generateSignal(context);
  const evaluation = evaluateMomentumBreakoutLong(context);

  assert.deepEqual(evaluation.signal, productionSignal);
  assert.equal(evaluation.rejectionReason, strategy.getLastRejectionReason());

  const futuresContext = baseContext({ secType: 'FUT', symbol: 'ES' });
  assert.equal(strategy.generateSignal(futuresContext), null);
  assert.equal(strategy.getLastRejectionReason(), 'sec_type_not_supported');
  assert.equal(evaluateMomentumBreakoutLong(futuresContext).signal, null);
  assert.ok(evaluateMomentumBreakoutLong(futuresContext, ['FUT']).signal);
});

test('MomentumBreakoutLongStrategy rejects overextended 20m move', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({
    indicators: {
      ...baseContext().indicators,
      return20mPct: 1.25
    }
  }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'overextended_20m');
});

test('MomentumBreakoutLongStrategy rejects breakout after strong pre-breakout drift', () => {
  const strategy = new MomentumBreakoutLongStrategy();
  const driftingCandles = Array.from({ length: 25 }, (_, index) => candle(index, 100 + index * 0.12));
  const latestCandle = candle(25, 105, 12500);

  const signal = strategy.generateSignal(baseContext({
    latestCandle,
    candlesByTimeframe: {
      '1m': [...driftingCandles, latestCandle]
    }
  }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'pre_breakout_drift_too_high');
});

test('MomentumBreakoutLongStrategy rejects trend continuation without 20-candle breakout', () => {
  const strategy = new MomentumBreakoutLongStrategy();
  const candles = Array.from({ length: 25 }, (_, index) => candle(index, 100 + index * 0.03));
  const latestCandle = candle(25, 100.9, 12500);
  const context = baseContext({
    latestCandle,
    indicators: {
      ...baseContext().indicators,
      ema20: 100.8,
      ema50: 100.1,
      ema200: 96,
      dcUpper20: 102,
      return5mPct: 0.08,
      return20mPct: 0.25,
      return60mPct: 0.7
    },
    candlesByTimeframe: {
      '1m': [...candles, latestCandle]
    }
  });

  const signal = strategy.generateSignal(context);

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'no_confirmed_breakout');
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

test('MomentumBreakoutLongStrategy rejects non-bull-trend directional regime', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({ directionalRegime: 'range' }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'directional_regime_not_bull_trend');
});

test('MomentumBreakoutLongStrategy rejects signals outside UTC strategy session', () => {
  const strategy = new MomentumBreakoutLongStrategy();
  const latestCandle = candle(25, 105, 12500);

  const signal = strategy.generateSignal(baseContext({
    latestCandle: {
      ...latestCandle,
      ts: new Date(Date.UTC(2024, 0, 1, 21, 30))
    },
    candlesByTimeframe: {
      '1m': [
        ...consolidationCandles(),
        {
          ...latestCandle,
          ts: new Date(Date.UTC(2024, 0, 1, 21, 30))
        }
      ]
    }
  }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'outside_strategy_session');
});

test('MomentumBreakoutLongStrategy accepts neutral 1h inside bull trend regime', () => {
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

  assert.ok(signal);
});

test('MomentumBreakoutLongStrategy rejects bearish 1h alignment', () => {
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
          trend: 'bearish'
        }
      }
    }
  });

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'higher_timeframe_1h_bearish');
});

test('MomentumBreakoutLongStrategy rejects unconfirmed volume', () => {
  const strategy = new MomentumBreakoutLongStrategy();

  const signal = strategy.generateSignal(baseContext({
    latestCandle: candle(25, 105, 9000),
    candlesByTimeframe: {
      '1m': [
        ...consolidationCandles(),
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
        ...consolidationCandles(),
        weakCandle
      ]
    }
  }));

  assert.equal(signal, null);
  assert.equal(strategy.getLastRejectionReason(), 'breakout_close_not_near_high');
});

test('GPW3 real momentum strategy WSE levels survive normalization builder and mapper', async () => {
  const { defaultInstrumentRegistry, normalizeWseStrategyLevels, ExecutionTicketBuilder } = await import('@ikbr/shared');
  const { toLegacySignalTicket } = await import('../runtime/execution/ticket-mapper.js');
  const now = new Date('2026-09-24T10:00:00Z');
  const source = baseContext();
  const candles = source.candlesByTimeframe['1m']!.map((c, i, all) => ({ ...c, symbol: 'PKO', conid: '35146360', ts: new Date(now.getTime() - (all.length - i) * 60000) }));
  const context: StrategyContext = { ...source, symbol: 'PKO', conid: '35146360', latestCandle: candles.at(-1)!, candlesByTimeframe: { '1m': candles } };
  const emitted = new MomentumBreakoutLongStrategy().generateSignal(context);
  assert.ok(emitted);
  const seed = defaultInstrumentRegistry.getInstrumentOrThrow('pko_wse');
  const instrument = { ...seed, trading: { ...seed.trading, executionEnabled: true } };
  const bound: import('@ikbr/shared').BoundInstrument = { instrument, instrumentId: instrument.id, broker: 'ibkr', brokerSymbol: 'PKO', conId: 35146360,
    localSymbol: 'PKO', tradingClass: 'PKO', exchange: 'WSE', currency: 'PLN', minTick: .0001 };
  const raw = { entry: emitted.suggestedEntry!, stopLoss: emitted.stopLoss!, takeProfit: emitted.takeProfit! };
  const evidence = normalizeWseStrategyLevels({ accountId: 'DU-TEST', instrumentId: 'pko_wse', conId: 35146360, symbol: 'PKO', localSymbol: 'PKO', tradingClass: 'PKO',
    exchange: 'WSE', currency: 'PLN', secType: 'STK', marketRuleId: 1, priceIncrements: [{ lowEdge: 0, increment: .01 }, { lowEdge: 100, increment: .05 }],
    timeZoneId: 'Europe/Warsaw', liquidHours: '20260924:0900-20260924:1705', requestStartedAtMs: now.getTime() - 100, receivedAtMs: now.getTime() - 50 }, bound, 'DU-TEST', raw, now.getTime());
  const signal: import('@ikbr/shared').SignalEvaluation = {
    signalId: 's', instrumentId: instrument.id, generatedAt: now, status: 'GENERATED', reasonSummary: 'fixture deterministic decision/risk approval', warnings: [], blockers: [],
    decision: { decisionId: 'd', instrumentId: instrument.id, generatedAt: now, action: 'LONG', confidence: 90, overallScore: 50, reasons: [], warnings: [], blockedBy: [], metadata: { engineVersion: 'fixture', evaluationTimeMs: 0 } },
    risk: { approved: true, riskScore: 1, warnings: [], blockers: [], metadata: { engineVersion: 'fixture', evaluationTimeMs: 0 } },
    metadata: { engineVersions: { signal: 'fixture', decision: 'fixture', risk: 'fixture' }, evaluationTimeMs: 0 },
  };
  const snapshot = { instrumentId: instrument.id, sections: { price: { status: 'fresh', observedAt: now, source: 'fixture', warnings: [], data: { last: 120, bid: 119, ask: 121 } } } } as unknown as import('@ikbr/shared').MarketContextSnapshot;
  const built = new ExecutionTicketBuilder({ idFactory: () => 't', correlationIdFactory: () => 'c', now: () => now }).build({ signal, snapshot, instrument,
    policy: { quantity: 1, orderType: 'LMT', timeInForce: 'DAY', outsideRth: false, transmit: true, priceTickSize: .0001, priceRoundingMode: 'nearest', stopLossDistance: 999, takeProfitDistance: 999, strategyPrices: evidence.final } });
  assert.ok(built.ok);
  const wire = toLegacySignalTicket(built.ticket, { bound });
  assert.deepEqual({ entry: wire.entry, stopLoss: wire.stop, takeProfit: wire.takeProfit }, evidence.final);
  assert.deepEqual(evidence.raw, raw);
  assert.equal(wire.entry, emitted.suggestedEntry);
  assert.notEqual(wire.entry, 121);
  assert.equal(context.indicators.timeframes?.['12h'], undefined);
  assert.equal(new MomentumBreakoutLongStrategy().generateSignal({ ...context, directionalRegime: 'range' }), null);
});
