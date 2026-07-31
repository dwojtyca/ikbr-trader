/**
 * PR15.2 — ingestion binding verification unit tests.
 *
 * Ingestion refuses to publish market state under a substituted
 * identity. Every legitimate mismatch class (conId / symbol /
 * exchange / currency / localSymbol / tradingClass) surfaces as
 * a `BoundSubscriptionMismatch` and drops the subscription;
 * legacy (unbound) subscriptions pass through unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InstrumentBindingAuthority,
  defaultInstrumentRegistry,
} from "@ikbr/shared";

import { verifyBoundSubscriptions } from "./binding-verification.js";
import type { InstrumentSubscription, WatchlistInstrument } from "./types.js";

const ES_BOUND: WatchlistInstrument = {
  symbol: "ES",
  conid: "700001",
  exchange: "CME",
  currency: "USD",
  localSymbol: "ESU6",
  tradingClass: "ES",
  instrumentId: "es_front",
};

const AUTHORITY = new InstrumentBindingAuthority(defaultInstrumentRegistry, [
  {
    instrumentId: "es_front",
    conId: 700_001,
    localSymbol: "ESU6",
    tradingClass: "ES",
    exchange: "CME",
    currency: "USD",
    minTick: 0.25,
  },
]);

function subFor(
  overrides: Partial<InstrumentSubscription> & {
    contract?: Record<string, unknown>;
    minTick?: number;
  } = {},
): InstrumentSubscription {
  const { minTick, ...rest } = overrides;
  const effectiveMinTick = minTick ?? 0.25;
  return {
    symbol: "ES",
    conid: "700001",
    contract: {
      conId: 700_001,
      symbol: "ES",
      exchange: "CME",
      currency: "USD",
      localSymbol: "ESU6",
      tradingClass: "ES",
    },
    instrumentContract: {
      symbol: "ES",
      conid: "700001",
      secType: "FUT",
      exchange: "CME",
      currency: "USD",
      localSymbol: "ESU6",
      tradingClass: "ES",
      minTick: effectiveMinTick,
      source: "ibkr",
    },
    ...rest,
  };
}

describe("verifyBoundSubscriptions — happy path", () => {
  it("matched bound subscription passes and gets tagged with instrumentId", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [subFor()],
    });
    assert.equal(result.mismatches.length, 0);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].instrumentId, "es_front");
  });

  it("legacy (unbound) subscription passes through untouched", () => {
    const legacy: InstrumentSubscription = {
      symbol: "AAPL",
      conid: "265598",
      contract: { conId: 265_598, symbol: "AAPL", exchange: "SMART", currency: "USD" },
    };
    const legacyWatch: WatchlistInstrument = { symbol: "AAPL" };
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND, legacyWatch],
      subscriptions: [legacy, subFor()],
    });
    assert.equal(result.mismatches.length, 0);
    assert.equal(result.accepted.length, 2);
    const aapl = result.accepted.find((s) => s.symbol === "AAPL");
    assert.ok(aapl);
    assert.equal(aapl!.instrumentId, undefined);
  });
});

describe("verifyBoundSubscriptions — rejection paths", () => {
  it("conId mismatch → drop + reason", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({ conid: "999999", contract: { conId: 999_999, symbol: "ES", exchange: "CME", currency: "USD", localSymbol: "ESU6", tradingClass: "ES" } }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.mismatches.length, 1);
    assert.match(result.mismatches[0].reason, /conId mismatch/i);
  });

  it("symbol mismatch → drop (broker returned a different symbol; PR15.2 hostile-review round-3)", () => {
    // The requested `sub.symbol` matches the bound broker
    // symbol (that's how ingestion asks IBKR), but the
    // returned `contract.symbol` is DIFFERENT — IBKR
    // substituted. The verifier MUST drop the bound
    // subscription; it must not reclassify as a legacy
    // pass-through.
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({
          contract: {
            conId: 700_001,
            symbol: "MES",
            exchange: "CME",
            currency: "USD",
            localSymbol: "ESU6",
            tradingClass: "ES",
          },
        }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.mismatches.length, 1);
    assert.match(result.mismatches[0].reason, /symbol mismatch/i);
  });

  it("symbol missing in contractDetails → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({
          contract: {
            conId: 700_001,
            // No `symbol` on purpose — IBKR sometimes omits
            // fields; ingestion cannot prove identity without it.
            exchange: "CME",
            currency: "USD",
            localSymbol: "ESU6",
            tradingClass: "ES",
          },
        }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.mismatches.length, 1);
    assert.match(result.mismatches[0].reason, /symbol missing/i);
  });

  it("exchange mismatch → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({ contract: { conId: 700_001, symbol: "ES", exchange: "GLOBEX", currency: "USD", localSymbol: "ESU6", tradingClass: "ES" } }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.mismatches.length, 1);
    assert.match(result.mismatches[0].reason, /exchange mismatch/i);
  });

  it("currency mismatch → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({ contract: { conId: 700_001, symbol: "ES", exchange: "CME", currency: "EUR", localSymbol: "ESU6", tradingClass: "ES" } }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /currency mismatch/i);
  });

  it("localSymbol mismatch → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({ contract: { conId: 700_001, symbol: "ES", exchange: "CME", currency: "USD", localSymbol: "ESZ6", tradingClass: "ES" } }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /localSymbol mismatch/i);
  });

  it("tradingClass mismatch → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({ contract: { conId: 700_001, symbol: "ES", exchange: "CME", currency: "USD", localSymbol: "ESU6", tradingClass: "MES" } }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /tradingClass mismatch/i);
  });
});

describe("verifyBoundSubscriptions — PR15.2 hostile-review missing-field rejection", () => {
  it("missing exchange → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({
          contract: {
            conId: 700_001,
            symbol: "ES",
            currency: "USD",
            localSymbol: "ESU6",
            tradingClass: "ES",
          },
        }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /exchange missing/i);
  });

  it("missing currency → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({
          contract: {
            conId: 700_001,
            symbol: "ES",
            exchange: "CME",
            localSymbol: "ESU6",
            tradingClass: "ES",
          },
        }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /currency missing/i);
  });

  it("missing localSymbol → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({
          contract: {
            conId: 700_001,
            symbol: "ES",
            exchange: "CME",
            currency: "USD",
            tradingClass: "ES",
          },
        }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /localSymbol missing/i);
  });

  it("missing tradingClass → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        subFor({
          contract: {
            conId: 700_001,
            symbol: "ES",
            exchange: "CME",
            currency: "USD",
            localSymbol: "ESU6",
          },
        }),
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /tradingClass missing/i);
  });

  it("missing minTick → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [
        {
          symbol: "ES",
          conid: "700001",
          contract: {
            conId: 700_001,
            symbol: "ES",
            exchange: "CME",
            currency: "USD",
            localSymbol: "ESU6",
            tradingClass: "ES",
          },
          // No instrumentContract.minTick set on purpose.
        } as InstrumentSubscription,
      ],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /minTick missing/i);
  });

  it("minTick mismatch → drop", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [subFor({ minTick: 0.5 })],
    });
    assert.equal(result.accepted.length, 0);
    assert.match(result.mismatches[0].reason, /minTick mismatch/i);
  });

  it("matching minTick (within representation tolerance) → accepted", () => {
    const result = verifyBoundSubscriptions({
      authority: AUTHORITY,
      watchlist: [ES_BOUND],
      subscriptions: [subFor({ minTick: 0.25 + 1e-12 })],
    });
    assert.equal(result.accepted.length, 1);
    assert.equal(result.mismatches.length, 0);
  });
});
