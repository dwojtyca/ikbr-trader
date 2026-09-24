import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { ReconciliationRepository } from "./repository.js";
import { ReconciliationRunner } from "./runner.js";
import { classifyReadiness } from "./gate.js";
import { completedFixture, completedRecord } from "./completed-test-fixture.js";
const connection = process.env.TEST_POSTGRES_URL;
for (const mode of ["filled", "zero-fill", "cancelled"] as const) test(`external zero-total completed record + PostgreSQL: ${mode}`, { skip: !connection }, async () => {
  const url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() });
  const db = `completed_zero_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${db}`);
  url.pathname = `/${db}`; const pool = new Pool({ connectionString: url.toString() });
  try {
    await runMigrations(pool);
    const repo = new ExecutionRepository(pool), recon = new ReconciliationRepository(pool), f = completedFixture();
    const inserted = await pool.query(`INSERT INTO proposed_orders
      (instrument,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,
      status,client_order_id,execution_account_id)
      VALUES ('TEST','123','BUY','LMT',1,100,99,102,'test',0.9,'PASS','PROPOSED','unrelated-proposal','DU-TEST') RETURNING *`);
    f.socket.handle = () => {
      const [c, o, s] = completedRecord();
      f.socket.emit("completedOrder", c, { ...o, orderRef: "external-ref", totalQuantity: 0,
        filledQuantity: mode === "zero-fill" ? 0 : 7 }, { ...s, status: mode === "cancelled" ? "Cancelled" : "Filled" });
      f.socket.emit("completedOrdersEnd");
    };
    const runner = new ReconciliationRunner(pool, repo, recon, f.adapter);
    const report = await runner.runOnce({ accountId: "DU-TEST", sessionId: "session", sessionStartedAt: new Date() },
      { runTimeoutMs: 5000, sourceTimeoutMs: 1000, executionSafetyMarginMs: 1000 });
    assert.ok(report);
    assert.equal(report.status, mode === "filled" ? "CLEAN" : "INCOMPLETE");
    const stored = (await pool.query("SELECT broker_snapshot FROM reconciliation_runs WHERE id=$1", [report.runId])).rows[0].broker_snapshot;
    assert.equal(stored.sourceCoverage.completedOrders.available, mode === "filled");
    if (mode === "filled") {
      assert.equal(stored.completedOrders.length, 1);
      assert.equal(stored.completedOrders[0].filled, 7);
      assert.equal(stored.completedOrders[0].remaining, 0);
      assert.equal(stored.completedOrders[0].brokerOrderId, null);
    } else {
      assert.deepEqual(stored.completedOrders, []);
      assert.equal(stored.sourceCoverage.completedOrders.reason, "completed_record_invalid");
    }
    const after = await pool.query("SELECT * FROM proposed_orders WHERE id=$1", [inserted.rows[0].id]);
    assert.deepEqual(after.rows, inserted.rows);
    for (const table of ["broker_order_ref_map", "broker_order_links", "reconciliation_broker_order_observations", "reconciliation_holds"]) {
      assert.equal(Number((await pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count), 0);
    }
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE ${db}`); await admin.end();
  }
});
for (const mode of ["clean", "unavailable", "ambiguous", "race"] as const) test(`completed production source + PostgreSQL: ${mode}`, { skip: !connection }, async () => {
  const url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() });
  const db = `completed_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${db}`);
  url.pathname = `/${db}`; const pool = new Pool({ connectionString: url.toString() });
  try {
    await runMigrations(pool);
    const repo = new ExecutionRepository(pool), recon = new ReconciliationRepository(pool), f = completedFixture();
    let proposal: number | undefined;
    const seed = async () => {
      const inserted = await pool.query(`INSERT INTO proposed_orders
        (instrument,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,
        status,client_order_id,execution_attempted_at,execution_account_id)
        VALUES ('TEST','123','BUY','LMT',1,100,99,102,'test',0.9,'PASS','PROPOSED','completed-test',NOW(),'DU-TEST') RETURNING id`);
      proposal = Number(inserted.rows[0].id);
      await pool.query(`INSERT INTO broker_order_ref_map (broker_order_ref,proposed_order_id,client_order_id,role)
        VALUES ('test-ref',$1,'completed-test','PARENT')`, [proposal]);
    };
    if (mode === "ambiguous") await seed();
    f.socket.handle = () => {
      if (mode === "unavailable") { f.socket.emit("error", new Error("unsupported"), 503); return; }
      const finish = () => {
        if (mode === "ambiguous" || mode === "race") {
          f.socket.emit("completedOrder", ...completedRecord());
          const [c, o, s] = completedRecord(); f.socket.emit("completedOrder", c, { ...o, permId: 988, orderRef: "unrelated" }, s);
        }
        f.socket.emit("completedOrdersEnd");
      };
      if (mode === "race") void seed().then(finish, error => f.socket.emit("error", error, 999)); else finish();
    };
    let oldest: Date | null | undefined;
    const runner = new ReconciliationRunner(pool, repo, recon, { capture: request => { oldest = request.oldestAmbiguousAttemptedAt; return f.adapter.capture(request); } });
    const report = await runner.runOnce({ accountId: "DU-TEST", sessionId: "session", sessionStartedAt: new Date() },
      { runTimeoutMs: 5000, sourceTimeoutMs: 1000, executionSafetyMarginMs: 1000 });
    assert.ok(report);
    assert.equal(report.status, mode === "clean" ? "CLEAN" : "INCOMPLETE");
    assert.equal(report.recoveryComplete, mode === "clean");
    const latest = await recon.getLatestRunForSession("DU-TEST", "session"); assert.ok(latest);
    assert.equal(classifyReadiness(false, latest, "session").kind, mode === "clean" ? "healthy" : "incomplete_recovery");
    const stored = (await pool.query("SELECT broker_snapshot,report FROM reconciliation_runs WHERE id=$1", [report.runId])).rows[0];
    assert.equal(stored.broker_snapshot.recoveryComplete, mode === "clean");
    if (mode === "clean") {
      assert.equal(classifyReadiness(false, { ...latest, sourceCoverage: { ...latest.sourceCoverage,
        completedOrders: { available: true, boundedWindow: false } } }, "session").kind, "incomplete_recovery");
    }
    if (proposal) {
      if (mode === "race") assert.equal(oldest, null);
      assert.equal(stored.broker_snapshot.sourceCoverage.completedOrders.available, true);
      assert.equal(stored.broker_snapshot.sourceCoverage.completedOrders.boundedWindow, false);
      assert.equal(stored.broker_snapshot.completedOrders.length, 2);
      assert.equal(stored.broker_snapshot.completedOrders[0].brokerOrderId, null);
      assert.equal(stored.report.brokerOrderObservationCount, 0);
      const row = (await pool.query("SELECT status,broker_order_id FROM proposed_orders WHERE id=$1", [proposal])).rows[0];
      assert.equal(row.status, "PROPOSED"); assert.equal(row.broker_order_id, null);
      const holds = (await pool.query("SELECT reason,resolved_at FROM reconciliation_holds")).rows;
      assert.equal(holds.length, 1); assert.equal(holds[0].reason, "recovery_source_missing"); assert.equal(holds[0].resolved_at, null);
    }
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE ${db}`); await admin.end();
  }
});
