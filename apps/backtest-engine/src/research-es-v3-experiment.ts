import { Worker } from "node:worker_threads";
import type { ResearchActiveProjection } from "./research-active-contract-projector.js";
import type { LoadedResearchDatasetIdentity } from "./research-dataset-loader.js";
import type {
  ResearchV3ScenarioWorkerInput,
  ResearchV3ScenarioWorkerMessage,
  ResearchV3StoredScenario,
} from "./research-es-v3-scenario-worker.js";
import {
  RESEARCH_ES_V3_EXPERIMENT_ID,
  RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256,
  RESEARCH_ES_V3_WORKER_COUNT,
  RESEARCH_ES_V3_WORKER_OLD_GEN_MB,
  REGISTERED_ES_V3_EXPERIMENT_SPEC,
  canonicalResearchV3FailureResult,
  canonicalResearchV3Result,
  researchV3FailureResultSha256,
  researchV3ResultSha256,
  type ResearchEsV3RunRequest,
  type ResearchExperimentV3Evidence,
} from "./research-v3-run-request.js";
import type { ResearchScenarioMetrics } from "./research-run-request.js";
import type { BacktestRepository } from "./repository.js";

const SCENARIOS = ["primary", "stress", "primary_reproduction"] as const;
export type ResearchV3WorkerState = "starting" | "running" | "completed" | "failed";

export interface ResearchEsV3ExperimentDependencies {
  repository: BacktestRepository;
  request: ResearchEsV3RunRequest;
  identity: LoadedResearchDatasetIdentity;
  projection: ResearchActiveProjection;
  researchDatabaseUrl: string;
  scenarioRunner?: (input: ResearchV3ScenarioWorkerInput) => Promise<ResearchScenarioMetrics>;
  onWorkerState?: (scenario: ResearchV3StoredScenario, state: ResearchV3WorkerState) => void;
}

function comparableMetrics(metrics: ResearchScenarioMetrics): unknown {
  const { scenario: _scenario, ...rest } = metrics;
  return rest;
}

function isWorkerMessage(value: unknown): value is ResearchV3ScenarioWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ResearchV3ScenarioWorkerMessage>;
  if (message.type === "completed") return Boolean(message.metrics) && SCENARIOS.includes(message.storedScenario as ResearchV3StoredScenario);
  if (message.type === "failed") return typeof message.errorName === "string" && SCENARIOS.includes(message.storedScenario as ResearchV3StoredScenario);
  return false;
}

export function runResearchV3ScenarioWorker(
  input: ResearchV3ScenarioWorkerInput,
): Promise<ResearchScenarioMetrics> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./research-es-v3-scenario-worker.js", import.meta.url),
      {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: RESEARCH_ES_V3_WORKER_OLD_GEN_MB },
      },
    );
    const messages: ResearchV3ScenarioWorkerMessage[] = [];
    let workerError: Error | undefined;
    worker.on("message", (value: unknown) => {
      if (!isWorkerMessage(value) || value.storedScenario !== input.storedScenario) {
        workerError = new Error("Research v3 worker emitted a malformed or wrong-scenario message");
        return;
      }
      messages.push(value);
    });
    worker.on("error", (error) => { workerError = error; });
    worker.on("exit", (code) => {
      if (workerError) { reject(workerError); return; }
      if (code !== 0) { reject(new Error(`Research v3 worker exited with code ${code}`)); return; }
      if (messages.length !== 1) {
        reject(new Error(`Research v3 worker emitted ${messages.length} terminal messages`));
        return;
      }
      const message = messages[0];
      if (message.type !== "completed") {
        reject(new Error(`Research v3 worker failed: ${message.errorName}`));
        return;
      }
      resolve(message.metrics);
    });
  });
}

export async function runResearchEsV3Experiment(
  dependencies: ResearchEsV3ExperimentDependencies,
): Promise<ResearchExperimentV3Evidence> {
  const { repository, request, identity, projection, researchDatabaseUrl } = dependencies;
  const scenarioRunner = dependencies.scenarioRunner ?? runResearchV3ScenarioWorker;
  try {
    const promises = SCENARIOS.map(async (storedScenario) => {
      dependencies.onWorkerState?.(storedScenario, "starting");
      try {
        dependencies.onWorkerState?.(storedScenario, "running");
        const metrics = await scenarioRunner({ researchDatabaseUrl, request, storedScenario });
        dependencies.onWorkerState?.(storedScenario, "completed");
        return { storedScenario, metrics };
      } catch (error) {
        dependencies.onWorkerState?.(storedScenario, "failed");
        throw error;
      }
    });
    if (promises.length !== RESEARCH_ES_V3_WORKER_COUNT)
      throw new Error("Research v3 worker count differs from the frozen specification");
    const settled = await Promise.allSettled(promises);
    const failures = settled.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw new Error(`Research v3 scenario worker failure count: ${failures.length}`);
    const results = new Map<ResearchV3StoredScenario, ResearchScenarioMetrics>();
    for (const result of settled) {
      if (result.status !== "fulfilled" || results.has(result.value.storedScenario))
        throw new Error("Research v3 worker result set is incomplete or duplicated");
      results.set(result.value.storedScenario, result.value.metrics);
    }
    const primary = results.get("primary");
    const stress = results.get("stress");
    const reproduction = results.get("primary_reproduction");
    if (!primary || !stress || !reproduction)
      throw new Error("Research v3 experiment did not produce all registered scenarios");
    const evidence: ResearchExperimentV3Evidence = {
      experimentId: RESEARCH_ES_V3_EXPERIMENT_ID,
      specificationSha256: RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256,
      implementationCommitSha: request.implementationCommitSha,
      projection: projection.evidence as typeof REGISTERED_ES_V3_EXPERIMENT_SPEC.projection,
      scenarioExecutionPolicy: REGISTERED_ES_V3_EXPERIMENT_SPEC.scenarioExecutionPolicy,
      scenarioWorkerCount: RESEARCH_ES_V3_WORKER_COUNT,
      reproducible: JSON.stringify(comparableMetrics(primary)) === JSON.stringify(comparableMetrics(reproduction)),
      evidenceErrors: [],
      primary,
      stress,
    };
    await repository.saveResearchExperimentArtifact(
      RESEARCH_ES_V3_EXPERIMENT_ID,
      JSON.parse(canonicalResearchV3Result(evidence)),
      researchV3ResultSha256(evidence),
    );
    return evidence;
  } catch (error) {
    await repository.failRunningResearchScenarioRuns(
      RESEARCH_ES_V3_EXPERIMENT_ID,
      "Research v3 scenario worker did not reach a terminal state",
    );
    const evidenceErrors = [`experiment_execution_failed:${(error as Error).name || "Error"}`];
    await repository.saveResearchExperimentArtifact(
      RESEARCH_ES_V3_EXPERIMENT_ID,
      JSON.parse(canonicalResearchV3FailureResult(request, evidenceErrors)),
      researchV3FailureResultSha256(request, evidenceErrors),
    );
    throw error;
  }
}
