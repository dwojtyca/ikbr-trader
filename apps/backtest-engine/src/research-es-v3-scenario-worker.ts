import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadResearchActiveContractProjection } from "./research-active-contract-projector.js";
import { loadRegisteredResearchDataset } from "./research-dataset-loader.js";
import { researchEsV2SimulatorOptions } from "./research-es-v2-experiment.js";
import {
  REGISTERED_ES_V3_EXPERIMENT_SPEC,
  RESEARCH_ES_V3_EXPERIMENT_ID,
  RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256,
  parseResearchEsV3RunRequest,
  type ResearchEsV3RunRequest,
} from "./research-v3-run-request.js";
import { REGISTERED_ES_V2_PROJECTION } from "./research-v2-run-request.js";
import type { ResearchScenarioMetrics } from "./research-run-request.js";
import { BacktestRepository } from "./repository.js";
import { BacktestSimulator } from "./simulator.js";

export type ResearchV3StoredScenario = "primary" | "stress" | "primary_reproduction";

export interface ResearchV3ScenarioWorkerInput {
  researchDatabaseUrl: string;
  request: ResearchEsV3RunRequest;
  storedScenario: ResearchV3StoredScenario;
}

export type ResearchV3ScenarioWorkerMessage =
  | { type: "completed"; storedScenario: ResearchV3StoredScenario; metrics: ResearchScenarioMetrics }
  | { type: "failed"; storedScenario: ResearchV3StoredScenario; errorName: string };

export async function executeResearchV3Scenario(
  input: ResearchV3ScenarioWorkerInput,
): Promise<ResearchScenarioMetrics> {
  const request = parseResearchEsV3RunRequest(input.request);
  const scenario = input.storedScenario === "primary_reproduction" ? "primary" : input.storedScenario;
  const identity = await loadRegisteredResearchDataset(input.researchDatabaseUrl, request);
  const projection = await loadResearchActiveContractProjection(
    input.researchDatabaseUrl,
    identity,
    REGISTERED_ES_V2_PROJECTION,
  );
  if (projection.evidence.activeSeriesSha256 !== REGISTERED_ES_V2_PROJECTION.activeSeriesSha256)
    throw new Error("Research v3 worker projection identity mismatch");

  const repository = new BacktestRepository(input.researchDatabaseUrl);
  let runId: number | undefined;
  try {
    const run = await repository.createResearchScenarioRun(identity.datasetId, {
      experimentId: RESEARCH_ES_V3_EXPERIMENT_ID,
      specificationSha256: RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256,
      implementationCommitSha: request.implementationCommitSha,
      provenanceId: identity.provenanceId,
      datasetFingerprint: identity.fingerprint,
      activeSeriesSha256: projection.evidence.activeSeriesSha256,
      scenario: input.storedScenario,
      assumptions: REGISTERED_ES_V3_EXPERIMENT_SPEC,
    });
    runId = run.id;
    const summary = await new BacktestSimulator(
      repository,
      run.id,
      projection.data,
      researchEsV2SimulatorOptions(identity, scenario),
    ).run({
      total: projection.data.candleCount1m,
      label: `ES compatibility v3 ${input.storedScenario}`,
      onProgress: (progress) => repository.updateRunProgress(run.id, progress),
    });
    await repository.finishRun(run.id, "completed", summary);
    const afterIdentity = await loadRegisteredResearchDataset(input.researchDatabaseUrl, request);
    if (afterIdentity.fingerprint !== identity.fingerprint)
      throw new Error("Research dataset fingerprint changed after v3 scenario execution");
    const afterProjection = await loadResearchActiveContractProjection(
      input.researchDatabaseUrl,
      afterIdentity,
      REGISTERED_ES_V2_PROJECTION,
    );
    if (afterProjection.evidence.activeSeriesSha256 !== projection.evidence.activeSeriesSha256)
      throw new Error("Research active-contract projection changed after v3 scenario execution");
    return repository.getResearchScenarioMetrics(
      run.id,
      scenario,
      identity.fingerprint,
      afterIdentity.fingerprint,
    );
  } catch (error) {
    if (runId !== undefined) {
      await repository.finishRun(runId, "failed", {
        error: `Research v3 scenario failed: ${(error as Error).name || "Error"}`,
      });
    }
    throw error;
  } finally {
    await repository.close();
  }
}

if (!isMainThread) {
  const input = workerData as ResearchV3ScenarioWorkerInput;
  try {
    const metrics = await executeResearchV3Scenario(input);
    parentPort?.postMessage({
      type: "completed",
      storedScenario: input.storedScenario,
      metrics,
    } satisfies ResearchV3ScenarioWorkerMessage);
  } catch (error) {
    parentPort?.postMessage({
      type: "failed",
      storedScenario: input.storedScenario,
      errorName: (error as Error).name || "Error",
    } satisfies ResearchV3ScenarioWorkerMessage);
    process.exitCode = 1;
  }
}
