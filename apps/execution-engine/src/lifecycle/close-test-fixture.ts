import type { BoundInstrument, ProposedOrder } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import type { LifecycleEvidence } from "./ownership.js";
export const nowMs = Date.parse("2026-09-23T12:00:00Z");
const iso = (delta = 0) => new Date(nowMs + delta).toISOString();
export function fixture() {
  const bound: BoundInstrument = {
    instrumentId: "test", conId: 123, brokerSymbol: "TEST", currency: "USD", broker: "ibkr",
    localSymbol: "TEST", tradingClass: "TEST", exchange: "SMART", minTick: 0.01,
    instrument: { id: "test", displayName: "Test", broker: "ibkr", brokerSymbol: "TEST", exchange: "SMART",
      session: { useRegularTradingHours: true, timezone: "America/New_York", sessionTemplate: "us_stock_rth" },
      metadata: { tags: [] }, assetClass: "stock", currency: "USD",
      trading: { executionEnabled: true, signalGenerationEnabled: true, aiAnalysisEnabled: true, monitoringEnabled: true },
      risk: { maxLeverage: 1, allowOvernight: false, quantityUnit: "shares", maxQuantity: 1, maxSpread: 1, maxSlippage: 1 },
      executionPolicy: { timeframe: "1m", defaultOrderType: "LMT", timeInForce: "DAY", outsideRth: false, transmit: true,
        priceTickSize: 0.01, priceRoundingMode: "nearest", strategyId: "test_strategy", expectedDirection: "LONG",
        quantityUnit: "shares", quantity: 1, maxQuantity: 1, allowedOrderTypes: ["LMT"] } },
  };
  const order: ProposedOrder = { id: 42, instrument: "TEST", instrumentId: "test", conid: "123", side: "BUY",
    orderType: "LMT", quantity: 1, entry: 100, stop: 99, takeProfit: 102, strategy: "test_strategy", status: "SUBMITTED",
    reason: "test", confidence: 0.8, timestamp: iso(-60_000), riskCheckStatus: "PASS", executionAccountId: "DU_TEST",
    executionAttemptedAt: new Date(iso(-30_000)) };
  const links = ["PARENT", "TP", "SL"].map((role, index) => ({ proposed_order_id: 42, account_id: "DU_TEST", role,
    role_ordinal: role === "PARENT" ? 0 : 1, broker_order_id: String(100 + index), perm_id: String(1000 + index) as string | null, order_ref: `test-${role}` }));
  const coverage = { positions: { available: true, boundedWindow: true, timedOut: false, count: 1 },
    openOrders: { available: true, boundedWindow: true, timedOut: false, count: 2 },
    executions: { available: true, timedOut: false, count: 1, window: { from: iso(-60_000), to: iso(-200), exposureWindowComplete: true, recoveryWindowComplete: false } },
    completedOrders: { available: false, boundedWindow: false, timedOut: false, count: 0 },
    session: { available: true, boundedWindow: true, timedOut: false, count: 1 } };
  const snapshot = { exposureComplete: true, recoveryComplete: false, capturedAt: iso(-100), accountId: "DU_TEST", sessionId: "current",
    sourceCoverage: coverage, positions: [{ accountId: "DU_TEST", conId: "123", position: 1 }],
    openOrders: links.slice(1).map(link => ({ accountId: "DU_TEST", conId: "123", brokerOrderId: link.broker_order_id,
      orderRef: link.order_ref, permId: link.perm_id, clientId: 7, status: "Submitted", remaining: 1, filled: 0, action: "SELL" })),
    executions: [{ accountId: "DU_TEST", conId: "123", brokerOrderId: "100", orderRef: "test-PARENT", permId: "1000",
      execId: "fill-1", shares: 1, price: 100, side: "BOT", executedAt: iso(-20_000) }], completedOrders: [] };
  const review = { proposed_order_id: 42, instrument_id: "test", conid: "123", client_order_hash: computeClientOrderHash(order),
    account_id: "DU_TEST", session_id: "old-submission-session", status: "APPROVED", expires_at: iso(-10_000),
    decided_at: iso(-31_000), delivery_started_at: iso(-31_000),
    decision_json: { decision: "EXECUTE", reason: "test", confidence: 0.8, model: "test", promptVersion: "test" } };
  const run = { position_generation: 1, id: 1, account_id: "DU_TEST", session_id: "current", started_at: iso(-1000), completed_at: iso(-50),
    status: "CLEAN", broker_snapshot: snapshot, source_coverage: coverage };
  const evidence: LifecycleEvidence = { order, clientOrderHash: review.client_order_hash, review, links, run,
    activeHoldCount: 0, competingProposalCount: 0,
    positionSnapshot: { accountId: "DU_TEST", sessionId: "current", generation: 1, complete: true, observedAt: iso(-1500),
      positions: [{ accountId: "DU_TEST", sessionId: "current", conid: "123", instrument: "TEST", quantity: 1, observedAt: iso(-1500) }] } };
  const context = { accountId: "DU_TEST" as string | null, sessionId: "current", nowMs, bound: bound as BoundInstrument | null };
  return { evidence, context, snapshot, coverage, review, run, order, links };
}
