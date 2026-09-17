import { createHash } from "node:crypto";
import { z } from "zod";

export const RESEARCH_ES_EXPERIMENT_ID = "pr15.5d-es-momentum-breakout-long-v1";
export const RESEARCH_ES_PROVENANCE_ID = "ibkr-es-20250622-20260831-e39a59790324";
export const RESEARCH_ES_DATASET_FINGERPRINT = "6dc425610feb44665226228bbd2c561b64504b47588b4dd38d26cc9dab93e026";
export const RESEARCH_ES_CANDLE_SHA256 = "9d40e586a77c29f036cf0df270f71ef59bcd36ea3f7625941cd81c99fbef7ca3";

export const REGISTERED_ES_EXPERIMENT_SPEC = Object.freeze({
  schemaVersion: "pr15.5d-es-experiment-v1",
  experimentId: RESEARCH_ES_EXPERIMENT_ID,
  dataset: {
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    fingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
    candlesSha256: RESEARCH_ES_CANDLE_SHA256,
    dateFrom: "2025-06-22T22:00:00.000Z",
    dateTo: "2026-08-31T20:59:00.000Z",
    symbol: "ES",
    rollPolicyVersion: "ibkr-es-volume-crossover-next-session-v2",
    calendarVersion: "cme-equity-index-2024-2026-v1",
    contracts: [
      { conId: "637533641", localSymbol: "ESU5", validFrom: "2025-06-22T22:00:00.000Z", validTo: "2025-09-15T21:59:00.000Z", rollAt: "2025-09-15T22:00:00.000Z", lastTradeAt: "2025-09-19T13:30:00.000Z" },
      { conId: "495512563", localSymbol: "ESZ5", validFrom: "2025-09-15T22:00:00.000Z", validTo: "2025-12-15T22:59:00.000Z", rollAt: "2025-12-15T23:00:00.000Z", lastTradeAt: "2025-12-19T14:30:00.000Z" },
      { conId: "649180695", localSymbol: "ESH6", validFrom: "2025-12-15T23:00:00.000Z", validTo: "2026-03-16T21:59:00.000Z", rollAt: "2026-03-16T22:00:00.000Z", lastTradeAt: "2026-03-20T13:30:00.000Z" },
      { conId: "649180678", localSymbol: "ESM6", validFrom: "2026-03-16T22:00:00.000Z", validTo: "2026-06-15T21:59:00.000Z", rollAt: "2026-06-15T22:00:00.000Z", lastTradeAt: "2026-06-18T13:30:00.000Z" },
      { conId: "649180671", localSymbol: "ESU6", validFrom: "2026-06-15T22:00:00.000Z", validTo: "2026-08-31T20:59:00.000Z", rollAt: null, lastTradeAt: "2026-09-18T13:30:00.000Z" },
    ],
  },
  strategy: {
    id: "momentum_breakout_long_v1",
    direction: "LONG",
    researchAdapterVersion: "momentum-breakout-long-fut-research-v1",
  },
  signal: {
    minimumCandles: 220,
    maximumSpreadBps: 12,
    volumeFilter: "off",
    minimumConfidence: 0.55,
    minimumStopBps: 0,
    limitEntryBufferBps: 0,
    syntheticSpreadBps: 2,
  },
  risk: {
    accountEquity: 100_000,
    targetRiskPerTradePct: 0.5,
    maxRiskPerTradePct: 0.5,
    maxExposurePct: 400,
    maxNotionalPerTradePct: 400,
    maxOpenPositions: 1,
  },
  execution: {
    multiplier: 50,
    tickSize: 0.25,
    orderTtlCandles: 2,
    strategyCooldownMs: 12 * 60 * 60 * 1000,
    limitEntryMode: "touch",
    sameBarCollisionPolicy: "stop_wins",
    pyramiding: false,
    fractionalQuantity: false,
    baseCurrency: "USD",
    fxConversion: false,
    scenarios: [
      { id: "primary", commissionPerContractPerSide: 2.5, slippageTicks: 1 },
      { id: "stress", commissionPerContractPerSide: 3.5, slippageTicks: 2 },
    ],
  },
  acceptance: {
    minimumClosedTrades: 30,
    primaryMinimumNetPnl: 0,
    primaryMinimumProfitFactor: 1.2,
    primaryMinimumMeanNetPnl: 0,
    primaryMinimumMaxDrawdown: -10_000,
    stressMinimumNetPnl: 0,
    stressMinimumProfitFactor: 1.05,
  },
} as const);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const RESEARCH_ES_EXPERIMENT_SPEC_SHA256 = sha256(
  canonicalJson(REGISTERED_ES_EXPERIMENT_SPEC),
);

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const requestSchema = z.object({
  experimentId: z.literal(RESEARCH_ES_EXPERIMENT_ID),
  specificationSha256: z.literal(RESEARCH_ES_EXPERIMENT_SPEC_SHA256),
  implementationCommitSha: sha,
  provenanceId: z.literal(RESEARCH_ES_PROVENANCE_ID),
  datasetFingerprint: z.literal(RESEARCH_ES_DATASET_FINGERPRINT),
}).strict();

export type ResearchEsRunRequest = z.infer<typeof requestSchema>;

export function parseResearchEsRunRequest(
  input: unknown,
  expectedImplementationCommitSha?: string,
): ResearchEsRunRequest {
  const request = requestSchema.parse(input);
  if (expectedImplementationCommitSha && request.implementationCommitSha !== expectedImplementationCommitSha)
    throw new Error("Research implementation commit does not match the running build");
  return Object.freeze(request);
}

export interface ResearchScenarioMetrics {
  scenario: "primary" | "stress";
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnl: number;
  grossWins: number;
  grossLosses: number;
  commissions: number;
  slippageCost: number;
  netPnl: number;
  meanNetPnl: number;
  medianNetPnl: number;
  profitFactor?: number;
  maxDrawdown: number;
  largestWinningTrade: number;
  largestLosingTrade: number;
  countsByMonth: Readonly<Record<string, number>>;
  countsByContract: Readonly<Record<string, number>>;
  countsByExitReason: Readonly<Record<string, number>>;
  countsByDirectionalRegime: Readonly<Record<string, number>>;
  countsByVolatilityRegime: Readonly<Record<string, number>>;
  signalRejections: Readonly<Record<string, number>>;
  lifecycleExitCounts: Readonly<Record<string, number>>;
  openPositions: number;
  pendingOrders: number;
  unclosedFills: number;
  strategyPermanentlyDisabled: boolean;
  invariantViolations: readonly string[];
  datasetFingerprintBefore: string;
  datasetFingerprintAfter: string;
}

export interface ResearchExperimentEvidence {
  experimentId: typeof RESEARCH_ES_EXPERIMENT_ID;
  specificationSha256: typeof RESEARCH_ES_EXPERIMENT_SPEC_SHA256;
  implementationCommitSha: string;
  reproducible: boolean;
  evidenceErrors: readonly string[];
  primary: ResearchScenarioMetrics;
  stress: ResearchScenarioMetrics;
}

export type ResearchExperimentVerdict =
  | "ACCEPTED_FOR_ES"
  | "REJECTED_FOR_ES"
  | "INCONCLUSIVE";

export interface ResearchGateResult {
  gate: string;
  passed: boolean;
  actual: number | boolean | string;
  required: number | boolean | string;
}

export function evaluateResearchExperiment(evidence: ResearchExperimentEvidence): {
  verdict: ResearchExperimentVerdict;
  gates: ResearchGateResult[];
} {
  const { acceptance } = REGISTERED_ES_EXPERIMENT_SPEC;
  const unchanged = (metrics: ResearchScenarioMetrics) =>
    metrics.datasetFingerprintBefore === RESEARCH_ES_DATASET_FINGERPRINT &&
    metrics.datasetFingerprintAfter === RESEARCH_ES_DATASET_FINGERPRINT;
  const noLifecycleResidue = (metrics: ResearchScenarioMetrics) =>
    metrics.openPositions === 0 && metrics.pendingOrders === 0 && metrics.unclosedFills === 0;
  const noInvariantFailure = (metrics: ResearchScenarioMetrics) => metrics.invariantViolations.length === 0;
  const gates: ResearchGateResult[] = [
    { gate: "minimum_closed_trades", passed: evidence.primary.closedTrades >= acceptance.minimumClosedTrades,
      actual: evidence.primary.closedTrades, required: acceptance.minimumClosedTrades },
    { gate: "primary_net_pnl", passed: evidence.primary.netPnl > acceptance.primaryMinimumNetPnl,
      actual: evidence.primary.netPnl, required: `>${acceptance.primaryMinimumNetPnl}` },
    { gate: "primary_profit_factor", passed: (evidence.primary.profitFactor ?? 0) >= acceptance.primaryMinimumProfitFactor,
      actual: evidence.primary.profitFactor ?? "undefined", required: acceptance.primaryMinimumProfitFactor },
    { gate: "primary_mean_expectancy", passed: evidence.primary.meanNetPnl > acceptance.primaryMinimumMeanNetPnl,
      actual: evidence.primary.meanNetPnl, required: `>${acceptance.primaryMinimumMeanNetPnl}` },
    { gate: "primary_max_drawdown", passed: evidence.primary.maxDrawdown >= acceptance.primaryMinimumMaxDrawdown,
      actual: evidence.primary.maxDrawdown, required: `>=${acceptance.primaryMinimumMaxDrawdown}` },
    { gate: "stress_net_pnl", passed: evidence.stress.netPnl > acceptance.stressMinimumNetPnl,
      actual: evidence.stress.netPnl, required: `>${acceptance.stressMinimumNetPnl}` },
    { gate: "stress_profit_factor", passed: (evidence.stress.profitFactor ?? 0) >= acceptance.stressMinimumProfitFactor,
      actual: evidence.stress.profitFactor ?? "undefined", required: acceptance.stressMinimumProfitFactor },
    { gate: "no_lifecycle_residue", passed: noLifecycleResidue(evidence.primary) && noLifecycleResidue(evidence.stress),
      actual: noLifecycleResidue(evidence.primary) && noLifecycleResidue(evidence.stress), required: true },
    { gate: "no_invariant_violations", passed: noInvariantFailure(evidence.primary) && noInvariantFailure(evidence.stress),
      actual: noInvariantFailure(evidence.primary) && noInvariantFailure(evidence.stress), required: true },
    { gate: "strategy_not_permanently_disabled", passed: !evidence.primary.strategyPermanentlyDisabled && !evidence.stress.strategyPermanentlyDisabled,
      actual: evidence.primary.strategyPermanentlyDisabled || evidence.stress.strategyPermanentlyDisabled, required: false },
    { gate: "dataset_fingerprint_unchanged", passed: unchanged(evidence.primary) && unchanged(evidence.stress),
      actual: unchanged(evidence.primary) && unchanged(evidence.stress), required: true },
  ];
  const integrityFailure = !unchanged(evidence.primary) || !unchanged(evidence.stress) ||
    !noInvariantFailure(evidence.primary) || !noInvariantFailure(evidence.stress);
  if (!evidence.reproducible || evidence.evidenceErrors.length > 0 || integrityFailure)
    return { verdict: "INCONCLUSIVE", gates };
  return { verdict: gates.every((gate) => gate.passed) ? "ACCEPTED_FOR_ES" : "REJECTED_FOR_ES", gates };
}

export function canonicalResearchResult(input: ResearchExperimentEvidence): string {
  const evaluated = evaluateResearchExperiment(input);
  return canonicalJson({
    schemaVersion: "pr15.5d-es-result-v1",
    experimentId: input.experimentId,
    specificationSha256: input.specificationSha256,
    implementationCommitSha: input.implementationCommitSha,
    dataset: REGISTERED_ES_EXPERIMENT_SPEC.dataset,
    reproducible: input.reproducible,
    evidenceErrors: [...input.evidenceErrors],
    primary: input.primary,
    stress: input.stress,
    gates: evaluated.gates,
    verdict: evaluated.verdict,
  });
}

export function researchResultSha256(input: ResearchExperimentEvidence): string {
  return sha256(canonicalResearchResult(input));
}

export function canonicalResearchFailureResult(
  request: ResearchEsRunRequest,
  evidenceErrors: readonly string[],
): string {
  return canonicalJson({
    schemaVersion: "pr15.5d-es-result-v1",
    experimentId: request.experimentId,
    specificationSha256: request.specificationSha256,
    implementationCommitSha: request.implementationCommitSha,
    dataset: REGISTERED_ES_EXPERIMENT_SPEC.dataset,
    reproducible: false,
    evidenceErrors: [...evidenceErrors],
    verdict: "INCONCLUSIVE" satisfies ResearchExperimentVerdict,
  });
}

export function researchFailureResultSha256(
  request: ResearchEsRunRequest,
  evidenceErrors: readonly string[],
): string {
  return sha256(canonicalResearchFailureResult(request, evidenceErrors));
}
