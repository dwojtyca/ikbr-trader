import { EMPTY_DIAGNOSTIC_IDENTITY, type DiagnosticEvent, type DiagnosticField, type DiagnosticSeverity } from '@ikbr/shared/diagnostics';
import { describeDiagnosticReason } from '@ikbr/shared/diagnostics';

export interface StoredDiagnosticRow {
  source: string; id: string; occurred_at: Date | string; recorded_at: Date | string;
  code: string; reason: string; severity: DiagnosticSeverity;
  instrument_id?: string | null; conid?: string | null; symbol?: string | null;
  listing?: string | null; implementation_id?: string | null; instance_id?: string | null;
  revision?: number | null; config_hash?: string | null; evaluation_id?: string | null;
  trace_id?: string | null; proposal_id?: string | null; broker_order_id?: string | null;
  lifecycle_id?: string | null; close_id?: string | null; research_snapshot_id?: string | null;
  audit_ref?: string | null; fields?: DiagnosticField[];
}
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function projectDiagnosticEvent(row: StoredDiagnosticRow): DiagnosticEvent {
  const explanation = describeDiagnosticReason(row.reason);
  const revision=typeof row.revision==='number'?row.revision:
    typeof row.revision==='string'&&/^\d+$/.test(row.revision)?Number(row.revision):null;
  return {
    ...EMPTY_DIAGNOSTIC_IDENTITY,
    schemaVersion: 1,
    id: `${row.source}:${row.id}`,
    code: row.code,
    severity: row.severity,
    service: row.source==='diagnostic_evaluations'?'signal-engine':row.source==='proposal_ai_reviews'?'llm-agent':'execution-engine',
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
    reason: row.reason,
    ...explanation,
    instrumentId: row.instrument_id ?? null,
    conId: row.conid ?? null,
    symbol: row.symbol ?? null,
    listing: row.listing ?? null,
    implementationId: row.implementation_id ?? null,
    instanceId: row.instance_id ?? null,
    revision: revision!==null&&Number.isSafeInteger(revision)?revision:null,
    configHash: row.config_hash ?? null,
    evaluationId: row.evaluation_id ?? null,
    traceId: row.trace_id ?? null,
    proposalId: row.proposal_id ?? null,
    brokerOrderId: row.broker_order_id ?? null,
    lifecycleId: row.lifecycle_id ?? null,
    closeId: row.close_id ?? null,
    researchSnapshotId: row.research_snapshot_id ?? null,
    auditRef: row.audit_ref ?? null,
    fields: row.fields ?? [],
  };
}
