import { wseMetadataFixture } from "../wse-market-rules.fixture.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  InstrumentBindingAuthority,
  InstrumentRegistry,
  type Instrument,
  type SignalTicket,
} from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { findAccountReservation } from "../ai-proposal-review.js";
import { ExecutionRepository } from "../repository.js";
import { runMigrations } from "../migrations.js";
import { ReconciliationRunner } from "../reconciliation/runner.js";
import { ReconciliationRepository } from "../reconciliation/repository.js";
import type { BrokerReconciliationSnapshot } from "../reconciliation/broker-adapter.js";
import { deriveParentOrderRef } from "../reconciliation/order-ref.js";
import { CloseRepository } from "./close-repository.js";
import { FullCloseService } from "./close-service.js";
import { evaluateCloseEvidence } from "./close-evidence.js";
import {
  assessCloseRisk,
  validatePersistedClosePrepared,
} from "./close-risk.js";
import type { CloseContext } from "./close-types.js";
const connection = process.env.TEST_POSTGRES_URL;
const accountId = "DU-CLOSE",
  sessionId = "close-session";
const instrument: Instrument = {
  id: "test",
  displayName: "Test",
  broker: "ibkr",
  brokerSymbol: "TEST",
  exchange: "SMART",
  assetClass: "stock",
  currency: "USD",
  metadata: { tags: [] },
  session: {
    useRegularTradingHours: true,
    timezone: "America/New_York",
    sessionTemplate: "us_stock_rth",
  },
  trading: {
    executionEnabled: true,
    signalGenerationEnabled: true,
    aiAnalysisEnabled: true,
    monitoringEnabled: true,
  },
  risk: {
    maxLeverage: 1,
    allowOvernight: false,
    quantityUnit: "shares",
    maxQuantity: 1,
    maxSpread: 1,
    maxSlippage: 1,
  },
  executionPolicy: {
    strategyId: "test",
    expectedDirection: "LONG",
    timeframe: "1m",
    quantity: 1,
    maxQuantity: 1,
    quantityUnit: "shares",
    allowedOrderTypes: ["LMT"],
    defaultOrderType: "LMT",
    timeInForce: "DAY",
    outsideRth: false,
    transmit: true,
    priceTickSize: 0.01,
    priceRoundingMode: "nearest",
  },
};
async function createFixture(currency: "USD" | "PLN") {
  const exchange = currency === "PLN" ? "WSE" : "SMART";
  const selectedInstrument: Instrument = { ...instrument, currency, exchange,
    session: currency === "PLN" ? { useRegularTradingHours: true, timezone: "Europe/Warsaw", sessionTemplate: "wse_stock_rth" } : instrument.session };
  const database = `close_${randomUUID().replaceAll("-", "")}`,
    url = new URL(connection!);
  url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString() });
  await runMigrations(pool);
  const execution = new ExecutionRepository(pool),
    repo = new CloseRepository(pool, execution),
    reconciliation = new ReconciliationRepository(pool);
  const authority = new InstrumentBindingAuthority(
    new InstrumentRegistry([selectedInstrument]),
    [
      {
        instrumentId: "test",
        conId: 123,
        localSymbol: "TEST",
        tradingClass: "TEST",
        exchange,
        currency,
        minTick: 0.01,
      },
    ],
  );
  const bound = authority.getBoundInstrument("test")!;
  const attempt = new Date(Date.now() - 3000),
    ticket: SignalTicket = {
      instrument: "TEST",
      instrumentId: "test",
      conid: "123",
      side: "BUY",
      orderType: "LMT",
      quantity: 1,
      entry: 100,
      stop: 99,
      takeProfit: 102,
      reason: "fixture",
      confidence: 1,
      riskCheckStatus: "PASS",
      timestamp: attempt.toISOString(),
    };
  const inserted = await pool.query(
    `INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,status,strategy,execution_account_id,execution_attempted_at,client_order_hash,client_order_id) VALUES('TEST','test','123','BUY','LMT',1,100,99,102,'fixture',1,'PASS','FILLED','test',$1,$2,$3,'entry') RETURNING id`,
    [accountId, attempt, computeClientOrderHash(ticket)],
  );
  const id = Number(inserted.rows[0].id);
  await pool.query(
    `INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,status,expires_at,decision_json,decided_at,delivery_started_at) VALUES($1,$2,'test','123',$3,$4,'APPROVED',$5,$6,$7,$7)`,
    [
      id,
      computeClientOrderHash(ticket),
      accountId,
      sessionId,
      new Date(attempt.getTime() + 120000),
      JSON.stringify({
        decision: "EXECUTE",
        reason: "approved",
        confidence: 1,
        model: "test",
        promptVersion: "1",
      }),
      new Date(attempt.getTime() - 100),
    ],
  );
  for (const [index, role] of ["PARENT", "TP", "SL"].entries())
    await pool.query(
      `INSERT INTO broker_order_links(proposed_order_id,account_id,role,role_ordinal,broker_order_id,perm_id,order_ref) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        accountId,
        role,
        index === 0 ? 0 : 1,
        String(101 + index),
        String(1001 + index),
        `entry-${role}`,
      ],
    );
  for (const role of ["PARENT", "TP", "SL"])
    await pool.query(
      "INSERT INTO broker_order_ref_map(broker_order_ref,client_order_id,proposed_order_id,role) VALUES($1,'entry',$2,$3)",
      [`entry-${role}`, id, role],
    );
  const state = {
    wseFailure: "" as string,
    generation: 1,
    working: ["TP", "SL"],
    position: 1,
    originalFilled: true,
    exitFilled: false,
    closeFilled: false,
    closeWorking: false,
    closeRef: "",
    closeId: "201",
    prepares: 0,
    dispatches: 0,
    cancels: [] as string[],
    alerts: [] as string[],
    failCancel: false,
    unknownDispatch: false,
    alterPrice: false,
    disconnectAfterPrepare: false,
    claimTamper: false,
    invalidRiskIdentity: false,
    expiredRisk: false,
    tpFillDuringCancel: false,
    fractionalFill: false,
    useRunner: false,
    extraPreparedLeg: false,
    wrongPreparedId: false,
    invalidateBeforeClaim: false,
    newerFlatBeforeClaim: false,
  };
  const context = (): CloseContext => ({
    accountId,
    sessionId,
    clientId: 7,
    generation: state.generation,
    nowMs: Date.now(),
    bound,
  });
  const refresh = async () => {
    const observedAt = (await pool.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    )).rows[0].now;
    const { generation } = await execution.beginPositionSnapshotRefresh({
      accountId,
      sessionId,
      observedAt,
    });
    await execution.completePositionSnapshotRefresh({
      accountId,
      sessionId,
      generation,
      observedAt,
      positions: state.position
        ? [{ instrument: "TEST", conid: "123", quantity: state.position }]
        : [],
    });
    const db = await pool.connect();
    try {
      const { runId } = await reconciliation.publishRunning(db, {
        accountId,
        sessionId,
        runTimeoutMs: 1000,
      });
      const capture = (
        await db.query<{
          now: Date;
        }>("SELECT clock_timestamp() AS now")
      ).rows[0].now;
      const orders = state.working.map((role) => ({
        accountId,
        conId: "123",
        brokerOrderId: String(101 + ["PARENT", "TP", "SL"].indexOf(role)),
        permId: String(1001 + ["PARENT", "TP", "SL"].indexOf(role)),
        orderRef: `entry-${role}`,
        clientId: 7,
        status: "Submitted",
        remaining: 1,
        filled: 0,
        action: role === "PARENT" ? "BUY" : "SELL",
        observedAt: capture,
      }));
      if (state.closeWorking)
        orders.push({
          accountId,
          conId: "123",
          brokerOrderId: state.closeId,
          permId: "2001",
          orderRef: state.closeRef,
          clientId: 7,
          status: "Submitted",
          remaining: 1,
          filled: 0,
          action: "SELL",
          observedAt: capture,
        });
      const executions = state.originalFilled
        ? [
            {
              accountId,
              conId: "123",
              brokerOrderId: "101",
              permId: "1001",
              orderRef: "entry-PARENT",
              execId: "entry-fill",
              shares: state.fractionalFill ? 0.5 : 1,
              price: 100,
              side: "BOT",
              executedAt: new Date(attempt.getTime() + 50),
            },
          ]
        : [];
      if (state.exitFilled)
        executions.push({
          accountId,
          conId: "123",
          brokerOrderId: "102",
          permId: "1002",
          orderRef: "entry-TP",
          execId: "tp-fill",
          shares: 1,
          price: 100,
          side: "SLD",
          executedAt: new Date(attempt.getTime() + 100),
        });
      if (state.closeFilled)
        executions.push({
          accountId,
          conId: "123",
          brokerOrderId: state.closeId,
          permId: "2001",
          orderRef: state.closeRef,
          execId: "close-fill",
          shares: 1,
          price: 100,
          side: "SLD",
          executedAt: new Date(capture.getTime() - 1),
        });
      const positions = state.position
        ? [
            {
              accountId,
              conId: "123",
              symbol: "TEST",
              position: state.position,
            },
          ]
        : [];
      const source = (count: number) => ({
        available: true,
        boundedWindow: true,
        timedOut: false,
        count,
      });
      const snapshot: BrokerReconciliationSnapshot = {
        accountId,
        sessionId,
        capturedAt: capture,
        exposureComplete: true,
        recoveryComplete: false,
        positions,
        openOrders: orders,
        executions,
        completedOrders: [],
        sourceCoverage: {
          positions: source(positions.length),
          openOrders: source(orders.length),
          session: source(1),
          completedOrders: { ...source(0), available: false },
          executions: {
            available: true,
            timedOut: false,
            count: executions.length,
            window: {
              from: attempt.toISOString(),
              to: capture.toISOString(),
              exposureWindowComplete: true,
              recoveryWindowComplete: true,
            },
          },
        },
      };
      await reconciliation.publishResult(db, {
        runId,
        accountId,
        finalStatus: "CLEAN",
        snapshot,
        matches: 1,
        mismatchesCount: 0,
        expectedPositionsCount: positions.length,
        brokerPositionsCount: positions.length,
        report: {},
        error: null,
        holdInserts: [],
        holdResolves: [],
      });
      let completedRunId = runId;
      if (state.useRunner) {
        for (const fill of executions)
          await execution.upsertBrokerExecutionFill({
            execId: fill.execId,
            orderId: Number(fill.brokerOrderId),
            accountId,
            conid: "123",
            symbol: "TEST",
            currency,
            side: fill.side === "BOT" ? "BUY" : "SELL",
            shares: fill.shares,
            price: fill.price,
            executedAt: fill.executedAt.toISOString(),
          });
        const runner = new ReconciliationRunner(
          pool,
          execution,
          reconciliation,
          {
            capture: async () => {
              const now = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
              return {
                ...snapshot,
                capturedAt: now,
                openOrders: snapshot.openOrders.map((row) => ({
                  ...row,
                  observedAt: now,
                })),
                sourceCoverage: {
                  ...snapshot.sourceCoverage,
                  executions: {
                    ...snapshot.sourceCoverage.executions,
                    window: {
                      ...snapshot.sourceCoverage.executions.window!,
                      to: now.toISOString(),
                    },
                  },
                },
              };
            },
          },
          { info: () => {}, warn: () => {}, error: () => {} },
        );
        const completedRun = await runner.runOnce(
          { accountId, sessionId, sessionStartedAt: attempt },
          {
            runTimeoutMs: 1000,
            sourceTimeoutMs: 1000,
            executionSafetyMarginMs: 1000,
          },
        );
        assert.ok(completedRun, "fixture reconciliation must produce a run");
        completedRunId = completedRun.runId;
      }
      const completed = (await db.query<{ completed_at: Date }>(
        "SELECT completed_at FROM reconciliation_runs WHERE id=$1", [completedRunId],
      )).rows[0].completed_at.getTime();
      const waitMs = completed - Date.now();
      assert.ok(waitMs <= 100, "fixture DB completion is more than 100ms ahead of the host clock");
      if (waitMs >= 0) await new Promise(resolve => setTimeout(resolve, waitMs + 1));
      assert.ok(completed <= Date.now(), "fixture host clock has not reached the completed run");
    } finally {
      db.release();
    }
  };
  const service = new FullCloseService(repo, {
    context,
    refresh,
    evaluate: evaluateCloseEvidence,
    assessRisk: async (t, b, c) => {
      if (
        state.prepares > 0 &&
        (state.invalidateBeforeClaim || state.newerFlatBeforeClaim)
      ) {
        const { generation } = await execution.invalidatePositionSnapshot({
          accountId,
          sessionId,
          observedAt: new Date(),
        });
        if (state.newerFlatBeforeClaim)
          await execution.completePositionSnapshotRefresh({
            accountId,
            sessionId,
            generation,
            observedAt: new Date(),
            positions: [],
          });
      }
      const wallNow = c.nowMs;
      // Pure market validation uses an open-session fixture clock; only the risk
      // expiry duration crosses into the real DB/service clock in this fake adapter.
      const riskNow = currency === "PLN" ? Date.parse("2026-09-24T10:00:00Z") : wallNow;
      const metadata = currency === "PLN" ? wseMetadataFixture(b, c.accountId, riskNow) : undefined;
      if (metadata && state.wseFailure === "closed") metadata.liquidHours = "20260924:CLOSED";
      if (metadata && state.wseFailure === "stale") metadata.requestStartedAtMs -= 60000;
      if (metadata && state.wseFailure === "band") metadata.priceIncrements = [{ lowEdge: 0, increment: 3 }];
      const risk = assessCloseRisk(t, b, { ...c, nowMs: riskNow }, {
        connected: true,
        watchlist: [
          {
            instrumentId: "test",
            conid: "123",
            subscribed: true,
            marketState: {
              conid: "123",
              marketDataType: 1,
              bid: 100,
              ask: 100.01,
              bidObservedAt: new Date(riskNow - 1).toISOString(),
              askObservedAt: new Date(riskNow - 1).toISOString(),
            },
          },
        ],
      }, metadata);
      if (risk.ok) {
        risk.expiresAt = new Date(Date.parse(risk.expiresAt) + wallNow - riskNow).toISOString();
        (risk.evidence as { expiresAt: string }).expiresAt = risk.expiresAt;
      }
      if (state.invalidRiskIdentity)
        (risk.evidence as { accountId: string }).accountId = "FOREIGN";
      if (state.expiredRisk) risk.expiresAt = new Date(0).toISOString();
      return risk;
    },
    prepare: async (t, clientOrderId) => {
      state.prepares++;
      if (state.disconnectAfterPrepare) state.generation++;
      if (state.claimTamper)
        await pool.query("UPDATE proposed_orders SET quantity=2 WHERE id=$1", [
          id,
        ]);
      const normalizedTicket = {
        ...t,
        ...(state.alterPrice ? { entry: 99 } : {}),
      };
      const leg = {
        role: "PARENT" as const,
        roleOrdinal: 0,
        brokerOrderId: state.closeId,
        orderRef: deriveParentOrderRef(clientOrderId),
      };
      const payload = {
        contract: {
          conId: 123,
          symbol: "TEST",
          secType: "STK",
          currency,
          exchange,
        },
        normalizedTicket,
        legs: [leg],
        plan: {
          parentOrderId: Number(state.closeId),
          relatedOrderIds: new Set([Number(state.closeId)]),
          orders: [
            {
              orderId: Number(state.closeId),
              order: {
                orderRef: leg.orderRef,
                account: accountId,
                action: "SELL",
                totalQuantity: 1,
                orderType: "LMT",
                lmtPrice: t.entry,
                tif: "DAY",
                transmit: true,
              },
            },
          ],
        },
      };
      if (state.extraPreparedLeg)
        payload.plan.orders.push({ ...payload.plan.orders[0], orderId: 999 });
      if (state.wrongPreparedId) payload.plan.orders[0].orderId = 999;
      return {
        normalizedTicket,
        persistence: {
          clientOrderId,
          clientOrderHash: computeClientOrderHash(t),
          instrument: t.instrument,
          instrumentId: t.instrumentId,
          conid: t.conid!,
          legs: [leg],
        },
        payload,
      };
    },
    validatePrepared: (p, t, c) => {
      const error = validatePersistedClosePrepared(p, t, c);
      if (error) throw new Error(error);
    },
    cancel: async (leg, c) => {
      state.cancels.push(leg.role);
      if (state.tpFillDuringCancel && leg.role === "TP") {
        state.working = [];
        state.exitFilled = true;
        state.position = 0;
        throw new Error("filled_during_cancel");
      }
      const saved = await repo.get(id);
      assert.ok(saved?.cancelAttempts.some((v) => v.role === leg.role));
      if (state.failCancel) throw new Error("cancel_timeout");
      state.working = state.working.filter((v) => v !== leg.role);
      return {
        ...leg,
        status: "CANCELLED",
        confirmedAt: new Date().toISOString(),
        generation: c.generation,
        sessionId: c.sessionId,
      };
    },
    dispatch: async (p, op) => {
      assert.equal(p.payload && (p.payload as { contract: { currency: string; exchange: string } }).contract.currency, currency);
      assert.equal((p.payload as { contract: { exchange: string } }).contract.exchange, exchange);
      const riskRow = await pool.query("SELECT risk_evidence FROM lifecycle_close_operations WHERE id=$1", [op.id]);
      assert.equal(riskRow.rows[0].risk_evidence.quoteCurrency, currency);
      if (currency === "PLN") assert.equal(riskRow.rows[0].risk_evidence.wseMetadata.marketRuleId, 1);
      state.dispatches++;
      state.closeRef = p.persistence.legs[0].orderRef;
      state.closeWorking = true;
      const durable = await repo.get(id);
      assert.ok(durable?.submissionAttemptedAt);
      assert.equal(durable?.closeLink?.broker_order_id, state.closeId);
      assert.equal(durable?.closeProposalId, op.closeProposalId);
      if (state.unknownDispatch) throw new Error("lost_ack");
    },
    alert: async (_op, reason) => {
      state.alerts.push(reason);
    },
  });
  return {
    pool,
    execution,
    repo,
    service,
    state,
    id,
    ticket,
    context,
    refresh,
    close: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    },
  };
}
for (const currency of ["USD", "PLN"] as const) describe(
  `durable full close production service + PostgreSQL (${currency})`,
  { skip: !connection },
  () => {
    const fixture = () => createFixture(currency);
    if (currency === "PLN") for (const failure of ["closed", "stale", "band"]) it(`WSE preflight ${failure} preserves protective orders`, async () => {
      const f = await fixture();
      try {
        f.state.wseFailure = failure;
        const op = await f.service.request(f.id, randomUUID(), 100, "test");
        assert.equal(op.state, "BLOCKED");
        assert.match(op.failureReason ?? "", /wse_/);
        assert.deepEqual(f.state.cancels, []);
        assert.equal(f.state.prepares, 0);
        assert.equal(f.state.dispatches, 0);
      } finally { await f.close(); }
    });
    it("persists cancellations then exact plan before one dispatch; replay is read-only; full fill completes", async () => {
      const f = await fixture();
      try {
        const key = randomUUID();
        const op = await f.service.request(f.id, key, 100, "test");
        assert.equal(op.state, "SUBMITTED", op.failureReason ?? "");
        assert.deepEqual(f.state.cancels, ["TP", "SL"]);
        assert.equal(f.state.dispatches, 1);
        await f.service.request(f.id, key, 100, "test");
        assert.equal(f.state.prepares, 1);
        assert.equal(f.state.dispatches, 1);
        await assert.rejects(
          f.service.request(f.id, key, 99, "test"),
          /conflict/,
        );
        f.state.closeWorking = false;
        f.state.closeFilled = true;
        f.state.position = 0;
        assert.equal((await f.service.reconcile(f.id)).state, "COMPLETED");
        const db = await f.pool.connect();
        try {
          assert.equal(await findAccountReservation(db, accountId), undefined);
        } finally {
          db.release();
        }
        assert.equal(
          (
            await f.pool.query(
              "SELECT status FROM proposed_orders WHERE id=$1",
              [op.closeProposalId],
            )
          ).rows[0].status,
          "FILLED",
        );
      } finally {
        await f.close();
      }
    });
    it("production reconciliation runner permits original FILLED -> close SUBMITTED -> flat without spurious holds", async () => {
      const f = await fixture();
      try {
        f.state.useRunner = true;
        const op = await f.service
          .request(f.id, randomUUID(), 100, "test")
          .catch(async (error) => {
            throw new Error(
              error.message +
                JSON.stringify(
                  (await f.pool.query("SELECT * FROM reconciliation_holds"))
                    .rows,
                ),
            );
          });
        assert.equal(op.state, "SUBMITTED", op.failureReason ?? "");
        f.state.closeWorking = false;
        f.state.closeFilled = true;
        f.state.position = 0;
        const done = await f.service.reconcile(f.id);
        assert.equal(done.state, "COMPLETED", JSON.stringify(done.observation));
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*) FROM reconciliation_holds WHERE active",
            )
          ).rows[0].count,
          "0",
        );
      } finally {
        await f.close();
      }
    });
    it("parallel same-key requests dispatch once", async () => {
      const f = await fixture();
      try {
        const key = randomUUID();
        const originalGet = f.repo.get.bind(f.repo);
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const firstLookup = new Promise<void>(resolve => { entered = resolve; });
        let holding = true;
        let initialLookups = 0;
        f.repo.get = async (id) => {
          if (holding) {
            initialLookups++;
            entered();
            await gate;
          }
          return originalGet(id);
        };
        const first = f.service.request(f.id, key, 100, "a");
        await firstLookup;
        const duplicate = f.service.request(f.id, key, 100, "b");
        const pending = Promise.allSettled([first, duplicate]);
        try {
          assert.equal(initialLookups, 1, "duplicate must not start another lookup/refresh");
          await assert.rejects(f.service.request(f.id, randomUUID(), 100, "c"), /close_request_conflict/);
          await assert.rejects(f.service.request(f.id, key, 99, "c"), /close_request_conflict/);
        } finally {
          holding = false;
          release();
          await pending;
        }
        const results = await pending;
        assert.ok(results.every(result => result.status === "fulfilled"), JSON.stringify(results));
        if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
          assert.equal(results[0].value.state, "SUBMITTED", JSON.stringify(results));
          assert.deepEqual(results[0].value, results[1].value);
        }
        assert.deepEqual(f.state.cancels, ["TP", "SL"]);
        assert.equal(f.state.dispatches, 1);
        assert.equal(f.state.prepares, 1);
        f.state.closeWorking = false; f.state.closeFilled = true; f.state.position = 0;
        await f.service.reconcile(f.id);
        assert.equal((await f.service.request(f.id, key, 100, "replay")).state, "COMPLETED");
        assert.equal(f.state.dispatches, 1);
      } finally {
        await f.close();
      }
    });
    it("failed initial refresh releases the in-flight request without persisting a close", async () => {
      const f = await fixture();
      try {
        const refresh = f.service.deps.refresh;
        f.service.deps.refresh = async () => { throw new Error("fixture_initial_refresh_failure"); };
        const key = randomUUID();
        const results = await Promise.allSettled([
          f.service.request(f.id, key, 100, "a"),
          f.service.request(f.id, key, 100, "b"),
        ]);
        assert.ok(results.every(result => result.status === "rejected" &&
          String(result.reason).includes("fixture_initial_refresh_failure")));
        assert.equal(await f.service.get(f.id), null);
        assert.equal(f.state.cancels.length, 0); assert.equal(f.state.dispatches, 0);
        f.service.deps.refresh = refresh;
        const retry = await f.service.request(f.id, key, 100, "retry_before_reservation");
        assert.equal(retry.state, "SUBMITTED", JSON.stringify(retry));
        assert.equal(f.state.dispatches, 1);
      } finally { await f.close(); }
    });
    it("flat original full round trip completes without cancellation or prepare", async () => {
      const f = await fixture();
      try {
        f.state.working = [];
        f.state.exitFilled = true;
        f.state.position = 0;
        assert.equal(
          (await f.service.request(f.id, randomUUID(), 100, "test")).state,
          "COMPLETED",
        );
        assert.equal(f.state.prepares, 0);
        assert.equal(f.state.cancels.length, 0);
      } finally {
        await f.close();
      }
    });
    it("pending parent cancels parent before children and completes without a SELL", async () => {
      const f = await fixture();
      try {
        f.state.originalFilled = false;
        f.state.position = 0;
        f.state.working = ["PARENT", "TP", "SL"];
        const op = await f.service.request(f.id, randomUUID(), 100, "test");
        assert.equal(op.state, "COMPLETED", op.failureReason ?? "");
        assert.deepEqual(f.state.cancels, ["PARENT", "TP", "SL"]);
        assert.equal(f.state.dispatches, 0);
      } finally {
        await f.close();
      }
    });
    it("TP full fill while cancelling completes flat without a new SELL", async () => {
      const f = await fixture();
      try {
        f.state.tpFillDuringCancel = true;
        const op = await f.service.request(f.id, randomUUID(), 100, "test");
        assert.equal(op.state, "COMPLETED", op.failureReason ?? "");
        assert.equal(f.state.dispatches, 0);
        assert.equal(f.state.prepares, 0);
      } finally {
        await f.close();
      }
    });
    it("fractional original entry blocks before removing any protection", async () => {
      const f = await fixture();
      try {
        f.state.fractionalFill = true;
        f.state.position = 0.5;
        await assert.rejects(
          f.service.request(f.id, randomUUID(), 100, "test"),
          /fractional/,
        );
        assert.deepEqual(f.state.cancels, []);
      } finally {
        await f.close();
      }
    });
    it("empty no-fill snapshot cannot release unknown parent", async () => {
      const f = await fixture();
      try {
        f.state.working = [];
        f.state.originalFilled = false;
        f.state.position = 0;
        await assert.rejects(
          f.service.request(f.id, randomUUID(), 100, "test"),
        );
        assert.equal(await f.repo.get(f.id), null);
        assert.equal(f.state.dispatches, 0);
      } finally {
        await f.close();
      }
    });
    for (const flag of [
      "failCancel",
      "alterPrice",
      "disconnectAfterPrepare",
      "claimTamper",
      "invalidRiskIdentity",
      "expiredRisk",
      "extraPreparedLeg",
      "wrongPreparedId",
      "invalidateBeforeClaim",
      "newerFlatBeforeClaim",
    ] as const)
      it(`${flag} leaves reserved operation and no dispatch; replay never writes`, async () => {
        const f = await fixture();
        try {
          f.state[flag] = true;
          const key = randomUUID(),
            op = await f.service.request(f.id, key, 100, "test");
          assert.ok(
            ["BLOCKED", "CANCEL_UNKNOWN"].includes(op.state),
            op.failureReason ?? "",
          );
          assert.equal(f.state.dispatches, 0);
          assert.equal(op.submissionAttemptedAt, null);
          assert.equal(op.closeProposalId, null);
          const before = [f.state.prepares, f.state.cancels.length];
          await f.service.request(f.id, key, 100, "test");
          assert.deepEqual([f.state.prepares, f.state.cancels.length], before);
          assert.equal(f.state.alerts.length, 1);
        } finally {
          await f.close();
        }
      });
    it("unknown dispatch never repeats and absence alone never completes", async () => {
      const f = await fixture();
      try {
        f.state.unknownDispatch = true;
        const key = randomUUID(),
          op = await f.service.request(f.id, key, 100, "test");
        assert.equal(op.state, "SUBMISSION_UNKNOWN");
        await f.service.request(f.id, key, 100, "test");
        f.state.closeWorking = false;
        f.state.position = 0;
        assert.notEqual((await f.service.reconcile(f.id)).state, "COMPLETED");
        assert.equal(f.state.dispatches, 1);
        f.state.closeFilled = true;
        assert.equal((await f.service.reconcile(f.id)).state, "COMPLETED");
      } finally {
        await f.close();
      }
    });
    for (const completeNewer of [false, true])
      it(`newer ${completeNewer ? "complete-flat" : "incomplete"} sync after reconciliation cannot release completion reservation`, async () => {
        const f = await fixture();
        try {
          const op = await f.service.request(f.id, randomUUID(), 100, "test");
          assert.equal(op.state, "SUBMITTED");
          f.state.closeWorking = false;
          f.state.closeFilled = true;
          f.state.position = 0;
          f.service.deps.refresh = async () => {
            await f.refresh();
            const { generation } = await f.execution.invalidatePositionSnapshot(
              { accountId, sessionId, observedAt: new Date() },
            );
            if (completeNewer)
              await f.execution.completePositionSnapshotRefresh({
                accountId,
                sessionId,
                generation,
                observedAt: new Date(),
                positions: [],
              });
          };
          const unresolved = await f.service.reconcile(f.id);
          assert.notEqual(unresolved.state, "COMPLETED");
          const db = await f.pool.connect();
          try {
            assert.ok(await findAccountReservation(db, accountId));
          } finally {
            db.release();
          }
          assert.equal(f.state.dispatches, 1);
          f.service.deps.refresh = f.refresh;
          assert.equal((await f.service.reconcile(f.id)).state, "COMPLETED");
        } finally {
          await f.close();
        }
      });
    it("changed immutable operation instrument cannot release a flat completion reservation", async () => {
      const f = await fixture();
      try {
        await f.service.request(f.id, randomUUID(), 100, "test");
        f.state.closeWorking = false;
        f.state.closeFilled = true;
        f.state.position = 0;
        await f.pool.query(
          "UPDATE lifecycle_close_operations SET instrument_id='tampered' WHERE original_proposal_id=$1",
          [f.id],
        );
        const unresolved = await f.service.reconcile(f.id);
        assert.notEqual(unresolved.state, "COMPLETED");
        assert.match(
          unresolved.failureReason ?? "",
          /operation_identity_changed/,
        );
      } finally {
        await f.close();
      }
    });
    it("later vanished close with residual long becomes unknown and alerts once without repeating writes", async () => {
      const f = await fixture();
      try {
        const key = randomUUID();
        assert.equal(
          (await f.service.request(f.id, key, 100, "test")).state,
          "SUBMITTED",
        );
        f.state.closeWorking = false;
        const observed = await f.service.reconcile(f.id);
        assert.equal(observed.state, "SUBMISSION_UNKNOWN");
        assert.equal(
          observed.failureReason,
          "close_order_missing_with_residual_position",
        );
        assert.deepEqual(f.state.alerts, [
          "close_order_missing_with_residual_position",
        ]);
        await f.service.reconcile(f.id);
        await f.service.request(f.id, key, 100, "test");
        assert.equal(f.state.alerts.length, 1);
        assert.equal(f.state.dispatches, 1);
        assert.equal(f.state.prepares, 1);
      } finally {
        await f.close();
      }
    });
    it("reserved full close fences entry creation and plan claims account-wide even with FILLED original", async () => {
      const f = await fixture();
      try {
        f.state.failCancel = true;
        await f.service.request(f.id, randomUUID(), 100, "test");
        const outcome = await f.execution.insertProposedFromTicket(
          {
            ...f.ticket,
            instrument: "OTHER",
            instrumentId: undefined,
            conid: "456",
          },
          "test",
          undefined,
          { kind: "available", accountId, sessionId, maxSnapshotAgeMs: 60000 },
        );
        assert.equal(outcome.kind, "active_intent_exists");
        const prepared = {
          clientOrderId: "other",
          clientOrderHash: computeClientOrderHash(f.ticket),
          instrument: "OTHER",
          conid: "456",
          legs: [
            {
              role: "PARENT" as const,
              roleOrdinal: 0,
              brokerOrderId: "301",
              orderRef: "other",
            },
          ],
        };
        const claim = await f.execution.tryStartSubmissionWithPlan({
          id: 999,
          owner: "test",
          instrument: "OTHER",
          conid: "456",
          allowCrossContractExposure: false,
          positionGuard: {
            kind: "available",
            accountId,
            sessionId,
            maxSnapshotAgeMs: 60000,
          },
          prepared,
          accountId,
        });
        assert.equal(claim.kind, "submission_identity_mismatch");
      } finally {
        await f.close();
      }
    });
  },
);
