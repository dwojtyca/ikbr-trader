import type { DecisionEngine } from "../decision-engine/evaluator.js";
import type { MarketContextSnapshot } from "../market-context/types.js";
import type { RiskEngine } from "../risk-engine/evaluator.js";
import type { InstrumentResolver } from "./pipeline.js";
import { runSignalPipeline } from "./pipeline.js";
import {
  deepFreezeSignal,
  deriveSignalStatus,
  summarizeReason,
} from "./result.js";
import type {
  SignalEngineVersions,
  SignalEvaluation,
  SignalMetadata,
} from "./types.js";

export const SIGNAL_ENGINE_VERSION = "0.1.0";

export interface SignalEngineOptions {
  readonly decisionEngine: DecisionEngine;
  readonly riskEngine: RiskEngine;
  /**
   * Resolves the `Instrument` associated with `snapshot.instrumentId`.
   * Return `undefined` for unknown ids — the engine converts that
   * into a `SignalStatus.ERROR` evaluation with a structured warning.
   */
  readonly instrumentResolver: InstrumentResolver;
  /** Deterministic clock. Default `() => new Date()`. */
  readonly now?: () => Date;
  /** Deterministic id factory. Default `crypto.randomUUID`. */
  readonly idFactory?: () => string;
  /** Reported in `SignalMetadata`. Default `SIGNAL_ENGINE_VERSION`. */
  readonly version?: string;
  /**
   * Monotonic clock used only for `metadata.evaluationTimeMs`.
   * Injectable so tests can produce deterministic durations. Default:
   * `() => performance.now()`.
   */
  readonly performanceNow?: () => number;
}

/**
 * Deterministic domain orchestrator that composes
 * `DecisionEngine` + `RiskEngine` into a single `SignalEvaluation`.
 *
 * Pipeline (single evaluate call):
 *   1. `DecisionEngine.evaluate(snapshot)` under try/catch.
 *   2. If decision is blocked or `HOLD`, skip risk.
 *   3. Resolve `Instrument` via the injected resolver (undefined →
 *      `ERROR`).
 *   4. `RiskEngine.evaluate(decision, snapshot, instrument)` under
 *      try/catch.
 *   5. Derive `SignalStatus`, build metadata, deep-freeze, return.
 *
 * TODO(architecture): once a second signal consumer appears, extract
 * timing + id + freeze into shared engine utilities (mirroring the
 * TODOs already recorded on `MarketContextBuilder`, `DecisionEngine`
 * and `RiskEngine`). Not done in this PR.
 *
 * TODO(execution): PR10 will add an ExecutionTicket layer that turns
 * a `GENERATED` `SignalEvaluation` into an order-shaped intent for
 * `execution-engine`. The Signal Engine itself will remain purely
 * domain — no broker, no HTTP, no persistence.
 */
export class SignalEngine {
  readonly #decisionEngine: DecisionEngine;
  readonly #riskEngine: RiskEngine;
  readonly #instrumentResolver: InstrumentResolver;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #version: string;
  readonly #performanceNow: () => number;

  constructor(options: SignalEngineOptions) {
    if (!options.decisionEngine) {
      throw new Error("SignalEngine: decisionEngine is required");
    }
    if (!options.riskEngine) {
      throw new Error("SignalEngine: riskEngine is required");
    }
    if (!options.instrumentResolver) {
      throw new Error("SignalEngine: instrumentResolver is required");
    }
    this.#decisionEngine = options.decisionEngine;
    this.#riskEngine = options.riskEngine;
    this.#instrumentResolver = options.instrumentResolver;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.#version = options.version ?? SIGNAL_ENGINE_VERSION;
    this.#performanceNow =
      options.performanceNow ?? (() => performance.now());
  }

  evaluate(snapshot: MarketContextSnapshot): SignalEvaluation {
    const start = this.#performanceNow();
    const generatedAt = this.#now();

    const outcome = runSignalPipeline({
      snapshot,
      decisionEngine: this.#decisionEngine,
      riskEngine: this.#riskEngine,
      instrumentResolver: this.#instrumentResolver,
    });

    const status = deriveSignalStatus(outcome);
    const reasonSummary = summarizeReason(status, outcome);

    const engineVersions: SignalEngineVersions = {
      signal: this.#version,
      ...(outcome.decision
        ? { decision: outcome.decision.metadata.engineVersion }
        : {}),
      ...(outcome.risk
        ? { risk: outcome.risk.metadata.engineVersion }
        : {}),
    };

    const metadata: SignalMetadata = {
      engineVersions,
      evaluationTimeMs: this.#performanceNow() - start,
    };

    const evaluation: SignalEvaluation = {
      signalId: this.#idFactory(),
      generatedAt,
      instrumentId: snapshot.instrumentId,
      decision: outcome.decision,
      risk: outcome.risk,
      status,
      reasonSummary,
      warnings: outcome.warnings,
      metadata,
    };

    return deepFreezeSignal(evaluation);
  }

  evaluateMany(
    snapshots: readonly MarketContextSnapshot[],
  ): readonly SignalEvaluation[] {
    return snapshots.map((snapshot) => this.evaluate(snapshot));
  }
}
