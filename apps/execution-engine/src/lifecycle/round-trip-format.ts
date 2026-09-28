import type { RoundTripReport } from "./round-trip-evidence.js";

const display = (value: unknown): string => {
  if (value === null || value === undefined) return "unknown";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const money = (value: { currency: string; amount: number } | null | undefined): string =>
  value ? `${value.amount} ${value.currency}` : "unknown";

const field = (label: string, value: unknown): string => `- **${label}:** ${display(value)}`;

/** Formats the evaluator's supplied, read-only audit result without interpreting it. */
export function formatRoundTripReport(report: RoundTripReport): string {
  const window = report.window;
  const outsideScope = report.outsideScope;
  const lines = [
    "# Round-trip audit report",
    "",
    field("Status", report.status),
    field("Refusal reasons", report.reasons.length ? report.reasons.join(", ") : "none supplied"),
    field("Proposal ID", report.proposalId),
    field("Client order hash", report.clientOrderHash),
    field("Instrument", report.instrumentId),
    field("Account", report.accountId),
    field("Contract ID", report.conid),
    field("Original strategy and configuration attribution", report.strategyAttribution),
    field("Quote currency", report.quoteCurrency),
    field("Reconciliation run ID", report.reconciliationRunId),
    field("GPW window run ID", report.gpwWindowRunId),
    field("AAPL window run ID", report.aaplWindowRunId),
    field("Paper run ID", report.paperRunId),
    field("Completion scope", report.completionScope),
    field("Run source", window?.source),
    field("Run ID", window?.runId),
    field("Run policy kind", report.runPolicyKind),
    field("Run policy hash", report.runPolicyHash),
    field("Attempt ID", report.attemptId),
    field("Account date", report.accountDate),
    field("Instrument session date", report.instrumentSessionDate),
    field("Window start", window?.startsAt),
    field("Window end", window?.endsAt),
    field("Window consumed at", window?.consumedAt),
    field("Consumed proposal ID", window?.consumedProposalId),
    field("Window effective configuration hash", window?.effectiveConfigHash),
    field("Gross P&L", money(report.grossPnl)),
    field("Net P&L", money(report.netPnl)),
    field("Accounting status", report.accounting),
    field("Commissions by currency", report.commissionsByCurrency),
    field("Missing commission execution IDs", report.missingCommissionExecIds.length ? report.missingCommissionExecIds.join(", ") : "none supplied"),
    field("Net P&L PLN alias", report.netPnlPLN),
    field("Net P&L USD alias", report.netPnlUSD),
    field("Other-contract scope evidence", outsideScope),
    field("AI decision evidence", report.ai),
    field("Entry risk evidence", report.entryRiskEvidence),
    field("Broker leg references", report.brokerLegs),
    field("Close operation evidence", report.closeOperation),
    field("Captured at", report.capturedAt),
    "",
    "## Supplied fills",
    "",
  ];

  if (report.fills.length === 0) {
    lines.push("No fills supplied.");
  } else {
    for (const fill of report.fills) {
      lines.push(`- **${fill.execId}**: role ${fill.role}; ${fill.quantity} shares at ${fill.price} ${fill.currency}; executed ${fill.executedAt}; commission ${fill.commission === null ? "unknown" : `${fill.commission} ${display(fill.commissionCurrency)}`}; broker realized P&L ${fill.brokerRealizedPnl === null ? "unknown" : fill.brokerRealizedPnl}`);
    }
  }

  return lines.join("\n");
}
