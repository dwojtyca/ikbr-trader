import type { Instrument } from "../instruments/types.js";
import type {
  MarketContextSectionKey,
  SectionDataByKey,
} from "./types.js";

/**
 * Input passed by `MarketContextBuilder` to every provider on each
 * build.
 */
export interface ProviderLoadInput {
  readonly instrument: Instrument;
  /** Reference `now` to use for the request (deterministic in tests). */
  readonly now: Date;
}

/**
 * Payload a provider returns for its owned section. `observedAt` is
 * treated as the freshness anchor by the builder (NOT `now` at the
 * time of the call) — a provider serving cached upstream data should
 * report the *original* observation timestamp, not the cache hit time.
 */
export interface SectionLoadResult<K extends MarketContextSectionKey> {
  readonly observedAt: Date;
  readonly source: string;
  readonly data: SectionDataByKey[K];
  readonly warnings?: readonly string[];
}

/**
 * Contract every market-context provider must satisfy. Providers own
 * exactly one section — multi-section behavior is expressed by
 * composing multiple providers, not by returning a bigger payload.
 *
 * Providers MUST NOT:
 *   - place, modify or cancel orders,
 *   - talk to the execution-engine,
 *   - persist state anywhere the builder is not aware of,
 *   - throw for expected upstream failures (return a rejected promise
 *     instead — the builder isolates and surfaces it).
 */
export interface MarketContextProvider<
  K extends MarketContextSectionKey = MarketContextSectionKey,
> {
  readonly id: string;
  readonly section: K;
  /**
   * Hard timeout for `load()`. Builder aborts waiting after this many
   * milliseconds and records a `timeout` warning on the section.
   */
  readonly timeoutMs: number;
  /**
   * Optional per-provider override of the section's TTL. If set, this
   * value overrides `FreshnessPolicy.ttls[section]` for computing this
   * provider's contribution.
   */
  readonly freshnessTtlMs?: number;
  supports(instrument: Instrument): boolean;
  load(input: ProviderLoadInput): Promise<SectionLoadResult<K>>;
}

// ---------------------------------------------------------------------------
// Test-only providers
// ---------------------------------------------------------------------------
// These are exported from the package because the same fixtures are
// useful for downstream integration tests (execution-engine mocks etc.)
// and for architecture documentation examples. They intentionally have
// no I/O.
// ---------------------------------------------------------------------------

export interface StaticProviderOptions<K extends MarketContextSectionKey> {
  readonly id?: string;
  readonly section: K;
  readonly timeoutMs?: number;
  readonly freshnessTtlMs?: number;
  readonly result: SectionLoadResult<K>;
  readonly supportsFilter?: (instrument: Instrument) => boolean;
}

/** Returns a fixed `SectionLoadResult` immediately. */
export class StaticMarketContextProvider<K extends MarketContextSectionKey>
  implements MarketContextProvider<K>
{
  readonly id: string;
  readonly section: K;
  readonly timeoutMs: number;
  readonly freshnessTtlMs?: number;
  readonly #result: SectionLoadResult<K>;
  readonly #supportsFilter?: (instrument: Instrument) => boolean;

  constructor(options: StaticProviderOptions<K>) {
    this.id = options.id ?? `static:${options.section}`;
    this.section = options.section;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.freshnessTtlMs = options.freshnessTtlMs;
    this.#result = options.result;
    this.#supportsFilter = options.supportsFilter;
  }

  supports(instrument: Instrument): boolean {
    return this.#supportsFilter ? this.#supportsFilter(instrument) : true;
  }

  async load(_input: ProviderLoadInput): Promise<SectionLoadResult<K>> {
    return this.#result;
  }
}

export interface FailingProviderOptions<K extends MarketContextSectionKey> {
  readonly id?: string;
  readonly section: K;
  readonly timeoutMs?: number;
  readonly error?: Error;
}

/** Always rejects. Used to exercise builder error isolation. */
export class FailingMarketContextProvider<K extends MarketContextSectionKey>
  implements MarketContextProvider<K>
{
  readonly id: string;
  readonly section: K;
  readonly timeoutMs: number;
  readonly #error: Error;

  constructor(options: FailingProviderOptions<K>) {
    this.id = options.id ?? `failing:${options.section}`;
    this.section = options.section;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.#error =
      options.error ??
      new Error(`FailingMarketContextProvider(${this.id}) always fails`);
  }

  supports(_instrument: Instrument): boolean {
    return true;
  }

  async load(_input: ProviderLoadInput): Promise<SectionLoadResult<K>> {
    throw this.#error;
  }
}

export interface DelayedProviderOptions<K extends MarketContextSectionKey> {
  readonly id?: string;
  readonly section: K;
  readonly timeoutMs?: number;
  readonly freshnessTtlMs?: number;
  readonly delayMs: number;
  readonly result: SectionLoadResult<K>;
  readonly supportsFilter?: (instrument: Instrument) => boolean;
}

/**
 * Resolves after `delayMs`. Used to exercise builder timeout and
 * parallelism.
 */
export class DelayedMarketContextProvider<K extends MarketContextSectionKey>
  implements MarketContextProvider<K>
{
  readonly id: string;
  readonly section: K;
  readonly timeoutMs: number;
  readonly freshnessTtlMs?: number;
  readonly #delayMs: number;
  readonly #result: SectionLoadResult<K>;
  readonly #supportsFilter?: (instrument: Instrument) => boolean;

  constructor(options: DelayedProviderOptions<K>) {
    this.id = options.id ?? `delayed:${options.section}`;
    this.section = options.section;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.freshnessTtlMs = options.freshnessTtlMs;
    this.#delayMs = options.delayMs;
    this.#result = options.result;
    this.#supportsFilter = options.supportsFilter;
  }

  supports(instrument: Instrument): boolean {
    return this.#supportsFilter ? this.#supportsFilter(instrument) : true;
  }

  async load(_input: ProviderLoadInput): Promise<SectionLoadResult<K>> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.#delayMs);
    });
    return this.#result;
  }
}
