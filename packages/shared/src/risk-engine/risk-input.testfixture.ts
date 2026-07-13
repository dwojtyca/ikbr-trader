import type {
  DecisionAction,
  DecisionResult,
} from "../decision-engine/types.js";
import type { Instrument } from "../instruments/types.js";

/**
 * Test-only builders for `DecisionResult` and `Instrument`. Kept out
 * of the production bundle via the tsconfig `**\/*.testfixture.ts`
 * exclude.
 */

const FIXTURE_DECISION_GENERATED_AT = new Date("2026-07-13T12:00:00Z");

export function buildDecision(
  overrides: Partial<DecisionResult> = {},
): DecisionResult {
  return {
    decisionId: overrides.decisionId ?? "decision-fixture",
    generatedAt: overrides.generatedAt ?? FIXTURE_DECISION_GENERATED_AT,
    instrumentId: overrides.instrumentId ?? "ctx_fut",
    action: (overrides.action ?? "LONG") as DecisionAction,
    confidence: overrides.confidence ?? 80,
    overallScore: overrides.overallScore ?? 40,
    reasons: overrides.reasons ?? [],
    warnings: overrides.warnings ?? [],
    blockedBy: overrides.blockedBy ?? [],
    metadata: overrides.metadata ?? {
      engineVersion: "0.1.0",
      evaluationTimeMs: 1,
    },
  };
}

export interface InstrumentOverrides {
  readonly id?: string;
  readonly executionEnabled?: boolean;
  readonly allowOvernight?: boolean;
}

export function buildInstrument(
  overrides: InstrumentOverrides = {},
): Instrument {
  return {
    id: overrides.id ?? "ctx_fut",
    displayName: "Context Future",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "CX",
    exchange: "CME",
    currency: "USD",
    trading: {
      executionEnabled: overrides.executionEnabled ?? true,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 1,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: overrides.allowOvernight ?? true,
      maxSpread: 0.25,
      maxSlippage: 0.5,
    },
    session: {
      useRegularTradingHours: false,
      timezone: "America/Chicago",
      sessionTemplate: "cme_equity_index",
    },
    roll: { rollStrategy: "calendar", rollDaysBeforeExpiry: 7 },
    metadata: { tags: [] },
  };
}
