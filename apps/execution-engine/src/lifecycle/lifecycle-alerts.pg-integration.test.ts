import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { runMigrations } from "../migrations.js";
import { LifecycleAlertStore, LifecycleAlertWorker, type LifecycleTransport } from "./lifecycle-alerts.js";

const connection = process.env.TEST_POSTGRES_URL;

async function fixture() {
  const name = `alerts_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(connection!);
  url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  await runMigrations(pool);
  return { pool, store: new LifecycleAlertStore(pool), async close() { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); } };
}

describe("lifecycle fault outbox PostgreSQL", { skip: !connection }, () => {
  it("deduplicates active faults, creates a new resolved episode, and backfills missing outbox", async () => {
    const f = await fixture();
    try {
      const input = { accountId: "DU-PK0", proposalId: 12, code: "PROTECTION_GAP" as const, evidence: { leg: "TP", token: "never-store" } };
      await Promise.all([f.store.recordFault(input), f.store.recordFault(input)]);
      let status = await f.store.readStatus(input.accountId);
      assert.equal(status.faults.length, 1);
      assert.equal(status.faults[0].occurrences, 2);
      assert.deepEqual(status.faults[0].evidence, { leg: "[REDACTED]" });
      await f.store.resolveScope(input.accountId, input.proposalId, []);
      await f.store.recordFault(input);
      status = await f.store.readStatus(input.accountId);
      assert.equal(status.faults.length, 2);
      assert.equal(status.faults[0].active, true);
      assert.notEqual(status.faults[0].id, status.faults[1].id);
      await f.pool.query("DELETE FROM lifecycle_alert_outbox WHERE fault_id=$1", [status.faults[0].id]);
      await f.store.startWorkerSession(input.accountId, "p1");
      status = await f.store.readStatus(input.accountId);
      assert.equal(status.faults[0].delivery, "PENDING");
      assert.equal(status.probes.length, 1);
    } finally { await f.close(); }
  });

  it("requires this process heartbeat, enabled transport, probe acknowledgement, and no active fault", async () => {
    const f = await fixture();
    try {
      const account = "DU-PK0";
      await f.store.startWorkerSession(account, "p1");
      const db = await f.pool.connect();
      try {
        assert.equal(await f.store.entryFailure(db, account, "p1"), "lifecycle_alert_transport_disabled");
        await f.store.heartbeatWorker(account, "p1", true);
        assert.equal(await f.store.entryFailure(db, account, "p1"), "lifecycle_alert_transport_unverified");
        const claim = await f.store.claimNext([account], "p1");
        assert.ok(claim);
        assert.equal(await f.store.complete(claim.id, claim.lease_token, { status: "DELIVERED", messageId: "11" }), true);
        assert.equal(await f.store.entryFailure(db, account, "p1"), null);
        assert.equal(await f.store.entryFailure(db, account, "different"), "lifecycle_alert_worker_stale");
        await f.store.recordFault({ accountId: account, proposalId: null, code: "SUPERVISOR_FAILURE", evidence: {} });
        assert.equal(await f.store.entryFailure(db, account, "p1"), "lifecycle_critical_delivery_unconfirmed");
        await f.pool.query("UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp()-interval '16 seconds' WHERE account_id=$1", [account]);
        assert.equal(await f.store.entryFailure(db, account, "p1"), "lifecycle_alert_worker_stale");
      } finally { db.release(); }
    } finally { await f.close(); }
  });

  it("fences late workers, charges expired sends, and caps retries at three", async () => {
    const f = await fixture();
    try {
      await f.store.recordFault({ accountId: "DU-PK0", proposalId: 12, code: "CLOSE_UNFILLED", evidence: {} });
      const first = await f.store.claimNext(["DU-PK0"], "p1");
      assert.ok(first);
      await f.pool.query("UPDATE lifecycle_alert_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
      await f.store.claimNext(["DU-PK0"], "p1");
      assert.equal(await f.store.complete(first.id, first.lease_token, { status: "DELIVERED", messageId: "late" }), false);
      let rows = await f.pool.query("SELECT status,attempts FROM lifecycle_alert_outbox WHERE id=$1", [first.id]);
      assert.deepEqual(rows.rows[0], { status: "UNKNOWN", attempts: 1 });
      for (let attempt = 2; attempt <= 3; attempt++) {
        await f.pool.query("UPDATE lifecycle_alert_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
        const claim = await f.store.claimNext(["DU-PK0"], "p1");
        assert.ok(claim);
        assert.equal(claim.attempts, attempt);
        assert.equal(await f.store.complete(claim.id, claim.lease_token, { status: "FAILED", errorCode: "provider_http_failure" }), true);
      }
      await f.pool.query("UPDATE lifecycle_alert_outbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.id]);
      assert.equal(await f.store.claimNext(["DU-PK0"], "p1"), null);
      rows = await f.pool.query("SELECT status,attempts FROM lifecycle_alert_outbox WHERE id=$1", [first.id]);
      assert.deepEqual(rows.rows[0], { status: "FAILED", attempts: 3 });
      const attempts = await f.pool.query("SELECT status FROM lifecycle_alert_delivery_attempts WHERE outbox_id=$1 ORDER BY attempt_number", [first.id]);
      assert.deepEqual(attempts.rows.map((row) => row.status), ["UNKNOWN", "FAILED", "FAILED"]);
      const status = await f.store.readStatus("DU-PK0");
      assert.deepEqual(status.deliveryAttempts.map((attempt) => attempt.status), ["FAILED", "FAILED", "UNKNOWN"]);
    } finally { await f.close(); }
  });

  it("worker sends one probe per process and fault ID without logging provider responses", async () => {
    const f = await fixture();
    try {
      const sent: string[] = [];
      const transport: LifecycleTransport = { enabled: true, send: async (text) => { sent.push(text); return { status: "DELIVERED", messageId: String(sent.length) }; } };
      const worker = new LifecycleAlertWorker(f.store, transport, { accountIds: ["DU-PK0"], processId: "p1" });
      await worker.start();
      await worker.triggerNow();
      assert.equal(sent.length, 1);
      await f.store.recordFault({ accountId: "DU-PK0", proposalId: null, code: "BROKER_UNAVAILABLE", evidence: {} });
      await worker.triggerNow();
      assert.match(sent[1], /LF-\d+/);
      await worker.stop();
      const restart = new LifecycleAlertWorker(f.store, transport, { accountIds: ["DU-PK0"], processId: "p2" });
      await restart.start();
      assert.equal(sent.length, 3);
      await restart.stop();
    } finally { await f.close(); }
  });

  it("limits each tick to one transport send while refreshing heartbeat", async () => {
    const f = await fixture();
    try {
      const account = "DU-PK0";
      await f.store.startWorkerSession(account, "p1");
      await f.store.recordFault({ accountId: account, proposalId: 1, code: "PROTECTION_GAP", evidence: {} });
      await f.store.recordFault({ accountId: account, proposalId: 2, code: "PROTECTION_GAP", evidence: {} });
      let sends = 0;
      const worker = new LifecycleAlertWorker(f.store, { enabled: true, send: async () => { sends++; return { status: "DELIVERED", messageId: String(sends) }; } }, { accountIds: [account], processId: "p1" });
      await worker.triggerNow();
      assert.equal(sends, 1);
      let status = await f.store.readStatus(account);
      assert.ok(status.probes[0].heartbeatAt);
      await worker.triggerNow();
      assert.equal(sends, 2);
      await worker.triggerNow();
      assert.equal(sends, 3);
      status = await f.store.readStatus(account);
      assert.equal(status.faults.filter((fault) => fault.delivery === "DELIVERED").length, 2);
    } finally { await f.close(); }
  });

  it("claims only configured account faults and this process probe; excluded expired leases remain untouched", async () => {
    const f = await fixture();
    try {
      const accountA = "DU-A";
      const accountB = "DU-B";
      await f.store.startWorkerSession(accountA, "p1");
      await f.store.startWorkerSession(accountA, "p2");
      await f.store.startWorkerSession(accountB, "p1");
      await f.store.recordFault({ accountId: accountA, proposalId: 1, code: "PROTECTION_GAP", evidence: {} });
      await f.store.recordFault({ accountId: accountB, proposalId: 2, code: "PROTECTION_GAP", evidence: {} });

      const foreignLease = await f.store.claimNext([accountB], "p1");
      assert.ok(foreignLease);
      await f.pool.query("UPDATE lifecycle_alert_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [foreignLease.id]);

      const first = await f.store.claimNext([accountA], "p1");
      assert.ok(first);
      assert.equal(first.account_id, accountA);
      assert.equal(first.probe_process_id, "p1");
      const excluded = await f.pool.query("SELECT status,attempts,lease_token FROM lifecycle_alert_outbox WHERE id=$1", [foreignLease.id]);
      assert.deepEqual(excluded.rows[0], { status: "SENDING", attempts: 1, lease_token: foreignLease.lease_token });
      await f.store.complete(first.id, first.lease_token, { status: "DELIVERED", messageId: "101" });

      const second = await f.store.claimNext([accountA], "p1");
      assert.ok(second);
      assert.equal(second.account_id, accountA);
      assert.ok(second.fault_id);
      await f.store.complete(second.id, second.lease_token, { status: "DELIVERED", messageId: "102" });
      assert.equal(await f.store.claimNext([accountA], "p1"), null);
      const p2 = await f.store.readStatus(accountA, "p2");
      assert.equal(p2.probes.length, 1);
      assert.equal(p2.probes[0].delivery, "PENDING");
      assert.equal(p2.transport, "DISABLED");

      await f.store.heartbeatWorker(accountA, "p1", true);
      assert.equal((await f.store.readStatus(accountA, "p1")).transport, "VERIFIED");
      await f.pool.query("UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp()-interval '16 seconds' WHERE account_id=$1 AND process_id='p1'", [accountA]);
      assert.equal((await f.store.readStatus(accountA, "p1")).transport, "UNVERIFIED");
    } finally { await f.close(); }
  });
});
