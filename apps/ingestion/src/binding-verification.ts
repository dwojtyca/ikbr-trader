/**
 * PR15.2 — post-resolution verification for bound instrument
 * subscriptions.
 *
 * The TWS `reqContractDetails` path in `TwsClient.resolveContract`
 * already narrows by the configured `conId + localSymbol +
 * tradingClass + exchange + currency`, but that request layer is
 * fire-and-forget: it accepts whatever contract IBKR returns and
 * builds a subscription. This module runs AFTER `resolveContracts`
 * and hard-fails any bound instrument whose resolved contract
 * disagrees with the authoritative binding.
 *
 * "Never subscribe to a mismatch" is the ONLY safe fallback for
 * a futures binding — the operator picked a specific dated
 * contract on purpose. A silent substitution would let ingestion
 * publish market state under the wrong identity and the trading
 * loop would trade the wrong future.
 */

import type {
  BoundInstrument,
  InstrumentBindingAuthority,
} from "@ikbr/shared";
import { tickSizesEqual } from "@ikbr/shared";

import type { InstrumentSubscription, WatchlistInstrument } from "./types.js";

export interface BoundSubscriptionMismatch {
  readonly instrumentId: string;
  readonly reason: string;
}

export interface BoundSubscriptionVerificationResult {
  readonly accepted: InstrumentSubscription[];
  readonly mismatches: BoundSubscriptionMismatch[];
}

function toUpperOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Verify every subscription resolved for a bound `WatchlistInstrument`
 * against the shared `InstrumentBindingAuthority`. Legacy (unbound)
 * subscriptions are passed through unchanged.
 */
export function verifyBoundSubscriptions(input: {
  readonly authority: InstrumentBindingAuthority;
  readonly watchlist: readonly WatchlistInstrument[];
  readonly subscriptions: readonly InstrumentSubscription[];
}): BoundSubscriptionVerificationResult {
  const bySymbol = new Map<string, WatchlistInstrument[]>();
  for (const item of input.watchlist) {
    const key = item.symbol.toUpperCase();
    const list = bySymbol.get(key) ?? [];
    list.push(item);
    bySymbol.set(key, list);
  }
  const accepted: InstrumentSubscription[] = [];
  const mismatches: BoundSubscriptionMismatch[] = [];

  for (const sub of input.subscriptions) {
    const candidates = bySymbol.get(sub.symbol.toUpperCase()) ?? [];
    // Bound candidates carry `instrumentId` (populated by
    // `buildMergedWatchlist`). We match by SYMBOL only here; the
    // conId identity check happens below so a substituted conId
    // (broker returned a different contract than we asked for)
    // still fails-closed. If the same symbol has both a legacy
    // and a bound watchlist entry (a corner case we discourage
    // in production), the bound entry wins — a matching legacy
    // subscription would still route through the identity check
    // because we always prefer the bound branch.
    const boundCandidate = candidates.find(
      (c) => c.instrumentId !== undefined,
    );
    if (!boundCandidate || boundCandidate.instrumentId === undefined) {
      // Legacy (unbound) subscription — pass through.
      accepted.push(sub);
      continue;
    }
    const bound: BoundInstrument | undefined = input.authority.getBoundInstrument(
      boundCandidate.instrumentId,
    );
    if (!bound) {
      mismatches.push({
        instrumentId: boundCandidate.instrumentId,
        reason: `binding vanished for id ${boundCandidate.instrumentId}`,
      });
      continue;
    }
    const contract = (sub.contract ?? {}) as Record<string, unknown>;
    const detailsMinTick =
      sub.instrumentContract?.minTick !== undefined
        ? Number(sub.instrumentContract.minTick)
        : undefined;
    const returnedConId = String(
      contract.conId ?? contract.conid ?? sub.conid ?? "",
    );
    if (returnedConId !== String(bound.conId)) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `conId mismatch: returned=${returnedConId}, bound=${bound.conId}`,
      });
      continue;
    }
    // PR15.2 hostile-review round-3 fix — verify the RETURNED
    // contract symbol, not the REQUESTED watchlist symbol.
    // `sub.symbol` carries the requested `WatchlistInstrument.symbol`
    // which was set from `bound.brokerSymbol` in the first place —
    // comparing it here would be a tautology. The broker's
    // response symbol lives on `sub.contract.symbol` and is the
    // only value that can prove IBKR did NOT substitute.
    // A missing returned symbol is a mismatch (not a skip):
    // ingestion cannot prove the contract identity otherwise.
    // A returned symbol different from `bound.brokerSymbol` is a
    // mismatch that MUST drop the bound subscription — it must
    // not fall back to a legacy pass-through.
    const returnedSymbol = toUpperOrEmpty(contract.symbol);
    if (!returnedSymbol) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `symbol missing in contractDetails (expected ${bound.brokerSymbol})`,
      });
      continue;
    }
    if (returnedSymbol !== bound.brokerSymbol.toUpperCase()) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `symbol mismatch: returned=${returnedSymbol}, bound=${bound.brokerSymbol}`,
      });
      continue;
    }
    // PR15.2 hostile-review fix — every disambiguator MUST be
    // present. A missing field is treated as a mismatch (not as
    // a skip) because ingestion cannot prove the returned
    // contract matches the operator's binding otherwise.
    const returnedExchange = toUpperOrEmpty(contract.exchange);
    if (!returnedExchange) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `exchange missing in contractDetails (expected ${bound.exchange})`,
      });
      continue;
    }
    if (returnedExchange !== bound.exchange.toUpperCase()) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `exchange mismatch: returned=${returnedExchange}, bound=${bound.exchange}`,
      });
      continue;
    }
    const returnedCurrency = toUpperOrEmpty(contract.currency);
    if (!returnedCurrency) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `currency missing in contractDetails (expected ${bound.currency})`,
      });
      continue;
    }
    if (returnedCurrency !== bound.currency.toUpperCase()) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `currency mismatch: returned=${returnedCurrency}, bound=${bound.currency}`,
      });
      continue;
    }
    const returnedLocalSymbol = toUpperOrEmpty(contract.localSymbol);
    if (!returnedLocalSymbol) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `localSymbol missing in contractDetails (expected ${bound.localSymbol})`,
      });
      continue;
    }
    if (returnedLocalSymbol !== bound.localSymbol.toUpperCase()) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `localSymbol mismatch: returned=${returnedLocalSymbol}, bound=${bound.localSymbol}`,
      });
      continue;
    }
    const returnedTradingClass = toUpperOrEmpty(contract.tradingClass);
    if (!returnedTradingClass) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `tradingClass missing in contractDetails (expected ${bound.tradingClass})`,
      });
      continue;
    }
    if (returnedTradingClass !== bound.tradingClass.toUpperCase()) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `tradingClass mismatch: returned=${returnedTradingClass}, bound=${bound.tradingClass}`,
      });
      continue;
    }
    // PR15.2 hostile-review fix — broker-verified `minTick`
    // MUST be present AND match the operator-configured value
    // within representation tolerance.
    if (detailsMinTick === undefined || !Number.isFinite(detailsMinTick)) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `minTick missing in contractDetails (expected ${bound.minTick})`,
      });
      continue;
    }
    if (!tickSizesEqual(detailsMinTick, bound.minTick)) {
      mismatches.push({
        instrumentId: bound.instrumentId,
        reason: `minTick mismatch: returned=${detailsMinTick}, bound=${bound.minTick}`,
      });
      continue;
    }
    // Tag the subscription with the bound identity so `/watchlist`
    // can surface it read-only. Deep-copy is unnecessary because
    // `InstrumentSubscription` is not frozen at this layer and
    // downstream consumers never mutate it.
    accepted.push({ ...sub, instrumentId: bound.instrumentId });
  }

  return { accepted, mismatches };
}
