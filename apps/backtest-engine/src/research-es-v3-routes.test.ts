import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { BacktestRepository } from "./repository.js";
import { installResearchEsV3Routes } from "./research-es-v3-routes.js";
import { RESEARCH_ES_DATASET_FINGERPRINT, RESEARCH_ES_PROVENANCE_ID } from "./research-run-request.js";
import { REGISTERED_ES_V2_PROJECTION } from "./research-v2-run-request.js";
import { RESEARCH_ES_V3_EXPERIMENT_ID, RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256 } from "./research-v3-run-request.js";

const sha = "a".repeat(40);
const request = { experimentId: RESEARCH_ES_V3_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_V3_EXPERIMENT_SPEC_SHA256, implementationCommitSha: sha,
  provenanceId: RESEARCH_ES_PROVENANCE_ID, datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT } as const;
const identity = { datasetId: 7, provenanceId: RESEARCH_ES_PROVENANCE_ID,
  fingerprint: RESEARCH_ES_DATASET_FINGERPRINT, candlesCount: 423_300, manifest: {} } as any;
const projection = { evidence: REGISTERED_ES_V2_PROJECTION, data: {} } as any;

function dependencies(capacity = { cpus: 3, memoryBytes: 12 * 1024 ** 3 }) {
  let claims = 0;
  const repository = { async init() {}, async close() {}, async claimResearchExperiment() { claims += 1; return true; },
    async getResearchExperimentResult() { return null; }, async recoverAbandonedResearchExperiment() { return false; } } as unknown as BacktestRepository;
  return { value: { implementationCommitSha: sha, researchDatabaseUrl: "fixture", researchDatabaseExists: async () => true,
    runtimeCapacity: async () => capacity, loadDataset: async () => identity, loadProjection: async () => projection,
    repositoryFactory: () => repository, runExperiment: async () => undefined }, claims: () => claims };
}

describe("PR15.5D.3 routes", () => {
  it("rejects insufficient CPU or memory before touching the dataset", async () => {
    for (const capacity of [{ cpus: 2, memoryBytes: 16 * 1024 ** 3 }, { cpus: 8, memoryBytes: 11 * 1024 ** 3 }]) {
      const app = Fastify({ logger: false }); const deps = dependencies(capacity); let loads = 0;
      deps.value.loadDataset = async () => { loads += 1; return identity; };
      installResearchEsV3Routes(app, deps.value);
      const response = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility-v3", payload: request });
      assert.equal(response.statusCode, 503); assert.equal(loads, 0); assert.equal(deps.claims(), 0); await app.close();
    }
  });
  it("accepts exact capacity and exposes three worker states", async () => {
    const app = Fastify({ logger: false }); const deps = dependencies();
    installResearchEsV3Routes(app, deps.value);
    const response = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility-v3", payload: request });
    assert.equal(response.statusCode, 202); assert.equal(response.json().scenarioWorkerCount, 3);
    assert.deepEqual(Object.keys(response.json().workerStates).sort(), ["primary", "primary_reproduction", "stress"]);
    await new Promise((resolve) => setImmediate(resolve)); await app.close();
  });
});
