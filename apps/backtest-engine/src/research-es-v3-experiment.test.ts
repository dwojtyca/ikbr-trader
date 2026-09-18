import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BacktestRepository } from "./repository.js";
import { runResearchEsV3Experiment } from "./research-es-v3-experiment.js";
import type { ResearchV3StoredScenario } from "./research-es-v3-scenario-worker.js";
import { RESEARCH_ES_DATASET_FINGERPRINT, RESEARCH_ES_PROVENANCE_ID, type ResearchScenarioMetrics } from "./research-run-request.js";
import { REGISTERED_ES_V2_PROJECTION } from "./research-v2-run-request.js";
import { RESEARCH_ES_V3_EXPERIMENT_ID, RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256 } from "./research-v3-run-request.js";

const identity = { datasetId: 7, provenanceId: RESEARCH_ES_PROVENANCE_ID,
  fingerprint: RESEARCH_ES_DATASET_FINGERPRINT, candlesCount: 423_300, manifest: {} } as any;
const projection = { evidence: REGISTERED_ES_V2_PROJECTION, data: { candleCount1m: 423_300 } } as any;
const request = { experimentId: RESEARCH_ES_V3_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256,
  implementationCommitSha: "a".repeat(40), provenanceId: RESEARCH_ES_PROVENANCE_ID,
  datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT } as const;
function metrics(scenario: "primary" | "stress"): ResearchScenarioMetrics {
  return { scenario, closedTrades: 30, wins: 20, losses: 10, winRate: 2 / 3,
    grossPnl: 100, grossWins: 120, grossLosses: 20, commissions: 10, slippageCost: 10,
    netPnl: 80, meanNetPnl: 8, medianNetPnl: 4, profitFactor: 2, maxDrawdown: -20,
    largestWinningTrade: 20, largestLosingTrade: -10, countsByMonth: {}, countsByContract: {},
    countsByExitReason: {}, countsByDirectionalRegime: {}, countsByVolatilityRegime: {}, signalRejections: {},
    lifecycleExitCounts: {}, openPositions: 0, pendingOrders: 0, unclosedFills: 0,
    strategyPermanentlyDisabled: false, invariantViolations: [],
    datasetFingerprintBefore: RESEARCH_ES_DATASET_FINGERPRINT,
    datasetFingerprintAfter: RESEARCH_ES_DATASET_FINGERPRINT };
}

describe("PR15.5D.3 parallel coordinator", () => {
  it("starts all three scenarios before allowing any one to complete", async () => {
    let started = 0; let active = 0; let peak = 0; let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const seen: ResearchV3StoredScenario[] = [];
    const repository = { async saveResearchExperimentArtifact() {},
      async failRunningResearchScenarioRuns() { return 0; } } as unknown as BacktestRepository;
    const resultPromise = runResearchEsV3Experiment({ repository, request, identity, projection,
      researchDatabaseUrl: "fixture", scenarioRunner: async ({ storedScenario }) => {
        seen.push(storedScenario); started += 1; active += 1; peak = Math.max(peak, active);
        if (started === 3) release();
        await barrier; active -= 1;
        return metrics(storedScenario === "stress" ? "stress" : "primary");
      } });
    const evidence = await resultPromise;
    assert.deepEqual(new Set(seen), new Set(["primary", "stress", "primary_reproduction"]));
    assert.equal(peak, 3); assert.equal(evidence.reproducible, true);
  });

  it("waits for all workers and persists INCONCLUSIVE if any worker fails", async () => {
    let failedRuns = 0; let saved: any;
    const repository = { async saveResearchExperimentArtifact(_id: string, value: unknown) { saved = value; },
      async failRunningResearchScenarioRuns() { failedRuns += 1; return 1; } } as unknown as BacktestRepository;
    await assert.rejects(() => runResearchEsV3Experiment({ repository, request, identity, projection,
      researchDatabaseUrl: "fixture", scenarioRunner: async ({ storedScenario }) => {
        if (storedScenario === "stress") throw new Error("boom");
        return metrics("primary");
      } }), /failure count: 1/);
    assert.equal(failedRuns, 1); assert.equal(saved.verdict, "INCONCLUSIVE");
  });
});
