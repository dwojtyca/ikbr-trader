import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESEARCH_ES_DATASET_FINGERPRINT, RESEARCH_ES_PROVENANCE_ID } from "./research-run-request.js";
import { RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256 } from "./research-v2-run-request.js";
import { REGISTERED_ES_V3_EXPERIMENT_SPEC, RESEARCH_ES_V3_EXPERIMENT_ID,
  RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256, parseResearchEsV3RunRequest } from "./research-v3-run-request.js";

const implementationCommitSha = "a".repeat(40);
const request = { experimentId: RESEARCH_ES_V3_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256, implementationCommitSha,
  provenanceId: RESEARCH_ES_PROVENANCE_ID, datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT } as const;

describe("PR15.5D.3 parallel research boundary", () => {
  it("freezes exactly three isolated scenario workers while preserving v2 economics", () => {
    assert.equal(RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256,
      "adcb1c2e3821e56a8b8245992f6ea0b47e736bb0bb05e9fe5514ae861037dfb0");
    assert.notEqual(RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256, RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256);
    assert.equal(REGISTERED_ES_V3_EXPERIMENT_SPEC.scenarioWorkerCount, 3);
    assert.equal(REGISTERED_ES_V3_EXPERIMENT_SPEC.workerMaxOldGenerationMb, 3072);
    assert.equal(REGISTERED_ES_V3_EXPERIMENT_SPEC.execution.scenarios[0].commissionPerContractPerSide, 2.5);
  });
  it("accepts only the frozen v3 identity", () => {
    assert.deepEqual(parseResearchEsV3RunRequest(request, implementationCommitSha), request);
    assert.throws(() => parseResearchEsV3RunRequest({ ...request, extra: true }), /unrecognized/i);
    assert.throws(() => parseResearchEsV3RunRequest(request, "b".repeat(40)), /running build/);
  });
});
