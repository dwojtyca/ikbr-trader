import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeOverallStatus,
  computeSectionStatus,
  DEFAULT_FRESHNESS_POLICY,
  METADATA_SECTIONS,
  mergeFreshnessPolicy,
} from "./freshness.js";
import type { MarketContextSectionKey, Section } from "./types.js";

function makeSection<T>(
  overrides: Partial<Section<T>> = {},
): Section<T> {
  return {
    status: "unavailable",
    observedAt: null,
    source: null,
    data: null,
    warnings: [],
    ...overrides,
  } as Section<T>;
}

describe("freshness — DEFAULT_FRESHNESS_POLICY", () => {
  it("declares a TTL for every section key", () => {
    const keys: MarketContextSectionKey[] = [
      "instrument",
      "price",
      "technical",
      "macro",
      "crossAsset",
      "positioning",
      "flows",
      "inventory",
      "calendar",
      "news",
      "brokerState",
    ];
    for (const key of keys) {
      assert.ok(
        typeof DEFAULT_FRESHNESS_POLICY.ttls[key] === "number",
        `expected TTL for ${key}`,
      );
    }
  });

  it("holds instrument TTL as +Infinity (registry metadata never stales)", () => {
    assert.equal(
      DEFAULT_FRESHNESS_POLICY.ttls.instrument,
      Number.POSITIVE_INFINITY,
    );
  });

  it("uses conservative real-world TTLs (Phase 1 defaults)", () => {
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.price, 30_000);
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.technical, 5 * 60_000);
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.macro, 15 * 60_000);
    assert.equal(
      DEFAULT_FRESHNESS_POLICY.ttls.positioning,
      7 * 24 * 60 * 60_000,
    );
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.inventory, 24 * 60 * 60_000);
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.calendar, 6 * 60 * 60_000);
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.news, 15 * 60_000);
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.brokerState, 30_000);
  });
});

describe("freshness — mergeFreshnessPolicy", () => {
  it("returns the base policy when override is undefined", () => {
    assert.equal(
      mergeFreshnessPolicy(DEFAULT_FRESHNESS_POLICY),
      DEFAULT_FRESHNESS_POLICY,
    );
  });

  it("overrides only the specified keys", () => {
    const merged = mergeFreshnessPolicy(DEFAULT_FRESHNESS_POLICY, {
      price: 5_000,
      news: 60_000,
    });
    assert.equal(merged.ttls.price, 5_000);
    assert.equal(merged.ttls.news, 60_000);
    assert.equal(
      merged.ttls.technical,
      DEFAULT_FRESHNESS_POLICY.ttls.technical,
    );
  });

  it("does not mutate the base policy", () => {
    mergeFreshnessPolicy(DEFAULT_FRESHNESS_POLICY, { price: 1 });
    assert.equal(DEFAULT_FRESHNESS_POLICY.ttls.price, 30_000);
  });
});

describe("freshness — computeSectionStatus", () => {
  const now = new Date("2026-07-13T12:00:00Z");

  it("returns unavailable when observedAt is null", () => {
    assert.equal(
      computeSectionStatus(null, "price", DEFAULT_FRESHNESS_POLICY, now),
      "unavailable",
    );
  });

  it("returns fresh when age is within TTL", () => {
    const observedAt = new Date(now.getTime() - 10_000); // 10 s ago
    assert.equal(
      computeSectionStatus(observedAt, "price", DEFAULT_FRESHNESS_POLICY, now),
      "fresh",
    );
  });

  it("returns stale when age exceeds TTL", () => {
    const observedAt = new Date(now.getTime() - 60_000); // 60 s ago
    assert.equal(
      computeSectionStatus(observedAt, "price", DEFAULT_FRESHNESS_POLICY, now),
      "stale",
    );
  });

  it("returns fresh when age equals TTL (boundary is inclusive)", () => {
    const observedAt = new Date(now.getTime() - 30_000);
    assert.equal(
      computeSectionStatus(observedAt, "price", DEFAULT_FRESHNESS_POLICY, now),
      "fresh",
    );
  });

  it("treats +Infinity TTL as always fresh (instrument)", () => {
    const observedAt = new Date(now.getTime() - 365 * 24 * 60 * 60_000);
    assert.equal(
      computeSectionStatus(
        observedAt,
        "instrument",
        DEFAULT_FRESHNESS_POLICY,
        now,
      ),
      "fresh",
    );
  });

  it("treats negative age (clock skew) as fresh, not stale", () => {
    const observedAt = new Date(now.getTime() + 5_000);
    assert.equal(
      computeSectionStatus(observedAt, "price", DEFAULT_FRESHNESS_POLICY, now),
      "fresh",
    );
  });
});

describe("freshness — computeOverallStatus", () => {
  const now = new Date("2026-07-13T12:00:00Z");
  const observedAt = new Date(now.getTime() - 1_000);
  const fresh: Section<unknown> = makeSection({
    status: "fresh",
    observedAt,
    source: "test",
    data: {},
  });
  const stale: Section<unknown> = makeSection({
    status: "stale",
    observedAt,
    source: "test",
    data: {},
  });
  const unavailable: Section<unknown> = makeSection();

  function buildMap(
    override: Partial<Record<MarketContextSectionKey, Section<unknown>>>,
  ): Record<MarketContextSectionKey, Section<unknown>> {
    const base = {
      instrument: fresh,
      price: unavailable,
      technical: unavailable,
      macro: unavailable,
      crossAsset: unavailable,
      positioning: unavailable,
      flows: unavailable,
      inventory: unavailable,
      calendar: unavailable,
      news: unavailable,
      brokerState: unavailable,
    } as Record<MarketContextSectionKey, Section<unknown>>;
    return { ...base, ...override };
  }

  it("declares the instrument section as metadata (excluded from overall)", () => {
    assert.deepEqual([...METADATA_SECTIONS], ["instrument"]);
  });

  it("returns unavailable when every data section is unavailable", () => {
    assert.equal(computeOverallStatus(buildMap({})), "unavailable");
  });

  it("returns fresh when every data section is fresh", () => {
    const allFresh = buildMap({
      price: fresh,
      technical: fresh,
      macro: fresh,
      crossAsset: fresh,
      positioning: fresh,
      flows: fresh,
      inventory: fresh,
      calendar: fresh,
      news: fresh,
      brokerState: fresh,
    });
    assert.equal(computeOverallStatus(allFresh), "fresh");
  });

  it("returns stale when every data section is stale", () => {
    const allStale = buildMap({
      price: stale,
      technical: stale,
      macro: stale,
      crossAsset: stale,
      positioning: stale,
      flows: stale,
      inventory: stale,
      calendar: stale,
      news: stale,
      brokerState: stale,
    });
    assert.equal(computeOverallStatus(allStale), "stale");
  });

  it("returns partial when statuses are mixed", () => {
    const mixed = buildMap({ price: fresh, technical: stale });
    assert.equal(computeOverallStatus(mixed), "partial");
  });

  it("ignores the instrument section — a lone fresh instrument does NOT become fresh overall", () => {
    // instrument is fresh, everything else unavailable → still unavailable.
    assert.equal(computeOverallStatus(buildMap({})), "unavailable");
  });
});
