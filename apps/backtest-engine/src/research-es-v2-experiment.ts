import type { LoadedResearchDatasetIdentity } from "./research-dataset-loader.js";
import type { ResearchActiveProjection } from "./research-active-contract-projector.js";
import { researchEsSimulatorOptions } from "./research-es-experiment.js";
import {
  REGISTERED_ES_V2_EXPERIMENT_SPEC,
  RESEARCH_ES_V2_EXPERIMENT_ID,
  RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
  canonicalResearchV2FailureResult,
  canonicalResearchV2Result,
  researchV2FailureResultSha256,
  researchV2ResultSha256,
  type ResearchEsV2RunRequest,
  type ResearchExperimentV2Evidence,
} from "./research-v2-run-request.js";
import type { ResearchScenarioMetrics } from "./research-run-request.js";
import type { BacktestRepository } from "./repository.js";
import { BacktestSimulator, type SimulatorOptions } from "./simulator.js";

type StoredScenario = "primary" | "stress" | "primary_reproduction";

function createSimulator(
  repository: BacktestRepository,
  runId: number,
  data: ResearchActiveProjection["data"],
  options: SimulatorOptions,
): Pick<BacktestSimulator, "run"> {
  return new BacktestSimulator(repository, runId, data, options);
}

export interface ResearchEsV2ExperimentDependencies {
  repository: BacktestRepository;
  request: ResearchEsV2RunRequest;
  identity: LoadedResearchDatasetIdentity;
  projection: ResearchActiveProjection;
  reloadIdentity: () => Promise<LoadedResearchDatasetIdentity>;
  reloadProjection: () => Promise<ResearchActiveProjection>;
  simulatorFactory?: typeof createSimulator;
}

export function researchEsV2SimulatorOptions(
  identity: LoadedResearchDatasetIdentity,
  scenario: "primary" | "stress",
): SimulatorOptions {
  return {
    ...researchEsSimulatorOptions(identity, scenario),
    deriveAllFuturesTimeframesFrom1m: true,
  };
}

function comparableMetrics(metrics: ResearchScenarioMetrics): unknown {
  const { scenario: _scenario, ...rest } = metrics;
  return rest;
}

export async function runResearchEsV2Experiment(
  dependencies: ResearchEsV2ExperimentDependencies,
): Promise<ResearchExperimentV2Evidence> {
  const { repository, request, identity, projection, reloadIdentity, reloadProjection } = dependencies;
  const simulatorFactory = dependencies.simulatorFactory ?? createSimulator;
  const results = new Map<StoredScenario, ResearchScenarioMetrics>();

  try {
    for (const storedScenario of ["primary", "stress", "primary_reproduction"] as const) {
      const scenario = storedScenario === "primary_reproduction" ? "primary" : storedScenario;
      const before = await reloadIdentity();
      if (before.fingerprint !== identity.fingerprint)
        throw new Error("Research dataset fingerprint changed before v2 scenario execution");
      const options = researchEsV2SimulatorOptions(identity, scenario);
      const run = await repository.createResearchScenarioRun(identity.datasetId, {
        experimentId: RESEARCH_ES_V2_EXPERIMENT_ID,
        specificationSha256: RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
        implementationCommitSha: request.implementationCommitSha,
        provenanceId: identity.provenanceId,
        datasetFingerprint: identity.fingerprint,
        activeSeriesSha256: projection.evidence.activeSeriesSha256,
        scenario: storedScenario,
        assumptions: REGISTERED_ES_V2_EXPERIMENT_SPEC,
      });
      try {
        const summary = await simulatorFactory(
          repository, run.id, projection.data, options,
        ).run({
          total: projection.data.candleCount1m,
          label: `ES compatibility v2 ${storedScenario}`,
          onProgress: (progress) => repository.updateRunProgress(run.id, progress),
        });
        await repository.finishRun(run.id, "completed", summary);
        const afterIdentity = await reloadIdentity();
        if (afterIdentity.fingerprint !== identity.fingerprint)
          throw new Error("Research dataset fingerprint changed after v2 scenario execution");
        const afterProjection = await reloadProjection();
        if (afterProjection.evidence.activeSeriesSha256 !== projection.evidence.activeSeriesSha256)
          throw new Error("Research active-contract projection changed after v2 scenario execution");
        results.set(storedScenario, await repository.getResearchScenarioMetrics(
          run.id,
          scenario,
          before.fingerprint,
          afterIdentity.fingerprint,
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
      throw new Error("Research v2 experiment did not produce all registered scenarios");
    const evidence: ResearchExperimentV2Evidence = {
      experimentId: RESEARCH_ES_V2_EXPERIMENT_ID,
      specificationSha256: RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
      implementationCommitSha: request.implementationCommitSha,
      projection: projection.evidence,
      reproducible: JSON.stringify(comparableMetrics(primary)) ===
        JSON.stringify(comparableMetrics(reproduction)),
      evidenceErrors: [],
      primary,
      stress,
    };
    await repository.saveResearchExperimentArtifact(
      RESEARCH_ES_V2_EXPERIMENT_ID,
      JSON.parse(canonicalResearchV2Result(evidence)),
      researchV2ResultSha256(evidence),
    );
    return evidence;
  } catch (error) {
    const evidenceErrors = [`experiment_execution_failed:${(error as Error).name || "Error"}`];
    await repository.saveResearchExperimentArtifact(
      RESEARCH_ES_V2_EXPERIMENT_ID,
      JSON.parse(canonicalResearchV2FailureResult(request, evidenceErrors)),
      researchV2FailureResultSha256(request, evidenceErrors),
    );
    throw error;
  }
}
