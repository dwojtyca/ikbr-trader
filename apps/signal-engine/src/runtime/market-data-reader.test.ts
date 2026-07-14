import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { defaultInstrumentRegistry, type Instrument } from "@ikbr/shared";

import {
  SignalRepositoryContractResolver,
  SignalRepositoryMarketDataReader,
  type ContractResolver,
  type InstrumentContractReadPort,
  type MarketStateReadPort,
} from "./market-data-reader.js";

// A real instrument from the shipped registry. It carries no conId
// (front-month futures conids are broker-assigned per contract) —
// this is exactly the shape the production runtime must resolve.
const KNOWN = defaultInstrumentRegistry.listAll()[0];
assert.equal(
  KNOWN.conId,
  undefined,
  "fixture invariant: default registry instruments carry no conId",
);

function fakeContractRepo(
  overrides: Partial<InstrumentContractReadPort> = {},
): InstrumentContractReadPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getInstrumentContract(symbol: string, conid?: string) {
      calls.push(`getInstrumentContract:${symbol}:${conid ?? ""}`);
      return overrides.getInstrumentContract
        ? overrides.getInstrumentContract(symbol, conid)
        : null;
    },
  };
}

function fakeMarketStateRepo(
  overrides: Partial<MarketStateReadPort> = {},
): MarketStateReadPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getMarketState(conid: string) {
      calls.push(`getMarketState:${conid}`);
      return overrides.getMarketState ? overrides.getMarketState(conid) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Contract resolver — construction guards
// ---------------------------------------------------------------------------

describe("SignalRepositoryContractResolver — construction", () => {
  it("throws when repo is missing", () => {
    assert.throws(
      () =>
        new SignalRepositoryContractResolver({
          // @ts-expect-error deliberate misuse
          repo: undefined,
          cacheTtlMs: 60_000,
        }),
      /repo with getInstrumentContract\(\) is required/,
    );
  });

  it("throws when cacheTtlMs is negative or non-finite", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          new SignalRepositoryContractResolver({
            repo: fakeContractRepo(),
            cacheTtlMs: bad,
          }),
        /cacheTtlMs must be a non-negative finite number/,
      );
    }
  });

  it("accepts cacheTtlMs = 0 (caching disabled)", () => {
    assert.doesNotThrow(
      () =>
        new SignalRepositoryContractResolver({
          repo: fakeContractRepo(),
          cacheTtlMs: 0,
        }),
    );
  });
});

// ---------------------------------------------------------------------------
// Contract resolver — behaviour
// ---------------------------------------------------------------------------

describe("SignalRepositoryContractResolver.resolveConid — happy paths", () => {
  it("uses Instrument.conId fast path (no Postgres call)", async () => {
    const repo = fakeContractRepo();
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 60_000,
    });
    const withConId: Instrument = { ...KNOWN, conId: 424242 };
    const result = await resolver.resolveConid(withConId);
    assert.equal(result, "424242");
    assert.deepEqual(repo.calls, []);
  });

  it("falls back to Postgres lookup by brokerSymbol when conId absent", async () => {
    const repo = fakeContractRepo({
      getInstrumentContract: async (symbol) => {
        assert.equal(symbol, KNOWN.brokerSymbol);
        return { conid: "555001", symbol };
      },
    });
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 60_000,
    });
    const result = await resolver.resolveConid(KNOWN);
    assert.equal(result, "555001");
    assert.deepEqual(repo.calls, [
      `getInstrumentContract:${KNOWN.brokerSymbol}:`,
    ]);
  });

  it("returns null when Postgres has no mapping (fail-closed)", async () => {
    const repo = fakeContractRepo({ getInstrumentContract: async () => null });
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 60_000,
    });
    const result = await resolver.resolveConid(KNOWN);
    assert.equal(result, null);
  });

  it("propagates Postgres infrastructure errors", async () => {
    const repo = fakeContractRepo({
      getInstrumentContract: async () => {
        throw new Error("pg unreachable");
      },
    });
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 60_000,
    });
    await assert.rejects(
      () => resolver.resolveConid(KNOWN),
      /pg unreachable/,
    );
  });
});

describe("SignalRepositoryContractResolver.resolveConid — TTL cache", () => {
  it("second lookup within TTL uses the cache (no extra Postgres call)", async () => {
    let now = 1_000_000;
    let currentConid = "111";
    const repo = fakeContractRepo({
      getInstrumentContract: async (symbol) => ({ conid: currentConid, symbol }),
    });
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 60_000,
      now: () => now,
    });

    const first = await resolver.resolveConid(KNOWN);
    now += 30_000; // still inside TTL
    const second = await resolver.resolveConid(KNOWN);

    assert.equal(first, "111");
    assert.equal(second, "111");
    assert.equal(
      repo.calls.length,
      1,
      "second lookup within TTL must not hit Postgres",
    );

    // Change the underlying value; the cached one must still win
    // (we are still inside the TTL window).
    currentConid = "222";
    now += 10_000; // 40s < 60s TTL
    const third = await resolver.resolveConid(KNOWN);
    assert.equal(third, "111");
    assert.equal(repo.calls.length, 1);
  });

  it("re-lookup after TTL fetches the new conid", async () => {
    let now = 1_000_000;
    let currentConid = "AAA"; // pre-roll
    const repo = fakeContractRepo({
      getInstrumentContract: async (symbol) => ({ conid: currentConid, symbol }),
    });
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 60_000,
      now: () => now,
    });

    const first = await resolver.resolveConid(KNOWN);
    assert.equal(first, "AAA");
    assert.equal(repo.calls.length, 1);

    // Simulate a futures roll: ingestion re-resolves the contract
    // and writes a new conid into instrument_contracts.
    currentConid = "BBB"; // post-roll

    // Still inside TTL — cached AAA served.
    now += 30_000;
    assert.equal(await resolver.resolveConid(KNOWN), "AAA");
    assert.equal(repo.calls.length, 1);

    // TTL expires — the next call re-queries and picks up BBB.
    now += 31_000; // total 61s > 60s TTL
    const afterRoll = await resolver.resolveConid(KNOWN);
    assert.equal(afterRoll, "BBB");
    assert.equal(repo.calls.length, 2);
  });

  it("post-rollover conid is what the market-state reader uses on the next call", async () => {
    // End-to-end proof: after TTL expires with a rolled conid, the
    // reader keys Redis by the NEW conid, not the old cached one.
    let now = 1_000_000;
    let currentConid = "PRE_ROLL";
    const contractRepo = fakeContractRepo({
      getInstrumentContract: async (symbol) => ({
        conid: currentConid,
        symbol,
      }),
    });
    const observedAt = new Date();
    const marketStateRepo = fakeMarketStateRepo({
      getMarketState: async (conid) => ({
        conid,
        symbol: KNOWN.brokerSymbol,
        lastPrice: 100,
        ts: observedAt.toISOString(),
      }),
    });
    const resolver = new SignalRepositoryContractResolver({
      repo: contractRepo,
      cacheTtlMs: 60_000,
      now: () => now,
    });
    const reader = new SignalRepositoryMarketDataReader({
      repo: marketStateRepo,
      resolver,
    });

    // First read → PRE_ROLL conid.
    const first = await reader.readMarketState(KNOWN);
    assert.equal(first?.source, "redis:market-state:PRE_ROLL");

    // Roll happens; ingestion updated the mapping. Inside TTL we
    // still see PRE_ROLL...
    currentConid = "POST_ROLL";
    now += 10_000;
    assert.equal(
      (await reader.readMarketState(KNOWN))?.source,
      "redis:market-state:PRE_ROLL",
    );

    // ...but after TTL, the reader keys Redis by the new conid.
    now += 60_000; // 70s total > 60s TTL
    const afterRoll = await reader.readMarketState(KNOWN);
    assert.equal(afterRoll?.source, "redis:market-state:POST_ROLL");
    assert.deepEqual(
      marketStateRepo.calls,
      [
        "getMarketState:PRE_ROLL",
        "getMarketState:PRE_ROLL",
        "getMarketState:POST_ROLL",
      ],
    );
  });

  it("Postgres refresh error does NOT resurrect the expired entry", async () => {
    let now = 1_000_000;
    let mode: "ok" | "throw" = "ok";
    const repo = fakeContractRepo({
      getInstrumentContract: async (symbol) => {
        if (mode === "throw") throw new Error("pg unreachable during refresh");
        return { conid: "AAA", symbol };
      },
    });
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 60_000,
      now: () => now,
    });

    assert.equal(await resolver.resolveConid(KNOWN), "AAA");

    // TTL expires; Postgres is now unhealthy.
    now += 61_000;
    mode = "throw";
    await assert.rejects(
      () => resolver.resolveConid(KNOWN),
      /pg unreachable during refresh/,
      "must not silently return the stale cached conid on refresh failure",
    );

    // Postgres recovers; the resolver must re-query and NOT still be
    // holding the "AAA" entry from the pre-refresh state.
    mode = "ok";
    assert.equal(await resolver.resolveConid(KNOWN), "AAA");
    // 3 calls total: initial + failed refresh + recovery.
    assert.equal(repo.calls.length, 3);
  });

  it("TTL = 0 disables caching (every call hits Postgres)", async () => {
    let currentConid = "A";
    const repo = fakeContractRepo({
      getInstrumentContract: async (symbol) => ({ conid: currentConid, symbol }),
    });
    const resolver = new SignalRepositoryContractResolver({
      repo,
      cacheTtlMs: 0,
    });

    assert.equal(await resolver.resolveConid(KNOWN), "A");
    currentConid = "B";
    assert.equal(await resolver.resolveConid(KNOWN), "B");
    assert.equal(repo.calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const staticResolver = (conid: string | null): ContractResolver => ({
  async resolveConid() {
    return conid;
  },
});

const throwingResolver = (error: Error): ContractResolver => ({
  async resolveConid() {
    throw error;
  },
});

describe("SignalRepositoryMarketDataReader — construction", () => {
  it("throws when repo is missing", () => {
    assert.throws(
      () =>
        new SignalRepositoryMarketDataReader({
          // @ts-expect-error deliberate misuse
          repo: undefined,
          resolver: staticResolver("1"),
        }),
      /repo with getMarketState\(\) is required/,
    );
  });

  it("throws when resolver is missing", () => {
    assert.throws(
      () =>
        new SignalRepositoryMarketDataReader({
          repo: fakeMarketStateRepo(),
          // @ts-expect-error deliberate misuse
          resolver: undefined,
        }),
      /resolver with resolveConid\(\) is required/,
    );
  });
});

describe("SignalRepositoryMarketDataReader.readMarketState — happy + storage failures", () => {
  it("returns null when the resolver returns null (no Redis call)", async () => {
    const repo = fakeMarketStateRepo();
    const reader = new SignalRepositoryMarketDataReader({
      repo,
      resolver: staticResolver(null),
    });
    const result = await reader.readMarketState(KNOWN);
    assert.equal(result, null);
    assert.deepEqual(repo.calls, []);
  });

  it("resolves the conid and reads Redis under the exact ingestion key format", async () => {
    const repo = fakeMarketStateRepo({
      getMarketState: async (conid) => ({
        conid,
        symbol: KNOWN.brokerSymbol,
        lastPrice: 100.25,
        bid: 100.2,
        ask: 100.3,
        spread: 0.1,
        ts: "2026-07-14T12:00:00.000Z",
      }),
    });
    const reader = new SignalRepositoryMarketDataReader({
      repo,
      resolver: staticResolver("123456"),
    });
    const result = await reader.readMarketState(KNOWN);
    assert.ok(result);
    assert.equal(result!.instrumentId, KNOWN.id);
    assert.equal(result!.lastPrice, 100.25);
    assert.equal(result!.bid, 100.2);
    assert.equal(result!.ask, 100.3);
    assert.equal(result!.spread, 0.1);
    assert.equal(
      result!.observedAt.toISOString(),
      "2026-07-14T12:00:00.000Z",
    );
    assert.equal(result!.source, "redis:market-state:123456");
    assert.deepEqual(repo.calls, ["getMarketState:123456"]);
  });

  it("returns null when Redis has no entry", async () => {
    const repo = fakeMarketStateRepo({ getMarketState: async () => null });
    const reader = new SignalRepositoryMarketDataReader({
      repo,
      resolver: staticResolver("123456"),
    });
    const result = await reader.readMarketState(KNOWN);
    assert.equal(result, null);
  });

  it("returns null on malformed timestamp (fail-closed)", async () => {
    const repo = fakeMarketStateRepo({
      getMarketState: async () => ({
        conid: "123456",
        symbol: KNOWN.brokerSymbol,
        lastPrice: 100.25,
        ts: "not-a-date",
      }),
    });
    const reader = new SignalRepositoryMarketDataReader({
      repo,
      resolver: staticResolver("123456"),
    });
    const result = await reader.readMarketState(KNOWN);
    assert.equal(result, null);
  });

  it("returns null on non-finite lastPrice (fail-closed)", async () => {
    const repo = fakeMarketStateRepo({
      getMarketState: async () => ({
        conid: "123456",
        symbol: KNOWN.brokerSymbol,
        lastPrice: Number.NaN,
        ts: "2026-07-14T12:00:00.000Z",
      }),
    });
    const reader = new SignalRepositoryMarketDataReader({
      repo,
      resolver: staticResolver("123456"),
    });
    const result = await reader.readMarketState(KNOWN);
    assert.equal(result, null);
  });

  it("propagates Redis infrastructure errors", async () => {
    const repo = fakeMarketStateRepo({
      getMarketState: async () => {
        throw new Error("redis down");
      },
    });
    const reader = new SignalRepositoryMarketDataReader({
      repo,
      resolver: staticResolver("123456"),
    });
    await assert.rejects(
      () => reader.readMarketState(KNOWN),
      /redis down/,
    );
  });

  it("propagates resolver errors", async () => {
    const repo = fakeMarketStateRepo();
    const reader = new SignalRepositoryMarketDataReader({
      repo,
      resolver: throwingResolver(new Error("pg unreachable")),
    });
    await assert.rejects(
      () => reader.readMarketState(KNOWN),
      /pg unreachable/,
    );
    assert.deepEqual(repo.calls, []);
  });
});

// ---------------------------------------------------------------------------
// Payload identity validation (fail-closed)
// ---------------------------------------------------------------------------

describe("SignalRepositoryMarketDataReader.readMarketState — payload identity validation", () => {
  const observedAt = "2026-07-14T12:00:00.000Z";

  function readerFor(
    payload: Awaited<ReturnType<MarketStateReadPort["getMarketState"]>>,
  ): SignalRepositoryMarketDataReader {
    const repo = fakeMarketStateRepo({ getMarketState: async () => payload });
    return new SignalRepositoryMarketDataReader({
      repo,
      resolver: staticResolver("EXPECTED_CONID"),
    });
  }

  it("returns null when raw.conid mismatches the requested conid (stale-after-roll)", async () => {
    const reader = readerFor({
      conid: "STALE_CONID",
      symbol: KNOWN.brokerSymbol,
      lastPrice: 100,
      ts: observedAt,
    });
    assert.equal(await reader.readMarketState(KNOWN), null);
  });

  it("returns null when raw.symbol mismatches Instrument.brokerSymbol (conid collision)", async () => {
    const reader = readerFor({
      conid: "EXPECTED_CONID",
      symbol: "SOMETHING_ELSE",
      lastPrice: 100,
      ts: observedAt,
    });
    assert.equal(await reader.readMarketState(KNOWN), null);
  });

  it("returns null when raw.conid is an empty string", async () => {
    const reader = readerFor({
      conid: "",
      symbol: KNOWN.brokerSymbol,
      lastPrice: 100,
      ts: observedAt,
    });
    assert.equal(await reader.readMarketState(KNOWN), null);
  });

  it("returns null when raw.conid is whitespace only", async () => {
    const reader = readerFor({
      conid: "   ",
      symbol: KNOWN.brokerSymbol,
      lastPrice: 100,
      ts: observedAt,
    });
    assert.equal(await reader.readMarketState(KNOWN), null);
  });

  it("returns null when raw.symbol is an empty string", async () => {
    const reader = readerFor({
      conid: "EXPECTED_CONID",
      symbol: "",
      lastPrice: 100,
      ts: observedAt,
    });
    assert.equal(await reader.readMarketState(KNOWN), null);
  });

  it("returns null when raw.conid is not a string (fail-closed)", async () => {
    const reader = readerFor({
      // @ts-expect-error hostile payload
      conid: 12345,
      symbol: KNOWN.brokerSymbol,
      lastPrice: 100,
      ts: observedAt,
    });
    assert.equal(await reader.readMarketState(KNOWN), null);
  });

  it("returns null when raw.symbol is not a string (fail-closed)", async () => {
    const reader = readerFor({
      conid: "EXPECTED_CONID",
      // @ts-expect-error hostile payload
      symbol: 42,
      lastPrice: 100,
      ts: observedAt,
    });
    assert.equal(await reader.readMarketState(KNOWN), null);
  });

  it("returns a fresh RuntimeMarketState when conid + symbol both match", async () => {
    const reader = readerFor({
      conid: "EXPECTED_CONID",
      symbol: KNOWN.brokerSymbol,
      lastPrice: 100.5,
      bid: 100.4,
      ask: 100.6,
      ts: observedAt,
    });
    const result = await reader.readMarketState(KNOWN);
    assert.ok(result);
    assert.equal(result!.lastPrice, 100.5);
    assert.equal(result!.source, "redis:market-state:EXPECTED_CONID");
  });
});

// ---------------------------------------------------------------------------
// Integration — defaultInstrumentRegistry end to end with the real key format
// ---------------------------------------------------------------------------

describe("SignalRepositoryMarketDataReader — integration with defaultInstrumentRegistry", () => {
  it("resolves a default-registry instrument (no conId) through Postgres → Redis and returns the tick", async () => {
    const RESOLVED_CONID = "999888";
    const observedAt = new Date();

    const repoContract = fakeContractRepo({
      getInstrumentContract: async (symbol) => {
        assert.equal(symbol, KNOWN.brokerSymbol);
        return { conid: RESOLVED_CONID, symbol };
      },
    });
    const repoMarketState = fakeMarketStateRepo({
      getMarketState: async (conid) => {
        assert.equal(
          conid,
          RESOLVED_CONID,
          "reader must key Redis by the resolved conid, not the symbol",
        );
        return {
          conid: RESOLVED_CONID,
          symbol: KNOWN.brokerSymbol,
          lastPrice: 42.5,
          bid: 42.49,
          ask: 42.51,
          spread: 0.02,
          ts: observedAt.toISOString(),
        };
      },
    });

    const resolver = new SignalRepositoryContractResolver({
      repo: repoContract,
      cacheTtlMs: 60_000,
    });
    const reader = new SignalRepositoryMarketDataReader({
      repo: repoMarketState,
      resolver,
    });

    const result = await reader.readMarketState(KNOWN);
    assert.ok(result, "expected a fresh RuntimeMarketState");
    assert.equal(result!.instrumentId, KNOWN.id);
    assert.equal(result!.lastPrice, 42.5);
    assert.equal(result!.source, `redis:market-state:${RESOLVED_CONID}`);
    assert.deepEqual(repoContract.calls, [
      `getInstrumentContract:${KNOWN.brokerSymbol}:`,
    ]);
    assert.deepEqual(repoMarketState.calls, [
      `getMarketState:${RESOLVED_CONID}`,
    ]);
  });
});
