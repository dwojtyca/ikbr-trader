import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_EXPERIMENT_ID,
  RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  RESEARCH_ES_PROVENANCE_ID,
  canonicalResearchFailureResult,
  canonicalResearchResult,
  evaluateResearchExperiment,
  parseResearchEsRunRequest,
  researchResultSha256,
  type ResearchExperimentEvidence,
  type ResearchScenarioMetrics,
} from "./research-run-request.js";

const implementationCommitSha = "a".repeat(40);

function request() {
  return {
    experimentId: RESEARCH_ES_EXPERIMENT_ID,
    specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
    implementationCommitSha,
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
  } as const;
}

function metrics(scenario: "primary" | "stress", patch: Partial<ResearchScenarioMetrics> = {}): ResearchScenarioMetrics {
  return {
    scenario, closedTrades: 30, wins: 15, losses: 15, winRate: 0.5, grossPnl: 5_000,
    grossWins: 6_000, grossLosses: 1_000,
    commissions: 150, slippageCost: 500, netPnl: 4_350, meanNetPnl: 145,
    medianNetPnl: 10, profitFactor: 1.2, maxDrawdown: -10_000,
    largestWinningTrade: 1_000, largestLosingTrade: -500,
    countsByMonth: {}, countsByContract: {}, countsByExitReason: {},
    countsByDirectionalRegime: {}, countsByVolatilityRegime: {},
    signalRejections: {}, lifecycleExitCounts: {},
    openPositions: 0, pendingOrders: 0, unclosedFills: 0,
    strategyPermanentlyDisabled: false, invariantViolations: [],
    datasetFingerprintBefore: RESEARCH_ES_DATASET_FINGERPRINT,
    datasetFingerprintAfter: RESEARCH_ES_DATASET_FINGERPRINT,
    ...patch,
  };
}

function evidence(patch: Partial<ResearchExperimentEvidence> = {}): ResearchExperimentEvidence {
  return {
    experimentId: RESEARCH_ES_EXPERIMENT_ID,
    specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
    implementationCommitSha,
    reproducible: true,
    evidenceErrors: [],
    primary: metrics("primary"),
    stress: metrics("stress", { profitFactor: 1.05 }),
    ...patch,
  };
}

describe("PR15.5D pure research request", () => {
  it("pins the complete approved experiment specification hash", () => {
    assert.equal(RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
      "4afee9646d4f8aea18f35effca741c2cc80c82195b5519f6a88161077a65dff6");
  });

  it("accepts only the exact registered identities and implementation commit", () => {
    assert.deepEqual(parseResearchEsRunRequest(request(), implementationCommitSha), request());
    for (const field of ["experimentId", "specificationSha256", "provenanceId", "datasetFingerprint"] as const) {
      assert.throws(() => parseResearchEsRunRequest({ ...request(), [field]: "wrong" }), /Invalid/);
    }
    assert.throws(() => parseResearchEsRunRequest({ ...request(), extra: true }), /unrecognized/i);
    assert.throws(() => parseResearchEsRunRequest(request(), "b".repeat(40)), /running build/);
  });

  it("accepts equality boundaries but rejects insufficient trades and economic failures", () => {
    assert.equal(evaluateResearchExperiment(evidence()).verdict, "ACCEPTED_FOR_ES");
    assert.equal(evaluateResearchExperiment(evidence({
      primary: metrics("primary", { closedTrades: 29 }),
    })).verdict, "REJECTED_FOR_ES");
    assert.equal(evaluateResearchExperiment(evidence({
      primary: metrics("primary", { profitFactor: 1.199999 }),
    })).verdict, "REJECTED_FOR_ES");
    assert.equal(evaluateResearchExperiment(evidence({
      primary: metrics("primary", { maxDrawdown: -10_000.01 }),
    })).verdict, "REJECTED_FOR_ES");
    assert.equal(evaluateResearchExperiment(evidence({
      stress: metrics("stress", { profitFactor: 1.049999 }),
    })).verdict, "REJECTED_FOR_ES");
  });

  it("reserves INCONCLUSIVE for evidence failures", () => {
    assert.equal(evaluateResearchExperiment(evidence({ reproducible: false })).verdict, "INCONCLUSIVE");
    assert.equal(evaluateResearchExperiment(evidence({ evidenceErrors: ["fingerprint read-back failed"] })).verdict, "INCONCLUSIVE");
    assert.equal(evaluateResearchExperiment(evidence({
      primary: metrics("primary", { invariantViolations: ["off_tick_fill"] }),
    })).verdict, "INCONCLUSIVE");
    assert.equal(evaluateResearchExperiment(evidence({
      stress: metrics("stress", { datasetFingerprintAfter: "f".repeat(64) }),
    })).verdict, "INCONCLUSIVE");
  });

  it("hashes canonical durable evidence and excludes runtime ids and timestamps", () => {
    const value = evidence();
    assert.equal(researchResultSha256(value), researchResultSha256(structuredClone(value)));
    assert.notEqual(researchResultSha256(value), researchResultSha256({
      ...value, primary: { ...value.primary, netPnl: value.primary.netPnl + 1 },
    }));
    const result = JSON.parse(canonicalResearchResult(value));
    assert.equal("runId" in result, false);
    assert.equal("generatedAt" in result, false);
  });

  it("canonicalizes map key order and binds every durable evidence class", () => {
    const value = evidence({
      primary: metrics("primary", { countsByMonth: { "2026-02": 2, "2026-01": 1 } }),
    });
    const reordered = {
      ...value,
      primary: { ...value.primary, countsByMonth: { "2026-01": 1, "2026-02": 2 } },
    };
    assert.equal(researchResultSha256(value), researchResultSha256(reordered));
    for (const mutated of [
      { ...value, implementationCommitSha: "b".repeat(40) },
      { ...value, reproducible: false },
      { ...value, evidenceErrors: ["failure"] },
      { ...value, primary: { ...value.primary, closedTrades: 31 } },
      { ...value, primary: { ...value.primary, commissions: 151 } },
      { ...value, primary: { ...value.primary, countsByContract: { other: 1 } } },
      { ...value, stress: { ...value.stress, slippageCost: 501 } },
    ]) assert.notEqual(researchResultSha256(value), researchResultSha256(mutated));
    const failure = JSON.parse(canonicalResearchFailureResult(request(), ["execution_failed:Error"]));
    assert.equal(failure.verdict, "INCONCLUSIVE");
    assert.equal(failure.reproducible, false);
  });
});
