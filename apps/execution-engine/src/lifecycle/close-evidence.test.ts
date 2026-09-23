import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, nowMs } from "./close-test-fixture.js";
import { evaluateCloseEvidence } from "./close-evidence.js";
import type { CloseEvidenceOptions } from "./close-types.js";

function setup() {
  const f = fixture();
  const context = { ...f.context, accountId: "DU_TEST", clientId: 7, generation: 1 };
  const options: CloseEvidenceOptions = { mode: "initial", terminals: [], closeLink: null, barrierAt: null };
  const evaluate = () => evaluateCloseEvidence(f.evidence, context, options);
  const count = () => { f.coverage.positions.count = f.snapshot.positions.length;
    f.coverage.openOrders.count = f.snapshot.openOrders.length; f.coverage.executions.count = f.snapshot.executions.length;
    f.evidence.positionSnapshot!.positions = f.snapshot.positions.map(p => ({ accountId: p.accountId, sessionId: "current", conid: p.conId,
      instrument: "TEST", quantity: p.position, observedAt: f.evidence.positionSnapshot!.observedAt })); };
  const cancel = (role: "PARENT" | "TP" | "SL") => {
    const link = f.links.find(leg => leg.role === role)!;
    options.terminals.push({ role, accountId: "DU_TEST", conid: "123", clientId: 7, generation: 1, sessionId: "current",
      brokerOrderId: link.broker_order_id, orderRef: link.order_ref, permId: link.perm_id,
      status: "CANCELLED", confirmedAt: new Date(nowMs - 2000).toISOString() });
    options.barrierAt = new Date(nowMs - 2000).toISOString();
    f.snapshot.openOrders = f.snapshot.openOrders.filter(leg => leg.brokerOrderId !== link.broker_order_id); count();
  };
  return { ...f, context, options, evaluate, count, cancel };
}

test("initial close proves whole share and cancellable client identities", () => {
  const f = setup(), result = f.evaluate();
  assert.equal(result.ok, true); assert.equal(result.quantity, 1); assert.equal(result.canComplete, false);
  assert.equal(result.legs[0].fullyFilled, true); assert.equal(result.allTerminal, false);
});
test("after confirmed cancellation fresh facts permit exactly one close", () => {
  const f = setup(); f.cancel("TP"); f.cancel("SL"); f.options.mode = "after_cancel";
  const result = f.evaluate(); assert.equal(result.ok, true); assert.equal(result.allTerminal, true); assert.equal(result.quantity, 1);
});
test("pending parent full cancellation can prove zero-fill completion", () => {
  const f = setup(); f.snapshot.positions = []; f.snapshot.executions = [];
  f.cancel("PARENT"); f.cancel("TP"); f.cancel("SL"); f.options.mode = "after_cancel";
  assert.equal(f.evaluate().canComplete, true); assert.equal(f.evaluate().quantity, 0);
});
test("empty flat snapshot never terminalizes unknown parent", () => {
  const f = setup(); f.snapshot.positions = []; f.snapshot.openOrders = []; f.snapshot.executions = []; f.count();
  assert.equal(f.evaluate().ok, false); assert.ok(f.evaluate().reasons.includes("close_flat_parent_unconfirmed"));
});
test("TP fill during cancellation plus no orphans finishes without sell", () => {
  const f = setup(); f.snapshot.positions = []; f.snapshot.openOrders = [];
  f.snapshot.executions.push({ ...f.snapshot.executions[0], brokerOrderId: "101", permId: "1001", orderRef: "test-TP", execId: "tp", side: "SLD" }); f.count();
  f.options.mode = "cancelling";
  assert.equal(f.evaluate().ok, true); assert.equal(f.evaluate().canComplete, true); assert.equal(f.evaluate().quantity, 0);
});
test("new close full fill and no orphans proves completion", () => {
  const f = setup(); f.cancel("TP"); f.cancel("SL"); f.options.mode = "reconcile";
  f.options.closeLink = { proposed_order_id: 43, account_id: "DU_TEST", role: "PARENT", role_ordinal: 0,
    broker_order_id: "200", order_ref: "close-ref", perm_id: null };
  f.snapshot.positions = [];
  f.snapshot.executions.push({ ...f.snapshot.executions[0], brokerOrderId: "200", permId: "2000", orderRef: "close-ref", execId: "close-fill", side: "SLD" }); f.count();
  assert.equal(f.evaluate().ok, true, JSON.stringify(f.evaluate())); assert.equal(f.evaluate().canComplete, true);
});
test("unknown absent close is not terminal even if protective exits filled", () => {
  const f = setup(); f.options.mode = "reconcile";
  f.options.closeLink = { proposed_order_id: 43, account_id: "DU_TEST", role: "PARENT", role_ordinal: 0,
    broker_order_id: "200", order_ref: "close-ref", perm_id: null };
  f.snapshot.positions = []; f.snapshot.openOrders = [];
  f.snapshot.executions.push({ ...f.snapshot.executions[0], brokerOrderId: "101", permId: "1001", orderRef: "test-TP", execId: "tp", side: "SLD" }); f.count();
  assert.equal(f.evaluate().canComplete, false);
});

for (const [name, mutate] of [
  ["foreign client", (f: ReturnType<typeof setup>) => { f.snapshot.openOrders[0].clientId = 9; }],
  ["missing perm", f => { f.snapshot.openOrders[0].permId = null; f.links[1].perm_id = null; }],
  ["fractional original fill", f => { f.snapshot.positions[0].position = .5; f.snapshot.executions[0].shares = .5; f.count(); }],
  ["unconfirmed absent child", f => { f.snapshot.openOrders = []; f.count(); f.options.mode = "after_cancel"; f.options.barrierAt = new Date(nowMs - 2000).toISOString(); }],
  ["pre-barrier capture", f => { f.cancel("TP"); f.cancel("SL"); f.options.mode = "after_cancel"; f.options.barrierAt = new Date(nowMs - 500).toISOString(); }],
  ["terminal wrong perm", f => { f.cancel("TP"); f.options.mode = "cancelling"; f.options.terminals[0].permId = "999"; }],
  ["terminal wrong session", f => { f.cancel("TP"); f.options.mode = "cancelling"; f.options.terminals[0].sessionId = "other"; }],
  ["terminal wrong generation", f => { f.cancel("TP"); f.options.mode = "cancelling"; f.options.terminals[0].generation = 2; }],
  ["terminal duplicate", f => { f.cancel("TP"); f.options.mode = "cancelling"; f.options.terminals.push(f.options.terminals[0]); }],
  ["generation changed", f => { f.options.originalGeneration = 1; f.context.generation = 2; }],
  ["known invalidation", f => { f.evidence.positionSnapshot!.complete = false; f.evidence.positionSnapshot!.generation++; }],
  ["newer complete snapshot", f => { f.evidence.positionSnapshot!.generation++; }],
  ["different sync position", f => { f.evidence.positionSnapshot!.positions[0].quantity = 0; }],
  ["old sync session", f => { f.evidence.positionSnapshot!.sessionId = "old"; }],
  ["missing captured generation", f => { f.run.position_generation = undefined as unknown as number; }],
  ["wrong account", f => { f.context.accountId = "other"; }],
  ["stale source", f => { f.run.started_at = new Date(nowMs - 11000).toISOString(); }],
] as Array<[string, (f: ReturnType<typeof setup>) => void]>) {
  test(`close evidence blocks ${name}`, () => { const f = setup(); mutate(f); assert.equal(f.evaluate().ok, false, JSON.stringify(f.evaluate())); });
}

test("a partially filled close stays observable and reserved without new sell authority", () => {
  const f = setup(); f.cancel("TP"); f.cancel("SL"); f.options.mode = "reconcile";
  f.options.closeLink = { proposed_order_id: 43, account_id: "DU_TEST", role: "PARENT", role_ordinal: 0,
    broker_order_id: "200", order_ref: "close-ref", perm_id: null };
  f.snapshot.positions[0].position = .5;
  f.snapshot.openOrders.push({ accountId: "DU_TEST", conId: "123", brokerOrderId: "200", orderRef: "close-ref", permId: "2000",
    clientId: 7, status: "Submitted", remaining: .5, filled: .5, action: "SELL" });
  f.snapshot.executions.push({ ...f.snapshot.executions[0], brokerOrderId: "200", permId: "2000", orderRef: "close-ref", execId: "close-partial", side: "SLD", shares: .5 }); f.count();
  const result = f.evaluate(); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.closeWorking, true);
  assert.equal(result.quantity, null); assert.equal(result.residualQuantity, .5); assert.equal(result.canComplete, false);
});
