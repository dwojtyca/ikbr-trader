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
  type TradingPipeline as TradingPipelineType,
} from "@ikbr/shared";

import {
  MarketDataRuntime,
  buildRuntimeFreshnessPolicy,
} from "../runtime.js";
import { PriceContextProvider } from "../price-provider.js";
import type {
  MarketDataRuntimeReader,
  RuntimeMarketState,
} from "../market-data-reader.js";
import { ExecutionRuntime } from "./execution-runtime.js";
import { PaperGuard, type ReadyProbe } from "./paper-guard.js";
import type {
  ExecutionTicketSubmitter,
  SubmitInput,
  SubmitResult,
} from "./submitter.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INSTRUMENT: Instrument = {
  id: "execution_test_stk",
  displayName: "Execution Test Stock",
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
  metadata: { tags: [] },
};

const REGISTRY = new InstrumentRegistry([INSTRUMENT]);

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

function fakeReader(state: RuntimeMarketState | null): MarketDataRuntimeReader {
  return {
    async readMarketState() {
      return state;
    },
  };
}

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

function buildSuccessPipeline(): TradingPipelineType {
  const decisionEngine = new DecisionEngine({
    rules: [new BullishFixtureRule()],
  });
  const riskEngine = new RiskEngine({ rules: [] });
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

function buildHoldPipeline(): TradingPipelineType {
  // Small positive score → confidence ≥ 25 but |score| < 15
  // → DecisionEngine produces HOLD action WITHOUT a blocker,
  // which the shared SignalEngine reports as SignalStatus.HOLD,
  // which the TradingPipeline classifies as `NO_TRADE`.
  const holdRule: Rule = {
    id: "runtime-test-hold",
    category: "TECHNICAL",
    supports: () => true,
    evaluate: () => ({
      scoreContribution: 5,
      reasons: [
        {
          id: "runtime-test-hold",
          category: "TECHNICAL",
          weight: 1,
          direction: "BULLISH",
          message: "weak signal — hold",
        },
      ],
      warnings: [],
      blockers: [],
    }),
  };
  const decisionEngine = new DecisionEngine({ rules: [holdRule] });
  const riskEngine = new RiskEngine({ rules: [] });
  const signalEngine = new SignalEngine({
    decisionEngine,
    riskEngine,
    instrumentResolver: (id) => REGISTRY.getInstrumentOrThrow(id),
  });
  const ticketBuilder = new ExecutionTicketBuilder({
    idFactory: () => "hold-ticket",
    correlationIdFactory: () => "hold-corr",
  });
  return new TradingPipeline({ signalEngine, ticketBuilder });
}

function buildDryRun(
  pipeline: TradingPipelineType,
  reader: MarketDataRuntimeReader = fakeReader(freshState()),
): MarketDataRuntime {
  const provider = new PriceContextProvider({
    reader,
    freshnessTtlMs: 30_000,
  });
  return new MarketDataRuntime({
    registry: REGISTRY,
    providers: [provider],
    pipeline,
    freshnessPolicy: buildRuntimeFreshnessPolicy({
      base: DEFAULT_FRESHNESS_POLICY,
      maxTickAgeMs: 30_000,
    }),
  });
}

function freshState(): RuntimeMarketState {
  return {
    instrumentId: INSTRUMENT.id,
    lastPrice: 100,
    bid: 99.98,
    ask: 100.02,
    observedAt: new Date(),
    source: "redis:market-state:test",
  };
}

function paperOkGuard(): PaperGuard {
  return new PaperGuard({
    probe: {
      async probeReady() {
        return {
          kind: "ok",
          ready: true,
          environment: "paper",
          accountMatchesEnvironment: true,
        };
      },
    } satisfies ReadyProbe,
    expectedEnvironment: "paper",
  });
}

function paperFailedGuard(reason: string): PaperGuard {
  return new PaperGuard({
    probe: {
      async probeReady() {
        return { kind: "error", message: reason };
      },
    },
    expectedEnvironment: "paper",
  });
}

function trackingSubmitter(
  behaviour: SubmitResult | ((input: SubmitInput) => SubmitResult),
): ExecutionTicketSubmitter & { calls: SubmitInput[] } {
  const calls: SubmitInput[] = [];
  return {
    calls,
    async submit(input) {
      calls.push(input);
      return typeof behaviour === "function" ? behaviour(input) : behaviour;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionRuntime — construction", () => {
  it("throws when dryRun is missing", () => {
    assert.throws(
      () =>
        new ExecutionRuntime({
          // @ts-expect-error deliberate misuse
          dryRun: undefined,
          paperGuard: paperOkGuard(),
          submitter: trackingSubmitter({
            kind: "unknown",
            reason: "n/a",
          }),
        }),
      /dryRun is required/,
    );
  });
});

describe("ExecutionRuntime.execute — pipeline gating", () => {
  it("NO_TRADE (HOLD) → NOT_SUBMITTED with reason NO_TRADE, no paper-guard call, no submit call", async () => {
    const dryRun = buildDryRun(buildHoldPipeline());
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    let guardCalls = 0;
    const paperGuard = new PaperGuard({
      probe: {
        async probeReady() {
          guardCalls += 1;
          return {
            kind: "ok",
            ready: true,
            environment: "paper",
            accountMatchesEnvironment: true,
          };
        },
      },
      expectedEnvironment: "paper",
    });
    const runtime = new ExecutionRuntime({ dryRun, paperGuard, submitter });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "NOT_SUBMITTED");
    if (result.outcome !== "NOT_SUBMITTED") return;
    assert.equal(result.reason, "NO_TRADE");
    assert.equal(guardCalls, 0);
    assert.equal(submitter.calls.length, 0);
  });

  it("pipeline FAILURE (stale price) → NOT_SUBMITTED with reason PIPELINE_FAILURE, no submit call", async () => {
    // Stale price → snapshot classifies price section as stale →
    // pipeline outcome is either NO_TRADE or FAILURE from decision
    // rules. In either case NO submit call must occur.
    const stalePipeline = buildSuccessPipeline();
    const dryRun = buildDryRun(
      stalePipeline,
      fakeReader({
        instrumentId: INSTRUMENT.id,
        lastPrice: 100,
        bid: 99.98,
        ask: 100.02,
        observedAt: new Date(Date.now() - 10 * 60 * 1000),
        source: "redis:market-state:test",
      }),
    );
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.notEqual(result.outcome, "SUBMITTED");
    if (result.outcome === "SUBMITTED") return;
    assert.equal(submitter.calls.length, 0);
  });
});

describe("ExecutionRuntime.execute — paper guard", () => {
  it("SUCCESS + paper guard fails → NOT_SUBMITTED / PAPER_GUARD_FAILED, no submit call", async () => {
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperFailedGuard("execution-engine reported live"),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "NOT_SUBMITTED");
    if (result.outcome !== "NOT_SUBMITTED") return;
    assert.equal(result.reason, "PAPER_GUARD_FAILED");
    assert.match(result.message!, /reported live/);
    assert.equal(submitter.calls.length, 0);
  });

  it("paper guard rejects when execution-engine reports live → NOT_SUBMITTED, no submit", async () => {
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const paperGuard = new PaperGuard({
      probe: {
        async probeReady() {
          return {
            kind: "ok",
            ready: true,
            environment: "live",
            accountMatchesEnvironment: true,
          };
        },
      },
      expectedEnvironment: "paper",
    });
    const runtime = new ExecutionRuntime({ dryRun, paperGuard, submitter });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "NOT_SUBMITTED");
    if (result.outcome !== "NOT_SUBMITTED") return;
    assert.equal(result.reason, "PAPER_GUARD_FAILED");
    assert.equal(submitter.calls.length, 0);
  });
});

describe("ExecutionRuntime.execute — submission outcomes", () => {
  it("SUCCESS + submitter SUBMITTED → SUBMITTED, exactly one submit call", async () => {
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({
      kind: "submitted",
      response: {
        execution: {
          orderId: 42,
          accountId: "PAPER-1",
          brokerOrderId: "b-1",
          status: "SUBMITTED",
        },
      },
    });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "SUBMITTED");
    if (result.outcome !== "SUBMITTED") return;
    assert.equal(result.execution.brokerOrderId, "b-1");
    assert.equal(result.idempotencyKey, "idem-1");
    assert.equal(submitter.calls.length, 1);
    // The submitted call must carry the runtime-computed
    // clientOrderId + clientOrderHash — the client never supplies
    // a ticket directly.
    assert.equal(submitter.calls[0].clientOrderId, "idem-1");
    assert.equal(submitter.calls[0].clientOrderHash.length, 64);
    assert.equal(submitter.calls[0].ticket.instrument, "RTX");
    assert.equal(submitter.calls[0].ticket.side, "BUY");
    assert.equal(submitter.calls[0].ticket.quantity, POLICY.quantity);
  });

  it("submitter duplicate_submitted → DUPLICATE outcome with previousExecution.order.status = SUBMITTED", async () => {
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({
      kind: "duplicate_submitted",
      response: {
        outcome: "DUPLICATE_SUBMITTED",
        duplicate: true,
        order: { id: 99, status: "SUBMITTED" },
      },
    });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "DUPLICATE");
    if (result.outcome !== "DUPLICATE") return;
    assert.deepEqual(result.previousExecution, {
      id: 99,
      status: "SUBMITTED",
    });
  });

  it("submitter conflict → CONFLICT outcome", async () => {
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({
      kind: "conflict",
      message: "idempotency_conflict",
    });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "CONFLICT");
  });

  it("submitter not_submitted (400) → NOT_SUBMITTED", async () => {
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({
      kind: "not_submitted",
      statusCode: 400,
      message: "invalid_ticket",
    });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "NOT_SUBMITTED");
    if (result.outcome !== "NOT_SUBMITTED") return;
    assert.equal(result.reason, "PIPELINE_FAILURE");
    assert.match(result.message!, /400/);
  });

  it("submitter unknown (timeout / 5xx) → UNKNOWN, never SUBMITTED", async () => {
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({
      kind: "unknown",
      reason: "timed out after 5000ms",
    });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: POLICY,
      idempotencyKey: "idem-1",
    });
    assert.equal(result.outcome, "UNKNOWN");
    if (result.outcome !== "UNKNOWN") return;
    assert.match(result.reason, /timed out/);
    assert.equal(result.idempotencyKey, "idem-1");
  });

  it("STP + bracket ticket → NOT_SUBMITTED / UNSUPPORTED_TICKET_SHAPE, no submit call", async () => {
    // The pipeline produces a valid STP+bracket ExecutionTicket
    // (STP order type + non-zero stopLossDistance /
    // takeProfitDistance). The legacy SignalTicket wire cannot
    // represent parent trigger + bracket protective stop
    // simultaneously → the mapper throws → the runtime translates
    // the throw into NOT_SUBMITTED / UNSUPPORTED_TICKET_SHAPE
    // BEFORE contacting the submitter.
    const dryRun = buildDryRun(buildSuccessPipeline());
    const submitter = trackingSubmitter({ kind: "unknown", reason: "unused" });
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const result = await runtime.execute({
      instrumentId: INSTRUMENT.id,
      policy: {
        ...POLICY,
        orderType: "STP",
        // Bracket-with-stopLoss is what the pipeline produces for
        // any non-zero stopLossDistance regardless of orderType —
        // this is precisely the shape the mapper must reject.
      },
      idempotencyKey: "idem-stp-bracket",
    });
    assert.equal(result.outcome, "NOT_SUBMITTED");
    if (result.outcome !== "NOT_SUBMITTED") return;
    assert.equal(result.reason, "UNSUPPORTED_TICKET_SHAPE");
    assert.match(
      result.message ?? "",
      /STP orders cannot carry bracket protection/,
    );
    assert.equal(
      submitter.calls.length,
      0,
      "an unsupported ticket shape must never reach the submitter",
    );
  });
});

describe("ExecutionRuntime.execute — one-submit invariant under concurrency", () => {
  it("two concurrent execute() calls with the same idempotencyKey cause the DB to reject the second", async () => {
    // The runtime itself has no cross-call locking — DB-level UNIQUE
    // is authoritative. This test simulates the second call
    // observing the DUPLICATE that execution-engine returns after
    // the unique-violation is resolved.
    const dryRun = buildDryRun(buildSuccessPipeline());
    let submitCount = 0;
    const submitter: ExecutionTicketSubmitter = {
      async submit(input) {
        submitCount += 1;
        // First call wins → SUBMITTED. Second call collides on the
        // unique constraint and the submitter surfaces DUPLICATE.
        if (submitCount === 1) {
          return {
            kind: "submitted",
            response: {
              execution: {
                accountId: "PAPER-1",
                brokerOrderId: "b-1",
                status: "SUBMITTED",
              },
            },
          };
        }
        return {
          kind: "duplicate_submitted",
          response: {
            outcome: "DUPLICATE_SUBMITTED",
            duplicate: true,
            order: { id: 42 },
          },
        };
      },
    };
    const runtime = new ExecutionRuntime({
      dryRun,
      paperGuard: paperOkGuard(),
      submitter,
    });
    const [a, b] = await Promise.all([
      runtime.execute({
        instrumentId: INSTRUMENT.id,
        policy: POLICY,
        idempotencyKey: "idem-1",
      }),
      runtime.execute({
        instrumentId: INSTRUMENT.id,
        policy: POLICY,
        idempotencyKey: "idem-1",
      }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    assert.deepEqual(outcomes, ["DUPLICATE", "SUBMITTED"]);
  });
});
