import { executeTicketBodySchema } from "../execute-ticket-schema.js";
import type { AaplWindow } from "../aapl-window.js";
import { wseMetadataFixture } from "../wse-market-rules.fixture.js";
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

async function fixture(currency: "USD" | "PLN" = "USD", pko = true) {
  const exchange = currency === "PLN" ? "WSE" : "SMART";
  const database = `ikbr_aapl_service_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString() });
  await runMigrations(pool);
  // Window policy parsing is unit-tested against New York wall time. The PG fake
  // broker fixture uses a short interval around database wall time, independently
  // of the host hour, just as its market-risk adapter uses a fixed open session.
  const window: AaplWindow = { runId: "test-run", accountId, startsAt: new Date(Date.now()-1000).toISOString(),
    endsAt: new Date(Date.now()+60000).toISOString(), tradeDate: "2026-09-24" };
  const repo = new ExecutionRepository(pool, undefined, window);
  await pool.query(`INSERT INTO broker_snapshot_syncs (account_id,session_id,generation,observed_at,complete)
    VALUES ($1,$2,1,clock_timestamp(),true)`, [accountId, sessionId]);
  const selectedInstrument = { ...instrument(pko ? "aapl_nasdaq" : "test", pko ? "AAPL" : "TEST"), currency, exchange };
  const makeTicket = (overrides: Partial<SignalTicket> = {}) => ticket({ ...(pko ? {instrumentId:"aapl_nasdaq",instrument:"AAPL",conid:"265598"} : {}), ...overrides });
  const authority = new InstrumentBindingAuthority(new InstrumentRegistry([selectedInstrument, instrument("other", "OTHER")]), [
    { instrumentId: selectedInstrument.id, conId: pko ? 265598 : 123, localSymbol: selectedInstrument.brokerSymbol,
      tradingClass: selectedInstrument.brokerSymbol, exchange, currency, minTick: 0.01 },
    { instrumentId: "other", conId: 456, localSymbol: "OTHER", tradingClass: "OTHER", exchange: "SMART", currency: "USD", minTick: 0.01 },
  ]);
  const state = { prepares: 0, dispatches: 0, uncertain: false, staleQuote: false, ageDuringPrepare: false,
    alteredPreparedPrice: false, rejectDuringPrepare: false, missingPlnEvidence: false, expireWindowDuringPrepare: false,
    wseFailure: "" as string,
    session: sessionId, account: accountId };
  const service = buildSubmissionApplicationService({ repo, bindingAuthority: authority,
    ensureBrokerSession: async () => ({ accountId: state.account }),
    buildPositionGuard: () => ({ kind: "available", accountId: state.account, sessionId: state.session, maxSnapshotAgeMs: 60000 }),
    reconciliationGate: () => async () => null,
    assessAiRisk: async (order, bound, account, session) => {
      const wallNow = Date.now();
      // The fake risk adapter evaluates the real assessor in a deterministic open
      // New York session, then maps its expiry duration onto the DB clock domain.
      const now = currency === "PLN" ? Date.parse("2026-09-24T10:00:00Z") : wallNow;
      const metadata = currency === "PLN" ? wseMetadataFixture(bound, account, now) : undefined;
      if (metadata && state.wseFailure === "closed") metadata.liquidHours = "20260924:CLOSED";
      if (metadata && state.wseFailure === "stale") metadata.requestStartedAtMs -= 60000;
      if (metadata && state.wseFailure === "band") metadata.priceIncrements = [{ lowEdge: 0, increment: 3 }];
      const quoteTime = new Date(now - (state.staleQuote ? 11000 : state.ageDuringPrepare ? 9900 : 1)).toISOString();
      const snapshot: AccountSnapshot = { accountId: account, retrievedAt: new Date(now).toISOString(), metrics: {}, positions: [],
        totals: { positionsCount: 0, longExposure: 0, shortExposure: 0, grossExposure: 0, netExposure: 0, unrealizedPnL: 0, realizedPnL: 0 },
        riskEvidence: { requestStartedAt: new Date(now - 1).toISOString(), completedAt: new Date(now).toISOString(),
          complete: true, configuredBaseCurrency: "USD",
          exchangeRatesToBase: state.missingPlnEvidence ? {} : { USD: 1, PLN: .25 }, cashByCurrency: { PLN: 500, USD: 5000 }, usdMetrics: { netLiquidation: 10000, availableFunds: 5000, grossPositionValue: 0 } } };
      const assessed = assessAiEntryRisk({ order, bound, wseMetadata: metadata, accountId: account, sessionId: session, nowMs: now, snapshot,
        limits: { maxNotionalPct: 10, maxStopRiskPct: 0.5, maxExposurePct: 25,
          aaplUsd: { maxNotional: 500, maxStopRisk: 5, feeReserve: 5 },
          pln: { maxNotional: 500, maxStopRisk: 5, feeReserve: 30 } },
        watchlist: { connected: true, watchlist: [{ instrumentId: order.instrumentId, conid: order.conid, subscribed: true,
          marketState: { conid: order.conid, bid: 99.5, ask: 100, marketDataType: 1, bidObservedAt: quoteTime, askObservedAt: quoteTime } }] } });
      if (assessed.ok) assessed.evidence.validUntilMs += wallNow - now;
      return assessed;
    },
    prepareBrokerPlan: async ({ order, clientOrderId }) => {
      state.prepares++;
      if (state.expireWindowDuringPrepare) await pool.query("SELECT pg_sleep(2.2)");
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
  const submit = (value = makeTicket(), clientOrderId = "proposal-1") => service.submitTicket({ ticket: value,
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
  return { pool, repo, service, state, submit, execute, create, rewriteReview, approve, window, makeTicket,
    close: async () => {
      const disconnected = new Promise<void>(resolve => {
        let remaining = pool.totalCount;
        if (!remaining) return resolve();
        pool.on("remove", () => { if (--remaining === 0) resolve(); });
      });
      await pool.end(); await disconnected;
      try { await admin.query(`DROP DATABASE ${database}`); } finally { await admin.end(); }
    } };
}

describe("AAPL durable single-entry window through production service", {skip: !connection}, () => {
  it("alias identities and absent window refuse before any proposal; pending AI cannot dispatch", async () => {
    const f = await fixture();
    try {
      const guard = { kind: "available" as const, accountId, sessionId, maxSnapshotAgeMs: 60000 };
      for (const patch of [{instrumentId: undefined}, {instrumentId:"other"}, {instrument:"OTHER"}, {conid:"123"}, {conid:undefined}]) {
        const result = await f.repo.insertProposedFromTicket(f.makeTicket(patch), "test_strategy", undefined, guard);
        assert.deepEqual(result, {kind:"invalid_ticket_shape", reason:"aapl_window_identity_mismatch"});
      }
      const unconfigured = new ExecutionRepository(f.pool);
      assert.deepEqual(await unconfigured.insertProposedFromTicket(f.makeTicket(), "test_strategy", undefined, guard),
        {kind:"invalid_ticket_shape", reason:"aapl_window_unconfigured"});
      assert.equal((await f.pool.query("SELECT count(*) FROM proposed_orders")).rows[0].count, "0");
      const id = await f.create();
      assert.equal((await f.execute(id)).kind, "ai_review_required");
      assert.equal(f.state.prepares, 0); assert.equal(f.state.dispatches, 0);
      assert.equal((await f.pool.query("SELECT consumed_proposal_id FROM aapl_windows")).rows[0].consumed_proposal_id, null);
    } finally { await f.close(); }
  });

  it("wire schema preserves strategy evidence and it is durable before AI claim",async()=>{
    const f=await fixture();
    try {
      const indicators={ema20:99,strategyPriceEvidence:{raw:{entry:100.009,stop:99.001,takeProfit:102.001},final:{entry:100,stop:99,takeProfit:102.01}}};
      const parsed=executeTicketBodySchema.parse({ticket:{...f.makeTicket(),indicators}});
      const result=await f.submit(parsed.ticket);assert.equal(result.kind,"awaiting_ai");
      if(result.kind!=="awaiting_ai")throw new Error("missing proposal");
      const row=(await f.pool.query("SELECT indicator_snapshot FROM proposed_orders WHERE id=$1",[result.order.id])).rows[0];
      assert.deepEqual(row.indicator_snapshot,indicators);
      assert.deepEqual((await f.repo.getProposedOrderById(result.order.id!))!.indicators,indicators);
    }finally{await f.close();}
  });

  it("concurrent approval executes once; restart and terminal flat cannot replenish budget", async () => {
    const f=await fixture();
    try {
      const id=await f.create();await f.approve(id);
      const out=await Promise.all([f.execute(id),f.execute(id)]);
      assert.equal(out.filter(x=>x.kind==="resumed").length,1,JSON.stringify(out));
      assert.equal(f.state.dispatches,1);
      const spent=(await f.pool.query("SELECT * FROM aapl_windows")).rows[0];
      assert.equal(Number(spent.consumed_proposal_id),id);
      const restarted=new ExecutionRepository(f.pool,undefined,f.window);
      assert.equal((await restarted.getAaplWindowStatus(accountId)).ok,false);
      await f.pool.query("UPDATE proposed_orders SET status='CANCELLED' WHERE id=$1",[id]);
      const retry=await f.submit(f.makeTicket(),"second-entry");
      assert.equal(retry.kind,"execution_error");assert.equal(f.state.dispatches,1);
      f.window.runId="another-run";
      assert.equal((await restarted.getAaplWindowStatus(accountId)).ok,false);
    } finally {await f.close();}
  });
  it("unknown dispatch retains consumed budget and never retries",async()=>{
    const f=await fixture();
    try {const id=await f.create();await f.approve(id);f.state.uncertain=true;
      assert.equal((await f.execute(id)).kind,"execution_error");
      await f.execute(id);assert.equal(f.state.dispatches,1);
      assert.equal((await f.repo.getAaplWindowStatus(accountId)).ok,false);
    } finally {await f.close();}
  });
  it("old pending run and altered same-run configuration refuse before prepare",async()=>{
    const f=await fixture();
    try {const id=await f.create();await f.approve(id);
      f.window.runId="new-run";assert.equal((await f.execute(id)).kind,"risk_rejected");
      f.window.runId="test-run";f.window.endsAt=new Date(Date.now()+50000).toISOString();
      assert.equal((await f.execute(id)).kind,"risk_rejected");assert.equal(f.state.prepares,0);
    } finally {await f.close();}
  });
  it("pre-commit plan failure rolls back budget and claim",async()=>{
    const f=await fixture();
    try {const id=await f.create();await f.approve(id);
      await f.pool.query(`CREATE FUNCTION fail_aapl_leg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_plan_failure'; END $$`);
      await f.pool.query(`CREATE TRIGGER fail_aapl_leg BEFORE INSERT ON broker_order_links FOR EACH ROW EXECUTE FUNCTION fail_aapl_leg()`);
      await assert.rejects(()=>f.execute(id),/fixture_plan_failure/);
      assert.equal((await f.pool.query("SELECT consumed_proposal_id FROM aapl_windows")).rows[0].consumed_proposal_id,null);
      assert.equal((await f.repo.getProposedOrderById(id))!.executionAttemptedAt,undefined);
      assert.equal(f.state.dispatches,0);
    } finally {await f.close();}
  });
  it("real database time crossing window end during prepare refuses atomic claim",async()=>{
    const f=await fixture();
    try {const id=await f.create();await f.approve(id);
      f.window.endsAt=new Date(Date.now()+2000).toISOString();
      await f.pool.query("UPDATE aapl_windows SET ends_at=$1",[f.window.endsAt]);
      f.state.expireWindowDuringPrepare=true;
      const out=await f.execute(id);
      assert.equal(out.kind,"submission_identity_mismatch",JSON.stringify(out));
      assert.equal(f.state.prepares,1);assert.equal(f.state.dispatches,0);
      assert.equal((await f.pool.query("SELECT consumed_proposal_id FROM aapl_windows")).rows[0].consumed_proposal_id,null);
      assert.equal((await f.repo.getProposedOrderById(id))!.executionAttemptedAt,undefined);
      assert.equal((await f.pool.query("SELECT count(*) FROM broker_order_links WHERE proposed_order_id=$1",[id])).rows[0].count,"0");
    }finally{await f.close();}
  });
  it("expiry after commit before dispatch sends nothing and keeps budget consumed",async()=>{
    const f=await fixture();
    try {const id=await f.create();await f.approve(id);
      const claim=f.repo.tryStartSubmissionWithPlan.bind(f.repo);
      f.repo.tryStartSubmissionWithPlan=async input=>{const result=await claim(input);
        if(result.kind==="claimed_with_persisted_plan") f.window.endsAt=new Date(Date.now()-1).toISOString();
        return result;};
      const out=await f.execute(id);assert.equal(out.kind,"risk_rejected",JSON.stringify(out));
      assert.equal(f.state.dispatches,0);
      assert.equal(Number((await f.pool.query("SELECT consumed_proposal_id FROM aapl_windows")).rows[0].consumed_proposal_id),id);
      assert.ok((await f.repo.getProposedOrderById(id))!.executionAttemptedAt);
    } finally {await f.close();}
  });
});
