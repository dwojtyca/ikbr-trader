import type { LifecycleContext, LifecycleEvidence, LifecycleLegLink } from './ownership.js';
import type { RoundTripReport } from './round-trip-evidence.js';

export interface LifecycleCycle {
  proposalId: number; links: LifecycleLegLink[];
  terminalProof: { status: string; report: RoundTripReport; links: LifecycleLegLink[]; executionIds: string[] } | null;
  terminalFingerprint: string | null; currentFingerprint: string;
}
const time = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
export function matchesCycleLink(row: Record<string, unknown>, link: LifecycleLegLink): boolean {
  return row.accountId === link.account_id && row.brokerOrderId === link.broker_order_id && row.orderRef === link.order_ref &&
    (link.perm_id === null || row.permId === link.perm_id);
}
export function cycleForRow(row: Record<string, unknown>, cycles: readonly LifecycleCycle[]): LifecycleCycle | undefined {
  const partial = cycles.flatMap(cycle => cycle.links.filter(link => row.accountId === link.account_id &&
    (row.brokerOrderId === link.broker_order_id || row.orderRef === link.order_ref || (link.perm_id !== null && row.permId === link.perm_id))).map(link => ({ cycle, link })));
  return partial.length === 1 && matchesCycleLink(row, partial[0].link) ? partial[0].cycle : undefined;
}

export function terminalCycleFailure(cycle: LifecycleCycle, evidence: LifecycleEvidence, context: LifecycleContext): string | null {
  const proof = cycle.terminalProof, report = proof?.report;
  if (!proof || !report || !['FLAT','TERMINAL_UNFILLED'].includes(proof.status) || !Array.isArray(proof.executionIds) || !Array.isArray(proof.links) || !Array.isArray(report.fills) ||
    !cycle.terminalFingerprint || cycle.currentFingerprint !== cycle.terminalFingerprint ||
    report.proposalId !== cycle.proposalId || report.accountId !== context.accountId || report.conid !== evidence.order.conid ||
    (proof.status === 'FLAT' && (report.status !== 'COMPLETED' || report.accounting !== 'COMPLETE')) ||
    (proof.status === 'TERMINAL_UNFILLED' && (report.status !== 'NOT_PROVEN' || report.fills.length !== 0))) return 'terminal_proof_changed';
  const snapshot = evidence.run?.broker_snapshot as { accountId?: string; sessionId?: string; capturedAt?: string; exposureComplete?: boolean; positions?: Record<string,unknown>[]; sourceCoverage?: Record<string,any>; openOrders?: Record<string,unknown>[]; executions?: Record<string,unknown>[] } | undefined;
  if (!snapshot || snapshot.accountId !== context.accountId || snapshot.sessionId !== context.sessionId || !snapshot.exposureComplete || evidence.activeHoldCount !== 0 ||
    evidence.run?.status !== 'CLEAN' || !Number.isFinite(time(snapshot.capturedAt)) || time(snapshot.capturedAt) > context.nowMs || context.nowMs-time(snapshot.capturedAt)>=10000 ||
    !Array.isArray(snapshot.positions) || !Array.isArray(snapshot.openOrders) || !Array.isArray(snapshot.executions)) return 'terminal_current_reconciliation_unavailable';
  const coverage = snapshot.sourceCoverage, persisted = evidence.run?.source_coverage as Record<string,any> | undefined;
  for (const name of ['positions','openOrders','executions','session']) {
    const c=coverage?.[name], p=persisted?.[name];
    if (!c || !p || c.available !== true || p.available !== true || c.timedOut !== false || p.timedOut !== false || !Number.isSafeInteger(c.count) || c.count<0 || p.count!==c.count || (name !== 'executions' && (c.boundedWindow !== true || p.boundedWindow !== true))) return 'terminal_current_coverage_invalid';
    if (name==='executions' && (!c.window?.exposureWindowComplete || !p.window?.exposureWindowComplete || !Number.isFinite(time(c.window.to)) || time(c.window.to)>time(snapshot.capturedAt) || time(c.window.to)<time(evidence.run?.started_at))) return 'terminal_current_coverage_invalid';
  }
  if (coverage!.openOrders.count!==snapshot.openOrders.length || coverage!.executions.count!==snapshot.executions.length || coverage!.positions.count<snapshot.positions.length) return 'terminal_current_coverage_invalid';
  for (const row of snapshot.positions) {
    if (typeof row.accountId!=='string' || !row.accountId || (row.accountId===context.accountId && (typeof row.conId!=='string'||!row.conId))) return 'terminal_uncorrelated_contract_evidence';
    if (row.accountId===context.accountId && row.conId===evidence.order.conid && row.position!==0 && !(evidence.cycles??[]).some(c=>!c.terminalProof && snapshot.executions!.some(e=>cycleForRow(e,evidence.cycles??[])===c))) return 'terminal_unowned_position';
  }
  for (const [source, rows] of [['openOrders',snapshot.openOrders],['executions',snapshot.executions]] as const) for (const row of rows) {
    if (typeof row.accountId!=='string' || !row.accountId || (row.accountId===context.accountId && (typeof row.conId!=='string'||!row.conId))) return 'terminal_uncorrelated_contract_evidence';
    if (row.accountId !== context.accountId) continue;
    if (row.conId !== evidence.order.conid) { if(cycleForRow(row,evidence.cycles??[])) return 'terminal_identity_contract_changed'; continue; }
    const owner = cycleForRow(row, evidence.cycles ?? []);
    if (!owner) return 'terminal_uncorrelated_contract_evidence';
    if (owner.proposalId !== cycle.proposalId) continue;
    if (source === 'openOrders' || typeof row.execId !== 'string' || !proof.executionIds.includes(row.execId)) return 'terminal_proof_contradicted';
    const fill = report.fills.find(f => f.execId === row.execId);
    const link = cycle.links.find(l => matchesCycleLink(row,l));
    if (!fill || !link || row.secType !== 'STK' || row.currency !== fill.currency || row.shares !== fill.quantity || row.price !== fill.price ||
      time(row.executedAt) !== time(fill.executedAt) || ![fill.role === 'PARENT' ? 'BUY' : 'SELL', fill.role === 'PARENT' ? 'BOT' : 'SLD'].includes(String(row.side))) return 'terminal_execution_changed';
  }
  return null;
}

export function isPriorTerminalExecution(row: Record<string, unknown>, evidence: LifecycleEvidence): boolean {
  const owner = cycleForRow(row, evidence.cycles ?? []);
  return !!owner && owner.proposalId !== evidence.order.id && !!owner.terminalProof && owner.currentFingerprint === owner.terminalFingerprint &&
    typeof row.execId === 'string' && owner.terminalProof.executionIds.includes(row.execId);
}
