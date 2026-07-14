/**
 * Market Data Runtime — orchestration entry point.
 *
 * `MarketDataRuntime.dryRun(instrumentId, policy)`:
 *   1. Resolves the `Instrument` via the shared `InstrumentRegistry`.
 *   2. Builds a `MarketContextSnapshot` from the configured providers
 *      (the runtime ships with `PriceContextProvider` — other sections
 *      remain `unavailable`).
 *   3. Feeds the snapshot to the injected `TradingPipeline`.
 *   4. Returns the raw `TradingPipelineResult`.
 *
 * PR12 constraints — enforced by construction:
 *   - No HTTP call to `execution-engine`.
 *   - No writes to Postgres, Redis, or `proposed_orders`.
 *   - No IBKR / broker interaction.
 *   - No scheduler / cron.
 *   - No LLM.
 */

import {
  MarketContextBuilder,
  mergeFreshnessPolicy,
  type FreshnessPolicy,
  type InstrumentRegistry,
  type MarketContextProvider,
  type MarketContextSnapshot,
  type ExecutionTicketPolicy,
  type TradingPipeline,
  type TradingPipelineResult,
} from "@ikbr/shared";

export interface MarketDataRuntimeOptions {
  readonly registry: InstrumentRegistry;
  readonly providers: readonly MarketContextProvider[];
  readonly pipeline: TradingPipeline;
  /** Optional override for the default freshness policy. */
  readonly freshnessPolicy?: FreshnessPolicy;
  /** Deterministic wall clock. Default: `() => new Date()`. */
  readonly now?: () => Date;
}

export interface DryRunResult {
  readonly instrumentId: string;
  readonly snapshot: MarketContextSnapshot;
  readonly pipeline: TradingPipelineResult;
}

export class MarketDataRuntime {
  readonly #registry: InstrumentRegistry;
  readonly #builder: MarketContextBuilder;
  readonly #pipeline: TradingPipeline;

  constructor(options: MarketDataRuntimeOptions) {
    if (!options?.registry) {
      throw new Error("MarketDataRuntime: registry is required");
    }
    if (!options.pipeline || typeof options.pipeline.run !== "function") {
      throw new Error(
        "MarketDataRuntime: pipeline with a run() method is required",
      );
    }
    if (!Array.isArray(options.providers)) {
      throw new Error("MarketDataRuntime: providers array is required");
    }
    this.#registry = options.registry;
    this.#pipeline = options.pipeline;
    this.#builder = new MarketContextBuilder({
      registry: options.registry,
      providers: options.providers,
      ...(options.freshnessPolicy
        ? { freshnessPolicy: options.freshnessPolicy }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /**
   * Compose registry → snapshot → pipeline for a single instrument.
   *
   * Errors:
   *   - Unknown `instrumentId` → the shared
   *     `InstrumentRegistry.getInstrumentOrThrow` throws, and this
   *     method rethrows. Callers (HTTP layer) map to `404`.
   *   - Any provider / builder failure is already isolated inside
   *     `MarketContextBuilder` — no throw leaves this method for
   *     data-availability issues.
   *   - `TradingPipeline.run` never throws (its own isolation
   *     contract).
   */
  async dryRun(
    instrumentId: string,
    policy: ExecutionTicketPolicy,
  ): Promise<DryRunResult> {
    // Explicit registry check: MarketContextBuilder would already
    // throw, but we surface the error at the outer boundary with the
    // instrumentId in scope so HTTP callers can distinguish
    // "unknown instrument" from "provider failed".
    const instrument = this.#registry.getInstrumentOrThrow(instrumentId);
    const snapshot = await this.#builder.build({ instrumentId });
    const pipelineResult = this.#pipeline.run(snapshot, instrument, policy);
    return { instrumentId, snapshot, pipeline: pipelineResult };
  }
}

/**
 * Convenience helper — mirrors the runtime env in
 * `apps/signal-engine/src/config.ts` (MARKET_CONTEXT_MAX_TICK_AGE_S)
 * into a `FreshnessPolicy` override. Kept small and pure so the
 * app-level composer can call it without importing zod.
 */
export function buildRuntimeFreshnessPolicy(input: {
  readonly base: FreshnessPolicy;
  readonly maxTickAgeMs: number;
}): FreshnessPolicy {
  return mergeFreshnessPolicy(input.base, { price: input.maxTickAgeMs });
}
