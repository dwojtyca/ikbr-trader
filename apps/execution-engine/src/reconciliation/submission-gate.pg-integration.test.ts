import { focusedSubmissionTestSessionGuard } from "../session-entry-guard.fixture.js";
/**
 * PR15 — authoritative submission-gate PG integration tests.
 *
 * Proves that when an active reconciliation hold exists for an
 * instrument, `insertProposedFromTicket` refuses the write under
 * the SAME PR14 advisory-lock transaction — no partial row is
 * left behind and no broker call happens.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { ReconciliationRepository } from "./repository.js";
import { buildReconciliationSubmissionGate } from "./submission-gate.js";
import { canonicaliseIdentity } from "./identity.js";

const CONN_URL = process.env.TEST_POSTGRES_URL;
const suite = CONN_URL ? describe : describe.skip;

const ACCOUNT = "DU-gate-test";
const SESSION_A = "sess-A";
const SESSION_B = "sess-B";

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
  const dbName = `ikbr_gate_${suffix}_${Date.now()}`;
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

async function seedCleanRun(
  pool: Pool,
  accountId: string,
  sessionId: string,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO reconciliation_runs (
       account_id, session_id, status, started_at, completed_at,
       snapshot_captured_at, snapshot_complete, source_coverage
     ) VALUES (
       $1, $2, 'CLEAN', NOW(), NOW(), NOW(), TRUE, $3::jsonb
     ) RETURNING id`,
    [
      accountId,
      sessionId,
      JSON.stringify({
        positions: { available: true, boundedWindow: true, timedOut: false, count: 0 },
        openOrders: { available: true, boundedWindow: true, timedOut: false, count: 0 },
        completedOrders: { available: true, boundedWindow: true, timedOut: false, count: 0 },
        executions: {
          available: true,
          timedOut: false,
          count: 0,
          window: {
            from: new Date().toISOString(),
            to: new Date().toISOString(),
            exposureWindowComplete: true,
            recoveryWindowComplete: true,
          },
        },
        session: { available: true, boundedWindow: true, timedOut: false, count: 1 },
      }),
    ],
  );
  return Number(res.rows[0].id);
}

async function seedHold(
  pool: Pool,
  accountId: string,
  identityKey: string,
  runId: number,
  instrument: string,
  reason: string,
): Promise<number> {
  const res = await pool.query<{ id: number }>(
    `INSERT INTO reconciliation_holds (
       account_id, instrument, identity_key, reason, severity,
       reconciliation_run_id, active
     ) VALUES ($1, $2, $3, $4, 'error', $5, TRUE) RETURNING id`,
    [accountId, instrument, identityKey, reason, runId],
  );
  return Number(res.rows[0].id);
}

async function seedFreshSnapshot(
  pool: Pool,
  accountId: string,
  sessionId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO broker_snapshot_syncs (account_id, session_id, observed_at, complete)
     VALUES ($1, $2, NOW(), TRUE)`,
    [accountId, sessionId],
  );
}

suite("Authoritative reconciliation gate — submission tx (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }

  it("active hold on identity blocks insertProposedFromTicket under the SAME advisory lock (no row inserted, no partial state)", async () => {
    const { pool, dbName } = await fresh("hold_blocks");
    try {
      const repo = new ExecutionRepository(pool,undefined,undefined,focusedSubmissionTestSessionGuard);
      const reconRepo = new ReconciliationRepository(pool);
      const runId = await seedCleanRun(pool, ACCOUNT, SESSION_A);
      const identity = canonicaliseIdentity({
        accountId: ACCOUNT,
        conId: "123",
        symbol: "AAPL",
      });
      await seedHold(pool, ACCOUNT, identity.identityKey, runId, "AAPL", "position_mismatch");
      await seedFreshSnapshot(pool, ACCOUNT, SESSION_A);

      const outcome = await repo.insertProposedFromTicket(
        {
          instrument: "AAPL",
          conid: "123",
          side: "BUY",
          orderType: "LMT",
          quantity: 1,
          entry: 100,
          reason: "test",
          confidence: 1,
          riskCheckStatus: "PASS" as never,
        } as never,
        "test",
        {
          clientOrderId: "co-test-1",
          clientOrderHash: "h1",
        },
        {
          kind: "available",
          accountId: ACCOUNT,
          sessionId: SESSION_A,
          maxSnapshotAgeMs: 60_000,
        },
        {
          reconciliationGate: buildReconciliationSubmissionGate({
            maxAgeSeconds: 900,
          }),
        },
      );

      assert.equal(outcome.kind, "reconciliation_hold");
      if (outcome.kind === "reconciliation_hold") {
        assert.equal(outcome.reason, "position_mismatch");
      }
      const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM proposed_orders`);
      assert.equal(rows.rows[0].n, 0);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("wrong-session latest run → reconciliation_unavailable(wrong_session), no INSERT", async () => {
    const { pool, dbName } = await fresh("wrong_session_gate");
    try {
      const repo = new ExecutionRepository(pool,undefined,undefined,focusedSubmissionTestSessionGuard);
      await seedCleanRun(pool, ACCOUNT, SESSION_B);
      await seedFreshSnapshot(pool, ACCOUNT, SESSION_A);

      const outcome = await repo.insertProposedFromTicket(
        {
          instrument: "AAPL",
          conid: "999",
          side: "BUY",
          orderType: "LMT",
          quantity: 1,
          entry: 100,
          reason: "test",
          confidence: 1,
          riskCheckStatus: "PASS" as never,
        } as never,
        "test",
        {
          clientOrderId: "co-test-ws",
          clientOrderHash: "h1",
        },
        {
          kind: "available",
          accountId: ACCOUNT,
          sessionId: SESSION_A,
          maxSnapshotAgeMs: 60_000,
        },
        {
          reconciliationGate: buildReconciliationSubmissionGate({
            maxAgeSeconds: 900,
          }),
        },
      );
      assert.equal(outcome.kind, "reconciliation_unavailable");
      if (outcome.kind === "reconciliation_unavailable") {
        assert.equal(outcome.reason, "reconciliation_wrong_session");
      }
    } finally {
      await drop(pool, dbName);
    }
  });

  it("no run for current session → reconciliation_unavailable(never_ran_in_session)", async () => {
    const { pool, dbName } = await fresh("never_ran_gate");
    try {
      const repo = new ExecutionRepository(pool,undefined,undefined,focusedSubmissionTestSessionGuard);
      await seedFreshSnapshot(pool, ACCOUNT, SESSION_A);

      const outcome = await repo.insertProposedFromTicket(
        {
          instrument: "AAPL",
          conid: "999",
          side: "BUY",
          orderType: "LMT",
          quantity: 1,
          entry: 100,
          reason: "test",
          confidence: 1,
          riskCheckStatus: "PASS" as never,
        } as never,
        "test",
        {
          clientOrderId: "co-test-nr",
          clientOrderHash: "h1",
        },
        {
          kind: "available",
          accountId: ACCOUNT,
          sessionId: SESSION_A,
          maxSnapshotAgeMs: 60_000,
        },
        {
          reconciliationGate: buildReconciliationSubmissionGate({
            maxAgeSeconds: 900,
          }),
        },
      );
      assert.equal(outcome.kind, "reconciliation_unavailable");
      if (outcome.kind === "reconciliation_unavailable") {
        assert.equal(outcome.reason, "reconciliation_never_ran_in_session");
      }
    } finally {
      await drop(pool, dbName);
    }
  });
});
