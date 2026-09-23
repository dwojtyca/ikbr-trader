import { evaluateLifecycleFacts, evaluateLifecycleOwnership } from "./ownership.js";
import type { CloseEvaluator, CloseLegIdentity } from "./close-types.js";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const time = (value: unknown): number => value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
const positiveId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

export const evaluateCloseEvidence: CloseEvaluator = (evidence, context, options) => {
  const facts = options.mode === "initial" ? evaluateLifecycleOwnership(evidence, context)
    : evaluateLifecycleFacts(evidence, context, { requireProtection: false, closeLink: options.closeLink });
  const result = { ok: false, reasons: [...facts.reasons], quantity: null as 0 | 1 | null,
    canComplete: false, allTerminal: false, closeWorking: false, residualQuantity: facts.ownedFillNet, legs: [] as CloseLegIdentity[], barrierAt: options.barrierAt };
  const fail = (reason: string) => { result.reasons.push(reason); return result; };
  if (facts.status === "BLOCKED") return result;
  if (!Number.isSafeInteger(context.clientId) || context.clientId < 0 || !Number.isSafeInteger(context.generation) || context.generation < 1)
    return fail("close_connection_identity_missing");
  const sync = evidence.positionSnapshot;
  if (!sync || sync.accountId !== context.accountId || sync.sessionId !== context.sessionId || !sync.complete ||
    !Number.isSafeInteger(sync.generation) || sync.generation < 1 || sync.generation !== evidence.run?.position_generation ||
    !Number.isFinite(time(sync.observedAt)) || time(sync.observedAt) > context.nowMs || context.nowMs - time(sync.observedAt) >= 10_000 ||
    time(sync.observedAt) > time(evidence.run.started_at)) return fail("close_position_generation_unusable");
  if (sync.positions.some(row => row.accountId !== context.accountId || row.sessionId !== context.sessionId || !row.conid ||
    !Number.isFinite(row.quantity) || !Number.isFinite(time(row.observedAt)) || time(row.observedAt) !== time(sync.observedAt)))
    return fail("close_position_rows_invalid");
  const positions = sync.positions.filter(row => row.conid === evidence.order.conid);
  if (positions.length > 1 || (positions[0]?.quantity ?? 0) !== facts.ownedFillNet) return fail("close_position_snapshot_mismatch");
  if (facts.ownedFillNet !== 0 && facts.ownedFillNet !== 1) {
    if (options.mode !== "reconcile" || !options.closeLink) return fail("close_fractional_position_unsupported");
  } else result.quantity = facts.ownedFillNet;
  const snapshot = record(evidence.run?.broker_snapshot)!;
  const open = snapshot.openOrders as Record<string, unknown>[];
  const executions = snapshot.executions as Record<string, unknown>[];
  const originalGeneration = options.originalGeneration ?? context.generation;
  const originalSession = options.originalSessionId ?? context.sessionId;
  if (options.mode !== "reconcile" && (originalGeneration !== context.generation || originalSession !== context.sessionId))
    return fail("close_connection_changed");
  const seenTerminals = new Set<string>();
  for (const terminal of options.terminals) {
    const link = evidence.links.find(leg => leg.role === terminal.role);
    if (!link || seenTerminals.has(terminal.role) || terminal.accountId !== context.accountId || terminal.conid !== evidence.order.conid ||
      terminal.brokerOrderId !== link.broker_order_id || terminal.orderRef !== link.order_ref || !positiveId(terminal.permId) ||
      (link.perm_id !== null && link.perm_id !== terminal.permId) || terminal.clientId !== context.clientId ||
      terminal.generation !== originalGeneration || terminal.sessionId !== originalSession || terminal.status !== "CANCELLED" ||
      !Number.isFinite(time(terminal.confirmedAt)) || time(terminal.confirmedAt) > context.nowMs ||
      time(terminal.confirmedAt) < time(evidence.order.executionAttemptedAt)) return fail("close_terminal_identity_invalid");
    seenTerminals.add(terminal.role);
  }
  for (const link of evidence.links) {
    const fact = facts.legs.find(leg => leg.role === link.role)!;
    const row = open.find(item => item.accountId === context.accountId && item.conId === evidence.order.conid &&
      item.brokerOrderId === link.broker_order_id && item.orderRef === link.order_ref);
    const terminal = options.terminals.find(item => item.role === link.role);
    const fill = executions.find(item => item.accountId === context.accountId && item.conId === evidence.order.conid &&
      item.brokerOrderId === link.broker_order_id && item.orderRef === link.order_ref);
    const permId = row?.permId ?? link.perm_id ?? terminal?.permId ?? fill?.permId ?? null;
    if (fact.observed && (!row || row.clientId !== context.clientId || !positiveId(row.permId)))
      return fail("close_working_leg_client_or_perm_missing");
    if (terminal && fact.observed) return fail("close_cancelled_leg_still_working");
    if (terminal && permId !== terminal.permId) return fail("close_terminal_perm_changed");
    result.legs.push({ role: link.role as CloseLegIdentity["role"], brokerOrderId: link.broker_order_id!, orderRef: link.order_ref,
      permId: typeof permId === "string" ? permId : null, accountId: context.accountId, conid: evidence.order.conid!,
      clientId: context.clientId, working: fact.observed, fullyFilled: fact.filledQuantity === 1, observedAt: facts.capturedAt! });
  }
  result.allTerminal = result.legs.every(leg => !leg.working && (leg.fullyFilled || seenTerminals.has(leg.role)));
  const parent = result.legs.find(leg => leg.role === "PARENT")!;
  const close = facts.legs.find(leg => leg.role === "CLOSE");
  result.closeWorking = close?.observed ?? false;
  // An absent possibly submitted close can still arrive: require its positive full-fill proof.
  const closeTerminal = !options.closeLink || close?.filledQuantity === 1;
  const noWorking = facts.legs.every(leg => !leg.observed);
  result.canComplete = facts.ownedFillNet === 0 && noWorking && !parent.working &&
    (parent.fullyFilled || seenTerminals.has("PARENT")) && closeTerminal;
  if (options.barrierAt !== null) {
    const barrier = time(options.barrierAt);
    if (!Number.isFinite(barrier) || barrier > context.nowMs || time(evidence.run?.started_at) <= barrier ||
      options.terminals.some(terminal => time(terminal.confirmedAt) > barrier)) return fail("close_snapshot_before_terminal_barrier");
  } else if (options.terminals.length > 0 || options.mode === "after_cancel") {
    return fail("close_terminal_barrier_missing");
  }
  if (options.mode === "after_cancel" && !result.canComplete && (!result.allTerminal || !noWorking))
    return fail("close_original_legs_not_terminal");
  if (facts.ownedFillNet === 0 && !parent.working && !parent.fullyFilled && !seenTerminals.has("PARENT") && !options.closeLink)
    return fail("close_flat_parent_unconfirmed");
  result.ok = true;
  return result;
};
