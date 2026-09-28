import { isDeepStrictEqual } from 'node:util';
import type { LifecycleContext } from './lifecycle/ownership.js';
import { evaluateRoundTrip, type RoundTripEvidence } from './lifecycle/round-trip-evidence.js';
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

export function isProvenUnfilledPaperEntry(evidence: RoundTripEvidence, context: LifecycleContext): boolean {
  const report = evaluateRoundTrip(evidence, context);
  if (report.status !== 'NOT_PROVEN' || report.reasons.length !== 1 || report.reasons[0] !== 'one_share_round_trip_not_proven' ||
      evidence.fills.length !== 0 || report.fills.length !== 0 || evidence.close !== null || !context.bound) return false;
  const snapshot = object(evidence.lifecycle.run?.broker_snapshot), coverage = object(snapshot?.sourceCoverage);
  const completed = object(coverage?.completedOrders), rows = snapshot?.completedOrders;
  if (!snapshot || !coverage || !isDeepStrictEqual(coverage, evidence.lifecycle.run?.source_coverage) ||
      completed?.available !== true || completed.boundedWindow !== true || completed.timedOut !== false ||
      !Array.isArray(rows) || completed.count !== rows.length) return false;
  const own = rows.map(object).filter(row => row?.accountId === context.accountId && row.conId === evidence.lifecycle.order.conid);
  if (own.length !== 3) return false;
  return evidence.lifecycle.links.every(link => {
    const matches = own.filter(row => row?.brokerOrderId === link.broker_order_id && row.orderRef === link.order_ref);
    if (matches.length !== 1) return false;
    const row = matches[0]!;
    const status = typeof row.terminalStatus === 'string' ? row.terminalStatus.toUpperCase().replaceAll('_', '') : '';
    const observed = row.observedAt instanceof Date ? row.observedAt.getTime() : Date.parse(String(row.observedAt));
    return ['CANCELLED', 'APICANCELLED', 'REJECTED'].includes(status) && row.filled === 0 &&
      (row.remaining === 0 || row.remaining === 1) && row.secType === 'STK' && row.currency === context.bound!.currency &&
      row.action === (link.role === 'PARENT' ? 'BUY' : 'SELL') &&
      (link.perm_id === null || row.permId === link.perm_id) && Number.isFinite(observed) && observed <= context.nowMs &&
      observed >= new Date(evidence.lifecycle.order.executionAttemptedAt!).getTime();
  });
}
