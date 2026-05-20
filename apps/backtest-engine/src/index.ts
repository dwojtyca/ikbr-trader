import Fastify from "fastify";
import { z } from "zod";
import { config, type WatchlistInstrument } from "./config.js";
import {
  HistoricalClient,
  type InstrumentSubscription,
} from "./historical-client.js";
import { FrankfurterFxClient } from "./fx-client.js";
import { BacktestRepository, ensureBacktestDatabase } from "./repository.js";
import {
  BacktestSimulator,
  runParallelIsolatedStrategyBacktest,
} from "./simulator.js";

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
let historyJob: Promise<void> | null = null;
let runJob: Promise<void> | null = null;

const CHUNK_MS = 5 * 24 * 60 * 60 * 1000;

type HistoryProgressPhase = "fetch" | "resume" | "partial";

interface HistoryProgress {
  datasetId: number;
  phase: HistoryProgressPhase;
  startedAt: string;
  totalSymbols: number;
  completedSymbols: number;
  activeSymbols: string[];
  totalChunks: number;
  completedChunks: number;
}

let historyProgress: HistoryProgress | null = null;

function estimateChunksForRange(dateFrom: Date, dateTo: Date): number {
  const range = Math.max(0, dateTo.getTime() - dateFrom.getTime());
  return Math.max(1, Math.ceil(range / CHUNK_MS));
}

function initHistoryProgress(
  datasetId: number,
  phase: HistoryProgressPhase,
  totalSymbols: number,
  totalChunks: number,
): void {
  historyProgress = {
    datasetId,
    phase,
    startedAt: new Date().toISOString(),
    totalSymbols,
    completedSymbols: 0,
    activeSymbols: [],
    totalChunks,
    completedChunks: 0,
  };
}

function addActiveSymbol(symbol: string): void {
  if (!historyProgress) return;
  if (!historyProgress.activeSymbols.includes(symbol)) {
    historyProgress.activeSymbols.push(symbol);
  }
}

function removeActiveSymbol(symbol: string): void {
  if (!historyProgress) return;
  historyProgress.activeSymbols = historyProgress.activeSymbols.filter(
    (s) => s !== symbol,
  );
}

function bumpProgressChunks(): void {
  if (!historyProgress) return;
  historyProgress.completedChunks += 1;
}

function bumpProgressSymbol(): void {
  if (!historyProgress) return;
  historyProgress.completedSymbols += 1;
}

function clearHistoryProgress(): void {
  historyProgress = null;
}

const dateRangeSchema = z.object({
  dateFrom: z.string().min(1),
  dateTo: z.string().min(1),
});

const partialHistorySchema = z.object({
  symbols: z.array(z.string().min(1)).min(1),
  dateFrom: z.string().min(1).optional(),
  dateTo: z.string().min(1).optional(),
});

const runSchema = z.object({
  mode: z.enum(["bot", "isolated"]).default("bot"),
});

function parseDateStart(value: string): Date {
  const date = value.includes("T")
    ? new Date(value)
    : new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invalid dateFrom: ${value}`);
  return date;
}

function parseDateEnd(value: string): Date {
  const date = value.includes("T")
    ? new Date(value)
    : new Date(`${value}T23:59:59`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid dateTo: ${value}`);
  return date;
}

async function simulatorOptions() {
  return {
    minCandles: config.SIGNAL_MIN_CANDLES,
    maxSpreadBps: config.SIGNAL_MAX_SPREAD_BPS,
    minVolume1m: config.SIGNAL_MIN_CANDLE_VOLUME_1M,
    minConfidence: config.SIGNAL_MIN_CONFIDENCE,
    lmtEntryMode: config.SIGNAL_LMT_ENTRY_MODE,
    lmtEntryBufferBps: config.SIGNAL_LMT_ENTRY_BUFFER_BPS,
    fractionalSymbols: config.fractionalSymbols,
    fractionalQuantityStep: config.SIGNAL_FRACTIONAL_QUANTITY_STEP,
    minStopBpsBySecType: {
      STK: config.SIGNAL_MIN_STOP_BPS_STK,
      IND: config.SIGNAL_MIN_STOP_BPS_IND,
      CMDTY: config.SIGNAL_MIN_STOP_BPS_CMDTY,
    },
    baseCurrency: config.IB_CURRENCY,
    currencyBySymbol: config.currencyBySymbol,
    secTypeBySymbol: await repo.getSecTypeBySymbol(),
    priceMultiplierBySymbol: config.priceMultiplierOverrides,
    strategyCooldownMs: config.SIGNAL_STRATEGY_COOLDOWN_MS,
    commissionBps: config.BACKTEST_COMMISSION_BPS,
    syntheticSpreadBps: config.BACKTEST_SYNTHETIC_SPREAD_BPS,
    orderTtlCandles: config.BACKTEST_ORDER_TTL_CANDLES,
    riskLimits: {
      accountEquity: config.SIGNAL_ACCOUNT_EQUITY,
      maxRiskPerTradePct: config.SIGNAL_MAX_RISK_PER_TRADE_PCT,
      targetRiskPerTradePct: config.SIGNAL_TARGET_RISK_PER_TRADE_PCT,
      maxExposurePct: config.SIGNAL_MAX_EXPOSURE_PCT,
      maxNotionalPerTradePct: config.MAX_NOTIONAL_PER_TRADE_PCT,
      maxOpenPositions: config.SIGNAL_MAX_OPEN_POSITIONS,
    },
  };
}

function requiredFxQuoteCurrencies(): string[] {
  const baseCurrency = config.IB_CURRENCY.trim().toUpperCase();
  return Array.from(
    new Set(
      Object.values(config.currencyBySymbol)
        .map((currency) => currency.trim().toUpperCase())
        .filter((currency) => currency && currency !== baseCurrency),
    ),
  ).sort();
}

async function ensureHistoricalFxRates(
  dateFrom: Date,
  dateTo: Date,
): Promise<void> {
  const quoteCurrencies = requiredFxQuoteCurrencies();
  if (quoteCurrencies.length === 0) return;

  const baseCurrency = config.IB_CURRENCY.trim().toUpperCase();
  const client = new FrankfurterFxClient();
  for (const quoteCurrency of quoteCurrencies) {
    try {
      const rates = await client.fetchDailyRatesToBase({
        quoteCurrency,
        baseCurrency,
        dateFrom,
        dateTo,
      });
      await repo.insertFxRates(rates);
      app.log.info(
        { scope: "fx", quoteCurrency, baseCurrency, rates: rates.length },
        "historical FX rates fetched",
      );
    } catch (error) {
      const cachedRates = await repo.countFxRates(
        baseCurrency,
        [quoteCurrency],
        dateFrom,
        dateTo,
      );
      if (cachedRates > 0) {
        app.log.warn(
          {
            scope: "fx",
            quoteCurrency,
            baseCurrency,
            cachedRates,
            err: error,
          },
          "historical FX fetch failed; using cached FX rates",
        );
        continue;
      }
      throw error;
    }
  }
}

function createHistoricalClient(): HistoricalClient {
  return new HistoricalClient(
    {
      host: config.IB_SOCKET_HOST,
      port: config.IB_SOCKET_PORT,
      clientId: config.BACKTEST_INGESTION_CLIENT_ID,
      securityType: config.defaultSecurityType,
      exchange: config.IB_EXCHANGE,
      primaryExchange: config.IB_PRIMARY_EXCHANGE,
      currency: config.IB_CURRENCY,
      pacingPer10Min: config.BACKTEST_HISTORY_PACING_PER_10MIN,
      maxConcurrency: config.BACKTEST_HISTORY_CONCURRENCY,
    },
    (line) => app.log.info({ scope: "historical" }, line),
  );
}

function instrumentsForDatasetSymbols(
  symbols: string[],
): WatchlistInstrument[] {
  const configured = new Map(
    config.watchlistInstruments.map((instrument) => [
      instrument.symbol.toUpperCase(),
      instrument,
    ]),
  );
  return symbols.map(
    (symbol) => configured.get(symbol.toUpperCase()) ?? { symbol },
  );
}

async function fetchSubscriptionRange(
  client: HistoricalClient,
  sub: InstrumentSubscription,
  dateFrom: Date,
  dateTo: Date,
): Promise<void> {
  addActiveSymbol(sub.symbol);
  try {
    await client.fetchHistorical1mRange(
      sub,
      dateFrom,
      dateTo,
      async (candles) => {
        await repo.insertCandles1m(candles);
        bumpProgressChunks();
      },
    );
    bumpProgressSymbol();
  } finally {
    removeActiveSymbol(sub.symbol);
  }
}

/**
 * Run fn for every subscription with a concurrency cap. Errors are
 * surfaced via Promise.all so a single symbol failure aborts the job
 * (matches previous sequential behavior).
 */
async function fetchSubscriptionsInParallel(
  subscriptions: Array<{ sub: InstrumentSubscription; from: Date; to: Date }>,
  client: HistoricalClient,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < subscriptions.length) {
      const index = cursor++;
      const item = subscriptions[index];
      await fetchSubscriptionRange(client, item.sub, item.from, item.to);
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, subscriptions.length) },
    () => worker(),
  );
  await Promise.all(workers);
}

async function startHistoryFetchJob(
  datasetId: number,
  instruments: WatchlistInstrument[],
  dateFrom: Date,
  dateTo: Date,
): Promise<void> {
  const client = createHistoricalClient();

  initHistoryProgress(
    datasetId,
    "fetch",
    instruments.length,
    instruments.length * estimateChunksForRange(dateFrom, dateTo),
  );
  try {
    await client.connect();
    const subscriptions = await client.resolveContracts(instruments);
    for (const subscription of subscriptions) {
      if (subscription.instrumentContract) {
        await repo.upsertInstrumentContract(subscription.instrumentContract);
      }
    }
    await fetchSubscriptionsInParallel(
      subscriptions.map((sub) => ({ sub, from: dateFrom, to: dateTo })),
      client,
      config.BACKTEST_HISTORY_CONCURRENCY,
    );
    await ensureHistoricalFxRates(dateFrom, dateTo);
    await repo.rebuildAggregates();
    await repo.finishDataset(datasetId, "ready");
  } catch (error) {
    app.log.error({ err: error }, "historical fetch failed");
    await repo.finishDataset(datasetId, "failed", (error as Error).message);
  } finally {
    client.disconnect();
    historyJob = null;
    clearHistoryProgress();
  }
}

async function startHistoryResumeJob(
  datasetId: number,
  instruments: WatchlistInstrument[],
  dateFrom: Date,
  dateTo: Date,
): Promise<void> {
  const client = createHistoricalClient();

  try {
    const summaries = await repo.listCandleSymbolSummaries();
    const summaryBySymbol = new Map(
      summaries.map((summary) => [summary.symbol.toUpperCase(), summary]),
    );
    const toleranceMs = 7 * 24 * 60 * 60 * 1000;
    const pending = instruments
      .map((instrument) => {
        const summary = summaryBySymbol.get(instrument.symbol.toUpperCase());
        if (!summary || summary.candles === 0 || !summary.firstTs) {
          return { instrument, from: dateFrom, to: dateTo };
        }

        const firstTs = new Date(summary.firstTs);
        if (firstTs.getTime() > dateFrom.getTime() + toleranceMs) {
          return {
            instrument,
            from: dateFrom,
            to: new Date(firstTs.getTime() - 1000),
          };
        }

        return null;
      })
      .filter(
        (
          item,
        ): item is {
          instrument: WatchlistInstrument;
          from: Date;
          to: Date;
        } => {
          return item !== null && item.to > item.from;
        },
      );

    if (pending.length === 0) {
      await ensureHistoricalFxRates(dateFrom, dateTo);
      await repo.rebuildAggregates();
      await repo.finishDataset(datasetId, "ready");
      return;
    }

    const pendingChunks = pending.reduce(
      (sum, item) => sum + estimateChunksForRange(item.from, item.to),
      0,
    );
    initHistoryProgress(datasetId, "resume", pending.length, pendingChunks);

    await client.connect();
    const subscriptions = await client.resolveContracts(
      pending.map((item) => item.instrument),
    );
    for (const subscription of subscriptions) {
      if (subscription.instrumentContract) {
        await repo.upsertInstrumentContract(subscription.instrumentContract);
      }
    }
    const rangeBySymbol = new Map(
      pending.map((item) => [item.instrument.symbol.toUpperCase(), item]),
    );
    const items = subscriptions
      .map((sub) => {
        const range = rangeBySymbol.get(sub.symbol.toUpperCase());
        if (!range) return null;
        app.log.info(
          {
            scope: "historical",
            symbol: sub.symbol,
            dateFrom: range.from.toISOString(),
            dateTo: range.to.toISOString(),
          },
          "resuming historical symbol",
        );
        return { sub, from: range.from, to: range.to };
      })
      .filter(
        (item): item is { sub: InstrumentSubscription; from: Date; to: Date } =>
          item !== null,
      );
    await fetchSubscriptionsInParallel(
      items,
      client,
      config.BACKTEST_HISTORY_CONCURRENCY,
    );
    await ensureHistoricalFxRates(dateFrom, dateTo);
    await repo.rebuildAggregates();
    await repo.finishDataset(datasetId, "ready");
  } catch (error) {
    app.log.error({ err: error }, "historical resume failed");
    await repo.finishDataset(datasetId, "failed", (error as Error).message);
  } finally {
    client.disconnect();
    historyJob = null;
    clearHistoryProgress();
  }
}

/**
 * Per-symbol top-up that re-uses the existing dataset. Does NOT
 * TRUNCATE anything; insertCandles1m has ON CONFLICT (symbol, ts) so
 * re-fetching overlapping ranges is safe. After ingestion we rebuild
 * the higher-timeframe aggregates and merge the symbols into the
 * dataset's symbols TEXT[] so subsequent backtest runs see them.
 *
 * Used when adding 1-2 new tickers to the watchlist without wanting to
 * re-pull data for everything else (which IBKR rate-limits would make
 * very slow). Does NOT change the dataset's status: it stays 'ready'.
 */
async function startHistoryPartialJob(
  datasetId: number,
  instruments: WatchlistInstrument[],
  dateFrom: Date,
  dateTo: Date,
): Promise<void> {
  const client = createHistoricalClient();

  initHistoryProgress(
    datasetId,
    "partial",
    instruments.length,
    instruments.length * estimateChunksForRange(dateFrom, dateTo),
  );
  try {
    await client.connect();
    const subscriptions = await client.resolveContracts(instruments);
    for (const subscription of subscriptions) {
      if (subscription.instrumentContract) {
        await repo.upsertInstrumentContract(subscription.instrumentContract);
      }
    }
    for (const sub of subscriptions) {
      app.log.info(
        {
          scope: "historical",
          symbol: sub.symbol,
          dateFrom: dateFrom.toISOString(),
          dateTo: dateTo.toISOString(),
        },
        "partial-fetch symbol started",
      );
    }
    await fetchSubscriptionsInParallel(
      subscriptions.map((sub) => ({ sub, from: dateFrom, to: dateTo })),
      client,
      config.BACKTEST_HISTORY_CONCURRENCY,
    );
    await ensureHistoricalFxRates(dateFrom, dateTo);
    await repo.rebuildAggregates();
    await repo.appendDatasetSymbols(
      datasetId,
      instruments.map((i) => i.symbol),
    );
    await repo.refreshDatasetCandlesCount(datasetId);
    app.log.info(
      { datasetId, symbols: instruments.map((i) => i.symbol) },
      "partial history fetch completed",
    );
  } catch (error) {
    app.log.error({ err: error }, "partial history fetch failed");
    throw error;
  } finally {
    client.disconnect();
    historyJob = null;
    clearHistoryProgress();
  }
}

await ensureBacktestDatabase(
  config.BACKTEST_POSTGRES_ADMIN_URL,
  config.BACKTEST_POSTGRES_URL,
);
const repo = new BacktestRepository(config.BACKTEST_POSTGRES_URL);
await repo.init();
const abandonedRuns = await repo.failRunningRuns(
  "Backtest engine restarted before run completed",
);
if (abandonedRuns > 0) {
  app.log.warn({ abandonedRuns }, "marked abandoned backtest runs as failed");
}

app.get("/health", async () => ({
  ok: true,
  historyJobRunning: Boolean(historyJob),
  runJobRunning: Boolean(runJob),
}));

app.get("/backtest/dataset", async () => ({
  dataset: await repo.latestDataset(),
  historyJobRunning: Boolean(historyJob),
  historyProgress,
}));

app.post("/backtest/history", async (request, reply) => {
  if (historyJob) {
    reply.code(409);
    return { error: "history_job_running" };
  }

  const parsed = dateRangeSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid_body", details: parsed.error.flatten() };
  }

  const dateFrom = parseDateStart(parsed.data.dateFrom);
  const dateTo = parseDateEnd(parsed.data.dateTo);
  if (dateTo <= dateFrom) {
    reply.code(400);
    return { error: "invalid_range", message: "dateTo must be after dateFrom" };
  }

  const dataset = await repo.resetHistoricalData(
    dateFrom,
    dateTo,
    config.watchlistSymbols,
  );
  historyJob = startHistoryFetchJob(
    dataset.id,
    config.watchlistInstruments,
    dateFrom,
    dateTo,
  );

  reply.code(202);
  return { dataset, historyJobRunning: true };
});

app.post("/backtest/history/symbols", async (request, reply) => {
  if (historyJob) {
    reply.code(409);
    return { error: "history_job_running" };
  }

  const parsed = partialHistorySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid_body", details: parsed.error.flatten() };
  }

  const existing = await repo.latestDataset();
  if (!existing) {
    reply.code(400);
    return {
      error: "no_dataset",
      message:
        "No base dataset exists. Call POST /backtest/history first to seed one.",
    };
  }

  // Default to the existing dataset's window so a per-symbol top-up
  // produces candles aligned with the rest of the data.
  const dateFrom = parsed.data.dateFrom
    ? parseDateStart(parsed.data.dateFrom)
    : new Date(existing.dateFrom);
  const dateTo = parsed.data.dateTo
    ? parseDateEnd(parsed.data.dateTo)
    : new Date(existing.dateTo);
  if (dateTo <= dateFrom) {
    reply.code(400);
    return { error: "invalid_range", message: "dateTo must be after dateFrom" };
  }

  const instruments = instrumentsForDatasetSymbols(parsed.data.symbols);

  historyJob = startHistoryPartialJob(
    existing.id,
    instruments,
    dateFrom,
    dateTo,
  );

  reply.code(202);
  return {
    dataset: existing,
    requestedSymbols: instruments.map((i) => i.symbol.toUpperCase()),
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
    historyJobRunning: true,
  };
});

app.post("/backtest/history/resume", async (_request, reply) => {
  if (historyJob) {
    reply.code(409);
    return { error: "history_job_running" };
  }

  const existing = await repo.latestDataset();
  if (!existing) {
    reply.code(400);
    return { error: "no_dataset" };
  }
  if (existing.status === "ready") {
    reply.code(400);
    return { error: "dataset_already_ready" };
  }

  const dataset = await repo.resumeDataset(existing.id);
  const dateFrom = new Date(dataset.dateFrom);
  const dateTo = new Date(dataset.dateTo);
  historyJob = startHistoryResumeJob(
    dataset.id,
    instrumentsForDatasetSymbols(
      dataset.symbols.length > 0 ? dataset.symbols : config.watchlistSymbols,
    ),
    dateFrom,
    dateTo,
  );

  reply.code(202);
  return { dataset, historyJobRunning: true };
});

app.get("/backtest/runs", async () => ({
  runs: await repo.listRuns(),
  runJobRunning: Boolean(runJob),
}));

app.post("/backtest/run", async (request, reply) => {
  if (runJob) {
    reply.code(409);
    return { error: "backtest_job_running" };
  }

  const parsed = runSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.code(400);
    return { error: "invalid_body", details: parsed.error.flatten() };
  }

  const mode = parsed.data.mode;
  const dataset = await repo.latestDataset();
  if (!dataset || dataset.status !== "ready") {
    reply.code(400);
    return { error: "no_ready_dataset" };
  }
  const options = await simulatorOptions();
  const run = await repo.createRun(
    dataset.id,
    {
      mode,
      ...options,
      fractionalSymbols: Array.from(config.fractionalSymbols),
    },
    mode,
  );

  runJob = (async () => {
    try {
      await repo.updateRunProgress(run.id, {
        current: 0,
        total: dataset.candlesCount,
        label: "loading dataset",
      });
      await ensureHistoricalFxRates(
        new Date(dataset.dateFrom),
        new Date(dataset.dateTo),
      );
      const metrics =
        mode === "isolated"
          ? await runParallelIsolatedStrategyBacktest(
              repo,
              run.id,
              config.BACKTEST_POSTGRES_URL,
              options,
              config.BACKTEST_STRATEGY_LAB_CONCURRENCY,
              (line) =>
                app.log.info({ scope: "strategy-lab", runId: run.id }, line),
            )
          : await (async () => {
              const data = await repo.loadBacktestData();
              return new BacktestSimulator(repo, run.id, data, options).run({
                total: data.candles1m.length,
                label: "bot backtest",
                onProgress: (progress) =>
                  repo.updateRunProgress(run.id, progress),
              });
            })();
      await repo.finishRun(run.id, "completed", metrics);
    } catch (error) {
      app.log.error({ err: error }, "backtest run failed");
      await repo.finishRun(run.id, "failed", {
        error: (error as Error).message,
      });
    } finally {
      runJob = null;
    }
  })();

  reply.code(202);
  return { run, runJobRunning: true };
});

app.get("/backtest/report", async (request) => {
  const query = request.query as { runId?: string };
  const runId = query.runId ? Number(query.runId) : undefined;
  return repo.getReport(Number.isFinite(runId) ? runId : undefined);
});

app.addHook("onClose", async () => {
  await repo.close();
});

app.listen({ port: config.BACKTEST_PORT, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
