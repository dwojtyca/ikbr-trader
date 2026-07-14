import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildSnapshot } from "../decision-engine/snapshot.testfixture.js";
import {
  buildDecision,
  buildInstrument,
} from "../risk-engine/risk-input.testfixture.js";
import type { DecisionResult } from "../decision-engine/types.js";
import type {
  ExecutionTicket,
  ExecutionTicketBuildResult,
  ExecutionTicketPolicy,
} from "../execution-ticket/types.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type { RiskEvaluation } from "../risk-engine/types.js";
import type {
  SignalEvaluation,
  SignalStatus,
  SignalWarningSource,
} from "../signal-engine/types.js";

import {
  TRADING_PIPELINE_VERSION,
  TradingPipeline,
  type ExecutionTicketBuilderLike,
  type SignalEngineLike,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildRisk(overrides: Partial<RiskEvaluation> = {}): RiskEvaluation {
  return {
    approved: overrides.approved ?? true,
    riskScore: overrides.riskScore ?? 20,
    warnings: overrides.warnings ?? [],
    blockers: overrides.blockers ?? [],
    metadata: overrides.metadata ?? {
      engineVersion: "0.1.0",
      evaluationTimeMs: 1,
    },
  };
}

interface SignalOverrides {
  readonly status?: SignalStatus;
  readonly decision?: DecisionResult | null;
  readonly risk?: RiskEvaluation | null;
  readonly instrumentId?: string;
  readonly warnings?: SignalEvaluation["warnings"];
  readonly reasonSummary?: string;
  readonly decisionVersion?: string;
  readonly riskVersion?: string;
}

function buildSignal(overrides: SignalOverrides = {}): SignalEvaluation {
  const decision =
    overrides.decision === undefined
      ? buildDecision({ action: "LONG", confidence: 80 })
      : overrides.decision;
  const risk =
    overrides.risk === undefined ? buildRisk() : overrides.risk;
  const status = overrides.status ?? "GENERATED";
  return {
    signalId: "signal-fixture",
    generatedAt: new Date("2026-07-13T12:00:05Z"),
    instrumentId: overrides.instrumentId ?? "ctx_fut",
    decision,
    risk,
    status,
    reasonSummary: overrides.reasonSummary ?? `${status} — fixture`,
    warnings: overrides.warnings ?? [],
    metadata: {
      engineVersions: {
        signal: "0.1.0",
        ...(overrides.decisionVersion !== undefined
          ? { decision: overrides.decisionVersion }
          : decision
            ? { decision: "0.1.0" }
            : {}),
        ...(overrides.riskVersion !== undefined
          ? { risk: overrides.riskVersion }
          : risk
            ? { risk: "0.1.0" }
            : {}),
      },
      evaluationTimeMs: 2,
    },
  };
}

function buildTicket(overrides: Partial<ExecutionTicket> = {}): ExecutionTicket {
  return {
    ticketId: overrides.ticketId ?? "ticket-fixture",
    createdAt: overrides.createdAt ?? new Date("2026-07-13T12:00:06Z"),
    signalId: overrides.signalId ?? "signal-fixture",
    decisionId: overrides.decisionId ?? "decision-fixture",
    instrumentId: overrides.instrumentId ?? "ctx_fut",
    broker: overrides.broker ?? "ibkr",
    brokerSymbol: overrides.brokerSymbol ?? "CX",
    exchange: overrides.exchange ?? "CME",
    currency: overrides.currency ?? "USD",
    order: overrides.order ?? {
      side: "BUY",
      quantity: 1,
      quantityUnit: "contracts",
      orderType: "LMT",
      limitPrice: 100.5,
      timeInForce: "DAY",
      outsideRth: false,
      transmit: true,
    },
    protection: overrides.protection ?? { bracketEnabled: false },
    metadata: overrides.metadata ?? {
      signalEngineVersion: "0.1.0",
      decisionEngineVersion: "0.1.0",
      riskEngineVersion: "0.1.0",
      builderVersion: "0.1.0",
      correlationId: "corr-fixture",
    },
  };
}

function policyFixture(
  overrides: Partial<ExecutionTicketPolicy> = {},
): ExecutionTicketPolicy {
  return {
    quantity: overrides.quantity ?? 1,
    orderType: overrides.orderType ?? "LMT",
    timeInForce: overrides.timeInForce ?? "DAY",
    outsideRth: overrides.outsideRth ?? false,
    transmit: overrides.transmit ?? true,
    priceTickSize: overrides.priceTickSize ?? 0.25,
    priceRoundingMode: overrides.priceRoundingMode ?? "nearest",
    ...(overrides.entryOffset !== undefined
      ? { entryOffset: overrides.entryOffset }
      : {}),
    ...(overrides.stopLossDistance !== undefined
      ? { stopLossDistance: overrides.stopLossDistance }
      : {}),
    ...(overrides.takeProfitDistance !== undefined
      ? { takeProfitDistance: overrides.takeProfitDistance }
      : {}),
    ...(overrides.trailingStopDistance !== undefined
      ? { trailingStopDistance: overrides.trailingStopDistance }
      : {}),
  };
}

// Fake engines --------------------------------------------------------------

function fakeSignalEngine(
  behaviour:
    | { readonly kind: "return"; readonly signal: SignalEvaluation }
    | { readonly kind: "throw"; readonly error: unknown },
): SignalEngineLike & { callCount: number } {
  const engine = {
    callCount: 0,
    evaluate(_snapshot: MarketContextSnapshot): SignalEvaluation {
      engine.callCount += 1;
      if (behaviour.kind === "throw") {
        throw behaviour.error;
      }
      return behaviour.signal;
    },
  };
  return engine;
}

function fakeTicketBuilder(
  behaviour:
    | { readonly kind: "return"; readonly result: ExecutionTicketBuildResult }
    | { readonly kind: "throw"; readonly error: unknown },
): ExecutionTicketBuilderLike & { callCount: number } {
  const builder = {
    callCount: 0,
    build(_input: Parameters<ExecutionTicketBuilderLike["build"]>[0]) {
      builder.callCount += 1;
      if (behaviour.kind === "throw") {
        throw behaviour.error;
      }
      return behaviour.result;
    },
  };
  return builder;
}

// Common inputs -------------------------------------------------------------

function baseSnapshot(): MarketContextSnapshot {
  return buildSnapshot();
}

function baseInstrument(): Instrument {
  return buildInstrument();
}

function makePipeline(options: {
  readonly signal: ReturnType<typeof fakeSignalEngine>;
  readonly ticket: ReturnType<typeof fakeTicketBuilder>;
  readonly nowValues?: readonly Date[];
  readonly perfValues?: readonly number[];
  readonly version?: string;
}): TradingPipeline {
  let nowIdx = 0;
  let perfIdx = 0;
  const nowValues = options.nowValues ?? [new Date("2026-07-13T13:00:00Z")];
  const perfValues = options.perfValues ?? [1000, 1050];
  return new TradingPipeline({
    signalEngine: options.signal,
    ticketBuilder: options.ticket,
    now: () => {
      const v = nowValues[Math.min(nowIdx, nowValues.length - 1)];
      nowIdx += 1;
      return v;
    },
    performanceNow: () => {
      const v = perfValues[Math.min(perfIdx, perfValues.length - 1)];
      perfIdx += 1;
      return v;
    },
    ...(options.version !== undefined ? { version: options.version } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TradingPipeline — constructor", () => {
  it("throws when signalEngine is missing", () => {
    assert.throws(
      () =>
        new TradingPipeline({
          // @ts-expect-error — deliberate misuse
          signalEngine: undefined,
          ticketBuilder: fakeTicketBuilder({
            kind: "return",
            result: { ok: true, ticket: buildTicket(), warnings: [] },
          }),
        }),
      /signalEngine with an evaluate\(\) method is required/,
    );
  });

  it("throws when ticketBuilder is missing", () => {
    assert.throws(
      () =>
        new TradingPipeline({
          signalEngine: fakeSignalEngine({ kind: "return", signal: buildSignal() }),
          // @ts-expect-error — deliberate misuse
          ticketBuilder: {},
        }),
      /ticketBuilder with a build\(\) method is required/,
    );
  });
});

describe("TradingPipeline — SUCCESS", () => {
  it("returns outcome SUCCESS with signal, ticket, warnings, duration and metadata", () => {
    const signal = buildSignal({ status: "GENERATED" });
    const ticket = buildTicket();
    const signalEngine = fakeSignalEngine({ kind: "return", signal });
    const builder = fakeTicketBuilder({
      kind: "return",
      result: { ok: true, ticket, warnings: [] },
    });
    const pipeline = makePipeline({
      signal: signalEngine,
      ticket: builder,
      perfValues: [1000, 1042],
      nowValues: [new Date("2026-07-13T13:00:00Z")],
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.strictEqual(result.signal, signal);
    assert.strictEqual(result.ticket, ticket);
    assert.equal(result.durationMs, 42);
    assert.deepEqual(result.metadata.engineVersions, {
      pipeline: TRADING_PIPELINE_VERSION,
      signal: "0.1.0",
      decision: "0.1.0",
      risk: "0.1.0",
      ticketBuilder: "0.1.0",
    });
    assert.equal(
      result.metadata.ranAt.toISOString(),
      "2026-07-13T13:00:00.000Z",
    );
    assert.deepEqual(result.warnings, []);
    assert.equal(signalEngine.callCount, 1);
    assert.equal(builder.callCount, 1);
  });

  it("merges signal + ticket warnings on success", () => {
    const signal = buildSignal({
      status: "GENERATED",
      warnings: [
        {
          code: "SIGNAL_INFO",
          message: "info",
          source: "signal-engine" as SignalWarningSource,
        },
      ],
    });
    const ticket = buildTicket();
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: {
          ok: true,
          ticket,
          warnings: [
            {
              code: "PROTECTION_ROUNDED",
              message: "rounded",
              source: "pricing",
            },
          ],
        },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.deepEqual(result.warnings, [
      { code: "SIGNAL_INFO", message: "info", source: "signal-engine" },
      { code: "PROTECTION_ROUNDED", message: "rounded", source: "pricing" },
    ]);
  });
});

describe("TradingPipeline — NO_TRADE (HOLD is not a failure)", () => {
  it("HOLD → outcome NO_TRADE, reason HOLD, no blockers, no ticket call", () => {
    const decision = buildDecision({ action: "HOLD" });
    const signal = buildSignal({ status: "HOLD", decision });
    const builder = fakeTicketBuilder({
      kind: "return",
      result: { ok: true, ticket: buildTicket(), warnings: [] },
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: builder,
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "NO_TRADE");
    if (result.outcome !== "NO_TRADE") return;
    assert.strictEqual(result.signal, signal);
    assert.equal(result.ticket, null);
    assert.equal(result.reason, "HOLD");
    // No pipeline-level blockers field on NO_TRADE.
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "blockers"),
      false,
    );
    // No failedStage on NO_TRADE.
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "failedStage"),
      false,
    );
    assert.equal(builder.callCount, 0);
  });

  it("HOLD forwards signal-engine warnings but does not synthesise its own", () => {
    const signal = buildSignal({
      status: "HOLD",
      decision: buildDecision({ action: "HOLD" }),
      warnings: [
        {
          code: "DECISION_TIE",
          message: "score cancelled out",
          source: "decision-engine" as SignalWarningSource,
        },
      ],
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.outcome, "NO_TRADE");
    if (result.outcome !== "NO_TRADE") return;
    assert.deepEqual(result.warnings, [
      {
        code: "DECISION_TIE",
        message: "score cancelled out",
        source: "decision-engine",
      },
    ]);
  });

  it("NO_TRADE result carries durationMs and full metadata", () => {
    const signal = buildSignal({ status: "HOLD" });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      perfValues: [10, 27],
      nowValues: [new Date("2028-02-02T00:00:00.000Z")],
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.outcome, "NO_TRADE");
    if (result.outcome !== "NO_TRADE") return;
    assert.equal(result.durationMs, 17);
    assert.equal(
      result.metadata.ranAt.toISOString(),
      "2028-02-02T00:00:00.000Z",
    );
    assert.deepEqual(result.metadata.engineVersions, {
      pipeline: TRADING_PIPELINE_VERSION,
      signal: "0.1.0",
      decision: "0.1.0",
      risk: "0.1.0",
    });
  });
});

describe("TradingPipeline — FAILURE from signal status", () => {
  it("BLOCKED → failedStage DECISION, no pipeline blockers, signal preserved with decision.blockedBy", () => {
    const decision = buildDecision({
      action: "HOLD",
      blockedBy: [
        { code: "STALE_DATA", message: "candles stale" },
        { code: "MARKET_CLOSED", message: "closed" },
      ],
    });
    const signal = buildSignal({ status: "BLOCKED", decision });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "DECISION");
    // Pipeline does NOT copy decision blockers into its own list.
    assert.deepEqual(result.blockers, []);
    // Authoritative diagnostics still available via signal.decision.blockedBy.
    assert.strictEqual(result.signal, signal);
    assert.deepEqual(
      (result.signal!.decision?.blockedBy ?? []).map((b) => b.code),
      ["STALE_DATA", "MARKET_CLOSED"],
    );
  });

  it("REJECTED → failedStage RISK, no pipeline blockers, signal preserved with risk.blockers", () => {
    // Use an existing RiskBlockerCode. LOW_CONFIDENCE is one of the
    // enumerated codes in `packages/shared/src/risk-engine/types.ts`;
    // fabricating strings like MAX_QUANTITY_EXCEEDED would violate
    // that domain model.
    const risk = buildRisk({
      approved: false,
      blockers: [
        {
          code: "LOW_CONFIDENCE",
          message: "confidence below threshold",
          ruleId: "confidence-threshold",
        },
      ],
    });
    const signal = buildSignal({ status: "REJECTED", risk });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "RISK");
    assert.deepEqual(result.blockers, []);
    assert.strictEqual(result.signal, signal);
    assert.deepEqual(
      (result.signal!.risk?.blockers ?? []).map((b) => b.code),
      ["LOW_CONFIDENCE"],
    );
  });

  it("ERROR + decision-engine warning → failedStage DECISION, no pipeline blockers", () => {
    const signal = buildSignal({
      status: "ERROR",
      decision: null,
      risk: null,
      warnings: [
        {
          code: "DECISION_ENGINE_THREW",
          message: "boom",
          source: "decision-engine" as SignalWarningSource,
        },
      ],
      reasonSummary: "ERROR — boom",
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "DECISION");
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ["DECISION_ENGINE_THREW"],
    );
  });

  it("ERROR + risk-engine warning → failedStage RISK, no pipeline blockers", () => {
    const signal = buildSignal({
      status: "ERROR",
      warnings: [
        {
          code: "RISK_ENGINE_THREW",
          message: "boom",
          source: "risk-engine" as SignalWarningSource,
        },
      ],
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "RISK");
    assert.deepEqual(result.blockers, []);
  });

  it("ERROR + signal-engine warning → failedStage SIGNAL, no pipeline blockers", () => {
    const signal = buildSignal({
      status: "ERROR",
      warnings: [
        {
          code: "SIGNAL_STAGE",
          message: "boom",
          source: "signal-engine" as SignalWarningSource,
        },
      ],
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "SIGNAL");
    assert.deepEqual(result.blockers, []);
  });

  it("ERROR + instrument-registry warning → failedStage SIGNAL", () => {
    const signal = buildSignal({
      status: "ERROR",
      warnings: [
        {
          code: "INSTRUMENT_NOT_FOUND",
          message: "unknown",
          source: "instrument-registry" as SignalWarningSource,
        },
      ],
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "SIGNAL");
    assert.deepEqual(result.blockers, []);
  });
});

describe("TradingPipeline — TICKET failure", () => {
  it("GENERATED signal + ticket !ok → failedStage TICKET, blockers stamped TICKET", () => {
    const signal = buildSignal({ status: "GENERATED" });
    const ticketFailure: ExecutionTicketBuildResult = {
      ok: false,
      ticket: null,
      blockers: [
        { code: "PRICE_MISSING", message: "no price", source: "snapshot" },
      ],
      warnings: [
        {
          code: "PRICE_SOURCE_FALLBACK",
          message: "fallback",
          source: "pricing",
        },
      ],
    };
    const builder = fakeTicketBuilder({ kind: "return", result: ticketFailure });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: builder,
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "TICKET");
    assert.strictEqual(result.signal, signal);
    assert.equal(result.ticket, null);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].code, "PRICE_MISSING");
    assert.equal(result.blockers[0].source, "snapshot");
    assert.equal(result.blockers[0].stage, "TICKET");
    // Ticket warnings must be surfaced on failure too.
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ["PRICE_SOURCE_FALLBACK"],
    );
    assert.equal(builder.callCount, 1);
  });

  it("skips ticket builder when signal is HOLD (NO_TRADE)", () => {
    const signal = buildSignal({ status: "HOLD" });
    const builder = fakeTicketBuilder({
      kind: "return",
      result: { ok: true, ticket: buildTicket(), warnings: [] },
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: builder,
    });

    pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(builder.callCount, 0);
  });

  it("skips ticket builder when signal is BLOCKED (FAILURE)", () => {
    const signal = buildSignal({
      status: "BLOCKED",
      decision: buildDecision({
        action: "HOLD",
        blockedBy: [{ code: "STALE_DATA", message: "stale" }],
      }),
    });
    const builder = fakeTicketBuilder({
      kind: "return",
      result: { ok: true, ticket: buildTicket(), warnings: [] },
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: builder,
    });

    pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(builder.callCount, 0);
  });
});

describe("TradingPipeline — error isolation (UNKNOWN)", () => {
  it("signal engine throws → failedStage UNKNOWN, signal null, no ticket call", () => {
    const builder = fakeTicketBuilder({
      kind: "return",
      result: { ok: true, ticket: buildTicket(), warnings: [] },
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "throw",
        error: new Error("engine exploded"),
      }),
      ticket: builder,
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "UNKNOWN");
    assert.equal(result.signal, null);
    assert.equal(result.ticket, null);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].code, "PIPELINE_SIGNAL_STAGE_THREW");
    assert.equal(result.blockers[0].source, "trading-pipeline");
    assert.equal(result.blockers[0].stage, "UNKNOWN");
    assert.match(result.blockers[0].message, /engine exploded/);
    assert.equal(builder.callCount, 0);
  });

  it("ticket builder throws → failedStage UNKNOWN, signal preserved, single pipeline blocker", () => {
    const signal = buildSignal({ status: "GENERATED" });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "throw",
        error: new Error("builder exploded"),
      }),
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.failedStage, "UNKNOWN");
    assert.strictEqual(result.signal, signal);
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].code, "PIPELINE_TICKET_STAGE_THREW");
    assert.equal(result.blockers[0].source, "trading-pipeline");
    assert.match(result.blockers[0].message, /builder exploded/);
  });

  it("non-Error throws are stringified without leaking [object Object]", () => {
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "throw", error: { reason: "boom" } }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.doesNotMatch(result.blockers[0].message, /\[object Object\]/);
    assert.match(result.blockers[0].message, /boom/);
  });
});

describe("TradingPipeline — deterministic clocks & metadata", () => {
  it("uses the injected now() for metadata.ranAt", () => {
    const ranAt = new Date("2027-01-02T03:04:05.000Z");
    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      nowValues: [ranAt],
      perfValues: [0, 5],
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.metadata.ranAt.toISOString(), ranAt.toISOString());
  });

  it("computes durationMs from injected performanceNow delta", () => {
    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      perfValues: [500, 812],
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.durationMs, 312);
  });

  it("FAILURE result carries durationMs and metadata (no ticket version)", () => {
    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({
          status: "REJECTED",
          risk: buildRisk({
            approved: false,
            blockers: [{ code: "HIGH_RISK_SCORE", message: "risky" }],
          }),
        }),
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      perfValues: [10, 25],
      nowValues: [new Date("2028-01-01T00:00:00.000Z")],
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(result.durationMs, 15);
    assert.equal(
      result.metadata.ranAt.toISOString(),
      "2028-01-01T00:00:00.000Z",
    );
    assert.equal(result.metadata.engineVersions.pipeline, TRADING_PIPELINE_VERSION);
    // ticketBuilder version absent because ticket stage did not run.
    assert.equal(result.metadata.engineVersions.ticketBuilder, undefined);
  });

  it("exposes signal + decision + risk versions when signal stage ran", () => {
    const signal = buildSignal({
      status: "GENERATED",
      decisionVersion: "0.9.9",
      riskVersion: "0.8.8",
    });
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      version: "test-pipeline-1",
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.deepEqual(result.metadata.engineVersions, {
      pipeline: "test-pipeline-1",
      signal: "0.1.0",
      decision: "0.9.9",
      risk: "0.8.8",
      ticketBuilder: "0.1.0",
    });
  });

  it("UNKNOWN failure metadata has only pipeline version populated", () => {
    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "throw", error: new Error("x") }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.deepEqual(result.metadata.engineVersions, {
      pipeline: TRADING_PIPELINE_VERSION,
    });
  });
});

describe("TradingPipeline — deep freeze", () => {
  it("freezes the success result, ticket, warnings and metadata", () => {
    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: {
          ok: true,
          ticket: buildTicket(),
          warnings: [
            { code: "W", message: "m", source: "pricing" },
          ],
        },
      }),
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.warnings), true);
    assert.equal(Object.isFrozen(result.metadata), true);
    assert.equal(Object.isFrozen(result.metadata.engineVersions), true);
    if (result.outcome === "SUCCESS") {
      assert.equal(Object.isFrozen(result.ticket), true);
    }
    assert.throws(() => {
      (result as unknown as Record<string, unknown>).outcome = "FAILURE";
    });
  });

  it("freezes the NO_TRADE result and its metadata", () => {
    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "HOLD" }),
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.outcome, "NO_TRADE");
    if (result.outcome !== "NO_TRADE") return;
    assert.equal(Object.isFrozen(result.warnings), true);
    assert.equal(Object.isFrozen(result.metadata), true);
    assert.throws(() => {
      (result as unknown as Record<string, unknown>).reason = "OTHER";
    });
  });

  it("freezes the failure result, blockers and warnings", () => {
    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({
          status: "REJECTED",
          risk: buildRisk({
            approved: false,
            blockers: [{ code: "HIGH_RISK_SCORE", message: "no" }],
          }),
        }),
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.outcome, "FAILURE");
    if (result.outcome !== "FAILURE") return;
    assert.equal(Object.isFrozen(result.blockers), true);
    assert.equal(Object.isFrozen(result.warnings), true);
    assert.equal(Object.isFrozen(result.metadata), true);
  });
});

// ---------------------------------------------------------------------------
// Full error-isolation contract
// ---------------------------------------------------------------------------
//
// `TradingPipeline.run()` MUST NOT propagate any exception. The tests
// below exercise every non-engine code path that could otherwise leak
// a throw: broken clocks, hostile signal getters, and freeze failures.
// Each test asserts:
//   - `run()` returns normally (no assert.throws around the call),
//   - the result is well-formed (correct discriminator + required fields),
//   - a broken clock is NEVER re-invoked (call-count checks).

describe("TradingPipeline — full error isolation (clocks)", () => {
  it("now() throws → still succeeds, ranAt falls back to epoch, now called exactly once", () => {
    let nowCalls = 0;
    let perfCalls = 0;
    const signal = buildSignal({ status: "GENERATED" });
    const pipeline = new TradingPipeline({
      signalEngine: fakeSignalEngine({ kind: "return", signal }),
      ticketBuilder: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      now: () => {
        nowCalls += 1;
        throw new Error("wall clock broken");
      },
      performanceNow: () => {
        perfCalls += 1;
        return perfCalls * 10;
      },
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    // Fallback epoch used for ranAt.
    assert.equal(result.metadata.ranAt.getTime(), 0);
    // Broken clock consulted exactly once — never re-invoked.
    assert.equal(nowCalls, 1);
    // Monotonic clock still worked: durationMs is a plausible delta.
    assert.equal(result.durationMs, 10);
  });

  it("first performanceNow() throws → still succeeds, durationMs = 0, perf never reused", () => {
    let perfCalls = 0;
    const signal = buildSignal({ status: "GENERATED" });
    const pipeline = new TradingPipeline({
      signalEngine: fakeSignalEngine({ kind: "return", signal }),
      ticketBuilder: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      now: () => new Date("2027-01-01T00:00:00.000Z"),
      performanceNow: () => {
        perfCalls += 1;
        // Only the FIRST call throws. If the pipeline (illegally)
        // re-invokes it, the second call would return a normal number
        // and mask the bug — so we throw on every call to make
        // reuse obvious via count.
        throw new Error("perf clock broken");
      },
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.equal(result.durationMs, 0);
    // Pipeline must NOT reuse the broken start clock at the end.
    assert.equal(perfCalls, 1);
    // Wall clock still worked.
    assert.equal(
      result.metadata.ranAt.toISOString(),
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("final performanceNow() throws → still succeeds, durationMs = 0", () => {
    let perfCalls = 0;
    const signal = buildSignal({ status: "GENERATED" });
    const pipeline = new TradingPipeline({
      signalEngine: fakeSignalEngine({ kind: "return", signal }),
      ticketBuilder: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      now: () => new Date("2027-01-01T00:00:00.000Z"),
      performanceNow: () => {
        perfCalls += 1;
        if (perfCalls === 1) return 500;
        throw new Error("perf clock broken at end");
      },
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());

    assert.equal(result.outcome, "SUCCESS");
    if (result.outcome !== "SUCCESS") return;
    assert.equal(result.durationMs, 0);
    assert.equal(perfCalls, 2);
  });

  it("now() returns invalid Date (NaN) → treated as broken, falls back to epoch", () => {
    const pipeline = new TradingPipeline({
      signalEngine: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticketBuilder: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      now: () => new Date(NaN),
      performanceNow: () => 42,
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.metadata.ranAt.getTime(), 0);
  });

  it("performanceNow() returns non-finite → durationMs falls back to 0", () => {
    const pipeline = new TradingPipeline({
      signalEngine: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticketBuilder: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      now: () => new Date("2027-01-01T00:00:00.000Z"),
      performanceNow: () => Number.POSITIVE_INFINITY,
    });
    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.durationMs, 0);
  });

  it(
    "measureDuration() memoized: end clock throws in one branch, then a further internal error fires; performanceNow still called exactly twice",
    () => {
      // Timeline:
      //   1. run() reads start clock: perf(1) → 500 (ok)
      //   2. signal engine throws → runSignalStep captures the throw.
      //   3. In the `signalOutcome.errored` branch, `measureDuration()`
      //      runs BEFORE the blocker literal (defensive ordering).
      //      That is the first call to `measureDuration`:
      //        - perf(2) → THROWS
      //        - cached duration = 0
      //   4. The blocker literal then evaluates
      //      `describeUnknownError(hostileError)`, which reads
      //      `error.message`. That getter is hostile → throws.
      //   5. The top-level `run()` catch fires.
      //      It calls `measureDuration()` again via `trySafe`.
      //      Memoization MUST make it return the cached 0 without
      //      re-invoking `performanceNow` — otherwise perf would be
      //      called a third time here.
      //
      // Assertions:
      //   - perf call count === 2 (never a third call)
      //   - outcome FAILURE / PIPELINE_INTERNAL_ERROR
      //   - durationMs === 0
      let perfCalls = 0;
      const perf = () => {
        perfCalls += 1;
        if (perfCalls === 1) return 500;
        throw new Error(`perf broken on call ${perfCalls}`);
      };

      // Hostile Error-like: `instanceof Error` is true (so
      // `describeUnknownError` takes the `.message` branch), but
      // reading `.message` throws.
      const hostileError = new Error("outer") as Error;
      Object.defineProperty(hostileError, "message", {
        get: () => {
          throw new Error("hostile message getter");
        },
        configurable: false,
      });

      const pipeline = new TradingPipeline({
        signalEngine: fakeSignalEngine({
          kind: "throw",
          error: hostileError,
        }),
        ticketBuilder: fakeTicketBuilder({
          kind: "return",
          result: { ok: true, ticket: buildTicket(), warnings: [] },
        }),
        now: () => new Date("2027-05-05T05:05:05.000Z"),
        performanceNow: perf,
      });

      let result: ReturnType<TradingPipeline["run"]>;
      assert.doesNotThrow(() => {
        result = pipeline.run(
          baseSnapshot(),
          baseInstrument(),
          policyFixture(),
        );
      });

      // Memoization is the whole point: perf MUST be invoked at
      // most twice per `run()` even when multiple code paths call
      // `measureDuration()`.
      assert.equal(
        perfCalls,
        2,
        `performanceNow should be called exactly twice, got ${perfCalls}`,
      );
      assert.equal(result!.outcome, "FAILURE");
      if (result!.outcome !== "FAILURE") return;
      assert.equal(result!.failedStage, "UNKNOWN");
      assert.equal(result!.blockers.length, 1);
      assert.equal(result!.blockers[0].code, "PIPELINE_INTERNAL_ERROR");
      assert.equal(result!.durationMs, 0);
    },
  );

  it("measureDuration() memoized in the happy path too: performanceNow called exactly twice", () => {
    // Baseline: even without any error, performanceNow must be
    // called exactly twice — once for the start, once inside
    // `measureDuration()`. Multiple internal invocations of the
    // memoized function do not multiply clock calls.
    let perfCalls = 0;
    const pipeline = new TradingPipeline({
      signalEngine: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticketBuilder: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
      now: () => new Date("2027-06-06T06:06:06.000Z"),
      performanceNow: () => {
        perfCalls += 1;
        return perfCalls * 100;
      },
    });

    const result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    assert.equal(result.outcome, "SUCCESS");
    assert.equal(perfCalls, 2);
    assert.equal(result.durationMs, 100);
  });
});

describe("TradingPipeline — full error isolation (hostile signal object)", () => {
  it("signal returns a malformed runtime object (getter throws) → does not leak, returns PIPELINE_INTERNAL_ERROR", () => {
    // Build a valid signal, then replace the `status` property with a
    // getter that throws. This escapes the try/catch around
    // `engine.evaluate()` because the signal is already returned; the
    // throw happens later when the pipeline reads `.status` while
    // classifying the outcome.
    const base = buildSignal({ status: "GENERATED" });
    const hostile = { ...base };
    Object.defineProperty(hostile, "status", {
      get: () => {
        throw new Error("hostile status getter");
      },
      enumerable: true,
      configurable: false,
    });

    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: hostile as unknown as SignalEvaluation,
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    let result: ReturnType<TradingPipeline["run"]>;
    assert.doesNotThrow(() => {
      result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    });
    assert.equal(result!.outcome, "FAILURE");
    if (result!.outcome !== "FAILURE") return;
    assert.equal(result!.failedStage, "UNKNOWN");
    assert.equal(result!.ticket, null);
    assert.equal(result!.signal, null);
    assert.equal(result!.blockers.length, 1);
    assert.equal(result!.blockers[0].code, "PIPELINE_INTERNAL_ERROR");
    assert.equal(result!.blockers[0].source, "trading-pipeline");
    assert.equal(result!.blockers[0].stage, "UNKNOWN");
    assert.match(result!.blockers[0].message, /hostile status getter/);
    // ranAt / durationMs still populated (from the pre-computed safe values).
    assert.equal(result!.metadata.engineVersions.pipeline, TRADING_PIPELINE_VERSION);
    assert.equal(typeof result!.durationMs, "number");
    assert.ok(Number.isFinite(result!.durationMs));
  });

  it("signal.warnings has a hostile Symbol.iterator → warnings fall back to [] but pipeline still classifies", () => {
    const base = buildSignal({ status: "HOLD" });
    const hostile = { ...base };
    Object.defineProperty(hostile, "warnings", {
      get: () => {
        throw new Error("warnings getter throws");
      },
      enumerable: true,
      configurable: false,
    });

    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: hostile as unknown as SignalEvaluation,
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    let result: ReturnType<TradingPipeline["run"]>;
    assert.doesNotThrow(() => {
      result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    });
    // Warnings mapping failed silently; the classifier still saw HOLD.
    assert.equal(result!.outcome, "NO_TRADE");
    if (result!.outcome !== "NO_TRADE") return;
    assert.deepEqual(result!.warnings, []);
    assert.equal(result!.reason, "HOLD");
  });

  it("signal.metadata.engineVersions.signal getter throws → version omitted, pipeline still succeeds", () => {
    const base = buildSignal({ status: "GENERATED" });
    const hostileEngineVersions = {} as Record<string, unknown>;
    Object.defineProperty(hostileEngineVersions, "signal", {
      get: () => {
        throw new Error("engineVersions.signal getter throws");
      },
      enumerable: true,
      configurable: false,
    });
    const hostile: SignalEvaluation = {
      ...base,
      metadata: {
        ...base.metadata,
        engineVersions: hostileEngineVersions as unknown as SignalEvaluation["metadata"]["engineVersions"],
      },
    };

    const pipeline = makePipeline({
      signal: fakeSignalEngine({ kind: "return", signal: hostile }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: { ok: true, ticket: buildTicket(), warnings: [] },
      }),
    });

    let result: ReturnType<TradingPipeline["run"]>;
    assert.doesNotThrow(() => {
      result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    });
    assert.equal(result!.outcome, "SUCCESS");
    if (result!.outcome !== "SUCCESS") return;
    // Signal version silently omitted; pipeline version always present.
    assert.equal(result!.metadata.engineVersions.pipeline, TRADING_PIPELINE_VERSION);
    assert.equal(result!.metadata.engineVersions.signal, undefined);
  });
});

describe("TradingPipeline — full error isolation (freeze / result assembly)", () => {
  it("deep-freeze failure on the ticket does not escape run()", () => {
    // Build a ticket whose `metadata` throws when its properties are
    // enumerated by `Object.freeze` walking. The pipeline's
    // `safeDeepFreezePipelineResult` must swallow the exception and
    // still return a well-formed SUCCESS result.
    const hostileMetadata = {} as Record<string, unknown>;
    Object.defineProperty(hostileMetadata, "builderVersion", {
      // Enumerable getter that throws — trips both `trySafe` for the
      // read AND the `Object.values` walk inside deepFreeze.
      get: () => {
        throw new Error("hostile ticket metadata");
      },
      enumerable: true,
      configurable: false,
    });
    const hostileTicket = {
      ...buildTicket(),
      metadata: hostileMetadata as unknown as ExecutionTicket["metadata"],
    };

    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticket: fakeTicketBuilder({
        kind: "return",
        result: {
          ok: true,
          ticket: hostileTicket as unknown as ExecutionTicket,
          warnings: [],
        },
      }),
    });

    let result: ReturnType<TradingPipeline["run"]>;
    assert.doesNotThrow(() => {
      result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    });
    assert.equal(result!.outcome, "SUCCESS");
    if (result!.outcome !== "SUCCESS") return;
    // ticketBuilder version was silently omitted because its getter throws.
    assert.equal(result!.metadata.engineVersions.ticketBuilder, undefined);
    // Result is at least frozen at the top level (freeze walk may have
    // aborted mid-way on the hostile getter — safeDeepFreeze catches
    // and returns unfrozen; we only assert that the pipeline did not
    // propagate the exception).
    assert.equal(typeof result!.metadata.ranAt.toISOString(), "string");
  });

  it("hostile ticket.blockers getter on ticket !ok path → falls back to empty list, no throw", () => {
    const hostileResult = {
      ok: false as const,
      ticket: null,
      warnings: [],
    } as unknown as ExecutionTicketBuildResult;
    Object.defineProperty(hostileResult, "blockers", {
      get: () => {
        throw new Error("hostile ticket.blockers");
      },
      enumerable: true,
      configurable: false,
    });

    const pipeline = makePipeline({
      signal: fakeSignalEngine({
        kind: "return",
        signal: buildSignal({ status: "GENERATED" }),
      }),
      ticket: fakeTicketBuilder({ kind: "return", result: hostileResult }),
    });

    let result: ReturnType<TradingPipeline["run"]>;
    assert.doesNotThrow(() => {
      result = pipeline.run(baseSnapshot(), baseInstrument(), policyFixture());
    });
    assert.equal(result!.outcome, "FAILURE");
    if (result!.outcome !== "FAILURE") return;
    assert.equal(result!.failedStage, "TICKET");
    assert.deepEqual(result!.blockers, []);
  });
});

