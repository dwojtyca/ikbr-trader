import { test } from "node:test";
import assert from "node:assert/strict";
import { aaplRoundTrip } from "./aapl-round-trip-test-fixture.js";
import { evaluateRoundTrip } from "./round-trip-evidence.js";

test("exact AAPL reports USD gross/net and does not label its window GPW", () => {
  const f = aaplRoundTrip(), report = evaluateRoundTrip(f.evidence, f.context);
  assert.equal(report.status, "COMPLETED", JSON.stringify(report.reasons));
  assert.deepEqual(report.grossPnl, { currency: "USD", amount: 2 });
  assert.equal(report.netPnlUSD, 1); assert.equal(report.netPnlPLN, null);
  assert.equal(report.aaplWindowRunId, "fixture-run"); assert.equal(report.gpwWindowRunId, null);
});
for (const kind of ["fill currency", "risk currency", "wrong instrument", "wrong conid", "missing window", "wrong window", "mixed fees", "missing fees"]) {
  test(`AAPL round trip refuses unproven ${kind}`, () => {
    const f = aaplRoundTrip();
    if (kind === "fill currency") f.evidence.fills[0].currency = "PLN";
    if (kind === "risk currency") Object.assign((f.review as unknown as { risk_evidence: object }).risk_evidence, { quoteCurrency: "PLN" });
    if (kind === "wrong instrument") f.context.bound = { ...f.context.bound!, instrumentId: "other" };
    if (kind === "wrong conid") f.context.bound = { ...f.context.bound!, conId: 123 };
    if (kind === "missing window") f.evidence.window = null;
    if (kind === "wrong window") f.evidence.window!.consumedProposalId = 43;
    if (kind === "mixed fees") f.evidence.fills[0].commission_currency = "EUR";
    if (kind === "missing fees") f.evidence.fills[0].commission = null;
    const report = evaluateRoundTrip(f.evidence, f.context);
    assert.equal(report.netPnlUSD, null); assert.equal(report.netPnlPLN, null);
    assert.equal(report.status, kind.endsWith("fees") ? "COMPLETED" : "NOT_PROVEN");
    if (kind === "mixed fees") assert.equal(report.accounting, "MIXED_CURRENCY");
    if (kind === "missing fees") assert.equal(report.accounting, "PENDING_FEES");
  });
}
