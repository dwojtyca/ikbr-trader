import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { BacktestRepository } from "./repository.js";
import { installResearchEsV2Routes } from "./research-es-v2-routes.js";
import { REGISTERED_ES_V2_PROJECTION, RESEARCH_ES_V2_EXPERIMENT_ID,
  RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256 } from "./research-v2-run-request.js";
import { RESEARCH_ES_DATASET_FINGERPRINT, RESEARCH_ES_PROVENANCE_ID } from "./research-run-request.js";

const implementationCommitSha = "a".repeat(40);
const request = { experimentId: RESEARCH_ES_V2_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_V2_EXPERIMENT_SPEC_SHA256,
  implementationCommitSha, provenanceId: RESEARCH_ES_PROVENANCE_ID,
  datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT } as const;
const identity = { datasetId: 7, provenanceId: RESEARCH_ES_PROVENANCE_ID,
  fingerprint: RESEARCH_ES_DATASET_FINGERPRINT, candlesCount: 423_300,
  manifest: {} } as any;
const projection = { evidence: REGISTERED_ES_V2_PROJECTION,
  data: { candleCount1m: 423_300 } } as any;

function repository(claim = true) {
  let claims = 0;
  const value = { async init() {}, async close() {},
    async claimResearchExperiment(id: string) {
      claims += 1; assert.equal(id, RESEARCH_ES_V2_EXPERIMENT_ID); return claim;
    },
    async getResearchExperimentResult() { return null; },
    async recoverAbandonedResearchExperiment() { return false; },
  } as unknown as BacktestRepository;
  return { value, claims: () => claims };
}

describe("PR15.5D.1 dedicated routes", () => {
  it("rejects malformed input before projection and projection mismatch before claim", async () => {
    const app = Fastify({ logger: false });
    const repo = repository();
    let loads = 0;
    installResearchEsV2Routes(app, { implementationCommitSha, researchDatabaseUrl: "fixture",
      researchDatabaseExists: async () => true,
      loadDataset: async () => { loads += 1; return identity; },
      loadProjection: async () => { throw new Error("projection mismatch"); },
      repositoryFactory: () => repo.value,
      runExperiment: async () => { throw new Error("must not run"); },
    });
    assert.equal((await app.inject({ method: "POST", url: "/backtest/research/es-compatibility-v2",
      payload: { ...request, extra: true } })).statusCode, 400);
    assert.equal(loads, 0);
    const mismatch = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility-v2", payload: request });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(repo.claims(), 0);
    await app.close();
  });

  it("passes the same verified projection into one accepted execution", async () => {
    const app = Fastify({ logger: false });
    const repo = repository();
    let runs = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    installResearchEsV2Routes(app, { implementationCommitSha, researchDatabaseUrl: "fixture",
      researchDatabaseExists: async () => true, loadDataset: async () => identity,
      loadProjection: async () => projection, repositoryFactory: () => repo.value,
      runExperiment: async (dependencies) => {
        runs += 1; assert.equal(dependencies.projection, projection); await blocked;
      },
    });
    const accepted = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility-v2", payload: request });
    assert.equal(accepted.statusCode, 202);
    const duplicate = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility-v2", payload: request });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(repo.claims(), 1);
    assert.equal(runs, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await app.close();
  });

  it("recovers only the v2 experiment identity", async () => {
    let recoveredId = "";
    const app = Fastify({ logger: false });
    const routes = installResearchEsV2Routes(app, { implementationCommitSha,
      researchDatabaseUrl: "fixture", researchDatabaseExists: async () => true,
      loadDataset: async () => identity, loadProjection: async () => projection,
      repositoryFactory: () => ({ async init() {}, async close() {},
        async recoverAbandonedResearchExperiment(id: string) { recoveredId = id; return false; },
      } as unknown as BacktestRepository), runExperiment: async () => undefined,
    });
    assert.equal(await routes.recoverAbandonedAttempt(), false);
    assert.equal(recoveredId, RESEARCH_ES_V2_EXPERIMENT_ID);
    await app.close();
  });
});
