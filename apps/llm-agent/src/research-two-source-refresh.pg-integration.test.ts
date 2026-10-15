import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { twoSourceResearchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { ResearchStore, ResearchSourceFailure, researchHash, type MarketauxRequest } from "@ikbr/shared/instrument-research";
import { loadTradingConfiguration, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { ResearchRefreshScheduler } from "./research-refresh.js";
import { marketauxResponse } from "./research-marketaux.testfixture.js";

const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (pool: Pool) => Promise<void>) {
  const name = "two_source_app_" + randomUUID().replaceAll("-", ""), url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.href }); await admin.query(`CREATE DATABASE ${name}`); url.pathname = "/" + name;
  const pool = new Pool({ connectionString: url.href });
  try {
    const dir = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) await pool.query(readFileSync(new URL(file, dir), "utf8"));
    await run(pool);
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}

async function seed(pool: Pool) {
  const f = twoSourceResearchFixture(), store = new ResearchStore(pool);
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json", TRADING_CONFIG_EXPECTED_HASH: f.configHash },
    { readFile: () => readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8") });
  await new TradingConfigurationStore(pool).register({ service: "execution-engine", processId: randomUUID(), loaded, tradingEnabled: false });
  await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const)
    await store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: service, tradingEnabled: false });
  // Only WSH consults this scheduler shortcut in v2. Actual Marketaux cadence remains entirely in the real database.
  store.hasRefreshSlot = async () => true;
  const requests: MarketauxRequest[] = [];
  const scheduler = (failure?: string) => new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash,
    store, accountId: "DU_SYNTHETIC", marketauxOnDemand: false, marketauxApiKey: "synthetic-secret", now: () => Date.now() + 10 * 86400000,
    marketauxFetch: async (_source, request) => {
      requests.push(request);
      if (failure === "RESEARCH_SOURCE_HTTP_429") throw new ResearchSourceFailure(failure, undefined, {}, { httpStatus: 429 });
      if (failure) throw new Error(failure);
      return marketauxResponse([], request.page, 0);
    } });
  return { f, store, requests, scheduler };
}

test("v2 scheduler and PostgreSQL acquire complete source-only snapshots using DB times once across restart", { skip: !connection }, () => isolated(async pool => {
  const s = await seed(pool);
  await Promise.all([s.scheduler().tick(), s.scheduler().tick()]);
  const expected = s.f.manifest.instruments.length * 2;
  assert.equal(s.requests.length, expected);
  await s.scheduler().tick(); assert.equal(s.requests.length, expected);
  for (const policy of s.f.manifest.instruments) {
    const head = await s.store.latestSnapshot({ configHash: s.f.configHash, manifestHash: s.f.manifestHash, instrumentId: policy.instrumentId });
    assert.ok(head); assert.equal("reports" in head.snapshot, false); assert.equal("facts" in head.snapshot, false);
    assert.equal(head.snapshot.coverage.length, 1);
    const coverage = head.snapshot.coverage[0];
    assert.ok("acquisition" in coverage && coverage.acquisition?.kind === "marketaux-news-v2");
    assert.equal(coverage.status, "EMPTY"); assert.equal(coverage.complete, true);
    assert.equal(coverage.checkedAt, coverage.acquisition.completedAt);
    assert.ok(Math.abs(Date.parse(coverage.checkedAt) - Date.now()) < 10000);
    assert.equal(coverage.acquisition.sourceHash, researchHash(policy.sources.find(source => source.adapter === "marketaux-news")));
    assert.notEqual(coverage.checkedAt, coverage.windowEnd);
  }
  const calls = (await pool.query("SELECT * FROM research_call_reservations")).rows;
  assert.equal(calls.length, expected); assert.ok(!JSON.stringify(calls).includes("synthetic-secret"));
}));

test("v2 scheduler and PostgreSQL persist known and unknown first-call failures without retry or false cache", { skip: !connection }, async () => {
  for (const reason of ["RESEARCH_SOURCE_HTTP_429", "RESEARCH_SOURCE_TIMEOUT"] as const) await isolated(async pool => {
    const s = await seed(pool);
    await s.scheduler(reason).tick();
    assert.equal(s.requests.length, s.f.manifest.instruments.length);
    await s.scheduler().tick(); assert.equal(s.requests.length, s.f.manifest.instruments.length);
    for (const policy of s.f.manifest.instruments) {
      const identity = { configHash: s.f.configHash, manifestHash: s.f.manifestHash, instrumentId: policy.instrumentId, accountId: "DU_SYNTHETIC" };
      const head = await s.store.latestSnapshot(identity);
      if (reason === "RESEARCH_SOURCE_TIMEOUT") {
        assert.equal(head, null);
        const state = await s.store.readMarketauxRefreshState({ ...identity, sourceId: policy.sources.find(source => source.adapter === "marketaux-news")!.id });
        assert.ok(state.holdReasons.includes("RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED"));
        assert.equal(state.latestFailure?.reason, reason); assert.equal(state.lastSuccessfulAt, null);
        assert.equal((await s.store.prepareRepair(identity)).state, "HOLD");
      } else {
        assert.ok(head);
        const coverage = head.snapshot.coverage[0];
        assert.equal(coverage.complete, false); assert.equal(coverage.reason, reason);
        assert.equal("reports" in head.snapshot, false); assert.equal("facts" in head.snapshot, false);
      }
    }
  });
});
