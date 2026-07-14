import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultInstrumentRegistry } from "@ikbr/shared";

import {
  MissingMarketStateError,
  PriceContextProvider,
} from "./price-provider.js";
import type {
  MarketDataRuntimeReader,
  RuntimeMarketState,
} from "./market-data-reader.js";

const instrument = defaultInstrumentRegistry.getInstrumentOrThrow(
  defaultInstrumentRegistry.listAll()[0].id,
);

function fakeReader(
  state: RuntimeMarketState | null | (() => Promise<RuntimeMarketState | null>),
): MarketDataRuntimeReader {
  return {
    async readMarketState() {
      if (typeof state === "function") return state();
      return state;
    },
  };
}

describe("PriceContextProvider — construction", () => {
  it("throws when reader is missing", () => {
    assert.throws(
      () =>
        new PriceContextProvider({
          // @ts-expect-error deliberate misuse
          reader: undefined,
          freshnessTtlMs: 30_000,
        }),
      /reader is required/,
    );
  });

  it("throws when freshnessTtlMs is non-positive or non-finite", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          new PriceContextProvider({
            reader: fakeReader(null),
            freshnessTtlMs: bad,
          }),
        /freshnessTtlMs must be a positive finite number/,
      );
    }
  });

  it("exposes stable section identity and defaults", () => {
    const p = new PriceContextProvider({
      reader: fakeReader(null),
      freshnessTtlMs: 30_000,
    });
    assert.equal(p.section, "price");
    assert.equal(p.freshnessTtlMs, 30_000);
    assert.equal(p.timeoutMs, 2_000);
    assert.equal(p.id, "runtime:price:redis");
    assert.equal(p.supports(), true);
  });
});

describe("PriceContextProvider.load", () => {
  it("throws MissingMarketStateError when reader returns null (fail-closed)", async () => {
    const p = new PriceContextProvider({
      reader: fakeReader(null),
      freshnessTtlMs: 30_000,
    });
    await assert.rejects(
      () => p.load({ instrument, now: new Date() }),
      MissingMarketStateError,
    );
  });

  it("returns a SectionLoadResult with observedAt from the source", async () => {
    const observedAt = new Date("2026-07-14T12:00:00.000Z");
    const state: RuntimeMarketState = {
      instrumentId: instrument.id,
      lastPrice: 100.5,
      bid: 100.4,
      ask: 100.6,
      spread: 0.2,
      observedAt,
      source: "redis:market-state:42",
    };
    const p = new PriceContextProvider({
      reader: fakeReader(state),
      freshnessTtlMs: 30_000,
    });
    const result = await p.load({
      instrument,
      now: new Date("2026-07-14T12:00:20.000Z"),
    });
    assert.equal(result.observedAt.toISOString(), observedAt.toISOString());
    assert.equal(result.source, "redis:market-state:42");
    assert.equal(result.data.last, 100.5);
    assert.equal(result.data.bid, 100.4);
    assert.equal(result.data.ask, 100.6);
    assert.equal(result.data.spread, 0.2);
  });

  it("omits optional fields when the reader does not supply them", async () => {
    const p = new PriceContextProvider({
      reader: fakeReader({
        instrumentId: instrument.id,
        lastPrice: 42,
        observedAt: new Date(),
        source: "redis:market-state:1",
      }),
      freshnessTtlMs: 30_000,
    });
    const result = await p.load({ instrument, now: new Date() });
    assert.equal(result.data.last, 42);
    assert.equal(result.data.bid, undefined);
    assert.equal(result.data.ask, undefined);
    assert.equal(result.data.spread, undefined);
  });

  it("propagates infrastructure errors (builder isolation is out of scope)", async () => {
    const p = new PriceContextProvider({
      reader: fakeReader(async () => {
        throw new Error("redis down");
      }),
      freshnessTtlMs: 30_000,
    });
    await assert.rejects(
      () => p.load({ instrument, now: new Date() }),
      /redis down/,
    );
  });
});
