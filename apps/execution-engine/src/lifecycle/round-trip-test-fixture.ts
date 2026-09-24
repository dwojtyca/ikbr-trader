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

export function roundTripWithSmr() {
  const f = roundTrip();
  f.snapshot.positions.push({ accountId: "DU_TEST", conId: "559289446", position: 4172 });
  f.coverage.positions.count = 1;
  f.evidence.lifecycle.positionSnapshot!.positions.push({ accountId: "DU_TEST", sessionId: "current",
    conid: "559289446", instrument: "SMR", quantity: 4172, observedAt: f.evidence.lifecycle.positionSnapshot!.observedAt });
  f.snapshot.openOrders.push({ accountId: "DU_TEST", conId: "559289446", brokerOrderId: "999", orderRef: "manual-smr",
    permId: "9999", clientId: 0, status: "Submitted", remaining: 4172, filled: 0, action: "SELL" });
  f.coverage.openOrders.count = 1;
  f.snapshot.executions.push({ ...f.snapshot.executions[0], conId: "559289446", brokerOrderId: "998", orderRef: "old-smr",
    permId: "9998", execId: "smr-entry", shares: 4172, price: 14 });
  f.coverage.executions.count = 3;
  return f;
}
