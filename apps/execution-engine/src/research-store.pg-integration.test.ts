import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { Pool } from "pg";
import { ResearchStore, researchHash, type ResearchCallReservation, type ResearchBindingIdentity } from "@ikbr/shared/instrument-research";
import { buildStrategyAttribution, canonicalizeTradingConfiguration } from "@ikbr/shared/trading-config";
import { researchFixture } from "@ikbr/shared/instrument-research-testfixture";
import { runMigrations } from "./migrations.js";

const url = process.env.TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
async function isolated(fn: (pool: Pool) => Promise<void>) {
  const name = `pp4_research_${randomUUID().replaceAll("-", "")}`, target = new URL(url!);
  target.pathname = "/postgres"; const admin = new Pool({ connectionString: target.toString() });
  await admin.query(`CREATE DATABASE ${name}`); target.pathname = `/${name}`; const pool = new Pool({ connectionString: target.toString() });
  try { await runMigrations(pool); await fn(pool); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function seed(pool: Pool) {
  const f = researchFixture(), store = new ResearchStore(pool);
  await pool.query("INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)", [f.configHash, canonicalizeTradingConfiguration(f.config)]);
  await store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const) await store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: service, tradingEnabled: false });
  return { ...f, store };
}
async function proposal(pool: Pool, f: Awaited<ReturnType<typeof seed>>): Promise<ResearchBindingIdentity> {
  const hash = "b".repeat(64), listing = f.policy.listing;
  const attribution = buildStrategyAttribution(f.config, f.policy.instrumentId, "momentum_default"), stamp = new Date().toISOString();
  const trigger = { version: 1, source: "evaluation_bucket", timeframe: "1m", observedAt: stamp, bucketStartMs: Math.floor(Date.parse(stamp) / 60000) * 60000 };
  const row = (await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger)
    VALUES($1,$2,$3,'BUY','LMT',1,100,99,102,'fixture',1,'PASS',$4,2,$5,$6) RETURNING id`, [listing.symbol, f.policy.instrumentId, String(listing.conId), hash, attribution, trigger])).rows[0];
  await pool.query("INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger) VALUES($1,$2,$3,$4,'DU_TEST','fixture',2,$5,$6)", [row.id, hash, f.policy.instrumentId, String(listing.conId), attribution, trigger]);
  return { proposalId: Number(row.id), clientOrderHash: hash, configHash: f.configHash, manifestHash: f.manifestHash, instrumentId: f.policy.instrumentId };
}
function call(f: Awaited<ReturnType<typeof seed>>, key: string): ResearchCallReservation {
  return { configHash: f.configHash, manifestHash: f.manifestHash, accountId: "DU_TEST", provider: "openai", kind: "model", callKey: key, requestHash: "c".repeat(64), reservedCostMicros: 100, maxRequestsPerDay: 1, maxCostMicrosPerDay: 100, deadlineAt: new Date(Date.now() + 9000).toISOString() };
}
suite("PP4 immutable research authority, refresh and budgets on isolated PostgreSQL", () => {
  test("manifest adoption rejects enabled writes, active leases and unknown model calls", async () => isolated(async pool => {
    const f = await seed(pool), input = await proposal(pool, f), changed = structuredClone(f.manifest); changed.model.model = "changed";
    await assert.rejects(f.store.registerManifest({ manifest: changed, configuration: f.config, tradingEnabled: true, adopt: true }), /DISABLED_WRITES/);
    await pool.query("UPDATE proposal_ai_reviews SET claim_until=clock_timestamp()+interval '30 seconds' WHERE proposed_order_id=$1", [input.proposalId]);
    await assert.rejects(f.store.registerManifest({ manifest: changed, configuration: f.config, tradingEnabled: false, adopt: true }), /ACTIVE_OR_UNKNOWN/);
    await pool.query("UPDATE proposal_ai_reviews SET claim_until=NULL WHERE proposed_order_id=$1", [input.proposalId]);
    await f.store.reserveCall(call(f, "unknown-model")); await f.store.recordCallOutcome("unknown-model", "UNKNOWN");
    await assert.rejects(f.store.registerManifest({ manifest: changed, configuration: f.config, tradingEnabled: false, adopt: true }), /ACTIVE_OR_UNKNOWN/);
    await assert.rejects(pool.query("UPDATE research_manifests SET canonical_json='{}'"), /IMMUTABLE/);
    await assert.rejects(pool.query("DELETE FROM research_call_reservations"), /IMMUTABLE/);
  }));
  test("dual peer missing, mismatch and expiry block; original process identity cannot mutate", async () => isolated(async pool => {
    const f = await seed(pool); assert.ok((await f.store.assertAuthority(f)).validUntilMs > Date.now());
    await assert.rejects(f.store.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service: "llm-agent", processId: "execution-engine", tradingEnabled: false }), /IDENTITY_CHANGED/);
    await pool.query("UPDATE research_observations SET observed_at=observed_at-interval '60 seconds',expires_at=expires_at-interval '60 seconds' WHERE service='llm-agent'");
    await assert.rejects(f.store.assertAuthority(f), /PEER/);
  }));
  test("new error snapshot supersedes pin without repinning and historical snapshot stays readable", async () => isolated(async pool => {
    const f = await seed(pool), original = await f.store.storeSnapshot(f.snapshot), input = await proposal(pool, f);
    const bound = await f.store.bind(input); assert.equal(bound.binding.snapshotId, original.id);
    const failed = structuredClone(f.snapshot); failed.coverage[1].status = "ERROR"; failed.coverage[1].reason = "provider outage";
    const newer = await f.store.storeSnapshot(failed); assert.equal(newer.sequence, original.sequence + 1);
    const old = structuredClone(f.snapshot); old.createdAt = new Date(Date.parse(old.createdAt) - 1000).toISOString();
    await assert.rejects(f.store.storeSnapshot(old), /OUT_OF_ORDER/);
    await assert.rejects(f.store.validateBinding(input), /SUPERSEDED/); await assert.rejects(f.store.bind(input), /SUPERSEDED/);
    assert.equal((await f.store.readSnapshot(original.id))!.hash, original.hash);
    assert.equal((await f.store.getBinding(input.proposalId))!.snapshotId, original.id);
    await assert.rejects(pool.query("UPDATE research_snapshot_heads SET sequence=sequence-1"), /MONOTONIC/);
    await assert.rejects(pool.query("UPDATE research_bindings SET snapshot_id=$1", [newer.id]), /IMMUTABLE/);
  }));
  test("dispatch head lock blocks publication and peer drift until transaction releases", async () => isolated(async pool => {
    const f = await seed(pool); await f.store.storeSnapshot(f.snapshot); const input = await proposal(pool, f); await f.store.bind(input);
    const client = await pool.connect(); await client.query("BEGIN");
    try {
      await f.store.validateBinding(input, client);
      const contender = await pool.connect();
      try {
        await contender.query("BEGIN"); await contender.query("SET LOCAL lock_timeout='40ms'");
        await assert.rejects(contender.query("SELECT * FROM research_snapshot_heads FOR UPDATE"), /lock timeout/);
        await contender.query("ROLLBACK"); await contender.query("BEGIN"); await contender.query("SET LOCAL lock_timeout='40ms'");
        await assert.rejects(contender.query("UPDATE research_observations SET trading_enabled=TRUE"), /lock timeout/);
      } finally { await contender.query("ROLLBACK"); contender.release(); }
    } finally { await client.query("ROLLBACK"); client.release(); }
    await f.store.storeSnapshot(f.snapshot);
  }));
  test("concurrent reservations charge once and changing manifest/process cannot reset account/provider/day", async () => isolated(async pool => {
    const f = await seed(pool);
    const results = await Promise.allSettled([f.store.reserveCall(call(f, "model:a")), new ResearchStore(pool).reserveCall(call(f, "model:b"))]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const winner = results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<{ callKey: string }>;
    await assert.rejects(f.store.reserveCall(call(f, winner.value.callKey)), /ALREADY_RESERVED/);
    await f.store.recordCallOutcome(winner.value.callKey, "SUCCEEDED");
    const changed = structuredClone(f.manifest); changed.model.model = "revision-2";
    await f.store.registerManifest({ manifest: changed, configuration: f.config, tradingEnabled: false, adopt: true });
    await pool.query("UPDATE research_observations SET observed_at=observed_at-interval '60 seconds',expires_at=expires_at-interval '60 seconds'");
    const manifestHash = researchHash(changed);
    for (const service of ["execution-engine", "llm-agent"] as const) await f.store.observe({ configHash: f.configHash, manifestHash, service, processId: `${service}:2`, tradingEnabled: false });
    await assert.rejects(f.store.reserveCall({ ...call(f, "model:new-config"), manifestHash }), /BUDGET_EXHAUSTED/);
    await assert.rejects(f.store.reserveCall({ ...call(f, "inflated-budget"), manifestHash, maxRequestsPerDay: 100 }), /MANIFEST_MISMATCH/);
  }));
});

suite("PP4 refresh publication durability", () => {
  test("instrument locks serialize workers and slot publication commits with the snapshot", async () => isolated(async pool => {
    const f = await seed(pool), identity = {configHash:f.configHash, manifestHash:f.manifestHash, instrumentId:f.policy.instrumentId};
    const second = new ResearchStore(pool);
    assert.equal(await f.store.withRefreshLock(identity, async () => {
      assert.equal(await second.withRefreshLock(identity, async () => { assert.fail("concurrent refresh"); }), false);
      await f.store.storeSnapshot(f.snapshot, "fixture-slot");
    }), true);
    assert.equal(await second.hasRefreshSlot("fixture-slot"), true);
    assert.equal(await second.withRefreshLock(identity, async () => undefined), true);
    await assert.rejects(f.store.storeSnapshot(f.snapshot, "fixture-slot"), /duplicate key/);
    assert.equal((await f.store.latestSnapshot(identity))!.sequence, 1);
    await assert.rejects(pool.query("DELETE FROM research_refresh_slots"), /IMMUTABLE/);
    await assert.rejects(pool.query("TRUNCATE research_refresh_slots"), /IMMUTABLE/);
  }));
});
