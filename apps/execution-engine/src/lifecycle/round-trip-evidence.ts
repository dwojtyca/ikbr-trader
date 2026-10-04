import { getSupportedStockCapability, isSupportedLegacyStockManagementBound, sessionDateAt } from "@ikbr/shared";
import { buildStrategyEconomicEvidence } from "@ikbr/shared/trading-config";
import type { LifecycleContext, LifecycleEvidence, LifecycleLegLink } from "./ownership.js";
import { evaluateLifecycleFacts } from "./ownership.js";

export interface RoundTripFill {
  sec_type?: string | null; sec_type_conflict?: boolean;
  exec_id: string; broker_order_id: string | null; proposed_order_id: number | null;
  account_id: string | null; conid: string | null; currency: string | null; side: string;
  shares: number | null; price: number | null; executed_at: Date | string | null;
  commission: number | null; commission_currency: string | null; realized_pnl: number | null;
}
export interface RoundTripEvidence {
  lifecycle: LifecycleEvidence;
  window: null | { source?: "paper" | "gpw" | "aapl"; instrumentId?: string; conid?: string; effectiveConfigHash?: string;
    runPolicyHash?: string; policyKind?: "supervised_one_attempt"; attemptId?: string; accountDate?: string; instrumentSessionDate?: string;
    runId: string; accountId: string; startsAt: Date | string; endsAt: Date | string;
    consumedProposalId: number | null; consumedAt: Date | string | null };
  close: null | { state: string; accountId: string; conid: string; originalHash: string;
    closeProposalId: number | null; links: LifecycleLegLink[]; submissionAttemptedAt?: Date | string | null; terminals?: import("./close-types.js").CloseTerminalEvidence[]; generation?: number; sessionId?: string; clientId?: number; barrierAt?: Date | string | null };
  fills: RoundTripFill[];
}
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const time = (v: unknown) => v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e100;
const contractId = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v));
const side = (v: string) => ["BUY", "BOT"].includes(v) ? "BUY" : ["SELL", "SLD"].includes(v) ? "SELL" : null;

export function evaluateRoundTrip(evidence: RoundTripEvidence, context: LifecycleContext) {
  const { lifecycle, close } = evidence;
  const capability = context.bound ? getSupportedStockCapability(context.bound) : null;
  const legacy = !lifecycle.order.strategyAttribution && context.bound && isSupportedLegacyStockManagementBound(context.bound);
  const quoteCurrency = capability?.quoteCurrency ?? (legacy ? context.bound!.currency as "USD" | "PLN" : null);
  const windowSource = evidence.window?.source ?? (!lifecycle.order.strategyAttribution && legacy ? (quoteCurrency === "USD" ? "aapl" : "gpw") : null);
  const review = record(lifecycle.review), decision = record(review?.decision_json), risk = record(review?.risk_evidence);
  const report = {
    clientOrderHash: lifecycle.clientOrderHash,
    strategyAttribution: lifecycle.order.strategyAttribution ?? null,
    economicEvidence: buildStrategyEconomicEvidence({
      fills: evidence.fills.map(fill => ({ execId: fill.exec_id, accountId: fill.account_id, conid: fill.conid,
        proposedOrderId: fill.proposed_order_id, brokerOrderId: fill.broker_order_id, secType: fill.sec_type ?? null, secTypeConflict: fill.sec_type_conflict === true, side: fill.side, currency: fill.currency,
        quantity: fill.shares, price: fill.price, executedAt: Number.isFinite(time(fill.executed_at)) ? new Date(time(fill.executed_at)).toISOString() : null,
        commission: fill.commission, commissionCurrency: fill.commission_currency })),
      links: [...lifecycle.links, ...(close?.links ?? [])].map(link => ({
        proposedOrderId: link.proposed_order_id, accountId: link.account_id, role: link.role,
        brokerOrderId: link.broker_order_id, orderRef: link.order_ref })),
      close: close ? { state: close.state, accountId: close.accountId, conid: close.conid, originalHash: close.originalHash,
        closeProposalId: close.closeProposalId } : null,
    }),
    readOnly: true as const, canSubmit: false as const, status: "NOT_PROVEN" as "NOT_PROVEN" | "COMPLETED",
    reasons: [] as string[], proposalId: lifecycle.order.id ?? null, instrumentId: lifecycle.order.instrumentId ?? null,
    accountId: context.accountId, conid: lifecycle.order.conid ?? null, sessionId: context.sessionId,
    completionScope: "INSTRUMENT" as const,
    outsideScope: null as null | { positionObservedAt: string; ordersObservedAt: string;
      positions: Array<{ conid: string; instrument: string; quantity: number }>; workingOrderCount: number },
    reconciliationRunId: lifecycle.run?.id ?? null, gpwWindowRunId: windowSource === "gpw" ? evidence.window?.runId ?? null : null,
    aaplWindowRunId: windowSource === "aapl" ? evidence.window?.runId ?? null : null,
    paperRunId: windowSource === "paper" ? evidence.window?.runId ?? null : null,
    runPolicyKind: evidence.window?.policyKind ?? null, runPolicyHash: evidence.window?.runPolicyHash ?? null,
    attemptId: evidence.window?.attemptId ?? null, accountDate: evidence.window?.accountDate ?? null,
    instrumentSessionDate: evidence.window?.instrumentSessionDate ?? null, quoteCurrency,
    netPnl: null as { currency: "PLN" | "USD"; amount: number } | null,
    window: evidence.window, capturedAt: null as string | null,
    entryRiskEvidence: null as Record<string, unknown> | null,
    brokerLegs: lifecycle.links.map(link => ({ proposedOrderId: link.proposed_order_id, role: link.role, roleOrdinal: link.role_ordinal,
      brokerOrderId: link.broker_order_id, orderRef: link.order_ref, permId: link.perm_id, accountId: link.account_id })),
    closeOperation: close ? { state: close.state, accountId: close.accountId, conid: close.conid, originalHash: close.originalHash, closeProposalId: close.closeProposalId } : null,
    ai: decision ? { decision: decision.decision, model: decision.model, promptVersion: decision.promptVersion,
      coverage: record(decision.context)?.coverage ?? null } : null,
    fills: [] as Array<{ execId: string; role: string; quantity: number; price: number; currency: string;
      executedAt: string; commission: number | null; commissionCurrency: string | null; brokerRealizedPnl: number | null }>,
    grossPnl: null as { currency: "PLN" | "USD"; amount: number } | null,
    commissionsByCurrency: {} as Record<string, number>, missingCommissionExecIds: [] as string[],
    accounting: "NOT_PROVEN" as "NOT_PROVEN" | "PENDING_FEES" | "MIXED_CURRENCY" | "COMPLETE",
    netPnlPLN: null as number | null,
    netPnlUSD: null as number | null,
  };
  const refuse = (reason: string) => { report.reasons.push(reason); return report; };
  if (!quoteCurrency || (!capability && !legacy)) return refuse("scope_stock_capability_unsupported");
  let closeLink: LifecycleLegLink | null = null;
  if (close) {
    if (close.state !== "COMPLETED" || close.accountId !== context.accountId || close.conid !== lifecycle.order.conid ||
      close.originalHash !== lifecycle.clientOrderHash || (close.closeProposalId === null ? close.links.length !== 0 :
        close.links.length !== 1 || close.links[0].proposed_order_id !== close.closeProposalId)) return refuse("close_not_proven");
    closeLink = close.links[0] ?? null;
  }
  const facts = evaluateLifecycleFacts(lifecycle, context, { requireProtection: false, closeLink });
  report.capturedAt = facts.capturedAt;
  if (facts.status === "BLOCKED") { report.reasons.push(...facts.reasons); return report; }
  if (lifecycle.run?.status !== "CLEAN" || facts.status !== "FLAT_OBSERVED" || facts.ownedFillNet !== 0 ||
    facts.brokerPositionQuantity !== 0 || facts.legs.some(leg => leg.observed)) return refuse("final_flat_reconciliation_not_proven");
  const snapshot = record(lifecycle.run.broker_snapshot)!;
  for (const name of ["positions", "openOrders", "executions"] as const) {
    const rows = (snapshot[name] as Record<string, unknown>[]).filter(row => row.accountId === context.accountId);
    if (rows.some(row => !contractId(row.conId) || (name === "positions" && !finite(row.position))))
      return refuse("snapshot_contract_identity_or_quantity_invalid");
  }
  const workingOrders = (snapshot.openOrders as Record<string, unknown>[]).filter(row => row.accountId === context.accountId);
  if (workingOrders.some(row => row.conId === lifecycle.order.conid)) return refuse("instrument_working_orders_remain");
  const sync = lifecycle.positionSnapshot;
  if (!sync || sync.accountId !== context.accountId || sync.sessionId !== context.sessionId || !sync.complete ||
    sync.generation !== lifecycle.run.position_generation || !Number.isSafeInteger(sync.generation) || sync.generation < 1 ||
    !Number.isFinite(time(sync.observedAt)) || context.nowMs - time(sync.observedAt) >= 10_000 ||
    time(sync.observedAt) > time(lifecycle.run.started_at) || sync.positions.some(p =>
      p.accountId !== context.accountId || p.sessionId !== context.sessionId || !contractId(p.conid) || !finite(p.quantity) ||
      time(p.observedAt) !== time(sync.observedAt) || (p.conid === lifecycle.order.conid && p.quantity !== 0)) ||
    new Set(sync.positions.map(p => p.conid)).size !== sync.positions.length) return refuse("final_position_snapshot_not_proven");
  report.outsideScope = {
    positionObservedAt: new Date(time(sync.observedAt)).toISOString(), ordersObservedAt: facts.capturedAt!,
    positions: sync.positions.filter(p => p.conid !== lifecycle.order.conid && p.quantity !== 0)
      .map(p => ({ conid: p.conid!, instrument: p.instrument, quantity: p.quantity })),
    workingOrderCount: workingOrders.length,
  };
  const attempted = time(lifecycle.order.executionAttemptedAt);
  const window = evidence.window;
  if (!window || !window.runId || window.accountId !== context.accountId || window.consumedProposalId !== lifecycle.order.id ||
    ![time(window.startsAt), time(window.endsAt), time(window.consumedAt), attempted].every(Number.isFinite) ||
    time(window.endsAt) <= time(window.startsAt) || time(window.endsAt) - time(window.startsAt) > 3_600_000 ||
    attempted < time(window.startsAt) || attempted >= time(window.endsAt) || time(window.consumedAt) < time(window.startsAt) ||
    time(window.consumedAt) >= time(window.endsAt) || time(window.consumedAt) > context.nowMs)
    return refuse("consumed_window_not_proven");
  if (lifecycle.order.strategyAttribution && (window.source !== "paper" || window.instrumentId !== lifecycle.order.instrumentId ||
    window.conid !== lifecycle.order.conid || window.effectiveConfigHash !== lifecycle.order.strategyAttribution.effectiveConfigHash ||
    window.policyKind !== "supervised_one_attempt" || !window.runPolicyHash || !/^[a-f0-9]{64}$/.test(window.runPolicyHash) ||
    window.attemptId !== String(lifecycle.order.id) || !/^[1-9]\d*$/.test(window.attemptId) ||
    window.accountDate !== sessionDateAt(attempted, "Europe/Warsaw") ||
    window.instrumentSessionDate !== sessionDateAt(attempted, capability!.timeZone))) return refuse("generic_attempt_identity_not_proven");
  if (!risk || risk.accountId !== context.accountId || risk.conid !== lifecycle.order.conid ||
    risk.instrumentId !== lifecycle.order.instrumentId || risk.sessionId !== review?.session_id || risk.quoteCurrency !== quoteCurrency ||
    !finite(risk.assessedAtMs) || !finite(risk.validUntilMs) || risk.assessedAtMs > attempted || risk.validUntilMs <= attempted)
    return refuse("entry_risk_evidence_missing");
  report.entryRiskEvidence = JSON.parse(JSON.stringify(risk)) as Record<string, unknown>;
  const executions = (snapshot.executions as Record<string, unknown>[]).filter(row =>
    row.accountId === context.accountId && row.conId === lifecycle.order.conid);
  const unique = new Map<string, Record<string, unknown>>();
  for (const execution of executions) {
    if (execution.secType !== "STK" || execution.currency !== quoteCurrency) return refuse("broker_fill_type_or_currency_mismatch");
    unique.set(execution.execId as string, execution);
  }
  if (evidence.fills.length !== unique.size || new Set(evidence.fills.map(fill => fill.exec_id)).size !== evidence.fills.length)
    return refuse("persisted_fills_not_exact");
  const links = closeLink ? [...lifecycle.links, { ...closeLink, role: "CLOSE" }] : lifecycle.links;
  for (const fill of evidence.fills) {
    const execution = unique.get(fill.exec_id);
    const link = links.find(leg => execution && leg.broker_order_id === execution.brokerOrderId && leg.order_ref === execution.orderRef);
    if (!execution || !link || fill.sec_type !== "STK" || fill.sec_type_conflict === true || execution.secType !== "STK" || execution.currency !== quoteCurrency || (fill.proposed_order_id !== null && fill.proposed_order_id !== link.proposed_order_id) || fill.account_id !== context.accountId ||
      fill.conid !== lifecycle.order.conid || fill.broker_order_id !== link.broker_order_id || fill.currency !== quoteCurrency ||
      side(fill.side) !== side(String(execution.side)) || !finite(fill.shares) || fill.shares <= 0 || fill.shares !== execution.shares ||
      !finite(fill.price) || fill.price <= 0 || fill.price !== execution.price || !Number.isFinite(time(fill.executed_at)) ||
      time(fill.executed_at) !== time(execution.executedAt)) return refuse("persisted_fill_identity_or_value_mismatch");
    report.fills.push({ execId: fill.exec_id, role: link.role, quantity: fill.shares, price: fill.price,
      currency: fill.currency, executedAt: new Date(time(fill.executed_at)).toISOString(),
      commission: finite(fill.commission) ? fill.commission : null,
      commissionCurrency: typeof fill.commission_currency === "string" && /^[A-Z]{3}$/.test(fill.commission_currency) ? fill.commission_currency : null,
      brokerRealizedPnl: finite(fill.realized_pnl) ? fill.realized_pnl : null });
  }
  const entries = report.fills.filter(fill => fill.role === "PARENT"), exits = report.fills.filter(fill => fill.role !== "PARENT");
  if (entries.reduce((sum, fill) => sum + fill.quantity, 0) !== 1 || exits.reduce((sum, fill) => sum + fill.quantity, 0) !== 1)
    return refuse("one_share_round_trip_not_proven");
  if (Math.min(...exits.map(fill => time(fill.executedAt))) < Math.max(...entries.map(fill => time(fill.executedAt))))
    return refuse("exit_precedes_entry");
  report.status = "COMPLETED";
  report.grossPnl = { currency: quoteCurrency, amount: exits.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) -
    entries.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) };
  for (const fill of report.fills) {
    if (fill.commission === null || fill.commissionCurrency === null) report.missingCommissionExecIds.push(fill.execId);
    else report.commissionsByCurrency[fill.commissionCurrency] = (report.commissionsByCurrency[fill.commissionCurrency] ?? 0) + fill.commission;
  }
  report.accounting = report.missingCommissionExecIds.length ? "PENDING_FEES" :
    Object.keys(report.commissionsByCurrency).some(currency => currency !== quoteCurrency) ? "MIXED_CURRENCY" : "COMPLETE";
  if (report.accounting === "COMPLETE") {
    const net = report.grossPnl.amount - (report.commissionsByCurrency[quoteCurrency] ?? 0);
    report.netPnl = { currency: quoteCurrency, amount: net };
    if (quoteCurrency === "USD") report.netPnlUSD = net;
    else report.netPnlPLN = net;
  }
  return report;
}

export type RoundTripReport = ReturnType<typeof evaluateRoundTrip>;
