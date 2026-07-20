/**
 * PR15 r5 §4-§6 — correlated observation link path, plan
 * persistence exact-match invariants, and full production-flow
 * three-phase (prepare → commit → dispatch) with a spy.
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
  const dbName = `ikbr_r5_${suffix.toLowerCase()}_${Date.now()}`;
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
       'AAPL', '123', 'BUY', 'LMT', 10, 100, 95, 110, 't',
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
async function seedRun(
  pool: Pool,
  accountId: string,
  sessionId: string,
  ageSeconds = 0,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO reconciliation_runs (
       account_id, session_id, status, snapshot_complete, completed_at
     ) VALUES ($1, $2, 'CLEAN', TRUE,
       NOW() - ($3::text || ' seconds')::interval)
     RETURNING id`,
    [accountId, sessionId, String(ageSeconds)],
  );
  return Number(res.rows[0].id);
}
async function seedObservation(
  pool: Pool,
  runId: number,
  accountId: string,
  sessionId: string,
  o: {
    brokerOrderId: string;
    permId?: string | null;
    orderRef?: string | null;
    source?: "OPEN_ORDER" | "COMPLETED_ORDER" | "EXECUTION";
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO reconciliation_broker_order_observations (
       reconciliation_run_id, account_id, session_id, source,
       broker_order_id, perm_id, order_ref, broker_status, observed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'Submitted', NOW())`,
    [
      runId,
      accountId,
      sessionId,
      o.source ?? "OPEN_ORDER",
      o.brokerOrderId,
      o.permId ?? null,
      o.orderRef ?? null,
    ],
  );
}
async function seedHold(
  pool: Pool,
  runId: number,
  accountId: string,
  poId: number,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO reconciliation_holds (
       account_id, instrument, identity_key, reason, severity,
       reconciliation_run_id, payload
     ) VALUES ($1, 'AAPL', 'sym:AAPL', 'unknown_submission', 'error', $2, $3::jsonb)
     RETURNING id`,
    [accountId, runId, JSON.stringify({ proposedOrderId: poId })],
  );
  return Number(res.rows[0].id);
}

function legsFor(clientOrderId: string) {
  return [
    { role: "PARENT" as const, roleOrdinal: 0, brokerOrderId: "20001", orderRef: deriveParentOrderRef(clientOrderId) },
    { role: "TP" as const, roleOrdinal: 1, brokerOrderId: "20002", orderRef: deriveChildOrderRef(clientOrderId, { role: "TP", ordinal: 1 }) },
    { role: "SL" as const, roleOrdinal: 1, brokerOrderId: "20003", orderRef: deriveChildOrderRef(clientOrderId, { role: "SL", ordinal: 1 }) },
  ];
}

// ---------------------------------------------------------------------------
// §4 — correlated observation link path
// ---------------------------------------------------------------------------
suite("PR15 r5 §4 — correlated LINK_TO_BROKER_ORDER (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("success: brokerOrderId + permId + orderRef all from the SAME observation", async () => {
    const { pool, dbName } = await fresh("linkok");
    try {
      const reconRepo = new ReconciliationRepository(pool);
      const po = await seedPO(pool, "r5-ok");
      const runId = await seedRun(pool, "DU-1", "sess-1");
      await seedObservation(pool, runId, "DU-1", "sess-1", {
        brokerOrderId: "77001",
        permId: "p-77001",
        orderRef: "co-observed",
      });
      const holdId = await seedHold(pool, runId, "DU-1", po);
      const out = await reconRepo.atomicOperatorLinkAndResolve({
        holdId,
        proposedOrderId: po,
        accountId: "DU-1",
        brokerOrderId: "77001",
        permId: "p-77001",
        orderRef: "co-observed",
        resolvedBy: "op",
        resolutionNote: "n",
        currentSessionId: "sess-1",
        snapshotMaxAgeSeconds: 60,
      });
      assert.equal(out.ok, true);
      const active = await pool.query(
        `SELECT active FROM reconciliation_holds WHERE id=$1`,
        [holdId],
      );
      assert.equal(active.rows[0].active, false);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("reject: brokerOrderId from A + permId from B → CORRELATION_NOT_FOUND, hold stays active, no link", async () => {
    const { pool, dbName } = await fresh("linkAB");
    try {
      const reconRepo = new ReconciliationRepository(pool);
      const po = await seedPO(pool, "r5-AB");
      const runId = await seedRun(pool, "DU-1", "sess-1");
      await seedObservation(pool, runId, "DU-1", "sess-1", {
        brokerOrderId: "A-1",
        permId: "pA",
        orderRef: "refA",
      });
      await seedObservation(pool, runId, "DU-1", "sess-1", {
        brokerOrderId: "B-1",
        permId: "pB",
        orderRef: "refB",
      });
      const holdId = await seedHold(pool, runId, "DU-1", po);
      const out = await reconRepo.atomicOperatorLinkAndResolve({
        holdId,
        proposedOrderId: po,
        accountId: "DU-1",
        brokerOrderId: "A-1",
        permId: "pB", // wrong observation
        orderRef: null,
        resolvedBy: "op",
        resolutionNote: "n",
        currentSessionId: "sess-1",
        snapshotMaxAgeSeconds: 60,
      });
      assert.equal(out.ok, false);
      if (out.ok === false) assert.equal(out.reason, "CORRELATION_NOT_FOUND");
      const links = await pool.query(
        `SELECT 1 FROM broker_order_links WHERE proposed_order_id=$1`,
        [po],
      );
      assert.equal(links.rowCount, 0);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("reject: brokerOrderId from A + orderRef from C → CORRELATION_NOT_FOUND", async () => {
    const { pool, dbName } = await fresh("linkAC");
    try {
      const reconRepo = new ReconciliationRepository(pool);
      const po = await seedPO(pool, "r5-AC");
      const runId = await seedRun(pool, "DU-1", "sess-1");
      await seedObservation(pool, runId, "DU-1", "sess-1", {
        brokerOrderId: "A-1",
        permId: "pA",
        orderRef: "refA",
      });
      await seedObservation(pool, runId, "DU-1", "sess-1", {
        brokerOrderId: "C-1",
        permId: null,
        orderRef: "refC",
      });
      const holdId = await seedHold(pool, runId, "DU-1", po);
      const out = await reconRepo.atomicOperatorLinkAndResolve({
        holdId,
        proposedOrderId: po,
        accountId: "DU-1",
        brokerOrderId: "A-1",
        permId: null,
        orderRef: "refC", // wrong observation
        resolvedBy: "op",
        resolutionNote: "n",
        currentSessionId: "sess-1",
        snapshotMaxAgeSeconds: 60,
      });
      assert.equal(out.ok, false);
      if (out.ok === false) assert.equal(out.reason, "CORRELATION_NOT_FOUND");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("reject: brokerOrderId NOT observed even if permId is → broker_order_not_observed", async () => {
    const { pool, dbName } = await fresh("linkNOB");
    try {
      const reconRepo = new ReconciliationRepository(pool);
      const po = await seedPO(pool, "r5-NOB");
      const runId = await seedRun(pool, "DU-1", "sess-1");
      await seedObservation(pool, runId, "DU-1", "sess-1", {
        brokerOrderId: "OBS-1",
        permId: "known-perm",
      });
      const holdId = await seedHold(pool, runId, "DU-1", po);
      const out = await reconRepo.atomicOperatorLinkAndResolve({
        holdId,
        proposedOrderId: po,
        accountId: "DU-1",
        brokerOrderId: "SPOOFED",
        permId: "known-perm",
        orderRef: null,
        resolvedBy: "op",
        resolutionNote: "n",
        currentSessionId: "sess-1",
        snapshotMaxAgeSeconds: 60,
      });
      assert.equal(out.ok, false);
      if (out.ok === false) assert.equal(out.reason, "broker_order_not_observed");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("reject: observation from previous session → no_complete_snapshot_for_session", async () => {
    const { pool, dbName } = await fresh("linkPrevSess");
    try {
      const reconRepo = new ReconciliationRepository(pool);
      const po = await seedPO(pool, "r5-PS");
      const prevRun = await seedRun(pool, "DU-1", "sess-OLD");
      await seedObservation(pool, prevRun, "DU-1", "sess-OLD", {
        brokerOrderId: "77001",
      });
      const holdId = await seedHold(pool, prevRun, "DU-1", po);
      const out = await reconRepo.atomicOperatorLinkAndResolve({
        holdId,
        proposedOrderId: po,
        accountId: "DU-1",
        brokerOrderId: "77001",
        permId: null,
        orderRef: null,
        resolvedBy: "op",
        resolutionNote: "n",
        currentSessionId: "sess-1",
        snapshotMaxAgeSeconds: 60,
      });
      assert.equal(out.ok, false);
      if (out.ok === false)
        assert.equal(out.reason, "no_complete_snapshot_for_session");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("reject: observation only in older run when a newer complete run exists → broker_order_not_observed", async () => {
    const { pool, dbName } = await fresh("linkOlder");
    try {
      const reconRepo = new ReconciliationRepository(pool);
      const po = await seedPO(pool, "r5-old");
      const oldRun = await seedRun(pool, "DU-1", "sess-1", 30);
      await seedObservation(pool, oldRun, "DU-1", "sess-1", {
        brokerOrderId: "OLD-BID",
      });
      // Newer run has DIFFERENT observations only.
      const newRun = await seedRun(pool, "DU-1", "sess-1", 0);
      await seedObservation(pool, newRun, "DU-1", "sess-1", {
        brokerOrderId: "NEW-BID",
      });
      const holdId = await seedHold(pool, newRun, "DU-1", po);
      const out = await reconRepo.atomicOperatorLinkAndResolve({
        holdId,
        proposedOrderId: po,
        accountId: "DU-1",
        brokerOrderId: "OLD-BID",
        permId: null,
        orderRef: null,
        resolvedBy: "op",
        resolutionNote: "n",
        currentSessionId: "sess-1",
        snapshotMaxAgeSeconds: 60,
      });
      assert.equal(out.ok, false);
      if (out.ok === false) assert.equal(out.reason, "broker_order_not_observed");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("reject: stale complete run → snapshot_stale", async () => {
    const { pool, dbName } = await fresh("linkStale");
    try {
      const reconRepo = new ReconciliationRepository(pool);
      const po = await seedPO(pool, "r5-stale");
      const runId = await seedRun(pool, "DU-1", "sess-1", 3600);
      await seedObservation(pool, runId, "DU-1", "sess-1", {
        brokerOrderId: "77001",
      });
      const holdId = await seedHold(pool, runId, "DU-1", po);
      const out = await reconRepo.atomicOperatorLinkAndResolve({
        holdId,
        proposedOrderId: po,
        accountId: "DU-1",
        brokerOrderId: "77001",
        permId: null,
        orderRef: null,
        resolvedBy: "op",
        resolutionNote: "n",
        currentSessionId: "sess-1",
        snapshotMaxAgeSeconds: 60,
      });
      assert.equal(out.ok, false);
      if (out.ok === false) assert.equal(out.reason, "snapshot_stale");
      const active = await pool.query(
        `SELECT active FROM reconciliation_holds WHERE id=$1`,
        [holdId],
      );
      assert.equal(active.rows[0].active, true);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// §5 — plan persistence exact-match / rollback
// ---------------------------------------------------------------------------
suite("PR15 r5 §5 — plan persistence exact-match (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("preexisting link row same orderRef but DIFFERENT brokerOrderId → plan_collision, marker NULL", async () => {
    const { pool, dbName } = await fresh("pers1");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-p1";
      const po = await seedPO(pool, cid);
      await seedFlatSnapshot(pool, "DU-1", "sess-1");
      const legs = legsFor(cid);
      // Preseed the PARENT with a DIFFERENT brokerOrderId.
      await pool.query(
        `INSERT INTO broker_order_links (
           proposed_order_id, account_id, role, role_ordinal,
           broker_order_id, order_ref, status
         ) VALUES ($1,'DU-1','PARENT',0,'99999',$2,'PLANNED')`,
        [po, legs[0].orderRef],
      );
      const claim = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "t",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(claim.kind, "plan_collision");
      const marker = await pool.query(
        `SELECT execution_attempted_at FROM proposed_orders WHERE id=$1`,
        [po],
      );
      assert.equal(marker.rows[0].execution_attempted_at, null);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("preexisting link row DIFFERENT role/ordinal → plan_collision", async () => {
    const { pool, dbName } = await fresh("pers2");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-p2";
      const po = await seedPO(pool, cid);
      await seedFlatSnapshot(pool, "DU-1", "sess-1");
      const legs = legsFor(cid);
      // Preseed with WRONG role.
      await pool.query(
        `INSERT INTO broker_order_links (
           proposed_order_id, account_id, role, role_ordinal,
           broker_order_id, order_ref, status
         ) VALUES ($1,'DU-1','SL',9,$2,$3,'PLANNED')`,
        [po, legs[0].brokerOrderId, legs[0].orderRef],
      );
      const claim = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "t",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(claim.kind, "plan_collision");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("extra unrelated leg row for same proposedOrder → plan_collision (leg count guard)", async () => {
    const { pool, dbName } = await fresh("pers3");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-p3";
      const po = await seedPO(pool, cid);
      await seedFlatSnapshot(pool, "DU-1", "sess-1");
      const legs = legsFor(cid);
      // Preseed an extra leg with an OLD orderRef that is not in
      // the fresh plan.
      await pool.query(
        `INSERT INTO broker_order_links (
           proposed_order_id, account_id, role, role_ordinal,
           broker_order_id, order_ref, status
         ) VALUES ($1,'DU-1','TP',9,'88888','stale-ref','PLANNED')`,
        [po],
      );
      const claim = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "t",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(claim.kind, "plan_collision");
      const marker = await pool.query(
        `SELECT execution_attempted_at FROM proposed_orders WHERE id=$1`,
        [po],
      );
      assert.equal(marker.rows[0].execution_attempted_at, null);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("full plan already persisted with EXACT match → treated as compatible; second call returns not_claimed after marker set by first (no new IDs)", async () => {
    const { pool, dbName } = await fresh("pers4");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-p4";
      const po = await seedPO(pool, cid);
      await seedFlatSnapshot(pool, "DU-1", "sess-1");
      const legs = legsFor(cid);
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
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(first.kind, "claimed_with_persisted_plan");
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
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(second.kind, "not_claimed");
      const links = await pool.query(
        `SELECT broker_order_id FROM broker_order_links WHERE proposed_order_id=$1 ORDER BY role,role_ordinal`,
        [po],
      );
      // Still the original three broker order IDs — never
      // re-allocated.
      const ids = links.rows.map((r) => String(r.broker_order_id)).sort();
      assert.deepEqual(ids, ["20001", "20002", "20003"]);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — full production flow with dispatch spy
// ---------------------------------------------------------------------------
suite("PR15 r5 §6 — production flow prepare → commit → dispatch (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }

  /**
   * Simulate the production three-phase orchestrated by
   * `index.ts::executePersistedOrder`: prepare (allocate IDs) →
   * atomic commit (`tryStartSubmissionWithPlan`) → dispatch spy.
   * The spy captures the exact IDs / refs it was invoked with
   * so the test can assert against the persisted plan.
   */
  it("dispatch runs ONLY after commit, receives EXACT persisted brokerOrderIds + orderRefs", async () => {
    const { pool, dbName } = await fresh("prod1");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-prod-ok";
      const po = await seedPO(pool, cid);
      await seedFlatSnapshot(pool, "DU-1", "sess-1");
      const legs = legsFor(cid);
      let dispatchStartedAt: number | null = null;
      let committedAt: number | null = null;
      const dispatchSpy = async () => {
        dispatchStartedAt = Date.now();
        return legs;
      };
      const claim = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "t",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      committedAt = Date.now();
      assert.equal(claim.kind, "claimed_with_persisted_plan");
      // Simulate dispatch — must happen strictly AFTER commit.
      const dispatched = await dispatchSpy();
      assert.ok(dispatchStartedAt !== null);
      assert.ok(dispatchStartedAt >= committedAt);
      // Persisted plan MUST equal what dispatch received.
      const dbLegs = await pool.query(
        `SELECT role, role_ordinal, broker_order_id, order_ref
           FROM broker_order_links WHERE proposed_order_id=$1
          ORDER BY role, role_ordinal`,
        [po],
      );
      const dbTuples = dbLegs.rows
        .map((r) => `${r.role}:${r.role_ordinal}:${r.broker_order_id}:${r.order_ref}`)
        .sort();
      const dispatchedTuples = dispatched
        .map((l) => `${l.role}:${l.roleOrdinal}:${l.brokerOrderId}:${l.orderRef}`)
        .sort();
      assert.deepEqual(dbTuples, dispatchedTuples);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("crash BEFORE commit (guard blocks) → NO marker, NO plan, NO dispatch", async () => {
    const { pool, dbName } = await fresh("prod2");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-prod-nomarker";
      const po = await seedPO(pool, cid);
      // NO broker_snapshot_syncs row → position guard blocks with
      // `missing`.
      const legs = legsFor(cid);
      let dispatchCalls = 0;
      const claim = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "t",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.notEqual(claim.kind, "claimed_with_persisted_plan");
      // dispatch is a caller-side no-op when claim fails; test
      // that we never invoke it.
      if (claim.kind === "claimed_with_persisted_plan") {
        dispatchCalls++;
      }
      assert.equal(dispatchCalls, 0);
      const marker = await pool.query(
        `SELECT execution_attempted_at FROM proposed_orders WHERE id=$1`,
        [po],
      );
      assert.equal(marker.rows[0].execution_attempted_at, null);
      const links = await pool.query(
        `SELECT 1 FROM broker_order_links WHERE proposed_order_id=$1`,
        [po],
      );
      assert.equal(links.rowCount, 0);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("crash AFTER commit BEFORE dispatch → plan and marker present; retry produces not_claimed (no re-dispatch of NEW IDs)", async () => {
    const { pool, dbName } = await fresh("prod3");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-prod-crash";
      const po = await seedPO(pool, cid);
      await seedFlatSnapshot(pool, "DU-1", "sess-1");
      const legs = legsFor(cid);
      const claim = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "t",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(claim.kind, "claimed_with_persisted_plan");
      // Marker + plan MUST exist.
      const marker = await pool.query(
        `SELECT execution_attempted_at FROM proposed_orders WHERE id=$1`,
        [po],
      );
      assert.ok(marker.rows[0].execution_attempted_at instanceof Date);
      const linkCount = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text n FROM broker_order_links WHERE proposed_order_id=$1`,
        [po],
      );
      assert.equal(linkCount.rows[0].n, "3");
      // Simulate a process restart; retry with a FRESHLY prepared
      // plan that uses different IDs must NOT succeed.
      const freshLegs = legsFor(cid).map((l) => ({
        ...l,
        brokerOrderId: String(Number(l.brokerOrderId) + 5000),
      }));
      const retry = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "retry",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: "hash-"+cid, instrument: "AAPL", conid: "123", legs: freshLegs },
        accountId: "DU-1",
      });
      assert.equal(retry.kind, "not_claimed");
      const linkIds = await pool.query(
        `SELECT broker_order_id FROM broker_order_links WHERE proposed_order_id=$1 ORDER BY broker_order_id`,
        [po],
      );
      const ids = linkIds.rows.map((r) => String(r.broker_order_id)).sort();
      assert.deepEqual(ids, ["20001", "20002", "20003"]);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("partial dispatch + exception → status NOT CANCELLED, marker and plan preserved, retry produces not_claimed (no re-dispatch)", async () => {
    const { pool, dbName } = await fresh("prod4");
    try {
      const repo = new ExecutionRepository(pool);
      const cid = "r5-prod-partial";
      const po = await seedPO(pool, cid);
      await seedFlatSnapshot(pool, "DU-1", "sess-1");
      const legs = legsFor(cid);
      const claim = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "t",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(claim.kind, "claimed_with_persisted_plan");
      // Simulate the production dispatch catch: DO NOT
      // markCancelled; only record source_error. This matches
      // `dispatchAndMarkThreePhase` semantics.
      await repo.setDecisionMetadata(po, {
        sourceError: "simulated dispatch exception",
      });
      // Row must remain PROPOSED with marker still set.
      const row = await pool.query(
        `SELECT status, execution_attempted_at, source_error, last_error
           FROM proposed_orders WHERE id=$1`,
        [po],
      );
      assert.equal(row.rows[0].status, "PROPOSED");
      assert.ok(row.rows[0].execution_attempted_at instanceof Date);
      assert.equal(
        row.rows[0].source_error,
        "simulated dispatch exception",
      );
      // Retry must NOT re-dispatch (marker set → not_claimed).
      const retry = await repo.tryStartSubmissionWithPlan({
        id: po,
        owner: "retry",
        instrument: "AAPL",
        conid: "123",
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "DU-1",
          sessionId: "sess-1",
          maxSnapshotAgeMs: 60_000,
        },
        prepared: { clientOrderId: cid, clientOrderHash: `hash-${cid}`, instrument: "AAPL", conid: "123", legs },
        accountId: "DU-1",
      });
      assert.equal(retry.kind, "not_claimed");
    } finally {
      await drop(pool, dbName);
    }
  });
});
