import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCashFills, type ReconciliationFill } from "./cash-classification.js";
import { FakeBrokerReconciliationAdapter } from "./fake-broker-adapter.js";
import type { BrokerReconciliationSnapshot } from "./broker-adapter.js";
const context = { accountId: "DU-CASH", sessionId: "cash-session", sessionStartedAt: new Date(Date.now() - 1000) };
const fill: ReconciliationFill = { execId: "cash-exec", accountId: context.accountId, conId: "123", symbol: "EUR",
  currency: "USD", side: "SELL", shares: 7, secType: null, conflict: false };
async function snapshot(): Promise<BrokerReconciliationSnapshot> {
  return { ...await new FakeBrokerReconciliationAdapter().capture({ ...context, safetyMarginMs: 1000,
    sourceTimeoutMs: 1000, abortSignal: new AbortController().signal }),
  positions: [{ accountId: context.accountId, conId: "123", symbol: "EUR", currency: "USD", secType: "CASH", position: 0 }],
  executions: [{ execId: fill.execId, brokerOrderId: "11", accountId: context.accountId, conId: "123", symbol: "EUR",
    currency: "USD", secType: "CASH", side: "SLD", shares: 7, executedAt: new Date() }] };
}
test("legacy CASH proof requires exact execution and keeps raw snapshot intact", async () => {
  const s = await snapshot(), before = JSON.stringify(s);
  const result = classifyCashFills([fill], s, context);
  assert.deepEqual(result.excluded, [fill]); assert.deepEqual([...result.resolvableKeys], ["conid:DU-CASH|123"]);
  assert.equal(JSON.stringify(s), before);
});
for (const field of ["execId", "accountId", "conId", "symbol", "currency", "side", "shares", "secType"] as const) {
  test(`legacy proof rejects mismatched ${field}`, async () => {
    const s = await snapshot();
    const row = { ...s.executions[0], [field]: field === "shares" ? 8 : field === "side" ? "BUY" : undefined };
    const result = classifyCashFills([fill], { ...s, executions: [row] } as BrokerReconciliationSnapshot, context);
    assert.equal(result.excluded.length, 0); assert.equal(result.resolvableKeys.size, 0);
  });
}
for (const mode of ["stale", "foreign-session", "partial", "coverage", "missing-second-fill", "missing-account"] as const) {
  test(`CASH hold cannot resolve with ${mode}`, async () => {
    let s = await snapshot(); let fills = [fill];
    if (mode === "stale") s = { ...s, capturedAt: new Date(Date.now() - 120000) };
    if (mode === "foreign-session") s = { ...s, sessionId: "other" };
    if (mode === "partial") s = { ...s, exposureComplete: false };
    if (mode === "coverage") s = { ...s, sourceCoverage: { ...s.sourceCoverage,
      positions: { ...s.sourceCoverage.positions, available: false } } };
    if (mode === "missing-second-fill") fills = [fill, { ...fill, execId: "unobserved" }];
    if (mode === "missing-account") fills = [{ ...fill, accountId: null }];
    assert.equal(classifyCashFills(fills, s, context).resolvableKeys.size, 0);
  });
}
for (const mode of ["durable", "typed-contradiction", "duplicate", "stock-same-contract"] as const) {
  test(`type conflict remains closed: ${mode}`, async () => {
    let s = await snapshot(); let f = fill;
    if (mode === "durable") f = { ...fill, conflict: true };
    if (mode === "typed-contradiction") f = { ...fill, secType: "STK" };
    if (mode === "duplicate") s = { ...s, executions: [...s.executions, { ...s.executions[0]!, secType: "STK" }] };
    if (mode === "stock-same-contract") s = { ...s, positions: [{ ...s.positions[0]!, secType: "STK" }] };
    assert.throws(() => classifyCashFills([f], s, context), /reconciliation_security_type_conflict/);
  });
}
for (const secType of ["STK", "FUT", "UNKNOWN", null]) test(`EUR/IDEALPRO never identifies CASH: ${secType}`, async () => {
  const s = await snapshot();
  const result = classifyCashFills([{ ...fill, secType }], { ...s, executions: [], positions: [] }, context);
  assert.equal(result.excluded.length, 0); assert.equal(result.resolvableKeys.size, 0);
});

test("unknown position type and invalid quantity cannot create a legacy CASH exemption", async () => {
  const s = await snapshot();
  assert.equal(classifyCashFills([fill], { ...s, positions: [{ ...s.positions[0]!, secType: undefined }] }, context).excluded.length, 0);
  const bad = { ...fill, secType: "CASH", shares: Number.MAX_VALUE };
  assert.equal(classifyCashFills([bad], { ...s, executions: [] }, context).excluded.length, 0);
});
