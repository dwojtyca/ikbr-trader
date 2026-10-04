import type { BoundInstrument } from '@ikbr/shared';
import type { CloseContext } from './close-types.js';
import type { FullCloseService } from './close-service.js';
import type { LifecycleFaultCode, LifecycleFaultSink } from './fault-contract.js';
import { LifecycleObserverRepository } from './observer-repository.js';
import { evaluateLifecycleOwnership } from './ownership.js';
import { evaluateRoundTrip } from './round-trip-evidence.js';
import { isProvenUnfilledPaperEntry } from '../paper-terminal-entry.js';
import { protectionFailure, activeStockEvidenceFailure } from './protection-evidence.js';
export interface LifecycleObserverDependencies {
  currentContext(): { accountId: string; sessionId: string } | null;
  context(proposalId: number): Promise<CloseContext | null>;
  refresh(): Promise<void>;
  close: Pick<FullCloseService, 'get' | 'request' | 'reconcile'>;
  faults: LifecycleFaultSink;
  closePrice(bound: BoundInstrument, context: CloseContext): Promise<number>;
  assertManagementAllowed(context: CloseContext): void;
  automationEnabled: boolean; adoptExisting: boolean; exitBeforeCloseMinutes: number;
  onHealth(healthy: boolean, reason: string | null): void;
  logCritical(reason: string): void;
  now?: () => number;
}
export class LifecycleObserver {
  private timer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inflight: Promise<void> | null = null;
  private watchInflight: Promise<void> | null = null;
  private lastSuccessAt: number | null = null;
  private healthy = false;
  private reason: string | null = 'lifecycle_not_observed';
  private startedAt: number;
  private closing: { proposalId: number; startedAt: number } | null = null;
  constructor(readonly store: LifecycleObserverRepository, readonly deps: LifecycleObserverDependencies) { this.startedAt = this.now(); }
  private now() { return this.deps.now?.() ?? Date.now(); }
  status() { return { healthy: this.healthy, reason: this.reason, lastSuccessAt: this.lastSuccessAt, running: this.inflight !== null }; }
  private setHealth(healthy: boolean, reason: string | null) { this.healthy = healthy; this.reason = reason; this.deps.onHealth(healthy, reason); }
  start(): void {
    if (this.timer || this.stopping) return;
    this.startedAt = this.now();
    this.timer = setInterval(() => { void this.triggerNow(); }, 5000);
    this.watchTimer = setInterval(() => { void this.watchdog(); }, 1000);
    void this.triggerNow();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.timer = this.watchTimer = null;
    await this.inflight; await this.watchInflight;
    this.setHealth(false, 'lifecycle_stopped');
  }
  watchdog(): Promise<void> {
    if (this.watchInflight) return this.watchInflight;
    if (this.stopping || this.now() - (this.lastSuccessAt ?? this.startedAt) < 10000) return Promise.resolve();
    this.setHealth(false, 'lifecycle_observation_overdue'); this.deps.logCritical('lifecycle_observation_overdue');
    const c = this.deps.currentContext(); if (!c) return Promise.resolve();
    const task = (async () => {
      try {
        await this.store.health(c.accountId, c.sessionId, false, 'lifecycle_observation_overdue');
        await this.deps.faults.recordFault({ accountId: c.accountId, proposalId: null, code: 'BROKER_STATE_STALE', evidence: { reason: 'lifecycle_observation_overdue' } });
        const overdue = await this.store.overdueProtection(c.accountId);
        if (this.closing && this.now()-this.closing.startedAt >= 15000) overdue.push(this.closing.proposalId);
        for (const id of new Set(overdue)) await this.deps.faults.recordFault({ accountId: c.accountId, proposalId: id, code: 'PROTECTION_GAP', evidence: { reason: 'closing_transition_overdue' } });
      } catch { this.deps.logCritical('lifecycle_watchdog_persistence_unavailable'); }
    })().finally(() => { this.watchInflight = null; });
    this.watchInflight = task; return task;
  }
  triggerNow(): Promise<void> {
    if (this.stopping || this.inflight) return this.inflight ?? Promise.resolve();
    const task = this.cycle().catch(async () => {
      this.setHealth(false, 'lifecycle_supervisor_failure'); this.deps.logCritical('lifecycle_supervisor_failure');
      const c = this.deps.currentContext(); if (!c) return;
      try { await this.store.health(c.accountId, c.sessionId, false, 'lifecycle_supervisor_failure');
        await this.deps.faults.recordFault({ accountId: c.accountId, proposalId: null, code: 'SUPERVISOR_FAILURE', evidence: { reason: 'lifecycle_supervisor_failure' } });
      } catch { this.deps.logCritical('lifecycle_database_unavailable'); }
    }).finally(() => { this.inflight = null; });
    this.inflight = task; return task;
  }
  private async cycle(): Promise<void> {
    const current = this.deps.currentContext();
    if (!current) { this.setHealth(false, 'lifecycle_broker_unavailable'); this.deps.logCritical('lifecycle_broker_unavailable'); return; }
    await this.store.withAccountLease(current.accountId, async () => {
      await this.deps.refresh();
      const fresh = this.deps.currentContext();
      if (!fresh || fresh.accountId !== current.accountId || fresh.sessionId !== current.sessionId || !await this.store.accountFresh(current.accountId, current.sessionId)) throw new Error('lifecycle_account_unavailable');
      let clean = true;
      for (const id of await this.store.listCandidates(current.accountId)) {
        if (this.stopping) { clean = false; break; }
        clean = (await this.observe(id, current.accountId)) && clean;
      }
      if (this.deps.currentContext()?.sessionId !== current.sessionId || !await this.store.accountFresh(current.accountId, current.sessionId)) throw new Error('lifecycle_account_stale');
      this.lastSuccessAt = this.now();
      await this.deps.faults.resolveScope(current.accountId, null, []);
      await this.store.health(current.accountId, current.sessionId, clean, clean ? null : 'lifecycle_fault_active');
      this.setHealth(clean, clean ? null : 'lifecycle_fault_active');
    });
  }
  private async observe(id: number, accountId: string): Promise<boolean> {
    const codes: LifecycleFaultCode[] = [];
    const fault = async (code: LifecycleFaultCode, reason: string) => {
      if (!codes.includes(code)) { codes.push(code); await this.deps.faults.recordFault({ accountId, proposalId: id, code, evidence: { reason } }); }
    };
    let status = 'HOLD'; let observation: unknown = null;
    try {
      const context = await this.deps.context(id);
      if (!context?.bound || context.accountId !== accountId) { await fault('ORPHAN_OWNERSHIP', 'original_management_identity_unavailable'); return false; }
      let close = await this.deps.close.get(id);
      if (close && close.state !== 'COMPLETED') close = await this.deps.close.reconcile(id);
      const fingerprintBefore = await this.store.fingerprint(id);
      const evidence = await this.store.execution.getRoundTripEvidence(id, accountId);
      if (!evidence) { await fault('ORPHAN_OWNERSHIP', 'original_proposal_missing'); return false; }
      const c = { ...context, nowMs: this.now() };
      let policy = await this.store.get(id);
      if (!policy && this.deps.adoptExisting) { await this.store.adopt(evidence.lifecycle.order, context.bound, accountId, this.deps.exitBeforeCloseMinutes); policy = await this.store.get(id); }
      if (!policy) { await fault('EXIT_POLICY_UNAVAILABLE', 'original_exit_policy_missing'); return false; }
      const fingerprint = await this.store.fingerprint(id);
      if (fingerprintBefore !== fingerprint) { await fault('HISTORICAL_EVIDENCE_CHANGED', 'economic_evidence_changed_during_observation'); return false; }
      if (policy.terminalProof) {
        const snapshot = evidence.lifecycle.run?.broker_snapshot as { openOrders?: Array<Record<string, unknown>>; executions?: Array<Record<string, unknown>> } | undefined;
        const oldLinks = policy.terminalProof.links as Array<{ broker_order_id: string; order_ref: string; perm_id: string | null }>;
        const own = (row: Record<string, unknown>) => row.accountId === accountId && oldLinks.some(link => row.brokerOrderId === link.broker_order_id || row.orderRef === link.order_ref || (link.perm_id !== null && row.permId === link.perm_id));
        const knownExecutions = policy.terminalProof.executionIds as string[];
        if (fingerprint !== policy.terminalFingerprint || !Array.isArray(snapshot?.openOrders) || !Array.isArray(snapshot?.executions) || snapshot.openOrders.some(own) || snapshot.executions.some(row => own(row) && !knownExecutions.includes(String(row.execId)))) {
          await fault('HISTORICAL_EVIDENCE_CHANGED', 'terminal_proof_contradicted'); return false;
        }
        status = policy.terminalProof.status === 'TERMINAL_UNFILLED' ? 'TERMINAL_UNFILLED' : 'FLAT'; observation = { terminalFingerprint: fingerprint }; return true;
      }
      const roundTrip = evaluateRoundTrip(evidence, c);
      if (roundTrip.status === 'COMPLETED' && roundTrip.accounting !== 'COMPLETE') { status = 'ACCOUNTING_PENDING'; observation = roundTrip; return true; }
      if (roundTrip.status === 'COMPLETED' || isProvenUnfilledPaperEntry(evidence, c)) {
        status = roundTrip.status === 'COMPLETED' ? 'FLAT' : 'TERMINAL_UNFILLED'; observation = roundTrip;
        const snapshot = evidence.lifecycle.run?.broker_snapshot as { executions: Array<{ execId: string }> };
        await this.store.observe(id, status, observation, { proof: { status, report: roundTrip, links: [...evidence.lifecycle.links, ...(evidence.close?.links ?? [])], executionIds: snapshot.executions.map(row => row.execId) }, fingerprint });
        return true;
      }
      const stockEvidence = activeStockEvidenceFailure(evidence, context.bound.currency);
      if (stockEvidence) { await fault('ORPHAN_OWNERSHIP', stockEvidence); if (!close) return false; }
      if (close) {
        observation = close;
        const residual=(close.observation as {residualQuantity?:unknown}|null)?.residualQuantity;
        if(typeof residual==='number' && residual!==0 && residual!==1) await fault('ORPHAN_OWNERSHIP','unsupported_close_residual_quantity');
        status = close.state === 'SUBMITTED' || close.state === 'PREPARING' ? 'CLOSING' : 'HOLD';
        if (close.state === 'CANCEL_UNKNOWN') await fault('CANCEL_UNKNOWN', close.failureReason ?? 'cancel_outcome_unknown');
        if (close.state === 'SUBMISSION_UNKNOWN') await fault('SUBMISSION_UNKNOWN', close.failureReason ?? 'submission_outcome_unknown');
        if (close.state === 'BLOCKED') await fault('CLOSE_BLOCKED', close.failureReason ?? 'close_blocked');
        if (close.state === 'PREPARING') await fault('CLOSE_BLOCKED', 'interrupted_preparation_observation_only');
        if (close.state === 'SUBMITTED' && close.submissionAttemptedAt && this.now()-Date.parse(close.submissionAttemptedAt) >= 15000) await fault('CLOSE_UNFILLED', 'close_not_flat_after_15_seconds');
        if (close.cancelAttempts.some(leg => leg.role !== 'PARENT') && codes.length) await fault('PROTECTION_GAP', 'cancelled_protection_without_final_flat_proof');
        if (close.state === 'COMPLETED') await fault('BROKER_STATE_STALE', 'final_accounting_or_terminal_proof_pending');
        return codes.length === 0;
      }
      const facts = evaluateLifecycleOwnership(evidence.lifecycle, c); observation = facts;
      if (facts.status === 'BLOCKED') { await fault(facts.reasons.includes('protection_missing') ? 'PROTECTION_GAP' : facts.reasons.some(r => r.includes('uncorrelated')) ? 'FOREIGN_ORDER_CONFLICT' : 'ORPHAN_OWNERSHIP', facts.reasons.join(',')); return false; }
      if (facts.status === 'FLAT_OBSERVED') { await fault('BROKER_STATE_STALE', 'terminal_accounting_not_proven'); return false; }
      if ((facts.status === 'OWNED_POSITION' && (facts.ownedFillNet !== 1 || facts.brokerPositionQuantity !== 1)) ||
          (facts.status === 'PENDING_ENTRY' && (facts.ownedFillNet !== 0 || facts.brokerPositionQuantity !== 0))) { await fault('ORPHAN_OWNERSHIP', 'unsupported_quantity'); return false; }
      const protection = protectionFailure(evidence.lifecycle, facts);
      if (protection) { await fault('PROTECTION_UNKNOWN', protection); return false; }
      status = facts.status === 'PENDING_ENTRY' ? 'PENDING_ENTRY' : 'PROTECTED';
      try { policy = await this.store.validateSession(policy, evidence.lifecycle.order, context.bound, this.now()); }
      catch { await fault('CALENDAR_UNAVAILABLE', 'verified_original_session_unavailable'); return false; }
      if (this.now() < Date.parse(policy.exitDeadline)) return true;
      if (this.now() >= Date.parse(policy.sessionEnd)) { await fault('EXIT_DEADLINE_MISSED', 'original_session_closed'); return false; }
      if (policy.automaticRequestId) { await fault('CLOSE_BLOCKED', 'automatic_intent_without_operation_observation_only'); return false; }
      if (!this.deps.automationEnabled || this.deps.adoptExisting) { await fault('MANAGEMENT_DISABLED', 'automatic_exit_disabled'); return false; }
      try { this.deps.assertManagementAllowed(c); } catch { await fault('MANAGEMENT_DISABLED', 'close_writes_disabled'); return false; }
      const price = await this.deps.closePrice(context.bound, c);
      this.deps.assertManagementAllowed(c);
      const claimed = await this.store.claimAutomatic(policy, price);
      if (!claimed) { await fault('CLOSE_BLOCKED', 'automatic_intent_already_claimed'); return false; }
      this.closing = { proposalId: id, startedAt: this.now() };
      try { close = await this.deps.close.request(id, claimed.automaticRequestId!, price, 'lifecycle_supervisor'); }
      finally { this.closing = null; }
      observation = close; status = close.state === 'COMPLETED' || close.state === 'SUBMITTED' ? 'CLOSING' : 'HOLD';
      if (close.state !== 'COMPLETED' && close.state !== 'SUBMITTED') {
        await fault(close.state === 'CANCEL_UNKNOWN' ? 'CANCEL_UNKNOWN' : close.state === 'SUBMISSION_UNKNOWN' ? 'SUBMISSION_UNKNOWN' : 'CLOSE_BLOCKED', close.failureReason ?? close.state);
        if (close.cancelAttempts.some(leg => leg.role !== 'PARENT')) await fault('PROTECTION_GAP', 'cancelled_protection_without_final_flat_proof');
      }
      return codes.length === 0;
    } catch { await fault('SUPERVISOR_FAILURE', 'lifecycle_observation_failed'); return false; }
    finally {
      await this.store.observe(id, codes.length ? 'HOLD' : status, observation);
      await this.deps.faults.resolveScope(accountId, id, codes);
    }
  }
}
