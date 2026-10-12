import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { EntryControlStore } from "./entry-control.js";
import { runMigrations } from "./migrations.js";

const url = process.env.TEST_POSTGRES_URL;
const accountId = "DU_PP5_CONTROL", sessionId = "pp5-process";
const context = { accountId, sessionId, entriesPaused: false, automationEnabled: true };
const coverage = { positions: { available: true, boundedWindow: true, timedOut: false },
  openOrders: { available: true, boundedWindow: true, timedOut: false },
  executions: { available: true, timedOut: false, window: { exposureWindowComplete: true } },
  session: { available: true, timedOut: false }, completedOrders: { available: true, boundedWindow: true } };
async function fixture(run: (pool: Pool, store: EntryControlStore) => Promise<void>) {
  const name = `pp5_control_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(url!); target.pathname = "/postgres";
  const admin = new Pool({ connectionString: target.toString() });
  await admin.query(`CREATE DATABASE ${name}`); target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.toString() });
  try {
    await runMigrations(pool);
    await pool.query(`INSERT INTO lifecycle_observer_health(account_id,session_id,observed_at,healthy)
      VALUES($1,$2,clock_timestamp(),true)`, [accountId, sessionId]);
    await pool.query(`INSERT INTO lifecycle_alert_workers(account_id,process_id,heartbeat_at,transport_enabled)
      VALUES($1,$2,clock_timestamp(),true)`, [accountId, sessionId]);
    await pool.query(`INSERT INTO reconciliation_runs(account_id,session_id,status,completed_at,source_coverage)
      VALUES($1,$2,'CLEAN',clock_timestamp(),$3)`, [accountId, sessionId, JSON.stringify(coverage)]);
    await run(pool, new EntryControlStore(pool));
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
const deps: Parameters<EntryControlStore["permit"]>[2] = { assertCurrent() {}, alertFailure: async () => null };

test("entry control adopts disabled once; durable pause survives enabled restart and audit cannot be reset", { skip: !url }, () => fixture(async (pool, store) => {
  await assert.rejects(store.adopt(accountId, true), /DISABLED_ADOPTION/);
  await store.adopt(accountId, false);
  await assert.rejects(store.check(context, deps), /EXECUTION_ENTRIES_PAUSED/);
  await store.adopt(accountId, true);
  assert.equal((await store.read(accountId)).control.paused, true);
  await store.setPaused(accountId, false, "operator:fixture", "approved fixture", db => store.permit(db, context, deps, { resuming: true }));
  await store.check(context, deps);
  await store.setPaused(accountId, true, "operator:fixture", "entry pause");
  const restarted = new EntryControlStore(pool);
  await assert.rejects(restarted.check(context, deps), /EXECUTION_ENTRIES_PAUSED/);
  assert.deepEqual((await store.read(accountId)).events.map(row => row.paused), [true, false, true]);
  await assert.rejects(pool.query("DELETE FROM execution_entry_controls"), /cannot be removed/);
  await assert.rejects(pool.query("TRUNCATE execution_entry_controls CASCADE"), /cannot be removed/);
  await assert.rejects(pool.query("UPDATE execution_entry_control_events SET reason='reset'"), /append-only/);
}));

test("resume fails for stale/missing process health, unknown alerts, incomplete broker coverage and final local failure", { skip: !url }, () => fixture(async (pool, store) => {
  await store.adopt(accountId, false);
  const resume = (overrides = deps) => store.setPaused(accountId, false, "operator:fixture", "resume fixture",
    db => store.permit(db, context, overrides, { resuming: true }));
  await assert.rejects(resume({ ...deps, alertFailure: async () => "alert_delivery_unknown" }), /alert_delivery_unknown/);
  await pool.query("UPDATE lifecycle_observer_health SET session_id='old'");
  await assert.rejects(resume(), /OBSERVER_UNHEALTHY/);
  await pool.query("UPDATE lifecycle_observer_health SET session_id=$1,observed_at=clock_timestamp()-interval '16 seconds'", [sessionId]);
  await assert.rejects(resume(), /OBSERVER_UNHEALTHY/);
  await pool.query("UPDATE lifecycle_observer_health SET observed_at=clock_timestamp()");
  await pool.query("UPDATE reconciliation_runs SET source_coverage='{}'");
  await assert.rejects(resume(), /RECONCILIATION_INCOMPLETE/);
  await pool.query("UPDATE reconciliation_runs SET source_coverage=$1", [JSON.stringify(coverage)]);
  let calls = 0;
  await assert.rejects(resume({ ...deps, assertCurrent() { if (++calls === 3) throw new Error("connection_changed"); } }), /connection_changed/);
  assert.equal((await store.read(accountId)).control.paused, true);
  assert.equal((await store.read(accountId)).events.length, 1);
  await assert.rejects(store.setPaused(accountId, false, "operator", "unguarded"), /RESUME_GATE_REQUIRED/);
}));

test("entry send transaction serializes with pause; a later sender cannot use the earlier permit", { skip: !url }, () => fixture(async (pool, store) => {
  await store.adopt(accountId, false);
  await store.setPaused(accountId, false, "operator", "fixture", db => store.permit(db, context, deps, { resuming: true }));
  const sending = await pool.connect(); let paused = false, sends = 0;
  try {
    await sending.query("BEGIN");
    await sending.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`snap:${accountId}`]);
    const permit = await store.permit(sending, context, deps);
    const pause = store.setPaused(accountId, true, "operator", "concurrent pause").then(() => { paused = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(paused, false);
    permit.assertCurrent(); assert.ok(Date.now() < permit.validUntilMs); sends++;
    await sending.query("COMMIT"); await pause;
    await sending.query("BEGIN"); await sending.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`snap:${accountId}`]);
    await assert.rejects(store.permit(sending, context, deps), /EXECUTION_ENTRIES_PAUSED/);
    await sending.query("ROLLBACK"); assert.equal(sends, 1);
  } finally { await sending.query("ROLLBACK"); sending.release(); }
}));

test("a final send permit expires with alert worker health even when broker and observer remain fresh", { skip: !url }, () => fixture(async (pool, store) => {
  await store.adopt(accountId, false);
  await store.setPaused(accountId, false, "operator", "fixture", db => store.permit(db, context, deps, { resuming: true }));
  await pool.query("UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp()-interval '14 seconds'");
  const db = await pool.connect();
  try {
    const heartbeat = new Date((await db.query("SELECT heartbeat_at FROM lifecycle_alert_workers")).rows[0].heartbeat_at).getTime();
    const permit = await store.permit(db, context, deps);
    assert.equal(permit.validUntilMs, heartbeat + 15000);
    await pool.query("UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp()-interval '16 seconds'");
    await assert.rejects(store.permit(db, context, deps), /ALERT_WORKER_STALE/);
  } finally { db.release(); }
}));

const startReason = `paper-start:${randomUUID()}`;
test("explicit startup requires its audited pause; stale CAS cannot run gates or undo newer pauses", { skip: !url }, () => fixture(async (_pool, store) => {
  await store.adopt(accountId, false);
  await assert.rejects(store.withStartupPause(accountId, 1, async () => null), /ENTRY_START_INTENT_REQUIRED/);
  await store.setPaused(accountId, true, "operator", startReason, undefined, 1);
  assert.equal(await store.withStartupPause(accountId, 2, async () => "prepared"), "prepared");
  await store.setPaused(accountId, true, "operator", "newer stop", undefined, 2);
  let gateCalls = 0;
  const gate = async () => { gateCalls++; return { validUntilMs: Date.now() + 10000, assertCurrent() {} }; };
  await assert.rejects(store.setPaused(accountId, false, "operator", startReason, gate, 2), /REVISION_CHANGED/);
  await assert.rejects(store.withStartupPause(accountId, 2, async () => assert.fail("must not prepare")), /REVISION_CHANGED/);
  assert.equal(gateCalls, 0);
  assert.equal((await store.read(accountId)).control.paused, true);
  assert.equal((await store.read(accountId)).events.length, 3);
}));

test("startup preparation serializes with pause and rolls queue work back on a failed final fence", { skip: !url }, () => fixture(async (pool, store) => {
  await store.adopt(accountId, false);
  await store.setPaused(accountId, true, "operator", startReason);
  await pool.query("CREATE TABLE startup_queue_fixture(id integer PRIMARY KEY)");
  await assert.rejects(store.withStartupPause(accountId, 2, async db => {
    await db.query("INSERT INTO startup_queue_fixture VALUES(1)");
    throw Error("connection changed");
  }), /connection changed/);
  assert.equal((await pool.query("SELECT * FROM startup_queue_fixture")).rowCount, 0);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const prepare = store.withStartupPause(accountId, 2, async db => {
    await db.query("INSERT INTO startup_queue_fixture VALUES(1)"); entered(); await pending;
  });
  await ready;
  let paused = false;
  const pause = store.setPaused(accountId, true, "operator", "stop during preparation").then(() => { paused = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(paused, false);
  release(); await prepare; await pause;
  await assert.rejects(store.withStartupPause(accountId, 2, async () => null), /REVISION_CHANGED/);
  assert.equal((await store.read(accountId)).control.paused, true);
}));

test("concurrent resumed startup commits only one CAS event and cannot prepare after resume", { skip: !url }, () => fixture(async (_pool, store) => {
  await store.adopt(accountId, false);
  await store.setPaused(accountId, true, "operator", startReason);
  const gate = async () => ({ validUntilMs: Date.now() + 10000, assertCurrent() {} });
  const outcomes = await Promise.allSettled([1, 2].map(() => store.setPaused(accountId, false, "operator", startReason, gate, 2)));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
  const state = await store.read(accountId);
  assert.equal(Number(state.control.revision), 3); assert.equal(state.control.paused, false);
  assert.equal(state.events[0].reason, startReason);
  await assert.rejects(store.withStartupPause(accountId, 3, async () => null), /ENTRY_START_PAUSE_REQUIRED/);
}));

test("paused explicit startup queues missing research through the real store without reservations and rolls back failed preparation", { skip: !url }, () => fixture(async (pool, controls) => {
  const { researchFixture } = await import("@ikbr/shared/instrument-research-testfixture");
  const { ResearchStore, researchHash } = await import("@ikbr/shared/instrument-research");
  const { canonicalizeTradingConfiguration } = await import("@ikbr/shared/trading-config");
  const f = researchFixture(), research = new ResearchStore(pool);
  f.manifest.refreshEnabled = true; f.policy.sources[0].parserConfig = { kind: "sec-json" };
  f.manifestHash = researchHash(f.manifest); f.snapshot.manifestHash = f.manifestHash; f.snapshot.mappingHash = researchHash(f.policy);
  await pool.query("INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)", [f.configHash, canonicalizeTradingConfiguration(f.config)]);
  await research.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: true });
  for (const service of ["execution-engine", "llm-agent"] as const)
    await research.observe({ configHash: f.configHash, manifestHash: f.manifestHash, service, processId: service, tradingEnabled: true });
  const missing = structuredClone(f.snapshot);
  missing.coverage = missing.coverage.filter(c => c.role !== "reports"); missing.evidence = []; missing.reports = []; missing.facts = [];
  await research.storeSnapshot(missing);
  const identity = { accountId, instrumentId: f.policy.instrumentId, configHash: f.configHash, manifestHash: f.manifestHash };
  await controls.adopt(accountId, false);
  await controls.setPaused(accountId, true, "operator", startReason);
  await assert.rejects(controls.withStartupPause(accountId, 2, async db => {
    assert.equal((await research.prepareRepair(identity, db)).state, "WAITING"); throw Error("final connection fence");
  }), /final connection fence/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_repair_requests")).rows[0].n, 0);
  for (let i = 0; i < 2; i++) assert.equal((await controls.withStartupPause(accountId, 2, db => research.prepareRepair(identity, db))).state, "WAITING");
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_repair_requests WHERE state='WAITING'")).rows[0].n, 1);
  await research.storeSnapshot(f.snapshot);
  assert.equal((await controls.withStartupPause(accountId, 2, db => research.prepareRepair(identity, db))).state, "READY");
  assert.equal((await pool.query("SELECT count(*)::int n FROM research_call_reservations")).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM proposed_orders")).rows[0].n, 0);
  assert.equal((await controls.read(accountId)).control.paused, true);
}));
