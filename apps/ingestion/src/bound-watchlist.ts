/**
 * PR15.2 hostile-review round-7 — SINGLE production merge
 * function for the ingestion watchlist.
 *
 * `config.ts` and the ingestion regression tests both call
 * `buildMergedWatchlist`. There is deliberately no other
 * exported builder — a duplicate lower-level export would
 * allow a caller to skip the collision-aware filter and route
 * a bound instrument through the permissive legacy resolver,
 * silently bypassing the authoritative binding gate that
 * PR15.2 exists to enforce.
 *
 * This module is intentionally pure:
 *   - no `process.env` reads,
 *   - no I/O,
 *   - no side effects at import time,
 *   - no `InstrumentRegistry` mutation.
 *
 * Behavior invariants (regression-tested in
 * `bound-watchlist.test.ts` and
 * `tws-client.contract-details.test.ts`):
 *
 *   1. Only bound instruments with
 *      `trading.monitoringEnabled=true` are emitted.
 *   2. On a `conid` collision between a bound entry and a
 *      legacy entry, the BOUND entry ALWAYS WINS: the legacy
 *      entry is filtered out of the merged list and the bound
 *      entry is appended. Keeping the legacy entry would route
 *      ingestion through the permissive `firstDetails` /
 *      secType-STK fallback for a configured binding, silently
 *      bypassing the authoritative identity check.
 *   3. Duplicate bound `conid`s (a startup error caught by
 *      `InstrumentBindingAuthority`) never reach this function.
 *   4. Every emitted bound entry carries the authoritative
 *      broker identity (`symbol`, `conid`, `localSymbol`,
 *      `tradingClass`, `exchange`, `currency`) derived from the
 *      `BoundInstrument`, plus the logical `instrumentId`.
 *   5. `secType` is derived from `Instrument.assetClass` via the
 *      trusted shared `mapAssetClassToIbkrSecType`. NEVER inferred
 *      from symbol, exchange, port, or operator-supplied fields.
 *   6. Order in `mergedWatchlist`: filtered legacy entries first
 *      (original order preserved), then bound entries.
 *   7. No duplicate `conid` appears in `mergedWatchlist`.
 */

import type { InstrumentBindingAuthority } from "@ikbr/shared";
import { mapAssetClassToIbkrSecType } from "@ikbr/shared";

import type { WatchlistInstrument } from "./types.js";

export interface BuildMergedWatchlistInput {
  /** Server-side bound instrument authority. */
  readonly authority: InstrumentBindingAuthority;
  /**
   * Legacy `WATCHLIST_SYMBOLS`-derived entries. Used both for
   * conflict detection and as the base of the merged list.
   * This function does NOT modify the input array.
   */
  readonly legacyWatchlist: readonly WatchlistInstrument[];
}

export interface BuildMergedWatchlistResult {
  /** The full merged list used by ingestion at bootstrap. */
  readonly mergedWatchlist: readonly WatchlistInstrument[];
  /** Bound-only view, used by `/watchlist` diagnostics. */
  readonly boundWatchlist: readonly WatchlistInstrument[];
}

interface BoundExpansion {
  readonly bound: readonly WatchlistInstrument[];
  readonly blockedLegacyConids: ReadonlySet<string>;
}

/**
 * Private helper. Expands the authority into bound
 * `WatchlistInstrument` entries and computes the set of legacy
 * `conid`s the caller must filter out. Intentionally NOT
 * exported — the only public entry point is
 * `buildMergedWatchlist` below, which performs the filter +
 * merge in one step.
 */
function expandBoundEntries(
  input: BuildMergedWatchlistInput,
): BoundExpansion {
  const legacyConids = new Set<string>(
    input.legacyWatchlist
      .map((i) => (i.conid ? String(i.conid) : ""))
      .filter(Boolean),
  );
  const bound: WatchlistInstrument[] = [];
  const blocked = new Set<string>();
  for (const boundInstrument of input.authority.listBoundInstruments()) {
    if (!boundInstrument.instrument.trading.monitoringEnabled) continue;
    const conidStr = String(boundInstrument.conId);
    if (legacyConids.has(conidStr)) {
      blocked.add(conidStr);
    }
    bound.push({
      symbol: boundInstrument.brokerSymbol,
      conid: conidStr,
      // PR15.2 hostile-review round-3 fix — propagate the exact
      // IBKR `secType` derived from the trusted registry's
      // `assetClass`. Without this, `TwsClient.withDefaults()`
      // inserts the ingestion default `STK` even for futures,
      // and the strict `contractDetails` request combines a
      // futures conId + localSymbol with `secType=STK` — an
      // ambiguous IBKR query.
      secType: mapAssetClassToIbkrSecType(
        boundInstrument.instrument.assetClass,
      ),
      exchange: boundInstrument.exchange,
      currency: boundInstrument.currency,
      localSymbol: boundInstrument.localSymbol,
      tradingClass: boundInstrument.tradingClass,
      instrumentId: boundInstrument.instrumentId,
    });
  }
  return { bound, blockedLegacyConids: blocked };
}

/**
 * Build the collision-aware merged watchlist consumed by
 * `config.ts` at boot. Returns the full merged list and the
 * bound-only view; callers MUST NOT reconstruct either.
 */
export function buildMergedWatchlist(
  input: BuildMergedWatchlistInput,
): BuildMergedWatchlistResult {
  const expansion = expandBoundEntries(input);
  const filteredLegacy: readonly WatchlistInstrument[] =
    expansion.blockedLegacyConids.size === 0
      ? input.legacyWatchlist
      : input.legacyWatchlist.filter(
          (i) =>
            !i.conid ||
            !expansion.blockedLegacyConids.has(String(i.conid)),
        );
  const mergedWatchlist: WatchlistInstrument[] = [
    ...filteredLegacy,
    ...expansion.bound,
  ];
  return {
    mergedWatchlist,
    boundWatchlist: expansion.bound,
  };
}
