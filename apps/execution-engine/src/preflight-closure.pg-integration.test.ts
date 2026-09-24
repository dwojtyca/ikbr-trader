import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runMigrations } from "./migrations.js";
import { ExecutionRepository } from "./repository.js";
import { ReconciliationRepository } from "./reconciliation/repository.js";
import { ReconciliationRunner } from "./reconciliation/runner.js";
import { FakeBrokerReconciliationAdapter } from "./reconciliation/fake-broker-adapter.js";
import { externalFixture } from "./reconciliation/external-test-fixture.js";
import { readZeroDayRows, validateZeroDay } from "./daily-loss-evidence.js";
import { zeroDayFixture } from "./daily-loss-test-fixture.js";
const connection = process.env.TEST_POSTGRES_URL;
async function database(run: (pool: Pool) => Promise<void>) {
  const url = new URL(connection!); url.pathname = "/postgres"; const admin = new Pool({ connectionString: url.toString() });
  const name = `preflight_${randomUUID().replaceAll("-", "")}`; await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`; const pool = new Pool({ connectionString: url.toString() });
  try { await runMigrations(pool); await run(pool); } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
for (const mode of ["known", "legacy", "legacy_bad_perm", "unknown_hold", "collision", "broker_id_collision", "active_proposal", "expired", "protected", "aggregate", "ambiguity_during_capture"] as const) test(`production reconciliation external manual order: ${mode}`, { skip: !connection }, () => database(async pool => {
  const f = externalFixture(); const repo = new ExecutionRepository(pool), recon = new ReconciliationRepository(pool), broker = new FakeBrokerReconciliationAdapter();
  await pool.query(`INSERT INTO broker_execution_fills (exec_id,account_id,conid,symbol,currency,exchange,side,shares,executed_at)
    VALUES ('old',$1,'123','EXT','USD','SMART','BOT',10,NOW()-INTERVAL '2 days')`, [f.approval.accountId]);
  broker.configure({ positions: [f.position], openOrders: [f.row] });
  const context = { accountId: f.approval.accountId, sessionId: "session", sessionStartedAt: new Date() };
  const config = { runTimeoutMs: 5000, sourceTimeoutMs: 1000, executionSafetyMarginMs: 1000 };
  const before = new ReconciliationRunner(pool, repo, recon, broker); assert.equal((await before.runOnce(context, config))?.status, "MISMATCH");
  if (mode.startsWith("legacy")) await pool.query("UPDATE reconciliation_holds SET payload=payload-'permId'");
  if (mode === "legacy_bad_perm") await pool.query(`UPDATE reconciliation_runs SET broker_snapshot=jsonb_set(broker_snapshot,'{openOrders,0,permId}','"999"')`);
  if (mode === "unknown_hold") await pool.query(`INSERT INTO reconciliation_holds (account_id,instrument,conid,identity_key,reason,severity,reconciliation_run_id)
    SELECT account_id,instrument,conid,identity_key,'unknown_submission','error',reconciliation_run_id FROM reconciliation_holds LIMIT 1`);
  if (mode === "collision" || mode === "broker_id_collision" || mode === "active_proposal") {
    const p = await pool.query(`INSERT INTO proposed_orders (instrument,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,execution_account_id)
      VALUES ('EXT','123','BUY','LMT',1,10,9,12,'fixture',0.9,'PASS',$1,$2) RETURNING id`, [mode !== "active_proposal" ? "FILLED" : "PROPOSED", f.approval.accountId]);
    if (mode === "collision") await pool.query(`INSERT INTO broker_order_links (proposed_order_id,account_id,role,role_ordinal,perm_id,order_ref) VALUES ($1,$2,'PARENT',0,'987','owned')`, [p.rows[0].id, f.approval.accountId]);
  }
  if (mode === "broker_id_collision") {
    await pool.query(`INSERT INTO broker_order_links (proposed_order_id,account_id,role,role_ordinal,perm_id,broker_order_id,order_ref)
      SELECT id,execution_account_id,'PARENT',0,'999','42','owned' FROM proposed_orders WHERE instrument='EXT'`);
    broker.configure({ positions: [f.position], openOrders: [{ ...f.row, brokerOrderId: "42" }] });
  }
  if (mode === "expired") f.approval.expiresAt = new Date(Date.now() - 1).toISOString();
  const approvals = [f.approval];
  if (mode === "aggregate") { approvals.push({ ...f.approval, permId: "988" }); broker.configure({ positions: [f.position], openOrders: [f.row, { ...f.row, permId: "988" }] }); }
  if (mode === "ambiguity_during_capture") {
    const capture = broker.capture.bind(broker);
    broker.capture = async request => {
      const snapshot = await capture(request);
      await pool.query(`INSERT INTO proposed_orders (instrument,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,execution_account_id,execution_attempted_at)
        VALUES ('BOT','456','BUY','LMT',1,10,9,12,'fixture',0.9,'PASS','PROPOSED',$1,NOW())`, [f.approval.accountId]);
      return { ...snapshot, sourceCoverage: { ...snapshot.sourceCoverage,
        completedOrders: { ...snapshot.sourceCoverage.completedOrders, recoveryScope: "current_state_only" } } };
    };
  }
  const runner = new ReconciliationRunner(pool, repo, recon, broker, console, () => ({ approvals, protectedConIds: mode === "protected" ? ["123"] : ["456"] }));
  const after = await runner.runOnce(context, config); const clean = ["known", "legacy"].includes(mode);
  assert.equal(after?.status, clean ? "CLEAN" : mode === "ambiguity_during_capture" ? "INCOMPLETE" : "MISMATCH");
  const holds = await recon.listActiveHolds(context.accountId); assert.equal(holds.length === 0, clean);
  if (mode === "ambiguity_during_capture") {
    assert.ok(holds.some(h => h.reason === "orphan_broker_order"));
    assert.equal(((await recon.getLatestRunForSession(context.accountId, "session"))?.report?.externalOrders as unknown[]).length, 0);
  }
  if (mode === "unknown_hold") assert.ok(holds.some(h => h.reason === "unknown_submission"));
  if (clean) {
    assert.equal(((await recon.getLatestRunForSession(context.accountId, "session"))?.report?.externalOrders as unknown[]).length, 1);
    approvals.length = 0;
    assert.equal((await runner.runOnce(context, config))?.status, "MISMATCH");
    assert.equal((await recon.listActiveHolds(context.accountId))[0].reason, "orphan_broker_order");
  }
}));
test("zero-day consistent PG evidence rejects unknown-account fill and later generation invalidation", { skip: !connection }, () => database(async pool => {
  const f = zeroDayFixture(), start = new Date(f.ctx.now); start.setUTCHours(0,0,0,0);
  await pool.query(`INSERT INTO broker_snapshot_syncs (account_id,session_id,observed_at,complete,generation) VALUES ($1,'session',NOW(),true,1)`, [f.ctx.accountId]);
  await pool.query(`INSERT INTO reconciliation_runs (account_id,session_id,status,completed_at,snapshot_captured_at,snapshot_complete,source_coverage,broker_snapshot,position_generation)
    VALUES ($1,'session','CLEAN',$2,$2,true,$3,$4,1)`, [f.ctx.accountId, f.run.completed_at, JSON.stringify(f.coverage), JSON.stringify(f.snapshot)]);
  assert.equal(validateZeroDay(await readZeroDayRows(pool, f.ctx.accountId, start), f.ctx).ok, true);
  await pool.query("UPDATE broker_snapshot_syncs SET generation=2");
  assert.equal(validateZeroDay(await readZeroDayRows(pool, f.ctx.accountId, start), f.ctx).reason, "position_generation_changed");
  await pool.query("UPDATE broker_snapshot_syncs SET generation=1");
  await pool.query("INSERT INTO broker_execution_fills (exec_id,account_id,executed_at,commission) VALUES ('unattributed',NULL,NOW(),NULL)");
  assert.equal(validateZeroDay(await readZeroDayRows(pool, f.ctx.accountId, start), f.ctx).reason, "local_day_not_empty");
  const summary = await new ExecutionRepository(pool).getRealizedPnLSince({ baseCurrency: "USD", since: start });
  assert.equal(summary.complete, false); assert.equal(summary.missingCommissionReports, 1);
}));
