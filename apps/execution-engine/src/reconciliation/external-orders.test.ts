import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBrokerReconciliationAdapter } from "./fake-broker-adapter.js";
import { recognizeExternalOrders, parseExternalOrders } from "./external-orders.js";
import { externalFixture } from "./external-test-fixture.js";
for (const mode of ["valid", "expired", "protected", "oversell", "aggregate", "unknown_competitor", "duplicate_perm", "foreign", "identity", "collision", "bot_ref", "short", "partial", "missing_position"] as const) test(`external manual reducing approval: ${mode}`, async () => {
  const f = externalFixture(), adapter = new FakeBrokerReconciliationAdapter();
  let row = f.row; const approvals = [f.approval]; const open = [row];
  if (mode === "expired") f.approval.expiresAt = new Date(Date.now() - 1).toISOString();
  if (mode === "oversell") f.position.position = 9;
  if (mode === "short") f.position.position = -10;
  if (mode === "foreign") row = { ...row, accountId: "OTHER" };
  if (mode === "identity") row = { ...row, currency: "PLN" };
  if (mode === "bot_ref") row = { ...row, orderRef: "co-owned" };
  if (mode === "partial") { row = { ...row, filled: 4, remaining: 6 }; f.position.position = 6; }
  open[0] = row;
  if (["aggregate", "unknown_competitor", "duplicate_perm"].includes(mode)) {
    open.push({ ...row, permId: mode === "duplicate_perm" ? row.permId : "988" });
    if (mode === "aggregate") approvals.push({ ...f.approval, permId: "988" });
  }
  adapter.configure({ positions: mode === "missing_position" ? [] : [f.position], openOrders: open });
  const snapshot = await adapter.capture({ accountId: f.approval.accountId, sessionId: "session", sessionStartedAt: new Date(), safetyMarginMs: 0, sourceTimeoutMs: 100, abortSignal: new AbortController().signal });
  const result = recognizeExternalOrders(snapshot, open, { approvals, protectedConIds: mode === "protected" ? ["123"] : [] }, new Set(mode === "collision" ? ["987"] : []), Date.now());
  assert.equal(result.size, ["valid", "partial"].includes(mode) ? 1 : 0);
});
test("external approval config has exact identities and bounded lifetime", () => {
  const { approval } = externalFixture();
  assert.equal(parseExternalOrders(JSON.stringify([approval])).length, 1);
  for (const value of [[approval, approval], [{ ...approval, conId: "*" }], [{ ...approval, totalQuantity: 1.5 }], [{ ...approval, action: "BUY" }], [{ ...approval, expiresAt: new Date(Date.now() + 2 * 86400000).toISOString() }]]) assert.throws(() => parseExternalOrders(JSON.stringify(value)));
  assert.throws(() => parseExternalOrders("not json"));
});
