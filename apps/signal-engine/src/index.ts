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

async function runAndPersist(symbols = config.watchlistSymbols) {
  const results: Array<{ id: number; order: ProposedOrder }> = [];
  const exposureSnapshot = await repo.getExposureSnapshot(config.EXECUTION_BASE_URL);
  for (const symbol of symbols) {
    let order: ProposedOrder;
    try {
      order = await engine.runForSymbol(symbol, exposureSnapshot);
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
        strategy: 'adaptive_profile_v1'
      };
    }

    await repo.cancelOpenProposalsForInstrument(symbol);
    const id = await repo.insertProposedOrder(order);
    results.push({ id, order });
  }
  return results;
}

app.get('/health', async () => ({ ok: true }));

app.post('/signals/run-once', async (request) => {
  const body = (request.body ?? {}) as { symbols?: string[] };
  const symbols = body.symbols?.length ? body.symbols : config.watchlistSymbols;
  const results = await runAndPersist(symbols);
  return { generated: results.length, results };
});

app.get('/signals/recent', async (request) => {
  const query = (request.query ?? {}) as { limit?: string };
  const limit = Number(query.limit ?? 50);
  return repo.getRecentSignals(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50);
});

let timer: NodeJS.Timeout | undefined;

async function main(): Promise<void> {
  await repo.init();

  const address = await app.listen({ port: config.SIGNAL_PORT, host: '0.0.0.0' });
  app.log.info(`signal-engine listening on ${address}`);

  if (config.signalAutoRun) {
    timer = setInterval(() => {
      void runAndPersist().catch((err) => app.log.error(err, 'scheduled signal run failed'));
    }, config.SIGNAL_POLL_MS);
    app.log.info(`auto-run enabled; interval ${config.SIGNAL_POLL_MS}ms`);
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    try {
      if (timer) clearInterval(timer);
      await app.close();
      await redis.quit();
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
