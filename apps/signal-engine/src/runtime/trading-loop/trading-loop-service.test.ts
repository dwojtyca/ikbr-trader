import type { WseStrategyMetadataReader } from "./wse-metadata-reader.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  BoundInstrument,
  Candle,
  CandleTimeframe,
  ExecutionTicket,
  ExecutionTicketPolicy,
  Instrument,
  InstrumentBindingAuthority,
  InstrumentContract,
  InstrumentExecutionPolicy,
  InstrumentRegistry,
  MarketContextSnapshot,
  SignalAttributionContext,
  TradingPipelineResult,
} from "@ikbr/shared";
import type { FastifyBaseLogger } from "fastify";

import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import type { DryRunResult, MarketDataRuntime } from "../runtime.js";
import type {
  ExecuteInput,
  ExecutionRuntime,
  ExecutionRuntimeOutcome,
} from "../execution/execution-runtime.js";

import { buildTradingLoopConfig, tradingLoopSchema } from "./config.js";
import {
  TradingLoopService,
  type StrategyRuntimeStateRepository,
  deriveTriggerIdentity,
  resolveInstrumentPolicy,
} from "./trading-loop-service.js";
import type { TradingExposure, TradingExposureReader } from "./types.js";
import { ReconciliationReader } from "./reconciliation-reader.js";
import { StrategyPortfolioManager } from "../../portfolio/strategy-portfolio-manager.js";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "../../strategies/strategy.types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AAPL_POLICY: InstrumentExecutionPolicy = {
  strategyId: "momentum_breakout_long_v1",
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
};

function makeInstrument(
  id: string,
  overrides: {
    executionEnabled?: boolean;
    signalGenerationEnabled?: boolean;
    monitoringEnabled?: boolean;
    riskMaxQuantity?: number;
    executionPolicy?: InstrumentExecutionPolicy | null;
  } = {},
): Instrument {
  return {
    id,
    displayName: id,
    assetClass: "stock",
    broker: "ibkr",
    brokerSymbol: id.toUpperCase(),
    exchange: "NASDAQ",
    currency: "USD",
    trading: {
      executionEnabled: overrides.executionEnabled ?? true,
      signalGenerationEnabled: overrides.signalGenerationEnabled ?? true,
      monitoringEnabled: overrides.monitoringEnabled ?? true,
      aiAnalysisEnabled: false,
    },
    risk: {
      maxQuantity: overrides.riskMaxQuantity ?? 100,
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
    ...(overrides.executionPolicy === null
      ? {}
      : { executionPolicy: overrides.executionPolicy ?? AAPL_POLICY }),
  } as Instrument;
}

function makeRegistry(instruments: readonly Instrument[]): InstrumentRegistry {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  return {
    getInstrument: (id: string) => byId.get(id),
    getInstrumentOrThrow: (id: string) => {
      const i = byId.get(id);
      if (!i) throw new Error(`missing ${id}`);
      return i;
    },
    getByBrokerSymbol: () => [],
    getByBrokerContract: () => undefined,
    listAll: () => instruments,
    listExecutionEnabled: () =>
      instruments.filter((i) => i.trading.executionEnabled),
    listSignalEnabled: () =>
      instruments.filter((i) => i.trading.signalGenerationEnabled),
    listMonitoringEnabled: () =>
      instruments.filter((i) => i.trading.monitoringEnabled),
    listAiEnabled: () => [],
  } as unknown as InstrumentRegistry;
}

function makeTicket(
  overrides: Partial<ExecutionTicket["order"]> = {},
): ExecutionTicket {
  return {
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
      ...overrides,
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
}

function makeSnapshot(
  instrumentId: string,
  priceObservedAtIso: string | null,
): MarketContextSnapshot {
  const observedAt = priceObservedAtIso ? new Date(priceObservedAtIso) : null;
  const empty = {
    status: "unavailable" as const,
    observedAt: null,
    source: null,
    data: null,
    warnings: [],
  };
  return {
    instrumentId,
    generatedAt: new Date("2026-07-14T12:00:00.000Z"),
    validUntil: new Date("2026-07-14T12:01:00.000Z"),
    overallStatus: "fresh",
    warnings: [],
    sections: {
      instrument: { ...empty, status: "fresh", observedAt },
      price: {
        status: observedAt ? "fresh" : "unavailable",
        observedAt,
        source: "test",
        data: observedAt ? { last: 100 } : null,
        warnings: [],
      },
      technical: empty,
      macro: empty,
      crossAsset: empty,
      positioning: empty,
      flows: empty,
      inventory: empty,
      calendar: empty,
      news: empty,
      brokerState: empty,
    },
  } as unknown as MarketContextSnapshot;
}

const CLEAR_EXPOSURE: TradingExposure = {
  hasOpenPosition: false,
  hasActiveOrder: false,
  hasAmbiguousSubmission: false,
  hasPendingProposal: false,
};

function makeExposureReader(
  behaviour: TradingExposure = CLEAR_EXPOSURE,
): TradingExposureReader {
  return {
    async readExposure() {
      return behaviour;
    },
    async probeReady() {
      return { ok: true };
    },
  };
}

function makeMarketDataRuntime(behaviour: {
  ticket?: ExecutionTicket;
  outcome?: "SUCCESS" | "NO_TRADE" | "FAILURE";
  priceObservedAtIso?: string | null;
  /**
   * PR15.3 Finding 2 — instruments in scope so the fixture can
   * emit the SAME strategyId that the instrument's execution
   * policy declares (simulating a strategy-aware pipeline). If
   * omitted, defaults to `AAPL_POLICY.strategyId`. Never
   * fabricates a strategyId different from the instrument's
   * declared one — that is exactly what the loop's fail-closed
   * check is meant to catch.
   */
  instruments?: readonly Instrument[];
}): MarketDataRuntime & {
  calls: Array<{ instrumentId: string; policy: ExecutionTicketPolicy }>;
} {
  const calls: Array<{ instrumentId: string; policy: ExecutionTicketPolicy }> =
    [];
  const byId = new Map((behaviour.instruments ?? []).map((i) => [i.id, i]));
  return {
    calls,
    async dryRun(
      instrumentId: string,
      policy: ExecutionTicketPolicy,
    ): Promise<DryRunResult> {
      calls.push({ instrumentId, policy });
      const outcome = behaviour.outcome ?? "SUCCESS";
      const snapshot = makeSnapshot(
        instrumentId,
        behaviour.priceObservedAtIso === undefined
          ? "2026-07-14T12:00:00.000Z"
          : behaviour.priceObservedAtIso,
      );
      const pipeline =
        outcome === "SUCCESS"
          ? ({
              outcome: "SUCCESS",
              signal: {
                id: "sig-1",
                instrumentId,
                // PR15.3 hostile-review Finding 2 — the default
                // fixture simulates a strategy-aware pipeline that
                // correctly identifies the winning strategy; the
                // loop's strict fail-closed check now requires it.
                // Tests that want to exercise the "missing" or
                // "mismatched" branch use a dedicated fixture
                // (`makeMismatchedMarketDataRuntime`) instead of
                // relying on this default.
                decision: { action: "LONG" },
                metadata: {
                  engineVersions: {},
                  evaluationTimeMs: 0,
                  strategyId:
                    byId.get(instrumentId)?.executionPolicy?.strategyId ??
                    AAPL_POLICY.strategyId,
                },
              },
              ticket: behaviour.ticket ?? makeTicket(),
              warnings: [],
              durationMs: 1,
              metadata: { engineVersions: {}, ranAt: new Date() },
            } as unknown as DryRunResult["pipeline"])
          : outcome === "NO_TRADE"
            ? ({
                outcome: "NO_TRADE",
                signal: {
                  id: "sig-1",
                  instrumentId,
                  metadata: {
                    engineVersions: {},
                    evaluationTimeMs: 0,
                  },
                },
                ticket: null,
                reason: "HOLD",
                warnings: [],
                durationMs: 1,
                metadata: { engineVersions: {}, ranAt: new Date() },
              } as unknown as DryRunResult["pipeline"])
            : ({
                outcome: "FAILURE",
                signal: null,
                ticket: null,
                blockers: [],
                warnings: [],
                failedStage: "SIGNAL",
                durationMs: 1,
                metadata: { engineVersions: {}, ranAt: new Date() },
              } as unknown as DryRunResult["pipeline"]);
      return { instrumentId, snapshot, pipeline };
    },
  } as unknown as MarketDataRuntime & {
    calls: Array<{ instrumentId: string; policy: ExecutionTicketPolicy }>;
  };
}

const SUBMITTED_OUTCOME: ExecutionRuntimeOutcome = {
  outcome: "SUBMITTED",
  pipeline: {
    outcome: "SUCCESS",
  } as unknown as ExecutionRuntimeOutcome extends {
    pipeline: infer P;
  }
    ? P
    : never,
  execution: {
    orderId: 1,
    accountId: "PAPER-1",
    brokerOrderId: "b-1",
    status: "SUBMITTED",
  },
  idempotencyKey: "runtime-echo",
};

const UNKNOWN_OUTCOME: ExecutionRuntimeOutcome = {
  outcome: "UNKNOWN",
  idempotencyKey: "runtime-echo",
  reason: "timed out after 5000ms",
};

function makeExecutionRuntime(
  behaviour:
    | ExecutionRuntimeOutcome
    | ((input: {
        dryRunResult: DryRunResult;
        idempotencyKey: string;
        clientOrderHash?: string;
      }) => ExecutionRuntimeOutcome | Promise<ExecutionRuntimeOutcome>),
): ExecutionRuntime & {
  preparedCalls: Array<{
    dryRunResult: DryRunResult;
    idempotencyKey: string;
    clientOrderHash?: string;
    bound?: unknown;
  }>;
} {
  const preparedCalls: Array<{
    dryRunResult: DryRunResult;
    idempotencyKey: string;
    clientOrderHash?: string;
    bound?: unknown;
  }> = [];
  return {
    preparedCalls,
    async execute(_input: ExecuteInput) {
      throw new Error("loop must not use execute()");
    },
    async executePrepared(input: {
      dryRunResult: DryRunResult;
      idempotencyKey: string;
      clientOrderHash?: string;
      bound?: unknown;
    }) {
      preparedCalls.push(input);
      return typeof behaviour === "function"
        ? await behaviour(input)
        : behaviour;
    },
  } as unknown as ExecutionRuntime & {
    preparedCalls: Array<{
      dryRunResult: DryRunResult;
      idempotencyKey: string;
      clientOrderHash?: string;
      bound?: unknown;
    }>;
  };
}

function makeLogger(): FastifyBaseLogger {
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

function makeConfig(overrides: Record<string, string> = {}) {
  const env = tradingLoopSchema.parse(overrides);
  return buildTradingLoopConfig({ env });
}

// PR15.4 — minimal fake `StrategyRuntimeStateRepository` shared by
// legacy tests. Individual tests can override behaviour by wrapping
// this and shadowing specific methods.
function makeFakeRepo(
  overrides: Partial<StrategyRuntimeStateRepository> = {},
): StrategyRuntimeStateRepository {
  return {
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
    ...overrides,
  } as StrategyRuntimeStateRepository;
}

// PR15.4 — a stub strategy that never generates a signal.
// Registered so legacy tests get a valid `StrategyPortfolioManager`
// even when they don't exercise the strategy portfolio path.
const FAKE_STRATEGY: Strategy = {
  id: "momentum_breakout_long_v1",
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
  generateSignal: () => null,
};

function makeFakePortfolioManager(
  strategies: readonly Strategy[] = [FAKE_STRATEGY],
): StrategyPortfolioManager {
  return new StrategyPortfolioManager(strategies);
}

// ---------------------------------------------------------------------------
// PR15.4 §14.7 integration infrastructure — real path fixtures
// ---------------------------------------------------------------------------

const AAPL_CONID = 265598;
const NOW_ISO = "2026-07-14T12:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();
const CLOCK = () => new Date(NOW_MS);

function makeBound(
  instrument: Instrument,
  conId = AAPL_CONID,
): BoundInstrument {
  return {
    instrumentId: instrument.id,
    instrument,
    broker: "ibkr",
    brokerSymbol: instrument.brokerSymbol,
    conId,
    localSymbol: instrument.brokerSymbol,
    tradingClass: "NMS",
    exchange: instrument.exchange,
    currency: instrument.currency,
    minTick: 0.01,
  };
}

function makeBindingAuthority(
  bounds: readonly BoundInstrument[],
): InstrumentBindingAuthority {
  const byId = new Map(bounds.map((b) => [b.instrumentId, b]));
  const byConId = new Map(bounds.map((b) => [b.conId, b]));
  const boundIds = [...byId.keys()].sort();
  return {
    getBoundInstrument: (id: string) => byId.get(id),
    getBoundInstrumentByConId: (conId: number) => byConId.get(conId),
    hasBinding: (id: string) => byId.has(id),
    listBoundInstrumentIds: () => boundIds,
    listBoundInstruments: () => Object.freeze([...bounds]),
    toDiagnostics: () => ({ boundCount: bounds.length, ids: boundIds }),
  } as unknown as InstrumentBindingAuthority;
}

function makeContract(
  bound: BoundInstrument,
  overrides: Partial<InstrumentContract> = {},
): InstrumentContract {
  return {
    symbol: bound.brokerSymbol,
    conid: String(bound.conId),
    secType: "STK",
    exchange: bound.exchange,
    primaryExchange: bound.exchange,
    currency: bound.currency,
    localSymbol: bound.localSymbol,
    tradingClass: bound.tradingClass,
    source: "ibkr",
    ...overrides,
  };
}

function makeMarketState(
  bound: BoundInstrument,
  overrides: {
    conid?: string;
    symbol?: string;
    lastPrice?: number;
    bid?: number;
    ask?: number;
    spread?: number;
    ts?: string;
  } = {},
) {
  return {
    conid: overrides.conid ?? String(bound.conId),
    symbol: overrides.symbol ?? bound.brokerSymbol,
    lastPrice: overrides.lastPrice ?? 150.25,
    bid: overrides.bid ?? 150.24,
    ask: overrides.ask ?? 150.26,
    spread: overrides.spread ?? 0.02,
    ts: overrides.ts ?? new Date(NOW_MS - 1_000).toISOString(),
  };
}

const TIMEFRAME_MS: Record<CandleTimeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

function makeCandles(
  bound: BoundInstrument,
  timeframe: CandleTimeframe,
  count: number,
  endTs: number,
): Candle[] {
  const step = TIMEFRAME_MS[timeframe];
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(endTs - (count - 1 - i) * step);
    out.push({
      conid: String(bound.conId),
      symbol: bound.brokerSymbol,
      timeframe,
      ts,
      open: 100 + i * 0.01,
      high: 100 + i * 0.01 + 0.05,
      low: 100 + i * 0.01 - 0.05,
      close: 100 + i * 0.01,
      volume: 1000 + i,
    } as Candle);
  }
  return out;
}

function makeFullCandles(
  bound: BoundInstrument,
): Record<CandleTimeframe, Candle[]> {
  return {
    "1m": makeCandles(bound, "1m", 300, NOW_MS - 60_000),
    "5m": makeCandles(bound, "5m", 60, NOW_MS - 300_000),
    "1h": makeCandles(bound, "1h", 60, NOW_MS - 3_600_000),
    "4h": makeCandles(bound, "4h", 60, NOW_MS - 14_400_000),
    "12h": makeCandles(bound, "12h", 60, NOW_MS - 43_200_000),
    "1d": makeCandles(bound, "1d", 60, NOW_MS - 86_400_000),
    "1w": makeCandles(bound, "1w", 60, NOW_MS - 604_800_000),
  };
}

interface LoaderRepoOverrides {
  contract?: InstrumentContract | null;
  candles?: Partial<Record<CandleTimeframe, Candle[]>>;
  marketState?: ReturnType<typeof makeMarketState> | null;
  runtimeStates?: Record<
    string,
    | { enabled: boolean; permanentlyDisabled: boolean; cooldownUntil?: Date }
    | Error
  >;
  syncBehavior?: () => Promise<void> | void;
}

interface LoaderRepoSpy extends StrategyRuntimeStateRepository {
  candleCalls: Array<{
    symbol: string;
    conId: string;
    timeframe: CandleTimeframe;
    limit: number;
  }>;
  contractCalls: string[];
  marketStateCalls: string[];
  syncCalls: Array<{ strategyIds: readonly string[]; cooldownMs: number }>;
  stateCalls: string[];
}

function makeLoaderRepo(
  bound: BoundInstrument,
  overrides: LoaderRepoOverrides = {},
): LoaderRepoSpy {
  const contract =
    overrides.contract === null
      ? null
      : (overrides.contract ?? makeContract(bound));
  const marketState =
    overrides.marketState === null
      ? null
      : (overrides.marketState ?? makeMarketState(bound));
  const fullCandles = makeFullCandles(bound);
  const candles: Partial<Record<CandleTimeframe, Candle[]>> = {
    ...fullCandles,
    ...(overrides.candles ?? {}),
  };
  const runtimeStates = overrides.runtimeStates ?? {};

  const spy: LoaderRepoSpy = {
    candleCalls: [],
    contractCalls: [],
    marketStateCalls: [],
    syncCalls: [],
    stateCalls: [],
    async syncStrategyRuntimeStates(strategyIds, cooldownMs) {
      spy.syncCalls.push({ strategyIds, cooldownMs });
      if (overrides.syncBehavior) await overrides.syncBehavior();
    },
    async getStrategyRuntimeState(id: string) {
      spy.stateCalls.push(id);
      const s = runtimeStates[id];
      if (s instanceof Error) throw s;
      return s ?? { enabled: true, permanentlyDisabled: false };
    },
    async getInstrumentContractByConId(conId: string) {
      spy.contractCalls.push(conId);
      return contract;
    },
    async getRecentCandlesForContract(
      symbol: string,
      conId: string,
      timeframe: CandleTimeframe,
      limit: number,
    ) {
      spy.candleCalls.push({ symbol, conId, timeframe, limit });
      return candles[timeframe] ?? [];
    },
    async getMarketState(conid: string) {
      spy.marketStateCalls.push(conid);
      return marketState;
    },
  } as LoaderRepoSpy;
  return spy;
}

interface RealStrategyOptions {
  direction?: "LONG" | "SHORT";
  side?: "BUY" | "SELL";
  symbol?: string;
  confidenceScore?: number;
  lanePriority?: number;
  onGenerate?: (context: StrategyContext) => void;
  throwErr?: Error;
  emitNull?: boolean;
  overrideStrategyId?: string;
}

function makeRealStrategy(
  id: string,
  options: RealStrategyOptions = {},
): Strategy {
  const direction = options.direction ?? "LONG";
  const side = options.side ?? (direction === "LONG" ? "BUY" : "SELL");
  return {
    id,
    secTypes: ["STK"],
    supportedDirections: [direction],
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
    ...(options.lanePriority !== undefined
      ? { lanePriority: options.lanePriority }
      : {}),
    generateSignal: (context: StrategyContext) => {
      options.onGenerate?.(context);
      if (options.throwErr) throw options.throwErr;
      if (options.emitNull) return null;
      const signal: StrategySignal = {
        strategyId: options.overrideStrategyId ?? id,
        symbol: options.symbol ?? context.symbol,
        side,
        direction,
        confidenceScore: options.confidenceScore ?? 0.7,
        entryReason: "test-fixture",
        stopLoss: side === "BUY" ? 99 : 101,
        takeProfit: side === "BUY" ? 105 : 95,
      };
      return signal;
    },
  } as Strategy;
}

function makeService(
  overrides: {
    config?: ReturnType<typeof makeConfig>;
    instruments?: readonly Instrument[];
    exposure?: TradingExposure;
    ticket?: ExecutionTicket;
    pipelineOutcome?: "SUCCESS" | "NO_TRADE" | "FAILURE";
    priceObservedAtIso?: string | null;
    runtimeOutcome?:
      | ExecutionRuntimeOutcome
      | ((input: {
          dryRunResult: DryRunResult;
          idempotencyKey: string;
          clientOrderHash?: string;
        }) => ExecutionRuntimeOutcome | Promise<ExecutionRuntimeOutcome>);
    clock?: () => Date;
  } = {},
) {
  const instruments = overrides.instruments ?? [makeInstrument("aapl")];
  const marketDataRuntime = makeMarketDataRuntime({
    ticket: overrides.ticket,
    outcome: overrides.pipelineOutcome,
    priceObservedAtIso: overrides.priceObservedAtIso,
    // PR15.3 Finding 2 — thread instruments through so the
    // default fixture emits the correct per-instrument strategyId.
    instruments,
  });
  const executionRuntime = makeExecutionRuntime(
    overrides.runtimeOutcome ?? SUBMITTED_OUTCOME,
  );
  const exposureReader = makeExposureReader(overrides.exposure);
  const svc = new TradingLoopService({
    config: overrides.config ?? makeConfig(),
    registry: makeRegistry(instruments),
    marketDataRuntime,
    executionRuntime,
    exposureReader,
    portfolioManager: makeFakePortfolioManager(),
    repo: makeFakeRepo(),
    strategyCooldownMs: 0,
    maxMarketStateAgeMs: 0,
    logger: makeLogger(),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
  });
  return { svc, marketDataRuntime, executionRuntime, exposureReader };
}

// ---------------------------------------------------------------------------
// Per-instrument policy — round-4 blocker (item 3)
// ---------------------------------------------------------------------------

describe("resolveInstrumentPolicy — per-instrument policy resolution", () => {
  it("missing executionPolicy → ok:false", () => {
    const instrument = makeInstrument("aapl", { executionPolicy: null });
    const result = resolveInstrumentPolicy(instrument);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /no executionPolicy/);
  });

  it("valid executionPolicy → ok:true with derived ExecutionTicketPolicy", () => {
    const result = resolveInstrumentPolicy(makeInstrument("aapl"));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.policy.quantity, 10);
    assert.equal(result.policy.orderType, "LMT");
    assert.equal(result.policy.priceTickSize, 0.01);
  });

  it("quantity is capped by min(policy.quantity, policy.maxQuantity, risk.maxQuantity)", () => {
    const result = resolveInstrumentPolicy(
      makeInstrument("aapl", {
        riskMaxQuantity: 3,
        executionPolicy: { ...AAPL_POLICY, quantity: 100, maxQuantity: 50 },
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.policy.quantity, 3);
  });

  it("defaultOrderType not in allowedOrderTypes → ok:false", () => {
    const result = resolveInstrumentPolicy(
      makeInstrument("aapl", {
        executionPolicy: {
          ...AAPL_POLICY,
          allowedOrderTypes: ["LMT"],
          defaultOrderType: "STP",
        },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /not in allowedOrderTypes/);
  });

  it("priceTickSize <= 0 → ok:false", () => {
    const result = resolveInstrumentPolicy(
      makeInstrument("aapl", {
        executionPolicy: { ...AAPL_POLICY, priceTickSize: 0 },
      }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /priceTickSize/);
  });

  it("silver and platinum can have different tick sizes", () => {
    const silver = resolveInstrumentPolicy(
      makeInstrument("silver_stk", {
        executionPolicy: { ...AAPL_POLICY, priceTickSize: 0.001 },
      }),
    );
    const platinum = resolveInstrumentPolicy(
      makeInstrument("platinum_stk", {
        executionPolicy: { ...AAPL_POLICY, priceTickSize: 0.05 },
      }),
    );
    assert.equal(silver.ok && silver.policy.priceTickSize, 0.001);
    assert.equal(platinum.ok && platinum.policy.priceTickSize, 0.05);
  });
});

// ---------------------------------------------------------------------------
// Trigger identity — round-4 blocker (item 1)
// ---------------------------------------------------------------------------

describe("deriveTriggerIdentity — candle-close anchored", () => {
  it("returns null when snapshot has no price observedAt", () => {
    const snapshot = makeSnapshot("aapl", null);
    assert.equal(deriveTriggerIdentity(snapshot, AAPL_POLICY), null);
  });

  it("returns evaluation-bucket triggerId (round-5 rename: floor(observedAt) is a bucket, NOT a proven candle close)", () => {
    // 2026-07-14T12:00:15Z → 1m bucket 2026-07-14T12:00:00Z
    const snapshot = makeSnapshot("aapl", "2026-07-14T12:00:15.500Z");
    const t = deriveTriggerIdentity(snapshot, AAPL_POLICY);
    assert.ok(t);
    if (!t) return;
    assert.equal(t.strategyId, AAPL_POLICY.strategyId);
    assert.equal(t.timeframe, "1m");
    assert.equal(t.source, "evaluation_bucket");
    assert.equal(t.triggerId, "evaluation.1m.1784030400000");
  });

  it("all ticks within the same 1m candle → same triggerId", () => {
    const t1 = deriveTriggerIdentity(
      makeSnapshot("aapl", "2026-07-14T12:00:00.000Z"),
      AAPL_POLICY,
    );
    const t2 = deriveTriggerIdentity(
      makeSnapshot("aapl", "2026-07-14T12:00:30.000Z"),
      AAPL_POLICY,
    );
    const t3 = deriveTriggerIdentity(
      makeSnapshot("aapl", "2026-07-14T12:00:59.999Z"),
      AAPL_POLICY,
    );
    assert.equal(t1?.triggerId, t2?.triggerId);
    assert.equal(t2?.triggerId, t3?.triggerId);
  });

  it("next candle → new triggerId", () => {
    const cur = deriveTriggerIdentity(
      makeSnapshot("aapl", "2026-07-14T12:00:59.999Z"),
      AAPL_POLICY,
    );
    const next = deriveTriggerIdentity(
      makeSnapshot("aapl", "2026-07-14T12:01:00.000Z"),
      AAPL_POLICY,
    );
    assert.notEqual(cur?.triggerId, next?.triggerId);
  });
});

// ---------------------------------------------------------------------------
// Exposure guard (unchanged from round 2)
// ---------------------------------------------------------------------------

describe("TradingLoopService.runOnce — exposure guard", () => {
  it("hasPendingProposal → SKIPPED / EXPOSURE_BLOCKED, no runtime call", async () => {
    const { svc, executionRuntime, marketDataRuntime } = makeService({
      exposure: {
        hasOpenPosition: false,
        hasActiveOrder: false,
        hasAmbiguousSubmission: false,
        hasPendingProposal: true,
      },
    });
    const report = await svc.runOnce();
    assert.equal(marketDataRuntime.calls.length, 0);
    assert.equal(executionRuntime.preparedCalls.length, 0);
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "EXPOSURE_BLOCKED");
  });

  it("hasOpenPosition → SKIPPED / EXPOSURE_BLOCKED", async () => {
    const { svc, executionRuntime } = makeService({
      exposure: {
        hasOpenPosition: true,
        hasActiveOrder: false,
        hasAmbiguousSubmission: false,
        hasPendingProposal: false,
      },
    });
    const report = await svc.runOnce();
    assert.equal(executionRuntime.preparedCalls.length, 0);
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
  });
});

// ---------------------------------------------------------------------------
// Scheduler lifecycle basics
// ---------------------------------------------------------------------------

describe("TradingLoopService — lifecycle", () => {
  it("disabled by default → start() is a no-op", () => {
    const { svc } = makeService();
    svc.start();
    assert.equal(svc.status().enabled, false);
    assert.equal(svc.status().running, false);
  });

  it("stop() while idle is idempotent", async () => {
    const { svc } = makeService();
    await svc.stop();
    await svc.stop();
    assert.equal(svc.status().running, false);
  });

  it("runOnce after stop → empty cycle, no runtime call", async () => {
    const { svc, executionRuntime } = makeService();
    await svc.stop();
    const report = await svc.runOnce();
    assert.equal(report.reports.length, 0);
    assert.equal(executionRuntime.preparedCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// PR15.2 — Instrument binding gate
// ---------------------------------------------------------------------------

describe("TradingLoopService — PR15.2 binding gate", () => {
  it("no binding for a registry instrument → SKIPPED / INSTRUMENT_BINDING_UNAVAILABLE", async () => {
    const instruments = [makeInstrument("aapl")];
    const marketDataRuntime = makeMarketDataRuntime({});
    const executionRuntime = makeExecutionRuntime(SUBMITTED_OUTCOME);
    const exposureReader = makeExposureReader();
    // Empty authority — the loop refuses every registry instrument.
    const { InstrumentBindingAuthority, defaultInstrumentRegistry } =
      await import("@ikbr/shared");
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      [],
    );
    const svc = new TradingLoopService({
      config: makeConfig(),
      registry: makeRegistry(instruments),
      bindingAuthority: authority,
      marketDataRuntime,
      executionRuntime,
      exposureReader,
      portfolioManager: makeFakePortfolioManager(),
      repo: makeFakeRepo(),
      strategyCooldownMs: 0,
      maxMarketStateAgeMs: 0,
      logger: makeLogger(),
    });
    const report = await svc.runOnce();
    assert.equal(report.reports.length, 1);
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind === "SKIPPED") {
      assert.equal(outcome.reason, "INSTRUMENT_BINDING_UNAVAILABLE");
    }
    assert.equal(
      executionRuntime.preparedCalls.length,
      0,
      "runtime.executePrepared must NOT be called when the binding is unavailable",
    );
    assert.equal(
      marketDataRuntime.calls.length,
      0,
      "market-data dryRun must NOT be called when the binding is unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// PR15.4 §14.7 integration — real path (context loader → portfolio → dryRun →
// executePrepared) with full fixtures. Every test asserts call-count
// invariants at each stage to prove fail-closed guards short-circuit.
// ---------------------------------------------------------------------------

const AAPL_INSTRUMENT = makeInstrument("aapl");
const AAPL_BOUND: BoundInstrument = makeBound(AAPL_INSTRUMENT);

interface RichMarketDataRuntime extends MarketDataRuntime {
  calls: Array<{
    instrumentId: string;
    policy: ExecutionTicketPolicy;
    attribution?: SignalAttributionContext;
  }>;
}

function makeAttributionAwareMarketDataRuntime(
  behavior: {
    outcome?: "SUCCESS" | "NO_TRADE" | "FAILURE";
    // PR15.4 — controls the fake FAILURE shape:
    //   - "SIGNAL" (default) → signal=null, failedStage="SIGNAL"
    //   - "RISK"             → signal populated (REJECTED-like), failedStage="RISK"
    //   - "ATTRIBUTION"      → signal populated with SignalBlocker[STRATEGY_DIRECTION_UNCONFIRMED],
    //                          failedStage="ATTRIBUTION" (mirrors what the real
    //                          direction gate produces without invoking Risk)
    failureStage?: "SIGNAL" | "RISK" | "ATTRIBUTION";
    priceObservedAtIso?: string | null;
    overrideMetadataStrategyId?: string;
    overrideDecisionAction?: "LONG" | "SHORT" | "HOLD";
    ticket?: ExecutionTicket;
    throwErr?: unknown;
  } = {},
): RichMarketDataRuntime {
  const calls: RichMarketDataRuntime["calls"] = [];
  return {
    calls,
    async dryRun(
      instrumentId: string,
      policy: ExecutionTicketPolicy,
      attribution?: SignalAttributionContext,
    ): Promise<DryRunResult> {
      calls.push({ instrumentId, policy, attribution });
      if (behavior.throwErr !== undefined) throw behavior.throwErr;
      const snapshot = makeSnapshot(
        instrumentId,
        behavior.priceObservedAtIso === undefined
          ? NOW_ISO
          : behavior.priceObservedAtIso,
      );
      const outcome = behavior.outcome ?? "SUCCESS";
      const metadataStrategyId =
        behavior.overrideMetadataStrategyId ?? attribution?.strategyId;
      const decisionAction =
        behavior.overrideDecisionAction ??
        attribution?.intendedAction ??
        "LONG";
      const buildSignal = (
        blockers: readonly {
          code: string;
          message: string;
          source: string;
        }[] = [],
      ) => ({
        signalId: "sig-1",
        instrumentId,
        decision: { action: decisionAction },
        blockers,
        warnings: [],
        metadata: {
          engineVersions: {},
          evaluationTimeMs: 0,
          ...(metadataStrategyId !== undefined
            ? { strategyId: metadataStrategyId }
            : {}),
        },
      });
      const pipeline =
        outcome === "SUCCESS"
          ? ({
              outcome: "SUCCESS",
              signal: buildSignal(),
              ticket: behavior.ticket ?? makeTicket(),
              warnings: [],
              durationMs: 1,
              metadata: { engineVersions: {}, ranAt: new Date() },
            } as unknown as DryRunResult["pipeline"])
          : outcome === "NO_TRADE"
            ? ({
                outcome: "NO_TRADE",
                signal: buildSignal(),
                ticket: null,
                reason: "HOLD",
                warnings: [],
                durationMs: 1,
                metadata: { engineVersions: {}, ranAt: new Date() },
              } as unknown as DryRunResult["pipeline"])
            : (() => {
                const stage = behavior.failureStage ?? "SIGNAL";
                if (stage === "ATTRIBUTION") {
                  return {
                    outcome: "FAILURE",
                    signal: buildSignal([
                      {
                        code: "STRATEGY_DIRECTION_UNCONFIRMED",
                        message: "test direction gate",
                        source: "attribution",
                      },
                    ]),
                    ticket: null,
                    blockers: [],
                    warnings: [],
                    failedStage: "ATTRIBUTION",
                    durationMs: 1,
                    metadata: { engineVersions: {}, ranAt: new Date() },
                  } as unknown as DryRunResult["pipeline"];
                }
                if (stage === "RISK") {
                  return {
                    outcome: "FAILURE",
                    signal: buildSignal(),
                    ticket: null,
                    blockers: [],
                    warnings: [],
                    failedStage: "RISK",
                    durationMs: 1,
                    metadata: { engineVersions: {}, ranAt: new Date() },
                  } as unknown as DryRunResult["pipeline"];
                }
                return {
                  outcome: "FAILURE",
                  signal: null,
                  ticket: null,
                  blockers: [],
                  warnings: [],
                  failedStage: "SIGNAL",
                  durationMs: 1,
                  metadata: { engineVersions: {}, ranAt: new Date() },
                } as unknown as DryRunResult["pipeline"];
              })();
      return { instrumentId, snapshot, pipeline };
    },
  } as unknown as RichMarketDataRuntime;
}

interface IntegrationEnv {
  svc: TradingLoopService;
  marketDataRuntime: RichMarketDataRuntime;
  executionRuntime: ReturnType<typeof makeExecutionRuntime>;
  exposureReader: TradingExposureReader;
  loaderRepo: LoaderRepoSpy;
  bindings: readonly BoundInstrument[];
}

function makeIntegrationSvc(
  overrides: {
    wseMetadataReader?: WseStrategyMetadataReader;
    instruments?: readonly Instrument[];
    bounds?: readonly BoundInstrument[];
    loaderRepo?: LoaderRepoSpy;
    strategies?: readonly Strategy[];
    exposure?: TradingExposure;
    exposureReader?: TradingExposureReader;
    reconciliationReader?: ReconciliationReader;
    runtimeBehavior?: Parameters<
      typeof makeAttributionAwareMarketDataRuntime
    >[0];
    runtimeOutcome?:
      | ExecutionRuntimeOutcome
      | ((input: {
          dryRunResult: DryRunResult;
          idempotencyKey: string;
          strategyId?: string;
        }) => ExecutionRuntimeOutcome | Promise<ExecutionRuntimeOutcome>);
    clock?: () => Date;
    strategyCooldownMs?: number;
    maxMarketStateAgeMs?: number;
  } = {},
): IntegrationEnv {
  const instruments = overrides.instruments ?? [AAPL_INSTRUMENT];
  const bounds =
    overrides.bounds ??
    instruments.map((i) =>
      i.id === AAPL_INSTRUMENT.id ? AAPL_BOUND : makeBound(i),
    );
  const strategies = overrides.strategies ?? [
    makeRealStrategy(AAPL_POLICY.strategyId, { direction: "LONG" }),
  ];
  const loaderRepo = overrides.loaderRepo ?? makeLoaderRepo(bounds[0]);
  const marketDataRuntime = makeAttributionAwareMarketDataRuntime(
    overrides.runtimeBehavior ?? {},
  );
  const executionRuntime = makeExecutionRuntime(
    overrides.runtimeOutcome ?? SUBMITTED_OUTCOME,
  );
  const exposureReader =
    overrides.exposureReader ?? makeExposureReader(overrides.exposure);
  const svc = new TradingLoopService({
    wseMetadataReader: overrides.wseMetadataReader,
    config: makeConfig(),
    registry: makeRegistry(instruments),
    bindingAuthority: makeBindingAuthority(bounds),
    marketDataRuntime: marketDataRuntime as unknown as MarketDataRuntime,
    executionRuntime,
    exposureReader,
    ...(overrides.reconciliationReader !== undefined
      ? { reconciliationReader: overrides.reconciliationReader }
      : {}),
    portfolioManager: new StrategyPortfolioManager(strategies),
    repo: loaderRepo,
    strategyCooldownMs: overrides.strategyCooldownMs ?? 0,
    maxMarketStateAgeMs: overrides.maxMarketStateAgeMs ?? 0,
    logger: makeLogger(),
    clock: overrides.clock ?? CLOCK,
  });
  return {
    svc,
    marketDataRuntime,
    executionRuntime,
    exposureReader,
    loaderRepo,
    bindings: bounds,
  };
}

describe("TradingLoopService — PR15.4 §14.7 integration", () => {
  it("1. LONG strategy + Decision LONG + submitter submitted → SUBMITTED, strategyId forwarded, attribution reached dryRun", async () => {
    const env = makeIntegrationSvc();
    const report = await env.svc.runOnce();
    assert.equal(report.reports.length, 1);
    assert.equal(report.reports[0].outcome.kind, "SUBMITTED");
    assert.equal(env.marketDataRuntime.calls.length, 1);
    const call = env.marketDataRuntime.calls[0];
    assert.equal(call.attribution?.strategyId, AAPL_POLICY.strategyId);
    assert.equal(call.attribution?.intendedAction, "LONG");
    assert.equal(env.executionRuntime.preparedCalls.length, 1);
    const prepared = env.executionRuntime.preparedCalls[0] as {
      strategyId?: string;
      bound?: BoundInstrument;
    };
    assert.equal(prepared.strategyId, AAPL_POLICY.strategyId);
    assert.ok(prepared.bound);
    assert.equal((prepared.bound as BoundInstrument).conId, AAPL_CONID);
  });

  it("2. syncStrategyRuntimeStates spy called ONCE per cycle even with two instruments", async () => {
    const msftInstrument = makeInstrument("msft");
    const msftBound = makeBound(msftInstrument, 272093);
    const bounds = [AAPL_BOUND, msftBound];
    const loaderRepo = makeLoaderRepo(AAPL_BOUND);
    const env = makeIntegrationSvc({
      instruments: [AAPL_INSTRUMENT, msftInstrument],
      bounds,
      loaderRepo,
    });
    await env.svc.runOnce();
    assert.equal(env.loaderRepo.syncCalls.length, 1);
  });

  it("3. syncStrategyRuntimeStates throws → every instrument SKIPPED / STRATEGY_STATE_SYNC_UNAVAILABLE; message operator-safe; zero downstream calls", async () => {
    const instruments = [AAPL_INSTRUMENT, makeInstrument("msft")];
    const bounds = [AAPL_BOUND, makeBound(instruments[1], 272093)];
    const loaderRepo = makeLoaderRepo(AAPL_BOUND, {
      syncBehavior: () => {
        throw new Error("db down: SECRET-DETAIL-12345");
      },
    });
    const env = makeIntegrationSvc({ instruments, bounds, loaderRepo });
    const report = await env.svc.runOnce();
    assert.equal(report.reports.length, 2);
    for (const r of report.reports) {
      assert.equal(r.outcome.kind, "SKIPPED");
      if (r.outcome.kind !== "SKIPPED") return;
      assert.equal(r.outcome.reason, "STRATEGY_STATE_SYNC_UNAVAILABLE");
      assert.ok(!/SECRET-DETAIL/.test(r.outcome.message ?? ""));
    }
    assert.equal(env.loaderRepo.contractCalls.length, 0);
    assert.equal(env.loaderRepo.candleCalls.length, 0);
    assert.equal(env.loaderRepo.marketStateCalls.length, 0);
    assert.equal(env.marketDataRuntime.calls.length, 0);
    assert.equal(env.executionRuntime.preparedCalls.length, 0);
  });

  it("4. Strategy LONG + Decision SHORT (direction gate fires in pipeline) → NOT_SUBMITTED / PIPELINE_FAILURE; metadata.strategyId preserved; submitter NOT called", async () => {
    const env = makeIntegrationSvc({
      runtimeBehavior: {
        outcome: "FAILURE",
        failureStage: "ATTRIBUTION",
        // Fake pipeline mirrors what the real direction gate produces:
        // Decision returned SHORT but Strategy intends LONG → BLOCKED signal
        // with SignalBlocker[source="attribution"] and failedStage="ATTRIBUTION".
        overrideDecisionAction: "SHORT",
      },
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "PIPELINE_FAILURE");
    assert.equal(outcome.runtime.outcome, "NOT_SUBMITTED");
    // metadata.strategyId is preserved on the pipeline signal (§14.7 pt 4).
    const runtimePipeline = (
      outcome.runtime as { pipeline: unknown }
    ).pipeline as {
      outcome: string;
      signal?: { metadata?: { strategyId?: string } };
      failedStage?: string;
    };
    assert.equal(runtimePipeline.outcome, "FAILURE");
    assert.equal(runtimePipeline.failedStage, "ATTRIBUTION");
    assert.equal(
      runtimePipeline.signal?.metadata?.strategyId,
      AAPL_POLICY.strategyId,
    );
    // Submitter is NOT called on the direction-gate failure path.
    assert.equal(env.executionRuntime.preparedCalls.length, 0);
    // The dryRun IS called (that is where the direction gate fires).
    assert.equal(env.marketDataRuntime.calls.length, 1);
  });

  it("5. winner.signal.symbol differs from instrument.brokerSymbol → SKIPPED / STRATEGY_POLICY_MISMATCH; zero dryRun", async () => {
    const env = makeIntegrationSvc({
      strategies: [
        makeRealStrategy(AAPL_POLICY.strategyId, { symbol: "OTHER" }),
      ],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_POLICY_MISMATCH");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("6. winner.signal.strategyId differs from winner.strategy.id → SKIPPED / STRATEGY_POLICY_MISMATCH", async () => {
    const env = makeIntegrationSvc({
      strategies: [
        makeRealStrategy(AAPL_POLICY.strategyId, {
          overrideStrategyId: "corrupt_v9",
        }),
      ],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_POLICY_MISMATCH");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("7. winner.strategy.id differs from executionPolicy.strategyId → SKIPPED / STRATEGY_POLICY_MISMATCH", async () => {
    const env = makeIntegrationSvc({
      strategies: [
        makeRealStrategy("wrong_strategy_v1", { direction: "LONG" }),
      ],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_POLICY_MISMATCH");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("8. strategy.supportedDirections does NOT include signal.direction → SKIPPED / STRATEGY_POLICY_MISMATCH", async () => {
    const badStrategy: Strategy = {
      ...makeRealStrategy(AAPL_POLICY.strategyId, { direction: "LONG" }),
      supportedDirections: ["SHORT"],
    } as Strategy;
    const env = makeIntegrationSvc({ strategies: [badStrategy] });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_POLICY_MISMATCH");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("9. signal.direction differs from executionPolicy.expectedDirection → SKIPPED / STRATEGY_POLICY_MISMATCH", async () => {
    const shortPolicy: InstrumentExecutionPolicy = {
      ...AAPL_POLICY,
      strategyId: "gap_fade_short_v1",
      expectedDirection: "SHORT",
    };
    const shortInstrument = makeInstrument("aapl", {
      executionPolicy: shortPolicy,
    });
    const env = makeIntegrationSvc({
      instruments: [shortInstrument],
      bounds: [makeBound(shortInstrument)],
      strategies: [
        makeRealStrategy("gap_fade_short_v1", { direction: "LONG" }),
      ],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_POLICY_MISMATCH");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("10. LONG direction but side=SELL → SKIPPED / STRATEGY_POLICY_MISMATCH", async () => {
    const env = makeIntegrationSvc({
      strategies: [
        makeRealStrategy(AAPL_POLICY.strategyId, {
          direction: "LONG",
          side: "SELL",
        }),
      ],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_POLICY_MISMATCH");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("11. Post-pipeline attribution mismatch (fake pipeline overrides metadata.strategyId) → SKIPPED / STRATEGY_POLICY_MISMATCH; executePrepared NOT called", async () => {
    const env = makeIntegrationSvc({
      runtimeBehavior: {
        overrideMetadataStrategyId: "impostor_v1",
      },
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_POLICY_MISMATCH");
    assert.equal(env.executionRuntime.preparedCalls.length, 0);
  });

  it("12. Strategy generateSignal throws → SKIPPED / STRATEGY_EVALUATION_ERROR", async () => {
    const env = makeIntegrationSvc({
      strategies: [
        makeRealStrategy(AAPL_POLICY.strategyId, {
          throwErr: new Error("boom"),
        }),
      ],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_EVALUATION_ERROR");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("13. LONG + SHORT candidates → SKIPPED / STRATEGY_CONFLICT", async () => {
    const longStrategy = makeRealStrategy("momentum_breakout_long_v1", {
      direction: "LONG",
    });
    const shortStrategy = makeRealStrategy("gap_fade_short_v1", {
      direction: "SHORT",
    });
    const env = makeIntegrationSvc({
      strategies: [longStrategy, shortStrategy],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_CONFLICT");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("14. Risk rejects → NOT_SUBMITTED / PIPELINE_FAILURE; signal.metadata.strategyId preserved on the pipeline result", async () => {
    const env = makeIntegrationSvc({
      runtimeBehavior: { outcome: "FAILURE", failureStage: "RISK" },
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "PIPELINE_FAILURE");
    assert.equal(outcome.runtime.outcome, "NOT_SUBMITTED");
    const runtimePipeline = (
      outcome.runtime as { pipeline: unknown }
    ).pipeline as {
      outcome: string;
      failedStage?: string;
      signal?: { metadata?: { strategyId?: string } };
    };
    assert.equal(runtimePipeline.outcome, "FAILURE");
    assert.equal(runtimePipeline.failedStage, "RISK");
    assert.equal(
      runtimePipeline.signal?.metadata?.strategyId,
      AAPL_POLICY.strategyId,
    );
    assert.equal(env.executionRuntime.preparedCalls.length, 0);
  });

  it("15. Context unavailable (no market state) → SKIPPED / STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const loaderRepo = makeLoaderRepo(AAPL_BOUND, { marketState: null });
    const env = makeIntegrationSvc({ loaderRepo });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_CONTEXT_UNAVAILABLE");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("16. Contract mismatch → SKIPPED / STRATEGY_CONTRACT_MISMATCH", async () => {
    const loaderRepo = makeLoaderRepo(AAPL_BOUND, {
      contract: makeContract(AAPL_BOUND, { symbol: "MSFT" }),
    });
    const env = makeIntegrationSvc({ loaderRepo });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_CONTRACT_MISMATCH");
  });

  it("17. No active strategy (all disabled) → SKIPPED / NO_STRATEGY_SIGNAL", async () => {
    const loaderRepo = makeLoaderRepo(AAPL_BOUND, {
      runtimeStates: {
        [AAPL_POLICY.strategyId]: {
          enabled: false,
          permanentlyDisabled: false,
        },
      },
    });
    const env = makeIntegrationSvc({ loaderRepo });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "NO_STRATEGY_SIGNAL");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("18. getStrategyRuntimeState throws → SKIPPED / STRATEGY_STATE_UNAVAILABLE; message operator-safe", async () => {
    const loaderRepo = makeLoaderRepo(AAPL_BOUND, {
      runtimeStates: {
        [AAPL_POLICY.strategyId]: new Error("db offline: SECRET-DETAIL"),
      },
    });
    const env = makeIntegrationSvc({ loaderRepo });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_STATE_UNAVAILABLE");
    assert.ok(!/SECRET-DETAIL/.test(outcome.message ?? ""));
  });

  it("19. hasOpenPosition=false but quantity non-zero → SKIPPED / EXPOSURE_DATA_CONTRADICTION", async () => {
    const env = makeIntegrationSvc({
      exposure: {
        hasOpenPosition: false,
        hasActiveOrder: false,
        hasAmbiguousSubmission: false,
        hasPendingProposal: false,
        quantity: 5,
      },
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "EXPOSURE_DATA_CONTRADICTION");
    assert.equal(env.marketDataRuntime.calls.length, 0);
    assert.equal(env.loaderRepo.contractCalls.length, 0);
  });

  it("20. Policy expectedDirection missing → NOT_SUBMITTED / INSTRUMENT_POLICY_UNAVAILABLE", async () => {
    const rest = { ...AAPL_POLICY };
    delete (rest as { expectedDirection?: unknown }).expectedDirection;
    const policyNoDir = rest as InstrumentExecutionPolicy;
    const instrument = makeInstrument("aapl", { executionPolicy: policyNoDir });
    const env = makeIntegrationSvc({
      instruments: [instrument],
      bounds: [makeBound(instrument)],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "INSTRUMENT_POLICY_UNAVAILABLE");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("21. Manual runOnce() and the scheduler tick pass through the identical gate", async () => {
    // First half: manual runOnce with the standard integration svc.
    const manualEnv = makeIntegrationSvc();
    const manualReport = await manualEnv.svc.runOnce();
    assert.equal(manualReport.reports[0].outcome.kind, "SUBMITTED");
    assert.equal(manualEnv.executionRuntime.preparedCalls.length, 1);
    const manualStrategyId =
      manualEnv.marketDataRuntime.calls[0].attribution?.strategyId;

    // Second half: enabled scheduler with injected fake timers so we
    // deterministically fire the startup callback and wait for the
    // async cycle to complete.
    const captured: {
      startup?: () => void;
      startupDelay?: number;
      tick?: () => void;
      tickInterval?: number;
    } = {};
    const fakeSetTimeout = ((cb: () => void, ms: number) => {
      captured.startup = cb;
      captured.startupDelay = ms;
      return { unref: () => undefined } as unknown as ReturnType<
        typeof setTimeout
      >;
    }) as unknown as typeof setTimeout;
    const fakeSetInterval = ((cb: () => void, ms: number) => {
      captured.tick = cb;
      captured.tickInterval = ms;
      return { unref: () => undefined } as unknown as ReturnType<
        typeof setInterval
      >;
    }) as unknown as typeof setInterval;
    const bounds = [AAPL_BOUND];
    const loaderRepo = makeLoaderRepo(AAPL_BOUND);
    const marketDataRuntime = makeAttributionAwareMarketDataRuntime({});
    const executionRuntime = makeExecutionRuntime(SUBMITTED_OUTCOME);
    const exposureReader = makeExposureReader();
    const scheduledSvc = new TradingLoopService({
      config: makeConfig({ TRADING_LOOP_ENABLED: "true" }),
      registry: makeRegistry([AAPL_INSTRUMENT]),
      bindingAuthority: makeBindingAuthority(bounds),
      marketDataRuntime: marketDataRuntime as unknown as MarketDataRuntime,
      executionRuntime,
      exposureReader,
      portfolioManager: new StrategyPortfolioManager([
        makeRealStrategy(AAPL_POLICY.strategyId, { direction: "LONG" }),
      ]),
      repo: loaderRepo,
      strategyCooldownMs: 0,
      maxMarketStateAgeMs: 0,
      logger: makeLogger(),
      clock: CLOCK,
      setTimeoutFn: fakeSetTimeout,
      setIntervalFn: fakeSetInterval,
    });
    scheduledSvc.start();
    // start() must schedule ONLY the startup timer (no interval yet).
    assert.equal(typeof captured.startup, "function");
    assert.equal(captured.tick, undefined);
    assert.equal(scheduledSvc.status().running, true);
    // Fire the startup callback. It schedules the interval and kicks
    // off the first #safeTick(). We deterministically await the
    // promise via runOnce() concurrency map: because runOnce() shares
    // the same #inFlight map, awaiting it here waits for the ongoing
    // safeTick to finish for any newly-started instrument, but on a
    // fresh cycle it triggers its own. Instead we wait until the
    // cycleCount has incremented by driving microtasks.
    const before = scheduledSvc.status().cycleCount;
    captured.startup!();
    // After firing, the interval callback must be scheduled.
    assert.equal(typeof captured.tick, "function");
    // The scheduler fires `void this.#safeTick()` (fire-and-forget), so
    // we deterministically drain microtasks until the runtime records
    // its submission (bounded to prevent hangs if the scheduler is
    // misconfigured).
    for (let i = 0; i < 200; i += 1) {
      if (executionRuntime.preparedCalls.length >= 1) break;
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(
      scheduledSvc.status().cycleCount > before,
      "scheduler tick must complete a cycle",
    );
    assert.equal(executionRuntime.preparedCalls.length, 1);
    assert.equal(marketDataRuntime.calls.length, 1);
    const scheduledStrategyId =
      marketDataRuntime.calls[0].attribution?.strategyId;
    // The scheduler path went through the SAME attribution / dryRun /
    // executePrepared gates as the manual runOnce path.
    assert.equal(scheduledStrategyId, manualStrategyId);
    await scheduledSvc.stop();
  });

  it("22. Runtime returns NOT_SUBMITTED / STRATEGY_ATTRIBUTION_UNAVAILABLE → loop outcome NOT_SUBMITTED with that reason preserved", async () => {
    const outcome: ExecutionRuntimeOutcome = {
      outcome: "NOT_SUBMITTED",
      pipeline: {} as unknown as ExecutionRuntimeOutcome extends {
        pipeline: infer P;
      }
        ? P
        : never,
      reason: "STRATEGY_ATTRIBUTION_UNAVAILABLE",
      message: "attribution missing",
    };
    const env = makeIntegrationSvc({ runtimeOutcome: outcome });
    const report = await env.svc.runOnce();
    const o = report.reports[0].outcome;
    assert.equal(o.kind, "NOT_SUBMITTED");
    if (o.kind !== "NOT_SUBMITTED") return;
    assert.equal(o.reason, "STRATEGY_ATTRIBUTION_UNAVAILABLE");
    assert.notEqual(o.idempotencyKey, "");
    assert.ok(o.runtime);
  });

  it("23. Runtime returns NOT_SUBMITTED / STRATEGY_ATTRIBUTION_MISMATCH → loop outcome NOT_SUBMITTED with that reason preserved", async () => {
    const outcome: ExecutionRuntimeOutcome = {
      outcome: "NOT_SUBMITTED",
      pipeline: {} as unknown as ExecutionRuntimeOutcome extends {
        pipeline: infer P;
      }
        ? P
        : never,
      reason: "STRATEGY_ATTRIBUTION_MISMATCH",
      message: "attribution mismatch",
    };
    const env = makeIntegrationSvc({ runtimeOutcome: outcome });
    const report = await env.svc.runOnce();
    const o = report.reports[0].outcome;
    assert.equal(o.kind, "NOT_SUBMITTED");
    if (o.kind !== "NOT_SUBMITTED") return;
    assert.equal(o.reason, "STRATEGY_ATTRIBUTION_MISMATCH");
    assert.notEqual(o.idempotencyKey, "");
    assert.ok(o.runtime);
  });
});

describe("TradingLoopService — PR15.4.1 operator-safe exception outcomes", () => {
  const assertRedacted = (
    outcome: { readonly message?: string },
    expected: string,
  ): void => {
    assert.equal(outcome.message, expected);
    assert.doesNotMatch(outcome.message ?? "", /SECRET-DETAIL/);
  };

  it("redacts an exposure-reader exception", async () => {
    const exposureReader: TradingExposureReader = {
      async readExposure() {
        throw new Error("database DSN SECRET-DETAIL-EXPOSURE");
      },
      async probeReady() {
        return { ok: true };
      },
    };
    const env = makeIntegrationSvc({ exposureReader });

    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;

    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "EXPOSURE_READ_FAILED");
    assertRedacted(outcome, "exposure read failed; check logs");
  });

  it("redacts a reconciliation exception in cycle and status outcomes", async () => {
    class ThrowingReconciliationReader extends ReconciliationReader {
      override async checkInstrument(): Promise<never> {
        throw new Error("broker response SECRET-DETAIL-RECONCILIATION");
      }
    }
    const reconciliationReader = new ThrowingReconciliationReader({
      baseUrl: "http://execution.test",
      bearerToken: "test-token",
    });
    const env = makeIntegrationSvc({ reconciliationReader });

    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;

    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "RECONCILIATION_UNAVAILABLE");
    assertRedacted(outcome, "reconciliation pre-check failed; check logs");

    const statusOutcome = env.svc.status().lastOutcomes[AAPL_INSTRUMENT.id];
    assert.ok(statusOutcome);
    assert.equal(statusOutcome.outcome.kind, "SKIPPED");
    assertRedacted(
      statusOutcome.outcome,
      "reconciliation pre-check failed; check logs",
    );
  });

  it("redacts a market-data dry-run exception", async () => {
    const env = makeIntegrationSvc({
      runtimeBehavior: {
        throwErr: new Error("upstream response SECRET-DETAIL-DRY-RUN"),
      },
    });

    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;

    assert.equal(outcome.kind, "ERROR");
    assertRedacted(outcome, "market-data dry run failed; check logs");
  });

  it("redacts an executePrepared exception", async () => {
    const env = makeIntegrationSvc({
      runtimeOutcome: async () => {
        throw new Error("execution token SECRET-DETAIL-EXECUTION");
      },
    });

    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;

    assert.equal(outcome.kind, "ERROR");
    assertRedacted(outcome, "prepared execution failed; check logs");
  });

  it("redacts an unexpected per-instrument exception", async () => {
    let clockCalls = 0;
    const env = makeIntegrationSvc({
      clock: () => {
        clockCalls += 1;
        if (clockCalls === 2) {
          throw new Error("clock payload SECRET-DETAIL-INSTRUMENT");
        }
        return new Date(NOW_ISO);
      },
    });

    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;

    assert.equal(outcome.kind, "ERROR");
    assertRedacted(outcome, "unexpected instrument run failure; check logs");
  });
});

// ---------------------------------------------------------------------------
// PR15.4 §14.13 — STRATEGY_CONFLICT edge cases, deterministic sort,
// history bounded after sync failure
// ---------------------------------------------------------------------------

describe("TradingLoopService — PR15.4 §14.13 STRATEGY_CONFLICT and history bounds", () => {
  it("1. LONG + SHORT candidates → SKIPPED / STRATEGY_CONFLICT; zero dryRun / execution / submitter", async () => {
    const long = makeRealStrategy("momentum_breakout_long_v1", {
      direction: "LONG",
    });
    const short = makeRealStrategy("gap_fade_short_v1", { direction: "SHORT" });
    const env = makeIntegrationSvc({ strategies: [long, short] });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_CONFLICT");
    assert.equal(env.marketDataRuntime.calls.length, 0);
    assert.equal(env.executionRuntime.preparedCalls.length, 0);
  });

  it("2. Two LONG candidates → no conflict; highest lanePriority wins", async () => {
    const primary = makeRealStrategy(AAPL_POLICY.strategyId, {
      direction: "LONG",
      lanePriority: 10,
    });
    const secondary = makeRealStrategy("secondary_long_v1", {
      direction: "LONG",
      lanePriority: 0,
    });
    const env = makeIntegrationSvc({ strategies: [primary, secondary] });
    const report = await env.svc.runOnce();
    assert.equal(report.reports[0].outcome.kind, "SUBMITTED");
    assert.equal(
      env.marketDataRuntime.calls[0].attribution?.strategyId,
      AAPL_POLICY.strategyId,
    );
  });

  it("3. Two SHORT candidates → no conflict; lexicographically smallest id wins on tie", async () => {
    const shortPolicy: InstrumentExecutionPolicy = {
      ...AAPL_POLICY,
      strategyId: "aa_short_v1",
      expectedDirection: "SHORT",
    };
    const instrument = makeInstrument("aapl", { executionPolicy: shortPolicy });
    const a = makeRealStrategy("aa_short_v1", { direction: "SHORT" });
    const b = makeRealStrategy("bb_short_v1", { direction: "SHORT" });
    const env = makeIntegrationSvc({
      instruments: [instrument],
      bounds: [makeBound(instrument)],
      strategies: [b, a],
    });
    const report = await env.svc.runOnce();
    assert.equal(report.reports[0].outcome.kind, "SUBMITTED");
    assert.equal(
      env.marketDataRuntime.calls[0].attribution?.strategyId,
      "aa_short_v1",
    );
  });

  it("4. Zero candidates → SKIPPED / NO_STRATEGY_SIGNAL", async () => {
    const env = makeIntegrationSvc({
      strategies: [
        makeRealStrategy(AAPL_POLICY.strategyId, {
          direction: "LONG",
          emitNull: true,
        }),
      ],
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "NO_STRATEGY_SIGNAL");
    assert.equal(env.marketDataRuntime.calls.length, 0);
  });

  it("5. Sync failure across >100 instruments → status().lastOutcomes stays at most 100 entries", async () => {
    const count = 105;
    const instruments = Array.from({ length: count }, (_, i) =>
      makeInstrument(`sym_${String(i).padStart(4, "0")}`),
    );
    const bounds = instruments.map((inst, i) => makeBound(inst, 100_000 + i));
    const loaderRepo = makeLoaderRepo(bounds[0], {
      syncBehavior: () => {
        throw new Error("db down");
      },
    });
    const env = makeIntegrationSvc({ instruments, bounds, loaderRepo });
    await env.svc.runOnce();
    const outcomes = env.svc.status().lastOutcomes;
    assert.ok(
      Object.keys(outcomes).length <= 100,
      `expected <= 100 outcomes, got ${Object.keys(outcomes).length}`,
    );
  });
});

// ---------------------------------------------------------------------------
// PR15.4 idempotency-key hash includes strategyId
// (invariant preserved from removed PR15.3 key trigger-only tests)
// ---------------------------------------------------------------------------

describe("TradingLoopService — PR15.4 idempotency key includes strategyId", () => {
  it("SUBMITTED clientOrderId uses v4 format `loop:v4:<instrumentId>:<strategyId>:<triggerId>`", async () => {
    const env = makeIntegrationSvc();
    await env.svc.runOnce();
    assert.equal(env.executionRuntime.preparedCalls.length, 1);
    const key = env.executionRuntime.preparedCalls[0].idempotencyKey;
    assert.match(key, /^loop:v4:aapl:/);
  });

  it("Same trigger + same strategy across ticks → same idempotencyKey", async () => {
    const env = makeIntegrationSvc();
    await env.svc.runOnce();
    await env.svc.runOnce();
    const keys = env.executionRuntime.preparedCalls.map(
      (c) => c.idempotencyKey,
    );
    assert.equal(keys[0], keys[1]);
  });

  it("Different strategy label → different idempotencyKey", async () => {
    // First tick with strategy A, second tick with policy switched to strategy B.
    const env1 = makeIntegrationSvc();
    await env1.svc.runOnce();
    const keyA = env1.executionRuntime.preparedCalls[0].idempotencyKey;
    const altPolicy: InstrumentExecutionPolicy = {
      ...AAPL_POLICY,
      strategyId: "momentum_breakdown_short_v1",
      expectedDirection: "SHORT",
    };
    const altInstrument = makeInstrument("aapl", {
      executionPolicy: altPolicy,
    });
    const env2 = makeIntegrationSvc({
      instruments: [altInstrument],
      bounds: [makeBound(altInstrument)],
      strategies: [
        makeRealStrategy("momentum_breakdown_short_v1", {
          direction: "SHORT",
        }),
      ],
    });
    await env2.svc.runOnce();
    const keyB = env2.executionRuntime.preparedCalls[0].idempotencyKey;
    assert.notEqual(keyA, keyB);
  });
});

// ---------------------------------------------------------------------------
// PR15.4 — dryRun invariants preserved from removed PR15.3 outcome-routing tests
// ---------------------------------------------------------------------------

describe("TradingLoopService — PR15.4 outcome routing", () => {
  it("NO_TRADE runtime → NOT_SUBMITTED / NO_TRADE; submitter NOT called; empty idempotencyKey", async () => {
    const env = makeIntegrationSvc({
      runtimeBehavior: { outcome: "NO_TRADE" },
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "NO_TRADE");
    assert.equal(outcome.idempotencyKey, "");
    assert.equal(env.executionRuntime.preparedCalls.length, 0);
  });

  it("Missing price.observedAt → NOT_SUBMITTED / TRIGGER_UNAVAILABLE; executePrepared NOT called", async () => {
    const env = makeIntegrationSvc({
      runtimeBehavior: { priceObservedAtIso: null },
    });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "TRIGGER_UNAVAILABLE");
    assert.equal(env.executionRuntime.preparedCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// PR15.4 — Bound instrument forwarded through executePrepared
// (invariant preserved from the removed PR15.2 binding-gate test)
// ---------------------------------------------------------------------------

describe("TradingLoopService — PR15.4 configured binding delivers bound to runtime", () => {
  it("executePrepared receives the exact BoundInstrument for the resolved id", async () => {
    const env = makeIntegrationSvc();
    await env.svc.runOnce();
    assert.equal(env.executionRuntime.preparedCalls.length, 1);
    const call = env.executionRuntime.preparedCalls[0] as {
      bound?: BoundInstrument;
    };
    assert.ok(call.bound);
    assert.equal((call.bound as BoundInstrument).conId, AAPL_CONID);
    assert.equal((call.bound as BoundInstrument).brokerSymbol, "AAPL");
  });
});

// ---------------------------------------------------------------------------
// PR15.4 — Scheduler-off / manual run-once
// (invariant preserved from the removed PR15.3 scheduler-off test)
// ---------------------------------------------------------------------------

describe("TradingLoopService — PR15.4 scheduler-off / manual run-once", () => {
  it("TRADING_LOOP_ENABLED=false → start() schedules no timers; runOnce still submits", async () => {
    const timerCalls: string[] = [];
    const fakeSetTimeout = ((_cb: () => void, ms: number) => {
      timerCalls.push(`setTimeout(${ms})`);
      return { unref: () => undefined } as unknown as ReturnType<
        typeof setTimeout
      >;
    }) as unknown as typeof setTimeout;
    const fakeSetInterval = ((_cb: () => void, ms: number) => {
      timerCalls.push(`setInterval(${ms})`);
      return { unref: () => undefined } as unknown as ReturnType<
        typeof setInterval
      >;
    }) as unknown as typeof setInterval;
    const bounds = [AAPL_BOUND];
    const loaderRepo = makeLoaderRepo(AAPL_BOUND);
    const marketDataRuntime = makeAttributionAwareMarketDataRuntime({});
    const executionRuntime = makeExecutionRuntime(SUBMITTED_OUTCOME);
    const exposureReader = makeExposureReader();
    const svc = new TradingLoopService({
      config: makeConfig(),
      registry: makeRegistry([AAPL_INSTRUMENT]),
      bindingAuthority: makeBindingAuthority(bounds),
      marketDataRuntime: marketDataRuntime as unknown as MarketDataRuntime,
      executionRuntime,
      exposureReader,
      portfolioManager: new StrategyPortfolioManager([
        makeRealStrategy(AAPL_POLICY.strategyId, { direction: "LONG" }),
      ]),
      repo: loaderRepo,
      strategyCooldownMs: 0,
      maxMarketStateAgeMs: 0,
      logger: makeLogger(),
      clock: CLOCK,
      setTimeoutFn: fakeSetTimeout,
      setIntervalFn: fakeSetInterval,
    });
    svc.start();
    assert.equal(svc.status().enabled, false);
    assert.equal(svc.status().running, false);
    assert.deepEqual(timerCalls, []);
    const cycle = await svc.runOnce();
    assert.equal(cycle.reports.length, 1);
    assert.equal(cycle.reports[0].outcome.kind, "SUBMITTED");
    assert.equal(executionRuntime.preparedCalls.length, 1);
    assert.deepEqual(timerCalls, []);
  });
});

// ---------------------------------------------------------------------------
// PR15.4 — Callback safety at loop layer
// ---------------------------------------------------------------------------

describe("TradingLoopService — PR15.4 callback safety", () => {
  it("resolver onStateError callback throwing → loop outcome still SKIPPED / STRATEGY_STATE_UNAVAILABLE", async () => {
    const loaderRepo = makeLoaderRepo(AAPL_BOUND, {
      runtimeStates: {
        [AAPL_POLICY.strategyId]: new Error("state read failed"),
      },
    });
    const env = makeIntegrationSvc({ loaderRepo });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_STATE_UNAVAILABLE");
  });

  it("manager onStrategyError callback throwing → loop outcome still SKIPPED / STRATEGY_EVALUATION_ERROR", async () => {
    const strategies = [
      makeRealStrategy(AAPL_POLICY.strategyId, {
        throwErr: new Error("boom"),
      }),
    ];
    const bounds = [AAPL_BOUND];
    const loaderRepo = makeLoaderRepo(AAPL_BOUND);
    const marketDataRuntime = makeAttributionAwareMarketDataRuntime({});
    const executionRuntime = makeExecutionRuntime(SUBMITTED_OUTCOME);
    const exposureReader = makeExposureReader();
    const svc = new TradingLoopService({
      config: makeConfig(),
      registry: makeRegistry([AAPL_INSTRUMENT]),
      bindingAuthority: makeBindingAuthority(bounds),
      marketDataRuntime: marketDataRuntime as unknown as MarketDataRuntime,
      executionRuntime,
      exposureReader,
      portfolioManager: new StrategyPortfolioManager(strategies, {
        onStrategyError: () => {
          throw new Error("callback exploded");
        },
      }),
      repo: loaderRepo,
      strategyCooldownMs: 0,
      maxMarketStateAgeMs: 0,
      logger: makeLogger(),
      clock: CLOCK,
    });
    const report = await svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "SKIPPED");
    if (outcome.kind !== "SKIPPED") return;
    assert.equal(outcome.reason, "STRATEGY_EVALUATION_ERROR");
  });
});

describe("TradingLoopService — AI approval wait", () => {
  it("reports pending AI approval with bound proposal identity and no second dispatch", async () => {
    const order = { id: 77, status: "PROPOSED", instrumentId: AAPL_INSTRUMENT.id, conid: String(AAPL_BOUND.conId) };
    const exposure = { ...CLEAR_EXPOSURE };
    const env = makeIntegrationSvc({ exposure, runtimeOutcome: input => ({
      outcome: "AWAITING_AI", previousOrder: order, idempotencyKey: input.idempotencyKey,
    }) });
    const report = await env.svc.runOnce();
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "AWAITING_AI");
    if (outcome.kind !== "AWAITING_AI") return;
    assert.equal(outcome.instrumentId, AAPL_INSTRUMENT.id);
    assert.equal(outcome.runtime.outcome, "AWAITING_AI");
    if (outcome.runtime.outcome !== "AWAITING_AI") return;
    assert.deepEqual(outcome.runtime.previousOrder, order);
    assert.equal(outcome.runtime.idempotencyKey, outcome.idempotencyKey);
    assert.equal(env.executionRuntime.preparedCalls.length, 1);
    assert.equal(env.executionRuntime.preparedCalls[0].idempotencyKey, outcome.idempotencyKey);
    assert.deepEqual(env.executionRuntime.preparedCalls[0].bound, AAPL_BOUND);
    assert.equal(env.svc.status().lastOutcomes[AAPL_INSTRUMENT.id].outcome.kind, "AWAITING_AI");
    exposure.hasPendingProposal = true;
    const repeat = await env.svc.runOnce();
    assert.equal(repeat.reports[0].outcome.kind, "SKIPPED");
    if (repeat.reports[0].outcome.kind === "SKIPPED")
      assert.equal(repeat.reports[0].outcome.reason, "EXPOSURE_BLOCKED");
    assert.equal(env.executionRuntime.preparedCalls.length, 1);
  });
});

describe("GPW3 WSE strategy level wiring", () => {
  for (const badMetadata of [false, true]) it(`normalizes before pipeline and fails closed: badMetadata=${badMetadata}`, async () => {
    const instrument: Instrument = { ...makeInstrument("pko_wse", { executionPolicy: { ...AAPL_POLICY, quantity: 1, maxQuantity: 1 } }), brokerSymbol: "PKO", exchange: "WSE", currency: "PLN" };
    const bound: BoundInstrument = { ...makeBound(instrument), brokerSymbol: "PKO", conId: 35146360, localSymbol: "PKO", tradingClass: "PKO", exchange: "WSE", currency: "PLN" };
    const candles = makeFullCandles(bound);
    for (const tf of Object.keys(candles) as CandleTimeframe[]) candles[tf] = candles[tf].map(c => ({ ...c, source: "ibkr_wse_native_v1" }));
    const strategy = makeRealStrategy(AAPL_POLICY.strategyId);
    const original = strategy.generateSignal.bind(strategy);
    strategy.generateSignal = context => ({ ...original(context)!, suggestedEntry: 100.039, stopLoss: 99.997, takeProfit: 100.051 });
    const ticket = { ...makeTicket({ quantity: 1, limitPrice: 100 }), instrumentId: "pko_wse", brokerSymbol: "PKO", exchange: "WSE", currency: "PLN",
      protection: { bracketEnabled: true, stopLoss: 99.99, takeProfit: 100.1 } };
    const env = makeIntegrationSvc({ instruments: [instrument], bounds: [bound], strategies: [strategy], loaderRepo: makeLoaderRepo(bound, { candles }), runtimeBehavior: { ticket },
      wseMetadataReader: { read: async () => ({ accountId: "DU-TEST", metadata: { accountId: badMetadata ? "FOREIGN" : "DU-TEST",
        instrumentId: "pko_wse", conId: 35146360, symbol: "PKO", localSymbol: "PKO", tradingClass: "PKO", exchange: "WSE", currency: "PLN", secType: "STK",
        marketRuleId: 1, priceIncrements: [{ lowEdge: 0, increment: .01 }, { lowEdge: 100, increment: .05 }], timeZoneId: "Europe/Warsaw",
        liquidHours: "20260714:0900-20260714:1705", requestStartedAtMs: NOW_MS - 100, receivedAtMs: NOW_MS - 50 } }) },
    });
    const report = await env.svc.runOnce();
    assert.equal(report.reports[0].outcome.kind, badMetadata ? "SKIPPED" : "SUBMITTED");
    assert.equal(env.marketDataRuntime.calls.length, badMetadata ? 0 : 1);
    if (!badMetadata) {
      assert.deepEqual(env.marketDataRuntime.calls[0].policy.strategyPrices, { entry: 100, stopLoss: 99.99, takeProfit: 100.1 });
      assert.equal(env.loaderRepo.candleCalls.some(c => c.timeframe === "12h"), false);
    }
  });
});
