import { availableParallelism, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { LoadedResearchDatasetIdentity } from "./research-dataset-loader.js";
import type { ResearchActiveProjection } from "./research-active-contract-projector.js";
import type { ResearchEsV3ExperimentDependencies, ResearchV3WorkerState } from "./research-es-v3-experiment.js";
import type { ResearchV3StoredScenario } from "./research-es-v3-scenario-worker.js";
import {
  REGISTERED_ES_V3_EXPERIMENT_SPEC,
  RESEARCH_ES_V3_EXPERIMENT_ID,
  RESEARCH_ES_V3_MIN_MEMORY_BYTES,
  RESEARCH_ES_V3_WORKER_COUNT,
  canonicalResearchV3FailureResult,
  parseResearchEsV3RunRequest,
  researchV3FailureResultSha256,
  type ResearchEsV3RunRequest,
} from "./research-v3-run-request.js";
import type { BacktestRepository } from "./repository.js";

export interface ResearchV3RuntimeCapacity { cpus: number; memoryBytes: number }

export async function researchV3RuntimeCapacity(): Promise<ResearchV3RuntimeCapacity> {
  let memoryBytes = totalmem();
  try {
    const raw = (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim();
    if (/^\d+$/.test(raw)) memoryBytes = Math.min(memoryBytes, Number(raw));
  } catch { /* macOS and cgroup v1 use OS-visible memory. */ }
  return { cpus: availableParallelism(), memoryBytes };
}

export interface ResearchEsV3RouteDependencies {
  implementationCommitSha: string;
  researchDatabaseUrl: string;
  researchDatabaseExists: () => Promise<boolean>;
  runtimeCapacity: () => Promise<ResearchV3RuntimeCapacity>;
  loadDataset: (connectionString: string, request: ResearchEsV3RunRequest) => Promise<LoadedResearchDatasetIdentity>;
  loadProjection: (connectionString: string, identity: LoadedResearchDatasetIdentity) => Promise<ResearchActiveProjection>;
  repositoryFactory: (connectionString: string) => BacktestRepository;
  runExperiment: (dependencies: ResearchEsV3ExperimentDependencies) => Promise<unknown>;
}

const scenarios = ["primary", "stress", "primary_reproduction"] as const;

export function installResearchEsV3Routes(app: FastifyInstance, dependencies: ResearchEsV3RouteDependencies) {
  let researchJob: Promise<void> | null = null;
  const workerStates: Record<ResearchV3StoredScenario, ResearchV3WorkerState | "idle"> = {
    primary: "idle", stress: "idle", primary_reproduction: "idle",
  };

  app.post("/backtest/research/es-compatibility-v3", async (request, reply) => {
    if (!dependencies.implementationCommitSha || REGISTERED_ES_V3_EXPERIMENT_SPEC.projection.higherTimeframes.length !== 6) {
      reply.code(503); return { error: "research_v3_implementation_not_frozen" };
    }
    if (researchJob) { reply.code(409); return { error: "research_v3_experiment_running" }; }
    let parsed: ResearchEsV3RunRequest;
    try { parsed = parseResearchEsV3RunRequest(request.body ?? {}, dependencies.implementationCommitSha); }
    catch (error) { reply.code(400); return { error: "invalid_research_v3_request", message: (error as Error).message }; }

    const capacity = await dependencies.runtimeCapacity();
    if (capacity.cpus < RESEARCH_ES_V3_WORKER_COUNT || capacity.memoryBytes < RESEARCH_ES_V3_MIN_MEMORY_BYTES) {
      reply.code(503);
      return { error: "research_v3_runtime_capacity_insufficient", requiredCpus: RESEARCH_ES_V3_WORKER_COUNT,
        availableCpus: capacity.cpus, requiredMemoryBytes: RESEARCH_ES_V3_MIN_MEMORY_BYTES,
        availableMemoryBytes: capacity.memoryBytes };
    }

    researchJob = Promise.resolve();
    let identity: LoadedResearchDatasetIdentity;
    let projection: ResearchActiveProjection;
    try {
      identity = await dependencies.loadDataset(dependencies.researchDatabaseUrl, parsed);
      if (identity.provenanceId !== parsed.provenanceId || identity.fingerprint !== parsed.datasetFingerprint)
        throw new Error("Loaded research dataset identity does not match the v3 request");
      projection = await dependencies.loadProjection(dependencies.researchDatabaseUrl, identity);
    } catch (error) {
      researchJob = null; reply.code(409);
      return { error: "research_v3_projection_identity_mismatch", message: (error as Error).message };
    }

    const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
    try {
      await repository.init();
      if (!(await repository.claimResearchExperiment(RESEARCH_ES_V3_EXPERIMENT_ID, parsed))) {
        await repository.close(); researchJob = null; reply.code(409);
        return { error: "research_v3_experiment_already_started" };
      }
    } catch (error) { await repository.close(); researchJob = null; throw error; }

    for (const scenario of scenarios) workerStates[scenario] = "idle";
    researchJob = (async () => {
      try {
        await dependencies.runExperiment({ repository, request: parsed, identity, projection,
          researchDatabaseUrl: dependencies.researchDatabaseUrl,
          onWorkerState: (scenario, state) => { workerStates[scenario] = state; } });
        app.log.info({ experimentId: parsed.experimentId }, "research ES v3 parallel experiment completed");
      } catch (error) { app.log.error({ err: error }, "research ES v3 parallel experiment failed"); }
      finally { await repository.close(); researchJob = null; }
    })();
    reply.code(202);
    return { experimentId: parsed.experimentId, specificationSha256: parsed.specificationSha256,
      researchJobRunning: true, scenarioWorkerCount: RESEARCH_ES_V3_WORKER_COUNT, workerStates };
  });

  app.get("/backtest/research/es-compatibility-v3", async () => {
    const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
    try { return { experimentId: RESEARCH_ES_V3_EXPERIMENT_ID, researchJobRunning: Boolean(researchJob),
      scenarioWorkerCount: RESEARCH_ES_V3_WORKER_COUNT, workerStates,
      artifact: await repository.getResearchExperimentResult(RESEARCH_ES_V3_EXPERIMENT_ID) }; }
    finally { await repository.close(); }
  });

  return { isRunning: () => Boolean(researchJob), async recoverAbandonedAttempt(): Promise<boolean> {
    if (!(await dependencies.researchDatabaseExists())) return false;
    const evidenceErrors = ["experiment_interrupted_by_process_restart"];
    const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
    try {
      await repository.init();
      return await repository.recoverAbandonedResearchExperiment(RESEARCH_ES_V3_EXPERIMENT_ID, (persisted) => {
        const parsed = parseResearchEsV3RunRequest(persisted);
        return { result: JSON.parse(canonicalResearchV3FailureResult(parsed, evidenceErrors)),
          resultSha256: researchV3FailureResultSha256(parsed, evidenceErrors) };
      });
    } finally { await repository.close(); }
  } };
}
