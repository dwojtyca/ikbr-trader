import type { BoundInstrument, ProposedOrder } from "@ikbr/shared";
import { validatePersistedOrderIdentity } from "../repository.js";

export interface LifecycleLegLink {
  proposed_order_id: number;
  account_id: string;
  role: string;
  role_ordinal: number;
  broker_order_id: string | null;
  perm_id: string | null;
  order_ref: string;
}
export interface LifecycleRun {
  id: number;
  account_id: string;
  session_id: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  status: string;
  broker_snapshot: unknown;
  source_coverage: unknown;
}
export interface LifecycleEvidence {
  order: ProposedOrder;
  clientOrderHash: string | null;
  review: unknown;
  links: readonly LifecycleLegLink[];
  run: LifecycleRun | null;
  activeHoldCount: number;
  competingProposalCount: number;
}
export interface LifecycleOwnershipReport {
  readOnly: true;
  canSubmitClose: false;
  status: "PENDING_ENTRY" | "OWNED_POSITION" | "FLAT_OBSERVED" | "BLOCKED";
  reasons: string[];
  accountId: string | null;
  proposalId: number | null;
  instrumentId: string | null;
  conid: string | null;
  runId: number | null;
  sessionId: string;
  capturedAt: string | null;
  brokerPositionQuantity: number | null;
  ownedFillNet: number | null;
  legs: Array<{ role: string; brokerOrderId: string; orderRef: string; observed: boolean;
    status: string | null; remaining: number | null; filledQuantity: number }>;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stamp = (value: unknown): number => value instanceof Date ? value.getTime()
  : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const normalizeStatus = (value: unknown) => typeof value === "string" ? value.toUpperCase().replaceAll("_", "") : "";
const active = (value: unknown) => ["SUBMITTED", "PRESUBMITTED"].includes(normalizeStatus(value));

export function evaluateLifecycleOwnership(evidence: LifecycleEvidence, context: {
  accountId: string | null; sessionId: string; nowMs: number; bound: BoundInstrument | null;
}): LifecycleOwnershipReport {
  const { order, run, links } = evidence;
  const { accountId, sessionId, nowMs, bound } = context;
  const report: LifecycleOwnershipReport = { readOnly: true, canSubmitClose: false, status: "BLOCKED", reasons: [],
    accountId, proposalId: order.id ?? null, instrumentId: order.instrumentId ?? null, conid: order.conid ?? null,
    runId: run?.id ?? null, sessionId, capturedAt: null, brokerPositionQuantity: null, ownedFillNet: null, legs: [] };
  const refuse = (reason: string) => { report.reasons.push(reason); return report; };
  if (!nonempty(accountId) || !nonempty(sessionId) || !Number.isFinite(nowMs)) return refuse("current_identity_missing");
  if (!order.instrumentId || !order.conid || order.executionAccountId !== accountId || !Number.isFinite(stamp(order.executionAttemptedAt)))
    return refuse("proposal_execution_identity_invalid");
  if (stamp(order.executionAttemptedAt) > nowMs) return refuse("proposal_attempt_in_future");
  const identity = validatePersistedOrderIdentity(order, evidence.clientOrderHash);
  if (!identity.ok) return refuse(`proposal_${identity.reason}`);
  if (!bound || bound.instrumentId !== order.instrumentId || String(bound.conId) !== order.conid ||
    bound.brokerSymbol !== order.instrument || !bound.instrument.trading.executionEnabled ||
    bound.instrument.assetClass !== "stock" || bound.currency !== "USD" || bound.instrument.currency !== "USD")
    return refuse("binding_mismatch");
  const policy = bound.instrument.executionPolicy;
  if (!policy || policy.strategyId !== order.strategy || policy.expectedDirection !== "LONG" ||
    policy.defaultOrderType !== "LMT" || !policy.allowedOrderTypes.includes("LMT") || policy.bracketDisabled ||
    policy.quantityUnit !== "shares" || bound.instrument.risk.quantityUnit !== "shares" ||
    !nonnegative(policy.quantity) || order.quantity > policy.quantity ||
    !nonnegative(policy.maxQuantity) || order.quantity > policy.maxQuantity ||
    !nonnegative(bound.instrument.risk.maxQuantity) || order.quantity > bound.instrument.risk.maxQuantity)
    return refuse("policy_mismatch");
  if (order.side !== "BUY" || order.orderType !== "LMT" || order.quantity !== 1 ||
    (order.positionEffect !== undefined && order.positionEffect !== "OPEN_OR_ADD") || order.riskCheckStatus !== "PASS" ||
    !nonnegative(order.entry) || order.entry === 0 || !nonnegative(order.stop) || order.stop === 0 ||
    order.stop >= order.entry || !nonnegative(order.takeProfit) || order.takeProfit <= order.entry ||
    (order.partialTakeProfits?.length ?? 0) > 0 || order.trailingStopPct !== undefined || order.trailingStopActivationR !== undefined)
    return refuse("proposal_scope_invalid");
  const review = object(evidence.review);
  const decision = object(review?.decision_json);
  if (!review || Number(review.proposed_order_id) !== order.id || review.instrument_id !== order.instrumentId ||
    review.conid !== order.conid || review.client_order_hash !== evidence.clientOrderHash || review.account_id !== accountId ||
    !nonempty(review.session_id) || review.status !== "APPROVED" || !decision || decision.decision !== "EXECUTE" ||
    !nonempty(decision.reason) || !nonempty(decision.model) || !nonempty(decision.promptVersion) ||
    !nonnegative(decision.confidence) || decision.confidence > 1 ||
    !Number.isFinite(stamp(review.delivery_started_at)) || !Number.isFinite(stamp(review.decided_at)) ||
    stamp(review.decided_at) > stamp(review.delivery_started_at) ||
    stamp(review.delivery_started_at) > stamp(order.executionAttemptedAt) ||
    !Number.isFinite(stamp(review.expires_at)) || stamp(review.expires_at) <= stamp(order.executionAttemptedAt))
    return refuse("approval_invalid");
  if (evidence.activeHoldCount !== 0) return refuse("active_account_hold");
  if (evidence.competingProposalCount !== 0) return refuse("competing_proposal");
  if (!run || run.account_id !== accountId || run.session_id !== sessionId || !["CLEAN", "INCOMPLETE"].includes(run.status))
    return refuse("latest_run_unusable");
  const snapshot = object(run.broker_snapshot);
  if (!snapshot || snapshot.accountId !== accountId || snapshot.sessionId !== sessionId) return refuse("snapshot_identity_invalid");
  const started = stamp(run.started_at), captured = stamp(snapshot.capturedAt), completed = stamp(run.completed_at);
  if (![started, captured, completed].every(t => Number.isFinite(t) && t <= nowMs && nowMs - t < 10_000) ||
    started > captured || captured > completed || started < stamp(order.executionAttemptedAt)) return refuse("snapshot_time_invalid");
  report.capturedAt = new Date(captured).toISOString();
  const coverage = object(snapshot.sourceCoverage), persistedCoverage = object(run.source_coverage);
  const validCoverage = (cov: Record<string, unknown> | null) => {
    if (!cov) return false;
    for (const name of ["positions", "openOrders", "executions", "session"]) {
      const source = object(cov[name]);
      if (!source || source.available !== true || source.timedOut !== false || !nonnegative(source.count) || !Number.isInteger(source.count)) return false;
      if (name !== "executions" && source.boundedWindow !== true) return false;
    }
    const window = object(object(cov.executions)?.window);
    return !!window && window.exposureWindowComplete === true && Number.isFinite(stamp(window.from)) &&
      stamp(window.from) <= stamp(order.executionAttemptedAt) &&
      stamp(window.to) >= started && stamp(window.to) <= captured && stamp(window.from) <= stamp(window.to);
  };
  if (snapshot.exposureComplete !== true || !validCoverage(coverage) || !validCoverage(persistedCoverage)) return refuse("coverage_incomplete");
  for (const name of ["positions", "openOrders", "executions"] as const) {
    if (!Array.isArray(snapshot[name]) || snapshot[name].some(row => !object(row)) ||
      (name === "positions" ? (object(coverage?.[name])?.count as number) < snapshot[name].length
        : object(coverage?.[name])?.count !== snapshot[name].length) ||
      object(persistedCoverage?.[name])?.count !== object(coverage?.[name])?.count) return refuse("snapshot_rows_invalid");
  }
  if (links.length !== 3 || ["PARENT", "TP", "SL"].some(role => links.filter(link => link.role === role).length !== 1) ||
    links.some(link => Number(link.proposed_order_id) !== order.id || link.account_id !== accountId ||
      link.role_ordinal !== (link.role === "PARENT" ? 0 : 1) || !nonempty(link.broker_order_id) || !nonempty(link.order_ref) ||
      (link.perm_id !== null && !nonempty(link.perm_id))) ||
    new Set(links.map(link => link.broker_order_id)).size !== 3 || new Set(links.map(link => link.order_ref)).size !== 3 ||
    new Set(links.flatMap(link => link.perm_id ? [link.perm_id] : [])).size !== links.filter(link => link.perm_id).length)
    return refuse("durable_legs_invalid");
  report.legs = links.map(link => ({ role: link.role, brokerOrderId: link.broker_order_id!, orderRef: link.order_ref,
    observed: false, status: null, remaining: null, filledQuantity: 0 }));
  const rows = (name: "positions" | "openOrders" | "executions") => snapshot[name] as Record<string, unknown>[];
  const targetPositions: Record<string, unknown>[] = [];
  for (const row of rows("positions")) {
    if (!nonempty(row.accountId)) return refuse("position_account_missing");
    if (row.accountId !== accountId) continue;
    if (!nonempty(row.conId)) return refuse("position_contract_missing");
    if (row.conId === order.conid) targetPositions.push(row);
  }
  if (targetPositions.length > 1 || targetPositions.some(row => !nonnegative(row.position) || row.position > order.quantity))
    return refuse("position_ambiguous");
  report.brokerPositionQuantity = targetPositions.length ? targetPositions[0].position as number : 0;
  const hasIdentity = (row: Record<string, unknown>) => links.some(link => row.brokerOrderId === link.broker_order_id ||
    row.orderRef === link.order_ref || (link.perm_id !== null && row.permId === link.perm_id));
  const correlate = (row: Record<string, unknown>) => links.findIndex(link => row.brokerOrderId === link.broker_order_id &&
    row.orderRef === link.order_ref && (link.perm_id === null || row.permId === link.perm_id));
  const executions = new Map<string, string>();
  const observedPermIds = new Map<string, number>();
  const observedLegPermIds = new Map<number, string>();
  for (const source of ["openOrders", "executions"] as const) {
    for (const row of rows(source)) {
      if (!nonempty(row.accountId)) return refuse(`${source}_account_missing`);
      if (row.accountId !== accountId) continue;
      if (!nonempty(row.conId)) return refuse(`${source}_contract_missing`);
      if (row.conId !== order.conid) {
        if (hasIdentity(row)) return refuse(`${source}_contract_mismatch`);
        continue;
      }
      const legIndex = correlate(row);
      if (legIndex < 0) return refuse(`${source}_uncorrelated`);
      if (nonempty(row.permId)) {
        const savedOwner = links.findIndex(link => link.perm_id === row.permId);
        const observedOwner = observedPermIds.get(row.permId);
        const previousPerm = observedLegPermIds.get(legIndex);
        if ((savedOwner >= 0 && savedOwner !== legIndex) ||
          (observedOwner !== undefined && observedOwner !== legIndex) ||
          (previousPerm !== undefined && previousPerm !== row.permId)) return refuse("broker_identity_conflict");
        observedPermIds.set(row.permId, legIndex);
        observedLegPermIds.set(legIndex, row.permId);
      }
      const leg = report.legs[legIndex];
      if (source === "openOrders") {
        if (leg.observed) return refuse("duplicate_open_order");
        if (row.action !== (leg.role === "PARENT" ? "BUY" : "SELL")) return refuse("open_order_action_invalid");
        if (!nonnegative(row.remaining) || row.remaining > order.quantity ||
          !nonnegative(row.filled) || row.filled > order.quantity || row.remaining + row.filled > order.quantity)
          return refuse("open_order_quantity_invalid");
        leg.observed = true; leg.status = typeof row.status === "string" ? row.status : null; leg.remaining = row.remaining;
        if (!active(row.status)) return refuse("open_order_not_active");
      } else {
        const expectedSides = leg.role === "PARENT" ? ["BUY", "BOT"] : ["SELL", "SLD"];
        // IB executions carry seconds, whereas the durable attempt has milliseconds.
        const executed = stamp(row.executedAt);
        const window = object(object(coverage!.executions)?.window)!;
        if (!nonempty(row.execId) || !nonnegative(row.shares) || row.shares === 0 || !expectedSides.includes(String(row.side)) ||
          !Number.isFinite(executed) || executed < Math.floor(stamp(order.executionAttemptedAt) / 1000) * 1000 || executed > stamp(window.to))
          return refuse("execution_invalid");
        const fingerprint = JSON.stringify([row.brokerOrderId, row.orderRef, row.permId ?? null, row.accountId, row.conId,
          row.side, row.shares, row.price ?? null, executed]);
        if (executions.has(row.execId)) {
          if (executions.get(row.execId) !== fingerprint) return refuse("conflicting_execution_id");
          continue;
        }
        executions.set(row.execId, fingerprint);
        leg.filledQuantity += row.shares;
      }
    }
  }
  const parent = report.legs.find(leg => leg.role === "PARENT")!;
  const children = report.legs.filter(leg => leg.role !== "PARENT");
  const exits = children.reduce((sum, leg) => sum + leg.filledQuantity, 0);
  if (parent.filledQuantity > order.quantity || exits > parent.filledQuantity) return refuse("fills_exceed_owned_quantity");
  const net = parent.filledQuantity - exits;
  report.ownedFillNet = net;
  if (Math.abs(net - report.brokerPositionQuantity) > 1e-9) return refuse("position_fill_mismatch");
  if (net > 0) {
    if (children.some(leg => !leg.observed || leg.remaining === null || leg.remaining < net)) return refuse("protection_missing");
    report.status = "OWNED_POSITION";
  } else if (parent.filledQuantity === 0 && parent.observed) {
    if (parent.remaining !== order.quantity) return refuse("pending_parent_quantity_invalid");
    report.status = "PENDING_ENTRY";
  } else {
    if (report.legs.some(leg => leg.observed)) return refuse("orphan_open_order");
    report.status = "FLAT_OBSERVED";
  }
  return report;
}
