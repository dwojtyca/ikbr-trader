import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { TwsExecutionClient, type BrokerCommissionReport } from "./tws-execution-client.js";
import { IbBrokerReconciliationAdapter } from "./reconciliation/ib-broker-adapter.js";
import type { BrokerReconciliationSnapshot } from "./reconciliation/broker-adapter.js";
import { buildPaperDailyLoss } from "./paper-daily-loss.js";

class CoverageSocket extends EventEmitter {
  filter?: Record<string, unknown>;
  execution = false;
  connect() { queueMicrotask(() => this.emit("nextValidId", 1)); }
  disconnect() { this.emit("disconnected"); }
  reqManagedAccts() { this.emit("managedAccounts", "PAPER"); }
  reqPositions() { this.emit("positionEnd"); }
  cancelPositions() {}
  reqAllOpenOrders() { this.emit("openOrderEnd"); }
  reqExecutions(id: number, filter: Record<string, unknown>) {
    this.filter = filter;
    if (this.execution) this.emit("execDetails", id,
      { conId: 123, symbol: "TEST", secType: "STK", currency: "USD", exchange: "SMART" },
      { execId: "fill-1", orderId: 1, acctNumber: "PAPER", side: "SLD", shares: 1, price: 100,
        time: "20260715 10:00:00 UTC" });
    this.emit("execDetailsEnd", id);
  }
}

async function fixture() {
  const socket = new CoverageSocket(), commissions: BrokerCommissionReport[] = [];
  const client = new TwsExecutionClient({ host: "unused", port: 0, clientId: 1,
    securityType: "STK", exchange: "SMART", currency: "USD", orderTimeoutMs: 100,
    executionTimeZone: "UTC" }, () => {}, undefined, undefined, report => commissions.push(report), { ib: socket });
  await client.connect();
  const adapter = new IbBrokerReconciliationAdapter(client, { load: async () => ({ ok: true, rows: [] }) });
  const request = { accountId: "PAPER", sessionId: "session", sessionStartedAt: new Date(),
    safetyMarginMs: 0, sourceTimeoutMs: 100, abortSignal: new AbortController().signal };
  return { socket, client, adapter, request, commissions };
}

function dailyLoss(snapshot: BrokerReconciliationSnapshot, generation: number, fills: unknown[] = []) {
  return buildPaperDailyLoss({ run: { id: 1, account_id: "PAPER", session_id: "session", status: "CLEAN",
    snapshot_complete: true, completed_at: new Date(), broker_snapshot: snapshot,
    source_coverage: snapshot.sourceCoverage, position_generation: 1 },
    sync: { account_id: "PAPER", session_id: "session", complete: true, generation: 1 }, fills },
  { accountId: "PAPER", sessionId: "session", connectionGeneration: generation, nowMs: Date.now(), lastBrokerFillObservedAt: 0 });
}

for (const [now, from, wire] of [
  ["2026-01-15T12:00:00Z", "2026-01-14T23:00:00.000Z", "20260114-23:00:00"],
  ["2026-07-15T12:00:00Z", "2026-07-14T22:00:00.000Z", "20260714-22:00:00"],
  ["2026-03-29T12:00:00Z", "2026-03-28T23:00:00.000Z", "20260328-23:00:00"],
  ["2026-03-30T12:00:00Z", "2026-03-29T22:00:00.000Z", "20260329-22:00:00"],
  ["2026-10-25T12:00:00Z", "2026-10-24T22:00:00.000Z", "20261024-22:00:00"],
  ["2026-10-26T12:00:00Z", "2026-10-25T23:00:00.000Z", "20261025-23:00:00"],
  ["2026-07-15T22:30:00Z", "2026-07-15T22:00:00.000Z", "20260715-22:00:00"],
] as const) {
  test(`production collector requests Warsaw midnight without certifying an empty day: ${now}`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
    const f = await fixture(), snapshot = await f.adapter.capture(f.request);
    assert.equal(f.socket.filter?.time, wire);
    assert.equal(f.socket.filter?.acctCode, "PAPER");
    assert.equal(f.socket.filter?.clientId, 0);
    assert.equal(snapshot.sourceCoverage.executions.window.from, from);
    assert.equal(snapshot.sourceCoverage.executions.window.to, new Date(now).toISOString());
    assert.equal(snapshot.exposureComplete, true);
    assert.equal(snapshot.recoveryComplete, true);
    assert.deepEqual(snapshot.executions, []);
    assert.equal(Object.hasOwn(snapshot.sourceCoverage.executions.window, "certifiedFrom"), false);
    assert.deepEqual(dailyLoss(snapshot, f.client.getConnectionGeneration()),
      { ok: false, reason: "paper_daily_loss_coverage_unavailable" });
  });
}

for (const boundary of ["session", "ambiguous"] as const) {
  test(`Warsaw request floor preserves an older ${boundary} recovery boundary and margin`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-15T12:00:00Z") });
    const f = await fixture(), older = new Date("2026-07-12T08:00:00Z");
    const snapshot = await f.adapter.capture({ ...f.request, safetyMarginMs: 30_000,
      ...(boundary === "session" ? { sessionStartedAt: older } : { oldestAmbiguousAttemptedAt: older }) });
    assert.equal(f.socket.filter?.time, "20260712-07:59:30");
    assert.equal(snapshot.sourceCoverage.executions.window.from, "2026-07-12T07:59:30.000Z");
    assert.equal(Object.hasOwn(snapshot.sourceCoverage.executions.window, "certifiedFrom"), false);
    if (boundary === "ambiguous") {
      assert.equal(snapshot.recoveryComplete, false);
      assert.equal(snapshot.sourceCoverage.completedOrders.reason, "completed_historical_window_unproven");
    }
  });
}

test("execution end and a later complete fee callback cannot certify production account-day coverage", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-15T12:00:00Z") });
  const f = await fixture(); f.socket.execution = true;
  const snapshot = await f.adapter.capture(f.request);
  assert.equal(snapshot.executions.length, 1);
  assert.deepEqual(f.commissions, []);
  assert.deepEqual(dailyLoss(snapshot, f.client.getConnectionGeneration()),
    { ok: false, reason: "paper_daily_loss_coverage_unavailable" });
  t.mock.timers.tick(1);
  f.socket.emit("commissionReport", { execId: "fill-1", commission: 1, currency: "USD", realizedPNL: -2 });
  assert.equal(f.commissions.length, 1);
  const execution = snapshot.executions[0]!;
  const fills = [{ exec_id: execution.execId, account_id: execution.accountId, conid: execution.conId,
    sec_type: execution.secType, broker_order_id: execution.brokerOrderId, side: execution.side,
    shares: execution.shares, price: execution.price, currency: execution.currency, executed_at: execution.executedAt,
    commission_currency: "USD", commission: 1, realized_pnl: -2 }];
  assert.deepEqual(dailyLoss(snapshot, f.client.getConnectionGeneration(), fills),
    { ok: false, reason: "paper_daily_loss_coverage_unavailable" });
  assert.equal(Object.hasOwn(snapshot.sourceCoverage.executions.window, "certifiedFrom"), false);
});

test("reconnect during production collection rejects the capture despite every end callback", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-15T12:00:00Z") });
  const f = await fixture();
  const adapter = new IbBrokerReconciliationAdapter(f.client, { load: async () => {
    f.socket.disconnect(); await f.client.connect(); return { ok: true, rows: [] };
  } });
  const snapshot = await adapter.capture(f.request);
  assert.equal(f.client.isConnected(), true);
  assert.notEqual(snapshot.connectionGeneration, f.client.getConnectionGeneration());
  assert.equal(snapshot.exposureComplete, false);
  assert.equal(snapshot.recoveryComplete, false);
  assert.equal(snapshot.sourceCoverage.session.reason, "execution_session_changed_during_capture");
  assert.equal(Object.hasOwn(snapshot.sourceCoverage.executions.window, "certifiedFrom"), false);
  assert.deepEqual(dailyLoss(snapshot, f.client.getConnectionGeneration()),
    { ok: false, reason: "paper_daily_loss_reconciliation_unavailable" });
});
