import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoundTripReport } from "./round-trip-evidence.js";
import { formatRoundTripReport } from "./round-trip-format.js";

function report(patch: Record<string, unknown> = {}): RoundTripReport {
  return {
    clientOrderHash: "a".repeat(64), strategyAttribution: { version: 1, implementationId: "momentum_breakout_long_v1",
      instanceId: "pko-instance", instrumentId: "pko_wse", instanceHash: "b".repeat(64), effectiveConfigHash: "c".repeat(64) },
    entryRiskEvidence: { allowed: false, reason: "supplied-risk-result" }, brokerLegs: [{ brokerOrderId: 701, role: "PARENT" }],
    closeOperation: { id: 91, status: "SUBMISSION_UNKNOWN" },
    economicEvidence: {}, readOnly: true, canSubmit: false, status: "COMPLETED", reasons: [], proposalId: 42,
    instrumentId: "pko_wse", accountId: "DU123", conid: "123456", sessionId: "session-1", completionScope: "INSTRUMENT",
    outsideScope: { positionObservedAt: "2026-09-28T10:00:00.000Z", ordersObservedAt: "2026-09-28T10:00:01.000Z",
      positions: [{ conid: "999", instrument: "OTHER", quantity: 3 }], workingOrderCount: 1 },
    reconciliationRunId: 7, gpwWindowRunId: "run-pko", aaplWindowRunId: null, paperRunId: null,
    runPolicyKind: "supervised_one_attempt", runPolicyHash: "d".repeat(64), attemptId: "42", accountDate: "2026-09-28",
    instrumentSessionDate: "2026-09-28", quoteCurrency: "PLN",
    netPnl: { currency: "PLN", amount: 10 },
    window: { source: "gpw", instrumentId: "pko_wse", conid: "123456", effectiveConfigHash: "c".repeat(64),
      runPolicyHash: "d".repeat(64), policyKind: "supervised_one_attempt", attemptId: "42", accountDate: "2026-09-28",
      instrumentSessionDate: "2026-09-28", runId: "run-pko", accountId: "DU123", startsAt: "2026-09-28T09:00:00Z",
      endsAt: "2026-09-28T10:00:00Z", consumedProposalId: 42, consumedAt: "2026-09-28T09:30:00Z" },
    capturedAt: "2026-09-28T10:00:01.000Z", ai: { decision: "EXECUTE", model: "fixture", promptVersion: "v1", coverage: null },
    fills: [{ execId: "entry-1", role: "PARENT", quantity: 1, price: 100, currency: "PLN", executedAt: "2026-09-28T09:10:00Z",
      commission: 0.5, commissionCurrency: "PLN", brokerRealizedPnl: null }],
    grossPnl: { currency: "PLN", amount: 10 }, commissionsByCurrency: { PLN: 1 }, missingCommissionExecIds: [],
    accounting: "COMPLETE", netPnlPLN: 9, netPnlUSD: null,
    ...patch,
  } as unknown as RoundTripReport;
}

test("formats supplied completion, original attribution, window identity, P&L and audit evidence", () => {
  const output = formatRoundTripReport(report());
  for (const expected of ["Status:** COMPLETED", "momentum_breakout_long_v1", "effectiveConfigHash",
    "run-pko", "supervised_one_attempt", "d".repeat(64), "Attempt ID:** 42", "2026-09-28T09:00:00Z",
    "Gross P&L:** 10 PLN", "Net P&L:** 10 PLN", "Commissions by currency:** {\"PLN\":1}",
    "Other-contract scope evidence", "999", "entry-1", "supplied-risk-result", "701", "SUBMISSION_UNKNOWN"]) assert.ok(output.includes(expected), expected);
});

test("formats a USD report and an instrument identity absent from the source registry", () => {
  const output = formatRoundTripReport(report({ instrumentId: "THIRD_SOURCE_ABSENT", quoteCurrency: "USD",
    grossPnl: { currency: "USD", amount: 2.25 }, netPnl: { currency: "USD", amount: 1.25 }, netPnlPLN: null,
    netPnlUSD: 1.25, commissionsByCurrency: { USD: 1 } }));
  assert.ok(output.includes("THIRD_SOURCE_ABSENT"));
  assert.ok(output.includes("Gross P&L:** 2.25 USD"));
  assert.ok(output.includes("Net P&L:** 1.25 USD"));
});

test("preserves evaluator refusal reasons and pending, mixed, or unknown accounting as supplied", () => {
  const refused = formatRoundTripReport(report({ status: "NOT_PROVEN", reasons: ["close_not_proven", "final_flat_reconciliation_not_proven"] }));
  assert.ok(refused.includes("Status:** NOT_PROVEN"));
  assert.ok(refused.includes("close_not_proven, final_flat_reconciliation_not_proven"));

  const pending = formatRoundTripReport(report({ accounting: "PENDING_FEES", grossPnl: { currency: "PLN", amount: 10 },
    netPnl: null, netPnlPLN: null, commissionsByCurrency: {}, missingCommissionExecIds: ["entry-1", "exit-1"],
    fills: [{ execId: "entry-1", role: "PARENT", quantity: 1, price: 100, currency: "PLN", executedAt: "t",
      commission: null, commissionCurrency: null, brokerRealizedPnl: null }] }));
  assert.ok(pending.includes("Accounting status:** PENDING_FEES"));
  assert.ok(pending.includes("Net P&L:** unknown"));
  assert.ok(pending.includes("Missing commission execution IDs:** entry-1, exit-1"));
  assert.ok(pending.includes("commission unknown"));

  const mixed = formatRoundTripReport(report({ accounting: "MIXED_CURRENCY", commissionsByCurrency: { PLN: 0.5, USD: 0.25 },
    netPnl: null, netPnlPLN: null }));
  assert.ok(mixed.includes("Accounting status:** MIXED_CURRENCY"));
  assert.ok(mixed.includes("{\"PLN\":0.5,\"USD\":0.25}"));
});

test("does not mutate its input report", () => {
  const value = report({ reasons: ["one"], missingCommissionExecIds: ["fill"] });
  const before = structuredClone(value);
  formatRoundTripReport(value);
  assert.deepEqual(value, before);
});
