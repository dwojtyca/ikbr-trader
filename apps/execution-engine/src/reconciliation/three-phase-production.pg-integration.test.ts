/**
 * PR15 §4 — production-flow three-phase submission tests.
 *
 * Unlike `three-phase.pg-integration.test.ts` which validates
 * the low-level `insertPlanLegsAndRefs` primitive, these tests
 * exercise the REAL production atomic method
 * (`ExecutionRepository.tryStartSubmissionWithPlan`) and the
 * REAL production `atomicOperatorLinkAndResolve` snapshot
 * verification path.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
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
  const dbName = `ikbr_3ppf_${suffix}_${Date.now()}`;
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
       status, client_order_id, client_order_hash
     ) VALUES (
       'AAPL', '123', 'BUY', 'LMT', 10, 100, 95, 110, 'test',
       0.9, 'PASS', 'PROPOSED', $1, $2
     ) RETURNING id`,
    [clientOrderId, `hash-${clientOrderId}`],
  );
  return Number(res.rows[0].id);
}

async function seedFlatSnapshot(
  pool: Pool,
  accountId: string,
  sessionId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO broker_snapshot_syncs (
       account_id, session_id, generation, observed_at, complete
     ) VALUES ($1, $2, 1, NOW(), TRUE)`,
    [accountId, sessionId],
  );
}

function legsFor(clientOrderId: string) {
  return [
    {
      role: "PARENT" as const,
      roleOrdinal: 0,
      brokerOrderId: `10001`,
      orderRef: deriveParentOrderRef(clientOrderId),
    },
    {
      role: "TP" as const,
      roleOrdinal: 1,
      brokerOrderId: `10002`,
      orderRef: deriveChildOrderRef(clientOrderId, {
        role: "TP",
        ordinal: 1,
      }),
    },
    {
      role: "SL" as const,
      roleOrdinal: 1,
      brokerOrderId: `10003`,
      orderRef: deriveChildOrderRef(clientOrderId, {
        role: "SL",
        ordinal: 1,
      }),
    },
  ];
}

suite(
  "PR15 §4 — production three-phase (tryStartSubmissionWithPlan)",
  () => {
    if (!CONN_URL) {
      it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
      return;
    }

    it("happy path: atomic claim + full plan persistence in ONE tx", async () => {
      const { pool, dbName } = await fresh("happy");
      try {
        const repo = new ExecutionRepository(pool);
        const cid = "prod-happy-1";
        const po = await seedPO(pool, cid);
        await seedFlatSnapshot(pool, "DU-1", "sess-1");
        const claim = await repo.tryStartSubmissionWithPlan({
          id: po,
          owner: "test-owner",
          instrument: "AAPL",
          conid: "123",
          allowCrossContractExposure: false,
          positionGuard: {
            kind: "available",
            accountId: "DU-1",
            sessionId: "sess-1",
            maxSnapshotAgeMs: 60_000,
          },
          prepared: { clientOrderId: cid, clientOrderHash: "hash-"+cid, instrument: "AAPL", conid: "123", legs: legsFor(cid) },
          accountId: "DU-1",
        });
        assert.equal(claim.kind, "claimed_with_persisted_plan");
        const row = await pool.query(
          `SELECT execution_attempted_at, execution_account_id
             FROM proposed_orders WHERE id=$1`,
          [po],
        );
        assert.ok(row.rows[0].execution_attempted_at instanceof Date);
        assert.equal(row.rows[0].execution_account_id, "DU-1");
        const links = await pool.query(
          `SELECT role, broker_order_id FROM broker_order_links WHERE proposed_order_id=$1`,
          [po],
        );
        assert.equal(links.rowCount, 3);
        const refs = await pool.query(
          `SELECT broker_order_ref FROM broker_order_ref_map WHERE proposed_order_id=$1`,
          [po],
        );
        assert.equal(refs.rowCount, 3);
      } finally {
        await drop(pool, dbName);
      }
    });

    it("collision rollback: preseeded ref → plan_collision, marker NOT set, legs NOT inserted", async () => {
      const { pool, dbName } = await fresh("coll");
      try {
        const repo = new ExecutionRepository(pool);
        const cidA = "prod-coll-A";
        const cidB = "prod-coll-B";
        const poA = await seedPO(pool, cidA);
        const poB = await seedPO(pool, cidB);
        await seedFlatSnapshot(pool, "DU-1", "sess-1");
        // A takes the atomic path first — populates ref map.
        const claimA = await repo.tryStartSubmissionWithPlan({
          id: poA,
          owner: "test-A",
          instrument: "AAPL",
          conid: "123",
          allowCrossContractExposure: false,
          positionGuard: {
            kind: "available",
            accountId: "DU-1",
            sessionId: "sess-1",
            maxSnapshotAgeMs: 60_000,
          },
          prepared: { clientOrderId: cidA, clientOrderHash: "hash-"+cidA, instrument: "AAPL", conid: "123", legs: legsFor(cidA) },
          accountId: "DU-1",
        });
        assert.equal(claimA.kind, "claimed_with_persisted_plan");
        // B's plan collides on A's PARENT ref (artificially
        // injected). Different symbol so exposure guard passes.
        const collide = legsFor(cidB).map((l, i) =>
          i === 0
            ? { ...l, orderRef: deriveParentOrderRef(cidA) }
            : l,
        );
        const claimB = await repo.tryStartSubmissionWithPlan({
          id: poB,
          owner: "test-B",
          instrument: "MSFT",
          conid: "456",
          allowCrossContractExposure: false,
          positionGuard: {
            kind: "available",
            accountId: "DU-1",
            sessionId: "sess-1",
            maxSnapshotAgeMs: 60_000,
          },
          prepared: { clientOrderId: cidB, clientOrderHash: "hash-"+cidB, instrument: "AAPL", conid: "123", legs: collide },
          accountId: "DU-1",
        });
        assert.equal(claimB.kind, "plan_collision");
        // B's row MUST NOT have a marker and MUST NOT have any
        // leg / ref rows (full rollback).
        const bRow = await pool.query(
          `SELECT execution_attempted_at FROM proposed_orders WHERE id=$1`,
          [poB],
        );
        assert.equal(bRow.rows[0].execution_attempted_at, null);
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
      } finally {
        await drop(pool, dbName);
      }
    });

    it("already-claimed row → not_claimed, no state change", async () => {
      const { pool, dbName } = await fresh("nc");
      try {
        const repo = new ExecutionRepository(pool);
        const cid = "prod-nc-1";
        const po = await seedPO(pool, cid);
        await seedFlatSnapshot(pool, "DU-1", "sess-1");
        // First call claims + persists plan.
        const first = await repo.tryStartSubmissionWithPlan({
          id: po,
          owner: "first",
          instrument: "AAPL",
          conid: "123",
          allowCrossContractExposure: false,
          positionGuard: {
            kind: "available",
            accountId: "DU-1",
            sessionId: "sess-1",
            maxSnapshotAgeMs: 60_000,
          },
          prepared: { clientOrderId: cid, clientOrderHash: "hash-"+cid, instrument: "AAPL", conid: "123", legs: legsFor(cid) },
          accountId: "DU-1",
        });
        assert.equal(first.kind, "claimed_with_persisted_plan");
        // Second call — same id — the marker is set, IS NULL
        // guard fails, tx rolls back cleanly. Because we pass
        // the SAME plan, refs are not the source of the failure
        // (marker check fires first).
        const second = await repo.tryStartSubmissionWithPlan({
          id: po,
          owner: "second",
          instrument: "AAPL",
          conid: "123",
          allowCrossContractExposure: false,
          positionGuard: {
            kind: "available",
            accountId: "DU-1",
            sessionId: "sess-1",
            maxSnapshotAgeMs: 60_000,
          },
          prepared: { clientOrderId: cid, clientOrderHash: "hash-"+cid, instrument: "AAPL", conid: "123", legs: legsFor(cid) },
          accountId: "DU-1",
        });
        assert.equal(second.kind, "not_claimed");
        const linkCount = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text n FROM broker_order_links WHERE proposed_order_id=$1`,
          [po],
        );
        assert.equal(linkCount.rows[0].n, "3");
      } finally {
        await drop(pool, dbName);
      }
    });
  },
);

suite(
  "PR15 §4 — atomicOperatorLinkAndResolve snapshot verification (PG)",
  () => {
    if (!CONN_URL) {
      it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
      return;
    }

    async function seedHoldAndPO(
      pool: Pool,
      accountId: string,
    ): Promise<{ holdId: number; poId: number; runId: number }> {
      const poId = await seedPO(pool, `snap-po-${Date.now()}`);
      const runRes = await pool.query<{ id: number }>(
        `INSERT INTO reconciliation_runs (
           account_id, session_id, status, snapshot_complete, completed_at, report
         ) VALUES ($1, 'sess-1', 'CLEAN', TRUE, NOW(), '{}'::jsonb)
         RETURNING id`,
        [accountId],
      );
      const runId = Number(runRes.rows[0].id);
      // PR15 r5 §1 — correlated observation row (all three
      // identifiers from ONE broker record).
      await pool.query(
        `INSERT INTO reconciliation_broker_order_observations (
           reconciliation_run_id, account_id, session_id, source,
           broker_order_id, perm_id, order_ref, broker_status, observed_at
         ) VALUES ($1,$2,'sess-1','OPEN_ORDER','77001','p-77001','co-observed-parent','Submitted', NOW())`,
        [runId, accountId],
      );
      const holdRes = await pool.query<{ id: number }>(
        `INSERT INTO reconciliation_holds (
           account_id, instrument, identity_key, reason, severity,
           reconciliation_run_id, payload
         ) VALUES ($1, 'AAPL', 'sym:AAPL', 'unknown_submission', 'error', $2, $3::jsonb)
         RETURNING id`,
        [accountId, runId, JSON.stringify({ proposedOrderId: poId })],
      );
      return { holdId: Number(holdRes.rows[0].id), poId, runId };
    }

    it("success: brokerOrderId observed in latest session snapshot", async () => {
      const { pool, dbName } = await fresh("lnkok");
      try {
        const reconRepo = new ReconciliationRepository(pool);
        const seed = await seedHoldAndPO(pool, "DU-1");
        const outcome = await reconRepo.atomicOperatorLinkAndResolve({
          holdId: seed.holdId,
          proposedOrderId: seed.poId,
          accountId: "DU-1",
          brokerOrderId: "77001",
          permId: "p-77001",
          orderRef: "co-observed-parent",
          resolvedBy: "test",
          resolutionNote: "link ok",
          currentSessionId: "sess-1",
          snapshotMaxAgeSeconds: 60,
        });
        assert.equal(outcome.ok, true);
        const hold = await pool.query(
          `SELECT active FROM reconciliation_holds WHERE id=$1`,
          [seed.holdId],
        );
        assert.equal(hold.rows[0].active, false);
      } finally {
        await drop(pool, dbName);
      }
    });

    it("refuse: brokerOrderId absent from snapshot → broker_order_not_observed", async () => {
      const { pool, dbName } = await fresh("lnknot");
      try {
        const reconRepo = new ReconciliationRepository(pool);
        const seed = await seedHoldAndPO(pool, "DU-1");
        const outcome = await reconRepo.atomicOperatorLinkAndResolve({
          holdId: seed.holdId,
          proposedOrderId: seed.poId,
          accountId: "DU-1",
          brokerOrderId: "99999",
          permId: null,
          orderRef: null,
          resolvedBy: "test",
          resolutionNote: "should refuse",
          currentSessionId: "sess-1",
          snapshotMaxAgeSeconds: 60,
        });
        assert.equal(outcome.ok, false);
        if (outcome.ok === false) {
          assert.equal(outcome.reason, "broker_order_not_observed");
        }
        const hold = await pool.query(
          `SELECT active FROM reconciliation_holds WHERE id=$1`,
          [seed.holdId],
        );
        assert.equal(hold.rows[0].active, true);
      } finally {
        await drop(pool, dbName);
      }
    });

    it("refuse: no complete snapshot for current session → no_complete_snapshot_for_session", async () => {
      const { pool, dbName } = await fresh("lnkws");
      try {
        const reconRepo = new ReconciliationRepository(pool);
        const seed = await seedHoldAndPO(pool, "DU-1");
        const outcome = await reconRepo.atomicOperatorLinkAndResolve({
          holdId: seed.holdId,
          proposedOrderId: seed.poId,
          accountId: "DU-1",
          brokerOrderId: "77001",
          permId: null,
          orderRef: null,
          resolvedBy: "test",
          resolutionNote: "wrong session",
          // Different session than the one that recorded the run
          currentSessionId: "sess-OTHER",
          snapshotMaxAgeSeconds: 60,
        });
        assert.equal(outcome.ok, false);
        if (outcome.ok === false) {
          assert.equal(outcome.reason, "no_complete_snapshot_for_session");
        }
      } finally {
        await drop(pool, dbName);
      }
    });

    it("refuse: stale snapshot → snapshot_stale", async () => {
      const { pool, dbName } = await fresh("lnkst");
      try {
        const reconRepo = new ReconciliationRepository(pool);
        const seed = await seedHoldAndPO(pool, "DU-1");
        // Age the run.
        await pool.query(
          `UPDATE reconciliation_runs SET completed_at = NOW() - INTERVAL '10 minutes' WHERE id=$1`,
          [seed.runId],
        );
        const outcome = await reconRepo.atomicOperatorLinkAndResolve({
          holdId: seed.holdId,
          proposedOrderId: seed.poId,
          accountId: "DU-1",
          brokerOrderId: "77001",
          permId: null,
          orderRef: null,
          resolvedBy: "test",
          resolutionNote: "stale",
          currentSessionId: "sess-1",
          snapshotMaxAgeSeconds: 60,
        });
        assert.equal(outcome.ok, false);
        if (outcome.ok === false) {
          assert.equal(outcome.reason, "snapshot_stale");
        }
      } finally {
        await drop(pool, dbName);
      }
    });
  },
);
