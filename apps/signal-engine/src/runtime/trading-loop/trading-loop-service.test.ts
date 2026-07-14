import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  ExecutionTicket,
  ExecutionTicketPolicy,
  Instrument,
  InstrumentExecutionPolicy,
  InstrumentRegistry,
  MarketContextSnapshot,
  TradingPipelineResult,
} from "@ikbr/shared";
import type { FastifyBaseLogger } from "fastify";

import { computeClientOrderHash } from "../execution/client-order-hash.js";
import type { DryRunResult, MarketDataRuntime } from "../runtime.js";
import type {
  ExecuteInput,
  ExecutionRuntime,
  ExecutionRuntimeOutcome,
} from "../execution/execution-runtime.js";

import { buildTradingLoopConfig, tradingLoopSchema } from "./config.js";
import {
  TradingLoopService,
  deriveTriggerIdentity,
  resolveInstrumentPolicy,
} from "./trading-loop-service.js";
import type { TradingExposure, TradingExposureReader } from "./types.js";

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
}): MarketDataRuntime & {
  calls: Array<{ instrumentId: string; policy: ExecutionTicketPolicy }>;
} {
  const calls: Array<{ instrumentId: string; policy: ExecutionTicketPolicy }> =
    [];
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
              signal: { id: "sig-1" },
              ticket: behaviour.ticket ?? makeTicket(),
              warnings: [],
              durationMs: 1,
              metadata: { engineVersions: {}, ranAt: new Date() },
            } as unknown as DryRunResult["pipeline"])
          : outcome === "NO_TRADE"
            ? ({
                outcome: "NO_TRADE",
                signal: { id: "sig-1" },
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
  }>;
} {
  const preparedCalls: Array<{
    dryRunResult: DryRunResult;
    idempotencyKey: string;
    clientOrderHash?: string;
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
// runOnce — outcome routing + key format
// ---------------------------------------------------------------------------

describe("TradingLoopService.runOnce — outcome routing", () => {
  it("SUCCESS → v4 key = loop:v4:<id>:<strategy>:<trigger>  (trigger-only, no intent-hash suffix)", async () => {
    const ticket = makeTicket();
    const { svc, executionRuntime } = makeService({ ticket });
    const report = await svc.runOnce();
    assert.equal(executionRuntime.preparedCalls.length, 1);
    assert.equal(report.reports[0].outcome.kind, "SUBMITTED");
    const key = executionRuntime.preparedCalls[0].idempotencyKey;
    // Round-5: no intent-hash suffix. Payload identity lives in
    // `clientOrderHash` inside ExecutionRuntime.
    const expected = `loop:v4:aapl:${AAPL_POLICY.strategyId}:evaluation.1m.1784030400000`;
    assert.equal(key, expected);
    // Round-5: loop MUST NOT forward a pre-computed clientOrderHash.
    assert.equal(
      executionRuntime.preparedCalls[0].clientOrderHash,
      undefined,
      "loop must not forward clientOrderHash; ExecutionRuntime computes it itself",
    );
  });

  it("NO_TRADE → runtime NOT called", async () => {
    const { svc, executionRuntime } = makeService({
      pipelineOutcome: "NO_TRADE",
    });
    const report = await svc.runOnce();
    assert.equal(executionRuntime.preparedCalls.length, 0);
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "NO_TRADE");
  });

  it("missing executionPolicy → NOT_SUBMITTED / INSTRUMENT_POLICY_UNAVAILABLE, no pipeline run", async () => {
    const { svc, marketDataRuntime, executionRuntime } = makeService({
      instruments: [makeInstrument("aapl", { executionPolicy: null })],
    });
    const report = await svc.runOnce();
    assert.equal(marketDataRuntime.calls.length, 0);
    assert.equal(executionRuntime.preparedCalls.length, 0);
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "INSTRUMENT_POLICY_UNAVAILABLE");
  });

  it("missing price.observedAt → NOT_SUBMITTED / TRIGGER_UNAVAILABLE, runtime NOT called", async () => {
    const { svc, executionRuntime } = makeService({
      priceObservedAtIso: null,
    });
    const report = await svc.runOnce();
    assert.equal(executionRuntime.preparedCalls.length, 0);
    const outcome = report.reports[0].outcome;
    assert.equal(outcome.kind, "NOT_SUBMITTED");
    if (outcome.kind !== "NOT_SUBMITTED") return;
    assert.equal(outcome.reason, "TRIGGER_UNAVAILABLE");
  });
});

// ---------------------------------------------------------------------------
// v4 trigger vs. intent separation — critical round-4 property
// ---------------------------------------------------------------------------

describe("TradingLoopService — key: trigger-only, payload in clientOrderHash (round-5)", () => {
  it("same trigger + same ticket → same key across many ticks", async () => {
    const ticket = makeTicket();
    const at = new Date("2026-07-14T12:00:15.000Z");
    const { svc, executionRuntime } = makeService({ ticket, clock: () => at });
    await svc.runOnce();
    await svc.runOnce();
    await svc.runOnce();
    assert.equal(executionRuntime.preparedCalls.length, 3);
    assert.equal(
      executionRuntime.preparedCalls[0].idempotencyKey,
      executionRuntime.preparedCalls[1].idempotencyKey,
    );
    assert.equal(
      executionRuntime.preparedCalls[1].idempotencyKey,
      executionRuntime.preparedCalls[2].idempotencyKey,
    );
  });

  it("new evaluation bucket + identical ticket → NEW key (historic terminal does not shadow)", async () => {
    const ticket = makeTicket();
    const { svc, executionRuntime } = makeService({
      ticket,
      priceObservedAtIso: "2026-07-14T12:00:00.000Z",
    });
    await svc.runOnce();
    // A NEW evaluation bucket → new triggerId → new key.
    const { svc: svc2, executionRuntime: exec2 } = makeService({
      ticket,
      priceObservedAtIso: "2026-07-14T12:01:00.000Z",
    });
    await svc2.runOnce();
    assert.notEqual(
      executionRuntime.preparedCalls[0].idempotencyKey,
      exec2.preparedCalls[0].idempotencyKey,
    );
  });

  it("same trigger + CHANGED order-critical field → SAME clientOrderId (round-5 fix)", async () => {
    // Round-5 blocker: clientOrderId must NOT depend on ticket
    // payload. Two evaluations of the same trigger with different
    // tickets must produce the SAME clientOrderId so
    // execution-engine surfaces a proper CONFLICT (via the hash
    // mismatch inside `clientOrderHash`), not silent bypass.
    const t1 = makeTicket({ quantity: 10 });
    const t2 = makeTicket({ quantity: 20 });
    const { svc: s1, executionRuntime: e1 } = makeService({ ticket: t1 });
    const { svc: s2, executionRuntime: e2 } = makeService({ ticket: t2 });
    await s1.runOnce();
    await s2.runOnce();
    assert.equal(
      e1.preparedCalls[0].idempotencyKey,
      e2.preparedCalls[0].idempotencyKey,
      "same trigger MUST yield same clientOrderId regardless of ticket contents",
    );
  });

  it("different strategies emitting on the same trigger window → different clientOrderIds", async () => {
    const inst1 = makeInstrument("aapl", {
      executionPolicy: { ...AAPL_POLICY, strategyId: "strat_a" },
    });
    const inst2 = makeInstrument("aapl", {
      executionPolicy: { ...AAPL_POLICY, strategyId: "strat_b" },
    });
    const { svc: s1, executionRuntime: e1 } = makeService({
      instruments: [inst1],
    });
    const { svc: s2, executionRuntime: e2 } = makeService({
      instruments: [inst2],
    });
    await s1.runOnce();
    await s2.runOnce();
    assert.notEqual(
      e1.preparedCalls[0].idempotencyKey,
      e2.preparedCalls[0].idempotencyKey,
    );
  });

  it("UNKNOWN retry with the same trigger → same key", async () => {
    let call = 0;
    const ticket = makeTicket();
    const { svc, executionRuntime } = makeService({
      ticket,
      runtimeOutcome: () => {
        call += 1;
        return call === 1 ? UNKNOWN_OUTCOME : SUBMITTED_OUTCOME;
      },
    });
    await svc.runOnce();
    await svc.runOnce();
    assert.equal(
      executionRuntime.preparedCalls[0].idempotencyKey,
      executionRuntime.preparedCalls[1].idempotencyKey,
    );
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
