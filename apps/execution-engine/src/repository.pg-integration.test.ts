/**
 * PostgreSQL integration test — atomic instrument-level guard.
 *
 * Verifies the round-3 blocker fix
 * (`pg_advisory_xact_lock(hashtext(instrument))` inside
 * `insertProposedFromTicket`) actually serialises concurrent
 * inserts at the SQL layer, not just in a fake in-memory repo.
 *
 * Runs only when `TEST_POSTGRES_URL` is set. `docker compose up
 * -d postgres` from the repo root is sufficient — the default
 * URL is the compose defaults.
 *
 *   TEST_POSTGRES_URL=postgresql://postgres:postgres@localhost:5432/ikbr_trader \
 *     pnpm --filter execution-engine test
 *
 * The test creates an isolated `ikbr_trader_pr14_pgtest` database
 * (drops + recreates on each run) so it doesn't collide with the
 * app schema and cleans up after itself.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool, type PoolClient } from "pg";

import type { SignalTicket } from "@ikbr/shared";

import { ExecutionRepository } from "./repository.js";

/** Inlined `isUniqueViolation` (execution-engine keeps it in index.ts). */
function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505"
  );
}

const CONN_URL = process.env.TEST_POSTGRES_URL;
// Gate the whole suite on the env var — CI and dev machines
// without Postgres running skip these tests cleanly.
const suite = CONN_URL ? describe : describe.skip;

const TEST_DB = "ikbr_trader_pr14_pgtest";

function poolForDb(url: string, dbName: string): Pool {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return new Pool({ connectionString: parsed.toString() });
}

async function withAdminPool<T>(
  url: string,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  const pool = new Pool({ connectionString: parsed.toString() });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

function baseTicket(instrument: string): SignalTicket {
  return {
    instrument,
    side: "BUY",
    orderType: "LMT",
    quantity: 10,
    entry: 100.5,
    reason: "pg-integration-test",
    confidence: 1,
    timestamp: "2026-07-14T12:00:00.000Z",
    riskCheckStatus: "PASS",
  };
}

// Round-6: `PositionGuardContext` is now REQUIRED on
// `insertProposedFromTicket`. Tests that predate the guard
// (round-3 / round-4 behavior) seed a fresh flat snapshot for
// `SHARED_ACCT` in `before` and supply this permissive context
// so the guard passes without changing the tested behavior.
const SHARED_ACCT = "PAPER-PGSHARED";
const SHARED_SESSION = "sess-pgshared";
function permissiveGuard() {
  return {
    kind: "available" as const,
    accountId: SHARED_ACCT,
    sessionId: SHARED_SESSION,
    maxSnapshotAgeMs: 60_000,
  };
}

suite(
  "ExecutionRepository — PostgreSQL advisory-lock guard (integration)",
  () => {
    if (!CONN_URL) {
      it("skipped — set TEST_POSTGRES_URL to enable", () => {
        assert.ok(true);
      });
      return;
    }

    let pool: Pool;
    let repo: ExecutionRepository;

    before(async () => {
      // Create / reset the isolated test DB.
      await withAdminPool(CONN_URL, async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
        await admin.query(`CREATE DATABASE ${TEST_DB}`);
      });
      pool = poolForDb(CONN_URL, TEST_DB);
      repo = new ExecutionRepository(pool);
      await repo.init();
      // Round-6: seed a permissive flat snapshot for tests that
      // predate PositionGuardContext (round-3 / round-4).
      await repo.upsertPositionSnapshot({
        accountId: SHARED_ACCT,
        sessionId: SHARED_SESSION,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
    });

    after(async () => {
      if (pool) await pool.end();
      await withAdminPool(CONN_URL, async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
      });
    });

    it("two concurrent inserts for the SAME instrument + different clientOrderIds → exactly one INSERT, one active_intent_exists", async () => {
      // Both requests observe an empty state, both try to INSERT.
      // The advisory lock inside `insertProposedFromTicket` must
      // serialise them so exactly one row lands.
      const ticket = baseTicket("PG_TEST_A");
      const [a, b] = await Promise.all([
        repo.insertProposedFromTicket(
          ticket,
          "loop",
          {
            clientOrderId: "pg-integ-A",
            clientOrderHash: "hashA",
          },
          permissiveGuard(),
        ),
        repo.insertProposedFromTicket(
          ticket,
          "loop",
          {
            clientOrderId: "pg-integ-B",
            clientOrderHash: "hashB",
          },
          permissiveGuard(),
        ),
      ]);
      const kinds = [a.kind, b.kind].sort();
      assert.deepEqual(kinds, ["active_intent_exists", "inserted"]);
      const rows = await pool.query(
        "SELECT id FROM proposed_orders WHERE instrument = $1",
        ["PG_TEST_A"],
      );
      assert.equal(rows.rowCount, 1);
    });

    it("advisory lock is per-instrument — different instruments never block each other", async () => {
      const [a, b] = await Promise.all([
        repo.insertProposedFromTicket(
          baseTicket("PG_TEST_B"),
          "loop",
          {
            clientOrderId: "pg-integ-B1",
            clientOrderHash: "hashB1",
          },
          permissiveGuard(),
        ),
        repo.insertProposedFromTicket(
          baseTicket("PG_TEST_C"),
          "loop",
          {
            clientOrderId: "pg-integ-C1",
            clientOrderHash: "hashC1",
          },
          permissiveGuard(),
        ),
      ]);
      assert.equal(a.kind, "inserted");
      assert.equal(b.kind, "inserted");
    });

    it("ROLLBACK from an aborted transaction releases the advisory lock — a later INSERT succeeds", async () => {
      // Simulate a slow first transaction that acquires the lock,
      // checks state, then explicitly ROLLBACKs (e.g. due to an
      // application-level failure). The advisory lock is transaction-
      // scoped, so it must release on ROLLBACK.
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
          ["PG_TEST_D"],
        );
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      const insert = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_D"),
        "loop",
        { clientOrderId: "pg-integ-D1", clientOrderHash: "hashD1" },
        permissiveGuard(),
      );
      assert.equal(insert.kind, "inserted");
    });

    it("existing PROPOSED row + different clientOrderId → active_intent_exists", async () => {
      await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_E"),
        "loop",
        {
          clientOrderId: "pg-integ-E1",
          clientOrderHash: "hashE1",
        },
        permissiveGuard(),
      );
      const result = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_E"),
        "loop",
        { clientOrderId: "pg-integ-E2", clientOrderHash: "hashE2" },
        permissiveGuard(),
      );
      assert.equal(result.kind, "active_intent_exists");
      if (result.kind !== "active_intent_exists") return;
      assert.equal(result.existingClientOrderId, "pg-integ-E1");
      assert.equal(result.existingStatus, "PROPOSED");
    });

    it("same clientOrderId retry does NOT hit active_intent_exists — falls through to UNIQUE violation for the idempotency path", async () => {
      // The atomic guard MUST exclude the caller's own
      // client_order_id so the PR13 idempotency / fencing-marker
      // path stays intact.
      await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_F"),
        "loop",
        {
          clientOrderId: "pg-integ-F",
          clientOrderHash: "hashF",
        },
        permissiveGuard(),
      );
      let uniqueViolation = false;
      try {
        await repo.insertProposedFromTicket(
          baseTicket("PG_TEST_F"),
          "loop",
          {
            clientOrderId: "pg-integ-F",
            clientOrderHash: "hashF",
          },
          permissiveGuard(),
        );
      } catch (error) {
        uniqueViolation = isUniqueViolation(error);
      }
      assert.equal(
        uniqueViolation,
        true,
        "same clientOrderId retry must throw UNIQUE violation, not ACTIVE_INTENT_EXISTS",
      );
    });

    it("terminal statuses do NOT block a new intent (guard only counts PROPOSED / SUBMITTED)", async () => {
      // Seed a REJECTED order for the instrument, then insert a
      // fresh intent — must succeed.
      const first = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_G"),
        "loop",
        { clientOrderId: "pg-integ-G1", clientOrderHash: "hashG1" },
        permissiveGuard(),
      );
      assert.equal(first.kind, "inserted");
      if (first.kind !== "inserted") return;
      await pool.query(
        "UPDATE proposed_orders SET status='REJECTED' WHERE id=$1",
        [first.id],
      );
      const second = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_G"),
        "loop",
        { clientOrderId: "pg-integ-G2", clientOrderHash: "hashG2" },
        permissiveGuard(),
      );
      assert.equal(second.kind, "inserted");
    });

    // -------------------------------------------------------------------
    // Round-5 blockers: PositionGuardContext + conId-preferring guard
    // -------------------------------------------------------------------

    it("PositionGuardContext=unavailable → POSITION_STATE_UNAVAILABLE, no INSERT", async () => {
      const outcome = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_UNAVAIL"),
        "loop",
        { clientOrderId: "pg-unavail-1", clientOrderHash: "hash" },
        { kind: "unavailable", reason: "no_active_account" },
      );
      assert.equal(outcome.kind, "position_state_unavailable");
      if (outcome.kind !== "position_state_unavailable") return;
      assert.equal(outcome.accountId, null);
      assert.equal(outcome.reason, "no_active_account");
      // Zero rows created.
      const rows = await pool.query(
        "SELECT COUNT(*)::int AS n FROM proposed_orders WHERE instrument = $1",
        ["PG_TEST_UNAVAIL"],
      );
      assert.equal(rows.rows[0].n, 0);
    });

    it("missing broker_snapshot_syncs row → POSITION_STATE_UNAVAILABLE (missing)", async () => {
      const outcome = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_MISS"),
        "loop",
        { clientOrderId: "pg-miss-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-NO-SNAPSHOT",
          sessionId: "sess-PAPER-NO-SNAPSHOT",
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "position_state_unavailable");
      if (outcome.kind !== "position_state_unavailable") return;
      assert.equal(outcome.reason, "missing");
    });

    it("stale snapshot → POSITION_STATE_UNAVAILABLE (stale)", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-STALE",
        sessionId: "sess-PAPER-STALE",
        observedAt: new Date(Date.now() - 5 * 60_000), // 5 min old
        complete: true,
        positions: [],
      });
      const outcome = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_STALE"),
        "loop",
        { clientOrderId: "pg-stale-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-STALE",
          sessionId: "sess-PAPER-STALE",
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "position_state_unavailable");
      if (outcome.kind !== "position_state_unavailable") return;
      assert.equal(outcome.reason, "stale");
    });

    it("fresh snapshot + zero position → INSERT succeeds", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-FLAT",
        sessionId: "sess-PAPER-FLAT",
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const outcome = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_FLAT"),
        "loop",
        { clientOrderId: "pg-flat-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-FLAT",
          sessionId: "sess-PAPER-FLAT",
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "inserted");
    });

    it("fresh snapshot + non-zero position (matched by symbol, no conId) → OPEN_POSITION_EXISTS", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-LONG",
        sessionId: "sess-PAPER-LONG",
        observedAt: new Date(),
        complete: true,
        positions: [{ instrument: "PG_TEST_LONG", quantity: 100 }],
      });
      const outcome = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_LONG"),
        "loop",
        { clientOrderId: "pg-long-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-LONG",
          sessionId: "sess-PAPER-LONG",
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "open_position_exists");
      if (outcome.kind !== "open_position_exists") return;
      assert.equal(outcome.quantity, 100);
    });

    it("conId-aware guard with allowCrossContractExposure=true: position on OLD conId does NOT block a new conId", async () => {
      // Futures rollover — the broker still reports a position on
      // the OLD contract (conId=OLD) but the ticket targets the
      // NEW front-month (conId=NEW). Round-6: the strategy MUST
      // explicitly opt into cross-contract exposure via
      // `allowCrossContractExposure: true`; the safe default
      // (round-6) is to block, since PR14 forbids pyramiding.
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-FUT",
        sessionId: "sess-PAPER-FUT",
        observedAt: new Date(),
        complete: true,
        positions: [
          { instrument: "PG_TEST_FUT", conid: "OLD_CONID", quantity: 1 },
        ],
      });
      const ticket = { ...baseTicket("PG_TEST_FUT"), conid: "NEW_CONID" };
      const outcome = await repo.insertProposedFromTicket(
        ticket,
        "loop",
        { clientOrderId: "pg-fut-new", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-FUT",
          sessionId: "sess-PAPER-FUT",
          maxSnapshotAgeMs: 60_000,
        },
        { allowCrossContractExposure: true },
      );
      assert.equal(outcome.kind, "inserted");
    });

    it("conId-aware guard: position on the SAME conId blocks", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-FUT2",
        sessionId: "sess-PAPER-FUT2",
        observedAt: new Date(),
        complete: true,
        positions: [
          { instrument: "PG_TEST_FUT2", conid: "MATCH_CONID", quantity: 1 },
        ],
      });
      const ticket = { ...baseTicket("PG_TEST_FUT2"), conid: "MATCH_CONID" };
      const outcome = await repo.insertProposedFromTicket(
        ticket,
        "loop",
        { clientOrderId: "pg-fut2-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-FUT2",
          sessionId: "sess-PAPER-FUT2",
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "open_position_exists");
    });

    it("symbol fallback: ticket without conId matches only rows without conId", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-STK",
        sessionId: "sess-PAPER-STK",
        observedAt: new Date(),
        complete: true,
        positions: [{ instrument: "PG_TEST_STK", quantity: 50 }],
      });
      // Ticket without conId → falls back to (account_id, instrument)
      // WHERE conid IS NULL. This matches the seeded position.
      const outcome = await repo.insertProposedFromTicket(
        baseTicket("PG_TEST_STK"),
        "loop",
        { clientOrderId: "pg-stk-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-STK",
          sessionId: "sess-PAPER-STK",
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "open_position_exists");
    });

    it("two rows with same symbol but different conIds are NOT merged (both persist)", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-MULTI",
        sessionId: "sess-PAPER-MULTI",
        observedAt: new Date(),
        complete: true,
        positions: [
          { instrument: "PG_TEST_MULTI", conid: "C1", quantity: 1 },
          { instrument: "PG_TEST_MULTI", conid: "C2", quantity: 2 },
        ],
      });
      const rows = await pool.query(
        "SELECT conid, quantity FROM broker_position_snapshots WHERE account_id = $1 ORDER BY conid",
        ["PAPER-MULTI"],
      );
      assert.equal(rows.rowCount, 2);
      assert.equal(rows.rows[0].conid, "C1");
      assert.equal(rows.rows[1].conid, "C2");
    });

    // -------------------------------------------------------------------
    // Round-6 blockers: tryStartSubmissionWithExposureGuard —
    // unified pre-submission gate for the RESUME path. Runs the
    // same exposure guard as insertProposedFromTicket, atomically
    // under the same advisory lock.
    // -------------------------------------------------------------------

    it("resume path with `unavailable` guard → position_state_unavailable, no marker set", async () => {
      // Seed a clean PROPOSED row without a marker.
      const inserted = await repo.insertProposedFromTicket(
        baseTicket("PG_R6_UN"),
        "loop",
        { clientOrderId: "pg-r6-un-1", clientOrderHash: "hash" },
        permissiveGuard(),
      );
      assert.equal(inserted.kind, "inserted");
      if (inserted.kind !== "inserted") return;

      const result = await repo.tryStartSubmissionWithExposureGuard({
        id: inserted.id,
        owner: "resume-owner",
        instrument: "PG_R6_UN",
        conid: null,
        allowCrossContractExposure: false,
        positionGuard: { kind: "unavailable", reason: "no_active_account" },
      });
      assert.equal(result.kind, "position_state_unavailable");
      if (result.kind !== "position_state_unavailable") return;
      assert.equal(result.reason, "no_active_account");
      // Marker MUST NOT be set.
      const row = await pool.query(
        "SELECT execution_attempted_at, processing_owner FROM proposed_orders WHERE id = $1",
        [inserted.id],
      );
      assert.equal(row.rows[0].execution_attempted_at, null);
      assert.equal(row.rows[0].processing_owner, null);
    });

    it("resume path with wrong sessionId → position_state_unavailable (wrong_session), no marker set", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-R6-WS",
        sessionId: "sess-OLD",
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const inserted = await repo.insertProposedFromTicket(
        baseTicket("PG_R6_WS"),
        "loop",
        { clientOrderId: "pg-r6-ws-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-R6-WS",
          sessionId: "sess-OLD",
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(inserted.kind, "inserted");
      if (inserted.kind !== "inserted") return;

      // Now try to resume with the NEW session's identity.
      const result = await repo.tryStartSubmissionWithExposureGuard({
        id: inserted.id,
        owner: "resume-owner",
        instrument: "PG_R6_WS",
        conid: null,
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "PAPER-R6-WS",
          sessionId: "sess-NEW",
          maxSnapshotAgeMs: 60_000,
        },
      });
      assert.equal(result.kind, "position_state_unavailable");
      if (result.kind !== "position_state_unavailable") return;
      assert.equal(result.reason, "wrong_session");
      const row = await pool.query(
        "SELECT execution_attempted_at FROM proposed_orders WHERE id = $1",
        [inserted.id],
      );
      assert.equal(row.rows[0].execution_attempted_at, null);
    });

    it("resume path with open position → open_position_exists, no marker set", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-R6-OP",
        sessionId: "sess-r6op",
        observedAt: new Date(),
        complete: true,
        positions: [{ instrument: "PG_R6_OP", quantity: 25 }],
      });
      // Seed the PROPOSED row via a manual insert (the guard would
      // block the fresh path too, but we need a PROPOSED row to
      // test the resume path in isolation).
      await pool.query(
        `INSERT INTO proposed_orders (
         instrument, side, order_type, quantity, entry, reason, confidence,
         risk_check_status, status, strategy, created_at,
         client_order_id, client_order_hash
       ) VALUES ($1, 'BUY', 'LMT', 10, 100.5, 'r6-op-test', 1, 'PASS',
                 'PROPOSED', 'loop', NOW(), $2, $3) RETURNING id`,
        ["PG_R6_OP", "pg-r6-op-1", "hash"],
      );
      const idRow = await pool.query(
        "SELECT id FROM proposed_orders WHERE client_order_id = $1",
        ["pg-r6-op-1"],
      );
      const id = Number(idRow.rows[0].id);

      const result = await repo.tryStartSubmissionWithExposureGuard({
        id,
        owner: "resume-owner",
        instrument: "PG_R6_OP",
        conid: null,
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "PAPER-R6-OP",
          sessionId: "sess-r6op",
          maxSnapshotAgeMs: 60_000,
        },
      });
      assert.equal(result.kind, "open_position_exists");
      if (result.kind !== "open_position_exists") return;
      assert.equal(result.quantity, 25);
      const row = await pool.query(
        "SELECT execution_attempted_at FROM proposed_orders WHERE id = $1",
        [id],
      );
      assert.equal(row.rows[0].execution_attempted_at, null);
    });

    it("resume path with fresh flat snapshot → claimed, marker set atomically", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-R6-OK",
        sessionId: "sess-r6ok",
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const inserted = await repo.insertProposedFromTicket(
        baseTicket("PG_R6_OK"),
        "loop",
        { clientOrderId: "pg-r6-ok-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-R6-OK",
          sessionId: "sess-r6ok",
          maxSnapshotAgeMs: 60_000,
        },
      );
      if (inserted.kind !== "inserted")
        throw new Error(`unexpected: ${inserted.kind}`);

      const result = await repo.tryStartSubmissionWithExposureGuard({
        id: inserted.id,
        owner: "resume-owner",
        instrument: "PG_R6_OK",
        conid: null,
        allowCrossContractExposure: false,
        positionGuard: {
          kind: "available",
          accountId: "PAPER-R6-OK",
          sessionId: "sess-r6ok",
          maxSnapshotAgeMs: 60_000,
        },
      });
      assert.equal(result.kind, "claimed");
      const row = await pool.query(
        "SELECT execution_attempted_at, processing_owner FROM proposed_orders WHERE id = $1",
        [inserted.id],
      );
      assert.notEqual(row.rows[0].execution_attempted_at, null);
      assert.equal(row.rows[0].processing_owner, "resume-owner");
    });

    it("two concurrent resume requests via separate pools → exactly one claims, one gets not_claimed", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-R6-RACE",
        sessionId: "sess-r6race",
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const inserted = await repo.insertProposedFromTicket(
        baseTicket("PG_R6_RACE"),
        "loop",
        { clientOrderId: "pg-r6-race-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-R6-RACE",
          sessionId: "sess-r6race",
          maxSnapshotAgeMs: 60_000,
        },
      );
      if (inserted.kind !== "inserted")
        throw new Error(`unexpected: ${inserted.kind}`);

      // Use two ExecutionRepository instances backed by DISTINCT
      // pools so the two concurrent calls truly serialise inside
      // Postgres via the advisory lock rather than reusing the
      // same connection.
      const poolA = poolForDb(CONN_URL!, TEST_DB);
      const poolB = poolForDb(CONN_URL!, TEST_DB);
      const repoA = new ExecutionRepository(poolA);
      const repoB = new ExecutionRepository(poolB);
      try {
        const guard = {
          kind: "available" as const,
          accountId: "PAPER-R6-RACE",
          sessionId: "sess-r6race",
          maxSnapshotAgeMs: 60_000,
        };
        const [a, b] = await Promise.all([
          repoA.tryStartSubmissionWithExposureGuard({
            id: inserted.id,
            owner: "A",
            instrument: "PG_R6_RACE",
            conid: null,
            allowCrossContractExposure: false,
            positionGuard: guard,
          }),
          repoB.tryStartSubmissionWithExposureGuard({
            id: inserted.id,
            owner: "B",
            instrument: "PG_R6_RACE",
            conid: null,
            allowCrossContractExposure: false,
            positionGuard: guard,
          }),
        ]);
        const kinds = [a.kind, b.kind].sort();
        assert.deepEqual(kinds, ["claimed", "not_claimed"]);
        // Marker set exactly once with exactly one of the owners.
        const row = await pool.query(
          "SELECT processing_owner FROM proposed_orders WHERE id = $1",
          [inserted.id],
        );
        assert.ok(
          row.rows[0].processing_owner === "A" ||
            row.rows[0].processing_owner === "B",
        );
      } finally {
        await poolA.end();
        await poolB.end();
      }
    });

    it("allowCrossContractExposure=false: position on OLD conId blocks NEW conId (default safe policy)", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-R6-CROSS",
        sessionId: "sess-r6cross",
        observedAt: new Date(),
        complete: true,
        positions: [{ instrument: "PG_R6_CROSS", conid: "OLD", quantity: 1 }],
      });
      const ticket = { ...baseTicket("PG_R6_CROSS"), conid: "NEW" };
      const outcome = await repo.insertProposedFromTicket(
        ticket,
        "loop",
        { clientOrderId: "pg-r6-cross-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-R6-CROSS",
          sessionId: "sess-r6cross",
          maxSnapshotAgeMs: 60_000,
        },
        { allowCrossContractExposure: false },
      );
      assert.equal(outcome.kind, "open_position_exists");
    });

    it("allowCrossContractExposure=true: position on OLD conId does NOT block NEW conId", async () => {
      await repo.upsertPositionSnapshot({
        accountId: "PAPER-R6-CROSS2",
        sessionId: "sess-r6cross2",
        observedAt: new Date(),
        complete: true,
        positions: [{ instrument: "PG_R6_CROSS2", conid: "OLD", quantity: 1 }],
      });
      const ticket = { ...baseTicket("PG_R6_CROSS2"), conid: "NEW" };
      const outcome = await repo.insertProposedFromTicket(
        ticket,
        "loop",
        { clientOrderId: "pg-r6-cross2-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: "PAPER-R6-CROSS2",
          sessionId: "sess-r6cross2",
          maxSnapshotAgeMs: 60_000,
        },
        { allowCrossContractExposure: true },
      );
      assert.equal(outcome.kind, "inserted");
    });

    // -------------------------------------------------------------------
    // Round-7 blockers: broker-driven snapshot refresh + fill race.
    // -------------------------------------------------------------------

    it("fill race: seed flat → INSERT → broker snapshot updated to non-zero BEFORE claim → claim returns open_position_exists, no marker", async () => {
      const ACCT = "PAPER-R7-FILL";
      const SESS = "sess-r7-fill";
      const INSTR = "PG_R7_FILL";
      // Phase 0: initial flat snapshot allows the fresh INSERT.
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const guard = {
        kind: "available" as const,
        accountId: ACCT,
        sessionId: SESS,
        maxSnapshotAgeMs: 60_000,
      };
      const inserted = await repo.insertProposedFromTicket(
        baseTicket(INSTR),
        "loop",
        { clientOrderId: "pg-r7-fill-1", clientOrderHash: "hash" },
        guard,
      );
      if (inserted.kind !== "inserted") {
        throw new Error(`unexpected: ${inserted.kind}`);
      }

      // Phase 1: broker fills the order via a DIFFERENT (external
      // or fill-event-driven) code path. The snapshot is updated
      // to reflect a non-zero position. This is the REAL race —
      // the row is clean PROPOSED, but the world moved between
      // INSERT and claim.
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [{ instrument: INSTR, quantity: 10 }],
      });

      // Phase 2: attempt to claim the marker. Round-6 unified
      // pre-submission gate re-runs the exposure guard under the
      // same advisory lock — the fresh non-zero position must
      // block.
      const result = await repo.tryStartSubmissionWithExposureGuard({
        id: inserted.id,
        owner: "claim-owner",
        instrument: INSTR,
        conid: null,
        allowCrossContractExposure: false,
        positionGuard: guard,
      });
      assert.equal(result.kind, "open_position_exists");
      if (result.kind !== "open_position_exists") return;
      assert.equal(result.quantity, 10);
      const row = await pool.query(
        "SELECT execution_attempted_at, processing_owner FROM proposed_orders WHERE id = $1",
        [inserted.id],
      );
      assert.equal(row.rows[0].execution_attempted_at, null);
      assert.equal(row.rows[0].processing_owner, null);
    });

    it("refresh in progress (complete=false) → guard returns incomplete on both fresh and resume paths", async () => {
      const ACCT = "PAPER-R7-INPROG";
      const SESS = "sess-r7-inprog";
      const INSTR = "PG_R7_INPROG";
      // Seed a healthy snapshot, then start a refresh (complete=false).
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const begin = await repo.beginPositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      const guard = {
        kind: "available" as const,
        accountId: ACCT,
        sessionId: SESS,
        maxSnapshotAgeMs: 60_000,
      };
      // Fresh INSERT is fail-closed under the incomplete guard.
      const insertOutcome = await repo.insertProposedFromTicket(
        baseTicket(INSTR),
        "loop",
        { clientOrderId: "pg-r7-inprog-1", clientOrderHash: "hash" },
        guard,
      );
      assert.equal(insertOutcome.kind, "position_state_unavailable");
      if (insertOutcome.kind !== "position_state_unavailable") return;
      assert.equal(insertOutcome.reason, "incomplete");

      // After completePositionSnapshotRefresh the write path
      // recovers.
      const completed = await repo.completePositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        generation: begin.generation,
        positions: [],
      });
      assert.equal(completed.kind, "completed");
      const retry = await repo.insertProposedFromTicket(
        baseTicket(INSTR),
        "loop",
        { clientOrderId: "pg-r7-inprog-2", clientOrderHash: "hash" },
        guard,
      );
      assert.equal(retry.kind, "inserted");
    });

    it("beginPositionSnapshotRefresh with no prior sync row → complete=false persisted; guard fails with incomplete", async () => {
      const ACCT = "PAPER-R7-NEWACCT";
      const SESS = "sess-r7-newacct";
      // No prior snapshot at all — begin creates the row with
      // complete=false. Then the write path fails-closed with
      // `incomplete`, NOT `missing`. If the refresh later fails
      // and never completes, the write path stays fail-closed —
      // exactly the goal.
      await repo.beginPositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      const status = await repo.getPositionSnapshotStatus(ACCT);
      assert.equal(status.kind, "present");
      if (status.kind !== "present") return;
      assert.equal(status.complete, false);
      const outcome = await repo.insertProposedFromTicket(
        baseTicket("PG_R7_NEWACCT"),
        "loop",
        { clientOrderId: "pg-r7-newacct-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: ACCT,
          sessionId: SESS,
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "position_state_unavailable");
      if (outcome.kind !== "position_state_unavailable") return;
      assert.equal(outcome.reason, "incomplete");
    });

    it("completePositionSnapshotRefresh atomically replaces rows AND flips complete=true", async () => {
      const ACCT = "PAPER-R7-ATOMIC";
      const SESS = "sess-r7-atomic";
      // Seed 3 rows to prove they get replaced.
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [
          { instrument: "R7A_A", quantity: 1 },
          { instrument: "R7A_B", quantity: 2 },
          { instrument: "R7A_C", quantity: 3 },
        ],
      });
      const b1 = await repo.beginPositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      await repo.completePositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        generation: b1.generation,
        positions: [{ instrument: "R7A_A", quantity: 42 }],
      });
      const rows = await pool.query(
        "SELECT instrument, quantity FROM broker_position_snapshots WHERE account_id = $1 ORDER BY instrument",
        [ACCT],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].instrument, "R7A_A");
      assert.equal(Number(rows.rows[0].quantity), 42);
      const status = await repo.getPositionSnapshotStatus(ACCT);
      assert.equal(status.kind, "present");
      if (status.kind !== "present") return;
      assert.equal(status.complete, true);
    });

    it("FILLED local order + stale-flat snapshot + broker position event → next submit blocked", async () => {
      // Composite scenario: a prior order is FILLED, our local
      // book is aware, but the DB snapshot is still flat (fill
      // event has not landed yet). Once the broker position event
      // reaches us and we run a refresh, the NEXT submit for the
      // instrument MUST see the position and block.
      const ACCT = "PAPER-R7-FLOW";
      const SESS = "sess-r7-flow";
      const INSTR = "PG_R7_FLOW";
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      // Broker position event arrives — refresh happens
      // (begin+complete).
      const b2 = await repo.beginPositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      await repo.completePositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        generation: b2.generation,
        positions: [{ instrument: INSTR, quantity: 25 }],
      });
      // Second submit — MUST block on open_position_exists.
      const outcome = await repo.insertProposedFromTicket(
        baseTicket(INSTR),
        "loop",
        { clientOrderId: "pg-r7-flow-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: ACCT,
          sessionId: SESS,
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(outcome.kind, "open_position_exists");
    });

    // -------------------------------------------------------------------
    // Round-8 blockers: generation-fenced refresh + concurrency
    // -------------------------------------------------------------------

    it("generation fence: OLDER refresh cannot overwrite a NEWER refresh's snapshot", async () => {
      const ACCT = "PAPER-R8-GEN";
      const SESS = "sess-r8-gen";
      // Seed baseline healthy snapshot.
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      // Older refresh begins.
      const older = await repo.beginPositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      // Newer refresh begins (bumps generation ahead of `older`).
      const newer = await repo.beginPositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      assert.ok(newer.generation > older.generation);
      // Newer completes first with quantity=42.
      const newerCompleted = await repo.completePositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        generation: newer.generation,
        positions: [{ instrument: "R8_GEN", quantity: 42 }],
      });
      assert.equal(newerCompleted.kind, "completed");
      // Older completes LATER with quantity=0 — MUST be rejected.
      const olderCompleted = await repo.completePositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        generation: older.generation,
        positions: [],
      });
      assert.equal(olderCompleted.kind, "stale_generation");
      if (olderCompleted.kind !== "stale_generation") return;
      assert.equal(olderCompleted.currentGeneration, newer.generation);
      // Post-condition: the persisted row is the NEWER one.
      const rows = await pool.query(
        "SELECT instrument, quantity FROM broker_position_snapshots WHERE account_id = $1",
        [ACCT],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].instrument, "R8_GEN");
      assert.equal(Number(rows.rows[0].quantity), 42);
    });

    it("invalidatePositionSnapshot bumps generation + sets complete=false without doing a full refresh", async () => {
      const ACCT = "PAPER-R8-INV";
      const SESS = "sess-r8-inv";
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const before = await repo.getPositionSnapshotStatus(ACCT);
      assert.equal(before.kind, "present");
      const inv = await repo.invalidatePositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      const after = await repo.getPositionSnapshotStatus(ACCT);
      assert.equal(after.kind, "present");
      if (after.kind !== "present") return;
      assert.equal(after.complete, false);
      // Guard blocks with `incomplete` — even though NO fill has
      // been persisted yet, the invalidation is enough to
      // fail-close the write path.
      const guardOutcome = await repo.insertProposedFromTicket(
        baseTicket("PG_R8_INV"),
        "loop",
        { clientOrderId: "pg-r8-inv-1", clientOrderHash: "hash" },
        {
          kind: "available",
          accountId: ACCT,
          sessionId: SESS,
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(guardOutcome.kind, "position_state_unavailable");
      if (guardOutcome.kind !== "position_state_unavailable") return;
      assert.equal(guardOutcome.reason, "incomplete");
      // A subsequent complete with the invalidation's generation
      // restores the write path.
      const completed = await repo.completePositionSnapshotRefresh({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        generation: inv.generation,
        positions: [],
      });
      assert.equal(completed.kind, "completed");
    });

    it("concurrent fill-vs-claim: fill invalidation racing a submission — never both (a) fill known AND (b) marker acquired on old snapshot", async () => {
      // The disallowed outcome is: fill has been applied to
      // broker_position_snapshots (quantity != 0) AND a new marker
      // was acquired for the same instrument based on the OLD
      // flat snapshot. The lock protocol (account lock first)
      // serialises the two paths so one of the two allowed
      // outcomes holds:
      //   A. claim commits first — the guard cannot have seen
      //      the fill; the subsequent invalidation blocks any
      //      NEXT submission.
      //   B. invalidation commits first — the claim's guard
      //      observes `complete=false` and returns
      //      POSITION_STATE_UNAVAILABLE.
      const ACCT = "PAPER-R8-RACE";
      const SESS = "sess-r8-race";
      const INSTR = "PG_R8_RACE";
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      const guard = {
        kind: "available" as const,
        accountId: ACCT,
        sessionId: SESS,
        maxSnapshotAgeMs: 60_000,
      };
      // Seed a clean PROPOSED so both racers can attempt a claim.
      const inserted = await repo.insertProposedFromTicket(
        baseTicket(INSTR),
        "loop",
        { clientOrderId: "pg-r8-race-1", clientOrderHash: "hash" },
        guard,
      );
      if (inserted.kind !== "inserted") {
        throw new Error(`unexpected: ${inserted.kind}`);
      }
      // Distinct pools so the two operations truly serialise on
      // the account advisory lock inside Postgres.
      const poolA = poolForDb(CONN_URL!, TEST_DB);
      const poolB = poolForDb(CONN_URL!, TEST_DB);
      const repoA = new ExecutionRepository(poolA);
      const repoB = new ExecutionRepository(poolB);
      try {
        // Kick both off concurrently. The account advisory lock
        // enforces a total order between them.
        const claimP = repoA.tryStartSubmissionWithExposureGuard({
          id: inserted.id,
          owner: "A",
          instrument: INSTR,
          conid: null,
          allowCrossContractExposure: false,
          positionGuard: guard,
        });
        const invalidateP = repoB.invalidatePositionSnapshot({
          accountId: ACCT,
          sessionId: SESS,
          observedAt: new Date(),
        });
        const [claim, invRes] = await Promise.all([claimP, invalidateP]);
        // Whichever ran second must observe the other's effect.
        // Allowed outcomes:
        //   A. claim=claimed (ran first, before invalidate) — the
        //      invalidate then marks complete=false. A follow-up
        //      submit for the same instrument will block.
        //   B. claim=position_state_unavailable(incomplete) (ran
        //      after the invalidate) — the claim never touched
        //      the marker.
        // Disallowed: claim=claimed AND the marker was set based
        // on a snapshot that the invalidation had already changed.
        if (claim.kind === "claimed") {
          // Case A — subsequent submission MUST block because
          // invalidate has now landed OR the active intent still
          // holds a marker. Both are fail-closed outcomes; a
          // successful new marker would be the disallowed one.
          const row = await pool.query(
            "SELECT execution_attempted_at FROM proposed_orders WHERE id = $1",
            [inserted.id],
          );
          assert.notEqual(row.rows[0].execution_attempted_at, null);
          // Verify write path is now fail-closed. Either
          // `position_state_unavailable` (invalidate landed and
          // the guard trips on `incomplete`) or
          // `active_intent_exists` (invalidate landed AFTER but
          // the previously-claimed row still holds the marker).
          // Both prove no new marker was acquired on a stale
          // snapshot.
          const nextSubmit = await repoA.insertProposedFromTicket(
            baseTicket(INSTR),
            "loop",
            { clientOrderId: "pg-r8-race-follow", clientOrderHash: "h" },
            guard,
          );
          assert.ok(
            nextSubmit.kind === "position_state_unavailable" ||
              nextSubmit.kind === "active_intent_exists",
            `expected fail-closed follow-up, got kind=${nextSubmit.kind}`,
          );
        } else {
          // Case B — claim was blocked by the invalidate.
          assert.equal(claim.kind, "position_state_unavailable");
          if (claim.kind !== "position_state_unavailable") return;
          assert.equal(claim.reason, "incomplete");
        }
        void invRes;
      } finally {
        await poolA.end();
        await poolB.end();
      }
    });

    it("async FILLED path: invalidatePositionSnapshot commits BEFORE local FILLED transition", async () => {
      // Order-of-operations invariant. We simulate the callback
      // by explicitly doing the two writes in the required order
      // and then verifying the intermediate state observed by a
      // reader is (complete=false, status=SUBMITTED) rather than
      // (complete=true, status=FILLED). That intermediate state
      // is the safe fail-closed window.
      const ACCT = "PAPER-R8-ASYNC";
      const SESS = "sess-r8-async";
      const INSTR = "PG_R8_ASYNC";
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      // Seed a SUBMITTED row (mimic the state before async FILLED).
      const inserted = await pool.query(
        `INSERT INTO proposed_orders (
         instrument, side, order_type, quantity, entry, reason, confidence,
         risk_check_status, status, strategy, created_at,
         client_order_id, client_order_hash, execution_attempted_at,
         broker_order_id
       ) VALUES ($1, 'BUY', 'LMT', 10, 100.5, 'r8-async', 1, 'PASS',
                 'SUBMITTED', 'loop', NOW(), $2, $3, NOW(), 'bkr-1')
       RETURNING id`,
        [INSTR, "pg-r8-async-1", "hash"],
      );
      // Callback contract: invalidate FIRST.
      await repo.invalidatePositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      // Intermediate state: complete=false, order still SUBMITTED.
      const midStatus = await repo.getPositionSnapshotStatus(ACCT);
      assert.equal(midStatus.kind, "present");
      if (midStatus.kind !== "present") return;
      assert.equal(midStatus.complete, false);
      // A concurrent write attempt during this window must
      // fail-close with `incomplete`.
      const raceOutcome = await repo.insertProposedFromTicket(
        baseTicket(INSTR + "_2"),
        "loop",
        { clientOrderId: "pg-r8-async-race", clientOrderHash: "h" },
        {
          kind: "available",
          accountId: ACCT,
          sessionId: SESS,
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(raceOutcome.kind, "position_state_unavailable");
      // Now the local FILLED transition happens.
      await pool.query(
        "UPDATE proposed_orders SET status = 'FILLED' WHERE id = $1",
        [inserted.rows[0].id],
      );
      // Even AFTER FILLED, the write path stays fail-closed until
      // the follow-up refresh completes.
      const stillBlocked = await repo.insertProposedFromTicket(
        baseTicket(INSTR + "_3"),
        "loop",
        { clientOrderId: "pg-r8-async-still", clientOrderHash: "h" },
        {
          kind: "available",
          accountId: ACCT,
          sessionId: SESS,
          maxSnapshotAgeMs: 60_000,
        },
      );
      assert.equal(stillBlocked.kind, "position_state_unavailable");
    });

    it("refresh failure after fill: complete stays false → next submit POSITION_STATE_UNAVAILABLE", async () => {
      // Simulate: invalidate runs (complete=false), broker fetch
      // fails (in production the completePositionSnapshotRefresh
      // is never called). Every subsequent write MUST stay
      // fail-closed with `incomplete` until a successful refresh.
      const ACCT = "PAPER-R8-REFAIL";
      const SESS = "sess-r8-refail";
      await repo.upsertPositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
        complete: true,
        positions: [],
      });
      await repo.invalidatePositionSnapshot({
        accountId: ACCT,
        sessionId: SESS,
        observedAt: new Date(),
      });
      // 3 consecutive submits — all blocked.
      for (let i = 0; i < 3; i++) {
        const outcome = await repo.insertProposedFromTicket(
          baseTicket(`PG_R8_REFAIL_${i}`),
          "loop",
          { clientOrderId: `pg-r8-refail-${i}`, clientOrderHash: "h" },
          {
            kind: "available",
            accountId: ACCT,
            sessionId: SESS,
            maxSnapshotAgeMs: 60_000,
          },
        );
        assert.equal(outcome.kind, "position_state_unavailable");
        if (outcome.kind !== "position_state_unavailable") continue;
        assert.equal(outcome.reason, "incomplete");
      }
    });
  },
);
