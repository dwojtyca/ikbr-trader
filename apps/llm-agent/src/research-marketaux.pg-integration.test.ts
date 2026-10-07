import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { ResearchStore, marketauxCallIdentity, marketauxSourceUrl, researchHash, type InstrumentResearchSnapshotV1, type MarketauxRequest } from "@ikbr/shared/instrument-research";
import { loadTradingConfiguration, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { ResearchRefreshScheduler, researchSourceSlot } from "./research-refresh.js";
import { marketauxFixture, marketauxResponse } from "./research-marketaux.testfixture.js";
import { reviewFixture } from "./research-review.testfixture.js";
import { ResearchBoundReviewRepository } from "./research-review-repository.js";
import { buildResearchModelRequest } from "./research-decision.js";
import type { BoundDecision } from "./bound-review-repository.js";

const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (pool: Pool) => Promise<void>) {
  const name = "pp7_e1b_" + randomUUID().replaceAll("-", ""), url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.href }); await admin.query(`CREATE DATABASE ${name}`); url.pathname = "/" + name;
  const pool = new Pool({ connectionString: url.href });
  try {
    const dir = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) await pool.query(readFileSync(new URL(file, dir), "utf8"));
    await run(pool);
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}

async function seed(pool: Pool, expiryMs = 3_600_000, budget = 1000, twoIssuers = false, expiryField: "qualification" | "entitlement" = "entitlement") {
  const now = Date.now(), f = marketauxFixture(now), store = new ResearchStore(pool);
  f.newsConfig[expiryField].expiresAt = new Date(now + expiryMs).toISOString(); f.source.maxRequestsPerDay = budget;
  if (twoIssuers) {
    const index = f.manifest.instruments.findIndex(policy => policy.instrumentId !== f.policy.instrumentId);
    const other = marketauxFixture(now, f.manifest.instruments[index].instrumentId);
    other.newsConfig.entity.symbol = "SECOND_SYNTHETIC"; other.source.urls = [marketauxSourceUrl(other.newsConfig)];
    other.source.maxRequestsPerDay = budget; f.manifest.instruments[index] = other.policy;
  }
  f.manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = f.manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json", TRADING_CONFIG_EXPECTED_HASH: f.configHash },
    { readFile: () => readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8") });
  await new TradingConfigurationStore(pool).register({ service: "execution-engine", processId: randomUUID(), loaded, tradingEnabled: false });
  await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const) await store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: service, tradingEnabled: false });
  await store.storeSnapshot(f.snapshot);
  const skipped = new Set(f.manifest.instruments.flatMap(p => p.sources.filter(s => s.adapter !== "marketaux-news").flatMap(s => s.roles.map(role => "research_slot_" + researchHash({ manifestHash: f.manifestHash, instrumentId: p.instrumentId, sourceId: s.id, role, slot: researchSourceSlot(now, role) })))));
  const requests: MarketauxRequest[] = [];
  let beforeStore: ((snapshot: InstrumentResearchSnapshotV1, deadline?: string) => Promise<void>) | undefined;
  const scheduler = () => new ResearchRefreshScheduler({ manifest: f.manifest, manifestHash: f.manifestHash, accountId: "DU_TEST", marketauxApiKey: "synthetic-secret", store: {
    latestSnapshot: store.latestSnapshot.bind(store), withRefreshLock: store.withRefreshLock.bind(store), reserveCall: store.reserveCall.bind(store), recordCallOutcome: store.recordCallOutcome.bind(store),
    hasRefreshSlot: async key => skipped.has(key) || store.hasRefreshSlot(key),
    storeSnapshot: async (snapshot, slot, deadline) => { await beforeStore?.(snapshot, deadline); return store.storeSnapshot(snapshot, slot, deadline); },
  }, marketauxFetch: async (source, request) => { requests.push(request); return marketauxResponse([{ ...f.article(1), entities: [source.parserConfig.entity] }], request.page, 1); } });
  return { ...f, store, scheduler, requests, beforeStore: (hook: typeof beforeStore) => { beforeStore = hook; } };
}

test("durable refresh lock and reservations publish once across workers and restart", { skip: !connection }, () => isolated(async pool => {
  const f = await seed(pool); await Promise.all([f.scheduler().tick(), f.scheduler().tick()]);
  assert.equal(f.requests.length, 2); await f.scheduler().tick(); assert.equal(f.requests.length, 2);
  const head = (await f.store.latestSnapshot({ configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId }))!;
  assert.equal(head.snapshot.coverage.find(c => c.sourceId === f.source.id)!.status, "AVAILABLE");
  assert.equal((await pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "2");
  assert.equal((await pool.query("SELECT count(*) FROM research_refresh_slots")).rows[0].count, "1");
  const audit = (await pool.query("SELECT * FROM research_call_reservations")).rows;
  assert.ok(!JSON.stringify(audit).includes("synthetic-secret"));
}));

test("PostgreSQL request budget exhaustion retains first call and publishes ineligible ERROR", { skip: !connection }, () => isolated(async pool => {
  const f = await seed(pool, 3_600_000, 1); await f.scheduler().tick();
  assert.equal(f.requests.length, 1);
  const head = (await f.store.latestSnapshot({ configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId }))!;
  assert.equal(head.snapshot.coverage.find(c => c.sourceId === f.source.id)!.status, "ERROR");
  assert.equal((await pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "1");
  await f.scheduler().tick(); assert.equal(f.requests.length, 1);
}));

test("two issuer refreshes share the same durable provider/account budget", { skip: !connection }, () => isolated(async pool => {
  const f = await seed(pool, 3_600_000, 3, true); await f.scheduler().tick();
  assert.equal(f.requests.length, 3);
  assert.equal((await pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "3");
  const states = [];
  for (const policy of f.manifest.instruments.filter(policy => policy.sources.some(source => source.adapter === "marketaux-news"))) {
    const head = await f.store.latestSnapshot({ configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: policy.instrumentId });
    states.push(head!.snapshot.coverage.find(c => c.sourceId === f.source.id)!.status);
  }
  assert.deepEqual(states.sort(), ["AVAILABLE", "ERROR"]);
}));

test("a persisted unknown first-page reservation survives process loss without replay", { skip: !connection }, () => isolated(async pool => {
  const f = await seed(pool), identity = marketauxCallIdentity(f.manifestHash, f.policy.instrumentId, f.source, f.descriptor);
  await f.store.reserveCall({ accountId: "DU_TEST", provider: f.source.provider, kind: "source", configHash: f.configHash, manifestHash: f.manifestHash,
    callKey: identity.callKey, requestHash: identity.requestHash, reservedCostMicros: 1, maxRequestsPerDay: 1000, maxCostMicrosPerDay: 1000, deadlineAt: new Date(Date.now() + 9000).toISOString() });
  await f.store.recordCallOutcome(identity.callKey, "UNKNOWN");
  await f.scheduler().tick(); assert.equal(f.requests.length, 0);
  const head = (await f.store.latestSnapshot({ configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId }))!;
  assert.equal(head.snapshot.coverage.find(c => c.sourceId === f.source.id)!.reason, "RESEARCH_CALL_ALREADY_RESERVED");
  assert.equal((await pool.query("SELECT count(*) FROM research_call_reservations")).rows[0].count, "1");
}));

test("head-lock wait past admission expiry rolls back success then publishes exactly one ERROR without provider retry", { skip: !connection }, () => isolated(async pool => {
  const f = await seed(pool), lock = await pool.connect(); let released = false, publications = 0;
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT * FROM research_snapshot_heads WHERE instrument_id=$1 FOR UPDATE", [f.policy.instrumentId]);
    f.beforeStore(async (_snapshot, deadline) => {
      publications++;
      if (!deadline) return;
      // Shorten only this test's store admission deadline; production supplies the source expiry.
      setTimeout(() => { void lock.query("ROLLBACK").then(() => { released = true; }); }, 100);
    });
    const original = f.store.storeSnapshot.bind(f.store);
    f.store.storeSnapshot = (snapshot, slot, deadline) => original(snapshot, slot, deadline ? new Date(Date.now() + 35).toISOString() : undefined);
    await f.scheduler().tick(); assert.equal(released, true);
    const head = (await f.store.latestSnapshot({ configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId }))!;
    assert.equal(publications, 2); assert.equal(f.requests.length, 2); assert.equal(head.sequence, 2);
    assert.equal(head.snapshot.coverage.find(c => c.sourceId === f.source.id)!.status, "ERROR");
    assert.equal((await pool.query("SELECT count(*) FROM research_snapshots")).rows[0].count, "2");
    assert.equal((await pool.query("SELECT count(*) FROM research_refresh_slots")).rows[0].count, "1");
  } finally { if (!released) await lock.query("ROLLBACK"); lock.release(); }
}));

for (const expiryField of ["qualification", "entitlement"] as const) for (const stage of ["AI finalization", "execution permit"] as const)
test(`${expiryField} expiry fences actual ${stage} with fresh news and readable history`, { skip: !connection }, () => isolated(async pool => {
  const f = await seed(pool, 5000, 1000, false, expiryField); await f.scheduler().tick();
  const r = reviewFixture(f.now), c = r.claim;
  await pool.query(`INSERT INTO proposed_orders(id,instrument,instrument_id,conid,side,position_effect,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,
    client_order_id,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger) VALUES(1,$1,$2,$3,'BUY','OPEN_OR_ADD','LMT',1,100,99,105,'fixture',.8,'PASS','PROPOSED',$4,'fixture',$5,2,$6,$7)`,
    [c.order.instrument,c.identity.instrumentId,c.identity.conid,c.order.strategy,c.identity.clientOrderHash,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger)]);
  await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger)
    VALUES(1,$1,$2,$3,'DU_TEST','session',2,$4,$5)`, [c.identity.clientOrderHash,c.identity.instrumentId,c.identity.conid,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger)]);
  const repo = new ResearchBoundReviewRepository(pool, { manifest: f.manifest, hash: f.manifestHash });
  const claim = (await repo.claim())!, bound = await repo.prepareResearch(claim);
  const expiresAt = f.newsConfig[expiryField].expiresAt;
  assert.equal(bound.eligibility.expiresAt, expiresAt);
  const request = buildResearchModelRequest(claim, bound, r.context);
  const reservation = await repo.reserveModel(claim, request);
  const completedAt = (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now.toISOString();
  const result = { decision: { decision: "EXECUTE" as const, confidence: .8, reason: "Synthetic qualified research", riskFlags: [], evidenceRefs: bound.eligibility.requiredEvidenceRefs }, actualModel: "fixture-model", usage: null };
  await repo.recordModelOutcome(claim, reservation, { kind: "COMPLETED", completedAt, result });
  const decision: BoundDecision = { ...result.decision, model: request.model, actualModel: result.actualModel, promptVersion: request.promptVersion, outputSchemaVersion: request.outputSchemaVersion,
    context: request.context, contextHash: reservation.requestHash, research: bound.binding,
    timings: { startedAt: reservation.startedAt, completedAt, latencyMs: Date.parse(completedAt) - Date.parse(reservation.startedAt), outcome: "COMPLETED" } };
  let checkExecution: (() => Promise<{ validUntilMs: number; assertCurrent(): void }>) | undefined;
  let permit: { validUntilMs: number; assertCurrent(): void } | undefined;
  if (stage === "execution permit") {
    assert.equal(await repo.finalize(claim, decision), true);
    // Runtime import keeps this cross-service integration fixture outside either service's build inputs.
    const { createResearchEntryValidator } = await import(new URL("../../execution-engine/src/research-entry-guard.ts", import.meta.url).href);
    const validate = createResearchEntryValidator({ store: f.store, loadedIdentity: () => ({ configHash: f.configHash, manifestHash: f.manifestHash }) });
    checkExecution = async () => {
      const db = await pool.connect();
      try { await db.query("BEGIN"); const checked = await validate({ db, order: claim.order, clientOrderHash: claim.identity.clientOrderHash, accountId: "DU_TEST", sessionId: "session" }); await db.query("COMMIT"); return checked; }
      catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
    };
    permit = await checkExecution(); permit.assertCurrent();
    assert.equal(permit.validUntilMs, Date.parse(expiresAt)); assert.ok(Date.now() < permit.validUntilMs);
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 15));
  if (stage === "AI finalization") {
    assert.equal(await repo.finalize(claim, decision), false);
    await assert.rejects(repo.prepareResearch(claim), /RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE/);
    assert.equal((await pool.query("SELECT status FROM proposal_ai_reviews WHERE proposed_order_id=1")).rows[0].status, "PENDING");
  } else {
    assert.ok(Date.now() >= permit!.validUntilMs);
    await assert.rejects(checkExecution!(), /RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE/);
  }
  await assert.rejects(f.store.validateBinding({ proposalId: 1, clientOrderHash: claim.identity.clientOrderHash, instrumentId: f.policy.instrumentId, configHash: f.configHash, manifestHash: f.manifestHash }), /RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE/);
  assert.ok(await f.store.readSnapshot(bound.binding.snapshotId));
  assert.equal((await pool.query("SELECT count(*) FROM proposal_ai_model_calls")).rows[0].count, "1");
  const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
  assert.ok(now - Date.parse(bound.stored.snapshot.coverage.find(c => c.sourceId === f.source.id)!.checkedAt) < 1800000);
  assert.equal((await pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=1")).rows[0].execution_attempted_at, null);
}));
