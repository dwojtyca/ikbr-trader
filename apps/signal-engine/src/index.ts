import Fastify from 'fastify';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { ProposedOrder } from '@ikbr/shared';
import { config } from './config.js';
import { SignalRepository } from './repository.js';
import { SignalEngine } from './signal-engine.js';
import { listStrategyProfiles } from './strategy-profiles.js';

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const pool = new Pool({ connectionString: config.POSTGRES_URL });
const redis = new Redis(config.REDIS_URL);
const repo = new SignalRepository(pool, redis);
const strategyToggleSchema = z.object({ enabled: z.boolean() });
const engine = new SignalEngine(repo, {
  minCandles: config.SIGNAL_MIN_CANDLES,
  maxSpreadBps: config.MAX_SPREAD_BPS,
  minVolume1m: config.MIN_CANDLE_VOLUME_1M,
  volumeFilterMode: config.volumeFilterMode,
  atrStopMult: config.ATR_STOP_MULT,
  atrTpMult: config.ATR_TP_MULT,
  minConfidence: config.SIGNAL_MIN_CONFIDENCE,
  lmtEntryMode: config.SIGNAL_LMT_ENTRY_MODE,
  lmtEntryBufferBps: config.SIGNAL_LMT_ENTRY_BUFFER_BPS,
  fractionalSymbols: config.fractionalSymbols,
  fractionalQuantityStep: config.SIGNAL_FRACTIONAL_QUANTITY_STEP,
  minStopBpsByAssetClass: {
    stock: config.SIGNAL_MIN_STOP_BPS_STOCK,
    index: config.SIGNAL_MIN_STOP_BPS_INDEX,
    commodity: config.SIGNAL_MIN_STOP_BPS_COMMODITY
  },
  maxMarketStateAgeMs: config.SIGNAL_MAX_MARKET_STATE_AGE_MS,
  baseCurrency: config.baseCurrency,
  assetClassBySymbol: config.assetClassOverrides,
  currencyBySymbol: config.currencyBySymbol,
  priceMultiplierBySymbol: config.priceMultiplierOverrides,
  executionBaseUrl: config.EXECUTION_BASE_URL,
  strategyCooldownMs: config.SIGNAL_STRATEGY_COOLDOWN_MS,
  symbolAddLossLimit: config.SIGNAL_SYMBOL_ADD_LOSS_LIMIT,
  riskLimits: {
    accountEquity: config.ACCOUNT_EQUITY,
    maxRiskPerTradePct: config.MAX_RISK_PER_TRADE_PCT,
    maxExposurePct: config.MAX_EXPOSURE_PCT,
    maxNotionalPerTradePct: config.MAX_NOTIONAL_PER_TRADE_PCT,
    maxOpenPositions: config.MAX_OPEN_POSITIONS
  }
});

let lastSignalRunStartedAt: Date | null = null;
let lastSignalRunFinishedAt: Date | null = null;
let lastSignalRunSource: 'manual' | 'candle' | 'startup' | null = null;
let lastSignalRunSymbols: string[] = [];
let lastSignalGeneratedCount = 0;

async function runAndPersist(
  symbols = config.watchlistSymbols,
  generatedFromCandleTs?: Date,
  source: 'manual' | 'candle' | 'startup' = generatedFromCandleTs ? 'candle' : 'manual'
) {
  lastSignalRunStartedAt = new Date();
  lastSignalRunSource = source;
  lastSignalRunSymbols = [...symbols];
  const results: Array<{ id: number; order: ProposedOrder }> = [];
  await repo.expireStalePendingSignals(config.SIGNAL_PROPOSAL_TTL_MS);
  const exposureSnapshot = await repo.getExposureSnapshot(config.EXECUTION_BASE_URL);
  for (const symbol of symbols) {
    let order: ProposedOrder;
    try {
      order = await engine.runForSymbol(symbol, exposureSnapshot, generatedFromCandleTs);
    } catch (error) {
      order = {
        instrument: symbol,
        side: 'HOLD',
        orderType: 'LMT',
        quantity: 0,
        reason: `Signal engine error: ${(error as Error).message}`,
        confidence: 0,
        timestamp: new Date().toISOString(),
        riskCheckStatus: 'REJECT',
        status: 'REJECTED',
        strategy: 'momentum_breakout_long_v1',
        generatedFromCandleTs
      };
    }

    const id = await repo.insertProposedOrder(order);
    if (order.status === 'PROPOSED') {
      await repo.supersedePendingSignalsForInstrument(symbol, id);
    }
    results.push({ id, order });
  }
  lastSignalGeneratedCount = results.length;
  lastSignalRunFinishedAt = new Date();
  return results;
}

app.get('/health', async () => ({
  ok: true,
  signalEventDriven: config.signalEventDriven,
  lastSignalRunStartedAt,
  lastSignalRunFinishedAt,
  lastSignalRunSource,
  lastSignalRunSymbols,
  lastSignalGeneratedCount
}));

app.post('/signals/run-once', async (request) => {
  const body = (request.body ?? {}) as { symbols?: string[] };
  const symbols = body.symbols?.length ? body.symbols : config.watchlistSymbols;
  const results = await runAndPersist(symbols, undefined, 'manual');
  return { generated: results.length, results };
});

app.post('/signals/on-candle', async (request) => {
  const body = (request.body ?? {}) as { symbol?: string; candleTs?: string };
  const symbol = body.symbol?.trim();
  if (!symbol) {
    throw new Error('symbol is required');
  }

  const candleTs = body.candleTs ? new Date(body.candleTs) : new Date();
  if (Number.isNaN(candleTs.getTime())) {
    throw new Error(`Invalid candleTs: ${body.candleTs}`);
  }

  const results = await runAndPersist([symbol], candleTs, 'candle');
  return { generated: results.length, skipped: false, results };
});

app.get('/signals/recent', async (request) => {
  const query = (request.query ?? {}) as { limit?: string };
  const limit = Number(query.limit ?? 50);
  return repo.getRecentSignals(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50);
});

app.post('/signals/outcomes/refresh', async (request) => {
  const body = (request.body ?? {}) as { limit?: number };
  const limit = Number.isFinite(Number(body.limit)) ? Math.min(Math.max(Number(body.limit), 1), 2000) : 500;
  const inserted = await repo.refreshSignalOutcomes(limit);
  return { inserted };
});

app.get('/signals/outcomes/summary', async (request) => {
  const query = (request.query ?? {}) as { limit?: string };
  const limit = Number(query.limit ?? 20);
  await repo.refreshSignalOutcomes(500);
  return repo.getSignalOutcomeSummary(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20);
});

app.get('/signals/report', async (request) => {
  const query = (request.query ?? {}) as { limit?: string };
  const limit = Number(query.limit ?? 300);
  const profiles = listStrategyProfiles();
  const strategyIds = profiles.map((profile) => profile.id);
  await repo.refreshSignalOutcomes(500);
  await repo.syncStrategyRuntimeStates(strategyIds, config.SIGNAL_STRATEGY_COOLDOWN_MS);
  return repo.getSignalReport(Number.isFinite(limit) ? Math.min(Math.max(limit, 20), 2000) : 300, strategyIds);
});

app.get('/signals/strategies', async () => {
  const profiles = listStrategyProfiles();
  await repo.syncStrategyRuntimeStates(
    profiles.map((profile) => profile.id),
    config.SIGNAL_STRATEGY_COOLDOWN_MS
  );

  const strategies = await Promise.all(
    profiles.map(async (profile) => ({
      ...profile,
      runtime: await repo.getStrategyRuntimeState(profile.id)
    }))
  );

  return { strategies };
});

app.post('/signals/strategies/:strategyId', async (request, reply) => {
  const params = request.params as { strategyId?: string };
  const strategyId = params.strategyId?.trim();
  const profiles = listStrategyProfiles();

  if (!strategyId || !profiles.some((profile) => profile.id === strategyId)) {
    reply.status(404);
    return { error: 'strategy_not_found' };
  }

  const parsed = strategyToggleSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.status(400);
    return { error: 'invalid_body', issues: parsed.error.issues };
  }

  const runtime = await repo.setStrategyManualEnabled(strategyId, parsed.data.enabled);
  return { strategyId, runtime };
});

async function main(): Promise<void> {
  await repo.init();

  const address = await app.listen({ port: config.SIGNAL_PORT, host: '0.0.0.0' });
  app.log.info(`signal-engine listening on ${address}`);

  if (config.signalEventDriven) {
    app.log.info('event-driven signal generation enabled; waiting for ingestion candle callbacks');
  } else {
    app.log.warn('signal-event-driven disabled, but interval scheduler has been removed; use /signals/run-once or enable candle callbacks');
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    try {
      await app.close();
      await redis.quit();
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
