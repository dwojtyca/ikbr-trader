/**
 * Trading Pipeline — result shaping helpers.
 *
 * Pure functions: derive the `failedStage` for signal-originated
 * failures, translate warnings between the underlying engines and
 * the pipeline's own type, translate ticket builder blockers, and
 * deep-freeze the final result.
 *
 * Design note (semantics):
 *   - HOLD is NOT a failure. It is handled by the orchestrator as
 *     `outcome: "NO_TRADE"`; there is no helper here that maps
 *     HOLD to a `failedStage`.
 *   - Decision Engine and Risk Engine blockers are NOT copied into
 *     `TradingPipelineBlocker`. The pipeline exposes the original
 *     `SignalEvaluation` on the failure result and callers read
 *     `signal.decision?.blockedBy` / `signal.risk?.blockers`
 *     directly. Pipeline-specific blockers exist only for `TICKET`
 *     (ticket builder returned `{ ok: false }`) and `UNKNOWN`
 *     (an engine threw).
 */

import type {
  ExecutionTicketBuildResult,
  TicketBlocker,
  TicketWarning,
} from "../execution-ticket/types.js";
import type {
  SignalEvaluation,
  SignalWarning,
} from "../signal-engine/types.js";

import type {
  TradingPipelineBlocker,
  TradingPipelineFailedStage,
  TradingPipelineWarning,
} from "./types.js";

/**
 * Map a signal-originated failure to a `TradingPipelineFailedStage`.
 *
 * Precondition: `signal.status` is one of `BLOCKED | REJECTED |
 * ERROR`. Callers MUST NOT pass `HOLD` (that is a `NO_TRADE`
 * outcome, not a failure) or `GENERATED` (that succeeds the signal
 * stage; the ticket stage decides its own `failedStage`).
 *
 * Rules:
 *   - `BLOCKED` with a typed attribution `SignalBlocker`
 *                              → `ATTRIBUTION`
 *   - `BLOCKED`   → `DECISION`
 *   - `REJECTED`  → `RISK`
 *   - `ERROR`     → derived from the first warning's `source`:
 *       - `decision-engine`     → `DECISION`
 *       - `risk-engine`         → `RISK`
 *       - `signal-engine`       → `SIGNAL`
 *       - `instrument-registry` → `SIGNAL`
 *       - no warnings           → `SIGNAL`
 */
export function deriveFailedStageFromSignal(
  signal: SignalEvaluation,
): TradingPipelineFailedStage {
  switch (signal.status) {
    case "BLOCKED":
      if (signal.blockers.some((b) => b.source === "attribution")) {
        return "ATTRIBUTION";
      }
      return "DECISION";
    case "REJECTED":
      return "RISK";
    case "ERROR": {
      const first = signal.warnings[0];
      if (!first) return "SIGNAL";
      switch (first.source) {
        case "decision-engine":
          return "DECISION";
        case "risk-engine":
          return "RISK";
        case "signal-engine":
        case "instrument-registry":
          return "SIGNAL";
        default:
          return "SIGNAL";
      }
    }
    case "HOLD":
    case "GENERATED":
      // Not reachable from a signal-failure path: HOLD is a
      // `NO_TRADE` outcome; GENERATED means the signal stage
      // succeeded. Fall through to `SIGNAL` as a defensive default
      // so an accidental caller still produces a well-formed
      // failure rather than crashing.
      return "SIGNAL";
  }
}

/**
 * Translate `SignalEvaluation.warnings` into pipeline warnings.
 * Preserves code + message; forwards `source` as a plain string so
 * downstream consumers do not need to import `SignalWarningSource`.
 */
export function warningsFromSignal(
  signal: SignalEvaluation,
): readonly TradingPipelineWarning[] {
  return signal.warnings.map((w: SignalWarning) => ({
    code: w.code,
    message: w.message,
    source: w.source,
  }));
}

/**
 * Translate `TicketBuildResult.warnings` into pipeline warnings.
 * Applies to both success and failure branches of the ticket
 * result.
 */
export function warningsFromTicket(
  result: ExecutionTicketBuildResult,
): readonly TradingPipelineWarning[] {
  return result.warnings.map((w: TicketWarning) => ({
    code: String(w.code),
    message: w.message,
    source: w.source,
  }));
}

/**
 * Translate the ticket builder's blockers into pipeline blockers,
 * always stamped with `stage: "TICKET"`.
 */
export function blockersFromTicketFailure(
  blockers: readonly TicketBlocker[],
): readonly TradingPipelineBlocker[] {
  return blockers.map((b) => ({
    code: b.code,
    message: b.message,
    source: b.source,
    stage: "TICKET" as const,
  }));
}

/**
 * Cycle-safe deep freeze.
 *
 * Duplicated from `market-context/builder.ts`,
 * `decision-engine/evaluator.ts`, `risk-engine/evaluator.ts`,
 * `signal-engine/result.ts` and `execution-ticket/builder.ts` on
 * purpose — see the architectural TODO recorded in each of those
 * modules for the planned extraction into a shared utility. This
 * PR intentionally does NOT extract it: doing so alongside
 * introducing a new module would conflate two changes.
 */
export function deepFreezePipelineResult<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      walk(child);
    }
    if (!Object.isFrozen(node)) {
      Object.freeze(node);
    }
  };
  walk(value);
  return value;
}

/**
 * Non-throwing wrapper around `deepFreezePipelineResult`. A hostile
 * value (exotic Proxy, getter that throws, non-configurable
 * property with `set` traps, etc.) can make `Object.freeze` or
 * property enumeration throw. The pipeline's error-isolation
 * contract requires that no exception ever leaves `run()`, so
 * return the value un-frozen on failure rather than propagating.
 */
export function safeDeepFreezePipelineResult<T>(value: T): T {
  try {
    return deepFreezePipelineResult(value);
  } catch {
    return value;
  }
}
