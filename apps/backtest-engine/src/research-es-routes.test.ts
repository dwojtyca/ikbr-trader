import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { BacktestRepository } from "./repository.js";
import { installResearchEsRoutes } from "./research-es-routes.js";
import {
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_EXPERIMENT_ID,
  RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  RESEARCH_ES_PROVENANCE_ID,
} from "./research-run-request.js";

const implementationCommitSha = "a".repeat(40);
const request = {
  experimentId: RESEARCH_ES_EXPERIMENT_ID,
  specificationSha256: RESEARCH_ES_EXPERIMENT_SPEC_SHA256,
  implementationCommitSha,
  provenanceId: RESEARCH_ES_PROVENANCE_ID,
  datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
};
const identity = {
  datasetId: 7, provenanceId: RESEARCH_ES_PROVENANCE_ID,
  fingerprint: RESEARCH_ES_DATASET_FINGERPRINT, candlesCount: 1,
  manifest: {},
} as any;

function fakeRepository(options: {
  exists?: boolean;
  artifact?: unknown;
  claim?: () => boolean;
  recoverRequest?: unknown;
  onRecoveredArtifact?: (artifact: { result: Record<string, unknown>; resultSha256: string }) => void;
} = {}) {
  let closes = 0;
  const repository = {
    async init() {},
    async claimResearchExperiment() { return options.claim?.() ?? !(options.exists ?? false); },
    async recoverAbandonedResearchExperiment(
      _experimentId: string,
      buildArtifact: (request: unknown) => { result: Record<string, unknown>; resultSha256: string },
    ) {
      if (!options.recoverRequest) return false;
      options.onRecoveredArtifact?.(buildArtifact(options.recoverRequest));
      return true;
    },
    async researchExperimentExists() { return options.exists ?? false; },
    async getResearchExperimentResult() { return options.artifact ?? null; },
    async close() { closes += 1; },
  } as unknown as BacktestRepository;
  return { repository, closes: () => closes };
}

describe("PR15.5D dedicated HTTP routes", () => {
  it("skips recovery without touching the repository when the research database is absent", async () => {
    const app = Fastify({ logger: false });
    const routes = installResearchEsRoutes(app, {
      implementationCommitSha: "",
      researchDatabaseUrl: "missing-research-database",
      researchDatabaseExists: async () => false,
      loadDataset: async () => { throw new Error("must not load"); },
      repositoryFactory: () => { throw new Error("must not connect"); },
      runExperiment: async () => undefined,
    });
    assert.equal(await routes.recoverAbandonedAttempt(), false);
    await app.close();
  });

  it("fails closed without implementation identity and rejects malformed requests", async () => {
    const app = Fastify({ logger: false });
    installResearchEsRoutes(app, {
      implementationCommitSha: "", researchDatabaseUrl: "fixture",
      researchDatabaseExists: async () => true,
      loadDataset: async () => identity,
      repositoryFactory: () => fakeRepository().repository,
      runExperiment: async () => undefined,
    });
    assert.equal((await app.inject({ method: "POST", url: "/backtest/research/es-compatibility", payload: request })).statusCode, 503);
    await app.close();

    const validating = Fastify({ logger: false });
    installResearchEsRoutes(validating, {
      implementationCommitSha, researchDatabaseUrl: "fixture",
      researchDatabaseExists: async () => true,
      loadDataset: async () => identity,
      repositoryFactory: () => fakeRepository().repository,
      runExperiment: async () => undefined,
    });
    assert.equal((await validating.inject({ method: "POST", url: "/backtest/research/es-compatibility", payload: { ...request, extra: true } })).statusCode, 400);
    await validating.close();
  });

  it("accepts one exact request and rejects a concurrent duplicate before another load", async () => {
    const app = Fastify({ logger: false });
    let loads = 0;
    let runs = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const repo = fakeRepository();
    installResearchEsRoutes(app, {
      implementationCommitSha, researchDatabaseUrl: "fixture",
      researchDatabaseExists: async () => true,
      loadDataset: async () => { loads += 1; return identity; },
      repositoryFactory: () => repo.repository,
      runExperiment: async () => { runs += 1; await blocked; },
    });
    const accepted = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility", payload: request });
    assert.equal(accepted.statusCode, 202);
    const duplicate = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility", payload: request });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, "research_experiment_running");
    assert.equal(loads, 1);
    assert.equal(runs, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(repo.closes(), 1);
    await app.close();
  });

  it("rejects a durable prior attempt and exposes its terminal artifact", async () => {
    const artifact = { result: { verdict: "INCONCLUSIVE" }, resultSha256: "f".repeat(64) };
    const app = Fastify({ logger: false });
    const repositories: ReturnType<typeof fakeRepository>[] = [];
    installResearchEsRoutes(app, {
      implementationCommitSha, researchDatabaseUrl: "fixture",
      researchDatabaseExists: async () => true,
      loadDataset: async () => identity,
      repositoryFactory: () => {
        const value = fakeRepository({ exists: true, artifact });
        repositories.push(value);
        return value.repository;
      },
      runExperiment: async () => { throw new Error("must not run"); },
    });
    const response = await app.inject({ method: "POST", url: "/backtest/research/es-compatibility", payload: request });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "research_experiment_already_started");
    const report = await app.inject({ method: "GET", url: "/backtest/research/es-compatibility" });
    assert.deepEqual(report.json().artifact, artifact);
    assert.equal(repositories.every((value) => value.closes() === 1), true);
    await app.close();
  });

  it("atomically accepts only one of two independent route instances", async () => {
    let claimed = false;
    let runs = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const claim = () => {
      if (claimed) return false;
      claimed = true;
      return true;
    };
    const createApp = () => {
      const app = Fastify({ logger: false });
      installResearchEsRoutes(app, {
        implementationCommitSha, researchDatabaseUrl: "fixture",
        researchDatabaseExists: async () => true,
        loadDataset: async () => identity,
        repositoryFactory: () => fakeRepository({ claim }).repository,
        runExperiment: async () => { runs += 1; await blocked; },
      });
      return app;
    };
    const first = createApp();
    const second = createApp();
    const responses = await Promise.all([
      first.inject({ method: "POST", url: "/backtest/research/es-compatibility", payload: request }),
      second.inject({ method: "POST", url: "/backtest/research/es-compatibility", payload: request }),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [202, 409]);
    assert.equal(runs, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([first.close(), second.close()]);
  });

  it("recovers with the persisted implementation identity, not the current build", async () => {
    const persistedSha = "b".repeat(40);
    let recoveredArtifact: { result: Record<string, unknown>; resultSha256: string } | undefined;
    const app = Fastify({ logger: false });
    const routes = installResearchEsRoutes(app, {
      implementationCommitSha,
      researchDatabaseUrl: "fixture",
      researchDatabaseExists: async () => true,
      loadDataset: async () => identity,
      repositoryFactory: () => fakeRepository({
        recoverRequest: { ...request, implementationCommitSha: persistedSha },
        onRecoveredArtifact: (artifact) => { recoveredArtifact = artifact; },
      }).repository,
      runExperiment: async () => undefined,
    });
    assert.equal(await routes.recoverAbandonedAttempt(), true);
    assert.equal(recoveredArtifact?.result.implementationCommitSha, persistedSha);
    assert.notEqual(recoveredArtifact?.result.implementationCommitSha, implementationCommitSha);
    assert.equal(recoveredArtifact?.result.verdict, "INCONCLUSIVE");
    await app.close();
  });
});
