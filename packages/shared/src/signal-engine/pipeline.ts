import type { DecisionResult } from "../decision-engine/types.js";
import type { DecisionEngine } from "../decision-engine/evaluator.js";
import type { Instrument } from "../instruments/types.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type { RiskEngine } from "../risk-engine/evaluator.js";
import type { RiskEvaluation } from "../risk-engine/types.js";
import type {
  SignalAttributionContext,
  SignalBlocker,
  SignalWarning,
} from "./types.js";

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
  /**
   * PR15.4 — pipeline-level blockers surfaced by classification
   * gates (currently only the attribution direction gate).
   * Empty array (never `undefined`) when no pipeline blocker
   * fired. Never populated on the same run as `errored: true` —
   * the direction gate only fires after a successful, directional
   * decision.
   */
  readonly signalBlockers: readonly SignalBlocker[];
}

export interface PipelineInputs {
  readonly snapshot: MarketContextSnapshot;
  readonly decisionEngine: DecisionEngine;
  readonly riskEngine: RiskEngine;
  readonly instrumentResolver: InstrumentResolver;
  /**
   * PR15.4 — optional attribution carrier. When present, the
   * pipeline enforces a fail-closed direction gate: a directional
   * decision that disagrees with `attribution.intendedAction`
   * short-circuits the pipeline before the Risk Engine is called
   * and yields a `signalBlockers` entry with
   * `code: "STRATEGY_DIRECTION_UNCONFIRMED"`.
   * Absent → gate is inactive; existing behaviour is preserved.
   */
  readonly attribution?: SignalAttributionContext;
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
      signalBlockers: [],
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
      signalBlockers: [],
    };
  }

  // --- PR15.4 attribution direction gate ---------------------------------
  // Fires only when the decision is directional (LONG/SHORT) and an
  // attribution is present. Fail-closed BEFORE instrument resolution
  // and Risk Engine — a direction disagreement makes downstream work
  // meaningless.
  if (inputs.attribution) {
    if (decision.action !== inputs.attribution.intendedAction) {
      return {
        decision,
        risk: null,
        warnings,
        riskSkipped: true,
        errored: false,
        signalBlockers: [
          {
            code: "STRATEGY_DIRECTION_UNCONFIRMED",
            message: `decision.action="${decision.action}" disagrees with intendedAction="${inputs.attribution.intendedAction}"`,
            source: "attribution",
          },
        ],
      };
    }
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
      signalBlockers: [],
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
      signalBlockers: [],
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
      signalBlockers: [],
    };
  }

  return {
    decision,
    risk,
    warnings,
    riskSkipped: false,
    errored: false,
    signalBlockers: [],
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
