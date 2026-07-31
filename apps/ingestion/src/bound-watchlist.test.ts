/**
 * PR15.2 hostile-review round-6 — regression test for the
 * SINGLE production merge function `buildMergedWatchlist`.
 * The test calls the same function `config.ts` calls (never a
 * duplicated inline helper), so any drift between the merge
 * shape and the collision contract is caught here.
 *
 * We do NOT import `apps/ingestion/src/config.ts` (its
 * module-load-time behavior is intentionally side-effectful).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InstrumentBindingAuthority,
  InstrumentRegistry,
  defaultInstrumentRegistry,
} from "@ikbr/shared";
import type { Instrument } from "@ikbr/shared";

import { buildMergedWatchlist } from "./bound-watchlist.js";
import type { WatchlistInstrument } from "./types.js";

describe("buildMergedWatchlist — PR15.2 hostile-review round-6 (single production merge)", () => {
  const authority = new InstrumentBindingAuthority(defaultInstrumentRegistry, [
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

  it("collision: legacy entry is FILTERED OUT of the merged list; bound entry survives; no duplicate conid", () => {
    const legacy: WatchlistInstrument[] = [
      { symbol: "AAPL", conid: "265598" },
      { symbol: "ES-LEGACY", conid: "700001" }, // collides with binding
    ];
    const { mergedWatchlist, boundWatchlist } = buildMergedWatchlist({
      authority,
      legacyWatchlist: legacy,
    });
    // Colliding legacy entry MUST be gone — otherwise ingestion
    // routes the instrument through the permissive resolver and
    // silently bypasses the binding gate.
    const legacyByConid = mergedWatchlist.filter(
      (i) => i.conid === "700001" && i.instrumentId === undefined,
    );
    assert.equal(
      legacyByConid.length,
      0,
      "the legacy entry sharing the bound conid must be filtered out",
    );
    // Bound entry MUST be present with authoritative identity.
    const boundByConid = mergedWatchlist.filter(
      (i) => i.conid === "700001" && i.instrumentId === "es_front",
    );
    assert.equal(boundByConid.length, 1);
    assert.equal(boundByConid[0].secType, "FUT");
    assert.equal(boundByConid[0].symbol, "ES");
    assert.equal(boundByConid[0].localSymbol, "ESU6");
    assert.equal(boundByConid[0].tradingClass, "ES");
    // Unrelated legacy entry untouched.
    assert.equal(
      mergedWatchlist.filter((i) => i.symbol === "AAPL").length,
      1,
    );
    // No duplicate conids in the merged list.
    const conidCounts = new Map<string, number>();
    for (const i of mergedWatchlist) {
      if (!i.conid) continue;
      conidCounts.set(i.conid, (conidCounts.get(i.conid) ?? 0) + 1);
    }
    for (const [c, n] of conidCounts.entries()) {
      assert.equal(
        n,
        1,
        `conid ${c} appears more than once in the merged watchlist`,
      );
    }
    // `boundWatchlist` is the bound-only view returned for the
    // /watchlist diagnostic endpoint.
    assert.equal(boundWatchlist.length, 1);
    assert.equal(boundWatchlist[0].instrumentId, "es_front");
  });

  it("no collision: legacy list preserved in order; bound entry appended", () => {
    const legacy: WatchlistInstrument[] = [
      { symbol: "AAPL", conid: "265598" },
      { symbol: "MSFT", conid: "272093" },
    ];
    const { mergedWatchlist, boundWatchlist } = buildMergedWatchlist({
      authority,
      legacyWatchlist: legacy,
    });
    assert.equal(mergedWatchlist.length, 3);
    // Legacy comes first, in original order.
    assert.equal(mergedWatchlist[0].symbol, "AAPL");
    assert.equal(mergedWatchlist[1].symbol, "MSFT");
    // Bound is appended.
    assert.equal(mergedWatchlist[2].instrumentId, "es_front");
    assert.equal(mergedWatchlist[2].secType, "FUT");
    // Bound-only view remains a single entry.
    assert.equal(boundWatchlist.length, 1);
    assert.equal(boundWatchlist[0].instrumentId, "es_front");
  });

  it("no bindings: merged list equals the legacy list; bound view is empty", () => {
    const emptyAuthority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      [],
    );
    const legacy: WatchlistInstrument[] = [
      { symbol: "AAPL", conid: "265598" },
    ];
    const { mergedWatchlist, boundWatchlist } = buildMergedWatchlist({
      authority: emptyAuthority,
      legacyWatchlist: legacy,
    });
    assert.equal(mergedWatchlist.length, 1);
    assert.equal(mergedWatchlist[0].symbol, "AAPL");
    assert.equal(boundWatchlist.length, 0);
  });

  it("monitoringEnabled=false on a bound instrument: bound entry is NOT emitted AND colliding legacy entry is preserved untouched (PR15.2 hostile-review round-7)", () => {
    // Build a custom `InstrumentRegistry` where `es_front` has
    // `trading.monitoringEnabled=false`. Everything else in the
    // seed is preserved so this is a real registry, not a stub.
    const disabledSeeds: Instrument[] = defaultInstrumentRegistry
      .listAll()
      .map((seed) =>
        seed.id === "es_front"
          ? {
              ...seed,
              trading: { ...seed.trading, monitoringEnabled: false },
            }
          : seed,
      );
    const disabledRegistry = new InstrumentRegistry(disabledSeeds);
    // The binding is configured for the disabled seed AND its
    // conid collides with a legacy watchlist entry. If the
    // production code were to emit the bound entry despite
    // `monitoringEnabled=false`, this collision would suppress
    // the legacy entry — corrupting the merged list in both
    // directions.
    const authority = new InstrumentBindingAuthority(disabledRegistry, [
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
    const collidingLegacy: WatchlistInstrument = {
      symbol: "ES-LEGACY",
      conid: "700001",
    };
    const { mergedWatchlist, boundWatchlist } = buildMergedWatchlist({
      authority,
      legacyWatchlist: [collidingLegacy],
    });
    // Bound entry MUST NOT appear in the diagnostic view.
    assert.equal(
      boundWatchlist.length,
      0,
      "monitoringEnabled=false must skip the bound entry entirely",
    );
    // Legacy entry MUST survive unchanged — no suppression
    // because there is no bound emission to replace it with.
    assert.equal(mergedWatchlist.length, 1);
    assert.equal(mergedWatchlist[0].symbol, "ES-LEGACY");
    assert.equal(mergedWatchlist[0].conid, "700001");
    assert.equal(
      mergedWatchlist[0].instrumentId,
      undefined,
      "legacy entry must not acquire a binding identity",
    );
  });
});
