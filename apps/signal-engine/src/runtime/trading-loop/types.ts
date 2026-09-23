/**
 * Trading Loop — public types.
 *
 * PR14 adds a paper-only scheduler inside `apps/signal-engine`. It
 * cyclically:
 *   - selects registry-enabled instruments,
 *   - queries the execution-engine for current exposure,
 *   - hands the resulting `ExecuteInput` to the existing
 *     `ExecutionRuntime` from PR13,
 *   - reports a per-instrument outcome for observability.
 *
 * The loop NEVER contacts the broker directly, never opens a second
 * position while one is active, never closes positions, and never
 * generates duplicate submissions — those invariants are enforced
 * respectively by the `TradingExposureReader`, the exposure guard
 * in `TradingLoopService.runInstrument`, and the fencing marker in
 * `ExecutionRuntime` (PR13).
 */

import type {
  ExecutionRuntimeOutcome,
  NotSubmittedReason,
} from "../execution/execution-runtime.js";

/**
 * Reasons the loop can skip an instrument BEFORE calling the
 * underlying `ExecutionRuntime`. Distinct from
 * `ExecutionRuntimeOutcome` so observers can see whether the skip
 * happened at the loop layer (exposure guard, run-in-progress,
 * concurrency cap) or at the runtime layer (paper guard, pipeline).
 */
export type TradingLoopSkipReason =
  | "LOOP_DISABLED"
  | "NOT_IN_SCOPE"
  | "RUN_IN_PROGRESS"
  | "CONCURRENCY_CAP"
  | "EXPOSURE_BLOCKED"
  | "EXPOSURE_READ_FAILED"
  | "RECONCILIATION_UNAVAILABLE"
  | "RECONCILIATION_STALE"
  | "RECONCILIATION_HOLD"
  // PR15.2 — the instrument does not have a configured
  // `INSTRUMENT_BINDINGS_JSON` entry, or the entry is stale
  // relative to the shared registry. Loop refuses to fabricate
  // symbol / conId identity.
  | "INSTRUMENT_BINDING_UNAVAILABLE"
  // PR15.4 — `hasOpenPosition === false` but `quantity` is
  // non-zero. Fail-closed: exposure data is internally
  // inconsistent, refuse to build a context on top of it.
  | "EXPOSURE_DATA_CONTRADICTION"
  // PR15.4 — the once-per-cycle `syncStrategyRuntimeStates` call
  // threw before per-instrument work started; every selected
  // instrument surfaces this reason.
  | "STRATEGY_STATE_SYNC_UNAVAILABLE"
  // PR15.4 — a single-strategy `getStrategyRuntimeState()` call
  // threw inside `resolveActiveStrategyIds()`.
  | "STRATEGY_STATE_UNAVAILABLE"
  // PR15.4 — no strategy is currently active for this
  // instrument (all excluded, disabled, or in cooldown), OR
  // the portfolio manager produced no `selected` candidate.
  | "NO_STRATEGY_SIGNAL"
  // PR15.4 — the persisted contract for the bound `conId`
  // disagrees with `BoundInstrument` on any required field.
  | "STRATEGY_CONTRACT_MISMATCH"
  // PR15.4 — candles / market state missing, stale, or
  // insufficient to compute indicators for the strategy
  // context.
  | "STRATEGY_CONTEXT_UNAVAILABLE"
  // PR15.4 — a strategy's `generateSignal()` threw inside
  // `StrategyPortfolioManager.run()`.
  | "STRATEGY_EVALUATION_ERROR"
  // PR15.4 — the portfolio manager returned both LONG and
  // SHORT candidates for the same instrument.
  | "STRATEGY_CONFLICT"
  // PR15.4 — the pre-dryRun attribution chain (§10.1)
  // detected a mismatch between the winning signal, the
  // instrument, and the execution policy; or the post-pipeline
  // defence-in-depth (§10.2) detected pipeline attribution
  // divergence.
  | "STRATEGY_POLICY_MISMATCH";

/**
 * Outcome union for a single instrument tick. Kept small on
 * purpose — every branch has an obvious observability semantic
 * for the status endpoint and the pino log stream.
 */
export type TradingLoopInstrumentOutcome =
  | {
      readonly kind:
        | "SUBMITTED"
        | "DUPLICATE"
        | "PENDING"
        | "AWAITING_AI"
        | "CONFLICT"
        | "UNKNOWN";
      readonly instrumentId: string;
      readonly idempotencyKey: string;
      readonly runtime: ExecutionRuntimeOutcome;
    }
  | {
      readonly kind: "NOT_SUBMITTED";
      readonly instrumentId: string;
      readonly idempotencyKey: string;
      readonly runtime: ExecutionRuntimeOutcome;
      // PR15.4 — import the canonical `NotSubmittedReason` union
      // from `ExecutionRuntime` instead of maintaining a manual
      // mirror. Loop-owned orchestration reasons (that
      // `ExecutionRuntime` never produces) are the three extra
      // literals below. `#classifyRuntimeOutcome` can now pass
      // `runtime.reason` through without any cast, and future
      // `NotSubmittedReason` additions require no second union.
      readonly reason:
        | NotSubmittedReason
        | "INSTRUMENT_POLICY_UNAVAILABLE"
        | "TRIGGER_UNAVAILABLE"
        | "STRATEGY_POLICY_MISMATCH";
      readonly message?: string;
    }
  | {
      readonly kind: "SKIPPED";
      readonly instrumentId: string;
      readonly reason: TradingLoopSkipReason;
      readonly message?: string;
    }
  | {
      readonly kind: "ERROR";
      readonly instrumentId: string;
      readonly message: string;
    };

export interface TradingLoopInstrumentReport {
  readonly cycleId: string;
  readonly instrumentId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly outcome: TradingLoopInstrumentOutcome;
}

export interface TradingLoopCycleReport {
  readonly cycleId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly reports: readonly TradingLoopInstrumentReport[];
}

export interface TradingLoopStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly startedAt: Date | null;
  readonly lastCycleAt: Date | null;
  readonly nextCycleAt: Date | null;
  readonly activeInstruments: readonly string[];
  readonly lastOutcomes: Readonly<Record<string, TradingLoopInstrumentReport>>;
  readonly cycleCount: number;
}

/**
 * Broker-level exposure snapshot for a single instrument. Sourced
 * from execution-engine (single source of truth — AGENTS.md).
 * Every non-terminal `PROPOSED` row for the instrument counts as
 * exposure — a clean `PROPOSED` row is safe to resume ONLY under
 * its own `clientOrderId`, so the loop MUST NOT create a new
 * `PROPOSED` next to it. Reconciliation (PR15) will decide the
 * fate of orphan `PROPOSED` rows.
 */
export interface TradingExposure {
  /** Non-zero position on the account for this instrument's broker symbol. */
  readonly hasOpenPosition: boolean;
  /** Any `SUBMITTED` order for this instrument. */
  readonly hasActiveOrder: boolean;
  /**
   * `PROPOSED` row with `executionAttemptedAt` set OR `brokerOrderId`
   * set — a submission WAS attempted but the terminal state is
   * unresolved. Requires reconciliation (PR15).
   */
  readonly hasAmbiguousSubmission: boolean;
  /**
   * `PROPOSED` row with NO markers set — safe-to-resume orphan
   * from a previous cycle. The loop MUST NOT create a new
   * `PROPOSED` for the same instrument; only reconciliation
   * (PR15) may resume it under its ORIGINAL `clientOrderId`.
   */
  readonly hasPendingProposal: boolean;
  readonly positionSide?: "LONG" | "SHORT";
  readonly quantity?: number;
}

export interface TradingExposureReader {
  readExposure(input: {
    readonly instrumentId: string;
    readonly brokerSymbol: string;
  }): Promise<TradingExposure>;
  /**
   * Lightweight ping used by the trading-loop readiness endpoint.
   * MUST NOT contact the broker directly — just verify the read
   * path (HTTP + auth + response shape).
   *
   * Returns `{ ok: true }` when the read endpoint is reachable and
   * returns a well-formed response; otherwise `{ ok: false,
   * message }`. NEVER throws.
   */
  probeReady(): Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
}

/**
 * Trigger identity for the idempotency key. Round-4 blocker fix —
 * separates the idea of "which trigger fired?" from "what is the
 * trade intent?" so a historic FILLED / REJECTED order that
 * happened to have the same intent hash does not shadow a
 * genuinely new trigger.
 *
 * PR14 derives this in the trading loop from
 * `snapshot.sections.price.observedAt` rounded down to the
 * strategy's timeframe boundary, plus a strategyId from the
 * per-instrument execution policy. Once the pipeline surfaces
 * canonical trigger metadata this interface will move into the
 * shared package.
 */
export interface TriggerIdentity {
  /**
   * Identifier of the strategy that emitted the intent. Read from
   * `Instrument.executionPolicy.strategyId` — MUST be stable per
   * strategy configuration, not per evaluation.
   */
  readonly strategyId: string;
  /**
   * How the trigger was derived. In PR14 always
   * `"evaluation_bucket"` — the strategy is re-evaluated on
   * every scheduler tick and the trigger id is bucketed by the
   * strategy timeframe. This is NOT a candle-close event: it's
   * a bucket of the observation timestamp. Once ingestion emits
   * real candle-close events this label will change to
   * `"candle_close"`; PR14 does NOT claim that guarantee.
   */
  readonly source: string;
  /**
   * Timeframe label the strategy operates on
   * (e.g. `"1m"`, `"5m"`, `"1h"`).
   */
  readonly timeframe: string;
  /**
   * Deterministic per-trigger identifier. Format:
   * `<timeframe>:<closedCandleTimestampMs>`.
   * Two evaluations that observe the same closed candle produce
   * the same id; a new candle produces a new id.
   */
  readonly triggerId: string;
  /**
   * Raw observation timestamp — mostly for observability, NOT
   * used in key derivation (`triggerId` is the anchor).
   */
  readonly observedAt: Date;
}
