import type { FastifyInstance } from "fastify";
import type { LoadedResearchDatasetIdentity } from "./research-dataset-loader.js";
import type { ResearchEsExperimentDependencies } from "./research-es-experiment.js";
import {
  canonicalResearchFailureResult,
  researchFailureResultSha256,
  RESEARCH_ES_EXPERIMENT_ID,
  parseResearchEsRunRequest,
  type ResearchEsRunRequest,
} from "./research-run-request.js";
import type { BacktestRepository } from "./repository.js";

export interface ResearchEsRouteDependencies {
  implementationCommitSha: string;
  researchDatabaseUrl: string;
  researchDatabaseExists: () => Promise<boolean>;
  loadDataset: (
    connectionString: string,
    request: ResearchEsRunRequest,
  ) => Promise<LoadedResearchDatasetIdentity>;
  repositoryFactory: (connectionString: string) => BacktestRepository;
  runExperiment: (dependencies: ResearchEsExperimentDependencies) => Promise<unknown>;
}

export function installResearchEsRoutes(
  app: FastifyInstance,
  dependencies: ResearchEsRouteDependencies,
): { isRunning(): boolean; recoverAbandonedAttempt(): Promise<boolean> } {
  let researchJob: Promise<void> | null = null;

  app.post("/backtest/research/es-compatibility", async (request, reply) => {
    if (!dependencies.implementationCommitSha) {
      reply.code(503);
      return { error: "research_implementation_sha_not_configured" };
    }
    if (researchJob) {
      reply.code(409);
      return { error: "research_experiment_running" };
    }
    let parsed: ResearchEsRunRequest;
    try {
      parsed = parseResearchEsRunRequest(request.body ?? {}, dependencies.implementationCommitSha);
    } catch (error) {
      reply.code(400);
      return { error: "invalid_research_request", message: (error as Error).message };
    }

    researchJob = Promise.resolve();
    let identity: LoadedResearchDatasetIdentity;
    try {
      identity = await dependencies.loadDataset(dependencies.researchDatabaseUrl, parsed);
      if (
        identity.provenanceId !== parsed.provenanceId ||
        identity.fingerprint !== parsed.datasetFingerprint
      ) throw new Error("Loaded research dataset identity does not match the request");
    } catch (error) {
      researchJob = null;
      reply.code(409);
      return { error: "research_dataset_identity_mismatch", message: (error as Error).message };
    }
    const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
    let claimed: boolean;
    try {
      await repository.init();
      claimed = await repository.claimResearchExperiment(RESEARCH_ES_EXPERIMENT_ID, parsed);
    } catch (error) {
      await repository.close();
      researchJob = null;
      throw error;
    }
    if (!claimed) {
      await repository.close();
      researchJob = null;
      reply.code(409);
      return { error: "research_experiment_already_started" };
    }

    researchJob = (async () => {
      try {
        await dependencies.runExperiment({
          repository,
          request: parsed,
          identity,
          reloadIdentity: () => dependencies.loadDataset(dependencies.researchDatabaseUrl, parsed),
        });
        app.log.info({ experimentId: parsed.experimentId }, "research ES compatibility experiment completed");
      } catch (error) {
        app.log.error({ err: error }, "research ES compatibility experiment failed");
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

  app.get("/backtest/research/es-compatibility", async () => {
    const repository = dependencies.repositoryFactory(dependencies.researchDatabaseUrl);
    try {
      return {
        experimentId: RESEARCH_ES_EXPERIMENT_ID,
        researchJobRunning: Boolean(researchJob),
        artifact: await repository.getResearchExperimentResult(RESEARCH_ES_EXPERIMENT_ID),
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
          RESEARCH_ES_EXPERIMENT_ID,
          (persistedRequest) => {
            const request = parseResearchEsRunRequest(persistedRequest);
            return {
              result: JSON.parse(canonicalResearchFailureResult(request, evidenceErrors)),
              resultSha256: researchFailureResultSha256(request, evidenceErrors),
            };
          },
        );
      } finally {
        await repository.close();
      }
    },
  };
}
