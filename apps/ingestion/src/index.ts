import Fastify from "fastify";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { config } from "./config.js";
import { TwsClient } from "./tws-client.js";
import { MarketRepository } from "./db.js";
import { CandleAggregator } from "./candle-aggregator.js";
import { HigherTimeframeAggregator } from "./higher-timeframe-aggregator.js";
import { InstrumentSubscription } from "./types.js";

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const pg = new Pool({ connectionString: config.POSTGRES_URL });
const redis = new Redis(config.REDIS_URL);
const repo = new MarketRepository(pg);
const aggregator = new CandleAggregator();
const higherTimeframeAggregator = new HigherTimeframeAggregator();
let activeSubscriptions: InstrumentSubscription[] = [];
let lastBootstrapAt: Date | null = null;
let lastTickAt: Date | null = null;
let lastCandleAt: Date | null = null;

interface BackfillProgress {
  phase: "connecting" | "one_minute" | "native_tf" | "completed";
  startedAt: string;
  finishedAt: string | null;
  totalSymbols: number;
  totalJobs: number;
  completedJobs: number;
  currentTimeframe: string | null;
  currentSymbol: string | null;
  completedSymbolsInJob: number;
  insertedByTimeframe: Record<string, number>;
  failedTimeframes: string[];
}

let backfillProgress: BackfillProgress | null = null;
let bootstrapInFlight = false;

async function flushBufferedCandles(): Promise<void> {
  const buffered = aggregator.flushAll();
  for (const candle of buffered) {
    await repo.upsertCandle(candle);
  }

  const higher = higherTimeframeAggregator.flushAll();
  for (const candle of higher) {
    await repo.upsertCandle(candle);
  }
}

async function stopIngestionSession(): Promise<void> {
  await flushBufferedCandles();
  twsClient.clearSubscriptions();
  twsClient.disconnect();
  activeSubscriptions = [];
}

async function triggerSignalsForCandle(
  symbol: string,
  candleTs: Date,
): Promise<void> {
  if (!config.ingestionTriggerSignalsOnCandle) return;

  const base = config.INGESTION_SIGNAL_ENGINE_BASE_URL.replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${base}/signals/on-candle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbol,
        candleTs: candleTs.toISOString(),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      app.log.warn(
        { symbol, candleTs, status: response.status, text },
        "signal trigger request failed",
      );
    }
  } catch (error) {
    app.log.warn(
      { symbol, candleTs, error: (error as Error).message },
      "signal trigger request errored",
    );
  } finally {
    clearTimeout(timeout);
  }
}

const twsClient = new TwsClient(
  {
    host: config.IB_SOCKET_HOST,
    port: config.IB_SOCKET_PORT,
    clientId: config.INGESTION_CLIENT_ID,
    securityType: config.defaultSecurityType,
    exchange: config.IB_EXCHANGE,
    primaryExchange: config.IB_PRIMARY_EXCHANGE,
    currency: config.IB_CURRENCY,
    marketDataType: config.IB_MARKET_DATA_TYPE,
  },
  async (tick) => {
    lastTickAt = tick.ts;
    const spread =
      tick.bid !== undefined && tick.ask !== undefined
        ? tick.ask - tick.bid
        : undefined;

    await repo.writeMarketState(redis, {
      conid: tick.conid,
      symbol: tick.symbol,
      lastPrice: tick.price,
      bid: tick.bid,
      ask: tick.ask,
      spread,
      ts: tick.ts,
    });

    const ready = aggregator.ingest(tick);
    for (const oneMinuteCandle of ready) {
      lastCandleAt = oneMinuteCandle.ts;
      await repo.upsertCandle(oneMinuteCandle);
      app.log.debug({ candle: oneMinuteCandle }, "persisted candle 1m");
      void triggerSignalsForCandle(oneMinuteCandle.symbol, oneMinuteCandle.ts);

      const higherCandles = higherTimeframeAggregator.ingest(oneMinuteCandle);
      for (const higherCandle of higherCandles) {
        await repo.upsertCandle(higherCandle);
        app.log.debug(
          { candle: higherCandle },
          `persisted candle ${higherCandle.timeframe}`,
        );
      }
    }
  },
  (line) => app.log.info(line),
);

app.get("/health", async () => ({
  ok: true,
  connected: twsClient.isConnected(),
  bootstrapped: activeSubscriptions.length > 0,
  bootstrapping: bootstrapInFlight,
  lastBootstrapAt,
  lastTickAt,
  lastCandleAt,
}));

app.get("/backfill-progress", async () => ({
  progress: backfillProgress,
}));

app.get("/watchlist", async () => {
  const subscriptionsBySymbol = new Map(
    activeSubscriptions.map((sub) => [sub.symbol, sub]),
  );
  const conids = activeSubscriptions.map((sub) => sub.conid);
  const latestCandles = await repo.getLatestCandles1mByConids(conids);

  const watchlist = await Promise.all(
    config.watchlistInstruments.map(async ({ symbol }) => {
      const subscription = subscriptionsBySymbol.get(symbol);
      const marketState = subscription
        ? await repo.readMarketState(redis, subscription.conid)
        : null;
      const latestCandle1m = subscription
        ? (latestCandles.get(subscription.conid) ?? null)
        : null;

      return {
        symbol,
        displayName: subscription?.displayName ?? null,
        conid: subscription?.conid ?? null,
        subscribed: Boolean(subscription),
        marketState,
        latestCandle1m,
      };
    }),
  );

  return {
    connected: twsClient.isConnected(),
    bootstrapped: activeSubscriptions.length > 0,
    bootstrapping: bootstrapInFlight,
    lastBootstrapAt,
    watchlist,
  };
});

app.post("/bootstrap", async () => {
  if (bootstrapInFlight) {
    return {
      alreadyRunning: true,
      bootstrapping: true,
      connected: twsClient.isConnected(),
      bootstrapped: activeSubscriptions.length > 0,
    };
  }
  bootstrapInFlight = true;
  backfillProgress = {
    phase: "connecting",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalSymbols: 0,
    totalJobs: 0,
    completedJobs: 0,
    currentTimeframe: null,
    currentSymbol: null,
    completedSymbolsInJob: 0,
    insertedByTimeframe: {},
    failedTimeframes: [],
  };
  try {
    await twsClient.connect();
    const accounts = await twsClient.getManagedAccounts();
    const accountId = config.IBKR_ACCOUNT_ID ?? accounts[0];
    if (!accountId) {
      throw new Error("No account available from TWS managed accounts");
    }
    if (config.IBKR_ACCOUNT_ID && !accounts.includes(config.IBKR_ACCOUNT_ID)) {
      app.log.warn(
        { requested: config.IBKR_ACCOUNT_ID, accounts },
        "configured IBKR_ACCOUNT_ID not found in managed accounts",
      );
    }

    const subscriptions = await twsClient.resolveContracts(
      config.watchlistInstruments,
    );
    for (const subscription of subscriptions) {
      if (subscription.instrumentContract) {
        await repo.upsertInstrumentContract(subscription.instrumentContract);
      }
    }
    if (backfillProgress) {
      backfillProgress.phase = "one_minute";
      backfillProgress.totalSymbols = subscriptions.length;
    }
    const historical = await twsClient.backfillRecentCandles1m(
      subscriptions,
      config.backfill1mCandles,
    );

    let backfilledCandles1m = 0;
    let backfilledCandles5m = 0;
    let backfilledCandles1h = 0;
    let backfilledCandles4h = 0;
    let backfilledCandles12h = 0;
    let backfilledCandles1d = 0;
    let backfilledCandles1w = 0;
    const backfillBySymbol: Array<{
      symbol: string;
      conid: string;
      candles1m: number;
    }> = [];

    for (const entry of historical) {
      backfillBySymbol.push({
        symbol: entry.symbol,
        conid: entry.conid,
        candles1m: entry.candles.length,
      });

      for (const candle of entry.candles) {
        await repo.upsertCandle(candle);
        backfilledCandles1m += 1;

        const higher = higherTimeframeAggregator.ingest(candle);
        for (const higherCandle of higher) {
          await repo.upsertCandle(higherCandle);
          if (higherCandle.timeframe === "5m") backfilledCandles5m += 1;
          if (higherCandle.timeframe === "1h") backfilledCandles1h += 1;
          if (higherCandle.timeframe === "4h") backfilledCandles4h += 1;
          if (higherCandle.timeframe === "12h") backfilledCandles12h += 1;
          if (higherCandle.timeframe === "1d") backfilledCandles1d += 1;
          if (higherCandle.timeframe === "1w") backfilledCandles1w += 1;
        }
      }
    }

    // Stage 8: native higher-timeframe backfill direct from TWS. The 1m
    // backfill above only covers ~220 minutes per symbol, so the aggregator
    // can at best build a handful of 4h/1d/1w bars — far below the 20 bars
    // required for EMA50/EMA200 and the regime detector to work. Here we
    // pull true historical bars per timeframe so indicators are sized
    // correctly from the first tick. Native bars overwrite any aggregated
    // approximations for the same timestamp (upsert).
    const higherBackfillJobs: Array<{
      timeframe: import("@ikbr/shared").CandleTimeframe;
      count: number;
    }> = [
      { timeframe: "5m", count: config.backfill5mCandles },
      { timeframe: "1h", count: config.backfill1hCandles },
      { timeframe: "4h", count: config.backfill4hCandles },
      { timeframe: "12h", count: config.backfill12hCandles },
      { timeframe: "1d", count: config.backfill1dCandles },
      { timeframe: "1w", count: config.backfill1wCandles },
    ];
    const nativeBackfillStats: Record<string, number> = {};
    const enabledJobs = higherBackfillJobs.filter((job) => job.count > 0);
    const totalJobs = enabledJobs.length;
    const totalSymbols = subscriptions.length;
    backfillProgress = {
      startedAt: backfillProgress?.startedAt ?? new Date().toISOString(),
      phase: "native_tf",
      finishedAt: null,
      totalSymbols,
      totalJobs,
      completedJobs: 0,
      currentTimeframe: null,
      currentSymbol: null,
      completedSymbolsInJob: 0,
      insertedByTimeframe: {},
      failedTimeframes: [],
    };
    let jobIndex = 0;
    for (const job of enabledJobs) {
      jobIndex += 1;
      if (backfillProgress) {
        backfillProgress.currentTimeframe = job.timeframe;
        backfillProgress.currentSymbol = null;
        backfillProgress.completedSymbolsInJob = 0;
      }
      app.log.info(
        {
          timeframe: job.timeframe,
          progress: `${jobIndex}/${totalJobs}`,
          symbols: totalSymbols,
          candlesPerSymbol: job.count,
        },
        `native historical backfill starting [${jobIndex}/${totalJobs}] ${job.timeframe}`,
      );
      try {
        const results = await twsClient.backfillRecentCandles(
          subscriptions,
          job.timeframe,
          job.count,
          ({ symbol, index }) => {
            if (!backfillProgress) return;
            backfillProgress.currentSymbol = symbol;
            backfillProgress.completedSymbolsInJob = Math.max(0, index - 1);
          },
        );
        let inserted = 0;
        for (const entry of results) {
          for (const candle of entry.candles) {
            await repo.upsertCandle(candle);
            inserted += 1;
          }
        }
        nativeBackfillStats[job.timeframe] = inserted;
        if (backfillProgress) {
          backfillProgress.insertedByTimeframe[job.timeframe] = inserted;
          backfillProgress.completedJobs = jobIndex;
          backfillProgress.completedSymbolsInJob = totalSymbols;
          backfillProgress.currentSymbol = null;
        }
        const pct = Math.round((jobIndex / totalJobs) * 100);
        app.log.info(
          {
            timeframe: job.timeframe,
            progress: `${jobIndex}/${totalJobs}`,
            pct,
            requestedPerSymbol: job.count,
            inserted,
            symbols: results.length,
          },
          `native historical backfill completed [${jobIndex}/${totalJobs} ${pct}%] ${job.timeframe}`,
        );
      } catch (error) {
        if (backfillProgress) {
          backfillProgress.failedTimeframes.push(job.timeframe);
          backfillProgress.completedJobs = jobIndex;
        }
        app.log.warn(
          {
            timeframe: job.timeframe,
            progress: `${jobIndex}/${totalJobs}`,
            err: error,
          },
          "native historical backfill failed",
        );
      }
    }
    if (backfillProgress) {
      backfillProgress.finishedAt = new Date().toISOString();
      backfillProgress.phase = "completed";
      backfillProgress.currentTimeframe = null;
      backfillProgress.currentSymbol = null;
    }

    app.log.info(
      {
        requestedPerSymbol: config.backfill1mCandles,
        backfilledCandles1m,
        backfilledCandles5m,
        backfilledCandles1h,
        backfilledCandles4h,
        backfilledCandles12h,
        backfilledCandles1d,
        backfilledCandles1w,
        symbols: backfillBySymbol,
      },
      "historical backfill completed",
    );

    twsClient.clearSubscriptions();
    activeSubscriptions = [];
    twsClient.addSubscriptions(subscriptions);
    activeSubscriptions = subscriptions;
    lastBootstrapAt = new Date();

    return {
      socket: {
        host: config.IB_SOCKET_HOST,
        port: config.IB_SOCKET_PORT,
        clientId: config.INGESTION_CLIENT_ID,
      },
      accounts,
      accountId,
      historicalBackfill: {
        requestedPerSymbol: config.backfill1mCandles,
        candles1m: backfilledCandles1m,
        candles5m: backfilledCandles5m,
        candles1h: backfilledCandles1h,
        candles4h: backfilledCandles4h,
        candles12h: backfilledCandles12h,
        candles1d: backfilledCandles1d,
        candles1w: backfilledCandles1w,
        bySymbol: backfillBySymbol,
      },
      subscribed: subscriptions,
    };
  } finally {
    bootstrapInFlight = false;
  }
});

app.post("/stop", async () => {
  await stopIngestionSession();
  return {
    stopped: true,
    connected: twsClient.isConnected(),
    bootstrapped: activeSubscriptions.length > 0,
    lastBootstrapAt,
  };
});

async function main(): Promise<void> {
  await repo.init();

  const address = await app.listen({
    port: config.ingestionPort,
    host: "0.0.0.0",
  });
  app.log.info(`ingestion service listening on ${address}`);
  app.log.info(
    "call POST /bootstrap once TWS/IB Gateway socket session is ready",
  );
  if (config.watchlistInstruments.length > 100) {
    app.log.warn(
      { size: config.watchlistInstruments.length },
      "watchlist exceeds default IBKR 100 market data lines; trim symbols or shard subscriptions",
    );
  }
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    try {
      await stopIngestionSession();
      await pg.end();
      await redis.quit();
      await app.close();
    } finally {
      process.exit(0);
    }
  });
}
