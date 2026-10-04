export type DiagnosticSeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
export type DiagnosticMode = 'events' | 'status' | 'timeline' | 'session';
export type DiagnosticScalar = string | number | boolean | null;
export interface DiagnosticField {
  key: string; label: string; value: DiagnosticScalar;
  sensitivity?: 'identifier' | 'financial' | 'untrusted';
}
export interface DiagnosticIdentity {
  instrumentId: string | null; conId: string | null; symbol: string | null; listing: string | null;
  implementationId: string | null; instanceId: string | null; revision: number | null;
  configHash: string | null; evaluationId: string | null; traceId: string | null;
  proposalId: string | null; brokerOrderId: string | null; lifecycleId: string | null;
  closeId: string | null; researchSnapshotId: string | null;
}
export interface DiagnosticEvent extends DiagnosticIdentity {
  schemaVersion: 1; id: string; code: string; severity: DiagnosticSeverity; service: string;
  occurredAt: string; recordedAt: string; reason: string;
  message: string; impact: string; action: string; auditRef: string | null;
  fields: DiagnosticField[];
}
export interface DiagnosticCoverage {
  source: string; status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  observedAt: string | null; earliestAvailableAt: string | null; reasons: string[];
}
export interface DiagnosticSection {
  id: string; title: string; instrumentId: string | null; fields: DiagnosticField[];
}
export interface DiagnosticCounter { key: string; label: string; value: number | null; }
export interface DiagnosticReport {
  schemaVersion: 1; mode: DiagnosticMode; generatedAt: string;
  interval: { from: string; to: string };
  coverage: DiagnosticCoverage[]; events: DiagnosticEvent[]; sections: DiagnosticSection[];
  counters: DiagnosticCounter[]; truncated: boolean; omissions: string[];
}
export interface DiagnosticQuery {
  mode: DiagnosticMode; from: string; to: string; limit: number;
  instrumentId?: string; reason?: string; severity?: DiagnosticSeverity;
  proposalId?: string; evaluationId?: string;
}
export const EMPTY_DIAGNOSTIC_IDENTITY: DiagnosticIdentity = {
  instrumentId:null,conId:null,symbol:null,listing:null,implementationId:null,instanceId:null,
  revision:null,configHash:null,evaluationId:null,traceId:null,proposalId:null,brokerOrderId:null,
  lifecycleId:null,closeId:null,researchSnapshotId:null,
};
export const DIAGNOSTIC_LIMITS = Object.freeze({ maxDays:31, defaultLimit:200, maxEvents:1000,
  maxResponseBytes:2*1024*1024, maxExportBytes:1024*1024, retentionDays:30, retentionRows:100000 });
