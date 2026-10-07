import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BrokerReconciliationSnapshot } from "../reconciliation/broker-adapter.js";

export type AccountingLane = "accounting" | "execution";
export interface SourceSettingsV1 {
  schemaVersion: 1; sourceKind: "ibkr-tws-seven-day-v1"; environment: "paper";
  accountId: string; endpoint: { host: string; port: number }; sourceClientId: 0;
  executionTimeZone: "UTC" | "Europe/Warsaw";
}
export interface OperatorQualificationV1 {
  schemaVersion: 1; sourceKind: "ibkr-tws-seven-day-v1"; settingsSha256: string;
  inspectionId: string; operator: string; observedAt: string; product: "TWS";
  productVersion: string; productBuild: string; tradeLogDays: 7; masterClientId: 0;
  executionTimeZone: "UTC" | "Europe/Warsaw";
  confirmations: { exactEndpointAndAccount: true; evidenceBelongsToCurrentHostSession: true;
    noSettingsChangeSinceEvidence: true; pauseAndRequalifyBeforeSettingsChange: true };
  artifacts: Array<{ kind: "tws-product-build" | "tws-trade-log-seven-days" | "tws-master-client-zero" | "execution-timezone";
    relativePath: string; sha256: string; observedAt: string }>;
}
export interface CanonicalExecution {
  execId: string; accountId: string; brokerOrderId: string; conId: string; symbol: string;
  secType: string; currency: string; exchange: string; side: "BUY" | "SELL";
  shares: number; price: number; executedAt: string; pendingPriceRevision?: boolean;
  permId?: string; orderRef?: string; clientId?: number;
}
export interface CanonicalCommission { execId: string; commission: number | null; currency: string; realizedPnL: number | null }
export interface LaneBarrier { received: number; persisted: number; pending: number }
export interface AccountingBarrier {
  sourceId: string; sourceProcessSessionId: string; sourceConnectionGeneration: number;
  executionSessionId: string; executionConnectionGeneration: number; semanticRevision: number;
  lanes: Record<AccountingLane, LaneBarrier>;
}
export interface AccountingCaptureReference {
  captureId: string; qualificationId: string; connectionReceiptId: string; barrier: AccountingBarrier;
  reconciliationRunId: number; positionGeneration: number; accountDate: string;
  periodStart: string; certifiedFrom: string; coveredThrough: string; capturedAt: string; fingerprint: string;
}
export interface AccountingCapture extends AccountingCaptureReference {
  accountId: string; executions: CanonicalExecution[]; commissions: CanonicalCommission[];
  observationIds: string[]; replayId: number; replayEndId: string;
}
export interface SourceInspection {
  id: string; sourceId: string; processSessionId: string; connectionGeneration: number;
  protocolVersion: number; accounts: string[]; brokerTime: string; completedAt: string;
  executionIds: string[]; observationIds: string[]; replayId: number; replayEndId: string;
  corroboration: "OBSERVED" | "NOT_OBSERVED";
}
export interface ClockRecoveryEvidence {
  id: string; inspection: SourceInspection; barrier: AccountingBarrier;
  accountId: string; settingsHash: string; gapEpoch: number;
  executions: CanonicalExecution[]; commissions: CanonicalCommission[]; observationIds: string[];
}
export interface ClockRecoveryReceipt {
  id: string; inspectionId: string; sourceId: string; connectionGeneration: number;
  recoveredAt: string; qualificationId: string | null; gap: true; brokerReadOnly: true;
}
export interface StoredQualification {
  id: string; input: OperatorQualificationV1; settings: SourceSettingsV1;
  protocolVersion: number; expiresAt: string; inspectionId: string;
}
export interface AccountingAuthority {
  assertCurrent(reference?: AccountingCaptureReference): void;
  readCapture(db: Pick<Pool | PoolClient, "query">, reference: AccountingCaptureReference, lock?: boolean): Promise<AccountingCapture>;
}
export interface AccountingJoin {
  join(snapshot: BrokerReconciliationSnapshot, input: { runId: number; positionGeneration: number; recoveryStart: Date;
    timeoutMs: number; abortSignal: AbortSignal }): Promise<BrokerReconciliationSnapshot>;
}
export function accountingHash(value: unknown): string {
  const canonical = (v: unknown): unknown => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export const accountingError = (code: string): Error => new Error(code.startsWith("ACCOUNTING_") ? code : `ACCOUNTING_${code}`);
export const accountingNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e100;

export function accountingReference(c: AccountingCaptureReference): AccountingCaptureReference {
  return { captureId: c.captureId, qualificationId: c.qualificationId, connectionReceiptId: c.connectionReceiptId,
    barrier: structuredClone(c.barrier), reconciliationRunId: c.reconciliationRunId, positionGeneration: c.positionGeneration,
    accountDate: c.accountDate, periodStart: c.periodStart, certifiedFrom: c.certifiedFrom, coveredThrough: c.coveredThrough,
    capturedAt: c.capturedAt, fingerprint: c.fingerprint };
}
