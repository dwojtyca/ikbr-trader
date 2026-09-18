import { z } from "zod";
import {
  REGISTERED_ES_V2_EXPERIMENT_SPEC,
  REGISTERED_ES_V2_PROJECTION,
} from "./research-v2-run-request.js";
import {
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_PROVENANCE_ID,
  canonicalJson,
  evaluateResearchExperiment,
  sha256,
  type ResearchExperimentEvidence,
  type ResearchExperimentVerdict,
  type ResearchScenarioMetrics,
} from "./research-run-request.js";

export const RESEARCH_ES_V3_EXPERIMENT_ID = "pr15.5d3-es-momentum-breakout-long-v1";
export const RESEARCH_ES_V3_WORKER_COUNT = 3;
export const RESEARCH_ES_V3_WORKER_OLD_GEN_MB = 3072;
export const RESEARCH_ES_V3_MIN_MEMORY_BYTES = 12 * 1024 ** 3;

export const REGISTERED_ES_V3_EXPERIMENT_SPEC = Object.freeze({
  ...REGISTERED_ES_V2_EXPERIMENT_SPEC,
  schemaVersion: "pr15.5d3-es-experiment-v1",
  experimentId: RESEARCH_ES_V3_EXPERIMENT_ID,
  scenarioExecutionPolicy: "three-worker-parallel-v1",
  scenarioWorkerCount: RESEARCH_ES_V3_WORKER_COUNT,
  workerMaxOldGenerationMb: RESEARCH_ES_V3_WORKER_OLD_GEN_MB,
} as const);

export const RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256 = sha256(
  canonicalJson(REGISTERED_ES_V3_EXPERIMENT_SPEC),
);

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const requestSchema = z.object({
  experimentId: z.literal(RESEARCH_ES_V3_EXPERIMENT_ID),
  specificationSha256: z.literal(RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256),
  implementationCommitSha: sha,
  provenanceId: z.literal(RESEARCH_ES_PROVENANCE_ID),
  datasetFingerprint: z.literal(RESEARCH_ES_DATASET_FINGERPRINT),
}).strict();

export type ResearchEsV3RunRequest = z.infer<typeof requestSchema>;

export function parseResearchEsV3RunRequest(
  input: unknown,
  expectedImplementationCommitSha?: string,
): ResearchEsV3RunRequest {
  const request = requestSchema.parse(input);
  if (expectedImplementationCommitSha && request.implementationCommitSha !== expectedImplementationCommitSha)
    throw new Error("Research v3 implementation commit does not match the running build");
  return Object.freeze(request);
}

export interface ResearchExperimentV3Evidence {
  experimentId: typeof RESEARCH_ES_V3_EXPERIMENT_ID;
  specificationSha256: typeof RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256;
  implementationCommitSha: string;
  projection: typeof REGISTERED_ES_V2_PROJECTION;
  scenarioExecutionPolicy: typeof REGISTERED_ES_V3_EXPERIMENT_SPEC.scenarioExecutionPolicy;
  scenarioWorkerCount: typeof RESEARCH_ES_V3_WORKER_COUNT;
  reproducible: boolean;
  evidenceErrors: readonly string[];
  primary: ResearchScenarioMetrics;
  stress: ResearchScenarioMetrics;
}

function evaluateV3(input: ResearchExperimentV3Evidence): ReturnType<typeof evaluateResearchExperiment> {
  return evaluateResearchExperiment(input as unknown as ResearchExperimentEvidence);
}

export function canonicalResearchV3Result(input: ResearchExperimentV3Evidence): string {
  const evaluated = evaluateV3(input);
  return canonicalJson({
    schemaVersion: "pr15.5d3-es-result-v1",
    experimentId: input.experimentId,
    specificationSha256: input.specificationSha256,
    implementationCommitSha: input.implementationCommitSha,
    dataset: REGISTERED_ES_V3_EXPERIMENT_SPEC.dataset,
    projection: input.projection,
    scenarioExecutionPolicy: input.scenarioExecutionPolicy,
    scenarioWorkerCount: input.scenarioWorkerCount,
    reproducible: input.reproducible,
    evidenceErrors: [...input.evidenceErrors],
    primary: input.primary,
    stress: input.stress,
    gates: evaluated.gates,
    verdict: evaluated.verdict,
  });
}

export function researchV3ResultSha256(input: ResearchExperimentV3Evidence): string {
  return sha256(canonicalResearchV3Result(input));
}

export function canonicalResearchV3FailureResult(
  request: ResearchEsV3RunRequest,
  evidenceErrors: readonly string[],
): string {
  return canonicalJson({
    schemaVersion: "pr15.5d3-es-result-v1",
    experimentId: request.experimentId,
    specificationSha256: request.specificationSha256,
    implementationCommitSha: request.implementationCommitSha,
    dataset: REGISTERED_ES_V3_EXPERIMENT_SPEC.dataset,
    projection: REGISTERED_ES_V2_PROJECTION,
    scenarioExecutionPolicy: REGISTERED_ES_V3_EXPERIMENT_SPEC.scenarioExecutionPolicy,
    scenarioWorkerCount: RESEARCH_ES_V3_WORKER_COUNT,
    reproducible: false,
    evidenceErrors: [...evidenceErrors],
    verdict: "INCONCLUSIVE" satisfies ResearchExperimentVerdict,
  });
}

export function researchV3FailureResultSha256(
  request: ResearchEsV3RunRequest,
  evidenceErrors: readonly string[],
): string {
  return sha256(canonicalResearchV3FailureResult(request, evidenceErrors));
}
