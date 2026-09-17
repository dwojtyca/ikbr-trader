import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BacktestRepository } from "./repository.js";
import {
  researchEsSimulatorOptions,
  runResearchEsExperiment,
} from "./research-es-experiment.js";
import {
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_EXPERIMENT_ID,
  RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  RESEARCH_ES_PROVENANCE_ID,
  type ResearchScenarioMetrics,
} from "./research-run-request.js";

const contract = {
  conId: "637533641", localSymbol: "ESU5", symbol: "ES", tradingClass: "ES",
  exchange: "CME", currency: "USD", expiry: "2025-09-19T13:30:00.000Z",
  lastTradeAt: "2025-09-19T13:30:00.000Z", validFrom: "2025-06-22T22:00:00.000Z",
  validTo: "2025-09-15T21:59:00.000Z", rollAt: null, multiplier: "50", minTick: "0.25",
} as const;

const identity = {
  datasetId: 7,
  provenanceId: RESEARCH_ES_PROVENANCE_ID,
  fingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
  candlesCount: 1,
  manifest: {
    contracts: [contract],
    sessionPolicy: { calendarVersion: "cme-equity-index-2024-2026-v1" },
  },
} as any;

function metrics(scenario: "primary" | "stress"): ResearchScenarioMetrics {
  return {
    scenario, closedTrades: 30, wins: 20, losses: 10, winRate: 2 / 3, grossPnl: 100,
    grossWins: 120, grossLosses: 20,
    commissions: 10, slippageCost: 10, netPnl: 80, meanNetPnl: 8,
    medianNetPnl: 4, profitFactor: 2, maxDrawdown: -20,
    largestWinningTrade: 20, largestLosingTrade: -10,
    countsByMonth: {}, countsByContract: {}, countsByExitReason: {},
    countsByDirectionalRegime: {}, countsByVolatilityRegime: {},
    signalRejections: {}, lifecycleExitCounts: {},
    openPositions: 0, pendingOrders: 0, unclosedFills: 0,
    strategyPermanentlyDisabled: false, invariantViolations: [],
    datasetFingerprintBefore: RESEARCH_ES_DATASET_FINGERPRINT,
    datasetFingerprintAfter: RESEARCH_ES_DATASET_FINGERPRINT,
  };
}

describe("PR15.5D ES experiment runner", () => {
  it("freezes primary and stress futures economics", () => {
    const primary = researchEsSimulatorOptions(identity, "primary");
    const stress = researchEsSimulatorOptions(identity, "stress");
    assert.equal(primary.futuresSpecs.get("ES")?.commissionPerContractPerSide, 2.5);
    assert.equal(primary.futuresSpecs.get("ES")?.slippageTicks, 1);
    assert.equal(stress.futuresSpecs.get("ES")?.commissionPerContractPerSide, 3.5);
    assert.equal(stress.futuresSpecs.get("ES")?.slippageTicks, 2);
    assert.deepEqual(primary.secTypeBySymbol, { ES: "FUT" });
    assert.deepEqual(primary.strategyIds, ["momentum_breakout_long_v1"]);
    assert.equal(primary.riskLimits.maxOpenPositions, 1);
  });

  it("runs primary, stress, and deterministic primary reproduction exactly once", async () => {
    const scenarios: string[] = [];
    let resultSaved = false;
    const repository = {
      async createResearchScenarioRun(_datasetId: number, config: { scenario: string }) {
        scenarios.push(config.scenario);
        return { id: scenarios.length };
      },
      async loadBacktestData() { return { candleCount1m: 1 }; },
      async updateRunProgress() {},
      async finishRun() {},
      async getResearchScenarioMetrics(_runId: number, scenario: "primary" | "stress") {
        return metrics(scenario);
      },
      async saveResearchExperimentArtifact(experimentId: string, _result: unknown, sha: string) {
        assert.equal(experimentId, RESEARCH_ES_EXPERIMENT_ID);
        assert.match(sha, /^[a-f0-9]{64}$/);
        resultSaved = true;
      },
    } as unknown as BacktestRepository;
    const evidence = await runResearchEsExperiment({
      repository,
      request: {
        experimentId: RESEARCH_ES_EXPERIMENT_ID,
        specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
        implementationCommitSha: "a".repeat(40),
        provenanceId: RESEARCH_ES_PROVENANCE_ID,
        datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
      },
      identity,
      reloadIdentity: async () => identity,
      simulatorFactory: (() => ({
        run: async () => ({ totalPnl: 80, trades: 30, wins: 20, winRate: 2 / 3 }),
      })) as any,
    });
    assert.deepEqual(scenarios, ["primary", "stress", "primary_reproduction"]);
    assert.equal(evidence.reproducible, true);
    assert.equal(resultSaved, true);
  });

  it("persists a terminal INCONCLUSIVE artifact after an execution failure", async () => {
    let saved: any;
    const repository = {
      async createResearchScenarioRun() { return { id: 1 }; },
      async loadBacktestData() { return { candleCount1m: 1 }; },
      async updateRunProgress() {},
      async finishRun() {},
      async saveResearchExperimentArtifact(_id: string, result: unknown) { saved = result; },
    } as unknown as BacktestRepository;
    await assert.rejects(() => runResearchEsExperiment({
      repository,
      request: {
        experimentId: RESEARCH_ES_EXPERIMENT_ID,
        specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
        implementationCommitSha: "a".repeat(40),
        provenanceId: RESEARCH_ES_PROVENANCE_ID,
        datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
      },
      identity,
      reloadIdentity: async () => identity,
      simulatorFactory: (() => ({ run: async () => { throw new Error("fixture failure"); } })) as any,
    }), /fixture failure/);
    assert.equal(saved.verdict, "INCONCLUSIVE");
    assert.deepEqual(saved.evidenceErrors, ["experiment_execution_failed:Error"]);
  });

  it("persists INCONCLUSIVE when a claimed attempt fails before the first scenario", async () => {
    let created = false;
    let saved: any;
    const repository = {
      async createResearchScenarioRun() { created = true; return { id: 1 }; },
      async saveResearchExperimentArtifact(_id: string, result: unknown) { saved = result; },
    } as unknown as BacktestRepository;
    await assert.rejects(() => runResearchEsExperiment({
      repository,
      request: {
        experimentId: RESEARCH_ES_EXPERIMENT_ID,
        specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
        implementationCommitSha: "a".repeat(40),
        provenanceId: RESEARCH_ES_PROVENANCE_ID,
        datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
      },
      identity,
      reloadIdentity: async () => { throw new Error("identity read failed"); },
    }), /identity read failed/);
    assert.equal(created, false);
    assert.equal(saved.verdict, "INCONCLUSIVE");
  });
});
