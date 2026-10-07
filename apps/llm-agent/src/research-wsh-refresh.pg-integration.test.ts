import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { ResearchStore, researchHash } from "@ikbr/shared/instrument-research";
import { wshResearchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { loadTradingConfiguration, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { refreshWsh } from "./research-wsh-refresh.js";
import type { WshTransport } from "./research-wsh-transport.js";

const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (pool: Pool) => Promise<void>) {
  const name = "wsh_refresh_" + randomUUID().replaceAll("-", ""), url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.href }); await admin.query(`CREATE DATABASE ${name}`); url.pathname = "/" + name;
  const pool = new Pool({ connectionString: url.href });
  try {
    const dir = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) await pool.query(readFileSync(new URL(file, dir), "utf8"));
    await run(pool);
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function seed(pool: Pool) {
  const f = wshResearchFixture(), store = new ResearchStore(pool);
  const metadata = JSON.stringify({ meta_data: { event_types: [] } });
  (f.source.parserConfig.qualification as Record<string, unknown>).metadataHash = createHash("sha256").update(metadata).digest("hex");
  const manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json", TRADING_CONFIG_EXPECTED_HASH: f.configHash },
    { readFile: () => readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8") });
  await new TradingConfigurationStore(pool).register({ service: "execution-engine", processId: randomUUID(), loaded, tradingEnabled: false });
  await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const) await store.observe({ configHash: f.configHash, manifestHash, service, processId: service, tradingEnabled: false });
  const prior = await store.storeSnapshot(f.snapshot);
  const identity = { configHash: f.configHash, manifestHash, instrumentId: f.policy.instrumentId };
  let calls = 0, failEvent = false, rows: unknown[] = [];
  const createTransport = (): WshTransport => ({ sessionId: randomUUID(), serverVersion: 180, sdkVersion: "1.6.10", connect: async () => {}, close: () => {},
    metadata: async () => {
      calls++;
      assert.equal((await pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "1");
      return metadata;
    },
    events: async () => {
      calls++;
      assert.equal((await pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "2");
      assert.deepEqual((await pool.query("SELECT outcome FROM research_call_outcomes")).rows.map(r => r.outcome), ["SUCCEEDED"]);
      assert.equal((await store.latestSnapshot(identity))?.id, prior.id);
      if (failEvent) throw new Error("RESEARCH_WSH_TIMEOUT");
      return JSON.stringify(rows);
    },
  });
  const options = { manifest: f.manifest, manifestHash, accountId: "DU_TEST", policy: f.policy, source: f.source, store, slotKey: "wsh-fixture-slot",
    wsh: { runtime: { enabled: true, endpointId: "fixture-endpoint", host: "127.0.0.1", port: 4002, clientId: 77 }, createTransport } };
  return { f, store, prior, identity, options, get calls() { return calls; }, fail: () => { failEvent = true; }, available: () => {
    rows = [{ event_key: "new-type-1", event_type: "fixture-new-type", conids: [String(f.policy.listing.conId)], data: { company: { isin: f.source.issuerIdentifier.value }, forecast: "NOT_PROVIDED" } }];
  } };
}

test("WSH real store atomically publishes observations/outcomes and resolves a lost success COMMIT reply", { skip: !connection }, () => isolated(async pool => {
  const h = await seed(pool); h.available();
  const publish = h.store.publishWshSnapshot.bind(h.store);
  h.store.publishWshSnapshot = async (...args) => { await publish(...args); throw new Error("synthetic lost COMMIT reply"); };
  await h.store.withRefreshLock(h.identity, async () => { assert.equal(await refreshWsh(h.options), true); });
  assert.equal(h.calls, 2);
  const head = await h.store.latestSnapshot(h.identity); assert.ok(head); assert.notEqual(head.id, h.prior.id);
  assert.equal(head.snapshot.events.length, 1);
  const evidence = head.snapshot.evidence.find(e => e.published === null)!; assert.equal(evidence.published, null);
  if (evidence.published !== null) throw new Error("expected prospective evidence");
  const observation = (await pool.query("SELECT first_observed_at FROM research_wsh_first_observations")).rows[0];
  assert.equal(evidence.firstObservedAt, new Date(observation.first_observed_at).toISOString());
  assert.deepEqual((await pool.query("SELECT outcome FROM research_call_outcomes ORDER BY call_key")).rows.map(r => r.outcome), ["SUCCEEDED", "SUCCEEDED"]);
  assert.equal((await pool.query("SELECT state FROM research_wsh_acquisitions")).rows[0].state, "PUBLISHED");
  await h.store.storeSnapshot({ ...head.snapshot, createdAt: new Date().toISOString() });
  assert.deepEqual((await h.store.readSnapshot(h.prior.id))?.snapshot, h.prior.snapshot);
}));

test("WSH failed negative persistence preserves original head; restart retires the read without replay", { skip: !connection }, () => isolated(async pool => {
  const h = await seed(pool); h.fail();
  h.store.finishWshFailure = async () => { throw new Error("synthetic negative persistence failure"); };
  await assert.rejects(h.store.withRefreshLock(h.identity, () => refreshWsh(h.options).then(() => {})), /synthetic negative persistence failure/);
  assert.deepEqual(await h.store.latestSnapshot(h.identity), h.prior);
  assert.equal((await pool.query("SELECT state FROM research_wsh_acquisitions")).rows[0].state, "PENDING");
  const restarted = new ResearchStore(pool);
  await restarted.withRefreshLock(h.identity, () => refreshWsh({ ...h.options, store: restarted }).then(() => {}));
  assert.equal(h.calls, 2);
  const head = await restarted.latestSnapshot(h.identity);
  assert.equal(head?.snapshot.coverage.find(c => c.sourceId === h.f.source.id)?.reason, "RESEARCH_WSH_ABANDONED_ACQUISITION");
  assert.deepEqual((await pool.query("SELECT outcome FROM research_call_outcomes ORDER BY outcome")).rows.map(r => r.outcome), ["SUCCEEDED", "UNKNOWN"]);
  assert.equal((await pool.query("SELECT state FROM research_wsh_acquisitions")).rows[0].state, "UNKNOWN");
  assert.equal((await pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "2");
}));
