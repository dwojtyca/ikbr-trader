import { fixture } from "./close-test-fixture.js";
import type { RoundTripEvidence } from "./round-trip-evidence.js";
export function roundTrip() {
  const f = fixture();
  f.context.bound = { ...f.context.bound!, currency: "PLN", exchange: "WSE",
    instrument: { ...f.context.bound!.instrument, currency: "PLN", exchange: "WSE" } };
  f.snapshot.positions = []; f.snapshot.openOrders = [];
  f.coverage.positions.count = 0; f.coverage.openOrders.count = 0; f.coverage.executions.count = 2;
  f.evidence.positionSnapshot!.positions = [];
  f.snapshot.executions.push({ ...f.snapshot.executions[0], execId: "fill-2", brokerOrderId: "101", orderRef: "test-TP",
    permId: "1001", price: 102, side: "SLD" });
  Object.assign(f.review, { risk_evidence: { accountId: "DU_TEST", instrumentId: "test", conid: "123",
    sessionId: f.review.session_id, quoteCurrency: "PLN", assessedAtMs: f.context.nowMs - 31000,
    validUntilMs: f.context.nowMs - 29000 } });
  const evidence: RoundTripEvidence = { lifecycle: f.evidence, close: null,
    window: {runId:"fixture-run",accountId:"DU_TEST",startsAt:new Date(f.context.nowMs-60000),endsAt:new Date(f.context.nowMs+60000),
      consumedAt:f.order.executionAttemptedAt!,consumedProposalId:42}, fills: f.snapshot.executions.map(fill => ({
    exec_id: fill.execId, broker_order_id: fill.brokerOrderId, proposed_order_id: 42, account_id: fill.accountId,
    conid: fill.conId, currency: "PLN", side: fill.side, shares: fill.shares, price: fill.price,
    executed_at: fill.executedAt, commission: 0.5, commission_currency: "PLN", realized_pnl: 0,
  })) };
  return { ...f, evidence };
}
