import { fixtureSessionSchedule, fixtureSessionCandles } from '../strategy/session-native.fixture.js';
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Fastify from "fastify";

import type {
  BoundInstrument,
  Candle,
  CandleTimeframe,
  ExecutionTicket,
  ExecutionTicketPolicy,
  Instrument,
  InstrumentBindingAuthority,
  InstrumentContract,
  InstrumentRegistry,
  MarketContextSnapshot,
  SignalAttributionContext,
  TradingPipelineResult,
} from "@ikbr/shared";
import type { FastifyBaseLogger } from "fastify";

import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { PaperGuard } from "../execution/paper-guard.js";
import type { ReadyProbe } from "../execution/paper-guard.js";
import type { DryRunResult, MarketDataRuntime } from "../runtime.js";
import type {
  ExecuteInput,
  ExecutionRuntime,
  ExecutionRuntimeOutcome,
} from "../execution/execution-runtime.js";

import { buildTradingLoopConfig, tradingLoopSchema } from "./config.js";
import { tradingLoopRoutesPlugin } from "./routes.js";
import { TradingLoopService } from "./trading-loop-service.js";
import type { StrategyRuntimeStateRepository } from "./trading-loop-service.js";
import type { TradingExposureReader } from "./types.js";
import { StrategyPortfolioManager } from "../../portfolio/strategy-portfolio-manager.js";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "../../strategies/strategy.types.js";

const AAPL_CONID = 265598;
const NOW_ISO = "2026-07-14T12:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();
const CLOCK = () => new Date(NOW_MS);

function makeAAPLBound(inst: Instrument): BoundInstrument {
  return {
    instrumentId: inst.id,
    instrument: inst,
    broker: "ibkr",
    brokerSymbol: inst.brokerSymbol,
    conId: AAPL_CONID,
    localSymbol: inst.brokerSymbol,
    tradingClass: "NMS",
    exchange: inst.exchange,
    currency: inst.currency,
    minTick: 0.01,
  };
}

function makeBindingAuthority(
  bounds: readonly BoundInstrument[],
): InstrumentBindingAuthority {
  const byId = new Map(bounds.map((b) => [b.instrumentId, b]));
  const byConId = new Map(bounds.map((b) => [b.conId, b]));
  const ids = [...byId.keys()].sort();
  return {
    getBoundInstrument: (id: string) => byId.get(id),
    getBoundInstrumentByConId: (c: number) => byConId.get(c),
    hasBinding: (id: string) => byId.has(id),
    listBoundInstrumentIds: () => ids,
    listBoundInstruments: () => Object.freeze([...bounds]),
    toDiagnostics: () => ({ boundCount: bounds.length, ids }),
  } as unknown as InstrumentBindingAuthority;
}

function makeRealLoaderRepo(
  bound: BoundInstrument,
): StrategyRuntimeStateRepository {
  const candles: Partial<Record<CandleTimeframe, Candle[]>> = fixtureSessionCandles(bound, new Date(NOW_MS));
  const contract: InstrumentContract = {
    symbol: bound.brokerSymbol,
    conid: String(bound.conId),
    secType: "STK",
    exchange: bound.exchange,
    primaryExchange: bound.exchange,
    currency: bound.currency,
    localSymbol: bound.localSymbol,
    tradingClass: bound.tradingClass,
    source: "ibkr",
  };
  const marketState = {
    conid: String(bound.conId),
    symbol: bound.brokerSymbol,
    lastPrice: 150.25,
    bid: 150.24,
    ask: 150.26,
    spread: 0.02,
    ts: new Date(NOW_MS - 1_000).toISOString(),
  };
  return {
    getSessionScheduleEvidence: async (identity: import("@ikbr/shared").InstrumentSessionIdentity) => fixtureSessionSchedule(identity, new Date(NOW_MS)),
    async syncStrategyRuntimeStates() {
      return;
    },
    async getStrategyRuntimeState() {
      return { enabled: true, permanentlyDisabled: false };
    },
    async getInstrumentContractByConId() {
      return contract;
    },
    async getRecentCandlesForContract(_s, _c, tf) {
      return candles[tf];
    },
    async getMarketState() {
      return marketState;
    },
  } as StrategyRuntimeStateRepository;
}

function makeRealStrategy(id: string): Strategy {
  return {
    id,
    secTypes: ["STK"],
    supportedDirections: ["LONG"],
    allowedDirectionalRegimes: [
      "bull_trend",
      "bear_trend",
      "range",
    ] as Strategy["allowedDirectionalRegimes"],
    allowedVolatilityRegimes: [
      "normal_volatility",
      "high_volatility",
      "low_volatility",
    ] as Strategy["allowedVolatilityRegimes"],
    requiredTimeframes: ["1m"],
    generateSignal: (context: StrategyContext): StrategySignal => ({
      strategyId: id,
      symbol: context.symbol,
      side: "BUY",
      direction: "LONG",
      confidenceScore: 0.7,
      entryReason: "test",
      stopLoss: 99,
      takeProfit: 105,
    }),
  } as Strategy;
}

function makeRealPortfolio(): StrategyPortfolioManager {
  return new StrategyPortfolioManager([makeRealStrategy("test_strategy_v1")]);
}

const FAKE_STRATEGY: Strategy = {
  id: "test_strategy_v1",
  secTypes: ["STK"],
  supportedDirections: ["LONG"],
  allowedDirectionalRegimes: [
    "bull_trend",
    "bear_trend",
    "range",
    "sideways",
  ] as unknown as Strategy["allowedDirectionalRegimes"],
  allowedVolatilityRegimes: [
    "normal_volatility",
    "high_volatility",
    "low_volatility",
  ] as unknown as Strategy["allowedVolatilityRegimes"],
  requiredTimeframes: ["1m"],
  generateSignal: () => null,
};

function makeFakePortfolioManager(): StrategyPortfolioManager {
  return new StrategyPortfolioManager([FAKE_STRATEGY]);
}

function makeFakeRepo(): StrategyRuntimeStateRepository {
  return {
    getSessionScheduleEvidence: async (identity: import("@ikbr/shared").InstrumentSessionIdentity) => fixtureSessionSchedule(identity, new Date(NOW_MS)),
    async syncStrategyRuntimeStates() {
      return;
    },
    async getStrategyRuntimeState() {
      return { enabled: true, permanentlyDisabled: false };
    },
    async getInstrumentContractByConId() {
      return null;
    },
    async getRecentCandlesForContract() {
      return [];
    },
    async getMarketState() {
      return null;
    },
  } as StrategyRuntimeStateRepository;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function instrument(id: string): Instrument {
  return {
    id,
    displayName: id,
    assetClass: "stock",
    broker: "ibkr",
    brokerSymbol: id.toUpperCase(),
    exchange: "NASDAQ",
    currency: "USD",
    trading: {
      executionEnabled: true,
      signalGenerationEnabled: true,
      monitoringEnabled: true,
      aiAnalysisEnabled: false,
    },
    risk: {
      maxQuantity: 10,
      quantityUnit: "shares",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.1,
      maxSlippage: 0.1,
    },
    session: {
      useRegularTradingHours: true,
      timezone: "America/New_York",
      sessionTemplate: "us_stock_rth",
    },
    metadata: { tags: [] },
    executionPolicy: {
      strategyId: "test_strategy_v1",
      timeframe: "1m",
      quantity: 10,
      maxQuantity: 100,
      quantityUnit: "shares",
      allowedOrderTypes: ["LMT", "STP"],
      defaultOrderType: "LMT",
      timeInForce: "DAY",
      outsideRth: false,
      transmit: true,
      priceTickSize: 0.01,
      priceRoundingMode: "nearest",
      expectedDirection: "LONG",
    },
  } as Instrument;
}

function registry(ids: readonly string[]): InstrumentRegistry {
  const list = ids.map(instrument);
  const byId = new Map(list.map((i) => [i.id, i]));
  return {
    getInstrument: (id: string) => byId.get(id),
    getInstrumentOrThrow: (id: string) => {
      const i = byId.get(id);
      if (!i) throw new Error(`missing ${id}`);
      return i;
    },
    getByBrokerSymbol: () => [],
    getByBrokerContract: () => undefined,
    listAll: () => list,
    listExecutionEnabled: () => list.filter((i) => i.trading.executionEnabled),
    listSignalEnabled: () =>
      list.filter((i) => i.trading.signalGenerationEnabled),
    listMonitoringEnabled: () =>
      list.filter((i) => i.trading.monitoringEnabled),
    listAiEnabled: () => list.filter((i) => i.trading.aiAnalysisEnabled),
  } as unknown as InstrumentRegistry;
}

function makeSnapshot(iso: string): MarketContextSnapshot {
  const observedAt = new Date(iso);
  return {
    instrumentId: "aapl",
    generatedAt: observedAt,
    validUntil: new Date(observedAt.getTime() + 60_000),
    overallStatus: "fresh",
    warnings: [],
    sections: {
      instrument: {
        status: "fresh",
        observedAt,
        source: "t",
        data: null,
        warnings: [],
      },
      price: {
        status: "fresh",
        observedAt,
        source: "t",
        data: { last: 100 },
        warnings: [],
      },
      technical: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      macro: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      crossAsset: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      positioning: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      flows: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      inventory: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      calendar: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      news: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
      brokerState: {
        status: "unavailable",
        observedAt: null,
        source: null,
        data: null,
        warnings: [],
      },
    },
  } as unknown as MarketContextSnapshot;
}

const SUCCESS_TICKET: ExecutionTicket = {
  ticketId: "tix-1",
  createdAt: new Date("2026-07-14T12:00:00.000Z"),
  signalId: "sig-1",
  decisionId: "dec-1",
  instrumentId: "aapl",
  broker: "ibkr",
  brokerSymbol: "AAPL",
  exchange: "NASDAQ",
  currency: "USD",
  order: {
    side: "BUY",
    quantity: 10,
    quantityUnit: "shares",
    orderType: "LMT",
    limitPrice: 100.5,
    timeInForce: "DAY",
    outsideRth: false,
    transmit: true,
  },
  protection: { bracketEnabled: false },
  metadata: {
    signalEngineVersion: "x",
    decisionEngineVersion: "x",
    riskEngineVersion: "x",
    builderVersion: "x",
    correlationId: "corr-x",
  },
} as ExecutionTicket;

const EXPECTED_INTENT_KEY = `loop:v4:aapl:test_strategy_v1:evaluation.1m.1784030400000`;

const SUCCESS_PIPELINE = {
  outcome: "SUCCESS",
  signal: {
    id: "sig-1",
    instrumentId: "aapl",
    // PR15.3 hostile-review Finding 2 — the strict fail-closed
    // check requires the pipeline to advertise the strategy that
    // produced the intent. Match the fixture instrument's
    // executionPolicy.strategyId (`test_strategy_v1`).
    decision: { action: "LONG" },
    metadata: {
      engineVersions: {},
      evaluationTimeMs: 0,
      strategyId: "test_strategy_v1",
    },
  },
  ticket: SUCCESS_TICKET,
  warnings: [],
  durationMs: 1,
  metadata: { engineVersions: {}, ranAt: new Date() },
} as unknown as TradingPipelineResult;

const NO_TRADE_PIPELINE = {
  outcome: "NO_TRADE",
  signal: {
    id: "sig-1",
    instrumentId: "aapl",
    metadata: { engineVersions: {}, evaluationTimeMs: 0 },
  },
  ticket: null,
  reason: "HOLD",
  warnings: [],
  durationMs: 1,
  metadata: { engineVersions: {}, ranAt: new Date() },
} as unknown as TradingPipelineResult;

const SUBMITTED_OUTCOME: ExecutionRuntimeOutcome = {
  outcome: "SUBMITTED",
  pipeline: SUCCESS_PIPELINE,
  execution: {
    orderId: 1,
    accountId: "PAPER-1",
    brokerOrderId: "b-1",
    status: "SUBMITTED",
  },
  idempotencyKey: "echo",
} as unknown as ExecutionRuntimeOutcome;

function paperOkGuard(): PaperGuard {
  const probe: ReadyProbe = {
    async probeReady() {
      return {
        kind: "ok",
        ready: true,
        environment: "paper",
        accountMatchesEnvironment: true,
        // PR15.3 Finding 1 — kill-switch cross-check must pass in
        // the "paper OK" fixture.
        tradingEnabled: true,
      };
    },
  };
  return new PaperGuard({ probe, expectedEnvironment: "paper" });
}

function paperFailGuard(reason: string): PaperGuard {
  const probe: ReadyProbe = {
    async probeReady() {
      return { kind: "error", message: reason };
    },
  };
  return new PaperGuard({ probe, expectedEnvironment: "paper" });
}

function makeMarketDataRuntime(
  pipeline: TradingPipelineResult,
): MarketDataRuntime {
  return {
    async dryRun(
      instrumentId: string,
      _policy: ExecutionTicketPolicy,
      attribution?: SignalAttributionContext,
    ): Promise<DryRunResult> {
      void _policy;
      // PR15.4 — mirror attribution into the fake pipeline signal
      // so the loop's post-pipeline defence-in-depth accepts it.
      let effective = pipeline;
      if (effective.outcome === "SUCCESS" && attribution && effective.signal) {
        effective = {
          ...effective,
          signal: {
            ...effective.signal,
            metadata: {
              ...effective.signal.metadata,
              strategyId: attribution.strategyId,
            },
            decision: { action: attribution.intendedAction },
          },
        } as unknown as TradingPipelineResult;
      }
      return {
        instrumentId,
        snapshot: makeSnapshot("2026-07-14T12:00:00.000Z"),
        pipeline: effective,
      };
    },
  } as unknown as MarketDataRuntime;
}

function makeExecutionRuntime(
  outcome: ExecutionRuntimeOutcome,
): ExecutionRuntime {
  return {
    async execute(_i: ExecuteInput) {
      throw new Error("route path must not call execute()");
    },
    async executePrepared() {
      return outcome;
    },
  } as unknown as ExecutionRuntime;
}

function clearReader(): TradingExposureReader {
  return {
    async readExposure() {
      return {
        hasOpenPosition: false,
        hasActiveOrder: false,
        hasAmbiguousSubmission: false,
        hasPendingProposal: false,
      };
    },
    async probeReady() {
      return { ok: true };
    },
  };
}

function silentLogger(): FastifyBaseLogger {
  const noop = () => undefined;
  const l = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => l,
    silent: () => {},
    level: "info",
    bindings: () => ({}),
    isLevelEnabled: () => true,
  };
  return l as unknown as FastifyBaseLogger;
}

function okReadinessDeps() {
  return {
    redis: { async ping() {} },
    postgres: { async query() {} },
    exposureReader: clearReader(),
  };
}

async function buildApp(opts: {
  bearerToken?: string;
  runtimeOutcome?: ExecutionRuntimeOutcome;
  pipeline?: TradingPipelineResult;
  paperGuard?: PaperGuard;
  configOverrides?: Record<string, string>;
  readinessDeps?: ReturnType<typeof okReadinessDeps>;
  exposureReader?: TradingExposureReader;
}) {
  const app = Fastify({ logger: false });
  const reg = registry(["aapl"]);
  const aaplInst = reg.getInstrumentOrThrow("aapl");
  const bound = makeAAPLBound(aaplInst);
  const marketDataRuntime = makeMarketDataRuntime(
    opts.pipeline ?? SUCCESS_PIPELINE,
  );
  const executionRuntime = makeExecutionRuntime(
    opts.runtimeOutcome ?? SUBMITTED_OUTCOME,
  );
  const exposureReader = opts.exposureReader ?? clearReader();
  const svc = new TradingLoopService({
    config: buildTradingLoopConfig({
      env: tradingLoopSchema.parse(opts.configOverrides ?? {}),
    }),
    registry: reg,
    bindingAuthority: makeBindingAuthority([bound]),
    marketDataRuntime,
    executionRuntime,
    exposureReader,
    portfolioManager: makeRealPortfolio(),
    repo: makeRealLoaderRepo(bound),
    strategyCooldownMs: 0,
    maxMarketStateAgeMs: 0,
    logger: silentLogger(),
    clock: CLOCK,
  });
  const readiness = opts.readinessDeps ?? {
    redis: { async ping() {} },
    postgres: { async query() {} },
    exposureReader,
  };
  await app.register(tradingLoopRoutesPlugin, {
    service: svc,
    bearerToken: opts.bearerToken ?? "test-token",
    paperGuard: opts.paperGuard ?? paperOkGuard(),
    readinessDeps: readiness,
  });
  await app.ready();
  return { app, svc };
}

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

describe("GET /runtime/trading-loop/status", () => {
  it("returns disabled state with empty history before any run", async () => {
    const { app } = await buildApp({});
    const res = await app.inject({
      method: "GET",
      url: "/runtime/trading-loop/status",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      enabled: boolean;
      running: boolean;
      lastOutcomes: Record<string, unknown>;
      cycleCount: number;
    };
    assert.equal(body.enabled, false);
    assert.equal(body.running, false);
    assert.deepEqual(body.lastOutcomes, {});
    assert.equal(body.cycleCount, 0);
    await app.close();
  });

  it("reports the most recent outcome after runOnce", async () => {
    const { app, svc } = await buildApp({});
    await svc.runOnce();
    const res = await app.inject({
      method: "GET",
      url: "/runtime/trading-loop/status",
    });
    const body = res.json() as {
      lastOutcomes: Record<
        string,
        { outcome: { kind: string; idempotencyKey?: string } }
      >;
      cycleCount: number;
    };
    assert.equal(body.cycleCount, 1);
    assert.equal(body.lastOutcomes["aapl"].outcome.kind, "SUBMITTED");
    // The v3 idempotency key is anchored to the ticket's clientOrderHash.
    assert.equal(
      body.lastOutcomes["aapl"].outcome.idempotencyKey,
      EXPECTED_INTENT_KEY,
    );
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// /ready — composite
// ---------------------------------------------------------------------------

describe("GET /runtime/trading-loop/ready", () => {
  it("disabled loop → 200 ready:true, no upstream probes fire", async () => {
    let redisPinged = false;
    let pgQueried = false;
    let exposureProbed = false;
    const readiness = {
      redis: {
        async ping() {
          redisPinged = true;
        },
      },
      postgres: {
        async query() {
          pgQueried = true;
        },
      },
      exposureReader: {
        async readExposure() {
          return {
            hasOpenPosition: false,
            hasActiveOrder: false,
            hasAmbiguousSubmission: false,
            hasPendingProposal: false,
          };
        },
        async probeReady() {
          exposureProbed = true;
          return { ok: true as const };
        },
      },
    };
    const { app } = await buildApp({ readinessDeps: readiness });
    const res = await app.inject({
      method: "GET",
      url: "/runtime/trading-loop/ready",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ready: boolean; enabled: boolean };
    assert.equal(body.ready, true);
    assert.equal(body.enabled, false);
    // Disabled loop must not probe upstreams — protects the /ready
    // endpoint from cascading failures when the loop is off.
    assert.equal(redisPinged, false);
    assert.equal(pgQueried, false);
    assert.equal(exposureProbed, false);
    await app.close();
  });

  it("enabled loop + all checks pass → 200 ready:true", async () => {
    const { app } = await buildApp({
      configOverrides: { TRADING_LOOP_ENABLED: "true" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/runtime/trading-loop/ready",
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ready: boolean;
      checks: {
        paperGuard: { ok: boolean };
        exposureReader: { ok: boolean };
        redis: { ok: boolean };
        postgres: { ok: boolean };
      };
    };
    assert.equal(body.ready, true);
    assert.equal(body.checks.paperGuard.ok, true);
    assert.equal(body.checks.exposureReader.ok, true);
    assert.equal(body.checks.redis.ok, true);
    assert.equal(body.checks.postgres.ok, true);
    await app.close();
  });

  it("enabled loop + paper guard failing → 503", async () => {
    const { app } = await buildApp({
      configOverrides: { TRADING_LOOP_ENABLED: "true" },
      paperGuard: paperFailGuard("env=live"),
    });
    const res = await app.inject({
      method: "GET",
      url: "/runtime/trading-loop/ready",
    });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { ready: boolean };
    assert.equal(body.ready, false);
    await app.close();
  });

  it("enabled loop + exposure reader down → 503", async () => {
    const { app } = await buildApp({
      configOverrides: { TRADING_LOOP_ENABLED: "true" },
      readinessDeps: {
        redis: { async ping() {} },
        postgres: { async query() {} },
        exposureReader: {
          async readExposure() {
            throw new Error("unreachable in this test");
          },
          async probeReady() {
            return { ok: false as const, message: "http_error: 500" };
          },
        },
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/runtime/trading-loop/ready",
    });
    assert.equal(res.statusCode, 503);
    const body = res.json() as {
      ready: boolean;
      checks: { exposureReader: { ok: boolean; error?: string } };
    };
    assert.equal(body.ready, false);
    assert.equal(body.checks.exposureReader.ok, false);
    assert.match(body.checks.exposureReader.error ?? "", /http_error/);
    await app.close();
  });

  it("enabled loop + Redis down → 503", async () => {
    const { app } = await buildApp({
      configOverrides: { TRADING_LOOP_ENABLED: "true" },
      readinessDeps: {
        redis: {
          async ping() {
            throw new Error("redis-refused");
          },
        },
        postgres: { async query() {} },
        exposureReader: clearReader(),
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/runtime/trading-loop/ready",
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// /run-once
// ---------------------------------------------------------------------------

describe("POST /runtime/trading-loop/run-once", () => {
  it("without Bearer token → 401", async () => {
    const { app } = await buildApp({});
    const res = await app.inject({
      method: "POST",
      url: "/runtime/trading-loop/run-once",
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it("paper guard rejects → 503 PAPER_GUARD_FAILED, no cycle runs", async () => {
    const { app, svc } = await buildApp({
      paperGuard: paperFailGuard("env=live"),
    });
    const before = svc.status().cycleCount;
    const res = await app.inject({
      method: "POST",
      url: "/runtime/trading-loop/run-once",
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(res.statusCode, 503);
    const body = res.json() as { outcome: string; message: string };
    assert.equal(body.outcome, "PAPER_GUARD_FAILED");
    assert.match(body.message, /env=live/);
    assert.equal(svc.status().cycleCount, before);
    await app.close();
  });

  it("happy path → 200 with cycle report + one SUBMITTED", async () => {
    const { app } = await buildApp({});
    const res = await app.inject({
      method: "POST",
      url: "/runtime/trading-loop/run-once",
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      reports: Array<{
        instrumentId: string;
        outcome: { kind: string; idempotencyKey?: string };
      }>;
    };
    assert.equal(body.reports.length, 1);
    assert.equal(body.reports[0].outcome.kind, "SUBMITTED");
    assert.equal(body.reports[0].outcome.idempotencyKey, EXPECTED_INTENT_KEY);
    await app.close();
  });

  it("NO_TRADE outcome propagates as NOT_SUBMITTED with reason NO_TRADE", async () => {
    const { app } = await buildApp({ pipeline: NO_TRADE_PIPELINE });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/trading-loop/run-once",
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      reports: Array<{ outcome: { kind: string; reason?: string } }>;
    };
    assert.equal(body.reports[0].outcome.kind, "NOT_SUBMITTED");
    assert.equal(body.reports[0].outcome.reason, "NO_TRADE");
    await app.close();
  });

  it("orphan PROPOSED → EXPOSURE_BLOCKED, executePrepared never called", async () => {
    const { app } = await buildApp({
      exposureReader: {
        async readExposure() {
          return {
            hasOpenPosition: false,
            hasActiveOrder: false,
            hasAmbiguousSubmission: false,
            hasPendingProposal: true,
          };
        },
        async probeReady() {
          return { ok: true };
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/runtime/trading-loop/run-once",
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      reports: Array<{
        outcome: { kind: string; reason?: string; message?: string };
      }>;
    };
    assert.equal(body.reports[0].outcome.kind, "SKIPPED");
    assert.equal(body.reports[0].outcome.reason, "EXPOSURE_BLOCKED");
    assert.match(body.reports[0].outcome.message ?? "", /pendingProposal/);
    await app.close();
  });
});
