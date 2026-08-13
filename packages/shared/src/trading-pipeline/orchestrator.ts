/**
 * Trading Pipeline — public runtime orchestrator.
 *
 * `TradingPipeline.run(...)` executes the deterministic pipeline:
 *
 *   SignalEngine.evaluate(snapshot)
 *     └─ if status === "GENERATED":
 *          ExecutionTicketBuilder.build({ signal, snapshot, instrument, policy })
 *     └─ if status === "HOLD":
 *          → NO_TRADE (not a failure)
 *     └─ otherwise (BLOCKED | REJECTED | ERROR):
 *          → FAILURE with the appropriate `failedStage`.
 *
 * The orchestrator never places, modifies, or cancels orders. It
 * never opens a socket, reads from Redis or Postgres, or calls an
 * LLM. It is the runtime entry point that a future integration PR
 * (see [docs/implementation/phase2/PHASE_2_ROADMAP.md](../../../../docs/implementation/phase2/PHASE_2_ROADMAP.md))
 * will wire behind an injected `TicketSubmitter` port.
 *
 * ## Error isolation contract
 *
 * `run()` MUST NOT propagate any exception. This is enforced with
 * layered defence:
 *
 *   1. Injected clocks (`now`, `performanceNow`) are read through
 *      `safeNow` / `safePerformanceNow`. A broken clock is captured
 *      once — the pipeline NEVER re-invokes a clock that already
 *      threw or returned an invalid value. `performanceNow` is
 *      invoked AT MOST TWICE per `run()` (start + end); the
 *      resulting duration is memoized so any subsequent
 *      `measureDuration()` call (e.g. from the top-level catch)
 *      reuses the cached value without touching the clock again.
 *   2. Every read from the snapshot / signal / ticket objects that
 *      could trigger a hostile getter (warning arrays, metadata
 *      versions, ticket builder version, etc.) is wrapped in
 *      `trySafe` with a benign fallback.
 *   3. The engine calls (`SignalEngine.evaluate`,
 *      `ExecutionTicketBuilder.build`) are wrapped by
 *      `runSignalStep` / `runTicketStep`.
 *   4. Branches that construct a blocker via `describeUnknownError`
 *      capture `measureDuration()` into a local variable BEFORE the
 *      potentially-throwing description call, so if the description
 *      throws, the top-level catch can reuse the memoized duration.
 *   5. The entire body of `run()` is wrapped in a final `try /
 *      catch` that yields a `PIPELINE_INTERNAL_ERROR` failure if
 *      any other code path throws unexpectedly.
 *   6. Deep freeze uses `safeDeepFreezePipelineResult`, which
 *      swallows freeze failures and returns the un-frozen value.
 *      This is BEST-EFFORT: a `TradingPipelineResult` returned by
 *      `run()` is normally deep-frozen, but callers cannot rely
 *      on it for hostile / exotic runtime objects.
 */

import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type { ExecutionTicketPolicy } from "../execution-ticket/types.js";
import type { SignalAttributionContext } from "../signal-engine/types.js";

import {
  describeUnknownError,
  runSignalStep,
  runTicketStep,
  safeNow,
  safePerformanceNow,
  trySafe,
  type ExecutionTicketBuilderLike,
  type SafeClockOutcome,
  type SignalEngineLike,
} from "./pipeline.js";
import {
  blockersFromTicketFailure,
  deriveFailedStageFromSignal,
  safeDeepFreezePipelineResult,
  warningsFromSignal,
  warningsFromTicket,
} from "./result.js";
import type {
  TradingPipelineBlocker,
  TradingPipelineEngineVersions,
  TradingPipelineFailure,
  TradingPipelineMetadata,
  TradingPipelineNoTrade,
  TradingPipelineResult,
  TradingPipelineSuccess,
  TradingPipelineWarning,
} from "./types.js";

export const TRADING_PIPELINE_VERSION = "0.1.0";

/** Fallback wall-clock used when the injected `now` clock is broken. */
const FALLBACK_RAN_AT = new Date(0);

/** Fallback duration used when the monotonic clock is broken. */
const FALLBACK_DURATION_MS = 0;

export interface TradingPipelineOptions {
  readonly signalEngine: SignalEngineLike;
  readonly ticketBuilder: ExecutionTicketBuilderLike;
  /** Deterministic wall clock. Default `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Monotonic clock used only for `durationMs`. Injectable so tests
   * can produce deterministic durations. Default: `() => performance.now()`.
   */
  readonly performanceNow?: () => number;
  /** Reported in `TradingPipelineMetadata.engineVersions.pipeline`. */
  readonly version?: string;
}

export class TradingPipeline {
  readonly #signalEngine: SignalEngineLike;
  readonly #ticketBuilder: ExecutionTicketBuilderLike;
  readonly #now: () => Date;
  readonly #performanceNow: () => number;
  readonly #version: string;

  constructor(options: TradingPipelineOptions) {
    if (!options || typeof options.signalEngine?.evaluate !== "function") {
      throw new Error(
        "TradingPipeline: signalEngine with an evaluate() method is required",
      );
    }
    if (typeof options.ticketBuilder?.build !== "function") {
      throw new Error(
        "TradingPipeline: ticketBuilder with a build() method is required",
      );
    }
    this.#signalEngine = options.signalEngine;
    this.#ticketBuilder = options.ticketBuilder;
    this.#now = options.now ?? (() => new Date());
    this.#performanceNow = options.performanceNow ?? (() => performance.now());
    this.#version = options.version ?? TRADING_PIPELINE_VERSION;
  }

  run(
    snapshot: MarketContextSnapshot,
    instrument: Instrument,
    policy: ExecutionTicketPolicy,
    attribution?: SignalAttributionContext,
  ): TradingPipelineResult {
    // ------------------------------------------------------------------
    // Read clocks defensively BEFORE anything else. A broken clock is
    // captured once and never re-invoked; downstream code uses the
    // stored `SafeClockOutcome` values (or fallbacks) instead of
    // calling the clock again.
    // ------------------------------------------------------------------
    const startClock = safePerformanceNow(this.#performanceNow);
    const ranAtClock = safeNow(this.#now);
    const ranAt = ranAtClock.ok ? ranAtClock.value : FALLBACK_RAN_AT;

    /**
     * Compute the pipeline's `durationMs` at most once per `run()`.
     *
     * Guarantees:
     *   - `performanceNow` is invoked AT MOST TWICE per run — once
     *     for the start clock (already done above) and once for the
     *     end clock (on the first call to `measureDuration`).
     *   - Every subsequent call returns the memoized value without
     *     re-invoking any clock. This matters when the top-level
     *     `catch` in `run()` fires after `#runInner` has already
     *     measured duration: reusing the (potentially broken) end
     *     clock is explicitly forbidden by the isolation contract.
     *   - A broken start clock, broken end clock, or a non-finite
     *     / negative delta all collapse to `FALLBACK_DURATION_MS`
     *     (also memoized).
     */
    let cachedDurationMs: number | undefined;
    const measureDuration = (): number => {
      if (cachedDurationMs !== undefined) return cachedDurationMs;
      if (!startClock.ok) {
        cachedDurationMs = FALLBACK_DURATION_MS;
        return cachedDurationMs;
      }
      const end = safePerformanceNow(this.#performanceNow);
      if (!end.ok) {
        cachedDurationMs = FALLBACK_DURATION_MS;
        return cachedDurationMs;
      }
      const delta = end.value - startClock.value;
      cachedDurationMs =
        Number.isFinite(delta) && delta >= 0 ? delta : FALLBACK_DURATION_MS;
      return cachedDurationMs;
    };

    try {
      return this.#runInner({
        snapshot,
        instrument,
        policy,
        startClock,
        ranAt,
        measureDuration,
        ...(attribution ? { attribution } : {}),
      });
    } catch (error) {
      // Last-resort catch: something inside the pipeline itself
      // (warning mapping, metadata assembly, freeze, or an
      // unexpected code path) threw. Emit a minimal, safe
      // `PIPELINE_INTERNAL_ERROR` failure.
      //
      // `measureDuration()` here is memoized: if `#runInner` already
      // measured (and possibly recorded a broken end clock), the
      // cached value is reused and the broken clock is NOT
      // re-invoked. If duration has never been measured, this call
      // reads the end clock exactly once (still bounded by the
      // "at most twice" guarantee on `performanceNow`).
      return this.#buildInternalErrorFailure({
        error,
        ranAt,
        durationMs: trySafe(measureDuration, FALLBACK_DURATION_MS),
      });
    }
  }

  // --------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------

  #runInner(ctx: {
    readonly snapshot: MarketContextSnapshot;
    readonly instrument: Instrument;
    readonly policy: ExecutionTicketPolicy;
    readonly startClock: SafeClockOutcome<number>;
    readonly ranAt: Date;
    readonly measureDuration: () => number;
    readonly attribution?: SignalAttributionContext;
  }): TradingPipelineResult {
    const {
      snapshot,
      instrument,
      policy,
      ranAt,
      measureDuration,
      attribution,
    } = ctx;

    // ------------------------------------------------------------------
    // Stage 1 — Signal (Decision + Risk inside SignalEngine)
    // ------------------------------------------------------------------
    const signalOutcome = runSignalStep(
      this.#signalEngine,
      snapshot,
      attribution,
    );

    if (signalOutcome.errored) {
      // Measure BEFORE constructing the blocker: `describeUnknownError`
      // reads `error.message`, which can throw for hostile Error-like
      // objects. If it throws, the top-level catch fires — the
      // memoized `measureDuration` will then return this same value
      // without re-invoking the clock.
      const durationMs = measureDuration();
      const versions: TradingPipelineEngineVersions = {
        pipeline: this.#version,
      };
      return this.#buildFailure({
        signal: null,
        blockers: [
          {
            code: "PIPELINE_SIGNAL_STAGE_THREW",
            message: describeUnknownError(signalOutcome.error),
            source: "trading-pipeline",
            stage: "UNKNOWN",
          },
        ],
        warnings: [],
        failedStage: "UNKNOWN",
        versions,
        ranAt,
        durationMs,
      });
    }

    const signal = signalOutcome.signal;
    // Signal properties can be hostile getters — wrap the reads that
    // are safe to fall back on. NOTE: `signal.status` is intentionally
    // NOT wrapped: it is the classification key, and a signal whose
    // status is unreadable is by definition not classifiable — that
    // case must escape to the top-level catch and yield a
    // `PIPELINE_INTERNAL_ERROR` failure rather than silently degrading
    // into an empty-blocker `UNKNOWN` outcome.
    const signalWarnings = trySafe(() => warningsFromSignal(signal), []);
    const baseVersions = this.#readSignalVersions(signal);

    // HOLD is a valid terminal decision, NOT a failure. Return a
    // dedicated `NO_TRADE` outcome so consumers can distinguish
    // "engine intentionally stood aside" from "engine could not
    // produce a trade".
    const signalStatus = signal.status;
    if (signalStatus === "HOLD") {
      const noTrade: TradingPipelineNoTrade = {
        outcome: "NO_TRADE",
        signal,
        ticket: null,
        reason: "HOLD",
        warnings: signalWarnings,
        durationMs: measureDuration(),
        metadata: {
          engineVersions: baseVersions,
          ranAt,
        },
      };
      return safeDeepFreezePipelineResult(noTrade);
    }

    if (signalStatus !== "GENERATED") {
      const failedStage = trySafe(
        () => deriveFailedStageFromSignal(signal),
        "UNKNOWN" as const,
      );
      // Do NOT copy Decision/Risk blockers into pipeline blockers.
      // The authoritative diagnostics live on the `SignalEvaluation`
      // itself (`signal.decision?.blockedBy`, `signal.risk?.blockers`,
      // `signal.warnings`). Pipeline blockers exist only for TICKET
      // and UNKNOWN stages.
      return this.#buildFailure({
        signal,
        blockers: [],
        warnings: signalWarnings,
        failedStage,
        versions: baseVersions,
        ranAt,
        durationMs: measureDuration(),
      });
    }

    // ------------------------------------------------------------------
    // Stage 2 — Execution Ticket
    // ------------------------------------------------------------------
    const ticketOutcome = runTicketStep(this.#ticketBuilder, {
      signal,
      snapshot,
      instrument,
      policy,
    });

    if (ticketOutcome.threw) {
      // Same pattern as `signalOutcome.errored`: measure BEFORE the
      // potentially-throwing `describeUnknownError` call so the
      // memoized duration is available if the top-level catch fires.
      const durationMs = measureDuration();
      return this.#buildFailure({
        signal,
        blockers: [
          {
            code: "PIPELINE_TICKET_STAGE_THREW",
            message: describeUnknownError(ticketOutcome.error),
            source: "trading-pipeline",
            stage: "UNKNOWN",
          },
        ],
        warnings: signalWarnings,
        failedStage: "UNKNOWN",
        versions: baseVersions,
        ranAt,
        durationMs,
      });
    }

    const ticketResult = ticketOutcome.result;
    const ticketWarnings = trySafe(() => warningsFromTicket(ticketResult), []);
    const mergedWarnings: readonly TradingPipelineWarning[] = [
      ...signalWarnings,
      ...ticketWarnings,
    ];

    // Read `ticketResult.ok` directly (NOT through `trySafe`): it is a
    // control-flow discriminator, and losing narrowing here forces a
    // cast on every subsequent field access. A hostile `.ok` getter
    // will be caught by the top-level `run()` catch and become a
    // `PIPELINE_INTERNAL_ERROR`.
    if (!ticketResult.ok) {
      const ticketBlockers = trySafe(
        () => blockersFromTicketFailure(ticketResult.blockers ?? []),
        [] as readonly TradingPipelineBlocker[],
      );
      return this.#buildFailure({
        signal,
        blockers: ticketBlockers,
        warnings: mergedWarnings,
        failedStage: "TICKET",
        versions: baseVersions,
        ranAt,
        durationMs: measureDuration(),
      });
    }

    // ------------------------------------------------------------------
    // Success
    // ------------------------------------------------------------------
    const ticket = ticketResult.ticket;
    const builderVersion = trySafe(
      () => ticket?.metadata?.builderVersion,
      undefined,
    );
    const metadata: TradingPipelineMetadata = {
      engineVersions: {
        ...baseVersions,
        ...(builderVersion !== undefined
          ? { ticketBuilder: builderVersion }
          : {}),
      },
      ranAt,
    };

    const success: TradingPipelineSuccess = {
      outcome: "SUCCESS",
      signal,
      ticket,
      warnings: mergedWarnings,
      durationMs: measureDuration(),
      metadata,
    };
    return safeDeepFreezePipelineResult(success);
  }

  /**
   * Extract the signal / decision / risk engine versions defensively.
   * Any hostile getter on `signal.metadata.engineVersions` is
   * swallowed and the corresponding field is simply omitted.
   */
  #readSignalVersions(signal: unknown): TradingPipelineEngineVersions {
    const versions: TradingPipelineEngineVersions = { pipeline: this.#version };
    const inner = trySafe(
      () =>
        (signal as { metadata?: { engineVersions?: Record<string, unknown> } })
          ?.metadata?.engineVersions,
      undefined,
    );
    if (!inner) return versions;
    const signalVersion = trySafe(() => inner.signal, undefined);
    const decisionVersion = trySafe(() => inner.decision, undefined);
    const riskVersion = trySafe(() => inner.risk, undefined);
    return {
      ...versions,
      ...(typeof signalVersion === "string" ? { signal: signalVersion } : {}),
      ...(typeof decisionVersion === "string"
        ? { decision: decisionVersion }
        : {}),
      ...(typeof riskVersion === "string" ? { risk: riskVersion } : {}),
    };
  }

  #buildFailure(input: {
    readonly signal: TradingPipelineFailure["signal"];
    readonly blockers: readonly TradingPipelineBlocker[];
    readonly warnings: readonly TradingPipelineWarning[];
    readonly failedStage: TradingPipelineFailure["failedStage"];
    readonly versions: TradingPipelineEngineVersions;
    readonly ranAt: Date;
    readonly durationMs: number;
  }): TradingPipelineFailure {
    const failure: TradingPipelineFailure = {
      outcome: "FAILURE",
      signal: input.signal,
      ticket: null,
      blockers: input.blockers,
      warnings: input.warnings,
      failedStage: input.failedStage,
      durationMs: input.durationMs,
      metadata: {
        engineVersions: input.versions,
        ranAt: input.ranAt,
      },
    };
    return safeDeepFreezePipelineResult(failure);
  }

  /**
   * Emergency failure builder used by the top-level `run()` catch.
   * MUST NOT touch the caller-supplied clocks or the (possibly
   * hostile) signal / ticket objects — `ranAt` and `durationMs`
   * are pre-computed by `run()` using safe fallbacks.
   *
   * The returned result contains NO references to caller-provided
   * objects (`signal: null`, `ticket: null`, warnings are an empty
   * literal, blockers hold only plain strings, metadata holds only
   * primitives and a `Date`). In practice the freeze walk always
   * succeeds; formally we still route through
   * `safeDeepFreezePipelineResult` so a pathological subclassed
   * `Date` (or similar) cannot violate the "no throw leaves
   * `run()`" contract.
   */
  #buildInternalErrorFailure(input: {
    readonly error: unknown;
    readonly ranAt: Date;
    readonly durationMs: number;
  }): TradingPipelineFailure {
    const message = trySafe(
      () => describeUnknownError(input.error),
      "unknown error",
    );
    const failure: TradingPipelineFailure = {
      outcome: "FAILURE",
      signal: null,
      ticket: null,
      blockers: [
        {
          code: "PIPELINE_INTERNAL_ERROR",
          message,
          source: "trading-pipeline",
          stage: "UNKNOWN",
        },
      ],
      warnings: [],
      failedStage: "UNKNOWN",
      durationMs: input.durationMs,
      metadata: {
        engineVersions: { pipeline: this.#version },
        ranAt: input.ranAt,
      },
    };
    return safeDeepFreezePipelineResult(failure);
  }
}
