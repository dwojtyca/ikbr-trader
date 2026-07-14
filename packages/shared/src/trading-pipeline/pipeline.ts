/**
 * Trading Pipeline — internal step runners.
 *
 * Each step wraps a single engine call in a try/catch so a
 * misbehaving underlying engine (which is not supposed to throw)
 * still yields a structured pipeline outcome. Errors captured here
 * are converted to `SignalStepOutcome.errored = true` /
 * `TicketStepOutcome.threw = true`; the orchestrator turns those
 * into `failedStage: "UNKNOWN"` results.
 *
 * These runners perform NO I/O of their own — they only invoke the
 * caller-provided engine instances.
 */

import type {
  ExecutionTicketBuildInput,
  ExecutionTicketBuildResult,
} from "../execution-ticket/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type { SignalEvaluation } from "../signal-engine/types.js";

/**
 * Structural port for the signal engine. Kept minimal so the
 * pipeline can be unit-tested with a bare fake and does not couple
 * to the full `SignalEngineOptions` surface.
 */
export interface SignalEngineLike {
  evaluate(snapshot: MarketContextSnapshot): SignalEvaluation;
}

/**
 * Structural port for the execution ticket builder. Same
 * minimality principle as `SignalEngineLike`.
 */
export interface ExecutionTicketBuilderLike {
  build(input: ExecutionTicketBuildInput): ExecutionTicketBuildResult;
}

export type SignalStepOutcome =
  | { readonly errored: false; readonly signal: SignalEvaluation }
  | { readonly errored: true; readonly error: unknown };

export type TicketStepOutcome =
  | { readonly threw: false; readonly result: ExecutionTicketBuildResult }
  | { readonly threw: true; readonly error: unknown };

export function runSignalStep(
  engine: SignalEngineLike,
  snapshot: MarketContextSnapshot,
): SignalStepOutcome {
  try {
    const signal = engine.evaluate(snapshot);
    return { errored: false, signal };
  } catch (error) {
    return { errored: true, error };
  }
}

export function runTicketStep(
  builder: ExecutionTicketBuilderLike,
  input: ExecutionTicketBuildInput,
): TicketStepOutcome {
  try {
    const result = builder.build(input);
    return { threw: false, result };
  } catch (error) {
    return { threw: true, error };
  }
}

/**
 * Best-effort message extraction for the `UNKNOWN` failure path.
 * Avoids `String(error)` on non-Error values leaking `[object Object]`.
 */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

/**
 * Outcome of invoking a caller-provided clock. `ok: false` means
 * the clock threw or returned an invalid value; the caller MUST
 * treat the clock as untrusted from that point on and MUST NOT
 * call it again while assembling the failure result (a broken
 * clock must not be reused).
 */
export type SafeClockOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

/**
 * Safely obtain a wall-clock timestamp. Returns `ok: false` on
 * throw or when the clock returns a non-Date / invalid-Date value.
 */
export function safeNow(now: () => Date): SafeClockOutcome<Date> {
  try {
    const value = now();
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return { ok: true, value };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Safely obtain a monotonic timestamp. Returns `ok: false` on
 * throw or when the clock returns a non-finite / non-number value.
 */
export function safePerformanceNow(
  perf: () => number,
): SafeClockOutcome<number> {
  try {
    const value = perf();
    if (typeof value === "number" && Number.isFinite(value)) {
      return { ok: true, value };
    }
  } catch {
    // fall through
  }
  return { ok: false };
}

/**
 * Attempt an operation and swallow any exception, returning a
 * caller-supplied fallback instead. Used to make warning /
 * metadata / freeze steps non-fatal so a misbehaving upstream
 * value cannot escape `TradingPipeline.run()`.
 */
export function trySafe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
