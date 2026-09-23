import type { BoundInstrument, SignalTicket } from "@ikbr/shared";
import type { LifecycleEvidence, LifecycleLegLink } from "./ownership.js";
import type { PlanPersistenceInput } from "../repository.js";

export interface CloseContext { accountId: string; sessionId: string; clientId: number; generation: number; nowMs: number; bound: BoundInstrument | null }
export interface CloseLegIdentity { role: "PARENT" | "TP" | "SL"; brokerOrderId: string; orderRef: string; permId: string | null; accountId: string; conid: string; clientId: number; working: boolean; fullyFilled: boolean; observedAt: string }
export interface CloseTerminalEvidence extends Omit<CloseLegIdentity, "working" | "fullyFilled" | "observedAt"> { confirmedAt: string; status: "CANCELLED"; generation: number; sessionId: string }
export interface CloseEvidenceOptions { mode: "initial" | "cancelling" | "after_cancel" | "reconcile"; terminals: CloseTerminalEvidence[]; closeLink: LifecycleLegLink | null; barrierAt: string | null; originalGeneration?: number; originalSessionId?: string }
export interface CloseEvidenceReport { closeWorking: boolean; residualQuantity: number | null; allTerminal: boolean; ok: boolean; reasons: string[]; quantity: 0 | 1 | null; canComplete: boolean; legs: CloseLegIdentity[]; barrierAt: string | null }
export type CloseEvaluator = (evidence: LifecycleEvidence, context: CloseContext, options: CloseEvidenceOptions) => CloseEvidenceReport;
export interface CloseRisk { ok: boolean; reasons: string[]; evidence: unknown; expiresAt: string }
export type CloseState = "PREPARING" | "CANCEL_UNKNOWN" | "BLOCKED" | "SUBMISSION_UNKNOWN" | "SUBMITTED" | "COMPLETED";
export interface CloseOperation { id: number; originalProposalId: number; requestId: string; accountId: string; sessionId: string; clientId: number; generation: number; originalHash: string; instrumentId: string; conid: string; limitPrice: number; state: CloseState; owner: string; terminals: CloseTerminalEvidence[]; cancelAttempts: CloseLegIdentity[]; barrierAt: string | null; closeProposalId: number | null; closeLink: LifecycleLegLink | null; submissionAttemptedAt: string | null; observation: unknown; failureReason: string | null }
export interface ClosePrepared { normalizedTicket: SignalTicket; persistence: PlanPersistenceInput; payload: unknown }
