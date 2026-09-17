import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BacktestRepository } from "./repository.js";
import { runResearchEsV2Experiment, researchEsV2SimulatorOptions } from "./research-es-v2-experiment.js";
import { RESEARCH_ES_DATASET_FINGERPRINT, RESEARCH_ES_PROVENANCE_ID, type ResearchScenarioMetrics } from "./research-run-request.js";
import { REGISTERED_ES_V2_PROJECTION, RESEARCH_ES_V2_EXPERIMENT_ID, RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256 } from "./research-v2-run-request.js";

const identity = {
  datasetId: 7, provenanceId: RESEARCH_ES_PROVENANCE_ID,
  fingerprint: RESEARCH_ES_DATASET_FINGERPRINT, candlesCount: 423_300,
  manifest: { contracts: [], sessionPolicy: { calendarVersion: "cme-equity-index-2024-2026-v1" } },
} as any;
const projection = { evidence: REGISTERED_ES_V2_PROJECTION, data: { candleCount1m: 423_300 } } as any;
const request = { experimentId: RESEARCH_ES_V2_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
  implementationCommitSha: "a".repeat(40), provenanceId: RESEARCH_ES_PROVENANCE_ID,
  datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT } as const;
function metrics(scenario: "primary" | "stress"): ResearchScenarioMetrics {
  return { scenario, closedTrades: 30, wins: 20, losses: 10, winRate: 2 / 3,
    grossPnl: 100, grossWins: 120, grossLosses: 20, commissions: 10,
    slippageCost: 10, netPnl: 80, meanNetPnl: 8, medianNetPnl: 4,
    profitFactor: 2, maxDrawdown: -20, largestWinningTrade: 20,
    largestLosingTrade: -10, countsByMonth: {}, countsByContract: {},
    countsByExitReason: {}, countsByDirectionalRegime: {}, countsByVolatilityRegime: {},
    signalRejections: {}, lifecycleExitCounts: {}, openPositions: 0, pendingOrders: 0,
    unclosedFills: 0, strategyPermanentlyDisabled: false, invariantViolations: [],
    datasetFingerprintBefore: RESEARCH_ES_DATASET_FINGERPRINT,
    datasetFingerprintAfter: RESEARCH_ES_DATASET_FINGERPRINT };
}

describe("PR15.5D.1 experiment runner", () => {
  it("uses one verified projection for all scenarios and never loads generic data", async () => {
    const scenarios: string[] = [];
    let projectionReloads = 0;
    const repository = {
      async createResearchScenarioRun(_id: number, config: { scenario: string }) {
        scenarios.push(config.scenario); return { id: scenarios.length };
      },
      async loadBacktestData() { throw new Error("generic loader forbidden"); },
      async updateRunProgress() {}, async finishRun() {},
      async getResearchScenarioMetrics(_id: number, scenario: "primary" | "stress") { return metrics(scenario); },
      async saveResearchExperimentArtifact() {},
    } as unknown as BacktestRepository;
    const evidence = await runResearchEsV2Experiment({ repository, request, identity, projection,
      reloadIdentity: async () => identity,
      reloadProjection: async () => { projectionReloads += 1; return projection; },
      simulatorFactory: ((_repo: unknown, _run: number, passed: any, options: any) => ({ run: async () => {
        assert.equal(passed, projection.data);
        assert.equal(options.deriveAllFuturesTimeframesFrom1m, true);
        return { totalPnl: 80, trades: 30, wins: 20, winRate: 2 / 3 };
      } })) as any,
    });
    assert.deepEqual(scenarios, ["primary", "stress", "primary_reproduction"]);
    assert.equal(projectionReloads, 3);
    assert.equal(evidence.reproducible, true);
  });

  it("fails terminally if identity or projection changes after a scenario", async () => {
    let saved: any;
    const repository = {
      async createResearchScenarioRun() { return { id: 1 }; },
      async updateRunProgress() {}, async finishRun() {},
      async saveResearchExperimentArtifact(_id: string, result: unknown) { saved = result; },
    } as unknown as BacktestRepository;
    await assert.rejects(() => runResearchEsV2Experiment({ repository, request, identity, projection,
      reloadIdentity: async () => ({ ...identity, fingerprint: "f".repeat(64) }),
      reloadProjection: async () => projection,
      simulatorFactory: (() => ({ run: async () => ({ totalPnl: 0, trades: 0, wins: 0, winRate: 0 }) })) as any,
    }), /fingerprint changed/);
    assert.equal(saved.verdict, "INCONCLUSIVE");
  });

  it("retains primary and stress economics while enabling all-timeframe derivation", () => {
    const primary = researchEsV2SimulatorOptions(identity, "primary");
    const stress = researchEsV2SimulatorOptions(identity, "stress");
    assert.equal(primary.deriveAllFuturesTimeframesFrom1m, true);
    assert.equal(primary.futuresSpecs.get("ES")?.commissionPerContractPerSide, 2.5);
    assert.equal(stress.futuresSpecs.get("ES")?.commissionPerContractPerSide, 3.5);
  });
});
