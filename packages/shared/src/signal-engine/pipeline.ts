import type { DecisionResult } from "../decision-engine/types.js";
import type { DecisionEngine } from "../decision-engine/evaluator.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type { RiskEngine } from "../risk-engine/evaluator.js";
import type { RiskEvaluation } from "../risk-engine/types.js";
import type { SignalWarning } from "./types.js";

/**
 * Function that resolves the `Instrument` associated with a
 * snapshot. Injected as a plain callable so the shared package does
 * not depend on any particular registry / config / DB API.
 */
export type InstrumentResolver = (
  instrumentId: string,
) => Instrument | undefined;

/**
 * Byproduct of one pipeline run. `decision` and `risk` are `null`
 * when the corresponding engine did not run (or threw). The engine
 * layer converts this into a `SignalEvaluation` via `result.ts`.
 */
export interface PipelineOutcome {
  readonly decision: DecisionResult | null;
  readonly risk: RiskEvaluation | null;
  readonly warnings: readonly SignalWarning[];
  /**
   * `true` iff the risk step was intentionally skipped because the
   * decision was `HOLD` or carried at least one blocker. Lets the
   * status resolver disambiguate "risk not run" from "risk failed".
   */
  readonly riskSkipped: boolean;
  /**
   * `true` iff any pipeline step failed (decision threw, instrument
   * missing, risk threw). Drives `SignalStatus.ERROR`.
   */
  readonly errored: boolean;
}

export interface PipelineInputs {
  readonly snapshot: MarketContextSnapshot;
  readonly decisionEngine: DecisionEngine;
  readonly riskEngine: RiskEngine;
  readonly instrumentResolver: InstrumentResolver;
}

/**
 * Pure pipeline runner. Isolated from the engine class so the
 * orchestration flow can be tested and reused independently of the
 * top-level `SignalEngine` (id generation, timing, freezing).
 *
 * Guarantees:
 *   - No exception escapes. Every engine step is wrapped in
 *     try/catch; the message becomes a `SignalWarning`.
 *   - Risk is not called if the decision is blocked or `HOLD`.
 *   - Risk is not called if the instrument cannot be resolved (that
 *     branch flips `errored = true` instead).
 */
export function runSignalPipeline(inputs: PipelineInputs): PipelineOutcome {
  const warnings: SignalWarning[] = [];

  // --- Decision -----------------------------------------------------------
  let decision: DecisionResult | null = null;
  try {
    decision = inputs.decisionEngine.evaluate(inputs.snapshot);
  } catch (error) {
    warnings.push({
      code: "DECISION_ENGINE_EXCEPTION",
      message: `decision engine threw: ${describeError(error)}`,
      source: "decision-engine",
    });
    return {
      decision: null,
      risk: null,
      warnings,
      riskSkipped: false,
      errored: true,
    };
  }

  // --- Skip risk on non-directional decisions ----------------------------
  const decisionHasBlockers = decision.blockedBy.length > 0;
  const decisionIsHold = decision.action === "HOLD";
  if (decisionHasBlockers || decisionIsHold) {
    return {
      decision,
      risk: null,
      warnings,
      riskSkipped: true,
      errored: false,
    };
  }

  // --- Instrument resolution ---------------------------------------------
  let instrument: Instrument | undefined;
  try {
    instrument = inputs.instrumentResolver(inputs.snapshot.instrumentId);
  } catch (error) {
    warnings.push({
      code: "INSTRUMENT_RESOLVER_EXCEPTION",
      message: `instrument resolver threw for "${inputs.snapshot.instrumentId}": ${describeError(error)}`,
      source: "instrument-registry",
    });
    return {
      decision,
      risk: null,
      warnings,
      riskSkipped: false,
      errored: true,
    };
  }
  if (!instrument) {
    warnings.push({
      code: "INSTRUMENT_NOT_FOUND",
      message: `instrument "${inputs.snapshot.instrumentId}" not found`,
      source: "instrument-registry",
    });
    return {
      decision,
      risk: null,
      warnings,
      riskSkipped: false,
      errored: true,
    };
  }

  // --- Risk --------------------------------------------------------------
  let risk: RiskEvaluation | null = null;
  try {
    risk = inputs.riskEngine.evaluate(decision, inputs.snapshot, instrument);
  } catch (error) {
    warnings.push({
      code: "RISK_ENGINE_EXCEPTION",
      message: `risk engine threw: ${describeError(error)}`,
      source: "risk-engine",
    });
    return {
      decision,
      risk: null,
      warnings,
      riskSkipped: false,
      errored: true,
    };
  }

  return {
    decision,
    risk,
    warnings,
    riskSkipped: false,
    errored: false,
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
