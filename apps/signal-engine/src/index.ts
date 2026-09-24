import { HttpWseStrategyMetadataReader } from "./runtime/trading-loop/wse-metadata-reader.js";
import Fastify from "fastify";
import { unavailableLegacySignalRoutes } from "./runtime/legacy-signal-routes.js";
import { Pool } from "pg";
import { Redis } from "ioredis";
import { z } from "zod";
import { buildConfiguredInstrumentRegistry } from "@ikbr/shared";
import { buildInstrumentBindingAuthority } from "@ikbr/shared";
import { config } from "./config.js";
import { SignalRepository } from "./repository.js";
import { StrategyPortfolioManager } from "./portfolio/strategy-portfolio-manager.js";
import { listStrategyProfiles } from "./strategy-profiles.js";
import { createStrategies } from "./strategies/strategy-registry.js";
import {
  MarketDataRuntime,
  buildRuntimeFreshnessPolicy,
} from "./runtime/runtime.js";
import { PriceContextProvider } from "./runtime/price-provider.js";
import {
  SignalRepositoryContractResolver,
  SignalRepositoryMarketDataReader,
  BindingAwareContractResolver,
} from "./runtime/market-data-reader.js";
import { createRuntimeEngines } from "./runtime/engines.js";
import { runtimeRoutesPlugin } from "./runtime/routes.js";
import { DEFAULT_FRESHNESS_POLICY } from "@ikbr/shared";
import { ExecutionRuntime } from "./runtime/execution/execution-runtime.js";
import { HttpExecutionTicketSubmitter } from "./runtime/execution/submitter.js";
import { HttpReadyProbe } from "./runtime/execution/ready-probe.js";
import { PaperGuard } from "./runtime/execution/paper-guard.js";
import { executionRuntimeRoutesPlugin } from "./runtime/execution/routes.js";
import { HttpTradingExposureReader } from "./runtime/trading-loop/exposure-reader.js";
import { ReconciliationReader } from "./runtime/trading-loop/reconciliation-reader.js";
import { tradingLoopRoutesPlugin } from "./runtime/trading-loop/routes.js";
import { TradingLoopService } from "./runtime/trading-loop/trading-loop-service.js";

const defaultInstrumentRegistry = buildConfiguredInstrumentRegistry(process.env);
const app = Fastify({ logger: { level: config.LOG_LEVEL } });
const pool = new Pool({ connectionString: config.POSTGRES_URL });
const redis = new Redis(config.REDIS_URL);
const repo = new SignalRepository(pool, redis);
/**
 * Populated when EXECUTION_RUNTIME_ENABLED=true. Kept module-scoped so
 * both `main()` (start the scheduler after startup) and the SIGINT /
 * SIGTERM handler (graceful shutdown) can reach it without re-plumbing
 * DI everywhere.
 */
let tradingLoopService: TradingLoopService | null = null;
const strategyToggleSchema = z.object({ enabled: z.boolean() });
const strategies = createStrategies();
app.get("/health", async () => ({ ok: true, signalEventDriven: false, producer: "bound_runtime" }));
await app.register(unavailableLegacySignalRoutes);

app.get("/signals/recent", async (request) => {
  const query = (request.query ?? {}) as { limit?: string };
  const limit = Number(query.limit ?? 50);
  return repo.getRecentSignals(
    Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50,
  );
});

app.post("/signals/outcomes/refresh", async (request) => {
  const body = (request.body ?? {}) as { limit?: number };
  const limit = Number.isFinite(Number(body.limit))
    ? Math.min(Math.max(Number(body.limit), 1), 2000)
    : 500;
  const inserted = await repo.refreshSignalOutcomes(limit);
  return { inserted };
});

app.get("/signals/outcomes/summary", async (request) => {
  const query = (request.query ?? {}) as { limit?: string };
  const limit = Number(query.limit ?? 20);
  await repo.refreshSignalOutcomes(500);
  return repo.getSignalOutcomeSummary(
    Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
  );
});

app.get("/signals/report", async (request) => {
  const query = (request.query ?? {}) as { limit?: string };
  const limit = Number(query.limit ?? 300);
  const profiles = listStrategyProfiles();
  const strategyIds = profiles.map((profile) => profile.id);
  await repo.refreshSignalOutcomes(500);
  await repo.syncStrategyRuntimeStates(
    strategyIds,
    config.SIGNAL_STRATEGY_COOLDOWN_MS,
  );
  return repo.getSignalReport(
    Number.isFinite(limit) ? Math.min(Math.max(limit, 20), 2000) : 300,
    strategyIds,
  );
});

app.get("/signals/strategies", async () => {
  const profiles = listStrategyProfiles();
  await repo.syncStrategyRuntimeStates(
    profiles.map((profile) => profile.id),
    config.SIGNAL_STRATEGY_COOLDOWN_MS,
  );

  const strategies = await Promise.all(
    profiles.map(async (profile) => ({
      ...profile,
      runtime: await repo.getStrategyRuntimeState(profile.id),
    })),
  );

  return { strategies };
});

app.post("/signals/strategies/:strategyId", async (request, reply) => {
  const params = request.params as { strategyId?: string };
  const strategyId = params.strategyId?.trim();
  const profiles = listStrategyProfiles();

  if (!strategyId || !profiles.some((profile) => profile.id === strategyId)) {
    reply.status(404);
    return { error: "strategy_not_found" };
  }

  const parsed = strategyToggleSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    reply.status(400);
    return { error: "invalid_body", issues: parsed.error.issues };
  }

  const runtime = await repo.setStrategyManualEnabled(
    strategyId,
    parsed.data.enabled,
  );
  return { strategyId, runtime };
});

// ---------------------------------------------------------------------------
// PR12 — Market Data Runtime (dry-run only). Isolated from the legacy
// signal pipeline above: uses the shared engines and reads market state
// through a dedicated reader; NEVER submits orders, NEVER writes to
// proposed_orders, NEVER calls execution-engine. See
// docs/architecture/MARKET_DATA_RUNTIME.md.
// ---------------------------------------------------------------------------
if (config.runtimeEnabled) {
  // PR15.2 — build the shared instrument-binding authority
  // ONCE at startup. The trading loop rejects every instrument
  // without a binding; the wrapped resolver returns the exact
  // operator-selected `conId` for market-data reads. The raw
  // config value is NEVER logged (only counts + ids).
  const bindingResult = buildInstrumentBindingAuthority(
    config.INSTRUMENT_BINDINGS_JSON,
    defaultInstrumentRegistry,
  );
  if (!bindingResult.ok) {
    const summary = bindingResult.errors
      .slice(0, 5)
      .map(
        (e) =>
          `#${e.index}${e.instrumentId ? ` (${e.instrumentId})` : ""}: ${e.message}`,
      )
      .join("; ");
    throw new Error(
      `INSTRUMENT_BINDINGS_JSON is invalid — refusing to start. ${summary}` +
        (bindingResult.errors.length > 5
          ? ` (+${bindingResult.errors.length - 5} more)`
          : ""),
    );
  }
  const bindingAuthority = bindingResult.authority;
  app.log.info(
    {
      component: "instrument-bindings",
      boundCount: bindingAuthority.toDiagnostics().boundCount,
      ids: bindingAuthority.toDiagnostics().ids,
    },
    "instrument bindings loaded",
  );

  const baseResolver = new SignalRepositoryContractResolver({
    repo,
    cacheTtlMs: config.instrumentContractCacheTtlMs,
  });
  const resolver = new BindingAwareContractResolver({
    resolveBound: (id) => bindingAuthority.getBoundInstrument(id),
    inner: baseResolver,
  });
  const reader = new SignalRepositoryMarketDataReader({ repo, resolver });
  const priceProvider = new PriceContextProvider({
    reader,
    freshnessTtlMs: config.marketContextMaxTickAgeMs,
  });
  const { pipeline } = createRuntimeEngines({
    registry: defaultInstrumentRegistry,
  });
  const marketDataRuntime = new MarketDataRuntime({
    registry: defaultInstrumentRegistry,
    providers: [priceProvider],
    pipeline,
    freshnessPolicy: buildRuntimeFreshnessPolicy({
      base: DEFAULT_FRESHNESS_POLICY,
      maxTickAgeMs: config.marketContextMaxTickAgeMs,
    }),
  });
  await app.register(runtimeRoutesPlugin, {
    runtime: marketDataRuntime,
    readinessDeps: { redis, postgres: pool },
  });
  app.log.info("runtime: /runtime/* endpoints registered (dry-run only)");

  // -------------------------------------------------------------------------
  // PR13 — Execution Runtime (paper-only write endpoint). Registered ONLY
  // when EXECUTION_RUNTIME_ENABLED=true. Off by default. Live is impossible
  // via env alone: EXECUTION_RUNTIME_EXPECTED_ENVIRONMENT is a schema
  // literal AND every submission verifies execution-engine's /ready reports
  // environment="paper". See docs/architecture/EXECUTION_RUNTIME.md.
  // -------------------------------------------------------------------------
  if (config.executionRuntime.enabled) {
    const engineUrl = config.executionRuntime.engineUrl;
    const bearerToken = config.EXECUTION_API_TOKEN ?? "";
    if (!bearerToken) {
      app.log.warn(
        "execution-runtime: EXECUTION_API_TOKEN is empty; POST /runtime/execute will deny every request",
      );
    }
    const readyProbe = new HttpReadyProbe({
      engineUrl,
      bearerToken,
      requestTimeoutMs: config.executionRuntime.requestTimeoutMs,
    });
    const paperGuard = new PaperGuard({
      probe: readyProbe,
      expectedEnvironment: config.executionRuntime.expectedEnvironment,
    });
    const submitter = new HttpExecutionTicketSubmitter({
      engineUrl,
      bearerToken,
      requestTimeoutMs: config.executionRuntime.requestTimeoutMs,
    });
    const executionRuntime = new ExecutionRuntime({
      dryRun: marketDataRuntime,
      paperGuard,
      submitter,
      // PR15.2 hostile-review fix — /runtime/execute goes
      // through the same authoritative binding gate as the
      // trading loop. Unbound instruments fail-closed BEFORE
      // any market-data read or submission.
      bindingAuthority,
    });
    await app.register(executionRuntimeRoutesPlugin, {
      runtime: executionRuntime,
      bearerToken,
      readinessDeps: { redis, postgres: pool, paperGuard },
    });
    app.log.info(
      "execution-runtime: /runtime/execute registered (paper-only, bearer-protected)",
    );

    // -------------------------------------------------------------------
    // PR14 — Trading Loop scheduler. Uses the same ExecutionRuntime and
    // PaperGuard as the write endpoint; contained in this branch so the
    // loop can never run without ExecutionRuntime being wired.
    // -------------------------------------------------------------------
    const exposureReader = new HttpTradingExposureReader({
      engineUrl,
      bearerToken,
      requestTimeoutMs: config.tradingLoop.exposureTimeoutMs,
    });
    // PR15 — fail-closed reconciliation pre-check.
    const reconciliationReader = new ReconciliationReader({
      baseUrl: engineUrl,
      bearerToken,
      timeoutMs: config.tradingLoop.exposureTimeoutMs,
    });
    // PR15.4 — the trading loop owns the strategy attribution.
    // A separate `StrategyPortfolioManager` instance (built from
    // the same `strategies` array as the legacy `SignalEngine`)
    // is threaded in so the loop can drive `.run()` itself. The
    // two managers are not shared.
    const portfolioManagerForLoop = new StrategyPortfolioManager(strategies, {
      onStrategyError: (strategyId, error) => {
        app.log.error(
          { strategyId, err: error },
          "trading-loop: strategy evaluation threw",
        );
      },
    });
    tradingLoopService = new TradingLoopService({
      wseMetadataReader: new HttpWseStrategyMetadataReader({ engineUrl, bearerToken, requestTimeoutMs: config.executionRuntime.requestTimeoutMs }),
      config: config.tradingLoop,
      registry: defaultInstrumentRegistry,
      bindingAuthority,
      marketDataRuntime,
      executionRuntime,
      exposureReader,
      reconciliationReader,
      portfolioManager: portfolioManagerForLoop,
      repo,
      strategyCooldownMs: config.SIGNAL_STRATEGY_COOLDOWN_MS,
      maxMarketStateAgeMs: config.SIGNAL_MAX_MARKET_STATE_AGE_MS,
      logger: app.log,
    });
    await app.register(tradingLoopRoutesPlugin, {
      service: tradingLoopService,
      bearerToken,
      paperGuard,
      readinessDeps: { redis, postgres: pool, exposureReader },
    });
    app.log.info(
      {
        component: "trading-loop",
        enabled: config.tradingLoop.enabled,
        intervalMs: config.tradingLoop.intervalMs,
        maxConcurrentInstruments: config.tradingLoop.maxConcurrentInstruments,
      },
      "trading-loop: routes registered (paper-only, bearer-protected)",
    );
  } else {
    app.log.warn(
      "execution-runtime: EXECUTION_RUNTIME_ENABLED=false — /runtime/execute NOT registered",
    );
  }
} else {
  app.log.warn(
    "runtime: RUNTIME_ENABLED=false — /runtime/* endpoints not registered",
  );
}

async function main(): Promise<void> {
  await repo.init();

  // Initial cleanup of terminal-status proposals beyond retention window.
  if (config.SIGNAL_REJECTED_RETENTION_DAYS > 0) {
    const deleted = await repo.cleanupExpiredProposals(
      config.SIGNAL_REJECTED_RETENTION_DAYS,
    );
    if (deleted > 0) {
      app.log.info(
        `proposed_orders retention: deleted ${deleted} terminal rows older than ${config.SIGNAL_REJECTED_RETENTION_DAYS}d`,
      );
    }
    if (config.SIGNAL_REJECTED_CLEANUP_INTERVAL_MS > 0) {
      setInterval(() => {
        repo
          .cleanupExpiredProposals(config.SIGNAL_REJECTED_RETENTION_DAYS)
          .then((n) => {
            if (n > 0) {
              app.log.info(
                `proposed_orders retention: deleted ${n} terminal rows`,
              );
            }
          })
          .catch((err) => {
            app.log.error({ err }, "proposed_orders retention cleanup failed");
          });
      }, config.SIGNAL_REJECTED_CLEANUP_INTERVAL_MS).unref();
    }
  }

  const address = await app.listen({
    port: config.SIGNAL_PORT,
    host: "0.0.0.0",
  });
  app.log.info(`signal-engine listening on ${address}`);

  // Start the trading-loop scheduler AFTER the server accepts
  // connections so the status endpoint can respond to health
  // probes during the startup-delay window. `start()` is a no-op
  // when TRADING_LOOP_ENABLED=false.
  if (tradingLoopService !== null) {
    tradingLoopService.start();
  }

  app.log.info("legacy signal callbacks disabled; verified bound trading runtime is required");
}

main().catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    try {
      // Stop the loop FIRST so no new instrument runs start while
      // the HTTP server is closing. `stop()` is idempotent and
      // bounded by TRADING_LOOP_SHUTDOWN_TIMEOUT_MS.
      if (tradingLoopService !== null) {
        await tradingLoopService.stop();
      }
      await app.close();
      await redis.quit();
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}
