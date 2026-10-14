import type { InstrumentResearchSnapshotV2, ResearchIdentity, ResearchProviderError, ResearchSourceError } from './types.js';
import type { WshAcquisition } from './wsh.js';

export type WshAttemptKind = 'regular' | 'retry';
export type WshCleanupState = 'CONFIRMED' | 'UNKNOWN' | 'NOT_NEEDED';
export type WshFailureClass = 'TRANSIENT' | 'HARD' | 'UNCERTAIN' | 'BUSY' | 'ABORTED' | 'BUDGET';
export type WshFailureStage = 'connect' | 'metadata' | 'events' | 'normalize' | 'publish' | 'cleanup';
export interface WshAttemptIdentity extends ResearchIdentity { accountId: string; instrumentId: string; sourceId: string }
export interface WshAttemptTicket extends WshAttemptIdentity {
  id: string; cycleId: string; ordinal: 0 | 1 | 2; endpointId: string; sessionId: string;
  startedAt: string; deadlineAt: string; nextRegularAt: string;
}
export type WshAttemptClaim = { state: 'CLAIMED'; ticket: WshAttemptTicket }
  | { state: 'DEFERRED'; reason: string; nextCheckAt: string | null };
export interface WshCleanupResult {
  sessionId: string; state: WshCleanupState; verifiedLocalClosure: boolean; completedAt: string;
  cancellationAttemptedAt: string | null; disconnectRequestedAt: string | null; localClosedAt: string | null;
  sourceError?: ResearchSourceError;
}
export interface WshAttemptFailure {
  failureClass: WshFailureClass; failureReason: string; stage: WshFailureStage;
  sourceError?: ResearchSourceError; providerError?: ResearchProviderError;
}
export type WshAttemptResult = {
  cleanup: WshCleanupResult; acquisition?: WshAcquisition; slotKey?: string;
} & ({ outcome: 'SUCCEEDED' } | ({ outcome: 'FAILED' | 'UNKNOWN'; acquisitionOutcome?: 'FAILED' | 'UNKNOWN'; snapshot: InstrumentResearchSnapshotV2 } & WshAttemptFailure));
export interface WshAttemptDiagnostic {
  id: string; cycleId: string; ordinal: 0 | 1 | 2; state: 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  terminalResultHash: string | null;
  startedAt: string; finishedAt: string | null; cleanup: WshCleanupState;
  failureClass: WshFailureClass | null; failureReason: string | null; stage: WshFailureStage | null;
  sourceError?: ResearchSourceError; providerError?: ResearchProviderError;
}
export interface WshRefreshState {
  sourceId: string; lastSuccessfulAt: string | null; expiresAt: string | null; retained: boolean;
  latestAttempt: WshAttemptDiagnostic | null; latestFailure: WshAttemptDiagnostic | null;
  nextRetryAt: string | null; nextRegularAt: string | null; blocksCachedEvidence: boolean;
  acquisitionBlockedReason?: 'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED';
}
export interface WshDueAttempt { identity: WshAttemptIdentity; kind: WshAttemptKind; dueAt: string }
export const WSH_REGULAR_MS = 900_000;
export const WSH_ATTEMPT_MS = 35_000;
export const WSH_RETRY_DELAYS_MS = [30_000, 120_000] as const;
