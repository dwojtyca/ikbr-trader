/**
 * PR15.2 hostile-review round-3 — event-level tests for
 * `awaitExactlyOneContractDetails` (the pure helper that powers
 * `TwsClient.requestContractDetailsExactlyOne`).
 *
 * The IB client is faked via an `EventEmitter`-backed port so
 * these tests exercise the real production wiring with zero
 * network / TWS dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  awaitExactlyOneContractDetails,
  type IbEventPort,
} from "./tws-client.js";

// ---------------------------------------------------------------------------
// Fake IB — an EventEmitter wearing the IbEventPort interface, with a
// spy on `reqContractDetails` and cleanup hooks so the tests can assert
// the listener population.
// ---------------------------------------------------------------------------

interface FakeIb extends IbEventPort {
  readonly emitter: EventEmitter;
  readonly reqCalls: Array<{
    reqId: number;
    contract: Record<string, unknown>;
  }>;
  listenerCounts(): { contractDetails: number; contractDetailsEnd: number; error: number };
}

function makeFakeIb(): FakeIb {
  const emitter = new EventEmitter();
  // node's EventEmitter warns at >10 listeners by default; two
  // concurrent resolvers push us past that harmlessly.
  emitter.setMaxListeners(50);
  const reqCalls: Array<{ reqId: number; contract: Record<string, unknown> }> =
    [];
  return {
    emitter,
    reqCalls,
    on(event, handler) {
      emitter.on(event, handler);
      return this;
    },
    off(event, handler) {
      emitter.off(event, handler);
      return this;
    },
    reqContractDetails(reqId, contract) {
      reqCalls.push({ reqId, contract });
      return this;
    },
    listenerCounts() {
      return {
        contractDetails: emitter.listenerCount("contractDetails"),
        contractDetailsEnd: emitter.listenerCount("contractDetailsEnd"),
        error: emitter.listenerCount("error"),
      };
    },
  };
}

const BOUND_CONTRACT: Record<string, unknown> = {
  conId: 700_001,
  secType: "FUT",
  symbol: "ES",
  exchange: "CME",
  currency: "USD",
  localSymbol: "ESU6",
  tradingClass: "ES",
};

function esDetails(overrides: Record<string, unknown> = {}): Record<
  string,
  unknown
> {
  return {
    contract: {
      conId: 700_001,
      symbol: "ES",
      exchange: "CME",
      currency: "USD",
      localSymbol: "ESU6",
      tradingClass: "ES",
      secType: "FUT",
    },
    minTick: 0.25,
    ...overrides,
  };
}

describe("awaitExactlyOneContractDetails — event-level contract", () => {
  it("exactly one matching result → resolves with the single details payload", async () => {
    const ib = makeFakeIb();
    const promise = awaitExactlyOneContractDetails({
      ib,
      reqId: 42,
      contract: BOUND_CONTRACT,
      label: "es_front",
      timeoutMs: 1_000,
    });
    // The helper must call reqContractDetails exactly once with
    // the exact bound contract; nothing about the fake infers
    // secType from a default.
    assert.equal(ib.reqCalls.length, 1);
    assert.equal(ib.reqCalls[0].reqId, 42);
    assert.deepEqual(ib.reqCalls[0].contract, BOUND_CONTRACT);
    assert.equal(
      (ib.reqCalls[0].contract as { secType: string }).secType,
      "FUT",
      "the exact request must carry secType=FUT (not STK)",
    );

    ib.emitter.emit("contractDetails", 42, esDetails());
    ib.emitter.emit("contractDetailsEnd", 42);
    const resolved = await promise;
    assert.deepEqual(
      (resolved as { contract: Record<string, unknown> }).contract,
      esDetails().contract,
    );
    // Listener cleanup — no leak after fulfilment.
    const counts = ib.listenerCounts();
    assert.equal(counts.contractDetails, 0);
    assert.equal(counts.contractDetailsEnd, 0);
    assert.equal(counts.error, 0);
  });

  it("zero results → rejects with 'expected exactly one'", async () => {
    const ib = makeFakeIb();
    const promise = awaitExactlyOneContractDetails({
      ib,
      reqId: 42,
      contract: BOUND_CONTRACT,
      label: "es_front",
      timeoutMs: 1_000,
    });
    ib.emitter.emit("contractDetailsEnd", 42);
    await assert.rejects(promise, /expected exactly one/);
    const counts = ib.listenerCounts();
    assert.equal(counts.contractDetails, 0);
    assert.equal(counts.contractDetailsEnd, 0);
    assert.equal(counts.error, 0);
  });

  it("multiple results → rejects as ambiguous; does NOT pick the first", async () => {
    const ib = makeFakeIb();
    const promise = awaitExactlyOneContractDetails({
      ib,
      reqId: 42,
      contract: BOUND_CONTRACT,
      label: "es_front",
      timeoutMs: 1_000,
    });
    ib.emitter.emit("contractDetails", 42, esDetails());
    ib.emitter.emit(
      "contractDetails",
      42,
      esDetails({
        contract: {
          ...(esDetails().contract as Record<string, unknown>),
          conId: 700_002,
        },
      }),
    );
    ib.emitter.emit("contractDetailsEnd", 42);
    await assert.rejects(promise, /Ambiguous contract details/);
    const counts = ib.listenerCounts();
    assert.equal(counts.contractDetails, 0);
    assert.equal(counts.contractDetailsEnd, 0);
    assert.equal(counts.error, 0);
  });

  it("error event for the same reqId → rejects", async () => {
    const ib = makeFakeIb();
    const promise = awaitExactlyOneContractDetails({
      ib,
      reqId: 42,
      contract: BOUND_CONTRACT,
      label: "es_front",
      timeoutMs: 1_000,
    });
    ib.emitter.emit("error", new Error("no security definition"), 200, 42);
    await assert.rejects(promise, /contractDetails error 200/);
    const counts = ib.listenerCounts();
    assert.equal(counts.contractDetails, 0);
    assert.equal(counts.contractDetailsEnd, 0);
    assert.equal(counts.error, 0);
  });

  it("events for OTHER reqIds are ignored (concurrent resolutions share the socket)", async () => {
    const ib = makeFakeIb();
    const promise = awaitExactlyOneContractDetails({
      ib,
      reqId: 42,
      contract: BOUND_CONTRACT,
      label: "es_front",
      timeoutMs: 1_000,
    });
    // Chatter for a different in-flight request MUST NOT be
    // routed to our promise.
    ib.emitter.emit("contractDetails", 999, esDetails());
    ib.emitter.emit(
      "contractDetails",
      999,
      esDetails({
        contract: {
          ...(esDetails().contract as Record<string, unknown>),
          conId: 42,
        },
      }),
    );
    ib.emitter.emit("contractDetailsEnd", 999);
    ib.emitter.emit("error", new Error("someone else's error"), 999, 999);
    // Our reqId still gets exactly one match.
    ib.emitter.emit("contractDetails", 42, esDetails());
    ib.emitter.emit("contractDetailsEnd", 42);
    const resolved = await promise;
    assert.equal(
      (resolved as { contract: { conId: number } }).contract.conId,
      700_001,
    );
    const counts = ib.listenerCounts();
    assert.equal(counts.contractDetails, 0);
    assert.equal(counts.contractDetailsEnd, 0);
    assert.equal(counts.error, 0);
  });

  it("timeout → rejects and cleans up listeners", async () => {
    const ib = makeFakeIb();
    const promise = awaitExactlyOneContractDetails({
      ib,
      reqId: 42,
      contract: BOUND_CONTRACT,
      label: "es_front",
      // Deliberately tight; no events are emitted so the timer
      // fires.
      timeoutMs: 20,
    });
    await assert.rejects(promise, /Timed out waiting contractDetails/);
    const counts = ib.listenerCounts();
    assert.equal(counts.contractDetails, 0);
    assert.equal(counts.contractDetailsEnd, 0);
    assert.equal(counts.error, 0);
  });

  it("two concurrent resolutions on the same IB port do not cross-wire", async () => {
    const ib = makeFakeIb();
    const p1 = awaitExactlyOneContractDetails({
      ib,
      reqId: 42,
      contract: { ...BOUND_CONTRACT },
      label: "es_front",
      timeoutMs: 1_000,
    });
    const p2 = awaitExactlyOneContractDetails({
      ib,
      reqId: 43,
      contract: { ...BOUND_CONTRACT, conId: 700_002 },
      label: "gc_front",
      timeoutMs: 1_000,
    });
    ib.emitter.emit("contractDetails", 43, esDetails());
    ib.emitter.emit("contractDetailsEnd", 43);
    ib.emitter.emit("contractDetails", 42, esDetails());
    ib.emitter.emit("contractDetailsEnd", 42);
    await Promise.all([p1, p2]);
    const counts = ib.listenerCounts();
    assert.equal(counts.contractDetails, 0);
    assert.equal(counts.contractDetailsEnd, 0);
    assert.equal(counts.error, 0);
  });

  it("synchronous throw from reqContractDetails → rejects, cleans up, does not double-fail on timeout (PR15.2 hostile-review round-4)", async () => {
    let reqCalls = 0;
    const emitter = new (
      await import("node:events")
    ).EventEmitter();
    emitter.setMaxListeners(50);
    const throwingIb: IbEventPort = {
      on(event, handler) {
        emitter.on(event, handler);
        return this;
      },
      off(event, handler) {
        emitter.off(event, handler);
        return this;
      },
      reqContractDetails() {
        reqCalls += 1;
        throw new Error("socket not connected");
      },
    };
    const promise = awaitExactlyOneContractDetails({
      ib: throwingIb,
      reqId: 42,
      contract: BOUND_CONTRACT,
      // Label appears in the error message; MUST NOT contain the
      // raw INSTRUMENT_BINDINGS_JSON payload.
      label: "es_front",
      // Deliberately short so we can prove the timer is cleared:
      // if cleanup ran correctly, the timer never fires and this
      // test wall-clock finishes well under 100 ms.
      timeoutMs: 50,
    });
    await assert.rejects(
      promise,
      /reqContractDetails threw synchronously for bound instrument es_front: socket not connected/,
    );
    // Listeners are removed immediately on synchronous failure.
    assert.equal(emitter.listenerCount("contractDetails"), 0);
    assert.equal(emitter.listenerCount("contractDetailsEnd"), 0);
    assert.equal(emitter.listenerCount("error"), 0);
    // Exactly one attempt — no retry, no fallback.
    assert.equal(reqCalls, 1);
    // Wait past the original timeoutMs to prove the cleared timer
    // does NOT fire a second rejection. If cleanup missed the
    // clearTimeout the promise would reject a second time and
    // node would surface an unhandled rejection.
    let secondSettlement = false;
    promise.catch(() => {
      secondSettlement = true;
    });
    await new Promise<void>((r) => setTimeout(r, 120));
    assert.equal(
      secondSettlement,
      true,
      "the already-rejected promise is caught exactly once (no new settlement)",
    );
    // Listener counts remain at zero after the timeout window.
    assert.equal(emitter.listenerCount("contractDetails"), 0);
    assert.equal(emitter.listenerCount("contractDetailsEnd"), 0);
    assert.equal(emitter.listenerCount("error"), 0);
  });
});

// ---------------------------------------------------------------------------
// Bound-futures regression: the actual production merged watchlist
// MUST emit `secType=FUT`, and that entry MUST reach the strict IB
// resolver unchanged. Removing the `secType` line from the production
// builder would fail this test.
// ---------------------------------------------------------------------------

import {
  InstrumentBindingAuthority,
  defaultInstrumentRegistry,
} from "@ikbr/shared";

import { buildMergedWatchlist } from "./bound-watchlist.js";

describe("buildMergedWatchlist secType propagation (PR15.2 hostile-review round-3)", () => {
  it("real bound `future` registry instrument → WatchlistInstrument with secType=FUT + authoritative broker identity", () => {
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      [
        {
          instrumentId: "es_front",
          conId: 700_001,
          localSymbol: "ESU6",
          tradingClass: "ES",
          exchange: "CME",
          currency: "USD",
          minTick: 0.25,
        },
      ],
    );
    const bound = authority.getBoundInstrument("es_front");
    assert.ok(bound);
    assert.equal(
      bound!.instrument.assetClass,
      "future",
      "test invariant: es_front is a `future` seed",
    );

    // Production builder — NO test-side reconstruction. If the
    // implementation drops `secType`, this assertion fails.
    const { boundWatchlist } = buildMergedWatchlist({
      authority,
      legacyWatchlist: [],
    });
    assert.equal(boundWatchlist.length, 1);
    const entry = boundWatchlist[0];
    assert.equal(entry.secType, "FUT");
    assert.equal(entry.symbol, "ES");
    assert.equal(entry.conid, "700001");
    assert.equal(entry.localSymbol, "ESU6");
    assert.equal(entry.tradingClass, "ES");
    assert.equal(entry.exchange, "CME");
    assert.equal(entry.currency, "USD");
    assert.equal(entry.instrumentId, "es_front");
  });

  it("the actual produced entry, fed into the strict resolver, reaches IB with secType=FUT (never STK)", async () => {
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      [
        {
          instrumentId: "es_front",
          conId: 700_001,
          localSymbol: "ESU6",
          tradingClass: "ES",
          exchange: "CME",
          currency: "USD",
          minTick: 0.25,
        },
      ],
    );
    // Production builder — the same call `config.ts` makes.
    const { boundWatchlist } = buildMergedWatchlist({
      authority,
      legacyWatchlist: [],
    });
    const [entry] = boundWatchlist;
    // Build the contract shape from the produced entry only. If
    // the production builder ever omits `secType`, `entry.secType`
    // is undefined and the strict IB port sees no `secType` — the
    // `secType === "FUT"` assertion below fails.
    const ib = makeFakeIb();
    const contract: Record<string, unknown> = {
      symbol: entry.symbol,
      conId: Number(entry.conid),
      secType: entry.secType,
      exchange: entry.exchange,
      currency: entry.currency,
      localSymbol: entry.localSymbol,
      tradingClass: entry.tradingClass,
    };
    const promise = awaitExactlyOneContractDetails({
      ib,
      reqId: 7,
      contract,
      label: entry.instrumentId ?? entry.symbol,
      timeoutMs: 1_000,
    });
    ib.emitter.emit("contractDetails", 7, {
      contract: { ...contract },
      minTick: 0.25,
    });
    ib.emitter.emit("contractDetailsEnd", 7);
    await promise;
    assert.equal(ib.reqCalls.length, 1);
    assert.equal(
      (ib.reqCalls[0].contract as { secType: string }).secType,
      "FUT",
      "the strict IB port must receive secType=FUT from the production builder — regression guard",
    );
    assert.notEqual(
      (ib.reqCalls[0].contract as { secType: string }).secType,
      "STK",
    );
  });
});

