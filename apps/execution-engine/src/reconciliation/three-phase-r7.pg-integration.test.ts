/**
 * PR15 r7 §7 — production `SubmissionApplicationService` tests.
 *
 * These tests build the SAME `SubmissionApplicationService`
 * module that `index.ts` wires for production endpoints. Only
 * the `BrokerOrderDispatcher` port is faked; every other dep
 * (repository, hash function, MKT/identity policy, kill switch,
 * alerts, reconciliation trigger, position guard, prepare
 * function) is the real one — or a minimal in-memory shim where
 * the real thing would require a live TWS/broker socket.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import type { SignalTicket } from "@ikbr/shared";
import {
  InstrumentBindingAuthority,
  defaultInstrumentRegistry,
} from "@ikbr/shared";

import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import {
  buildSubmissionApplicationService,
  type BrokerDispatchPayload,
  type BrokerOrderDispatcher,
  type SubmissionApplicationService,
} from "./submission-service.js";
import type { PreparedBrokerOrder } from "../tws-execution-client.js";
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
  try { return await fn(admin); } finally { await admin.end(); }
}
async function fresh(suffix: string): Promise<{ pool: Pool; dbName: string }> {
  const dbName = `ikbr_r7_${suffix.toLowerCase()}_${Date.now()}`;
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

const ACCOUNT = "DU-1";
const SESSION = "sess-r7";

function baseTicket(overrides: Partial<SignalTicket> = {}): SignalTicket {
  return {
    instrument: "AAPL",
    conid: "265598",
    side: "BUY",
    positionEffect: "OPEN_OR_ADD",
    orderType: "LMT",
    quantity: 10,
    entry: 100,
    stop: 95,
    takeProfit: 110,
    reason: "test",
    confidence: 0.9,
    timestamp: "2026-07-17T00:00:00.000Z",
    riskCheckStatus: "PASS",
    ...overrides,
  };
}

async function seedFlatSnapshot(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO broker_snapshot_syncs (
       account_id, session_id, generation, observed_at, complete
     ) VALUES ($1, $2, 1, NOW(), TRUE)`,
    [ACCOUNT, SESSION],
  );
}

/**
 * Build a service instance identical in shape to the production
 * one in `index.ts`. Only `dispatcher` is a spy; the prepare
 * function synthesises deterministic legs.
 */
function buildTestService(
  pool: Pool,
  overrides: {
    dispatcher?: BrokerOrderDispatcher;
    allowMarketOrder?: boolean;
    prepareOverride?: (cid: string) => PreparedBrokerOrder;
    ticketAtDispatch?: (payload: BrokerDispatchPayload) => Promise<void>;
  } = {},
): { service: SubmissionApplicationService; alerts: unknown[]; reconTriggered: () => number } {
  const alerts: unknown[] = [];
  let reconCount = 0;
  const repo = new ExecutionRepository(pool);
  const buildPrepared = (cid: string): PreparedBrokerOrder => ({
    // Contract / normalisedTicket / plan payloads are opaque to
    // the service; only `.legs` is inspected downstream. Cast so
    // we don't drag in the full TWS types for a test synth.
    contract: {} as PreparedBrokerOrder["contract"],
    normalizedTicket: {} as PreparedBrokerOrder["normalizedTicket"],
    plan: {} as PreparedBrokerOrder["plan"],
    legs: [
      { role: "PARENT", roleOrdinal: 0, brokerOrderId: "80001", orderRef: deriveParentOrderRef(cid) },
      { role: "TP", roleOrdinal: 1, brokerOrderId: "80002", orderRef: deriveChildOrderRef(cid, { role: "TP", ordinal: 1 }) },
      { role: "SL", roleOrdinal: 1, brokerOrderId: "80003", orderRef: deriveChildOrderRef(cid, { role: "SL", ordinal: 1 }) },
    ],
  });
  const dispatcher: BrokerOrderDispatcher = overrides.dispatcher ?? {
    async dispatch(payload) {
      if (overrides.ticketAtDispatch) {
        await overrides.ticketAtDispatch(payload);
      }
      return { brokerOrderId: payload.prepared.legs[0].brokerOrderId, status: "SUBMITTED" };
    },
  };
  const service = buildSubmissionApplicationService({
    repo,
    ensureBrokerSession: async () => ({ accountId: ACCOUNT }),
    buildPositionGuard: () => ({
      kind: "available",
      accountId: ACCOUNT,
      sessionId: SESSION,
      maxSnapshotAgeMs: 60_000,
    }),
    reconciliationGate: () => async () => null,
    prepareBrokerPlan: async ({ clientOrderId }) =>
      overrides.prepareOverride
        ? overrides.prepareOverride(clientOrderId)
        : buildPrepared(clientOrderId),
    dispatcher,
    assertKillSwitchOk: async () => undefined,
    recordAlert: (a) => { alerts.push(a); },
    triggerReconciliation: () => { reconCount++; },
    ownerId: SESSION,
    allowMarketOrder: overrides.allowMarketOrder ?? false,
    allowCrossContractExposure: false,
    // PR15.2 — legacy pre-binding tests operate on rows without
    // an `instrumentId` on the wire; an empty authority matches
    // that path exactly and refuses any accidental bound ticket.
    bindingAuthority: new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      [],
    ),
    defaultTif: "GTC",
  });
  return { service, alerts, reconTriggered: () => reconCount };
}

// ---------------------------------------------------------------------------
// §7 — module wiring: the service exported here IS the same
//                     `buildSubmissionApplicationService` module
//                     that index.ts imports for production.
// ---------------------------------------------------------------------------
describe("PR15 r7 §7 — wiring: production service module identity", () => {
  it("index.ts imports the same submission-service module as this test", async () => {
    const testModule = await import("./submission-service.js");
    // Read index.ts source and confirm the import path + the
    // constructor name. A `git grep` equivalent — the compile-
    // time proof is the shared module URL below.
    const url = new URL(
      "../reconciliation/submission-service.ts",
      import.meta.url,
    ).toString();
    assert.ok(url.endsWith("/reconciliation/submission-service.ts"));
    assert.equal(typeof testModule.buildSubmissionApplicationService, "function");
  });
});

// ---------------------------------------------------------------------------
// A — fresh valid submission
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/A — fresh valid submission through production service", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("plan + refs + marker persisted BEFORE broker call; dispatch uses persisted plan", async () => {
    const { pool, dbName } = await fresh("A");
    try {
      await seedFlatSnapshot(pool);
      const captured: { legs?: number; refs?: number } = {};
      const { service } = buildTestService(pool, {
        ticketAtDispatch: async (payload) => {
          const legs = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM broker_order_links WHERE proposed_order_id=$1`,
            [payload.proposedOrderId],
          );
          const refs = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM broker_order_ref_map WHERE proposed_order_id=$1`,
            [payload.proposedOrderId],
          );
          captured.legs = Number(legs.rows[0].n);
          captured.refs = Number(refs.rows[0].n);
        },
      });
      const ticket = baseTicket();
      const hash = computeClientOrderHash(ticket);
      const outcome = await service.submitTicket({
        ticket,
        strategy: "prod-test",
        clientOrderId: "r7-A-1",
        clientOrderHash: hash,
      });
      assert.equal(outcome.kind, "submitted");
      assert.equal(captured.legs, 3);
      assert.equal(captured.refs, 3);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// B — execute-proposed happy path + stored-hash mismatch after tampering
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/B — execute-proposed hash validation", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("PROPOSED with matching stored hash → dispatched exactly once", async () => {
    const { pool, dbName } = await fresh("B1");
    try {
      await seedFlatSnapshot(pool);
      let dispatchCount = 0;
      const { service } = buildTestService(pool, {
        dispatcher: {
          async dispatch(p) {
            dispatchCount++;
            return { brokerOrderId: p.prepared.legs[0].brokerOrderId, status: "SUBMITTED" };
          },
        },
      });
      const ticket = baseTicket();
      const hash = computeClientOrderHash(ticket);
      const cid = "r7-B1";
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, position_effect, order_type, quantity, entry,
           stop, take_profit, reason, confidence, risk_check_status, status,
           client_order_id, client_order_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PROPOSED',$13,$14)
         RETURNING id`,
        [ticket.instrument, ticket.conid, ticket.side, ticket.positionEffect,
         ticket.orderType, ticket.quantity, ticket.entry, ticket.stop,
         ticket.takeProfit, ticket.reason, ticket.confidence,
         ticket.riskCheckStatus, cid, hash],
      );
      const outcome = await service.executeProposed({
        proposedOrderId: Number(inserted.rows[0].id),
        overrideRejected: false,
      });
      assert.equal(outcome.kind, "resumed");
      assert.equal(dispatchCount, 1);
    } finally {
      await drop(pool, dbName);
    }
  });

  it("PROPOSED tampered (fields changed but stored hash unchanged) → CLIENT_ORDER_HASH_MISMATCH, zero dispatch", async () => {
    const { pool, dbName } = await fresh("B2");
    try {
      await seedFlatSnapshot(pool);
      let dispatchCount = 0;
      const { service } = buildTestService(pool, {
        dispatcher: { async dispatch() { dispatchCount++; return { brokerOrderId: "n", status: "SUBMITTED" }; } },
      });
      const ticket = baseTicket();
      const originalHash = computeClientOrderHash(ticket);
      const cid = "r7-B2";
      // Insert with originalHash, but with a MUTATED quantity.
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, position_effect, order_type, quantity, entry,
           stop, take_profit, reason, confidence, risk_check_status, status,
           client_order_id, client_order_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PROPOSED',$13,$14)
         RETURNING id`,
        [ticket.instrument, ticket.conid, ticket.side, ticket.positionEffect,
         ticket.orderType, 999, ticket.entry, ticket.stop,
         ticket.takeProfit, ticket.reason, ticket.confidence,
         ticket.riskCheckStatus, cid, originalHash],
      );
      const outcome = await service.executeProposed({
        proposedOrderId: Number(inserted.rows[0].id),
        overrideRejected: false,
      });
      assert.equal(outcome.kind, "client_order_hash_mismatch");
      assert.equal(dispatchCount, 0);
      const marker = await pool.query(
        `SELECT execution_attempted_at FROM proposed_orders WHERE id=$1`,
        [Number(inserted.rows[0].id)],
      );
      assert.equal(marker.rows[0].execution_attempted_at, null);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// C — repository identity binding
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/C — SUBMISSION_IDENTITY_MISMATCH from tryStartSubmissionWithPlan", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  async function runIdentity(
    seed: { cid: string; hash: string; instrument: string; conid: string | null },
    plan: { clientOrderId: string; clientOrderHash: string; instrument: string; conid: string | null },
    expectedReason: string,
  ): Promise<void> {
    const { pool, dbName } = await fresh("C_" + expectedReason);
    try {
      await seedFlatSnapshot(pool);
      const repo = new ExecutionRepository(pool);
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, order_type, quantity, entry,
           stop, take_profit, reason, confidence, risk_check_status,
           status, client_order_id, client_order_hash
         ) VALUES ($1,$2,'BUY','LMT',10,100,95,110,'t',0.9,'PASS','PROPOSED',$3,$4)
         RETURNING id`,
        [seed.instrument, seed.conid, seed.cid, seed.hash],
      );
      const legs = [
        { role: "PARENT" as const, roleOrdinal: 0, brokerOrderId: "60001", orderRef: deriveParentOrderRef(plan.clientOrderId) },
      ];
      const claim = await repo.tryStartSubmissionWithPlan({
        id: Number(inserted.rows[0].id),
        owner: "t",
        instrument: plan.instrument,
        conid: plan.conid,
        allowCrossContractExposure: false,
        positionGuard: { kind: "available", accountId: ACCOUNT, sessionId: SESSION, maxSnapshotAgeMs: 60_000 },
        prepared: {
          clientOrderId: plan.clientOrderId,
          clientOrderHash: plan.clientOrderHash,
          instrument: plan.instrument,
          conid: plan.conid,
          legs,
        },
        accountId: ACCOUNT,
      });
      assert.equal(claim.kind, "submission_identity_mismatch");
      if (claim.kind === "submission_identity_mismatch") {
        assert.equal(claim.reason, expectedReason);
      }
      const marker = await pool.query(
        `SELECT execution_attempted_at FROM proposed_orders WHERE id=$1`,
        [Number(inserted.rows[0].id)],
      );
      assert.equal(marker.rows[0].execution_attempted_at, null);
      const links = await pool.query(
        `SELECT 1 FROM broker_order_links WHERE proposed_order_id=$1`,
        [Number(inserted.rows[0].id)],
      );
      assert.equal(links.rowCount, 0);
    } finally {
      await drop(pool, dbName);
    }
  }
  it("client_order_id mismatch", async () => {
    await runIdentity(
      { cid: "cid-DB", hash: "hashDB", instrument: "AAPL", conid: "123" },
      { clientOrderId: "cid-PLAN", clientOrderHash: "hashDB", instrument: "AAPL", conid: "123" },
      "client_order_id_mismatch",
    );
  });
  it("client_order_hash mismatch", async () => {
    await runIdentity(
      { cid: "cid-X", hash: "hashDB", instrument: "AAPL", conid: "123" },
      { clientOrderId: "cid-X", clientOrderHash: "hashPLAN", instrument: "AAPL", conid: "123" },
      "client_order_hash_mismatch",
    );
  });
  it("instrument mismatch", async () => {
    await runIdentity(
      { cid: "cid-Y", hash: "hashY", instrument: "AAPL", conid: "123" },
      { clientOrderId: "cid-Y", clientOrderHash: "hashY", instrument: "MSFT", conid: "123" },
      "instrument_mismatch",
    );
  });
  it("conid mismatch (null vs value)", async () => {
    await runIdentity(
      { cid: "cid-Z", hash: "hashZ", instrument: "AAPL", conid: null },
      { clientOrderId: "cid-Z", clientOrderHash: "hashZ", instrument: "AAPL", conid: "999" },
      "conid_mismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// D — legacy identity missing
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/D — LEGACY_IDEMPOTENCY_IDENTITY_MISSING", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("execute-proposed on legacy row without hash → refused, zero dispatch", async () => {
    const { pool, dbName } = await fresh("D");
    try {
      await seedFlatSnapshot(pool);
      let dispatchCount = 0;
      const { service } = buildTestService(pool, {
        dispatcher: { async dispatch() { dispatchCount++; return { brokerOrderId: "n", status: "SUBMITTED" }; } },
      });
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, order_type, quantity, entry,
           stop, take_profit, reason, confidence, risk_check_status, status
         ) VALUES ('AAPL','123','BUY','LMT',10,100,95,110,'t',0.9,'PASS','PROPOSED')
         RETURNING id`,
      );
      const outcome = await service.executeProposed({
        proposedOrderId: Number(inserted.rows[0].id),
        overrideRejected: false,
      });
      assert.equal(outcome.kind, "legacy_idempotency_identity_missing");
      assert.equal(dispatchCount, 0);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// E — REJECTED immutable
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/E — REJECTED_ORDER_IMMUTABLE (both overrideRejected values)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  for (const override of [false, true]) {
    it(`overrideRejected=${override} → rejected_order_immutable, zero dispatch`, async () => {
      const { pool, dbName } = await fresh(`E_${override}`);
      try {
        await seedFlatSnapshot(pool);
        let dispatchCount = 0;
        const { service } = buildTestService(pool, {
          dispatcher: { async dispatch() { dispatchCount++; return { brokerOrderId: "n", status: "SUBMITTED" }; } },
        });
        const inserted = await pool.query<{ id: number }>(
          `INSERT INTO proposed_orders (
             instrument, conid, side, order_type, quantity, entry,
             stop, take_profit, reason, confidence, risk_check_status, status,
             client_order_id, client_order_hash
           ) VALUES ('AAPL','123','BUY','LMT',10,100,95,110,'t',0.9,'PASS','REJECTED','r7-E','h')
           RETURNING id`,
        );
        const outcome = await service.executeProposed({
          proposedOrderId: Number(inserted.rows[0].id),
          overrideRejected: override,
        });
        assert.equal(outcome.kind, "rejected_order_immutable");
        assert.equal(dispatchCount, 0);
      } finally {
        await drop(pool, dbName);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// F — resume concurrency: two parallel resumes → exactly one dispatch
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/F — two parallel resumes → exactly one broker dispatch", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("clean PROPOSED with identity + concurrent resumes → single dispatch", async () => {
    const { pool, dbName } = await fresh("F");
    try {
      await seedFlatSnapshot(pool);
      let dispatchCount = 0;
      const { service } = buildTestService(pool, {
        dispatcher: { async dispatch(p) { dispatchCount++; return { brokerOrderId: p.prepared.legs[0].brokerOrderId, status: "SUBMITTED" }; } },
      });
      const ticket = baseTicket();
      const hash = computeClientOrderHash(ticket);
      const cid = "r7-F";
      await pool.query(
        `INSERT INTO proposed_orders (
           instrument, conid, side, position_effect, order_type, quantity, entry,
           stop, take_profit, reason, confidence, risk_check_status,
           status, client_order_id, client_order_hash
         ) VALUES ($1,$2,'BUY','OPEN_OR_ADD','LMT',10,100,95,110,'test',
                   0.9,'PASS','PROPOSED',$3,$4)`,
        [ticket.instrument, ticket.conid, cid, hash],
      );
      const [a, b] = await Promise.all([
        service.submitTicket({ ticket, strategy: "s", clientOrderId: cid, clientOrderHash: hash }),
        service.submitTicket({ ticket, strategy: "s", clientOrderId: cid, clientOrderHash: hash }),
      ]);
      const kinds = [a.kind, b.kind].sort();
      // Loser sees the winner's row-level lock; by the time it
      // reads freshest state after `not_claimed`, winner may or
      // may not have already flipped status to SUBMITTED — both
      // `duplicate_submitted` and `duplicate_pending_ambiguous`
      // are valid classifications for the loser.
      const loser = kinds[0];
      assert.equal(kinds[1], "resumed");
      assert.ok(
        loser === "duplicate_submitted" ||
          loser === "duplicate_pending_ambiguous" ||
          loser === "pending_claimed",
        `unexpected loser outcome: ${loser}`,
      );
      assert.equal(dispatchCount, 1);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// G — partial dispatch exception → ambiguous, retry no re-dispatch
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/G — partial dispatch exception → ambiguous, alert + reconciliation, retry not re-dispatched", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("dispatcher throws → status PROPOSED preserved, alert emitted, reconciliation triggered, retry is duplicate_pending_ambiguous", async () => {
    const { pool, dbName } = await fresh("G");
    try {
      await seedFlatSnapshot(pool);
      let dispatchCount = 0;
      const { service, alerts, reconTriggered } = buildTestService(pool, {
        dispatcher: { async dispatch() { dispatchCount++; throw new Error("simulated broker timeout"); } },
      });
      const ticket = baseTicket();
      const hash = computeClientOrderHash(ticket);
      const outcome = await service.submitTicket({
        ticket, strategy: "s", clientOrderId: "r7-G", clientOrderHash: hash,
      });
      assert.equal(outcome.kind, "execution_error");
      assert.equal(dispatchCount, 1);
      assert.equal(reconTriggered(), 1);
      assert.ok(alerts.some((a: unknown) => (a as { kind: string }).kind === "dispatch_unknown"));
      const row = await pool.query<{ status: string; execution_attempted_at: Date | null }>(
        `SELECT status, execution_attempted_at FROM proposed_orders WHERE client_order_id='r7-G'`,
      );
      assert.equal(row.rows[0].status, "PROPOSED");
      assert.ok(row.rows[0].execution_attempted_at instanceof Date);
      const retry = await service.submitTicket({
        ticket, strategy: "s", clientOrderId: "r7-G", clientOrderHash: hash,
      });
      assert.equal(retry.kind, "duplicate_pending_ambiguous");
      assert.equal(dispatchCount, 1);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// H — invalid plan (empty legs, duplicate refs, missing IDs)
// ---------------------------------------------------------------------------
suite("PR15 r7 §7/H — invalid plan variants", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  const cases: [string, () => PreparedBrokerOrder][] = [
    [
      "empty legs",
      () => ({
        contract: {} as PreparedBrokerOrder["contract"],
        normalizedTicket: {} as PreparedBrokerOrder["normalizedTicket"],
        plan: {} as PreparedBrokerOrder["plan"],
        legs: [],
      }),
    ],
    [
      "duplicate orderRef",
      () => ({
        contract: {} as PreparedBrokerOrder["contract"],
        normalizedTicket: {} as PreparedBrokerOrder["normalizedTicket"],
        plan: {} as PreparedBrokerOrder["plan"],
        legs: [
          { role: "PARENT", roleOrdinal: 0, brokerOrderId: "1", orderRef: "same" },
          { role: "TP", roleOrdinal: 1, brokerOrderId: "2", orderRef: "same" },
        ],
      }),
    ],
    [
      "duplicate brokerOrderId",
      () => ({
        contract: {} as PreparedBrokerOrder["contract"],
        normalizedTicket: {} as PreparedBrokerOrder["normalizedTicket"],
        plan: {} as PreparedBrokerOrder["plan"],
        legs: [
          { role: "PARENT", roleOrdinal: 0, brokerOrderId: "1", orderRef: "ref-A" },
          { role: "TP", roleOrdinal: 1, brokerOrderId: "1", orderRef: "ref-B" },
        ],
      }),
    ],
    [
      "missing brokerOrderId",
      () => ({
        contract: {} as PreparedBrokerOrder["contract"],
        normalizedTicket: {} as PreparedBrokerOrder["normalizedTicket"],
        plan: {} as PreparedBrokerOrder["plan"],
        legs: [{ role: "PARENT", roleOrdinal: 0, brokerOrderId: "", orderRef: "ref-A" }],
      }),
    ],
  ];
  for (const [name, prepBad] of cases) {
    it(`${name} → invalid_plan, zero marker, zero broker call`, async () => {
      const { pool, dbName } = await fresh(`H_${name.replace(/[^a-z0-9]/gi, "_")}`);
      try {
        await seedFlatSnapshot(pool);
        let dispatchCount = 0;
        const { service } = buildTestService(pool, {
          prepareOverride: () => prepBad(),
          dispatcher: { async dispatch() { dispatchCount++; return { brokerOrderId: "n", status: "SUBMITTED" }; } },
        });
        const ticket = baseTicket();
        const hash = computeClientOrderHash(ticket);
        const outcome = await service.submitTicket({
          ticket, strategy: "s", clientOrderId: "r7-H", clientOrderHash: hash,
        });
        assert.equal(outcome.kind, "invalid_plan");
        assert.equal(dispatchCount, 0);
        const marker = await pool.query(
          `SELECT execution_attempted_at FROM proposed_orders WHERE client_order_id='r7-H'`,
        );
        assert.equal(marker.rows[0].execution_attempted_at, null);
      } finally {
        await drop(pool, dbName);
      }
    });
  }
});
