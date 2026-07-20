/**
 * PR15 r8 — order-critical fields round-trip + persisted hash
 * verification tests. All scenarios use the real
 * `SubmissionApplicationService` with a fake broker dispatcher.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import type { PartialTakeProfit, SignalTicket } from "@ikbr/shared";

import { runMigrations } from "../migrations.js";
import { ExecutionRepository, validatePersistedOrderIdentity } from "../repository.js";
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
  const dbName = `ikbr_r8_${suffix.toLowerCase()}_${Date.now()}`;
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
const SESSION = "sess-r8";

async function seedFlatSnapshot(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO broker_snapshot_syncs (
       account_id, session_id, generation, observed_at, complete
     ) VALUES ($1, $2, 1, NOW(), TRUE)`,
    [ACCOUNT, SESSION],
  );
}

function richTicket(overrides: Partial<SignalTicket> = {}): SignalTicket {
  return {
    instrument: "AAPL",
    conid: "265598",
    side: "BUY",
    positionEffect: "OPEN_OR_ADD",
    orderType: "LMT",
    quantity: 30,
    entry: 100,
    stop: 95,
    takeProfit: 110,
    partialTakeProfits: [
      { price: 105, fraction: 0.333 },
      { price: 110, fraction: 0.333 },
    ],
    trailingStopPct: 1.5,
    trailingStopActivationR: 2,
    reason: "test",
    confidence: 0.9,
    timestamp: "2026-07-17T00:00:00.000Z",
    riskCheckStatus: "PASS",
    ...overrides,
  };
}

function buildTestService(
  pool: Pool,
  overrides: {
    dispatcher?: BrokerOrderDispatcher;
    onDispatch?: (p: BrokerDispatchPayload) => Promise<void>;
  } = {},
): { service: SubmissionApplicationService; dispatchCount: () => number; captured: { legs: PreparedBrokerOrder["legs"] | null } } {
  const repo = new ExecutionRepository(pool);
  const captured: { legs: PreparedBrokerOrder["legs"] | null } = { legs: null };
  let count = 0;
  const dispatcher: BrokerOrderDispatcher = overrides.dispatcher ?? {
    async dispatch(payload) {
      count++;
      captured.legs = payload.prepared.legs;
      if (overrides.onDispatch) await overrides.onDispatch(payload);
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
    prepareBrokerPlan: async ({ clientOrderId }) => ({
      contract: {} as PreparedBrokerOrder["contract"],
      normalizedTicket: {} as PreparedBrokerOrder["normalizedTicket"],
      plan: {} as PreparedBrokerOrder["plan"],
      legs: [
        { role: "PARENT", roleOrdinal: 0, brokerOrderId: "80001", orderRef: deriveParentOrderRef(clientOrderId) },
        { role: "TP", roleOrdinal: 1, brokerOrderId: "80002", orderRef: deriveChildOrderRef(clientOrderId, { role: "TP", ordinal: 1 }) },
        { role: "SL", roleOrdinal: 1, brokerOrderId: "80003", orderRef: deriveChildOrderRef(clientOrderId, { role: "SL", ordinal: 1 }) },
      ],
    }),
    dispatcher,
    assertKillSwitchOk: async () => undefined,
    recordAlert: () => undefined,
    triggerReconciliation: () => undefined,
    ownerId: SESSION,
    allowMarketOrder: false,
    allowCrossContractExposure: false,
    defaultTif: "GTC",
  });
  return { service, dispatchCount: () => count, captured };
}

// ---------------------------------------------------------------------------
// 1. round-trip: ticket with partialTakeProfits + trailing fields
// ---------------------------------------------------------------------------
suite("PR15 r8 §1 — order-critical fields round-trip through DB (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("ticket with partialTakeProfits + trailing preserved after INSERT/SELECT; recomputed hash equals wire hash; dispatch sees exact plan", async () => {
    const { pool, dbName } = await fresh("rt");
    try {
      await seedFlatSnapshot(pool);
      const { service, dispatchCount, captured } = buildTestService(pool);
      const ticket = richTicket();
      const wireHash = computeClientOrderHash(ticket);
      const outcome = await service.submitTicket({
        ticket, strategy: "s", clientOrderId: "r8-rt", clientOrderHash: wireHash,
      });
      assert.equal(outcome.kind, "submitted");
      assert.equal(dispatchCount(), 1);
      const row = await pool.query<{
        partial_take_profits: unknown;
        trailing_stop_pct: string | number | null;
        trailing_stop_activation_r: string | number | null;
      }>(
        `SELECT partial_take_profits, trailing_stop_pct, trailing_stop_activation_r
           FROM proposed_orders WHERE client_order_id='r8-rt'`,
      );
      const persisted = row.rows[0];
      // Round-trip: fields survived INSERT/SELECT.
      assert.deepEqual(
        persisted.partial_take_profits,
        ticket.partialTakeProfits,
      );
      assert.equal(Number(persisted.trailing_stop_pct), 1.5);
      assert.equal(Number(persisted.trailing_stop_activation_r), 2);
      // Recomputed persisted hash equals wire hash.
      const repo = new ExecutionRepository(pool);
      const rec = await repo.getExecutableProposedById(
        (await pool.query<{ id: number }>(`SELECT id FROM proposed_orders WHERE client_order_id='r8-rt'`)).rows[0].id,
      );
      assert.ok(rec);
      const check = validatePersistedOrderIdentity(rec.order, rec.clientOrderHash);
      assert.equal(check.ok, true);
      if (check.ok) {
        assert.deepEqual(check.ticket.partialTakeProfits, ticket.partialTakeProfits);
        assert.equal(check.ticket.trailingStopPct, 1.5);
        assert.equal(check.ticket.trailingStopActivationR, 2);
      }
      // Dispatcher received the plan built from the persisted row.
      assert.equal(captured.legs?.length, 3);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. mutating each field in DB → CLIENT_ORDER_HASH_MISMATCH
// ---------------------------------------------------------------------------
suite("PR15 r8 §2 — persisted mutation → CLIENT_ORDER_HASH_MISMATCH (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  const mutations: [string, (id: number, pool: Pool) => Promise<void>][] = [
    ["quantity", async (id, pool) => { await pool.query(`UPDATE proposed_orders SET quantity=1 WHERE id=$1`, [id]); }],
    ["entry", async (id, pool) => { await pool.query(`UPDATE proposed_orders SET entry=999 WHERE id=$1`, [id]); }],
    ["trailing_stop_pct", async (id, pool) => { await pool.query(`UPDATE proposed_orders SET trailing_stop_pct=99 WHERE id=$1`, [id]); }],
    ["trailing_stop_activation_r", async (id, pool) => { await pool.query(`UPDATE proposed_orders SET trailing_stop_activation_r=99 WHERE id=$1`, [id]); }],
    ["partial_take_profits", async (id, pool) => { await pool.query(`UPDATE proposed_orders SET partial_take_profits=$2::jsonb WHERE id=$1`, [id, JSON.stringify([{ price: 200, fraction: 0.5 }])]); }],
  ];
  for (const [name, mutate] of mutations) {
    it(`mutating ${name} on the DB row → hash mismatch, zero dispatch`, async () => {
      const { pool, dbName } = await fresh(`m_${name}`);
      try {
        await seedFlatSnapshot(pool);
        const { service, dispatchCount } = buildTestService(pool);
        const ticket = richTicket();
        const hash = computeClientOrderHash(ticket);
        const first = await service.submitTicket({
          ticket, strategy: "s", clientOrderId: `r8-mut-${name}`, clientOrderHash: hash,
        });
        assert.equal(first.kind, "submitted");
        // Reset to PROPOSED with marker cleared to allow retry.
        const rowId = (await pool.query<{ id: number }>(
          `SELECT id FROM proposed_orders WHERE client_order_id=$1`, [`r8-mut-${name}`],
        )).rows[0].id;
        await pool.query(
          `UPDATE proposed_orders SET status='PROPOSED', execution_attempted_at=NULL, broker_order_id=NULL, processing_owner=NULL, processing_claimed_at=NULL WHERE id=$1`,
          [rowId],
        );
        await mutate(rowId, pool);
        const before = dispatchCount();
        const retry = await service.executeProposed({
          proposedOrderId: rowId,
          overrideRejected: false,
        });
        assert.equal(retry.kind, "client_order_hash_mismatch");
        assert.equal(dispatchCount(), before);
      } finally {
        await drop(pool, dbName);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. clean PROPOSED resume: mutation via submitTicket also blocked
// ---------------------------------------------------------------------------
suite("PR15 r8 §3 — clean PROPOSED resume path recomputes persisted hash (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("resume via submitTicket after DB mutation → CLIENT_ORDER_HASH_MISMATCH, zero dispatch", async () => {
    const { pool, dbName } = await fresh("resmut");
    try {
      await seedFlatSnapshot(pool);
      const { service, dispatchCount } = buildTestService(pool);
      const ticket = richTicket();
      const hash = computeClientOrderHash(ticket);
      // Insert a clean PROPOSED row (no marker) directly.
      await pool.query(
        `INSERT INTO proposed_orders (
           instrument, conid, side, position_effect, order_type, quantity, entry,
           stop, take_profit, partial_take_profits, trailing_stop_pct,
           trailing_stop_activation_r, reason, confidence, risk_check_status,
           status, client_order_id, client_order_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,'PROPOSED',$16,$17)`,
        [ticket.instrument, ticket.conid, ticket.side, ticket.positionEffect,
         ticket.orderType, ticket.quantity, ticket.entry, ticket.stop,
         ticket.takeProfit, JSON.stringify(ticket.partialTakeProfits),
         ticket.trailingStopPct, ticket.trailingStopActivationR,
         ticket.reason, ticket.confidence, ticket.riskCheckStatus,
         "r8-res", hash],
      );
      // Mutate persisted quantity so recomputed hash diverges.
      await pool.query(
        `UPDATE proposed_orders SET quantity=1 WHERE client_order_id='r8-res'`,
      );
      const outcome = await service.submitTicket({
        ticket, strategy: "s", clientOrderId: "r8-res", clientOrderHash: hash,
      });
      assert.equal(outcome.kind, "client_order_hash_mismatch");
      assert.equal(dispatchCount(), 0);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Fresh DB from migrations has the required columns
// ---------------------------------------------------------------------------
suite("PR15 r8 §4 — fresh DB from migrations only has required columns (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("proposed_orders has partial_take_profits, trailing_stop_pct, trailing_stop_activation_r", async () => {
    const { pool, dbName } = await fresh("cols");
    try {
      const res = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='proposed_orders'
            AND column_name IN ('partial_take_profits','trailing_stop_pct','trailing_stop_activation_r')`,
      );
      const cols = res.rows.map((r) => r.column_name).sort();
      assert.deepEqual(cols, [
        "partial_take_profits",
        "trailing_stop_activation_r",
        "trailing_stop_pct",
      ]);
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed partial_take_profits blocks submission
// ---------------------------------------------------------------------------
suite("PR15 r8 §5 — malformed partialTakeProfits blocks submission", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("negative fraction → fail-closed, zero INSERT, zero dispatch", async () => {
    const { pool, dbName } = await fresh("mal");
    try {
      await seedFlatSnapshot(pool);
      const { service, dispatchCount } = buildTestService(pool);
      const bad: SignalTicket = richTicket({
        partialTakeProfits: [{ price: 100, fraction: -0.5 } as PartialTakeProfit],
      });
      const outcome = await service.submitTicket({
        ticket: bad, strategy: "s", clientOrderId: "r8-mal", clientOrderHash: computeClientOrderHash(bad),
      });
      assert.equal(outcome.kind, "execution_error");
      assert.equal(dispatchCount(), 0);
      const rows = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM proposed_orders`,
      );
      assert.equal(rows.rows[0].n, "0");
    } finally {
      await drop(pool, dbName);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. executeProposed happy path: clean PROPOSED with rich fields
//    dispatches exactly once and prepare/dispatcher see every
//    order-critical field unchanged.
// ---------------------------------------------------------------------------
suite("PR15 r8 §6 — executeProposed happy path with rich fields (PG)", () => {
  if (!CONN_URL) {
    it("skipped — set TEST_POSTGRES_URL", () => assert.ok(true));
    return;
  }
  it("clean PROPOSED with partialTakeProfits + trailing fields + matching hash → SUBMITTED, exactly one dispatch, prepare receives every field", async () => {
    const { pool, dbName } = await fresh("epok");
    try {
      await seedFlatSnapshot(pool);
      const preparedFor: { order?: unknown } = {};
      let dispatchCount = 0;
      const capturedLegs: { legs?: PreparedBrokerOrder["legs"] } = {};
      const repo = new ExecutionRepository(pool);
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
        prepareBrokerPlan: async ({ order, clientOrderId }) => {
          // Record the order handed to prepare so the test can
          // assert every rich field survived.
          preparedFor.order = order;
          return {
            contract: {} as PreparedBrokerOrder["contract"],
            normalizedTicket: {} as PreparedBrokerOrder["normalizedTicket"],
            plan: {} as PreparedBrokerOrder["plan"],
            legs: [
              { role: "PARENT", roleOrdinal: 0, brokerOrderId: "80001", orderRef: deriveParentOrderRef(clientOrderId) },
              { role: "TP", roleOrdinal: 1, brokerOrderId: "80002", orderRef: deriveChildOrderRef(clientOrderId, { role: "TP", ordinal: 1 }) },
              { role: "SL", roleOrdinal: 1, brokerOrderId: "80003", orderRef: deriveChildOrderRef(clientOrderId, { role: "SL", ordinal: 1 }) },
            ],
          };
        },
        dispatcher: {
          async dispatch(payload) {
            dispatchCount++;
            capturedLegs.legs = payload.prepared.legs;
            return { brokerOrderId: payload.prepared.legs[0].brokerOrderId, status: "SUBMITTED" };
          },
        },
        assertKillSwitchOk: async () => undefined,
        recordAlert: () => undefined,
        triggerReconciliation: () => undefined,
        ownerId: SESSION,
        allowMarketOrder: false,
        allowCrossContractExposure: false,
        defaultTif: "GTC",
      });
      const ticket = richTicket();
      const hash = computeClientOrderHash(ticket);
      const cid = "r8-ep-ok";
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO proposed_orders (
           instrument, conid, side, position_effect, order_type, quantity, entry,
           stop, take_profit, partial_take_profits, trailing_stop_pct,
           trailing_stop_activation_r, reason, confidence, risk_check_status,
           status, client_order_id, client_order_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,'PROPOSED',$16,$17)
         RETURNING id`,
        [ticket.instrument, ticket.conid, ticket.side, ticket.positionEffect,
         ticket.orderType, ticket.quantity, ticket.entry, ticket.stop,
         ticket.takeProfit, JSON.stringify(ticket.partialTakeProfits),
         ticket.trailingStopPct, ticket.trailingStopActivationR,
         ticket.reason, ticket.confidence, ticket.riskCheckStatus,
         cid, hash],
      );
      const outcome = await service.executeProposed({
        proposedOrderId: Number(inserted.rows[0].id),
        overrideRejected: false,
      });
      assert.equal(outcome.kind, "resumed");
      if (outcome.kind === "resumed") {
        assert.equal(outcome.execution.status, "SUBMITTED");
      }
      assert.equal(dispatchCount, 1);
      // Prepare received a persisted order with every rich
      // field unchanged.
      const p = preparedFor.order as {
        partialTakeProfits?: unknown;
        trailingStopPct?: number;
        trailingStopActivationR?: number;
        quantity?: number;
        entry?: number;
      };
      assert.deepEqual(p.partialTakeProfits, ticket.partialTakeProfits);
      assert.equal(p.trailingStopPct, ticket.trailingStopPct);
      assert.equal(p.trailingStopActivationR, ticket.trailingStopActivationR);
      assert.equal(p.quantity, ticket.quantity);
      assert.equal(p.entry, ticket.entry);
      assert.equal(capturedLegs.legs?.length, 3);
    } finally {
      await drop(pool, dbName);
    }
  });
});
