import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  researchFailureResultSha256,
  RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_PROVENANCE_ID,
} from "./research-run-request.js";
import {
  REGISTERED_ES_V2_EXPERIMENT_SPEC,
  REGISTERED_ES_V2_PROJECTION,
  RESEARCH_ES_V2_EXPERIMENT_ID,
  RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
  parseResearchEsV2RunRequest,
} from "./research-v2-run-request.js";

const implementationCommitSha = "a".repeat(40);
const request = {
  experimentId: RESEARCH_ES_V2_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
  implementationCommitSha,
  provenanceId: RESEARCH_ES_PROVENANCE_ID,
  datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
} as const;

describe("PR15.5D.1 pure research boundary", () => {
  it("preserves v1 identity and freezes the complete v2 projection", () => {
    assert.equal(RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
      "4afee9646d4f8aea18f35effca741c2cc80c82195b5519f6a88161077a65dff6");
    assert.equal(RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
      "22ae7af844f549d06d3eaa64715556ca028d1dee69cbd35254f55e48d82ff85e");
    assert.notEqual(RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256, RESEARCH_ES_EXPERIMENT_SPEC_SHA256);
    assert.equal(researchFailureResultSha256({
      experimentId: "pr15.5d-es-momentum-breakout-long-v1",
      specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
      implementationCommitSha: "d833146b4a16228d364b082193b7d7ddd891f7ad",
      provenanceId: RESEARCH_ES_PROVENANCE_ID,
      datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
    }, ["experiment_execution_failed:Error"]),
    "efedef18335d2e471023879ea4ffe968a833928f840883f658274c2c30808a45");
    assert.equal(REGISTERED_ES_V2_PROJECTION.selectedRows, 423_300);
    assert.equal(REGISTERED_ES_V2_PROJECTION.higherTimeframes.length, 6);
    assert.deepEqual(REGISTERED_ES_V2_PROJECTION.higherTimeframes.map((value) =>
      [value.timeframe, value.count]), [
      ["5m", 84_672], ["1h", 7_059], ["4h", 1_841],
      ["12h", 618], ["1d", 309], ["1w", 66],
    ]);
  });

  it("accepts exactly one v2 request identity", () => {
    assert.deepEqual(parseResearchEsV2RunRequest(request, implementationCommitSha), request);
    for (const field of ["experimentId", "specificationSha256", "provenanceId", "datasetFingerprint"] as const)
      assert.throws(() => parseResearchEsV2RunRequest({ ...request, [field]: "wrong" }), /Invalid/);
    assert.throws(() => parseResearchEsV2RunRequest({ ...request, extra: true }), /unrecognized/i);
    assert.throws(() => parseResearchEsV2RunRequest(request, "b".repeat(40)), /running build/);
  });

  it("keeps every economic input and gate inherited from v1", () => {
    const { schemaVersion: _schema, experimentId: _id, projection: _projection,
      higherTimeframePolicyVersion: _policy, ...economic } = REGISTERED_ES_V2_EXPERIMENT_SPEC;
    assert.equal(economic.strategy.id, "momentum_breakout_long_v1");
    assert.equal(economic.execution.scenarios[0].commissionPerContractPerSide, 2.5);
    assert.equal(economic.execution.scenarios[1].slippageTicks, 2);
    assert.equal(economic.acceptance.minimumClosedTrades, 30);
    assert.equal(economic.acceptance.primaryMinimumProfitFactor, 1.2);
  });
});
