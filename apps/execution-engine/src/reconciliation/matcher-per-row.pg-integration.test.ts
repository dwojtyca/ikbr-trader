/**
 * PR15 §2 regression — the matcher is per-proposed_order, not
 * global. Two ambiguous rows A and B; the broker snapshot only
 * contains B's `orderRef`. B must be matched and A must remain
 * unresolved even though both share the same identity_key
 * (same instrument+conId).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { ReconciliationRepository } from "./repository.js";
import { ReconciliationRunner } from "./runner.js";
import { FakeBrokerReconciliationAdapter } from "./fake-broker-adapter.js";
import { deriveParentOrderRef } from "./order-ref.js";

const CONN_URL = process.env.TEST_POSTGRES_URL;
const suite = CONN_URL ? describe : describe.skip;

function poolForDb(url: string, dbName: string): Pool {
  const p = new URL(url);
  p.pathname = `/${dbName}`;
  return new Pool({ connectionString: p.toString() });
}
async function withAdmin<T>(url: string, fn: (p: Pool) => Promise<T>): Promise<T> {
  const p = new URL(url);
  p.pathname = "/postgres";
  const admin = new Pool({ connectionString: p.toString() });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}
async function fresh(suffix: string): Promise<{ pool: Pool; dbName: string }> {
  const dbName = `ikbr_perrow_${suffix}_${Date.now()}`;
  await withAdmin(CONN_URL!, async (a) => {
    await a.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await a.query(`CREATE DATABASE ${dbName}`);
  });
  const pool = poolForDb(CONN_URL!, dbName);
  await runMigrations(pool);
  return { pool, dbName };
}
async function drop(pool: Pool, dbName: string): Promise<void> {
  await pool.end();
  await withAdmin(CONN_URL!, async (a) => {
    await a.query(`DROP DATABASE IF EXISTS ${dbName}`);
  });
}

suite("Reconciliation matcher — per-proposed_order (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }

  it("row A is NOT matched via row B's orderRef even when both share instrument+conId", async () => {
    const { pool, dbName } = await fresh("per_row");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      // Two ambiguous rows with distinct client_order_ids.
      const cidA = "co-owner-A";
      const cidB = "co-owner-B";
      const insA = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, order_type, quantity, entry, stop,
           take_profit, reason, confidence, risk_check_status,
           status, client_order_id, execution_attempted_at,
           execution_account_id
         ) VALUES (
           'AAPL', '123', 'BUY', 'LMT', 1, 100, 95, 110, 'test',
           0.9, 'PASS', 'PROPOSED', $1, NOW(), $2
         ) RETURNING id`,
        [cidA, "DU-1"],
      );
      const insB = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, order_type, quantity, entry, stop,
           take_profit, reason, confidence, risk_check_status,
           status, client_order_id, execution_attempted_at,
           execution_account_id
         ) VALUES (
           'AAPL', '123', 'BUY', 'LMT', 1, 100, 95, 110, 'test',
           0.9, 'PASS', 'PROPOSED', $1, NOW(), $2
         ) RETURNING id`,
        [cidB, "DU-1"],
      );
      const idA = insA.rows[0].id;
      const idB = insB.rows[0].id;
      const refA = deriveParentOrderRef(cidA);
      const refB = deriveParentOrderRef(cidB);
      // Persist ref-map for BOTH — via a shared PoolClient tx.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await reconRepo.insertPlanLegsAndRefs(client, {
          proposedOrderId: idA,
          clientOrderId: cidA,
          accountId: "DU-1",
          legs: [{ role: "PARENT", roleOrdinal: 0, orderRef: refA }],
        });
        await reconRepo.insertPlanLegsAndRefs(client, {
          proposedOrderId: idB,
          clientOrderId: cidB,
          accountId: "DU-1",
          legs: [{ role: "PARENT", roleOrdinal: 0, orderRef: refB }],
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      // Broker snapshot contains ONLY refB.
      const adapter = new FakeBrokerReconciliationAdapter();
      adapter.configure({
        openOrders: [
          {
            brokerOrderId: "broker-B",
            orderRef: refB,
            status: "Submitted",
            symbol: "AAPL",
            conId: "123",
            observedAt: new Date(),
          },
        ],
      });
      const runner = new ReconciliationRunner(pool, repo, reconRepo, adapter);
      const report = await runner.runOnce(
        {
          accountId: "DU-1",
          sessionId: "sess-A",
          sessionStartedAt: new Date(Date.now() - 60_000),
        },
        {
          runTimeoutMs: 5_000,
          sourceTimeoutMs: 1_000,
          executionSafetyMarginMs: 60_000,
        },
      );
      assert.ok(report);
      // B has a positive match — its status should be SUBMITTED
      // (parent status from broker). A is unresolved.
      const rows = await pool.query<{ id: string; status: string }>(
        `SELECT id::text AS id, status FROM proposed_orders ORDER BY id`,
      );
      const byId = new Map(rows.rows.map((r) => [String(r.id), String(r.status)]));
      assert.equal(byId.get(String(idB)), "SUBMITTED", `B should have transitioned; rows=${JSON.stringify(rows.rows)}`);
      assert.equal(byId.get(String(idA)), "PROPOSED", "A must remain PROPOSED");
    } finally {
      await drop(pool, dbName);
    }
  });
});
