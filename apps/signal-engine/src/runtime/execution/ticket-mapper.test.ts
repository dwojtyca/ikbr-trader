import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExecutionTicket } from "@ikbr/shared";

import {
  UnsupportedOrderCombinationError,
  UnsupportedOrderTypeError,
  toLegacySignalTicket,
} from "./ticket-mapper.js";

function baseTicket(overrides: Partial<ExecutionTicket> = {}): ExecutionTicket {
  return {
    ticketId: "tix-1",
    createdAt: new Date("2026-07-14T12:00:00.000Z"),
    signalId: "sig-1",
    decisionId: "dec-1",
    instrumentId: "runtime_test_stk",
    broker: "ibkr",
    brokerSymbol: "RTX",
    exchange: "NYSE",
    currency: "USD",
    conId: 42,
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
    protection: {
      stopLoss: 99,
      takeProfit: 102,
      bracketEnabled: true,
    },
    metadata: {
      signalEngineVersion: "x",
      decisionEngineVersion: "x",
      riskEngineVersion: "x",
      builderVersion: "x",
      correlationId: "corr-x",
    },
    ...overrides,
  };
}

describe("toLegacySignalTicket — order type preservation", () => {
  it("LMT remains LMT with entry set from limitPrice", () => {
    const result = toLegacySignalTicket(baseTicket());
    assert.equal(result.orderType, "LMT");
    assert.equal(result.entry, 100.5);
  });

  it("STP remains STP with stop set from stopPrice (no bracket)", () => {
    // STP orders MUST NOT carry bracket protection — see the
    // "STP + bracket" describe block below. When protection is
    // empty the parent trigger `stopPrice` is preserved on the
    // legacy `stop` field.
    const result = toLegacySignalTicket(
      baseTicket({
        order: {
          side: "SELL",
          quantity: 5,
          quantityUnit: "shares",
          orderType: "STP",
          stopPrice: 98,
          timeInForce: "DAY",
          outsideRth: false,
          transmit: true,
        },
        protection: { bracketEnabled: false },
      }),
    );
    assert.equal(result.orderType, "STP");
    assert.equal(result.stop, 98);
    assert.equal(result.entry, undefined);
  });

  it("STP_LMT is REJECTED — never silently coerced to STP", () => {
    // This is the PR13 blocker fix: the legacy wire type has no
    // STP_LMT variant, so silently coercing to STP would DROP the
    // limit price and place the wrong order type at the broker.
    assert.throws(
      () =>
        toLegacySignalTicket(
          baseTicket({
            order: {
              side: "BUY",
              quantity: 3,
              quantityUnit: "shares",
              orderType: "STP_LMT",
              limitPrice: 99,
              stopPrice: 98.5,
              timeInForce: "DAY",
              outsideRth: false,
              transmit: true,
            },
          }),
        ),
      UnsupportedOrderTypeError,
    );
  });
});

describe("toLegacySignalTicket — STP + bracket is UNSUPPORTED", () => {
  // The legacy SignalTicket has a SINGLE `stop` field. It can carry
  // either the parent STP trigger OR the bracket protective
  // stop-loss — never both. Silently letting one overwrite the
  // other would place a different order than the pipeline intended.
  // The mapper rejects the combination at the write edge; the
  // execution runtime translates the throw into
  // NOT_SUBMITTED / UNSUPPORTED_TICKET_SHAPE.
  const stpOrder = {
    side: "SELL" as const,
    quantity: 5,
    quantityUnit: "shares" as const,
    orderType: "STP" as const,
    stopPrice: 98,
    timeInForce: "DAY" as const,
    outsideRth: false,
    transmit: true,
  };

  it("STP + protection.stopLoss → throws (no silent overwrite of parent trigger)", () => {
    assert.throws(
      () =>
        toLegacySignalTicket(
          baseTicket({
            order: stpOrder,
            protection: { stopLoss: 95, bracketEnabled: false },
          }),
        ),
      UnsupportedOrderCombinationError,
    );
  });

  it("STP + protection.takeProfit → throws", () => {
    assert.throws(
      () =>
        toLegacySignalTicket(
          baseTicket({
            order: stpOrder,
            protection: { takeProfit: 105, bracketEnabled: false },
          }),
        ),
      UnsupportedOrderCombinationError,
    );
  });

  it("STP + bracketEnabled → throws even without stopLoss/takeProfit set", () => {
    assert.throws(
      () =>
        toLegacySignalTicket(
          baseTicket({
            order: stpOrder,
            protection: { bracketEnabled: true },
          }),
        ),
      UnsupportedOrderCombinationError,
    );
  });

  it("STP + protection.trailingStop → throws", () => {
    assert.throws(
      () =>
        toLegacySignalTicket(
          baseTicket({
            order: stpOrder,
            protection: { trailingStop: 1.5, bracketEnabled: false },
          }),
        ),
      UnsupportedOrderCombinationError,
    );
  });

  it("STP + FULL bracket → throws (regression: the parent trigger MUST NOT be dropped)", () => {
    // This test case is precisely the pre-fix bug: with STP
    // parent trigger 98 AND bracket protective stop 95, the old
    // implementation silently placed a "STP order with stop=95"
    // — a fundamentally different order than intended. Now it
    // throws so the runtime can NOT_SUBMIT and log the shape.
    assert.throws(
      () =>
        toLegacySignalTicket(
          baseTicket({
            order: stpOrder,
            protection: {
              stopLoss: 95,
              takeProfit: 105,
              bracketEnabled: true,
            },
          }),
        ),
      UnsupportedOrderCombinationError,
    );
  });
});

describe("toLegacySignalTicket — price field routing (LMT bracket)", () => {
  it("LMT bracket preserves entry (limitPrice), stop (protection.stopLoss) and takeProfit", () => {
    const result = toLegacySignalTicket(baseTicket());
    assert.equal(result.orderType, "LMT");
    assert.equal(result.entry, 100.5);
    assert.equal(result.stop, 99);
    assert.equal(result.takeProfit, 102);
  });

  it("LMT without protection → only entry set, stop/takeProfit undefined", () => {
    const result = toLegacySignalTicket(
      baseTicket({
        protection: { bracketEnabled: false },
      }),
    );
    assert.equal(result.entry, 100.5);
    assert.equal(result.stop, undefined);
    assert.equal(result.takeProfit, undefined);
  });
});

describe("toLegacySignalTicket — metadata + identity", () => {
  it("maps identity, provenance reason and PASS risk-check", () => {
    const result = toLegacySignalTicket(baseTicket());
    assert.equal(result.instrument, "RTX");
    assert.equal(result.conid, "42");
    assert.equal(result.side, "BUY");
    assert.equal(result.quantity, 10);
    assert.equal(result.riskCheckStatus, "PASS");
    assert.equal(result.confidence, 1);
    assert.match(result.reason, /signalId=sig-1/);
    assert.match(result.reason, /decisionId=dec-1/);
    assert.match(result.reason, /ticketId=tix-1/);
    assert.equal(result.timestamp, "2026-07-14T12:00:00.000Z");
  });

  it("omits conid when the source ticket has no conId", () => {
    const result = toLegacySignalTicket(baseTicket({ conId: undefined }));
    assert.equal(result.conid, undefined);
  });
});
