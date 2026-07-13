import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSnapshot,
  samplePriceData,
  type SectionOverride,
} from "../decision-engine/snapshot.testfixture.js";
import { buildDecision, buildInstrument } from "../risk-engine/risk-input.testfixture.js";
import type { DecisionResult } from "../decision-engine/types.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type {
  RiskEvaluation,
  RiskEvaluation as _R,
} from "../risk-engine/types.js";
import type {
  SignalEvaluation,
  SignalStatus,
} from "../signal-engine/types.js";
import {
  EXECUTION_TICKET_BUILDER_VERSION,
  ExecutionTicketBuilder,
} from "./builder.js";
import type {
  ExecutionTicketPolicy,
  PriceRoundingMode,
  SupportedOrderType,
  TimeInForce,
} from "./types.js";
import { roundToTick } from "./pricing.js";

// keep unused re-export marker happy
void ({} as _R);

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
  readonly signalId?: string;
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
    signalId: overrides.signalId ?? "signal-fixture",
    generatedAt: new Date("2026-07-13T12:00:05Z"),
    instrumentId: overrides.instrumentId ?? "ctx_fut",
    decision,
    risk,
    status,
    reasonSummary: `${status} — fixture`,
    warnings: [],
    metadata: {
      engineVersions: {
        signal: "0.1.0",
        decision: "0.1.0",
        risk: "0.1.0",
      },
      evaluationTimeMs: 1,
    },
  };
}

function policy(overrides: Partial<ExecutionTicketPolicy> = {}): ExecutionTicketPolicy {
  return {
    quantity: overrides.quantity ?? 1,
    orderType: (overrides.orderType ?? "LMT") as SupportedOrderType,
    timeInForce: (overrides.timeInForce ?? "DAY") as TimeInForce,
    outsideRth: overrides.outsideRth ?? false,
    transmit: overrides.transmit ?? true,
    entryOffset: overrides.entryOffset,
    stopLossDistance: overrides.stopLossDistance,
    takeProfitDistance: overrides.takeProfitDistance,
    trailingStopDistance: overrides.trailingStopDistance,
    priceTickSize: overrides.priceTickSize ?? 0.25,
    priceRoundingMode: (overrides.priceRoundingMode ?? "nearest") as PriceRoundingMode,
  };
}

function snapshotWithPrice(
  overrides: {
    readonly last?: number;
    readonly bid?: number;
    readonly ask?: number;
    readonly status?: "fresh" | "stale" | "unavailable";
    readonly instrumentId?: string;
  } = {},
): MarketContextSnapshot {
  const status = overrides.status ?? "fresh";
  const priceOverride: SectionOverride<ReturnType<typeof samplePriceData>> | undefined =
    status === "unavailable"
      ? { kind: "unavailable" }
      : {
          kind: "present",
          status,
          data: samplePriceData({
            last: overrides.last ?? 100,
            bid: overrides.bid,
            ask: overrides.ask,
          }),
        };
  return buildSnapshot({
    overallStatus: status,
    instrumentId: overrides.instrumentId,
    price: priceOverride,
  });
}

function makeBuilder(
  tick: { value: number } = { value: 0 },
): ExecutionTicketBuilder {
  let ids = 0;
  let cors = 0;
  return new ExecutionTicketBuilder({
    now: () => new Date("2026-07-13T12:00:10Z"),
    idFactory: () => `ticket-${++ids}`,
    correlationIdFactory: () => `cor-${++cors}`,
    // version left as default
  });
}

// A canonical happy-path input.
function happyInput(): {
  signal: SignalEvaluation;
  snapshot: MarketContextSnapshot;
  instrument: Instrument;
  policy: ExecutionTicketPolicy;
} {
  return {
    signal: buildSignal(),
    snapshot: snapshotWithPrice({ last: 100, bid: 99.9, ask: 100.1 }),
    instrument: buildInstrument({ id: "ctx_fut" }),
    policy: policy({
      quantity: 1,
      stopLossDistance: 1,
      takeProfitDistance: 2,
      priceTickSize: 0.1,
    }),
  };
}

// ---------------------------------------------------------------------------
// Direction mapping
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — direction mapping", () => {
  it("maps LONG to BUY", () => {
    const b = makeBuilder();
    const input = happyInput();
    const r = b.build(input);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.ticket.order.side, "BUY");
  });

  it("maps SHORT to SELL", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.signal = buildSignal({
      decision: buildDecision({ action: "SHORT", confidence: 80, overallScore: -30 }),
    });
    const r = b.build(input);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.ticket.order.side, "SELL");
  });
});

// ---------------------------------------------------------------------------
// Order types
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — order types", () => {
  it("builds a valid LMT with only limitPrice", () => {
    const b = makeBuilder();
    const input = happyInput();
    const r = b.build(input);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.order.orderType, "LMT");
    assert.equal(typeof r.ticket.order.limitPrice, "number");
    assert.equal(r.ticket.order.stopPrice, undefined);
  });

  it("builds a valid STP with only stopPrice", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({
      quantity: 1,
      orderType: "STP",
      priceTickSize: 0.1,
      stopLossDistance: 1,
      takeProfitDistance: 2,
    });
    const r = b.build(input);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.order.orderType, "STP");
    assert.equal(typeof r.ticket.order.stopPrice, "number");
    assert.equal(r.ticket.order.limitPrice, undefined);
  });

  it("builds a valid STP_LMT with both stopPrice and limitPrice", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({
      quantity: 1,
      orderType: "STP_LMT",
      priceTickSize: 0.1,
      stopLossDistance: 1,
      takeProfitDistance: 2,
    });
    const r = b.build(input);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.order.orderType, "STP_LMT");
    assert.equal(typeof r.ticket.order.stopPrice, "number");
    assert.equal(typeof r.ticket.order.limitPrice, "number");
    assert.equal(r.ticket.order.stopPrice, r.ticket.order.limitPrice);
  });

  it("rejects MKT with UNSUPPORTED_ORDER_TYPE", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({
      orderType: "MKT" as unknown as SupportedOrderType,
      priceTickSize: 0.1,
    });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "UNSUPPORTED_ORDER_TYPE"));
  });
});

// ---------------------------------------------------------------------------
// Tick rounding + entry / protection prices
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — tick rounding", () => {
  it("rounds entry, stop-loss and take-profit to tick size (BUY)", () => {
    const b = makeBuilder();
    const r = b.build({
      signal: buildSignal(),
      snapshot: snapshotWithPrice({ ask: 100.13, bid: 100.07, last: 100.1 }),
      instrument: buildInstrument({ id: "ctx_fut" }),
      policy: policy({
        quantity: 1,
        priceTickSize: 0.25,
        stopLossDistance: 0.4,
        takeProfitDistance: 0.6,
      }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // nearest to 100.13 in 0.25 grid = 100.25 (0.13 -> 0.25 side)
    assert.equal(r.ticket.order.limitPrice, 100.25);
    // BUY stopLoss = 100.25 - 0.4 = 99.85 → nearest 0.25 = 99.75
    assert.equal(r.ticket.protection.stopLoss, 99.75);
    // BUY takeProfit = 100.25 + 0.6 = 100.85 → nearest 0.25 = 100.75
    assert.equal(r.ticket.protection.takeProfit, 100.75);
  });

  it("respects 'down' rounding mode", () => {
    assert.equal(roundToTick(100.13, 0.25, "down"), 100);
    assert.equal(roundToTick(100.13, 0.25, "up"), 100.25);
    assert.equal(roundToTick(100.13, 0.25, "nearest"), 100.25);
  });

  it("puts SELL stop-loss above entry and take-profit below", () => {
    const b = makeBuilder();
    const r = b.build({
      signal: buildSignal({
        decision: buildDecision({ action: "SHORT", confidence: 80 }),
      }),
      snapshot: snapshotWithPrice({ ask: 100.1, bid: 99.9, last: 100 }),
      instrument: buildInstrument({ id: "ctx_fut" }),
      policy: policy({
        quantity: 1,
        priceTickSize: 0.1,
        stopLossDistance: 1,
        takeProfitDistance: 2,
      }),
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // SELL entry = bid 99.9
    assert.equal(r.ticket.order.limitPrice, 99.9);
    // SELL stopLoss = entry + distance = 100.9
    assert.equal(r.ticket.protection.stopLoss, 100.9);
    // SELL takeProfit = entry - distance = 97.9
    assert.equal(r.ticket.protection.takeProfit, 97.9);
    assert.equal(r.ticket.protection.bracketEnabled, true);
  });

  it("puts BUY stop-loss below entry and take-profit above", () => {
    const b = makeBuilder();
    const r = b.build(happyInput());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const entry = r.ticket.order.limitPrice!;
    assert.ok(r.ticket.protection.stopLoss! < entry);
    assert.ok(r.ticket.protection.takeProfit! > entry);
  });
});

// ---------------------------------------------------------------------------
// Signal statuses
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — signal status guards", () => {
  const nonGenerated: SignalStatus[] = ["HOLD", "BLOCKED", "REJECTED", "ERROR"];
  for (const status of nonGenerated) {
    it(`rejects signal with status=${status}`, () => {
      const b = makeBuilder();
      const input = happyInput();
      input.signal = buildSignal({ status });
      const r = b.build(input);
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.ok(r.blockers.some((b) => b.code === "SIGNAL_NOT_GENERATED"));
    });
  }

  it("rejects when decision is missing", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.signal = buildSignal({ status: "ERROR", decision: null });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "DECISION_MISSING"));
  });

  it("rejects when risk is missing", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.signal = buildSignal({ status: "ERROR", risk: null });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "RISK_MISSING"));
  });

  it("rejects when risk is not approved", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.signal = buildSignal({
      risk: buildRisk({ approved: false }),
      status: "REJECTED",
    });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    // status guard fires first — RISK_NOT_APPROVED is also raised
    assert.ok(r.blockers.some((b) => b.code === "RISK_NOT_APPROVED"));
  });

  it("rejects non-directional decision", () => {
    const b = makeBuilder();
    const input = happyInput();
    // Force GENERATED with a HOLD decision (unreachable in production
    // but validates the guardrail).
    input.signal = {
      ...buildSignal(),
      decision: buildDecision({ action: "HOLD", confidence: 80 }),
    };
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "NON_DIRECTIONAL_DECISION"));
  });
});

// ---------------------------------------------------------------------------
// Instrument / snapshot alignment
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — instrument alignment", () => {
  it("rejects INSTRUMENT_MISMATCH", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.signal = buildSignal({ instrumentId: "other" });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "INSTRUMENT_MISMATCH"));
  });

  it("rejects INSTRUMENT_DISABLED", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.instrument = buildInstrument({ id: "ctx_fut", executionEnabled: false });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "INSTRUMENT_DISABLED"));
  });
});

// ---------------------------------------------------------------------------
// Price section
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — price section", () => {
  it("rejects PRICE_MISSING when snapshot has no price data", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.snapshot = snapshotWithPrice({ status: "unavailable" });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "PRICE_MISSING"));
  });

  it("rejects PRICE_NOT_FRESH when snapshot is stale", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.snapshot = snapshotWithPrice({ status: "stale", last: 100, bid: 99.9, ask: 100.1 });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "PRICE_NOT_FRESH"));
  });
});

// ---------------------------------------------------------------------------
// Quantity + tick size + protection
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — policy validation", () => {
  it("rejects quantity = 0", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({ quantity: 0, priceTickSize: 0.1 });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "INVALID_QUANTITY"));
  });

  it("rejects quantity > instrument.risk.maxQuantity", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({ quantity: 5, priceTickSize: 0.1 }); // fixture maxQuantity=1
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "QUANTITY_LIMIT_EXCEEDED"));
  });

  it("rejects invalid tick size (<= 0)", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({ priceTickSize: 0 });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "INVALID_TICK_SIZE"));
  });

  it("rejects negative protection distance", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({
      quantity: 1,
      priceTickSize: 0.1,
      stopLossDistance: -1,
    });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.blockers.some((b) => b.code === "INVALID_PROTECTION_LEVELS"));
  });

  it("rejects protection distance smaller than tick (BUY stop lands at entry)", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.policy = policy({
      quantity: 1,
      priceTickSize: 1,
      stopLossDistance: 0.1,
    });
    input.snapshot = snapshotWithPrice({ ask: 100, bid: 99.9, last: 100 });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    // BUY: rawStopLoss = 100 - 0.1 = 99.9 → rounded to nearest 1 = 100 == entry
    assert.ok(r.blockers.some((b) => b.code === "INVALID_PROTECTION_LEVELS"));
  });
});

// ---------------------------------------------------------------------------
// Deep freeze + determinism
// ---------------------------------------------------------------------------

describe("ExecutionTicketBuilder — immutability + determinism", () => {
  it("deep-freezes the success result", () => {
    const b = makeBuilder();
    const r = b.build(happyInput());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(Object.isFrozen(r), true);
    assert.equal(Object.isFrozen(r.ticket), true);
    assert.equal(Object.isFrozen(r.ticket.order), true);
    assert.equal(Object.isFrozen(r.ticket.protection), true);
    assert.equal(Object.isFrozen(r.ticket.metadata), true);
    assert.equal(Object.isFrozen(r.warnings), true);
    assert.throws(() => {
      (r.ticket.order as { quantity: number }).quantity = 999;
    });
  });

  it("deep-freezes the failure result", () => {
    const b = makeBuilder();
    const input = happyInput();
    input.signal = buildSignal({ status: "HOLD" });
    const r = b.build(input);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(Object.isFrozen(r), true);
    assert.equal(Object.isFrozen(r.blockers), true);
    assert.equal(Object.isFrozen(r.warnings), true);
  });

  it("uses injected now, idFactory and correlationIdFactory", () => {
    const b = new ExecutionTicketBuilder({
      now: () => new Date("2026-07-13T12:00:10Z"),
      idFactory: () => "TID-42",
      correlationIdFactory: () => "COR-42",
    });
    const r = b.build(happyInput());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ticket.ticketId, "TID-42");
    assert.equal(r.ticket.metadata.correlationId, "COR-42");
    assert.equal(r.ticket.createdAt.toISOString(), "2026-07-13T12:00:10.000Z");
    assert.equal(
      r.ticket.metadata.builderVersion,
      EXECUTION_TICKET_BUILDER_VERSION,
    );
    assert.equal(r.ticket.metadata.signalEngineVersion, "0.1.0");
    assert.equal(r.ticket.metadata.decisionEngineVersion, "0.1.0");
    assert.equal(r.ticket.metadata.riskEngineVersion, "0.1.0");
  });

  it("throws only on constructor misconfiguration (missing input)", () => {
    const b = new ExecutionTicketBuilder({
      idFactory: () => "id",
      correlationIdFactory: () => "cor",
    });
    assert.throws(
      () =>
        b.build(undefined as unknown as Parameters<typeof b.build>[0]),
      /requires signal, snapshot, instrument and policy/,
    );
  });

  it("throws when idFactory is missing from constructor options", () => {
    assert.throws(
      () =>
        new ExecutionTicketBuilder({
          correlationIdFactory: () => "cor",
        } as unknown as ConstructorParameters<typeof ExecutionTicketBuilder>[0]),
      /idFactory is required/,
    );
  });

  it("throws when correlationIdFactory is missing from constructor options", () => {
    assert.throws(
      () =>
        new ExecutionTicketBuilder({
          idFactory: () => "id",
        } as unknown as ConstructorParameters<typeof ExecutionTicketBuilder>[0]),
      /correlationIdFactory is required/,
    );
  });
});
