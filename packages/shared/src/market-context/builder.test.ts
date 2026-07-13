import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InstrumentRegistry } from "../instruments/registry.js";
import type { Instrument } from "../instruments/types.js";
import { MarketContextBuilder } from "./builder.js";
import {
  DEFAULT_FRESHNESS_POLICY,
  mergeFreshnessPolicy,
} from "./freshness.js";
import {
  DelayedMarketContextProvider,
  FailingMarketContextProvider,
  StaticMarketContextProvider,
  type MarketContextProvider,
} from "./provider.js";
import type {
  PriceSectionData,
  MarketContextSnapshot,
  Section,
  TechnicalSectionData,
} from "./types.js";

function makeFuture(overrides: Partial<Instrument> = {}): Instrument {
  const base: Instrument = {
    id: "ctx_fut",
    displayName: "Context Future",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "CX",
    exchange: "CME",
    currency: "USD",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 1,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.25,
      maxSlippage: 0.5,
    },
    session: {
      useRegularTradingHours: false,
      timezone: "America/Chicago",
      sessionTemplate: "cme_equity_index",
    },
    roll: { rollStrategy: "calendar", rollDaysBeforeExpiry: 7 },
    metadata: { tags: [] },
  };
  return { ...base, ...overrides };
}

const FIXED_NOW = new Date("2026-07-13T12:00:00Z");
const FRESH_OBSERVED_AT = new Date(FIXED_NOW.getTime() - 5_000);

function buildPriceResult(observedAt: Date = FRESH_OBSERVED_AT) {
  return {
    observedAt,
    source: "test:price",
    data: {
      last: 100,
      bid: 99.5,
      ask: 100.5,
      spread: 1,
      changePct: 0.5,
      volume: 12_345,
    } satisfies PriceSectionData,
  };
}

function buildTechnicalResult(observedAt: Date = FRESH_OBSERVED_AT) {
  return {
    observedAt,
    source: "test:technical",
    data: {
      trend: { direction: "up" as const, strength: 0.7 },
      momentum: { value: 0.3, window: "14" },
      volatility: { bucket: "normal" as const, annualisedPct: 22 },
      supportLevels: [95, 90],
      resistanceLevels: [105, 110],
      timeframeSignals: [
        { timeframe: "1h", signal: "long" as const, score: 0.6 },
      ],
    } satisfies TechnicalSectionData,
  };
}

function makeBuilder(
  providers: readonly MarketContextProvider[],
  instrumentOverrides: Partial<Instrument> = {},
): MarketContextBuilder {
  const registry = new InstrumentRegistry([makeFuture(instrumentOverrides)]);
  return new MarketContextBuilder({
    registry,
    providers,
    now: () => FIXED_NOW,
  });
}

describe("MarketContextBuilder — happy path", () => {
  it("builds a fresh snapshot when every provider returns", async () => {
    const price = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(),
    });
    const tech = new StaticMarketContextProvider({
      section: "technical",
      result: buildTechnicalResult(),
    });
    const builder = makeBuilder([price, tech]);

    const snapshot = await builder.build({ instrumentId: "ctx_fut" });

    assert.equal(snapshot.instrumentId, "ctx_fut");
    assert.equal(snapshot.overallStatus, "partial");
    // Only 2 of 10 data sections have data → partial.
    assert.equal(snapshot.sections.price.status, "fresh");
    assert.equal(snapshot.sections.technical.status, "fresh");
    assert.equal(snapshot.sections.macro.status, "unavailable");
    assert.equal(snapshot.warnings.length, 0);
  });

  it("integrates with InstrumentRegistry — instrument section is always fresh", async () => {
    const builder = makeBuilder([]);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });

    assert.equal(snapshot.sections.instrument.status, "fresh");
    assert.equal(snapshot.sections.instrument.data?.id, "ctx_fut");
    assert.equal(snapshot.sections.instrument.data?.brokerSymbol, "CX");
    assert.equal(snapshot.sections.instrument.data?.sessionTemplate, "cme_equity_index");
    assert.equal(snapshot.sections.instrument.data?.quantityUnit, "contracts");
    // With no data providers, overall = unavailable (instrument excluded).
    assert.equal(snapshot.overallStatus, "unavailable");
  });

  it("computes validUntil = generatedAt + min TTL across present sections", async () => {
    const price = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(),
    });
    const tech = new StaticMarketContextProvider({
      section: "technical",
      result: buildTechnicalResult(),
    });
    const builder = makeBuilder([price, tech]);

    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    // min TTL across (instrument=inf, price=30s, technical=5min) = 30s.
    // Instrument TTL is +Infinity so it is filtered out of the min.
    const expected =
      snapshot.generatedAt.getTime() + DEFAULT_FRESHNESS_POLICY.ttls.price;
    assert.equal(snapshot.validUntil.getTime(), expected);
  });

  it("honours explicit validityMs input", async () => {
    const builder = makeBuilder([]);
    const snapshot = await builder.build({
      instrumentId: "ctx_fut",
      validityMs: 999_000,
    });
    assert.equal(
      snapshot.validUntil.getTime() - snapshot.generatedAt.getTime(),
      999_000,
    );
  });

  it("computes validityMs=0 when no data section has data", async () => {
    const builder = makeBuilder([]);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.validUntil.getTime(), snapshot.generatedAt.getTime());
  });
});

describe("MarketContextBuilder — partial (single provider failure)", () => {
  it("returns partial when one of two providers fails", async () => {
    const price = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(),
    });
    const tech = new FailingMarketContextProvider({
      section: "technical",
      error: new Error("upstream 500"),
    });
    const builder = makeBuilder([price, tech]);

    const snapshot = await builder.build({ instrumentId: "ctx_fut" });

    assert.equal(snapshot.overallStatus, "partial");
    assert.equal(snapshot.sections.price.status, "fresh");
    assert.equal(snapshot.sections.technical.status, "unavailable");
    // Warning appears both on the section and at snapshot level.
    assert.equal(snapshot.sections.technical.warnings.length, 1);
    assert.match(
      snapshot.sections.technical.warnings[0],
      /failing:technical.*upstream 500/,
    );
    assert.equal(snapshot.warnings.length, 1);
  });
});

describe("MarketContextBuilder — stale", () => {
  it("classifies overdue data as stale", async () => {
    const staleObservedAt = new Date(FIXED_NOW.getTime() - 60_000); // 60 s > 30 s TTL
    const price = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(staleObservedAt),
    });
    const builder = makeBuilder([price]);

    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.sections.price.status, "stale");
    // Only one data section, and it is stale, others unavailable → partial (mixed).
    assert.equal(snapshot.overallStatus, "partial");
  });

  it("returns overall=stale only when every data section is stale", async () => {
    // Use 48h so sections with a 24h TTL (flows/inventory) are stale too.
    const staleAt = new Date(FIXED_NOW.getTime() - 48 * 60 * 60_000);
    const providers: MarketContextProvider[] = [
      new StaticMarketContextProvider({
        section: "price",
        result: buildPriceResult(staleAt),
      }),
      new StaticMarketContextProvider({
        section: "technical",
        result: buildTechnicalResult(staleAt),
      }),
      new StaticMarketContextProvider({
        section: "macro",
        result: { observedAt: staleAt, source: "t", data: {} },
      }),
      new StaticMarketContextProvider({
        section: "crossAsset",
        result: { observedAt: staleAt, source: "t", data: {} },
      }),
      new StaticMarketContextProvider({
        section: "positioning",
        // 8 days > 7-day TTL
        result: {
          observedAt: new Date(FIXED_NOW.getTime() - 8 * 24 * 60 * 60_000),
          source: "t",
          data: {},
        },
      }),
      new StaticMarketContextProvider({
        section: "flows",
        result: { observedAt: staleAt, source: "t", data: { etfFlows: [] } },
      }),
      new StaticMarketContextProvider({
        section: "inventory",
        result: {
          observedAt: staleAt,
          source: "t",
          data: { exchangeInventory: [] },
        },
      }),
      new StaticMarketContextProvider({
        section: "calendar",
        result: {
          observedAt: staleAt,
          source: "t",
          data: { upcomingEvents: [] },
        },
      }),
      new StaticMarketContextProvider({
        section: "news",
        result: {
          observedAt: staleAt,
          source: "t",
          data: { sentiment: "neutral", headlines: [], riskFlags: [] },
        },
      }),
      new StaticMarketContextProvider({
        section: "brokerState",
        result: {
          observedAt: staleAt,
          source: "t",
          data: { openOrders: [], accountEnvironment: "paper" },
        },
      }),
    ];
    const builder = makeBuilder(providers);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.overallStatus, "stale");
  });
});

describe("MarketContextBuilder — unavailable", () => {
  it("returns overall=unavailable with no providers at all", async () => {
    const builder = makeBuilder([]);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.overallStatus, "unavailable");
  });

  it("returns unavailable when every provider fails", async () => {
    const providers: MarketContextProvider[] = [
      new FailingMarketContextProvider({ section: "price" }),
      new FailingMarketContextProvider({ section: "technical" }),
    ];
    const builder = makeBuilder(providers);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.sections.price.status, "unavailable");
    assert.equal(snapshot.sections.technical.status, "unavailable");
    assert.equal(snapshot.overallStatus, "unavailable");
    assert.equal(snapshot.warnings.length, 2);
  });
});

describe("MarketContextBuilder — timeout isolation", () => {
  it("times out a slow provider without failing others", async () => {
    const fast = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(),
    });
    const slow = new DelayedMarketContextProvider({
      section: "technical",
      delayMs: 200,
      timeoutMs: 20,
      result: buildTechnicalResult(),
    });
    const builder = makeBuilder([fast, slow]);

    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.sections.price.status, "fresh");
    assert.equal(snapshot.sections.technical.status, "unavailable");
    assert.match(
      snapshot.sections.technical.warnings[0],
      /delayed:technical.*timed out after 20ms/,
    );
  });
});

describe("MarketContextBuilder — parallel execution", () => {
  it("runs providers in parallel (total time ≈ slowest, not sum)", async () => {
    const a = new DelayedMarketContextProvider({
      id: "a",
      section: "price",
      delayMs: 60,
      timeoutMs: 500,
      result: buildPriceResult(),
    });
    const b = new DelayedMarketContextProvider({
      id: "b",
      section: "technical",
      delayMs: 60,
      timeoutMs: 500,
      result: buildTechnicalResult(),
    });
    const builder = makeBuilder([a, b]);

    const start = Date.now();
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    const elapsed = Date.now() - start;

    assert.ok(
      elapsed < 150,
      `expected parallel run to finish under ~150ms, got ${elapsed}ms`,
    );
    assert.equal(snapshot.sections.price.status, "fresh");
    assert.equal(snapshot.sections.technical.status, "fresh");
  });
});

describe("MarketContextBuilder — unknown instrument", () => {
  it("throws on unknown instrumentId (configuration error)", async () => {
    const builder = makeBuilder([]);
    await assert.rejects(
      () => builder.build({ instrumentId: "does_not_exist" }),
      /unknown instrument id "does_not_exist"/,
    );
  });

  it("throws when constructed without a registry", () => {
    assert.throws(
      () =>
        new MarketContextBuilder({
          // deliberately bad config
          registry: undefined as unknown as InstrumentRegistry,
          providers: [],
        }),
      /registry is required/,
    );
  });
});

describe("MarketContextBuilder — collision warnings (first provider wins)", () => {
  it("keeps the first section provider and warns on subsequent duplicates", async () => {
    const winner = new StaticMarketContextProvider({
      id: "winner",
      section: "price",
      result: buildPriceResult(),
    });
    const loser = new StaticMarketContextProvider({
      id: "loser",
      section: "price",
      result: {
        observedAt: FRESH_OBSERVED_AT,
        source: "test:loser",
        data: {
          last: 999,
          bid: 998,
          ask: 1000,
          spread: 2,
          changePct: 0,
          volume: 0,
        },
      },
    });
    const builder = makeBuilder([winner, loser]);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });

    assert.equal(snapshot.sections.price.source, "test:price");
    assert.equal(snapshot.sections.price.data?.last, 100);
    assert.match(
      snapshot.warnings[0],
      /provider "loser" produced section "price".*already provided/,
    );
  });
});

describe("MarketContextBuilder — freshness policy override", () => {
  it("provider freshnessTtlMs shortens its section's TTL", async () => {
    const price = new StaticMarketContextProvider({
      section: "price",
      // 10 s ago
      result: buildPriceResult(new Date(FIXED_NOW.getTime() - 10_000)),
      freshnessTtlMs: 5_000,
    });
    const builder = makeBuilder([price]);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    // 10 s > provider's 5 s override, even though default is 30 s.
    assert.equal(snapshot.sections.price.status, "stale");
  });

  it("builder-level policy override applies to sections without provider override", async () => {
    const price = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(new Date(FIXED_NOW.getTime() - 10_000)),
    });
    const registry = new InstrumentRegistry([makeFuture()]);
    const builder = new MarketContextBuilder({
      registry,
      providers: [price],
      now: () => FIXED_NOW,
      freshnessPolicy: mergeFreshnessPolicy(DEFAULT_FRESHNESS_POLICY, {
        price: 5_000,
      }),
    });
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.sections.price.status, "stale");
  });
});

describe("MarketContextBuilder — deep-freeze", () => {
  async function buildSnapshot(): Promise<MarketContextSnapshot> {
    const price = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(),
    });
    const builder = makeBuilder([price]);
    return builder.build({ instrumentId: "ctx_fut" });
  }

  it("freezes the top-level snapshot", async () => {
    const snapshot = await buildSnapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.throws(() => {
      (snapshot as { instrumentId: string }).instrumentId = "x";
    });
  });

  it("freezes every section object", async () => {
    const snapshot = await buildSnapshot();
    for (const [key, section] of Object.entries(snapshot.sections)) {
      assert.equal(
        Object.isFrozen(section),
        true,
        `section ${key} not frozen`,
      );
    }
  });

  it("freezes nested section data", async () => {
    const snapshot = await buildSnapshot();
    assert.ok(snapshot.sections.price.data);
    assert.equal(Object.isFrozen(snapshot.sections.price.data), true);
    assert.throws(() => {
      (snapshot.sections.price as Section<{ last: number }>).data!.last = 999;
    });
  });

  it("freezes warnings arrays", async () => {
    const price = new FailingMarketContextProvider({ section: "price" });
    const builder = makeBuilder([price]);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(Object.isFrozen(snapshot.warnings), true);
    assert.throws(() => {
      (snapshot.warnings as string[]).push("nope");
    });
    assert.equal(Object.isFrozen(snapshot.sections.price.warnings), true);
    assert.throws(() => {
      (snapshot.sections.price.warnings as string[]).push("nope");
    });
  });

  it("survives cyclic references in provider data (no stack overflow)", async () => {
    // Build a provider whose `data` payload contains a cycle. This
    // is only reachable via a `SectionLoadResult` cast because our
    // typed payloads are acyclic, but a real provider (or a bug in
    // one) could produce this shape, and deepFreeze() must not
    // recurse infinitely.
    type Cyclic = { last: number; self?: Cyclic };
    const cyclic: Cyclic = { last: 42 };
    cyclic.self = cyclic;

    const provider = new StaticMarketContextProvider({
      section: "price",
      result: {
        observedAt: FRESH_OBSERVED_AT,
        source: "test:cyclic",
        data: cyclic as unknown as PriceSectionData,
      },
    });
    const builder = makeBuilder([provider]);

    // If deepFreeze() were not cycle-aware, this would blow the stack.
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });

    assert.equal(Object.isFrozen(snapshot.sections.price.data), true);
    const frozen = snapshot.sections.price.data as unknown as Cyclic;
    assert.equal(frozen.self, frozen);
    assert.equal(Object.isFrozen(frozen.self), true);
  });
});

describe("MarketContextBuilder — warnings surface", () => {
  it("surfaces provider errors and section warnings together", async () => {
    const priceWithWarn = new StaticMarketContextProvider({
      section: "price",
      result: {
        ...buildPriceResult(),
        warnings: ["synthetic-warning"],
      },
    });
    const brokenTech = new FailingMarketContextProvider({
      section: "technical",
      error: new Error("boom"),
    });
    const builder = makeBuilder([priceWithWarn, brokenTech]);

    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    // Section-level warning from provider is preserved verbatim.
    assert.deepEqual(snapshot.sections.price.warnings, ["synthetic-warning"]);
    // Section-level warning about provider failure.
    assert.match(
      snapshot.sections.technical.warnings[0],
      /failing:technical.*boom/,
    );
    // Snapshot-level warnings include only builder-level ones (not
    // per-section provider notes).
    assert.equal(snapshot.warnings.length, 1);
    assert.match(snapshot.warnings[0], /failing:technical/);
  });
});

describe("MarketContextBuilder — supports() filter", () => {
  it("skips providers whose supports() returns false", async () => {
    const gated = new StaticMarketContextProvider({
      section: "price",
      result: buildPriceResult(),
      supportsFilter: (instrument) => instrument.assetClass === "stock",
    });
    const builder = makeBuilder([gated]);
    const snapshot = await builder.build({ instrumentId: "ctx_fut" });
    assert.equal(snapshot.sections.price.status, "unavailable");
    assert.equal(snapshot.warnings.length, 0);
  });
});
