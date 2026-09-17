import type { FastifyInstance } from "fastify";
import type { LoadedResearchDatasetIdentity } from "./research-dataset-loader.js";
import type { ResearchActiveProjection } from "./research-active-contract-projector.js";
import type { ResearchEsV2ExperimentDependencies } from "./research-es-v2-experiment.js";
import {
  REGISTERED_ES_V2_PROJECTION,
  RESEARCH_ES_V2_EXPERIMENT_ID,
  canonicalResearchV2FailureResult,
  parseResearchEsV2RunRequest,
  researchV2FailureResultSha256,
  type ResearchEsV2RunRequest,
} from "./research-v2-run-request.js";
import type { BacktestRepository } from "./repository.js";

export interface ResearchEsV2RouteDependencies {
  implementationCommitSha: string;
  researchDatabaseUrl: string;
  researchDatabaseExists: () => Promise<boolean>;
  loadDataset: (
    connectionString: string,
    request: ResearchEsV2RunRequest,
  ) => Promise<LoadedResearchDatasetIdentity>;
  loadProjection: (
    connectionString: string,
    identity: LoadedResearchDatasetIdentity,
  ) => Promise<ResearchActiveProjection>;
  repositoryFactory: (connectionString: string) => BacktestRepository;
  runExperiment: (dependencies: ResearchEsV2ExperimentDependencies) => Promise<unknown>;
}

export function installResearchEsV2Routes(
  app: FastifyInstance,
  dependencies: ResearchEsV2RouteDependencies,
): { isRunning(): boolean; recoverAbandonedAttempt(): Promise<boolean> } {
  let researchJob: Promise<void> | null = null;

  app.post("/backtest/research/es-compatibility-v2", async (request, reply) => {
    if (!dependencies.implementationCommitSha ||
      REGISTERED_ES_V2_PROJECTION.higherTimeframes.length !== 6) {
      reply.code(503);
      return { error: "research_v2_implementation_not_frozen" };
    }
    if (researchJob) {
      reply.code(409);
      return { error: "research_v2_experiment_running" };
    }
    let parsed: ResearchEsV2RunRequest;
    try {
      parsed = parseResearchEsV2RunRequest(request.body ?? {}, dependencies.implementationCommitSha);
    } catch (error) {
      reply.code(400);
      return { error: "invalid_research_v2_request", message: (error as Error).message };
    }

    researchJob = Promise.resolve();
    let identity: LoadedResearchDatasetIdentity;
    let projection: ResearchActiveProjection;
    try {
      identity = await dependencies.loadDataset(dependencies.researchDatabaseUrl, parsed);
      if (identity.provenanceId !== parsed.provenanceId ||
        identity.fingerprint !== parsed.datasetFingerprint)
        throw new Error("Loaded research dataset identity does not match the v2 request");
      projection = await dependencies.loadProjection(dependencies.researchDatabaseUrl, identity);
    } catch (error) {
      researchJob = null;
      reply.code(409);
      return { error: "research_v2_projection_identity_mismatch", message: (error as Error).message };
    }

    const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
    let claimed: boolean;
    try {
      await repository.init();
      claimed = await repository.claimResearchExperiment(RESEARCH_ES_V2_EXPERIMENT_ID, parsed);
    } catch (error) {
      await repository.close();
      researchJob = null;
      throw error;
    }
    if (!claimed) {
      await repository.close();
      researchJob = null;
      reply.code(409);
      return { error: "research_v2_experiment_already_started" };
    }

    const reloadProjection = async () => {
      const reloadedIdentity = await dependencies.loadDataset(dependencies.researchDatabaseUrl, parsed);
      return dependencies.loadProjection(dependencies.researchDatabaseUrl, reloadedIdentity);
    };
    researchJob = (async () => {
      try {
        await dependencies.runExperiment({
          repository,
          request: parsed,
          identity,
          projection,
          reloadIdentity: () => dependencies.loadDataset(dependencies.researchDatabaseUrl, parsed),
          reloadProjection,
        });
        app.log.info({ experimentId: parsed.experimentId }, "research ES v2 compatibility experiment completed");
      } catch (error) {
        app.log.error({ err: error }, "research ES v2 compatibility experiment failed");
      } finally {
        await repository.close();
        researchJob = null;
      }
    })();
    reply.code(202);
    return {
      experimentId: parsed.experimentId,
      specificationSha256: parsed.specificationSha256,
      researchJobRunning: true,
    };
  });

  app.get("/backtest/research/es-compatibility-v2", async () => {
    const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
    try {
      return {
        experimentId: RESEARCH_ES_V2_EXPERIMENT_ID,
        researchJobRunning: Boolean(researchJob),
        artifact: await repository.getResearchExperimentResult(RESEARCH_ES_V2_EXPERIMENT_ID),
      };
    } finally {
      await repository.close();
    }
  });

  return {
    isRunning: () => Boolean(researchJob),
    async recoverAbandonedAttempt(): Promise<boolean> {
      if (!(await dependencies.researchDatabaseExists())) return false;
      const evidenceErrors = ["experiment_interrupted_by_process_restart"];
      const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
      try {
        await repository.init();
        return await repository.recoverAbandonedResearchExperiment(
          RESEARCH_ES_V2_EXPERIMENT_ID,
          (persistedRequest) => {
            const request = parseResearchEsV2RunRequest(persistedRequest);
            return {
              result: JSON.parse(canonicalResearchV2FailureResult(request, evidenceErrors)),
              resultSha256: researchV2FailureResultSha256(request, evidenceErrors),
            };
          },
        );
      } finally {
        await repository.close();
      }
    },
  };
}
