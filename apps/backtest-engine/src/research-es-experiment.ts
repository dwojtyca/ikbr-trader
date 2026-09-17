import { withBuiltInResearchCalendar } from "./cme-equity-index-calendar.js";
import type { LoadedResearchDatasetIdentity } from "./research-dataset-loader.js";
import { createResearchEsStrategies } from "./research-es-strategy.js";
import {
  REGISTERED_ES_EXPERIMENT_SPEC,
  RESEARCH_ES_EXPERIMENT_ID,
  RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  canonicalResearchFailureResult,
  canonicalResearchResult,
  researchFailureResultSha256,
  researchResultSha256,
  type ResearchEsRunRequest,
  type ResearchExperimentEvidence,
  type ResearchScenarioMetrics,
} from "./research-run-request.js";
import type { BacktestRepository } from "./repository.js";
import { BacktestSimulator, type SimulatorOptions } from "./simulator.js";

type StoredScenario = "primary" | "stress" | "primary_reproduction";

export interface ResearchEsExperimentDependencies {
  repository: BacktestRepository;
  request: ResearchEsRunRequest;
  identity: LoadedResearchDatasetIdentity;
  reloadIdentity: () => Promise<LoadedResearchDatasetIdentity>;
  simulatorFactory?: typeof createSimulator;
}

function createSimulator(
  repository: BacktestRepository,
  runId: number,
  data: Awaited<ReturnType<BacktestRepository["loadBacktestData"]>>,
  options: SimulatorOptions,
): Pick<BacktestSimulator, "run"> {
  return new BacktestSimulator(repository, runId, data, options);
}

export function researchEsSimulatorOptions(
  identity: LoadedResearchDatasetIdentity,
  scenario: "primary" | "stress",
): SimulatorOptions {
  const registered = REGISTERED_ES_EXPERIMENT_SPEC;
  const economics = registered.execution.scenarios.find((item) => item.id === scenario);
  if (!economics) throw new Error(`Unregistered research scenario: ${scenario}`);
  const futuresContracts = new Map(identity.manifest.contracts.map((contract) => [
    contract.conId,
    {
      conid: contract.conId,
      symbol: contract.symbol,
      localSymbol: contract.localSymbol,
      tradingClass: contract.tradingClass,
      lastTradeAt: new Date(contract.lastTradeAt),
    },
  ]));
  const spec = {
    tradingClass: "ES",
    secType: "FUT" as const,
    currency: "USD",
    multiplier: registered.execution.multiplier,
    tickSize: registered.execution.tickSize,
    commissionPerContractPerSide: economics.commissionPerContractPerSide,
    slippageTicks: economics.slippageTicks,
    sessionTemplate: "cme_equity_index" as const,
    timezone: "America/Chicago" as const,
    calendarVersion: identity.manifest.sessionPolicy.calendarVersion,
  };
  return {
    minCandles: registered.signal.minimumCandles,
    maxSpreadBps: registered.signal.maximumSpreadBps,
    minVolume1m: 0,
    minConfidence: registered.signal.minimumConfidence,
    lmtEntryMode: registered.execution.limitEntryMode,
    lmtEntryBufferBps: registered.signal.limitEntryBufferBps,
    fractionalSymbols: new Set(),
    fractionalQuantityStep: 1,
    minStopBpsBySecType: { FUT: registered.signal.minimumStopBps },
    baseCurrency: "USD",
    currencyBySymbol: { ES: "USD" },
    secTypeBySymbol: { ES: "FUT" },
    priceMultiplierBySymbol: { ES: registered.execution.multiplier },
    strategyCooldownMs: registered.execution.strategyCooldownMs,
    commissionBps: 0,
    commissionPerShare: 0,
    commissionMinPerSide: 0,
    commissionPassthroughBps: 0,
    syntheticSpreadBps: registered.signal.syntheticSpreadBps,
    orderTtlCandles: registered.execution.orderTtlCandles,
    futuresSpecs: new Map([["ES", spec]]),
    futuresContracts,
    futuresCalendars: withBuiltInResearchCalendar(new Map()),
    strategyIds: [registered.strategy.id],
    strategyFactory: createResearchEsStrategies,
    riskLimits: {
      accountEquity: registered.risk.accountEquity,
      targetRiskPerTradePct: registered.risk.targetRiskPerTradePct,
      maxRiskPerTradePct: registered.risk.maxRiskPerTradePct,
      maxExposurePct: registered.risk.maxExposurePct,
      maxNotionalPerTradePct: registered.risk.maxNotionalPerTradePct,
      maxOpenPositions: registered.risk.maxOpenPositions,
    },
  };
}

function comparableMetrics(metrics: ResearchScenarioMetrics): unknown {
  const { scenario: _scenario, ...rest } = metrics;
  return rest;
}

export async function runResearchEsExperiment(
  dependencies: ResearchEsExperimentDependencies,
): Promise<ResearchExperimentEvidence> {
  const { repository, request, identity, reloadIdentity } = dependencies;
  const simulatorFactory = dependencies.simulatorFactory ?? createSimulator;
  const results = new Map<StoredScenario, ResearchScenarioMetrics>();

  try {
    for (const storedScenario of ["primary", "stress", "primary_reproduction"] as const) {
    const scenario = storedScenario === "primary_reproduction" ? "primary" : storedScenario;
    const before = await reloadIdentity();
    if (before.fingerprint !== identity.fingerprint)
      throw new Error("Research dataset fingerprint changed before scenario execution");
    const options = researchEsSimulatorOptions(identity, scenario);
    const run = await repository.createResearchScenarioRun(identity.datasetId, {
      experimentId: RESEARCH_ES_EXPERIMENT_ID,
      specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
      implementationCommitSha: request.implementationCommitSha,
      provenanceId: identity.provenanceId,
      datasetFingerprint: identity.fingerprint,
      scenario: storedScenario,
      assumptions: REGISTERED_ES_EXPERIMENT_SPEC,
    });
    try {
      const data = await repository.loadBacktestData(["ES"]);
      const summary = await simulatorFactory(repository, run.id, data, options).run({
        total: data.candleCount1m,
        label: `ES compatibility ${storedScenario}`,
        onProgress: (progress) => repository.updateRunProgress(run.id, progress),
      });
      await repository.finishRun(run.id, "completed", summary);
      const after = await reloadIdentity();
      results.set(storedScenario, await repository.getResearchScenarioMetrics(
        run.id,
        scenario,
        before.fingerprint,
        after.fingerprint,
      ));
    } catch (error) {
      await repository.finishRun(run.id, "failed", { error: (error as Error).message });
      throw error;
    }
    }

    const primary = results.get("primary");
    const stress = results.get("stress");
    const reproduction = results.get("primary_reproduction");
    if (!primary || !stress || !reproduction)
      throw new Error("Research experiment did not produce all registered scenarios");
    const evidence: ResearchExperimentEvidence = {
    experimentId: RESEARCH_ES_EXPERIMENT_ID,
    specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
    implementationCommitSha: request.implementationCommitSha,
    reproducible: JSON.stringify(comparableMetrics(primary)) === JSON.stringify(comparableMetrics(reproduction)),
    evidenceErrors: [],
    primary,
    stress,
    };
    await repository.saveResearchExperimentArtifact(
      RESEARCH_ES_EXPERIMENT_ID,
      JSON.parse(canonicalResearchResult(evidence)),
      researchResultSha256(evidence),
    );
    return evidence;
  } catch (error) {
    const evidenceErrors = [`experiment_execution_failed:${(error as Error).name || "Error"}`];
    await repository.saveResearchExperimentArtifact(
      RESEARCH_ES_EXPERIMENT_ID,
      JSON.parse(canonicalResearchFailureResult(request, evidenceErrors)),
      researchFailureResultSha256(request, evidenceErrors),
    );
    throw error;
  }
}
