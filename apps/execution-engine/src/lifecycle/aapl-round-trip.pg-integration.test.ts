import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { aaplRoundTrip } from "./aapl-round-trip-test-fixture.js";
import { evaluateRoundTrip } from "./round-trip-evidence.js";
const connection = process.env.TEST_POSTGRES_URL;
test("AAPL collector selects persisted USD window and never mutates database", {skip:!connection}, async () => {
  const name=`ikbr_aapl_roundtrip_${randomUUID().replaceAll("-","")}`, url=new URL(connection!); url.pathname="/postgres";
  const admin=new Pool({connectionString:url.toString()}); await admin.query(`CREATE DATABASE ${name}`);
  url.pathname=`/${name}`; const pool=new Pool({connectionString:url.toString()});
  try {
    await runMigrations(pool); const repo=new ExecutionRepository(pool), f=aaplRoundTrip();
    await pool.query(`INSERT INTO proposed_orders (id,instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,
      reason,confidence,risk_check_status,status,strategy,execution_account_id,execution_attempted_at,client_order_hash)
      VALUES (42,'AAPL','aapl_nasdaq','265598','BUY','LMT',1,100,99,102,'aapl_nasdaq',.8,'PASS','FILLED','test_strategy','DU_TEST',$1,$2)`,
      [f.order.executionAttemptedAt,f.review.client_order_hash]);
    await pool.query(`INSERT INTO proposal_ai_reviews (proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,
      status,expires_at,decided_at,delivery_started_at,decision_json,risk_evidence) VALUES
      (42,$1,'aapl_nasdaq','265598','DU_TEST',$2,'APPROVED',$3,$4,$5,$6,$7)`,[f.review.client_order_hash,f.review.session_id,
      f.review.expires_at,f.review.decided_at,f.review.delivery_started_at,f.review.decision_json,
      (f.evidence.lifecycle.review as {risk_evidence:unknown}).risk_evidence]);
    await pool.query(`INSERT INTO aapl_windows (run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
      VALUES ('fixture-run','DU_TEST','2026-09-23',$1,$2,42,$3)`,
      [f.evidence.window!.startsAt,f.evidence.window!.endsAt,f.evidence.window!.consumedAt]);
    await pool.query("INSERT INTO aapl_proposals (proposed_order_id,run_id) VALUES (42,'fixture-run')");
    for (const l of f.links) await pool.query(`INSERT INTO broker_order_links
      (proposed_order_id,account_id,role,role_ordinal,broker_order_id,perm_id,order_ref) VALUES (42,$1,$2,$3,$4,$5,$6)`,
      [l.account_id,l.role,l.role_ordinal,l.broker_order_id,l.perm_id,l.order_ref]);
    await pool.query(`INSERT INTO reconciliation_runs (account_id,session_id,started_at,completed_at,status,broker_snapshot,source_coverage,position_generation)
      VALUES ('DU_TEST','current',$1,$2,'CLEAN',$3,$4,1)`,[f.run.started_at,f.run.completed_at,f.snapshot,f.coverage]);
    await pool.query(`INSERT INTO broker_snapshot_syncs (account_id,session_id,observed_at,complete,generation) VALUES ('DU_TEST','current',$1,true,1)`,
      [f.evidence.lifecycle.positionSnapshot!.observedAt]);
    for (const fill of f.evidence.fills) await pool.query(`INSERT INTO broker_execution_fills
      (exec_id,broker_order_id,proposed_order_id,account_id,conid,symbol,currency,side,shares,price,executed_at,commission,commission_currency,realized_pnl)
      VALUES ($1,$2,42,'DU_TEST','265598','AAPL','USD',$3,$4,$5,$6,$7,$8,$9)`,
      [fill.exec_id,fill.broker_order_id,fill.side,fill.shares,fill.price,fill.executed_at,fill.commission,fill.commission_currency,fill.realized_pnl]);
    const readState = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(p)) FROM proposed_orders p) AS proposals,
      (SELECT jsonb_agg(to_jsonb(f) ORDER BY exec_id) FROM broker_execution_fills f) AS fills,
      (SELECT jsonb_agg(to_jsonb(w)) FROM aapl_windows w) AS windows`)).rows[0];
    const before = await readState();
    const evidence = await repo.getRoundTripEvidence(42, "DU_TEST"); assert.ok(evidence);
    const report = evaluateRoundTrip(evidence, f.context);
    assert.equal(report.status, "COMPLETED", JSON.stringify(report.reasons));
    assert.equal(report.netPnlUSD, 1); assert.equal(report.netPnlPLN, null);
    assert.deepEqual(report.commissionsByCurrency, { USD: 1 });
    assert.deepEqual(await readState(), before);
    await pool.query("UPDATE aapl_windows SET account_id='OTHER'");
    assert.equal(evaluateRoundTrip((await repo.getRoundTripEvidence(42, "DU_TEST"))!, f.context).status, "NOT_PROVEN");
    await pool.query("UPDATE aapl_windows SET account_id='DU_TEST'");
    await pool.query("DELETE FROM aapl_proposals WHERE proposed_order_id=42");
    await pool.query(`INSERT INTO gpw_windows (run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
      SELECT run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at FROM aapl_windows`);
    await pool.query("INSERT INTO gpw_proposals VALUES (42,'fixture-run')");
    const missing = await repo.getRoundTripEvidence(42, "DU_TEST"); assert.ok(missing);
    assert.equal(missing.window, null);
    assert.equal(evaluateRoundTrip(missing, f.context).status, "NOT_PROVEN");
  } finally {
    const disconnected = new Promise<void>(resolve => {
      let remaining = pool.totalCount;
      if (!remaining) return resolve();
      pool.on("remove", () => { if (--remaining === 0) resolve(); });
    });
    await pool.end(); await disconnected;
    try { await admin.query(`DROP DATABASE ${name}`); } finally { await admin.end(); }
  }
});
