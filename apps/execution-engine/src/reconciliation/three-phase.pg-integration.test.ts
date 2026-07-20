/**
 * PR15 §4 — three-phase submission tests (prepare + persist +
 * dispatch). Exercised through the runtime path — `prepare` +
 * `persistPreparedPlan` invariants are validated via direct
 * PG queries after seeding a fake plan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

import { runMigrations } from "../migrations.js";
import { ReconciliationRepository } from "./repository.js";
import { deriveChildOrderRef, deriveParentOrderRef } from "./order-ref.js";

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
  const dbName = `ikbr_3phase_${suffix}_${Date.now()}`;
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

async function seedPO(pool: Pool, clientOrderId: string): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO proposed_orders (
       instrument, conid, side, order_type, quantity, entry,
       stop, take_profit, reason, confidence, risk_check_status,
       status, client_order_id
     ) VALUES (
       'AAPL', '123', 'BUY', 'LMT', 10, 100, 95, 110, 'test',
       0.9, 'PASS', 'PROPOSED', $1
     ) RETURNING id`,
    [clientOrderId],
  );
  return Number(res.rows[0].id);
}

suite("Three-phase submission — Phase B persistence (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }

  it("happy path: parent + 2 TP + 2 SL legs persisted BEFORE broker call (all 5 refs in map)", async () => {
    const { pool, dbName } = await fresh("happy");
    try {
      const cid = "co-happy-1";
      const po = await seedPO(pool, cid);
      const reconRepo = new ReconciliationRepository(pool);
      const legs = [
        { role: "PARENT" as const, roleOrdinal: 0, orderRef: deriveParentOrderRef(cid) },
        { role: "TP" as const, roleOrdinal: 1, orderRef: deriveChildOrderRef(cid, { role: "TP", ordinal: 1 }) },
        { role: "SL" as const, roleOrdinal: 1, orderRef: deriveChildOrderRef(cid, { role: "SL", ordinal: 1 }) },
        { role: "TP" as const, roleOrdinal: 2, orderRef: deriveChildOrderRef(cid, { role: "TP", ordinal: 2 }) },
        { role: "SL" as const, roleOrdinal: 2, orderRef: deriveChildOrderRef(cid, { role: "SL", ordinal: 2 }) },
      ];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const outcome = await reconRepo.insertPlanLegsAndRefs(client, {
          proposedOrderId: po,
          clientOrderId: cid,
          accountId: "DU-1",
          legs,
        });
        assert.equal(outcome.ok, true);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const links = await pool.query(
        `SELECT role, role_ordinal, order_ref FROM broker_order_links
          WHERE proposed_order_id=$1 ORDER BY role, role_ordinal`,
        [po],
      );
      assert.equal(links.rowCount, 5);
      const refs = await pool.query(
        `SELECT broker_order_ref FROM broker_order_ref_map
          WHERE proposed_order_id=$1 ORDER BY broker_order_ref`,
        [po],
      );
      assert.equal(refs.rowCount, 5);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("collision rollback: pre-seed one child ref for a FOREIGN order → insertPlanLegsAndRefs returns ok=false + collidedRefs, tx must roll back", async () => {
    const { pool, dbName } = await fresh("collision");
    try {
      const cidA = "co-owner-A";
      const cidB = "co-owner-B";
      const poA = await seedPO(pool, cidA);
      const poB = await seedPO(pool, cidB);
      const reconRepo = new ReconciliationRepository(pool);
      // Pre-seed A's parent ref via a completed transaction.
      const seedRefA = deriveParentOrderRef(cidA);
      {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await reconRepo.insertPlanLegsAndRefs(c, {
            proposedOrderId: poA,
            clientOrderId: cidA,
            accountId: "DU-1",
            legs: [{ role: "PARENT", roleOrdinal: 0, orderRef: seedRefA }],
          });
          await c.query("COMMIT");
        } finally {
          c.release();
        }
      }
      // B tries to insert a plan whose CHILD ref happens to
      // clash with A's parent ref — simulate by injecting the
      // same string.
      const collidingChild = seedRefA; // artificial collision
      const legs = [
        { role: "PARENT" as const, roleOrdinal: 0, orderRef: deriveParentOrderRef(cidB) },
        { role: "TP" as const, roleOrdinal: 1, orderRef: collidingChild },
      ];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const outcome = await reconRepo.insertPlanLegsAndRefs(client, {
          proposedOrderId: poB,
          clientOrderId: cidB,
          accountId: "DU-1",
          legs,
        });
        assert.equal(outcome.ok, false);
        assert.deepEqual(outcome.collidedRefs, [collidingChild]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      // After rollback: B has NO leg rows and NO new ref-map
      // entries. Original A row unaffected.
      const bLinks = await pool.query(
        `SELECT 1 FROM broker_order_links WHERE proposed_order_id=$1`,
        [poB],
      );
      assert.equal(bLinks.rowCount, 0);
      const bRefs = await pool.query(
        `SELECT 1 FROM broker_order_ref_map WHERE proposed_order_id=$1`,
        [poB],
      );
      assert.equal(bRefs.rowCount, 0);
      const aRef = await pool.query(
        `SELECT proposed_order_id::text AS pid
           FROM broker_order_ref_map WHERE broker_order_ref=$1`,
        [seedRefA],
      );
      assert.equal(aRef.rows[0].pid, String(poA));
    } finally {
      await drop(pool, dbName);
    }
  });
});
