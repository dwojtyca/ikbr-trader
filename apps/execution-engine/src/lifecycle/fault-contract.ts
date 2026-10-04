export type LifecycleFaultCode =
  | "PROTECTION_GAP" | "PROTECTION_UNKNOWN" | "FOREIGN_ORDER_CONFLICT"
  | "ORPHAN_OWNERSHIP" | "BROKER_UNAVAILABLE" | "BROKER_STATE_STALE"
  | "CALENDAR_UNAVAILABLE" | "CANCEL_UNKNOWN" | "SUBMISSION_UNKNOWN"
  | "CLOSE_UNFILLED" | "CLOSE_BLOCKED" | "EXIT_DEADLINE_MISSED"
  | "MANAGEMENT_DISABLED" | "SUPERVISOR_FAILURE" | "DATABASE_UNAVAILABLE"
  | "HISTORICAL_EVIDENCE_CHANGED" | "EXIT_POLICY_UNAVAILABLE";

export interface LifecycleFaultInput {
  accountId: string;
  proposalId: number | null;
  code: LifecycleFaultCode;
  evidence: Record<string, unknown>;
}

export interface LifecycleFaultSink {
  recordFault(input: LifecycleFaultInput): Promise<void>;
  resolveScope(accountId: string, proposalId: number | null, activeCodes: readonly LifecycleFaultCode[]): Promise<void>;
}
