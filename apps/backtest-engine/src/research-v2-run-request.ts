import { z } from "zod";
import type { ResearchActiveProjectionEvidence } from "./research-active-contract-projector.js";
import {
  REGISTERED_ES_EXPERIMENT_SPEC,
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_PROVENANCE_ID,
  canonicalJson,
  evaluateResearchExperiment,
  sha256,
  type ResearchExperimentEvidence,
  type ResearchExperimentVerdict,
  type ResearchScenarioMetrics,
} from "./research-run-request.js";

export const RESEARCH_ES_V2_EXPERIMENT_ID = "pr15.5d1-es-momentum-breakout-long-v1";

export const REGISTERED_ES_V2_PROJECTION = Object.freeze({
  algorithmVersion: "research-active-contract-projection-v1",
  rawRows: 483_608,
  expectedActiveMinutes: 423_360,
  selectedRows: 423_300,
  missingActiveMinutes: 60,
  maximumConsecutiveGap: 1,
  entirelyMissingSessions: 0,
  inactiveOnlyRawTimestamps: [
    "2025-09-04T13:30:00.000Z",
    "2025-09-09T13:30:00.000Z",
    "2025-12-09T14:30:00.000Z",
    "2026-06-03T13:30:00.000Z",
    "2026-06-08T13:30:00.000Z",
    "2026-06-17T20:59:00.000Z",
  ],
  activeSeriesSha256: "741220af6e99c90a85d73f28c5c9ab40784b91f44a2079f4bad7a50e71251411",
  contracts: [
    { conId: "637533641", count: 83_463, firstTs: "2025-06-22T22:00:00.000Z", lastTs: "2025-09-15T20:59:00.000Z" },
    { conId: "495512563", count: 89_223, firstTs: "2025-09-15T22:00:00.000Z", lastTs: "2025-12-15T21:59:00.000Z" },
    { conId: "649180695", count: 86_224, firstTs: "2025-12-15T23:00:00.000Z", lastTs: "2026-03-16T20:59:00.000Z" },
    { conId: "649180678", count: 88_982, firstTs: "2026-03-16T22:00:00.000Z", lastTs: "2026-06-15T20:59:00.000Z" },
    { conId: "649180671", count: 75_408, firstTs: "2026-06-15T22:00:00.000Z", lastTs: "2026-08-31T20:58:00.000Z" },
  ],
  higherTimeframes: [
    {
      timeframe: "5m", count: 84_672,
      sha256: "95de2564dfd3b7a78c52bff4e74c697f35ebdaf08db8c3bd59c246c8153f3881",
      contracts: [
        { conId: "637533641", count: 16_695, firstBucketStart: "2025-06-22T22:00:00.000Z", firstCompletedAt: "2025-06-22T22:05:00.000Z", lastBucketStart: "2025-09-15T20:55:00.000Z", lastCompletedAt: "2025-09-15T21:00:00.000Z" },
        { conId: "495512563", count: 17_847, firstBucketStart: "2025-09-15T22:00:00.000Z", firstCompletedAt: "2025-09-15T22:05:00.000Z", lastBucketStart: "2025-12-15T21:55:00.000Z", lastCompletedAt: "2025-12-15T22:00:00.000Z" },
        { conId: "649180695", count: 17_247, firstBucketStart: "2025-12-15T23:00:00.000Z", firstCompletedAt: "2025-12-15T23:05:00.000Z", lastBucketStart: "2026-03-16T20:55:00.000Z", lastCompletedAt: "2026-03-16T21:00:00.000Z" },
        { conId: "649180678", count: 17_799, firstBucketStart: "2026-03-16T22:00:00.000Z", firstCompletedAt: "2026-03-16T22:05:00.000Z", lastBucketStart: "2026-06-15T20:55:00.000Z", lastCompletedAt: "2026-06-15T21:00:00.000Z" },
        { conId: "649180671", count: 15_084, firstBucketStart: "2026-06-15T22:00:00.000Z", firstCompletedAt: "2026-06-15T22:05:00.000Z", lastBucketStart: "2026-08-31T20:55:00.000Z", lastCompletedAt: "2026-08-31T21:00:00.000Z" },
      ],
    },
    {
      timeframe: "1h", count: 7_059,
      sha256: "62585b6b905024e05e404193aa1d541d972797fc9f0fc37df3ca8a3b0f7db766",
      contracts: [
        { conId: "637533641", count: 1_392, firstBucketStart: "2025-06-22T22:00:00.000Z", firstCompletedAt: "2025-06-22T23:00:00.000Z", lastBucketStart: "2025-09-15T20:00:00.000Z", lastCompletedAt: "2025-09-15T21:00:00.000Z" },
        { conId: "495512563", count: 1_488, firstBucketStart: "2025-09-15T22:00:00.000Z", firstCompletedAt: "2025-09-15T23:00:00.000Z", lastBucketStart: "2025-12-15T21:00:00.000Z", lastCompletedAt: "2025-12-15T22:00:00.000Z" },
        { conId: "649180695", count: 1_438, firstBucketStart: "2025-12-15T23:00:00.000Z", firstCompletedAt: "2025-12-16T00:00:00.000Z", lastBucketStart: "2026-03-16T20:00:00.000Z", lastCompletedAt: "2026-03-16T21:00:00.000Z" },
        { conId: "649180678", count: 1_484, firstBucketStart: "2026-03-16T22:00:00.000Z", firstCompletedAt: "2026-03-16T23:00:00.000Z", lastBucketStart: "2026-06-15T20:00:00.000Z", lastCompletedAt: "2026-06-15T21:00:00.000Z" },
        { conId: "649180671", count: 1_257, firstBucketStart: "2026-06-15T22:00:00.000Z", firstCompletedAt: "2026-06-15T23:00:00.000Z", lastBucketStart: "2026-08-31T20:00:00.000Z", lastCompletedAt: "2026-08-31T21:00:00.000Z" },
      ],
    },
    {
      timeframe: "4h", count: 1_841,
      sha256: "1304537302c509244605b8e87c9ad7a9243aafd6536ac99bfa12d400b643619d",
      contracts: [
        { conId: "637533641", count: 363, firstBucketStart: "2025-06-22T22:00:00.000Z", firstCompletedAt: "2025-06-23T02:00:00.000Z", lastBucketStart: "2025-09-15T18:00:00.000Z", lastCompletedAt: "2025-09-15T21:00:00.000Z" },
        { conId: "495512563", count: 388, firstBucketStart: "2025-09-15T22:00:00.000Z", firstCompletedAt: "2025-09-16T02:00:00.000Z", lastBucketStart: "2025-12-15T19:00:00.000Z", lastCompletedAt: "2025-12-15T22:00:00.000Z" },
        { conId: "649180695", count: 375, firstBucketStart: "2025-12-15T23:00:00.000Z", firstCompletedAt: "2025-12-16T03:00:00.000Z", lastBucketStart: "2026-03-16T18:00:00.000Z", lastCompletedAt: "2026-03-16T21:00:00.000Z" },
        { conId: "649180678", count: 387, firstBucketStart: "2026-03-16T22:00:00.000Z", firstCompletedAt: "2026-03-17T02:00:00.000Z", lastBucketStart: "2026-06-15T18:00:00.000Z", lastCompletedAt: "2026-06-15T21:00:00.000Z" },
        { conId: "649180671", count: 328, firstBucketStart: "2026-06-15T22:00:00.000Z", firstCompletedAt: "2026-06-16T02:00:00.000Z", lastBucketStart: "2026-08-31T18:00:00.000Z", lastCompletedAt: "2026-08-31T21:00:00.000Z" },
      ],
    },
    {
      timeframe: "12h", count: 618,
      sha256: "70e1c9370e78841a1f4ac26c54d2158541e0e7ffb79161ba6433462a35636dc8",
      contracts: [
        { conId: "637533641", count: 122, firstBucketStart: "2025-06-22T22:00:00.000Z", firstCompletedAt: "2025-06-23T10:00:00.000Z", lastBucketStart: "2025-09-15T10:00:00.000Z", lastCompletedAt: "2025-09-15T21:00:00.000Z" },
        { conId: "495512563", count: 130, firstBucketStart: "2025-09-15T22:00:00.000Z", firstCompletedAt: "2025-09-16T10:00:00.000Z", lastBucketStart: "2025-12-15T11:00:00.000Z", lastCompletedAt: "2025-12-15T22:00:00.000Z" },
        { conId: "649180695", count: 126, firstBucketStart: "2025-12-15T23:00:00.000Z", firstCompletedAt: "2025-12-16T11:00:00.000Z", lastBucketStart: "2026-03-16T10:00:00.000Z", lastCompletedAt: "2026-03-16T21:00:00.000Z" },
        { conId: "649180678", count: 130, firstBucketStart: "2026-03-16T22:00:00.000Z", firstCompletedAt: "2026-03-17T10:00:00.000Z", lastBucketStart: "2026-06-15T10:00:00.000Z", lastCompletedAt: "2026-06-15T21:00:00.000Z" },
        { conId: "649180671", count: 110, firstBucketStart: "2026-06-15T22:00:00.000Z", firstCompletedAt: "2026-06-16T10:00:00.000Z", lastBucketStart: "2026-08-31T10:00:00.000Z", lastCompletedAt: "2026-08-31T21:00:00.000Z" },
      ],
    },
    {
      timeframe: "1d", count: 309,
      sha256: "c14c10db80fadf4f9b961b639498d9ac929a8b622decd502b67a68168c978ab9",
      contracts: [
        { conId: "637533641", count: 61, firstBucketStart: "2025-06-22T22:00:00.000Z", firstCompletedAt: "2025-06-23T21:00:00.000Z", lastBucketStart: "2025-09-14T22:00:00.000Z", lastCompletedAt: "2025-09-15T21:00:00.000Z" },
        { conId: "495512563", count: 65, firstBucketStart: "2025-09-15T22:00:00.000Z", firstCompletedAt: "2025-09-16T21:00:00.000Z", lastBucketStart: "2025-12-14T23:00:00.000Z", lastCompletedAt: "2025-12-15T22:00:00.000Z" },
        { conId: "649180695", count: 63, firstBucketStart: "2025-12-15T23:00:00.000Z", firstCompletedAt: "2025-12-16T22:00:00.000Z", lastBucketStart: "2026-03-15T22:00:00.000Z", lastCompletedAt: "2026-03-16T21:00:00.000Z" },
        { conId: "649180678", count: 65, firstBucketStart: "2026-03-16T22:00:00.000Z", firstCompletedAt: "2026-03-17T21:00:00.000Z", lastBucketStart: "2026-06-14T22:00:00.000Z", lastCompletedAt: "2026-06-15T21:00:00.000Z" },
        { conId: "649180671", count: 55, firstBucketStart: "2026-06-15T22:00:00.000Z", firstCompletedAt: "2026-06-16T21:00:00.000Z", lastBucketStart: "2026-08-30T22:00:00.000Z", lastCompletedAt: "2026-08-31T21:00:00.000Z" },
      ],
    },
    {
      timeframe: "1w", count: 66,
      sha256: "5b9ca2e97fb115e4332b3733451a86e32cf9e95e3fede63cde301543db359cde",
      contracts: [
        { conId: "637533641", count: 13, firstBucketStart: "2025-06-22T22:00:00.000Z", firstCompletedAt: "2025-06-27T21:00:00.000Z", lastBucketStart: "2025-09-14T22:00:00.000Z", lastCompletedAt: "2025-09-19T21:00:00.000Z" },
        { conId: "495512563", count: 14, firstBucketStart: "2025-09-15T22:00:00.000Z", firstCompletedAt: "2025-09-19T21:00:00.000Z", lastBucketStart: "2025-12-14T23:00:00.000Z", lastCompletedAt: "2025-12-19T22:00:00.000Z" },
        { conId: "649180695", count: 14, firstBucketStart: "2025-12-15T23:00:00.000Z", firstCompletedAt: "2025-12-19T22:00:00.000Z", lastBucketStart: "2026-03-15T22:00:00.000Z", lastCompletedAt: "2026-03-20T21:00:00.000Z" },
        { conId: "649180678", count: 14, firstBucketStart: "2026-03-16T22:00:00.000Z", firstCompletedAt: "2026-03-20T21:00:00.000Z", lastBucketStart: "2026-06-14T22:00:00.000Z", lastCompletedAt: "2026-06-19T17:00:00.000Z" },
        { conId: "649180671", count: 11, firstBucketStart: "2026-06-15T22:00:00.000Z", firstCompletedAt: "2026-06-19T17:00:00.000Z", lastBucketStart: "2026-08-23T22:00:00.000Z", lastCompletedAt: "2026-08-28T21:00:00.000Z" },
      ],
    },
  ],
} satisfies ResearchActiveProjectionEvidence);

export const REGISTERED_ES_V2_EXPERIMENT_SPEC = Object.freeze({
  ...REGISTERED_ES_EXPERIMENT_SPEC,
  schemaVersion: "pr15.5d1-es-experiment-v1",
  experimentId: RESEARCH_ES_V2_EXPERIMENT_ID,
  projection: REGISTERED_ES_V2_PROJECTION,
  higherTimeframePolicyVersion: "research-cme-active-contract-aggregate-v1",
} as const);

export const RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256 = sha256(
  canonicalJson(REGISTERED_ES_V2_EXPERIMENT_SPEC),
);

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const requestSchema = z.object({
  experimentId: z.literal(RESEARCH_ES_V2_EXPERIMENT_ID),
  specificationSha256: z.literal(RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256),
  implementationCommitSha: sha,
  provenanceId: z.literal(RESEARCH_ES_PROVENANCE_ID),
  datasetFingerprint: z.literal(RESEARCH_ES_DATASET_FINGERPRINT),
}).strict();

export type ResearchEsV2RunRequest = z.infer<typeof requestSchema>;

export function parseResearchEsV2RunRequest(
  input: unknown,
  expectedImplementationCommitSha?: string,
): ResearchEsV2RunRequest {
  const request = requestSchema.parse(input);
  if (expectedImplementationCommitSha && request.implementationCommitSha !== expectedImplementationCommitSha)
    throw new Error("Research v2 implementation commit does not match the running build");
  return Object.freeze(request);
}

export interface ResearchExperimentV2Evidence {
  experimentId: typeof RESEARCH_ES_V2_EXPERIMENT_ID;
  specificationSha256: typeof RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256;
  implementationCommitSha: string;
  projection: ResearchActiveProjectionEvidence;
  reproducible: boolean;
  evidenceErrors: readonly string[];
  primary: ResearchScenarioMetrics;
  stress: ResearchScenarioMetrics;
}

function evaluateV2(input: ResearchExperimentV2Evidence): ReturnType<typeof evaluateResearchExperiment> {
  return evaluateResearchExperiment(input as unknown as ResearchExperimentEvidence);
}

export function canonicalResearchV2Result(input: ResearchExperimentV2Evidence): string {
  const evaluated = evaluateV2(input);
  return canonicalJson({
    schemaVersion: "pr15.5d1-es-result-v1",
    experimentId: input.experimentId,
    specificationSha256: input.specificationSha256,
    implementationCommitSha: input.implementationCommitSha,
    dataset: REGISTERED_ES_V2_EXPERIMENT_SPEC.dataset,
    projection: input.projection,
    reproducible: input.reproducible,
    evidenceErrors: [...input.evidenceErrors],
    primary: input.primary,
    stress: input.stress,
    gates: evaluated.gates,
    verdict: evaluated.verdict,
  });
}

export function researchV2ResultSha256(input: ResearchExperimentV2Evidence): string {
  return sha256(canonicalResearchV2Result(input));
}

export function canonicalResearchV2FailureResult(
  request: ResearchEsV2RunRequest,
  evidenceErrors: readonly string[],
): string {
  return canonicalJson({
    schemaVersion: "pr15.5d1-es-result-v1",
    experimentId: request.experimentId,
    specificationSha256: request.specificationSha256,
    implementationCommitSha: request.implementationCommitSha,
    dataset: REGISTERED_ES_V2_EXPERIMENT_SPEC.dataset,
    projection: REGISTERED_ES_V2_PROJECTION,
    reproducible: false,
    evidenceErrors: [...evidenceErrors],
    verdict: "INCONCLUSIVE" satisfies ResearchExperimentVerdict,
  });
}

export function researchV2FailureResultSha256(
  request: ResearchEsV2RunRequest,
  evidenceErrors: readonly string[],
): string {
  return sha256(canonicalResearchV2FailureResult(request, evidenceErrors));
}
