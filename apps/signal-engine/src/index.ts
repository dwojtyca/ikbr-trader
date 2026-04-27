import Fastify from 'fastify';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { ProposedOrder } from '@ikbr/shared';
import { config } from './config.js';
import { SignalRepository } from './repository.js';
import { SignalEngine } from './signal-engine.js';

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const pool = new Pool({ connectionString: config.POSTGRES_URL });
const redis = new Redis(config.REDIS_URL);
const repo = new SignalRepository(pool, redis);
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
  minStopBpsByAssetClass: {
    stock: config.SIGNAL_MIN_STOP_BPS_STOCK,
    index: config.SIGNAL_MIN_STOP_BPS_INDEX,
    commodity: config.SIGNAL_MIN_STOP_BPS_COMMODITY
  },
  maxMarketStateAgeMs: config.SIGNAL_MAX_MARKET_STATE_AGE_MS,
  assetClassBySymbol: config.assetClassOverrides,
  executionBaseUrl: config.EXECUTION_BASE_URL,
  riskLimits: {
    accountEquity: config.ACCOUNT_EQUITY,
    maxRiskPerTradePct: config.MAX_RISK_PER_TRADE_PCT,
    maxExposurePct: config.MAX_EXPOSURE_PCT,
    maxNotionalPerTradePct: config.MAX_NOTIONAL_PER_TRADE_PCT,
    maxOpenPositions: config.MAX_OPEN_POSITIONS
  }
});

const LOW_VALUE_HOLD_REJECT_PREFIXES = [
  'No edge for ',
  'Liquidity filter rejected signal',
  'Spread filter rejected signal'
];
let lastSignalRunStartedAt: Date | null = null;
let lastSignalRunFinishedAt: Date | null = null;
let lastSignalRunSource: 'manual' | 'candle' | 'startup' | null = null;
let lastSignalRunSymbols: string[] = [];
let lastSignalGeneratedCount = 0;

function shouldPersistOrder(order: ProposedOrder): boolean {
  if (order.status !== 'REJECTED') return true;
  if (order.side !== 'HOLD') return true;

  const reason = (order.reason ?? '').trim();
  if (!reason) return true;

  return !LOW_VALUE_HOLD_REJECT_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

async function shouldSkipDuplicatePersist(order: ProposedOrder): Promise<boolean> {
  if (config.SIGNAL_HOLD_REJECT_DEDUP_MS <= 0) return false;
  if (order.status !== 'REJECTED' || order.side !== 'HOLD') return false;

  const reason = (order.reason ?? '').trim();
  if (!reason) return false;

  return repo.hasRecentDuplicateHoldReject(order.instrument, reason, config.SIGNAL_HOLD_REJECT_DEDUP_MS);
}

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
        strategy: 'adaptive_profile_v1',
        generatedFromCandleTs
      };
    }

    if (!shouldPersistOrder(order)) {
      app.log.debug(
        { symbol, reason: order.reason, status: order.status, side: order.side },
        'skip persisting low-value HOLD/REJECT signal'
      );
      continue;
    }

    if (await shouldSkipDuplicatePersist(order)) {
      app.log.debug(
        {
          symbol,
          reason: order.reason,
          status: order.status,
          side: order.side,
          dedupWindowMs: config.SIGNAL_HOLD_REJECT_DEDUP_MS
        },
        'skip persisting duplicate HOLD/REJECT signal'
      );
      continue;
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

  if (await repo.hasSignalForInstrumentCandle(symbol, candleTs)) {
    return { generated: 0, skipped: true, reason: 'already_processed_for_candle' };
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
  await repo.refreshSignalOutcomes(500);
  return repo.getSignalReport(Number.isFinite(limit) ? Math.min(Math.max(limit, 20), 2000) : 300);
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
