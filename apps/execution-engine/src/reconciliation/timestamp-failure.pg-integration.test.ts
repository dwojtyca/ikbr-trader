import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { ReconciliationRepository } from "./repository.js";
import { ReconciliationRunner } from "./runner.js";
import { FakeBrokerReconciliationAdapter } from "./fake-broker-adapter.js";
import type { BrokerReconciliationSnapshot } from "./broker-adapter.js";

const url = process.env.TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
const context = { accountId: "DU-time-test", sessionId: "time-session", sessionStartedAt: new Date() };
const config = { runTimeoutMs: 5000, sourceTimeoutMs: 1000, executionSafetyMarginMs: 60000 };

async function withDb(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const name = `recon_time_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(url!); adminUrl.pathname = "/postgres";
  const dbUrl = new URL(url!); dbUrl.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const pool = new Pool({ connectionString: dbUrl.toString() });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    await runMigrations(pool);
    await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
}

function runner(pool: Pool, repo = new ReconciliationRepository(pool), mutate?: (snapshot: BrokerReconciliationSnapshot) => BrokerReconciliationSnapshot) {
  const fake = new FakeBrokerReconciliationAdapter();
  return new ReconciliationRunner(pool, new ExecutionRepository(pool), repo, {
    capture: async request => {
      const snapshot = await fake.capture(request);
      return mutate ? mutate(snapshot) : snapshot;
    },
  });
}

suite("Reconciliation invalid timestamp and Phase C failure finalization (PG)", () => {
  for (const kind of ["execution_nan", "execution_missing", "capture_nan", "order_nan"] as const) {
    it(`${kind} fails before matching, persists FAILED and releases lock`, async () => withDb(async pool => {
      const repo = new ReconciliationRepository(pool);
      const bad = runner(pool, repo, snapshot => ({
        ...snapshot,
        capturedAt: kind === "capture_nan" ? new Date(NaN) : snapshot.capturedAt,
        executions: kind.startsWith("execution") ? [{
          execId: "test-exec", brokerOrderId: "99", accountId: context.accountId,
          symbol: "PKO", shares: 1, executedAt: kind === "execution_nan" ? new Date(NaN) : undefined as unknown as Date,
        }] : [],
        openOrders: kind === "order_nan" ? [{ brokerOrderId: "99", status: "Submitted", observedAt: new Date(NaN) }] : [],
      }));
      const result = await bad.runOnce(context, config);
      assert.equal(result?.status, "FAILED");
      assert.equal(result?.error, "invalid_snapshot_timestamp");
      const latest = await repo.getLatestRunForSession(context.accountId, context.sessionId);
      assert.equal(latest?.status, "FAILED");
      assert.ok(latest?.completedAt);
      assert.equal(latest?.snapshotComplete, false);
      for (const table of ["reconciliation_broker_order_observations", "reconciliation_holds", "proposed_orders"]) {
        assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
      }
      assert.equal((await runner(pool).runOnce(context, config))?.status, "CLEAN");
    }));
  }

  it("real publication SQL error rolls back Phase C and finalizes FAILED; next run succeeds", async () => withDb(async pool => {
    class BrokenPublication extends ReconciliationRepository {
      override async publishResult(...args: Parameters<ReconciliationRepository["publishResult"]>): Promise<void> {
        await super.publishResult(args[0], { ...args[1], holdInserts: [{
          accountId: context.accountId, instrument: "PKO", conId: "35146360", secType: "STK", exchange: "WSE",
          currency: "PLN", identityKey: "test-key", reason: "position_mismatch", severity: "critical", payload: {},
        }], brokerOrderObservations: [{
          accountId: context.accountId, sessionId: context.sessionId, source: "EXECUTION", brokerOrderId: "99",
          permId: null, orderRef: null, brokerStatus: null, observedAt: new Date(NaN),
        }] });
      }
    }
    const result = await runner(pool, new BrokenPublication(pool)).runOnce(context, config);
    assert.equal(result?.status, "FAILED");
    assert.equal(result?.error, "reconciliation_phase_c_failed");
    const row = (await pool.query("SELECT status, completed_at, broker_snapshot, snapshot_complete FROM reconciliation_runs WHERE id=$1", [result!.runId])).rows[0];
    assert.equal(row.status, "FAILED"); assert.ok(row.completed_at);
    assert.equal(row.broker_snapshot, null); assert.equal(row.snapshot_complete, false);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM reconciliation_broker_order_observations")).rows[0].count, 0);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM reconciliation_holds")).rows[0].count, 0);
    assert.equal((await runner(pool).runOnce(context, config))?.status, "CLEAN");
  }));

  it("ambiguous post-commit publication error cannot overwrite committed CLEAN", async () => withDb(async pool => {
    class CommitThenThrow extends ReconciliationRepository {
      override async publishResult(...args: Parameters<ReconciliationRepository["publishResult"]>): Promise<void> {
        await super.publishResult(...args);
        throw new Error("simulated_ambiguous_commit");
      }
    }
    await assert.rejects(runner(pool, new CommitThenThrow(pool)).runOnce(context, config), /reconciliation_failure_finalization_not_applied/);
    assert.equal((await pool.query("SELECT status FROM reconciliation_runs")).rows[0].status, "CLEAN");
    assert.equal((await runner(pool).runOnce(context, config))?.status, "CLEAN");
  }));

  it("guarded finalizer preserves terminal, foreign account and foreign session rows", async () => withDb(async pool => {
    const repo = new ReconciliationRepository(pool);
    const result = await runner(pool, repo).runOnce(context, config);
    const client = await pool.connect();
    try {
      assert.equal(await repo.failRunningRun(client, { ...context, runId: result!.runId, reason: "test" }), false);
      const { runId } = await repo.publishRunning(client, { ...context, runTimeoutMs: 5000 });
      assert.equal(await repo.failRunningRun(client, { ...context, accountId: "foreign", runId, reason: "test" }), false);
      assert.equal(await repo.failRunningRun(client, { ...context, sessionId: "foreign", runId, reason: "test" }), false);
      assert.equal((await pool.query("SELECT status FROM reconciliation_runs WHERE id=$1", [runId])).rows[0].status, "RUNNING");
      assert.equal(await repo.failRunningRun(client, { ...context, runId, reason: "test" }), true);
      assert.equal((await pool.query("SELECT status FROM reconciliation_runs WHERE id=$1", [result!.runId])).rows[0].status, "CLEAN");
    } finally { client.release(); }
  }));

  for (const failure of ["throw", "noop"] as const) {
    it(`finalizer ${failure} propagates instead of claiming FAILED`, async () => withDb(async pool => {
      class FailedFinalization extends ReconciliationRepository {
        override async failRunningRun(): Promise<boolean> {
          if (failure === "throw") throw new Error("finalizer_unavailable");
          return false;
        }
      }
      await assert.rejects(runner(pool, new FailedFinalization(pool), snapshot => ({ ...snapshot, capturedAt: new Date(NaN) })).runOnce(context, config),
        failure === "throw" ? /finalizer_unavailable/ : /reconciliation_failure_finalization_not_applied/);
      assert.equal((await pool.query("SELECT status FROM reconciliation_runs")).rows[0].status, "RUNNING");
      assert.equal((await runner(pool).runOnce(context, config))?.status, "CLEAN");
    }));
  }
});
