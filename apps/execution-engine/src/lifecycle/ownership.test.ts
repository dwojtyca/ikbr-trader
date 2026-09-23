import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoundInstrument, ProposedOrder } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { evaluateLifecycleOwnership, type LifecycleEvidence } from "./ownership.js";

const nowMs = Date.parse("2026-09-23T12:00:00Z");
const iso = (delta = 0) => new Date(nowMs + delta).toISOString();
function fixture() {
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
      orderRef: link.order_ref, permId: link.perm_id, status: "Submitted", remaining: 1, filled: 0, action: "SELL" })),
    executions: [{ accountId: "DU_TEST", conId: "123", brokerOrderId: "100", orderRef: "test-PARENT", permId: "1000",
      execId: "fill-1", shares: 1, price: 100, side: "BOT", executedAt: iso(-20_000) }], completedOrders: [] };
  const review = { proposed_order_id: 42, instrument_id: "test", conid: "123", client_order_hash: computeClientOrderHash(order),
    account_id: "DU_TEST", session_id: "old-submission-session", status: "APPROVED", expires_at: iso(-10_000),
    decided_at: iso(-31_000), delivery_started_at: iso(-31_000),
    decision_json: { decision: "EXECUTE", reason: "test", confidence: 0.8, model: "test", promptVersion: "test" } };
  const run = { id: 1, account_id: "DU_TEST", session_id: "current", started_at: iso(-1000), completed_at: iso(-50),
    status: "CLEAN", broker_snapshot: snapshot, source_coverage: coverage };
  const evidence: LifecycleEvidence = { order, clientOrderHash: review.client_order_hash, review, links, run,
    activeHoldCount: 0, competingProposalCount: 0 };
  const context = { accountId: "DU_TEST" as string | null, sessionId: "current", nowMs, bound: bound as BoundInstrument | null };
  return { evidence, context, snapshot, coverage, review, run, order, links };
}
type Fixture = ReturnType<typeof fixture>;
function evaluate(f: Fixture) {
  const result = evaluateLifecycleOwnership(f.evidence, f.context);
  assert.equal(result.readOnly, true); assert.equal(result.canSubmitClose, false);
  return result;
}
function rehash(f: Fixture) { f.evidence.clientOrderHash = computeClientOrderHash(f.order); f.review.client_order_hash = f.evidence.clientOrderHash; }
function counts(f: Fixture) {
  f.coverage.positions.count = f.snapshot.positions.length;
  f.coverage.openOrders.count = f.snapshot.openOrders.length;
  f.coverage.executions.count = f.snapshot.executions.length;
}
function pending(f: Fixture) {
  f.snapshot.positions = []; f.snapshot.executions = [];
  f.snapshot.openOrders.unshift({ accountId: "DU_TEST", conId: "123", brokerOrderId: "100", orderRef: "test-PARENT", permId: "1000",
    status: "PreSubmitted", remaining: 1, filled: 0, action: "BUY" }); counts(f);
}
function flat(f: Fixture) {
  f.snapshot.positions = []; f.snapshot.openOrders = [];
  f.snapshot.executions.push({ ...f.snapshot.executions[0], brokerOrderId: "101", permId: "1001", orderRef: "test-TP", execId: "fill-2", side: "SLD" }); counts(f);
}

test("ownership survives restart with complete historical executions and retains an expired historical approval", () => {
  const result = evaluate(fixture());
  assert.equal(result.status, "OWNED_POSITION"); assert.equal(result.ownedFillNet, 1);
  assert.equal(result.brokerPositionQuantity, 1); assert.equal(result.reasons.length, 0);
});
test("partial entry and partial exit remain descriptive", () => {
  const f = fixture(); f.snapshot.executions[0].shares = 0.5; f.snapshot.positions[0].position = 0.5;
  assert.equal(evaluate(f).status, "OWNED_POSITION");
  f.snapshot.executions.push({ ...f.snapshot.executions[0], brokerOrderId: "101", permId: "1001", orderRef: "test-TP", execId: "fill-2", side: "SELL", shares: 0.25 });
  f.snapshot.positions[0].position = 0.25; counts(f);
  assert.equal(evaluate(f).ownedFillNet, 0.25);
});
test("active parent with zero owned fills is pending", () => { const f = fixture(); pending(f); assert.equal(evaluate(f).status, "PENDING_ENTRY"); });
test("complete round trip with no remaining open orders is flat", () => { const f = fixture(); flat(f); assert.equal(evaluate(f).status, "FLAT_OBSERVED"); });
test("no fills and no observed orders is merely flat, never cancellation confirmation", () => {
  const f = fixture(); f.snapshot.positions = []; f.snapshot.openOrders = []; f.snapshot.executions = []; counts(f);
  assert.equal(evaluate(f).status, "FLAT_OBSERVED");
});
test("exact repeated execution rows are deduplicated", () => {
  const f = fixture(); f.snapshot.executions.push({ ...f.snapshot.executions[0] }); counts(f);
  assert.equal(evaluate(f).ownedFillNet, 1); assert.equal(evaluate(f).status, "OWNED_POSITION");
});
test("known other accounts and contracts are excluded", () => {
  const f = fixture(); f.snapshot.positions.push({ accountId: "OTHER", conId: "123", position: 999 });
  f.snapshot.openOrders.push({ ...f.snapshot.openOrders[0], accountId: "OTHER" });
  f.snapshot.executions.push({ ...f.snapshot.executions[0], accountId: "OTHER" });
  f.snapshot.positions.push({ accountId: "DU_TEST", conId: "999", position: 9 }); counts(f);
  assert.equal(evaluate(f).status, "OWNED_POSITION");
});
test("malformed persisted JSON fails closed without throwing", () => {
  for (const value of [null, [], {}, 1, "bad"]) {
    const f = fixture(); f.run.broker_snapshot = value as unknown as typeof f.snapshot;
    assert.equal(evaluate(f).status, "BLOCKED");
  }
});
const cases: Array<[string, (f: Fixture) => void, string?]> = [
  ["missing account", f => { f.context.accountId = null; }, "current_identity_missing"],
  ["missing binding", f => { f.context.bound = null; }, "binding_mismatch"],
  ["disabled binding", f => { f.context.bound = { ...f.context.bound!, instrument: { ...f.context.bound!.instrument,
    trading: { ...f.context.bound!.instrument.trading, executionEnabled: false } } }; }, "binding_mismatch"],
  ["wrong contract", f => { f.context.bound = { ...f.context.bound!, conId: 999 }; }, "binding_mismatch"],
  ["wrong strategy", f => { f.order.strategy = "other"; }, "policy_mismatch"],
  ["nonUSD binding", f => { f.context.bound = { ...f.context.bound!, currency: "EUR" }; }, "binding_mismatch"],
  ["nonstock binding", f => { f.context.bound = { ...f.context.bound!, instrument: { ...f.context.bound!.instrument, assetClass: "future" } }; }, "binding_mismatch"],
  ["missing attempt", f => { delete f.order.executionAttemptedAt; }],
  ["future attempt", f => { f.order.executionAttemptedAt = new Date(iso(1)); }],
  ["wrong execution account", f => { f.order.executionAccountId = "OTHER"; }],
  ["missing hash", f => { f.evidence.clientOrderHash = null; }, "proposal_hash_missing"],
  ["modified monetary identity", f => { f.order.entry = 110; }, "proposal_hash_mismatch"],
  ["close spoof", f => { f.order.positionEffect = "CLOSE_OR_REDUCE"; rehash(f); }, "proposal_scope_invalid"],
  ["nonPASS proposal", f => { f.order.riskCheckStatus = "REJECT"; rehash(f); }, "proposal_scope_invalid"],
  ["short", f => { f.order.side = "SELL"; rehash(f); }],
  ["fractional ticket", f => { f.order.quantity = 0.5; rehash(f); }],
  ["no approval", f => { f.evidence.review = null; }, "approval_invalid"],
  ["pending approval", f => { f.review.status = "PENDING"; }, "approval_invalid"],
  ["wrong approval hash", f => { f.review.client_order_hash = "wrong"; }, "approval_invalid"],
  ["wrong approval account", f => { f.review.account_id = "OTHER"; }, "approval_invalid"],
  ["wrong approval contract", f => { f.review.conid = "456"; }, "approval_invalid"],
  ["attempt after approval expiry", f => { f.review.expires_at = iso(-30_000); }, "approval_invalid"],
  ["delivery after attempt", f => { f.review.delivery_started_at = iso(-29_000); }, "approval_invalid"],
  ["invalid decision confidence", f => { f.review.decision_json.confidence = Infinity; }, "approval_invalid"],
  ["active hold", f => { f.evidence.activeHoldCount = 1; }, "active_account_hold"],
  ["competing intent", f => { f.evidence.competingProposalCount = 1; }, "competing_proposal"],
  ["missing run", f => { f.evidence.run = null; }, "latest_run_unusable"],
  ["latest failed run", f => { f.run.status = "FAILED"; }, "latest_run_unusable"],
  ["latest running run", f => { f.run.status = "RUNNING"; }, "latest_run_unusable"],
  ["old process session", f => { f.run.session_id = "old"; }, "latest_run_unusable"],
  ["wrong run account", f => { f.run.account_id = "OTHER"; }, "latest_run_unusable"],
  ["snapshot wrong session", f => { f.snapshot.sessionId = "old"; }, "snapshot_identity_invalid"],
  ["snapshot wrong account", f => { f.snapshot.accountId = "OTHER"; }, "snapshot_identity_invalid"],
  ["stale run", f => { f.run.started_at = iso(-10_000); }, "snapshot_time_invalid"],
  ["future completion", f => { f.run.completed_at = iso(1); }, "snapshot_time_invalid"],
  ["capture before start", f => { f.snapshot.capturedAt = iso(-2000); }, "snapshot_time_invalid"],
  ["capture after completion", f => { f.run.completed_at = iso(-150); }, "snapshot_time_invalid"],
  ["missing snapshot", f => { f.run.broker_snapshot = null as unknown as typeof f.snapshot; }],
  ["restart loses history", f => { f.coverage.executions.window.from = iso(-2000); }, "coverage_incomplete"],
  ["future execution window", f => { f.coverage.executions.window.to = iso(1); }, "coverage_incomplete"],
  ["execution window before run", f => { f.coverage.executions.window.to = iso(-1500); }, "coverage_incomplete"],
  ["timeout", f => { f.coverage.openOrders.timedOut = true; }, "coverage_incomplete"],
  ["missing positions coverage", f => { f.coverage.positions.available = false; }, "coverage_incomplete"],
  ["missing session", f => { f.coverage.session.available = false; }, "coverage_incomplete"],
  ["exposure incomplete", f => { f.snapshot.exposureComplete = false; }, "coverage_incomplete"],
  ["missing leg", f => { f.links.pop(); }, "durable_legs_invalid"],
  ["open count mismatch", f => { f.coverage.openOrders.count++; }, "snapshot_rows_invalid"],
  ["execution count mismatch", f => { f.coverage.executions.count++; }, "snapshot_rows_invalid"],
  ["duplicate link broker id", f => { f.links[1].broker_order_id = f.links[0].broker_order_id; }, "durable_legs_invalid"],
  ["duplicate link ref", f => { f.links[1].order_ref = f.links[0].order_ref; }, "durable_legs_invalid"],
  ["duplicate link perm", f => { f.links[1].perm_id = f.links[0].perm_id; }, "durable_legs_invalid"],
  ["wrong link account", f => { f.links[1].account_id = "OTHER"; }, "durable_legs_invalid"],
  ["wrong link proposal", f => { f.links[1].proposed_order_id = 999; }, "durable_legs_invalid"],
  ["missing open order account", f => { f.snapshot.openOrders[0].accountId = ""; }, "openOrders_account_missing"],
  ["missing execution account", f => { f.snapshot.executions[0].accountId = ""; }, "executions_account_missing"],
  ["missing position account", f => { f.snapshot.positions[0].accountId = ""; }, "position_account_missing"],
  ["missing position contract", f => { f.snapshot.positions[0].conId = ""; }, "position_contract_missing"],
  ["duplicate position", f => { f.snapshot.positions.push({ ...f.snapshot.positions[0] }); counts(f); }, "position_ambiguous"],
  ["manual exposure", f => { f.snapshot.positions[0].position = 2; }, "position_ambiguous"],
  ["unattributed manual order", f => { f.snapshot.openOrders.push({ ...f.snapshot.openOrders[0], brokerOrderId: "999", orderRef: "manual" }); counts(f); }, "openOrders_uncorrelated"],
  ["unattributed execution", f => { f.snapshot.executions[0].orderRef = "manual"; }, "executions_uncorrelated"],
  ["mismatched union identifiers", f => { f.snapshot.openOrders[0].brokerOrderId = "102"; }, "openOrders_uncorrelated"],
  ["wrong permId", f => { f.snapshot.openOrders[0].permId = "999"; }, "openOrders_uncorrelated"],
  ["same order wrong contract", f => { f.snapshot.openOrders[0].conId = "999"; }, "openOrders_contract_mismatch"],
  ["duplicate open order", f => { f.snapshot.openOrders.push({ ...f.snapshot.openOrders[0] }); counts(f); }, "duplicate_open_order"],
  ["negative remaining", f => { f.snapshot.openOrders[0].remaining = -1; }, "open_order_quantity_invalid"],
  ["excess remaining", f => { f.snapshot.openOrders[0].remaining = 2; }, "open_order_quantity_invalid"],
  ["NaN remaining", f => { f.snapshot.openOrders[0].remaining = NaN; }, "open_order_quantity_invalid"],
  ["nonfinite filled", f => { f.snapshot.openOrders[0].filled = Infinity; }, "open_order_quantity_invalid"],
  ["protective order wrong action", f => { f.snapshot.openOrders[0].action = "BUY"; }, "open_order_action_invalid"],
  ["pending cancel child", f => { f.snapshot.openOrders[0].status = "PendingCancel"; }, "open_order_not_active"],
  ["inactive child", f => { f.snapshot.openOrders[0].status = "Inactive"; }, "open_order_not_active"],
  ["cancelled child", f => { f.snapshot.openOrders[0].status = "Cancelled"; }, "open_order_not_active"],
  ["missing protection", f => { f.snapshot.openOrders.pop(); counts(f); }, "protection_missing"],
  ["protection too small", f => { f.snapshot.openOrders[0].remaining = 0.5; }, "protection_missing"],
  ["negative fill", f => { f.snapshot.executions[0].shares = -1; }, "execution_invalid"],
  ["zero fill", f => { f.snapshot.executions[0].shares = 0; }, "execution_invalid"],
  ["nonfinite fill", f => { f.snapshot.executions[0].shares = Infinity; }, "execution_invalid"],
  ["wrong fill side", f => { f.snapshot.executions[0].side = "SELL"; }, "execution_invalid"],
  ["fill before attempt", f => { f.snapshot.executions[0].executedAt = iso(-31_000); }, "execution_invalid"],
  ["fill after window", f => { f.snapshot.executions[0].executedAt = iso(-150); }, "execution_invalid"],
  ["conflicting execution id", f => { f.snapshot.executions.push({ ...f.snapshot.executions[0], shares: 0.5 }); counts(f); }, "conflicting_execution_id"],
  ["overfill", f => { f.snapshot.executions[0].shares = 2; }, "fills_exceed_owned_quantity"],
  ["negative net", f => { flat(f); f.snapshot.executions[1].shares = 2; }, "fills_exceed_owned_quantity"],
  ["position fill disagreement", f => { f.snapshot.positions[0].position = 0.5; }, "position_fill_mismatch"],
  ["orphan protective orders", f => { const children = [...f.snapshot.openOrders]; flat(f); f.snapshot.openOrders = children; counts(f); }, "orphan_open_order"],
  ["local cancellation does not prove flat", f => { f.order.status = "CANCELLED"; f.snapshot.executions = []; counts(f); }, "position_fill_mismatch"],
  ["pending parent wrong action", f => { pending(f); f.snapshot.openOrders[0].action = "SELL"; }, "open_order_action_invalid"],
  ["pending parent inactive", f => { pending(f); f.snapshot.openOrders[0].status = "Inactive"; }, "open_order_not_active"],
];
for (const [name, mutate, reason] of cases) test(`ownership blocks ${name}`, () => {
  const f = fixture(); mutate(f); const result = evaluate(f);
  assert.equal(result.status, "BLOCKED"); if (reason) assert.deepEqual(result.reasons, [reason]);
});

test("evaluator does not mutate persisted evidence", () => {
  const f = fixture(); const before = structuredClone(f.evidence); evaluate(f); assert.deepEqual(f.evidence, before);
});


test("completed-orders unsupported does not block fully covered exposure", () => {
  const f = fixture(); f.run.status = "INCOMPLETE";
  assert.equal(evaluate(f).status, "OWNED_POSITION");
});
test("broker second-precision execution timestamp accepts same-second durable attempt", () => {
  const f = fixture(); f.order.executionAttemptedAt = new Date(iso(-29_501));
  f.snapshot.executions[0].executedAt = iso(-30_000);
  assert.equal(evaluate(f).status, "OWNED_POSITION");
});
test("filtered account positions retain raw coverage count", () => {
  const f = fixture(); f.coverage.positions.count = 5;
  assert.equal(evaluate(f).status, "OWNED_POSITION");
});
test("parent with unknown saved permId cannot borrow saved protective permId", () => {
  const f = fixture(); f.links[0].perm_id = null; f.snapshot.executions[0].permId = "1001";
  assert.deepEqual(evaluate(f).reasons, ["broker_identity_conflict"]);
});
test("observed protective legs cannot share permId when saved permIds are absent", () => {
  const f = fixture(); f.links[1].perm_id = null; f.links[2].perm_id = null;
  f.snapshot.openOrders[1].permId = f.snapshot.openOrders[0].permId;
  assert.deepEqual(evaluate(f).reasons, ["broker_identity_conflict"]);
});
test("open order and execution permIds must agree for the same leg", () => {
  const f = fixture(); f.links[1].perm_id = null;
  f.snapshot.executions.push({ ...f.snapshot.executions[0], brokerOrderId: "101", permId: "9999", orderRef: "test-TP", execId: "fill-2", side: "SELL", shares: 0.25 });
  f.snapshot.positions[0].position = 0.75; counts(f);
  assert.deepEqual(evaluate(f).reasons, ["broker_identity_conflict"]);
});
