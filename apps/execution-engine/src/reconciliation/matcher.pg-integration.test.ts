/**
 * PR15 — runner matcher unit tests.
 *
 * Regression: a broker order whose `orderRef` merely LOOKS like
 * one of ours (shares the `co-` prefix or even matches a hash
 * prefix) MUST NOT be classified as `BOT_OWNED`. Only exact
 * membership in `broker_order_ref_map` counts.
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
  const dbName = `ikbr_match_${suffix}_${Date.now()}`;
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

suite("Reconciliation matcher — no prefix ownership (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }

  it("spoofed orderRef sharing the co- prefix does NOT create auto_broker_match on an ambiguous PROPOSED row", async () => {
    const { pool, dbName } = await fresh("spoof");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      // Seed an ambiguous PROPOSED row with a specific
      // client_order_id.
      const clientOrderId = "co-owner-real";
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, order_type, quantity, entry,
           stop, take_profit, reason, confidence, risk_check_status,
           status, client_order_id, execution_attempted_at,
           execution_account_id
         ) VALUES (
           'AAPL', '123', 'BUY', 'LMT', 1, 100,
           95, 110, 'test', 0.9, 'PASS',
           'PROPOSED', $1, NOW(), $2
         ) RETURNING id`,
        [clientOrderId, "DU-1"],
      );
      // Broker reports an OPEN order with a lookalike orderRef —
      // same prefix, DIFFERENT payload (nothing in our
      // broker_order_ref_map).
      const parentRef = deriveParentOrderRef(clientOrderId);
      const adapter = new FakeBrokerReconciliationAdapter();
      adapter.configure({
        positions: [],
        openOrders: [
          {
            brokerOrderId: "spoof-123",
            orderRef: parentRef.slice(0, 10) + "-XXX", // shared prefix, different suffix, NOT in ref map
            status: "Submitted",
            symbol: "AAPL",
            conId: "123",
            clientId: 999, // foreign clientId
            observedAt: new Date(),
          },
        ],
        completedOrders: [],
        executions: [],
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
      assert.ok(report, "runOnce returned null");
      // The runner should have created a hold — NOT auto-matched.
      // (recovery_source_missing OR orphan_broker_order OR
      // unknown_submission, depending on coverage; assert none of
      // them resolved via auto_broker_match).
      assert.equal(report!.holdsResolved, 0);
      // The ambiguous row is UNTOUCHED — no leg link created
      // implying a positive match.
      const links = await pool.query(
        `SELECT COUNT(*)::int AS n FROM broker_order_links
          WHERE proposed_order_id = $1`,
        [inserted.rows[0].id],
      );
      assert.equal(links.rows[0].n, 0);
    } finally {
      await drop(pool, dbName);
    }
  });
});
