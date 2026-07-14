/**
 * Market Data Runtime — reader port.
 *
 * A thin, side-effect-free abstraction over the read paths the runtime
 * needs from ingestion's storage (Redis market state).
 *
 * The runtime NEVER writes through this port and never reaches into
 * `SignalRepository` directly; every read the runtime performs goes
 * through `MarketDataRuntimeReader` so tests can substitute a fake.
 *
 * Boundaries (PR12):
 *   - No IBKR calls, no order placement, no execution-engine calls,
 *     no writes to `proposed_orders`.
 *   - No new tables, no new Redis keys, no new ingestion producers.
 *   - Reads are strictly against ingestion's existing storage —
 *     Redis (`market-state:<conid>`) and Postgres
 *     (`instrument_contracts` for the symbol → conid mapping
 *     ingestion already resolves through IBKR at bootstrap).
 */

import type { Instrument } from "@ikbr/shared";

/**
 * Snapshot of the last observed tick for an instrument. `observedAt`
 * is the broker-supplied timestamp of the tick — NEVER the cache hit
 * time — so the market-context freshness classifier compares against
 * the true observation moment.
 */
export interface RuntimeMarketState {
  readonly instrumentId: string;
  readonly lastPrice: number;
  readonly bid?: number;
  readonly ask?: number;
  readonly spread?: number;
  readonly observedAt: Date;
  readonly source: string;
}

/**
 * Read-only port over ingestion's storage. Implementations MUST:
 *
 *   - Return `null` when the underlying store has no data for the
 *     instrument (fail-closed: no fake defaults).
 *   - Throw for infrastructure errors (Redis down, Postgres down,
 *     corrupt JSON). The caller isolates and surfaces the throw as
 *     an unavailable section + warning.
 *   - NOT hide staleness: `observedAt` is the source-of-truth
 *     timestamp; freshness classification is the builder's job.
 */
export interface MarketDataRuntimeReader {
  /**
   * Returns the last market state (tick) for `instrument`, or `null`
   * if ingestion has not published a tick / cannot resolve a conid
   * for the instrument.
   */
  readMarketState(
    instrument: Instrument,
  ): Promise<RuntimeMarketState | null>;
}

// ---------------------------------------------------------------------------
// Contract resolver — symbol → broker conid mapping.
// ---------------------------------------------------------------------------

/**
 * Resolves an `Instrument` (from the shared registry) to the broker
 * conid used by ingestion as the Redis key material.
 *
 * `defaultInstrumentRegistry` deliberately ships without conids —
 * they are broker-assigned and change per contract (front-month
 * futures roll every few weeks). Ingestion resolves them at
 * bootstrap by calling IBKR and persists them in the
 * `instrument_contracts` Postgres table keyed by `symbol`.
 *
 * PR12 reuses that mapping via `SignalRepositoryContractResolver`;
 * no new resolution logic is introduced.
 */
export interface ContractResolver {
  resolveConid(instrument: Instrument): Promise<string | null>;
}

/**
 * Minimal structural port over the Postgres helper that ingestion
 * populates. Declared here so tests can substitute a bare object.
 */
export interface InstrumentContractReadPort {
  getInstrumentContract(
    symbol: string,
    conid?: string,
  ): Promise<{ conid: string; symbol: string } | null>;
}

export interface SignalRepositoryContractResolverOptions {
  readonly repo: InstrumentContractReadPort;
  /**
   * Cache TTL for symbol → conid entries, in milliseconds. A
   * front-month futures roll changes the conid without any change
   * to the shared `Instrument`; caching forever would keep serving
   * the pre-roll conid until the process restarts. A short TTL
   * bounds that staleness window without hammering Postgres on
   * every dry-run.
   *
   * Set to `0` to disable caching entirely.
   */
  readonly cacheTtlMs: number;
  /** Injectable monotonic clock for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Default resolver. Fast path: use `Instrument.conId` when present
 * (some future registry entries may carry it). Fallback: look up
 * `instrument_contracts` by `brokerSymbol`.
 *
 * Cache semantics:
 *   - Each entry stores `{ conid, expiresAt }`.
 *   - Reads inside the TTL window return the cached conid without
 *     hitting Postgres.
 *   - Reads after `expiresAt` re-lookup Postgres and refresh the
 *     entry.
 *   - A Postgres error during refresh does NOT keep the expired
 *     entry alive: the entry is deleted and the error propagates.
 *   - A refresh that returns `null` (symbol no longer resolved)
 *     also deletes the entry — fail-closed.
 *   - TTL of `0` disables caching entirely.
 */
export class SignalRepositoryContractResolver implements ContractResolver {
  readonly #repo: InstrumentContractReadPort;
  readonly #cache = new Map<
    string,
    { readonly conid: string; readonly expiresAt: number }
  >();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: SignalRepositoryContractResolverOptions) {
    if (!options?.repo || typeof options.repo.getInstrumentContract !== "function") {
      throw new Error(
        "SignalRepositoryContractResolver: repo with getInstrumentContract() is required",
      );
    }
    if (
      typeof options.cacheTtlMs !== "number" ||
      !Number.isFinite(options.cacheTtlMs) ||
      options.cacheTtlMs < 0
    ) {
      throw new Error(
        "SignalRepositoryContractResolver: cacheTtlMs must be a non-negative finite number (0 disables caching)",
      );
    }
    this.#repo = options.repo;
    this.#ttlMs = options.cacheTtlMs;
    this.#now = options.now ?? (() => Date.now());
  }

  async resolveConid(instrument: Instrument): Promise<string | null> {
    if (instrument.conId !== undefined && instrument.conId !== null) {
      return String(instrument.conId);
    }
    if (this.#ttlMs > 0) {
      const cached = this.#cache.get(instrument.id);
      if (cached && cached.expiresAt > this.#now()) {
        return cached.conid;
      }
      // Cache miss OR expired entry — evict eagerly. A refresh
      // failure below MUST NOT resurrect the stale entry.
      if (cached) this.#cache.delete(instrument.id);
    }

    const row = await this.#repo.getInstrumentContract(instrument.brokerSymbol);
    if (!row?.conid) return null;

    if (this.#ttlMs > 0) {
      this.#cache.set(instrument.id, {
        conid: row.conid,
        expiresAt: this.#now() + this.#ttlMs,
      });
    }
    return row.conid;
  }
}

// ---------------------------------------------------------------------------
// Concrete implementation over the existing SignalRepository read helpers.
// ---------------------------------------------------------------------------

/**
 * Minimal structural port over the existing Redis-backed
 * `SignalRepository.getMarketState` read.
 */
export interface MarketStateReadPort {
  getMarketState(conid: string): Promise<{
    conid: string;
    symbol: string;
    lastPrice: number;
    bid?: number;
    ask?: number;
    spread?: number;
    ts: string;
  } | null>;
}

export interface SignalRepositoryMarketDataReaderOptions {
  readonly repo: MarketStateReadPort;
  readonly resolver: ContractResolver;
}

/**
 * `MarketDataRuntimeReader` backed by the existing `SignalRepository`.
 * Resolves the symbol → conid mapping through the injected
 * `ContractResolver`, then reads the Redis market-state key ingestion
 * publishes under `market-state:<conid>`.
 *
 * Identity validation (fail-closed): the reader NEVER uses a payload
 * whose `conid` or `symbol` disagrees with the request. A mismatch
 * indicates one of:
 *   - a stale Redis entry left over from a previous contract roll,
 *   - a corrupt / partial JSON write,
 *   - a conid collision between two instruments the runtime asked
 *     about in overlapping calls.
 * In every case the reader returns `null` so `MarketContextBuilder`
 * marks the price section `unavailable` — the pipeline cannot
 * proceed to SUCCESS on data that belongs to a different contract.
 */
export class SignalRepositoryMarketDataReader
  implements MarketDataRuntimeReader
{
  readonly #repo: MarketStateReadPort;
  readonly #resolver: ContractResolver;

  constructor(options: SignalRepositoryMarketDataReaderOptions) {
    if (!options?.repo || typeof options.repo.getMarketState !== "function") {
      throw new Error(
        "SignalRepositoryMarketDataReader: repo with getMarketState() is required",
      );
    }
    if (
      !options.resolver ||
      typeof options.resolver.resolveConid !== "function"
    ) {
      throw new Error(
        "SignalRepositoryMarketDataReader: resolver with resolveConid() is required",
      );
    }
    this.#repo = options.repo;
    this.#resolver = options.resolver;
  }

  async readMarketState(
    instrument: Instrument,
  ): Promise<RuntimeMarketState | null> {
    const resolvedConid = await this.#resolver.resolveConid(instrument);
    if (!resolvedConid) {
      // Ingestion has not resolved this symbol yet — the resolver
      // fails-closed. No fake default; the price section becomes
      // unavailable downstream.
      return null;
    }

    const raw = await this.#repo.getMarketState(resolvedConid);
    if (!raw) return null;

    // Identity validation — payload MUST belong to the exact
    // instrument we asked about. Any mismatch fails-closed.
    if (!isNonEmptyString(raw.conid)) return null;
    if (!isNonEmptyString(raw.symbol)) return null;
    if (raw.conid !== resolvedConid) return null;
    if (raw.symbol !== instrument.brokerSymbol) return null;

    // The stored payload's `ts` is an ISO string. A malformed value
    // is treated as "no data" rather than a runtime error — freshness
    // will classify it as unavailable and the pipeline will not
    // return SUCCESS.
    const observedAt = new Date(raw.ts);
    if (Number.isNaN(observedAt.getTime())) return null;
    if (typeof raw.lastPrice !== "number" || !Number.isFinite(raw.lastPrice)) {
      return null;
    }

    return {
      instrumentId: instrument.id,
      lastPrice: raw.lastPrice,
      ...(typeof raw.bid === "number" && Number.isFinite(raw.bid)
        ? { bid: raw.bid }
        : {}),
      ...(typeof raw.ask === "number" && Number.isFinite(raw.ask)
        ? { ask: raw.ask }
        : {}),
      ...(typeof raw.spread === "number" && Number.isFinite(raw.spread)
        ? { spread: raw.spread }
        : {}),
      observedAt,
      source: `redis:market-state:${raw.conid}`,
    };
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
