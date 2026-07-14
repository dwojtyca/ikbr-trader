/**
 * Market Data Runtime — `price` section provider.
 *
 * Adapts `MarketDataRuntimeReader.readMarketState` into a
 * `MarketContextProvider<"price">` so `MarketContextBuilder`
 * composes it uniformly with any other provider.
 *
 * Behaviour:
 *
 *   - Reader returns a `RuntimeMarketState`  → section is filled
 *     with `data.last / bid / ask / spread`; the builder classifies
 *     freshness against `observedAt` and the injected per-section
 *     TTL (`freshnessTtlMs` — defaults to `MARKET_CONTEXT_MAX_TICK_AGE_S`).
 *   - Reader returns `null` (unknown instrument / no tick ever
 *     written / corrupt payload / missing `conId`) → this provider
 *     throws a `MissingMarketStateError`. The builder's error
 *     isolation converts that into an `unavailable` section with a
 *     structured warning — fail-closed, no fabricated defaults.
 *   - Reader throws (Redis / Postgres infrastructure error) → the
 *     builder isolates and surfaces it as an unavailable section.
 *
 * The provider NEVER writes, calls IBKR, or invokes the
 * execution-engine.
 */

import type {
  MarketContextProvider,
  ProviderLoadInput,
  SectionLoadResult,
} from "@ikbr/shared";

import type { MarketDataRuntimeReader } from "./market-data-reader.js";

export class MissingMarketStateError extends Error {
  constructor(instrumentId: string) {
    super(
      `no market state available for instrument "${instrumentId}" ` +
        `(ingestion has not published a tick, or the instrument is not tracked)`,
    );
    this.name = "MissingMarketStateError";
  }
}

export interface PriceContextProviderOptions {
  readonly reader: MarketDataRuntimeReader;
  /** Per-section TTL override for freshness classification. */
  readonly freshnessTtlMs: number;
  /** Hard timeout on `reader.readMarketState`. */
  readonly timeoutMs?: number;
  readonly id?: string;
}

export class PriceContextProvider
  implements MarketContextProvider<"price">
{
  readonly id: string;
  readonly section = "price" as const;
  readonly timeoutMs: number;
  readonly freshnessTtlMs: number;

  readonly #reader: MarketDataRuntimeReader;

  constructor(options: PriceContextProviderOptions) {
    if (!options?.reader) {
      throw new Error("PriceContextProvider: reader is required");
    }
    if (
      !Number.isFinite(options.freshnessTtlMs) ||
      options.freshnessTtlMs <= 0
    ) {
      throw new Error(
        "PriceContextProvider: freshnessTtlMs must be a positive finite number",
      );
    }
    this.#reader = options.reader;
    this.freshnessTtlMs = options.freshnessTtlMs;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.id = options.id ?? "runtime:price:redis";
  }

  supports(): boolean {
    return true;
  }

  async load(input: ProviderLoadInput): Promise<SectionLoadResult<"price">> {
    const state = await this.#reader.readMarketState(input.instrument);
    if (!state) {
      // Fail-closed: no data → the builder will surface this as an
      // `unavailable` section with a warning. A pipeline SUCCESS is
      // impossible without a fresh `price` section.
      throw new MissingMarketStateError(input.instrument.id);
    }
    return {
      observedAt: state.observedAt,
      source: state.source,
      data: {
        last: state.lastPrice,
        ...(state.bid !== undefined ? { bid: state.bid } : {}),
        ...(state.ask !== undefined ? { ask: state.ask } : {}),
        ...(state.spread !== undefined ? { spread: state.spread } : {}),
      },
    };
  }
}
