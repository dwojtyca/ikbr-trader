import type { ResearchIdentity, ResearchSourceError } from './types.js';

export interface MarketauxAttemptIdentity extends ResearchIdentity { accountId: string; instrumentId: string; sourceId: string }
export interface MarketauxAttemptTicket extends MarketauxAttemptIdentity {
  attemptId: string; sourceHash: string; slot: number; startedAt: string; deadlineAt: string;
  windowStart: string; asOf: string; monotonicDeadlineMs: number;
}
export type MarketauxAttemptClaim = { claimed: true; ticket: MarketauxAttemptTicket }
  | { claimed: false; reason: string; nextCheckAt: string | null };
export interface MarketauxRefreshState {
  recovery?: import("./startup-recovery.js").ResearchRecoveryDiagnostic;
  sourceId: string; lastSuccessfulAt: string | null; expiresAt: string | null;
  nextRegularAt: string | null; activeAttemptId: string | null; holdReasons: string[];
  latestFailure: { attemptId: string; recordedAt: string; reason: string; sourceError?: ResearchSourceError;
    retainedSnapshotId: string | null; retainedProjectionHash: string | null } | null;
}
export interface MarketauxAttemptFailure { reason: string; sourceError?: ResearchSourceError; outcome: 'FAILED' | 'UNKNOWN' }
