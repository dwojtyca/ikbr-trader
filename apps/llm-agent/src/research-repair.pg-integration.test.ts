import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { Pool } from "pg";
import { ResearchStore, ResearchPreparationNeededError, inspectResearch, researchHash, researchRefreshSlotKey, researchRefreshSlot } from "@ikbr/shared/instrument-research";
import { loadTradingConfiguration, TradingConfigurationStore } from "@ikbr/shared/trading-config";
import { ResearchBoundReviewRepository } from "./research-review-repository.js";
import { BoundReviewWorker } from "./bound-review-worker.js";
import { reviewFixture } from "./research-review.testfixture.js";
import { researchCallKey, researchSourceSlot } from "./research-refresh.js";

const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>, lifetimeMs = 120000) {
  const name = `repair_${randomUUID().replaceAll("-", "")}`, url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() }); await admin.query(`CREATE DATABASE ${name}`); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    const dir = new URL("../../../infra/sql/migrations/", import.meta.url);
    for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) await pool.query(readFileSync(new URL(file, dir), "utf8"));
    await run(await seed(pool, lifetimeMs));
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function seed(pool: Pool, lifetimeMs: number) {
  const now = (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime();
  const f = reviewFixture(now); f.manifest.refreshEnabled = true; f.policy.sources[0].parserConfig = { kind: "sec-json" };
  f.manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = f.manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: "bundle", TRADING_CONFIG_PATH: "/fixture.json", TRADING_CONFIG_EXPECTED_HASH: f.configHash },
    { readFile: () => readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8") });
  await new TradingConfigurationStore(pool).register({ service: "execution-engine", processId: randomUUID(), loaded, tradingEnabled: false });
  const store = new ResearchStore(pool);
  await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const) await store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: service, tradingEnabled: false });
  const missing = structuredClone(f.snapshot); missing.coverage = missing.coverage.filter(c => c.role !== "reports"); missing.evidence = []; missing.reports = []; missing.facts = [];
  await store.storeSnapshot(missing);
  const c = f.claim;
  await pool.query(`INSERT INTO proposed_orders(id,instrument,instrument_id,conid,side,position_effect,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,
    client_order_id,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger) VALUES(1,$1,$2,$3,'BUY','OPEN_OR_ADD','LMT',1,100,99,105,'fixture',.8,'PASS','PROPOSED',$4,
    'fixture',$5,2,$6,$7)`, [c.order.instrument,c.identity.instrumentId,c.identity.conid,c.order.strategy,c.identity.clientOrderHash,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger)]);
  await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger,expires_at)
    VALUES(1,$1,$2,$3,'DU_TEST','session',2,$4,$5,$6)`, [c.identity.clientOrderHash,c.identity.instrumentId,c.identity.conid,JSON.stringify(c.order.strategyAttribution),JSON.stringify(c.order.strategyTrigger),new Date(now + lifetimeMs)]);
  const identity = { accountId: "DU_TEST", instrumentId: f.policy.instrumentId, configHash: f.configHash, manifestHash: f.manifestHash };
  const repo = new ResearchBoundReviewRepository(pool, { manifest: f.manifest, hash: f.manifestHash });
  return { ...f, now, pool, store, repo, identity };
}

test("repair requests deduplicate across processes and remain instrument scoped; ready evidence resolves waiting history", { skip: !connection }, () => isolated(async f => {
  const results = await Promise.all([f.store.prepareRepair(f.identity), new ResearchStore(f.pool).prepareRepair(f.identity)]);
  assert.ok(results.every(r => r.state === "WAITING"));
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM research_repair_requests WHERE state='WAITING'")).rows[0].n, 1);
  assert.equal((await f.store.dueRepairs(f.identity))[0].instrumentId, f.identity.instrumentId);
  const other = f.manifest.instruments.find(p => p.instrumentId !== f.policy.instrumentId)!;
  const otherSnapshot = reviewFixture(f.now, other.instrumentId).snapshot;
  otherSnapshot.manifestHash = f.manifestHash; otherSnapshot.mappingHash = researchHash(other);
  await f.store.storeSnapshot(otherSnapshot);
  assert.equal((await f.store.prepareRepair({ ...f.identity, instrumentId: other.instrumentId })).state, "READY");
  assert.equal((await f.store.dueRepairs(f.identity))[0].instrumentId, f.identity.instrumentId);
  await f.store.storeSnapshot(f.snapshot);
  assert.equal((await f.store.prepareRepair(f.identity)).state, "READY");
  assert.equal((await f.store.dueRepairs(f.identity)).length, 0);
  await assert.rejects(f.pool.query("DELETE FROM research_repair_events"), /RESEARCH_IMMUTABLE/);
}));

test("READY repair rows do not rearm stale coverage after restart without a new preparation request", { skip: !connection }, () => isolated(async f => {
  assert.equal((await f.store.prepareRepair(f.identity)).state, "WAITING");
  const almostStale = structuredClone(f.snapshot), reports = almostStale.coverage.find(c => c.role === "reports")!;
  const staleAt = Date.now() + 2000;
  reports.checkedAt = new Date(staleAt - 86400000).toISOString();
  reports.windowEnd = reports.checkedAt; reports.windowStart = new Date(staleAt - 2 * 86400000).toISOString();
  const stored = await f.store.storeSnapshot(almostStale);
  assert.equal((await f.store.prepareRepair(f.identity)).state, "READY");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, staleAt - Date.now()) + 50));
  assert.equal(inspectResearch(f.manifest, f.identity.instrumentId, stored, Date.now()).state, "WAITING");
  const restarted = new ResearchStore(f.pool);
  assert.deepEqual(await restarted.dueRepairs(f.identity), []);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM research_call_reservations")).rows[0].n, 0);
  assert.equal((await restarted.prepareRepair(f.identity)).state, "WAITING");
  assert.equal((await restarted.dueRepairs(f.identity)).length, 1);
}));

test("prebinding wait releases claim without rejection/model call and fresh head wakes same original-lifetime proposal", { skip: !connection }, () => isolated(async f => {
  const expires = (await f.pool.query("SELECT expires_at FROM proposal_ai_reviews WHERE proposed_order_id=1")).rows[0].expires_at;
  let model = 0, contexts = 0;
  const worker = new BoundReviewWorker({ repository: f.repo, execution: { getAiContext: async () => { contexts++; return f.context; }, executeBoundProposed: async () => "REFUSED" },
    researchDecider: { isConfigured: () => true, decide: async () => { model++; return { decision: { decision: "REJECT", confidence: .5, reason: "fixture rejection", riskFlags: [], evidenceRefs: ["reports"] }, actualModel: "fixture", usage: null }; } }, model: "fixture", promptVersion: "fixture" });
  assert.equal(await worker.pollOnce(), true);
  const row = (await f.pool.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=1")).rows[0];
  assert.equal(row.status, "PENDING"); assert.equal(row.claim_token, null); assert.equal(row.decision_json, null); assert.deepEqual(row.expires_at, expires);
  assert.equal(await worker.pollOnce(), false); assert.equal(contexts, 0); assert.equal(model, 0);
  await f.store.storeSnapshot(f.snapshot);
  const reclaimed = await f.repo.claim(); assert.ok(reclaimed); assert.equal(reclaimed.expiresAt, expires.toISOString());
  const research = await f.repo.prepareResearch(reclaimed); assert.ok(research.eligibility.eligible);
  assert.equal(await f.repo.waitForResearch(reclaimed), false);
  await f.store.storeSnapshot({ ...f.snapshot, createdAt: new Date().toISOString() });
  await assert.rejects(f.repo.prepareResearch(reclaimed), /SUPERSEDED/);
  assert.equal(await f.repo.waitForResearch(reclaimed), false);
}));

test("expired proposals cannot be reclaimed or revived by research repair", { skip: !connection }, () => isolated(async f => {
  const claim = (await f.repo.claim())!; assert.equal(await f.repo.waitForResearch(claim), true);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await f.store.storeSnapshot(f.snapshot);
  assert.equal(await f.repo.claim(), null);
  assert.equal((await f.pool.query("SELECT status FROM proposed_orders WHERE id=1")).rows[0].status, "EXPIRED");
}, 1000));

test("completed refresh slots, unknown source outcomes and exhausted pooled budgets cannot manufacture demand calls", { skip: !connection }, () => isolated(async f => {
  const source = f.policy.sources[0], slot = researchSourceSlot(f.now, "reports"), callKey = researchCallKey(f.manifestHash, f.policy, source, "reports", slot, source.urls[0], 1);
  await f.store.reserveCall({ ...f.identity, provider: source.provider, kind: "source", callKey, requestHash: "a".repeat(64), reservedCostMicros: 0, maxRequestsPerDay: 10, maxCostMicrosPerDay: 0, deadlineAt: new Date(f.now + 9000).toISOString() });
  await f.store.recordCallOutcome(callKey, "UNKNOWN");
  const held = await f.store.prepareRepair(f.identity);
  assert.equal(held.state, "HOLD"); assert.ok(held.reasons.includes("RESEARCH_PROVIDER_OUTCOME_UNKNOWN"));
  assert.equal((await f.store.dueRepairs(f.identity)).length, 0);
  const second = f.manifest.instruments.find(p => p.instrumentId !== f.policy.instrumentId)!;
  for (let i = 0; i < 9; i++) await f.store.reserveCall({ ...f.identity, provider: source.provider, kind: "source", callKey: `other-${i}`, requestHash: "a".repeat(64), reservedCostMicros: 0, maxRequestsPerDay: 10, maxCostMicrosPerDay: 0, deadlineAt: new Date(Date.now() + 9000).toISOString() });
  assert.ok(second);
  assert.ok((await f.store.prepareRepair(f.identity)).reasons.includes("RESEARCH_BUDGET_EXHAUSTED"));
}));

test("durable completed source slot delays stale coverage until original next slot", { skip: !connection }, () => isolated(async f => {
  const source = f.policy.sources[0], slot = researchRefreshSlot(source, "reports", f.now);
  const current = await f.store.latestSnapshot(f.identity); assert.ok(current);
  await f.store.storeSnapshot(current.snapshot, researchRefreshSlotKey(f.manifestHash, f.policy.instrumentId, source.id, "reports", slot));
  const prepared = await f.store.prepareRepair(f.identity);
  assert.equal(prepared.state, "WAITING"); assert.ok(prepared.reasons.includes("RESEARCH_WAITING_NEXT_SLOT"));
  assert.equal(Date.parse(prepared.nextCheckAt!), (slot + 1) * 86_400_000);
  assert.equal((await f.store.dueRepairs(f.identity)).length, 0);
}));

for (const marker of ["decision_json", "decided_at", "delivery_started_at", "delivery_outcome"] as const) {
  test(`PENDING with retained ${marker} cannot wait, bind or reclaim`, { skip: !connection }, () => isolated(async f => {
    const claim = (await f.repo.claim())!;
    const value = marker === "decision_json" ? "'{}'::jsonb" : marker === "delivery_outcome" ? "'UNKNOWN'" : "clock_timestamp()";
    await f.pool.query(`UPDATE proposal_ai_reviews SET ${marker}=${value} WHERE proposed_order_id=1`);
    await assert.rejects(f.repo.waitForResearch(claim), /AI_CLAIM_EXPIRED/);
    await assert.rejects(f.repo.prepareResearch(claim), /AI_CLAIM_EXPIRED/);
    await f.pool.query("UPDATE proposal_ai_reviews SET claim_until=clock_timestamp()-interval '1 second' WHERE proposed_order_id=1");
    assert.equal(await f.repo.claim(), null);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM research_repair_requests")).rows[0].n, 0);
    assert.equal((await f.pool.query("SELECT count(*)::int n FROM research_call_reservations")).rows[0].n, 0);
  }));
}

test("repair published between preparation failure and deferral causes bounded fresh reevaluation, not stale rejection", { skip: !connection }, () => isolated(async f => {
  const claim = (await f.repo.claim())!;
  await assert.rejects(f.repo.prepareResearch(claim), ResearchPreparationNeededError);
  await f.store.storeSnapshot(f.snapshot);
  assert.equal(await f.repo.waitForResearch(claim, true), true);
  const next = await f.repo.claim(); assert.ok(next);
  assert.equal(next.expiresAt, claim.expiresAt);
  assert.ok((await f.repo.prepareResearch(next)).eligibility.eligible);
  const row = (await f.pool.query("SELECT status,decision_json FROM proposal_ai_reviews")).rows[0];
  assert.equal(row.status, "PENDING"); assert.equal(row.decision_json, null);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM research_call_reservations")).rows[0].n, 0);
}));
