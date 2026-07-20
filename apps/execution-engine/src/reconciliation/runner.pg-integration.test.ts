/**
 * PR15 — PostgreSQL integration tests for reconciliation runner
 * + repository.
 *
 * Gated on `TEST_POSTGRES_URL`. Uses hermetic per-suite databases.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { ReconciliationRepository } from "./repository.js";
import { ReconciliationRunner } from "./runner.js";
import { FakeBrokerReconciliationAdapter } from "./fake-broker-adapter.js";
import {
  evaluateReconciliationGate,
  classifyReadiness,
} from "./gate.js";

const CONN_URL = process.env.TEST_POSTGRES_URL;
const suite = CONN_URL ? describe : describe.skip;

const ACCOUNT_ID = "DU-recon-test";
const SESSION_A = "sess-A";
const SESSION_B = "sess-B";

function poolForDb(url: string, dbName: string): Pool {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return new Pool({ connectionString: parsed.toString() });
}

async function withAdmin<T>(url: string, fn: (p: Pool) => Promise<T>): Promise<T> {
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  const admin = new Pool({ connectionString: parsed.toString() });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function freshDb(suffix: string): Promise<{ pool: Pool; dbName: string }> {
  const dbName = `ikbr_recon_${suffix}_${Date.now()}`;
  await withAdmin(CONN_URL!, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  });
  const pool = poolForDb(CONN_URL!, dbName);
  await runMigrations(pool);
  return { pool, dbName };
}

async function drop(pool: Pool, dbName: string): Promise<void> {
  await pool.end();
  await withAdmin(CONN_URL!, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  });
}

suite("Reconciliation runner + repository (PG integration)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }

  it("clean CLEAN run publishes RUNNING then CLEAN and returns healthy readiness", async () => {
    const { pool, dbName } = await freshDb("clean");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      const adapter = new FakeBrokerReconciliationAdapter();
      const runner = new ReconciliationRunner(pool, repo, reconRepo, adapter);
      const report = await runner.runOnce(
        {
          accountId: ACCOUNT_ID,
          sessionId: SESSION_A,
          sessionStartedAt: new Date(),
        },
        {
          runTimeoutMs: 5_000,
          sourceTimeoutMs: 1_000,
          executionSafetyMarginMs: 60_000,
        },
      );
      assert.ok(report, "runOnce should return a report");
      assert.equal(report!.status, "CLEAN");
      assert.equal(report!.exposureComplete, true);
      assert.equal(report!.recoveryComplete, true);

      const latest = await reconRepo.getLatestRunForSession(
        ACCOUNT_ID,
        SESSION_A,
      );
      assert.equal(latest?.status, "CLEAN");
      assert.equal(latest?.snapshotComplete, true);

      const readiness = classifyReadiness(false, latest, SESSION_A);
      assert.equal(readiness.kind, "healthy");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("recoveryComplete=false but exposureComplete=true → INCOMPLETE, readiness=incomplete_recovery (per-instrument)", async () => {
    const { pool, dbName } = await freshDb("recov_missing");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      const adapter = new FakeBrokerReconciliationAdapter();
      adapter.configure({ completedOrdersSupported: false });
      const runner = new ReconciliationRunner(pool, repo, reconRepo, adapter);
      const report = await runner.runOnce(
        {
          accountId: ACCOUNT_ID,
          sessionId: SESSION_A,
          sessionStartedAt: new Date(),
        },
        {
          runTimeoutMs: 5_000,
          sourceTimeoutMs: 1_000,
          executionSafetyMarginMs: 60_000,
        },
      );
      assert.equal(report!.status, "INCOMPLETE");
      assert.equal(report!.exposureComplete, true);
      assert.equal(report!.recoveryComplete, false);
      const latest = await reconRepo.getLatestRunForSession(
        ACCOUNT_ID,
        SESSION_A,
      );
      const readiness = classifyReadiness(false, latest, SESSION_A);
      // Per §8: incomplete_recovery is PER-INSTRUMENT, not global.
      assert.equal(readiness.kind, "incomplete_recovery");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("exposureComplete=false → INCOMPLETE, readiness=incomplete_exposure (global 503 material)", async () => {
    const { pool, dbName } = await freshDb("exp_missing");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      const adapter = new FakeBrokerReconciliationAdapter();
      adapter.configure({ failSource: "positions" });
      const runner = new ReconciliationRunner(pool, repo, reconRepo, adapter);
      const report = await runner.runOnce(
        {
          accountId: ACCOUNT_ID,
          sessionId: SESSION_A,
          sessionStartedAt: new Date(),
        },
        {
          runTimeoutMs: 5_000,
          sourceTimeoutMs: 1_000,
          executionSafetyMarginMs: 60_000,
        },
      );
      assert.equal(report!.status, "INCOMPLETE");
      assert.equal(report!.exposureComplete, false);
      const latest = await reconRepo.getLatestRunForSession(
        ACCOUNT_ID,
        SESSION_A,
      );
      const readiness = classifyReadiness(false, latest, SESSION_A);
      assert.equal(readiness.kind, "incomplete_exposure");
    } finally {
      await drop(pool, dbName);
    }
  });

  it("wrong-session run is IGNORED for readiness gate (foreign runs never trust)", async () => {
    const { pool, dbName } = await freshDb("wrong_session");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      const adapter = new FakeBrokerReconciliationAdapter();
      const runner = new ReconciliationRunner(pool, repo, reconRepo, adapter);
      // A CLEAN run under SESSION_B ...
      await runner.runOnce(
        {
          accountId: ACCOUNT_ID,
          sessionId: SESSION_B,
          sessionStartedAt: new Date(),
        },
        {
          runTimeoutMs: 5_000,
          sourceTimeoutMs: 1_000,
          executionSafetyMarginMs: 60_000,
        },
      );
      // ... does NOT satisfy readiness for SESSION_A.
      const latest = await reconRepo.getLatestRunOverall(ACCOUNT_ID);
      const readiness = classifyReadiness(false, latest, SESSION_A);
      assert.equal(readiness.kind, "wrong_session");

      // Write gate too.
      const gateOutcome = await evaluateReconciliationGate(
        reconRepo,
        {
          accountId: ACCOUNT_ID,
          sessionId: SESSION_A,
          nowMs: Date.now(),
          maxAgeSeconds: 900,
        },
      );
      assert.equal(gateOutcome.kind, "unavailable");
      if (gateOutcome.kind === "unavailable") {
        assert.equal(gateOutcome.reason, "reconciliation_wrong_session");
      }
    } finally {
      await drop(pool, dbName);
    }
  });

  it("mismatch creates a per-identity position_mismatch hold, other identities keep trading", async () => {
    const { pool, dbName } = await freshDb("mismatch_hold");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      // Seed a broker fill so expected = +10 AAPL.
      await pool.query(
        `INSERT INTO broker_execution_fills (exec_id, account_id, symbol, conid, side, shares, price, executed_at)
         VALUES ('e1', $1, 'AAPL', '123', 'BOT', 10, 100, NOW())`,
        [ACCOUNT_ID],
      );
      const adapter = new FakeBrokerReconciliationAdapter();
      // Broker reports 0 for AAPL and 5 for MSFT (unexpected).
      adapter.configure({
        positions: [
          {
            accountId: ACCOUNT_ID,
            symbol: "MSFT",
            conId: "456",
            position: 5,
          },
        ],
      });
      const runner = new ReconciliationRunner(pool, repo, reconRepo, adapter);
      const report = await runner.runOnce(
        {
          accountId: ACCOUNT_ID,
          sessionId: SESSION_A,
          sessionStartedAt: new Date(),
        },
        {
          runTimeoutMs: 5_000,
          sourceTimeoutMs: 1_000,
          executionSafetyMarginMs: 60_000,
        },
      );
      assert.equal(report!.status, "MISMATCH");
      assert.ok(report!.holdsCreated >= 2, "expected AAPL + MSFT holds");

      const activeHolds = await reconRepo.listActiveHolds(ACCOUNT_ID);
      const identities = activeHolds.map((h) => h.identityKey).sort();
      assert.ok(
        identities.some((k) => k.endsWith("|123")),
        `AAPL hold missing: ${identities.join(",")}`,
      );
      assert.ok(
        identities.some((k) => k.endsWith("|456")),
        `MSFT hold missing: ${identities.join(",")}`,
      );

      // Write gate blocks AAPL specifically, but a third instrument
      // (with no hold) passes. Direct hold lookup via
      // `findActiveHoldForIdentity` mirrors what the submission
      // gate does inside the write-path transaction.
      const aaplHold = await reconRepo.findActiveHoldForIdentity(
        pool,
        ACCOUNT_ID,
        "conid:" + ACCOUNT_ID + "|123",
      );
      assert.ok(aaplHold);

      const otherHold = await reconRepo.findActiveHoldForIdentity(
        pool,
        ACCOUNT_ID,
        "conid:" + ACCOUNT_ID + "|999",
      );
      assert.equal(otherHold, null);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("subsequent CLEAN run auto-resolves position_mismatch holds (auto_snapshot_clean)", async () => {
    const { pool, dbName } = await freshDb("auto_clean");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      await pool.query(
        `INSERT INTO broker_execution_fills (exec_id, account_id, symbol, conid, side, shares, price, executed_at)
         VALUES ('e1', $1, 'AAPL', '123', 'BOT', 10, 100, NOW())`,
        [ACCOUNT_ID],
      );
      const adapter = new FakeBrokerReconciliationAdapter();
      // First run: mismatch (broker=0, expected=10).
      adapter.configure({ positions: [] });
      const runner = new ReconciliationRunner(pool, repo, reconRepo, adapter);
      const first = await runner.runOnce(
        { accountId: ACCOUNT_ID, sessionId: SESSION_A, sessionStartedAt: new Date() },
        { runTimeoutMs: 5_000, sourceTimeoutMs: 1_000, executionSafetyMarginMs: 60_000 },
      );
      assert.equal(first!.status, "MISMATCH");
      assert.ok(first!.holdsCreated >= 1);

      // Second run: broker now shows the +10, position matches.
      adapter.reset();
      adapter.configure({
        positions: [
          { accountId: ACCOUNT_ID, symbol: "AAPL", conId: "123", position: 10 },
        ],
      });
      const second = await runner.runOnce(
        { accountId: ACCOUNT_ID, sessionId: SESSION_A, sessionStartedAt: new Date() },
        { runTimeoutMs: 5_000, sourceTimeoutMs: 1_000, executionSafetyMarginMs: 60_000 },
      );
      assert.equal(second!.status, "CLEAN");
      assert.ok(
        second!.holdsResolved >= 1,
        `expected at least one auto_snapshot_clean resolution, got ${second!.holdsResolved}`,
      );

      const active = await reconRepo.listActiveHolds(ACCOUNT_ID);
      assert.equal(active.length, 0);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("concurrent runners: pg_try_advisory_lock serialises — the second runOnce sees the lock in use and skips", async () => {
    const { pool, dbName } = await freshDb("concurrent");
    try {
      const repo = new ExecutionRepository(pool);
      const reconRepo = new ReconciliationRepository(pool);
      const adapter1 = new FakeBrokerReconciliationAdapter();
      const adapter2 = new FakeBrokerReconciliationAdapter();
      // Slow the first runner's broker read so the second lands
      // while the lock is still held.
      let slowFirstResolve: () => void = () => {};
      const originalCapture = adapter1.capture.bind(adapter1);
      adapter1.capture = async (req) => {
        await new Promise<void>((r) => (slowFirstResolve = r));
        return originalCapture(req);
      };
      const runner1 = new ReconciliationRunner(pool, repo, reconRepo, adapter1);
      const runner2 = new ReconciliationRunner(pool, repo, reconRepo, adapter2);

      const [reportOrRun1, reportOrRun2] = await Promise.all([
        (async () => {
          const p = runner1.runOnce(
            { accountId: ACCOUNT_ID, sessionId: SESSION_A, sessionStartedAt: new Date() },
            { runTimeoutMs: 5_000, sourceTimeoutMs: 1_000, executionSafetyMarginMs: 60_000 },
          );
          // Let the second runner get a chance to try the lock first.
          await new Promise((r) => setTimeout(r, 50));
          slowFirstResolve();
          return p;
        })(),
        (async () => {
          await new Promise((r) => setTimeout(r, 25));
          return runner2.runOnce(
            { accountId: ACCOUNT_ID, sessionId: SESSION_A, sessionStartedAt: new Date() },
            { runTimeoutMs: 5_000, sourceTimeoutMs: 1_000, executionSafetyMarginMs: 60_000 },
          );
        })(),
      ]);
      // Exactly one wins the lock; the other returns null.
      const winners = [reportOrRun1, reportOrRun2].filter(Boolean);
      assert.equal(winners.length, 1);
    } finally {
      await drop(pool, dbName);
    }
  });
});
