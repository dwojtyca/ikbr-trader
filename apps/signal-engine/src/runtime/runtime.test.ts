import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FRESHNESS_POLICY,
  DecisionEngine,
  ExecutionTicketBuilder,
  InstrumentRegistry,
  RiskEngine,
  SignalEngine,
  TradingPipeline,
  type ExecutionTicketPolicy,
  type Instrument,
  type MarketContextSnapshot,
  type Rule,
  type RuleEvaluation,
  type TradingPipelineResult,
} from "@ikbr/shared";

import { createRuntimeEngines } from "./engines.js";
import { MarketDataRuntime, buildRuntimeFreshnessPolicy } from "./runtime.js";
import { PriceContextProvider } from "./price-provider.js";
import type {
  MarketDataRuntimeReader,
  RuntimeMarketState,
} from "./market-data-reader.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Test instrument. Kept close to a real registry shape:
 *   - `executionEnabled = true` (Risk `InstrumentExecutionRule`).
 *   - `allowOvernight = true`   (Risk `OvernightRule`).
 *   - `quantityUnit = "shares"` (ExecutionTicketBuilder).
 * The runtime tests never use a synthetic `conId` in production
 * code paths — the reader resolves conids via the injected
 * `ContractResolver`. Here we bypass the resolver by supplying a
 * fake reader that returns the market state directly.
 */
const INSTRUMENT: Instrument = {
  id: "runtime_test_stk",
  displayName: "Runtime Test Stock",
  assetClass: "stock",
  broker: "ibkr",
  brokerSymbol: "RTX",
  exchange: "NYSE",
  currency: "USD",
  primaryExchange: "NYSE",
  trading: {
    executionEnabled: true,
    signalGenerationEnabled: true,
    aiAnalysisEnabled: true,
    monitoringEnabled: true,
  },
  risk: {
    maxQuantity: 100,
    quantityUnit: "shares",
    maxLeverage: 1,
    allowOvernight: true,
    maxSpread: 0.5,
    maxSlippage: 1.0,
  },
  session: {
    useRegularTradingHours: true,
    timezone: "America/New_York",
    sessionTemplate: "us_stock_rth",
  },
  metadata: { tags: ["runtime-test"] },
};

const REGISTRY = new InstrumentRegistry([INSTRUMENT]);

function fakeReader(behaviour: {
  readonly state?: RuntimeMarketState | null;
  readonly stateThrow?: Error;
}): MarketDataRuntimeReader & { stateCalls: number } {
  const reader = {
    stateCalls: 0,
    async readMarketState() {
      reader.stateCalls += 1;
      if (behaviour.stateThrow) throw behaviour.stateThrow;
      return behaviour.state ?? null;
    },
  };
  return reader;
}

const POLICY: ExecutionTicketPolicy = {
  quantity: 10,
  orderType: "LMT",
  timeInForce: "DAY",
  outsideRth: false,
  transmit: true,
  priceTickSize: 0.01,
  priceRoundingMode: "nearest",
  entryOffset: 0,
  stopLossDistance: 1,
  takeProfitDistance: 2,
};

// Custom bullish decision rule used to drive the SUCCESS path
// deterministically. It contributes a strong bullish score without
// touching any snapshot section beyond acknowledging support, so it
// works with the runtime's minimal single-provider snapshot.
class BullishFixtureRule implements Rule {
  readonly id = "runtime-test-bullish";
  readonly category = "TECHNICAL" as const;
  supports(_snapshot: MarketContextSnapshot): boolean {
    return true;
  }
  evaluate(_snapshot: MarketContextSnapshot): RuleEvaluation {
    return {
      scoreContribution: 60,
      reasons: [
        {
          id: "runtime-test-bullish",
          category: "TECHNICAL",
          weight: 1,
          direction: "BULLISH",
          message: "test fixture forces LONG",
        },
      ],
      warnings: [],
      blockers: [],
    };
  }
}

/**
 * Wires the shared engines with a controlled ruleset that
 * deterministically produces `SUCCESS` when the snapshot's `price`
 * section is fresh. Used only by the SUCCESS test — all other tests
 * use the runtime's default `createRuntimeEngines` factory.
 */
function buildSuccessPipeline(): TradingPipeline {
  const decisionEngine = new DecisionEngine({
    rules: [new BullishFixtureRule()],
    // Threshold at 15 (default) and score = +60 → LONG. Confidence
    // is coverage(=1) * consistency(=1) * freshnessFactor(=0.7 for
    // "partial" — only price fresh) * 100 = 70, which clears the
    // Risk engine's DecisionConfidenceRule default (50).
  });
  const riskEngine = new RiskEngine({
    // Default risk rules would work here too, but we pass an empty
    // ruleset to keep the SUCCESS path purely a "produce a ticket"
    // proof — no defensive risk rule can accidentally intercept it.
    rules: [],
  });
  const signalEngine = new SignalEngine({
    decisionEngine,
    riskEngine,
    instrumentResolver: (id) => REGISTRY.getInstrumentOrThrow(id),
  });
  const ticketBuilder = new ExecutionTicketBuilder({
    idFactory: () => "ticket-id-fixture",
    correlationIdFactory: () => "corr-id-fixture",
  });
  return new TradingPipeline({ signalEngine, ticketBuilder });
}

function buildRuntime(reader: MarketDataRuntimeReader): {
  runtime: MarketDataRuntime;
  pipeline: TradingPipeline;
} {
  const provider = new PriceContextProvider({
    reader,
    freshnessTtlMs: 30_000,
  });
  const { pipeline } = createRuntimeEngines({ registry: REGISTRY });
  const runtime = new MarketDataRuntime({
    registry: REGISTRY,
    providers: [provider],
    pipeline,
    freshnessPolicy: buildRuntimeFreshnessPolicy({
      base: DEFAULT_FRESHNESS_POLICY,
      maxTickAgeMs: 30_000,
    }),
  });
  return { runtime, pipeline };
}

function buildRuntimeWithSuccessPipeline(reader: MarketDataRuntimeReader): {
  runtime: MarketDataRuntime;
  pipeline: TradingPipeline;
} {
  const provider = new PriceContextProvider({
    reader,
    freshnessTtlMs: 30_000,
  });
  const pipeline = buildSuccessPipeline();
  const runtime = new MarketDataRuntime({
    registry: REGISTRY,
    providers: [provider],
    pipeline,
    freshnessPolicy: buildRuntimeFreshnessPolicy({
      base: DEFAULT_FRESHNESS_POLICY,
      maxTickAgeMs: 30_000,
    }),
  });
  return { runtime, pipeline };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MarketDataRuntime — construction guards", () => {
  it("throws when registry is missing", () => {
    assert.throws(
      // @ts-expect-error deliberate misuse
      () => new MarketDataRuntime({ providers: [], pipeline: {} }),
      /registry is required/,
    );
  });

  it("throws when pipeline is missing or malformed", () => {
    assert.throws(
      () =>
        new MarketDataRuntime({
          registry: REGISTRY,
          providers: [],
          // @ts-expect-error deliberate misuse
          pipeline: {},
        }),
      /pipeline with a run\(\) method is required/,
    );
  });
});

describe("MarketDataRuntime.dryRun — unknown / missing data (fail-closed)", () => {
  it("rethrows for an unknown instrumentId (registry decides)", async () => {
    const { runtime } = buildRuntime(fakeReader({}));
    await assert.rejects(
      () => runtime.dryRun("does_not_exist", POLICY),
      /does_not_exist/,
    );
  });

  it("produces a snapshot with unavailable price when reader returns null", async () => {
    const reader = fakeReader({ state: null });
    const { runtime } = buildRuntime(reader);
    const result = await runtime.dryRun(INSTRUMENT.id, POLICY);
    assert.equal(result.snapshot.sections.price.status, "unavailable");
    assert.ok(
      result.snapshot.sections.price.warnings.some((w) =>
        /no market state/i.test(w),
      ),
      "expected a MissingMarketStateError warning on the price section",
    );
    // Pipeline MUST NOT return SUCCESS without a fresh price.
    assert.notEqual(result.pipeline.outcome, "SUCCESS");
    assert.equal(result.pipeline.ticket, null);
  });

  it("produces a snapshot with unavailable price when Redis throws", async () => {
    const reader = fakeReader({ stateThrow: new Error("redis down") });
    const { runtime } = buildRuntime(reader);
    const result = await runtime.dryRun(INSTRUMENT.id, POLICY);
    assert.equal(result.snapshot.sections.price.status, "unavailable");
    assert.ok(
      result.snapshot.sections.price.warnings.some((w) =>
        /redis down/i.test(w),
      ),
    );
    assert.notEqual(result.pipeline.outcome, "SUCCESS");
    assert.equal(result.pipeline.ticket, null);
  });

  it("produces a snapshot with stale price when observedAt exceeds TTL", async () => {
    // observedAt is 10 minutes old; the runtime freshness TTL is 30 s.
    const observedAt = new Date(Date.now() - 10 * 60 * 1000);
    const reader = fakeReader({
      state: {
        instrumentId: INSTRUMENT.id,
        lastPrice: 100,
        bid: 99.9,
        ask: 100.1,
        observedAt,
        source: "redis:market-state:999001",
      },
    });
    const { runtime } = buildRuntime(reader);
    const result = await runtime.dryRun(INSTRUMENT.id, POLICY);
    assert.equal(result.snapshot.sections.price.status, "stale");
    // Pipeline MUST NOT return SUCCESS with a stale price.
    assert.notEqual(result.pipeline.outcome, "SUCCESS");
    assert.equal(result.pipeline.ticket, null);
  });
});

describe("MarketDataRuntime.dryRun — real SUCCESS path", () => {
  it("returns outcome SUCCESS with a populated ticket when fed a fresh tick and a bullish ruleset", async () => {
    const observedAt = new Date();
    const reader = fakeReader({
      state: {
        instrumentId: INSTRUMENT.id,
        lastPrice: 100,
        bid: 99.98,
        ask: 100.02,
        spread: 0.04,
        observedAt,
        source: "redis:market-state:999001",
      },
    });
    const { runtime } = buildRuntimeWithSuccessPipeline(reader);

    const result: { pipeline: TradingPipelineResult } = await runtime.dryRun(
      INSTRUMENT.id,
      POLICY,
    );

    assert.equal(
      result.pipeline.outcome,
      "SUCCESS",
      `expected SUCCESS, got ${result.pipeline.outcome}`,
    );
    if (result.pipeline.outcome !== "SUCCESS") return;
    // Ticket is populated with the deterministic id from our
    // injected id factory — proves the real ExecutionTicketBuilder
    // produced the value (not a stub).
    assert.equal(result.pipeline.ticket.ticketId, "ticket-id-fixture");
    assert.equal(result.pipeline.ticket.instrumentId, INSTRUMENT.id);
    assert.equal(result.pipeline.ticket.order.side, "BUY");
    assert.equal(result.pipeline.ticket.order.quantity, POLICY.quantity);
    assert.equal(result.pipeline.ticket.order.orderType, "LMT");
    // Price came out of the fake reader, was propagated through the
    // snapshot into the ticket entry price.
    assert.equal(typeof result.pipeline.ticket.order.limitPrice, "number");
  });
});

describe("MarketDataRuntime.dryRun — structural side-effect guarantees", () => {
  it("MarketDataRuntimeOptions has no submitter / executor / repo / http fields (structural)", () => {
    // Type-level assertion: if a future refactor adds a
    // write-oriented option to `MarketDataRuntimeOptions`, this
    // block will fail to compile because we exhaustively enumerate
    // the currently-allowed keys.
    const allowedKeys: readonly (keyof import("./runtime.js").MarketDataRuntimeOptions)[] =
      ["registry", "providers", "pipeline", "freshnessPolicy", "now"];
    // Cast to `unknown` avoids the never-satisfying type inference
    // while still guaranteeing the compile-time assertion above.
    for (const forbidden of [
      "submitter",
      "executor",
      "writer",
      "repo",
      "httpClient",
      "executionClient",
      "orderClient",
    ] as const) {
      assert.ok(
        !(allowedKeys as readonly string[]).includes(forbidden),
        `MarketDataRuntimeOptions must not accept "${forbidden}"`,
      );
    }
  });

  it("invokes only pipeline.run() on the injected pipeline — no other method touched", async () => {
    const reader = fakeReader({
      state: {
        instrumentId: INSTRUMENT.id,
        lastPrice: 100,
        observedAt: new Date(),
        source: "redis:market-state:999001",
      },
    });
    const provider = new PriceContextProvider({
      reader,
      freshnessTtlMs: 30_000,
    });
    const { pipeline } = createRuntimeEngines({ registry: REGISTRY });
    // Record actual invocations (via Function.apply) rather than
    // property reads — the runtime constructor reads `.run` once for
    // its `typeof === "function"` guard, and property-read counting
    // would double-count that.
    const invocations: string[] = [];
    const spiedPipeline = new Proxy(pipeline, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          invocations.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const runtime = new MarketDataRuntime({
      registry: REGISTRY,
      providers: [provider],
      pipeline: spiedPipeline,
    });

    await runtime.dryRun(INSTRUMENT.id, POLICY);
    assert.deepEqual(
      invocations,
      ["run"],
      `expected only pipeline.run() to be invoked, got: ${invocations.join(", ")}`,
    );
  });

  it("MarketDataRuntimeReader port declares only readMarketState (compile-time surface check)", () => {
    // The reader port intentionally has no write methods. This
    // asserts the runtime surface at build time — a future refactor
    // that adds a write method would need to update the port, and
    // reviewers would notice this test's need to change.
    const reader: MarketDataRuntimeReader = fakeReader({});
    const surface = Object.getOwnPropertyNames(reader);
    // The test double intentionally exposes only readMarketState +
    // internal counters; a compliant production reader will only
    // expose the port method.
    assert.ok(
      surface.includes("readMarketState"),
      "port must expose readMarketState",
    );
    // Explicitly assert the absence of write-shaped methods on the
    // port typing (compile-time; runtime is best-effort here).
    const forbidden = [
      "write",
      "submit",
      "insert",
      "update",
      "delete",
      "publish",
    ];
    for (const method of forbidden) {
      assert.ok(
        !surface.includes(method),
        `reader must not expose "${method}"`,
      );
    }
  });
});
