import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { InstrumentBindingAuthority, InstrumentRegistry, type Instrument, type SignalTicket } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { assessAiEntryRisk } from "../ai-entry-risk.js";
import { buildSubmissionApplicationService } from "./submission-service.js";
import { deriveChildOrderRef, deriveParentOrderRef } from "./order-ref.js";
import type { AccountSnapshot } from "../tws-execution-client.js";

const connection = process.env.TEST_POSTGRES_URL;
const accountId = "DU-AI-TEST";
const sessionId = "ai-test-session";
const decision = { decision: "EXECUTE", reason: "source evidence supports test", confidence: 0.8,
  model: "fake-model", promptVersion: "test-v1", context: { news: [] } };

function instrument(id = "test", symbol = "TEST"): Instrument {
  return { id, displayName: "Synthetic integration fixture", broker: "ibkr", brokerSymbol: symbol, exchange: "SMART",
    assetClass: "stock", currency: "USD", metadata: { tags: [] },
    session: { useRegularTradingHours: true, timezone: "America/New_York", sessionTemplate: "us_stock_rth" },
    trading: { executionEnabled: true, signalGenerationEnabled: true, aiAnalysisEnabled: true, monitoringEnabled: true },
    risk: { maxLeverage: 1, allowOvernight: false, quantityUnit: "shares", maxQuantity: 1, maxSpread: 1, maxSlippage: 1 },
    executionPolicy: { strategyId: "test_strategy", expectedDirection: "LONG", timeframe: "1m", quantity: 1,
      maxQuantity: 1, quantityUnit: "shares", allowedOrderTypes: ["LMT"], defaultOrderType: "LMT",
      timeInForce: "DAY", outsideRth: false, transmit: true, priceTickSize: 0.01, priceRoundingMode: "nearest" } };
}
function ticket(overrides: Partial<SignalTicket> = {}): SignalTicket {
  return { instrument: "TEST", instrumentId: "test", conid: "123", side: "BUY", orderType: "LMT",
    quantity: 1, entry: 100, stop: 99, takeProfit: 102, confidence: 0.8, reason: "strategy proposal",
    timestamp: new Date().toISOString(), riskCheckStatus: "PASS", ...overrides };
}

async function fixture(currency: "USD" | "PLN" = "USD") {
  const exchange = currency === "PLN" ? "WSE" : "SMART";
  const database = `ikbr_ai_service_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString() });
  await runMigrations(pool);
  const repo = new ExecutionRepository(pool);
  await pool.query(`INSERT INTO broker_snapshot_syncs (account_id,session_id,generation,observed_at,complete)
    VALUES ($1,$2,1,clock_timestamp(),true)`, [accountId, sessionId]);
  const selectedInstrument = { ...instrument(), currency, exchange };
  const authority = new InstrumentBindingAuthority(new InstrumentRegistry([selectedInstrument, instrument("other", "OTHER")]), [
    { instrumentId: "test", conId: 123, localSymbol: "TEST", tradingClass: "TEST", exchange, currency, minTick: 0.01 },
    { instrumentId: "other", conId: 456, localSymbol: "OTHER", tradingClass: "OTHER", exchange: "SMART", currency: "USD", minTick: 0.01 },
  ]);
  const state = { prepares: 0, dispatches: 0, uncertain: false, staleQuote: false, ageDuringPrepare: false,
    alteredPreparedPrice: false, rejectDuringPrepare: false, missingPlnEvidence: false,
    session: sessionId, account: accountId };
  const service = buildSubmissionApplicationService({ repo, bindingAuthority: authority,
    ensureBrokerSession: async () => ({ accountId: state.account }),
    buildPositionGuard: () => ({ kind: "available", accountId: state.account, sessionId: state.session, maxSnapshotAgeMs: 60000 }),
    reconciliationGate: () => async () => null,
    assessAiRisk: async (order, bound, account, session) => {
      const now = Date.now();
      const quoteTime = new Date(now - (state.staleQuote ? 11000 : state.ageDuringPrepare ? 9900 : 1)).toISOString();
      const snapshot: AccountSnapshot = { accountId: account, retrievedAt: new Date(now).toISOString(), metrics: {}, positions: [],
        totals: { positionsCount: 0, longExposure: 0, shortExposure: 0, grossExposure: 0, netExposure: 0, unrealizedPnL: 0, realizedPnL: 0 },
        riskEvidence: { requestStartedAt: new Date(now - 1).toISOString(), completedAt: new Date(now).toISOString(),
          complete: true, configuredBaseCurrency: "USD",
          exchangeRatesToBase: state.missingPlnEvidence ? {} : { USD: 1, PLN: .25 }, cashByCurrency: { PLN: 500 }, usdMetrics: { netLiquidation: 10000, availableFunds: 5000, grossPositionValue: 0 } } };
      return assessAiEntryRisk({ order, bound, accountId: account, sessionId: session, nowMs: now, snapshot,
        limits: { maxNotionalPct: 10, maxStopRiskPct: 0.5, maxExposurePct: 25,
          pln: { maxNotional: 500, maxStopRisk: 5, feeReserve: 30 } },
        watchlist: { connected: true, watchlist: [{ instrumentId: order.instrumentId, conid: order.conid, subscribed: true,
          marketState: { conid: order.conid, bid: 99.5, ask: 100, marketDataType: 1, bidObservedAt: quoteTime, askObservedAt: quoteTime } }] } });
    },
    prepareBrokerPlan: async ({ order, clientOrderId }) => {
      state.prepares++;
      if (state.ageDuringPrepare) await pool.query("SELECT pg_sleep(0.15)");
      if (state.rejectDuringPrepare) await repo.rejectPendingProposal(order.id!, "concurrent rejection");
      const base = 10000 + state.prepares * 10;
      return { contract: { symbol: order.instrument, conId: Number(order.conid), secType: "STK", currency, exchange },
        normalizedTicket: state.alteredPreparedPrice ? { ...order, entry: 101 } : order, plan: { parentOrderId: base, orders: [], relatedOrderIds: new Set([base, base + 1, base + 2]) },
        legs: [ { role: "PARENT", roleOrdinal: 0, brokerOrderId: String(base), orderRef: deriveParentOrderRef(clientOrderId) },
          { role: "TP", roleOrdinal: 1, brokerOrderId: String(base + 1), orderRef: deriveChildOrderRef(clientOrderId, { role: "TP", ordinal: 1 }) },
          { role: "SL", roleOrdinal: 1, brokerOrderId: String(base + 2), orderRef: deriveChildOrderRef(clientOrderId, { role: "SL", ordinal: 1 }) } ] };
    },
    dispatcher: { dispatch: async ({ prepared }) => {
      state.dispatches++;
      if (state.uncertain) throw new Error("simulated broker timeout after possible acceptance");
      return { brokerOrderId: prepared.legs[0].brokerOrderId, status: "SUBMITTED" };
    } },
    assertKillSwitchOk: async () => undefined, recordAlert: () => undefined, triggerReconciliation: () => undefined,
    ownerId: sessionId, allowMarketOrder: false, allowCrossContractExposure: false, defaultTif: "DAY",
  });
  const submit = (value = ticket(), clientOrderId = "proposal-1") => service.submitTicket({ ticket: value,
    strategy: "test_strategy", clientOrderId, clientOrderHash: computeClientOrderHash(value) });
  const execute = (id: number) => service.executeProposed({ proposedOrderId: id, overrideRejected: true,
    decisionMetadata: { aiReason: "spoofed metadata", aiModel: "spoofed", aiDecision: "EXECUTE" } });
  const create = async () => {
    const result = await submit(); assert.equal(result.kind, "awaiting_ai", JSON.stringify(result));
    if (result.kind !== "awaiting_ai") throw new Error("proposal missing");
    return result.order.id!;
  };
  const rewriteReview = async (id: number, overrides: Record<string, unknown>) => {
    const old = (await pool.query("DELETE FROM proposal_ai_reviews WHERE proposed_order_id=$1 RETURNING *", [id])).rows[0];
    await pool.query("INSERT INTO proposal_ai_reviews SELECT * FROM jsonb_populate_record(NULL::proposal_ai_reviews,$1::jsonb)",
      [JSON.stringify({ ...old, ...overrides })]);
  };
  const approve = async (id: number) => pool.query(`UPDATE proposal_ai_reviews SET status='APPROVED', decision_json=$2,
    decided_at=clock_timestamp(), delivery_started_at=clock_timestamp() WHERE proposed_order_id=$1`, [id, JSON.stringify(decision)]);
  return { pool, repo, service, state, submit, execute, create, rewriteReview, approve,
    close: async () => { await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); } };
}

describe("mandatory AI gate through production submission service + PostgreSQL", { skip: !connection }, () => {
  it("durable pending and approved ticket replay never prepares; approved execution dispatches once with authoritative evidence", async () => {
    const f = await fixture();
    try {
      const id = await f.create();
      assert.equal((await f.submit()).kind, "awaiting_ai");
      const row = (await f.pool.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id])).rows[0];
      assert.equal(row.account_id, accountId); assert.equal(row.session_id, sessionId); assert.equal(row.status, "PENDING");
      await f.approve(id);
      assert.equal((await f.submit()).kind, "awaiting_ai");
      assert.equal(f.state.prepares, 0); assert.equal(f.state.dispatches, 0);
      const outcomes = await Promise.all([f.execute(id), f.execute(id)]);
      assert.equal(outcomes.filter((o) => o.kind === "resumed" || o.kind === "submitted").length, 1, JSON.stringify(outcomes));
      assert.equal(f.state.dispatches, 1);
      await f.execute(id); assert.equal(f.state.dispatches, 1);
      assert.equal(await f.repo.rejectPendingProposal(id, "late reject"), false);
      const stored = await f.repo.getProposedOrderById(id);
      assert.equal(stored?.status, "SUBMITTED"); assert.equal(stored?.aiReason, decision.reason); assert.equal(stored?.aiModel, decision.model);
      assert.equal((await f.pool.query("SELECT count(*) FROM broker_order_links WHERE proposed_order_id=$1", [id])).rows[0].count, "3");
      const evidence = (await f.pool.query("SELECT risk_evidence FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id])).rows[0].risk_evidence;
      assert.equal(evidence.accountId, accountId); assert.equal(evidence.notional, 100);
    } finally { await f.close(); }
  });

  it("a delayed risk refusal cannot overwrite evidence committed by a concurrent submission", async () => {
    const f = await fixture();
    const gate = await f.pool.connect();
    let pending: Promise<void> | undefined;
    try {
      const id = await f.create(); await f.approve(id);
      await gate.query("BEGIN");
      await gate.query("SELECT id FROM proposed_orders WHERE id=$1 FOR UPDATE", [id]);
      await gate.query("SELECT proposed_order_id FROM proposal_ai_reviews WHERE proposed_order_id=$1 FOR UPDATE", [id]);
      const pid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = f.repo.recordAiRisk(id, { ok: false, reason: "late_assessment" });
      let blocked = false;
      for (let i=0; i<100; i++) {
        const waiters = await gate.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid]);
        if (waiters.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "risk recorder must overlap the submission transaction");
      await gate.query("UPDATE proposed_orders SET execution_attempted_at=clock_timestamp(),status='SUBMITTED' WHERE id=$1", [id]);
      await gate.query("UPDATE proposal_ai_reviews SET risk_evidence=$2 WHERE proposed_order_id=$1", [id, JSON.stringify({accountId,notional:100})]);
      await gate.query("COMMIT");
      await pending;
      const result = (await f.pool.query("SELECT risk_evidence FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id])).rows[0];
      assert.deepEqual(result.risk_evidence, {accountId,notional:100});
    } finally {
      await gate.query("ROLLBACK"); gate.release();
      await pending; await f.close();
    }
  });

  for (const scenario of ["missing", "pending", "rejected", "expired", "hash", "account", "session", "conid", "nonpass", "close"] as const) {
    it(`dispatch fails closed for ${scenario}`, async () => {
      const f = await fixture();
      try {
        const id = await f.create();
        if (scenario !== "pending") await f.approve(id);
        if (scenario === "missing") await f.pool.query("DELETE FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id]);
        if (scenario === "rejected") await f.rewriteReview(id, { status: "REJECTED", decision_json: { ...decision, decision: "REJECT" } });
        if (scenario === "expired") await f.rewriteReview(id, { expires_at: new Date(Date.now() - 1000).toISOString() });
        if (scenario === "hash") await f.rewriteReview(id, { client_order_hash: "wrong" });
        if (scenario === "account") f.state.account = "OTHER";
        if (scenario === "session") f.state.session = "OTHER";
        if (scenario === "conid") await f.rewriteReview(id, { conid: "999" });
        if (scenario === "nonpass") await f.pool.query("UPDATE proposed_orders SET risk_check_status='REJECT',client_order_hash=$2 WHERE id=$1", [id, computeClientOrderHash(ticket({ riskCheckStatus: "REJECT" }))]);
        if (scenario === "close") {
          const closed = ticket({ positionEffect: "CLOSE_OR_REDUCE" });
          await f.pool.query("UPDATE proposed_orders SET position_effect='CLOSE_OR_REDUCE',client_order_hash=$2 WHERE id=$1", [id, computeClientOrderHash(closed)]);
        }
        const outcome = await f.execute(id);
        assert.ok(["ai_review_required", "risk_rejected"].includes(outcome.kind), JSON.stringify(outcome));
        assert.equal(f.state.prepares, 0); assert.equal(f.state.dispatches, 0);
        assert.equal((await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1", [id])).rows[0].execution_attempted_at, null);
      } finally { await f.close(); }
    });
  }

  it("account reservation blocks a second instrument and invalid input never creates a proposal", async () => {
    const f = await fixture();
    try {
      assert.equal((await f.submit(ticket({ riskCheckStatus: "REJECT" }))).kind, "risk_rejected");
      assert.equal((await f.submit(ticket({ positionEffect: "CLOSE_OR_REDUCE" }))).kind, "ai_review_required");
      assert.equal((await f.pool.query("SELECT count(*) FROM proposed_orders")).rows[0].count, "0");
      await f.create();
      assert.equal((await f.submit(ticket({ instrumentId: "other", instrument: "OTHER", conid: "456" }), "proposal-2")).kind, "active_intent_exists");
      assert.equal((await f.pool.query("SELECT count(*) FROM proposed_orders")).rows[0].count, "1");
    } finally { await f.close(); }
  });

  for (const duringPrepare of [false, true]) it(`fresh risk fences stale data ${duringPrepare ? 'at atomic claim' : 'before prepare'}`, async () => {
    const f = await fixture();
    try {
      const id = await f.create(); await f.approve(id);
      f.state.staleQuote = !duringPrepare; f.state.ageDuringPrepare = duringPrepare;
      const outcome = await f.execute(id);
      assert.ok(["risk_rejected", "submission_identity_mismatch"].includes(outcome.kind), JSON.stringify(outcome));
      assert.equal(f.state.prepares, duringPrepare ? 1 : 0); assert.equal(f.state.dispatches, 0);
      assert.equal((await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1", [id])).rows[0].execution_attempted_at, null);
    } finally { await f.close(); }
  });

  it("prepared price cannot change the approved ticket", async () => {
    const f = await fixture();
    try {
      const id = await f.create(); await f.approve(id); f.state.alteredPreparedPrice = true;
      const outcome = await f.execute(id);
      assert.equal(outcome.kind, "risk_rejected", JSON.stringify(outcome));
      if (outcome.kind === "risk_rejected") assert.equal(outcome.reason, "prepared_ticket_differs_from_ai_approval");
      assert.equal(f.state.dispatches, 0);
      assert.equal((await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1", [id])).rows[0].execution_attempted_at, null);
    } finally { await f.close(); }
  });

  it("rejection during broker preparation wins before atomic submission", async () => {
    const f = await fixture();
    try {
      const id = await f.create(); await f.approve(id); f.state.rejectDuringPrepare = true;
      const outcome = await f.execute(id);
      assert.equal(outcome.kind, "duplicate_terminal", JSON.stringify(outcome));
      assert.equal(f.state.dispatches, 0);
      assert.equal((await f.pool.query("SELECT execution_attempted_at FROM proposed_orders WHERE id=$1", [id])).rows[0].execution_attempted_at, null);
    } finally { await f.close(); }
  });

  it("concurrent different-instrument creations reserve only one account slot", async () => {
    const f = await fixture();
    try {
      const outcomes = await Promise.all([f.submit(), f.submit(ticket({ instrumentId: "other", instrument: "OTHER", conid: "456" }), "proposal-2")]);
      assert.deepEqual(outcomes.map((o) => o.kind).sort(), ["active_intent_exists", "awaiting_ai"]);
      assert.equal((await f.pool.query("SELECT count(*) FROM proposed_orders")).rows[0].count, "1");
      assert.equal(f.state.dispatches, 0);
    } finally { await f.close(); }
  });

  it("unknown dispatch stays fenced against retry and late rejection", async () => {
    const f = await fixture();
    try {
      const id = await f.create(); await f.approve(id); f.state.uncertain = true;
      assert.equal((await f.execute(id)).kind, "execution_error");
      assert.equal((await f.execute(id)).kind, "duplicate_pending_ambiguous");
      assert.equal((await f.submit()).kind, "duplicate_pending_ambiguous");
      assert.equal(await f.repo.rejectPendingProposal(id, "timeout isn't reject"), false);
      assert.equal(f.state.dispatches, 1);
      const stored = await f.repo.getProposedOrderById(id);
      assert.equal(stored?.status, "PROPOSED"); assert.ok(stored?.executionAttemptedAt);
    } finally { await f.close(); }
  });
});


describe("GPW1 PLN valuation through production submission service (fake broker)", { skip: !connection }, () => {
  it("persists currency-labelled risk only on approved exactly-once dispatch", async () => {
    const f = await fixture("PLN");
    try {
      const id = await f.create();
      await f.execute(id);
      assert.equal(f.state.prepares, 0); assert.equal(f.state.dispatches, 0);
      await f.approve(id);
      await f.execute(id); await f.execute(id);
      assert.equal(f.state.prepares, 1); assert.equal(f.state.dispatches, 1);
      const evidence = (await f.pool.query("SELECT risk_evidence FROM proposal_ai_reviews WHERE proposed_order_id=$1", [id])).rows[0].risk_evidence;
      assert.equal(evidence.accountId, accountId);
      assert.equal(evidence.quoteCurrency, "PLN"); assert.equal(evidence.valuationCurrency, "USD");
      assert.equal(evidence.quoteNotional, 100); assert.equal(evidence.notional, 25.5);
      assert.equal(evidence.quoteStopRisk, 1); assert.equal(evidence.stopRisk, .255);
      assert.equal(evidence.fxSource, "ib_account_exchange_rate");
      assert.equal(evidence.fxToUsd, .25); assert.equal(evidence.fxValuationBuffer, 1.02);
      assert.equal(evidence.quoteCashBalance, 500); assert.equal(evidence.quoteFeeReserve, 30);
      assert.equal(evidence.limits.pln.maxNotional, 500);
    } finally { await f.close(); }
  });
  it("missing currency evidence after AI approval prevents all preparation and dispatch", async () => {
    const f = await fixture("PLN");
    try {
      const id = await f.create(); await f.approve(id); f.state.missingPlnEvidence = true;
      const result = await f.execute(id);
      assert.deepEqual(result, { kind: "risk_rejected", reason: "risk_pln_fx_missing_or_invalid" });
      assert.equal(f.state.prepares, 0); assert.equal(f.state.dispatches, 0);
      assert.equal((await f.repo.getProposedOrderById(id))?.executionAttemptedAt, undefined);
    } finally { await f.close(); }
  });
});
