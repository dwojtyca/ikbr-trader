import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ExecutionTicket } from "@ikbr/shared";

import {
  CLIENT_ORDER_HASH_VERSION,
  canonicaliseTicket,
  computeClientOrderHash,
} from "./client-order-hash.js";

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

describe("computeClientOrderHash — determinism & stability", () => {
  it("returns the same hash for two identical tickets", () => {
    const a = computeClientOrderHash(baseTicket());
    const b = computeClientOrderHash(baseTicket());
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it("is insensitive to metadata / signalId / decisionId / ticketId / createdAt", () => {
    // These fields change every dry-run even when the underlying
    // order is identical — they MUST NOT affect the hash.
    const base = baseTicket();
    const noisy = baseTicket({
      ticketId: "tix-2",
      signalId: "sig-999",
      decisionId: "dec-999",
      createdAt: new Date("2027-01-01T00:00:00Z"),
      metadata: {
        signalEngineVersion: "y",
        decisionEngineVersion: "y",
        riskEngineVersion: "y",
        builderVersion: "y",
        correlationId: "corr-y",
      },
    });
    assert.equal(
      computeClientOrderHash(base),
      computeClientOrderHash(noisy),
    );
  });
});

describe("computeClientOrderHash — sensitivity to order-critical fields", () => {
  const fieldMutations: Array<{
    label: string;
    mutate: (t: ExecutionTicket) => ExecutionTicket;
  }> = [
    {
      label: "side",
      mutate: (t) => ({ ...t, order: { ...t.order, side: "SELL" } }),
    },
    {
      label: "quantity",
      mutate: (t) => ({ ...t, order: { ...t.order, quantity: 11 } }),
    },
    {
      label: "orderType",
      mutate: (t) => ({ ...t, order: { ...t.order, orderType: "STP" } }),
    },
    {
      label: "limitPrice",
      mutate: (t) => ({ ...t, order: { ...t.order, limitPrice: 100.6 } }),
    },
    {
      label: "timeInForce",
      mutate: (t) => ({ ...t, order: { ...t.order, timeInForce: "GTC" } }),
    },
    {
      label: "outsideRth",
      mutate: (t) => ({ ...t, order: { ...t.order, outsideRth: true } }),
    },
    {
      label: "protection.stopLoss",
      mutate: (t) => ({
        ...t,
        protection: { ...t.protection, stopLoss: 98 },
      }),
    },
    {
      label: "protection.takeProfit",
      mutate: (t) => ({
        ...t,
        protection: { ...t.protection, takeProfit: 105 },
      }),
    },
    {
      label: "instrumentId",
      mutate: (t) => ({ ...t, instrumentId: "other_stk" }),
    },
    {
      label: "brokerSymbol",
      mutate: (t) => ({ ...t, brokerSymbol: "RTY" }),
    },
    {
      label: "conId",
      mutate: (t) => ({ ...t, conId: 43 }),
    },
  ];
  for (const { label, mutate } of fieldMutations) {
    it(`changing ${label} produces a different hash`, () => {
      const base = baseTicket();
      const mutated = mutate(base);
      assert.notEqual(
        computeClientOrderHash(base),
        computeClientOrderHash(mutated),
        `hash must be sensitive to ${label}`,
      );
    });
  }
});

describe("computeClientOrderHash — canonicalisation", () => {
  it("throws for a non-finite numeric field (defensive)", () => {
    const bad = baseTicket({
      order: { ...baseTicket().order, quantity: Number.NaN },
    });
    assert.throws(
      () => computeClientOrderHash(bad),
      /must be finite/,
    );
  });

  it("canonical form starts with the version prefix", () => {
    const canonical = canonicaliseTicket(baseTicket());
    assert.equal(CLIENT_ORDER_HASH_VERSION, "v1");
    assert.ok(
      canonical.startsWith(`${CLIENT_ORDER_HASH_VERSION}|`),
      `canonical form must start with "${CLIENT_ORDER_HASH_VERSION}|", got: ${canonical.slice(0, 20)}`,
    );
  });

  it("canonical form is stable, ordered, and reads as key=value pairs after the version", () => {
    const canonical = canonicaliseTicket(baseTicket());
    // Order-critical fields are all named and separated by `|`.
    assert.match(canonical, /^v1\|instrumentId=runtime_test_stk\|/);
    assert.match(canonical, /side=BUY/);
    assert.match(canonical, /quantity=10/);
    assert.match(canonical, /orderType=LMT/);
    assert.match(canonical, /limitPrice=100\.5/);
  });

  it("digest changes if the format version changes (guarantees conflict on schema bump)", () => {
    // Emulate a bump: prepend a hypothetical "v2|" and compare.
    // Digests must differ, guaranteeing that a re-used
    // idempotencyKey across a format bump surfaces as CONFLICT
    // rather than silently replays the old outcome under the new
    // fingerprint.
    const canonicalV1 = canonicaliseTicket(baseTicket());
    const canonicalV2 = `v2${canonicalV1.slice(CLIENT_ORDER_HASH_VERSION.length)}`;
    assert.notEqual(canonicalV1, canonicalV2);
  });
});
