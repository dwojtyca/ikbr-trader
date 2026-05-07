import Fastify from 'fastify';
import { z } from 'zod';
import { config, type WatchlistInstrument } from './config.js';
import { HistoricalClient, type InstrumentSubscription } from './historical-client.js';
import { FrankfurterFxClient } from './fx-client.js';
import { BacktestRepository, ensureBacktestDatabase } from './repository.js';
import { BacktestSimulator, runParallelIsolatedStrategyBacktest } from './simulator.js';

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
let historyJob: Promise<void> | null = null;
let runJob: Promise<void> | null = null;

const dateRangeSchema = z.object({
  dateFrom: z.string().min(1),
  dateTo: z.string().min(1)
});

const runSchema = z.object({
  mode: z.enum(['bot', 'isolated']).default('bot')
});

function parseDateStart(value: string): Date {
  const date = value.includes('T') ? new Date(value) : new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid dateFrom: ${value}`);
  return date;
}

function parseDateEnd(value: string): Date {
  const date = value.includes('T') ? new Date(value) : new Date(`${value}T23:59:59`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid dateTo: ${value}`);
  return date;
}

function simulatorOptions() {
  return {
    minCandles: config.SIGNAL_MIN_CANDLES,
    maxSpreadBps: config.MAX_SPREAD_BPS,
    minVolume1m: config.MIN_CANDLE_VOLUME_1M,
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
    baseCurrency: config.IB_CURRENCY,
    currencyBySymbol: config.currencyBySymbol,
    assetClassBySymbol: config.assetClassOverrides,
    priceMultiplierBySymbol: config.priceMultiplierOverrides,
    strategyCooldownMs: config.SIGNAL_STRATEGY_COOLDOWN_MS,
    symbolAddLossLimit: config.SIGNAL_SYMBOL_ADD_LOSS_LIMIT,
    commissionBps: config.BACKTEST_COMMISSION_BPS,
    syntheticSpreadBps: config.BACKTEST_SYNTHETIC_SPREAD_BPS,
    orderTtlCandles: config.BACKTEST_ORDER_TTL_CANDLES,
    riskLimits: {
      accountEquity: config.ACCOUNT_EQUITY,
      maxRiskPerTradePct: config.MAX_RISK_PER_TRADE_PCT,
      maxExposurePct: config.MAX_EXPOSURE_PCT,
      maxNotionalPerTradePct: config.MAX_NOTIONAL_PER_TRADE_PCT,
      maxOpenPositions: config.MAX_OPEN_POSITIONS
    }
  };
}

function requiredFxQuoteCurrencies(): string[] {
  const baseCurrency = config.IB_CURRENCY.trim().toUpperCase();
  return Array.from(
    new Set(
      Object.values(config.currencyBySymbol)
        .map((currency) => currency.trim().toUpperCase())
        .filter((currency) => currency && currency !== baseCurrency)
    )
  ).sort();
}

async function ensureHistoricalFxRates(dateFrom: Date, dateTo: Date): Promise<void> {
  const quoteCurrencies = requiredFxQuoteCurrencies();
  if (quoteCurrencies.length === 0) return;

  const baseCurrency = config.IB_CURRENCY.trim().toUpperCase();
  const client = new FrankfurterFxClient();
  for (const quoteCurrency of quoteCurrencies) {
    const rates = await client.fetchDailyRatesToBase({ quoteCurrency, baseCurrency, dateFrom, dateTo });
    await repo.insertFxRates(rates);
    app.log.info({ scope: 'fx', quoteCurrency, baseCurrency, rates: rates.length }, 'historical FX rates fetched');
  }
}

function createHistoricalClient(): HistoricalClient {
  return new HistoricalClient(
    {
      host: config.IB_SOCKET_HOST,
      port: config.IB_SOCKET_PORT,
      clientId: config.BACKTEST_IB_CLIENT_ID,
      securityType: config.IB_SECURITY_TYPE,
      exchange: config.IB_EXCHANGE,
      primaryExchange: config.IB_PRIMARY_EXCHANGE,
      currency: config.IB_CURRENCY
    },
    (line) => app.log.info({ scope: 'historical' }, line)
  );
}

function instrumentsForDatasetSymbols(symbols: string[]): WatchlistInstrument[] {
  const configured = new Map(config.watchlistInstruments.map((instrument) => [instrument.symbol.toUpperCase(), instrument]));
  return symbols.map((symbol) => configured.get(symbol.toUpperCase()) ?? { symbol });
}

async function fetchSubscriptionRange(
  client: HistoricalClient,
  sub: InstrumentSubscription,
  dateFrom: Date,
  dateTo: Date
): Promise<void> {
  await client.fetchHistorical1mRange(sub, dateFrom, dateTo, async (candles) => {
    await repo.insertCandles1m(candles);
  });
}

async function startHistoryFetchJob(datasetId: number, instruments: WatchlistInstrument[], dateFrom: Date, dateTo: Date): Promise<void> {
  const client = createHistoricalClient();

  try {
    await client.connect();
    const subscriptions = await client.resolveContracts(instruments);
    for (const sub of subscriptions) {
      await fetchSubscriptionRange(client, sub, dateFrom, dateTo);
    }
    await ensureHistoricalFxRates(dateFrom, dateTo);
    await repo.rebuildAggregates();
    await repo.finishDataset(datasetId, 'ready');
  } catch (error) {
    app.log.error({ err: error }, 'historical fetch failed');
    await repo.finishDataset(datasetId, 'failed', (error as Error).message);
  } finally {
    client.disconnect();
    historyJob = null;
  }
}

async function startHistoryResumeJob(datasetId: number, instruments: WatchlistInstrument[], dateFrom: Date, dateTo: Date): Promise<void> {
  const client = createHistoricalClient();

  try {
    const summaries = await repo.listCandleSymbolSummaries();
    const summaryBySymbol = new Map(summaries.map((summary) => [summary.symbol.toUpperCase(), summary]));
    const toleranceMs = 7 * 24 * 60 * 60 * 1000;
    const pending = instruments
      .map((instrument) => {
        const summary = summaryBySymbol.get(instrument.symbol.toUpperCase());
        if (!summary || summary.candles === 0 || !summary.firstTs) {
          return { instrument, from: dateFrom, to: dateTo };
        }

        const firstTs = new Date(summary.firstTs);
        if (firstTs.getTime() > dateFrom.getTime() + toleranceMs) {
          return { instrument, from: dateFrom, to: new Date(firstTs.getTime() - 1000) };
        }

        return null;
      })
      .filter((item): item is { instrument: WatchlistInstrument; from: Date; to: Date } => {
        return item !== null && item.to > item.from;
      });

    if (pending.length === 0) {
      await ensureHistoricalFxRates(dateFrom, dateTo);
      await repo.rebuildAggregates();
      await repo.finishDataset(datasetId, 'ready');
      return;
    }

    await client.connect();
    const subscriptions = await client.resolveContracts(pending.map((item) => item.instrument));
    const rangeBySymbol = new Map(pending.map((item) => [item.instrument.symbol.toUpperCase(), item]));
    for (const sub of subscriptions) {
      const range = rangeBySymbol.get(sub.symbol.toUpperCase());
      if (!range) continue;
      app.log.info(
        { scope: 'historical', symbol: sub.symbol, dateFrom: range.from.toISOString(), dateTo: range.to.toISOString() },
        'resuming historical symbol'
      );
      await fetchSubscriptionRange(client, sub, range.from, range.to);
    }
    await ensureHistoricalFxRates(dateFrom, dateTo);
    await repo.rebuildAggregates();
    await repo.finishDataset(datasetId, 'ready');
  } catch (error) {
    app.log.error({ err: error }, 'historical resume failed');
    await repo.finishDataset(datasetId, 'failed', (error as Error).message);
  } finally {
    client.disconnect();
    historyJob = null;
  }
}

await ensureBacktestDatabase(config.POSTGRES_ADMIN_URL, config.BACKTEST_POSTGRES_URL);
const repo = new BacktestRepository(config.BACKTEST_POSTGRES_URL);
await repo.init();
const abandonedRuns = await repo.failRunningRuns('Backtest engine restarted before run completed');
if (abandonedRuns > 0) {
  app.log.warn({ abandonedRuns }, 'marked abandoned backtest runs as failed');
}

app.get('/health', async () => ({
  ok: true,
  historyJobRunning: Boolean(historyJob),
  runJobRunning: Boolean(runJob)
}));

app.get('/backtest/dataset', async () => ({
  dataset: await repo.latestDataset(),
  historyJobRunning: Boolean(historyJob)
}));

app.post('/backtest/history', async (request, reply) => {
  if (historyJob) {
    reply.code(409);
    return { error: 'history_job_running' };
  }

  const parsed = dateRangeSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.code(400);
    return { error: 'invalid_body', details: parsed.error.flatten() };
  }

  const dateFrom = parseDateStart(parsed.data.dateFrom);
  const dateTo = parseDateEnd(parsed.data.dateTo);
  if (dateTo <= dateFrom) {
    reply.code(400);
    return { error: 'invalid_range', message: 'dateTo must be after dateFrom' };
  }

  const dataset = await repo.resetHistoricalData(dateFrom, dateTo, config.watchlistSymbols);
  historyJob = startHistoryFetchJob(dataset.id, config.watchlistInstruments, dateFrom, dateTo);

  reply.code(202);
  return { dataset, historyJobRunning: true };
});

app.post('/backtest/history/resume', async (_request, reply) => {
  if (historyJob) {
    reply.code(409);
    return { error: 'history_job_running' };
  }

  const existing = await repo.latestDataset();
  if (!existing) {
    reply.code(400);
    return { error: 'no_dataset' };
  }
  if (existing.status === 'ready') {
    reply.code(400);
    return { error: 'dataset_already_ready' };
  }

  const dataset = await repo.resumeDataset(existing.id);
  const dateFrom = new Date(dataset.dateFrom);
  const dateTo = new Date(dataset.dateTo);
  historyJob = startHistoryResumeJob(
    dataset.id,
    instrumentsForDatasetSymbols(dataset.symbols.length > 0 ? dataset.symbols : config.watchlistSymbols),
    dateFrom,
    dateTo
  );

  reply.code(202);
  return { dataset, historyJobRunning: true };
});

app.get('/backtest/runs', async () => ({
  runs: await repo.listRuns(),
  runJobRunning: Boolean(runJob)
}));

app.post('/backtest/run', async (request, reply) => {
  if (runJob) {
    reply.code(409);
    return { error: 'backtest_job_running' };
  }

  const parsed = runSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.code(400);
    return { error: 'invalid_body', details: parsed.error.flatten() };
  }

  const mode = parsed.data.mode;
  const dataset = await repo.latestDataset();
  if (!dataset || dataset.status !== 'ready') {
    reply.code(400);
    return { error: 'no_ready_dataset' };
  }
  const run = await repo.createRun(dataset.id, {
    mode,
    ...simulatorOptions(),
    fractionalSymbols: Array.from(config.fractionalSymbols)
  }, mode);

  runJob = (async () => {
    try {
      await repo.updateRunProgress(run.id, {
        current: 0,
        total: dataset.candlesCount,
        label: 'loading dataset'
      });
      await ensureHistoricalFxRates(new Date(dataset.dateFrom), new Date(dataset.dateTo));
      const metrics = mode === 'isolated'
        ? await runParallelIsolatedStrategyBacktest(
          repo,
          run.id,
          config.BACKTEST_POSTGRES_URL,
          dataset.candlesCount,
          simulatorOptions(),
          config.BACKTEST_STRATEGY_LAB_CONCURRENCY,
          (line) => app.log.info({ scope: 'strategy-lab', runId: run.id }, line)
        )
        : await (async () => {
          const data = await repo.loadBacktestData();
          return new BacktestSimulator(repo, run.id, data, simulatorOptions()).run({
            total: data.candles1m.length,
            label: 'bot backtest',
            onProgress: (progress) => repo.updateRunProgress(run.id, progress)
          });
        })();
      await repo.finishRun(run.id, 'completed', metrics);
    } catch (error) {
      app.log.error({ err: error }, 'backtest run failed');
      await repo.finishRun(run.id, 'failed', { error: (error as Error).message });
    } finally {
      runJob = null;
    }
  })();

  reply.code(202);
  return { run, runJobRunning: true };
});

app.get('/backtest/report', async (request) => {
  const query = request.query as { runId?: string };
  const runId = query.runId ? Number(query.runId) : undefined;
  return repo.getReport(Number.isFinite(runId) ? runId : undefined);
});

app.addHook('onClose', async () => {
  await repo.close();
});

app.listen({ port: config.BACKTEST_PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
