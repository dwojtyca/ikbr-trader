import { classifySessionHistoryPreparation, sessionHistoryCoverageBounds, requireSessionHistorySchedule, type SessionSchedule, type SessionScheduleEvidence, type InstrumentSessionIdentity } from "@ikbr/shared";
export interface SessionScheduleDiagnostic {
  identity: InstrumentSessionIdentity; generation: number; attemptedAt: string; completedAt?: string; nextCheckAt: string;
  status: 'FETCHING' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'SUPERSEDED'; reason?: string;
  coverageStart?: string; coverageEnd?: string; requestedAt?: string; receivedAt?: string; sessionCount?: number;
  firstSessionDate?: string; lastSessionDate?: string; required: ReturnType<typeof sessionHistoryCoverageBounds>;
}
export class SessionScheduleRefresh {
  lastError: string | undefined;
  lastAttemptDiagnostic: SessionScheduleDiagnostic | undefined;
  private invalidationVersion = 0;
  private running: Promise<SessionScheduleEvidence | null> | undefined;
  private invalidating: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private lastAttempt = -Infinity;
  constructor(private readonly identity: InstrumentSessionIdentity, private readonly deps: {
    read(): Promise<SessionScheduleEvidence | null>;
    begin(status: 'REFRESHING' | 'FAILED'): Promise<number>;
    finish(generation: number, schedule: SessionSchedule | null): Promise<boolean>;
    fetch(): Promise<SessionSchedule>;
    now?: () => number;
  }) {}
  invalidate(): Promise<void> {
    // Serialize database invalidation, preserving the generation fence across in-flight callbacks.
    this.lastAttempt = -Infinity;
    this.invalidationVersion++;
    if (this.lastAttemptDiagnostic) this.lastAttemptDiagnostic = { ...this.lastAttemptDiagnostic, status: 'SUPERSEDED' };
    const pending = this.invalidating.catch(() => undefined).then(() => this.deps.begin('FAILED'));
    this.invalidating = pending;
    return pending.then(() => undefined);
  }
  ensure(): Promise<SessionScheduleEvidence | null> {
    if (this.running) return this.running;
    this.running = this.refresh().catch(error => {
      this.lastError = error instanceof Error ? error.message : 'session_schedule_refresh_failed';
      if (this.lastAttemptDiagnostic && this.lastAttemptDiagnostic.status !== 'SUPERSEDED')
        this.lastAttemptDiagnostic = { ...this.lastAttemptDiagnostic, status: 'FAILED', reason: this.lastError };
      throw error;
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async idle(): Promise<void> { await this.running; await this.invalidating; }
  private reconcileDiagnostic(evidence: SessionScheduleEvidence | null, now: number, prepared?: 'COMPLETE' | 'PARTIAL'): void {
    const diagnostic = this.lastAttemptDiagnostic;
    if (!diagnostic || diagnostic.status === 'SUPERSEDED' || (!prepared && !['COMPLETE', 'PARTIAL'].includes(diagnostic.status))) return;
    if (!evidence || evidence.generation !== diagnostic.generation) {
      this.lastAttemptDiagnostic = { ...diagnostic, status: 'SUPERSEDED', reason: 'session_schedule_generation_changed' };
      return;
    }
    const preparation = classifySessionHistoryPreparation(evidence, this.identity, now);
    if (preparation.state === 'UNAVAILABLE') {
      this.lastError = preparation.reason;
      this.lastAttemptDiagnostic = { ...diagnostic, status: 'FAILED', reason: preparation.reason };
      return;
    }
    this.lastAttemptDiagnostic = { ...diagnostic, status: preparation.state,
      reason: preparation.state === 'PARTIAL' ? 'session_history_partial' : undefined };
  }
  private async refresh(): Promise<SessionScheduleEvidence | null> {
    if (!this.initialized) { this.initialized = true; await this.invalidate(); }
    try { await this.invalidating; } catch { await this.invalidate(); }
    const now = this.deps.now?.() ?? Date.now();
    const evidence = await this.deps.read();
    this.reconcileDiagnostic(evidence, this.deps.now?.() ?? Date.now());
    let due = true;
    try {
      const schedule = requireSessionHistorySchedule(evidence, this.identity, now);
      const received = Date.parse(schedule.receivedAt);
      const crossedOpen = schedule.sessions.some(x => Date.parse(x.start) > received && Date.parse(x.start) <= now);
      due = now - received >= 3600000 || crossedOpen || Date.parse(schedule.coverageEnd) < now;
    } catch { /* Missing, stale or invalidated evidence must be refreshed. */ }
    if (!due || now - this.lastAttempt < 60000) return evidence;
    this.lastAttempt = now;
    const invalidationVersion = this.invalidationVersion;
    const generation = await this.deps.begin('REFRESHING');
    const diagnostic: SessionScheduleDiagnostic = { identity: this.identity, generation, attemptedAt: new Date(now).toISOString(),
      nextCheckAt: new Date(now + 60000).toISOString(), status: 'FETCHING', required: sessionHistoryCoverageBounds(this.identity, now) };
    this.lastAttemptDiagnostic = diagnostic;
    let prepared: 'COMPLETE' | 'PARTIAL' | undefined;
    try {
      const schedule = await this.deps.fetch();
      Object.assign(diagnostic, { coverageStart: schedule.coverageStart, coverageEnd: schedule.coverageEnd,
        requestedAt: schedule.requestedAt, receivedAt: schedule.receivedAt, sessionCount: schedule.sessions.length,
        firstSessionDate: schedule.sessions[0]?.date, lastSessionDate: schedule.sessions.at(-1)?.date });
      const checkedAt = this.deps.now?.() ?? Date.now();
      diagnostic.required = sessionHistoryCoverageBounds(this.identity, checkedAt);
      const preparation = classifySessionHistoryPreparation({ generation, status: 'READY', schedule, updatedAt: schedule.receivedAt }, this.identity, checkedAt);
      if (preparation.state === 'UNAVAILABLE') throw new Error(preparation.reason);
      await this.invalidating;
      const accepted = await this.deps.finish(generation, schedule);
      diagnostic.completedAt = new Date(this.deps.now?.() ?? Date.now()).toISOString();
      if (accepted && invalidationVersion === this.invalidationVersion) prepared = preparation.state;
      else diagnostic.status = 'SUPERSEDED';
      if (accepted && invalidationVersion === this.invalidationVersion) this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "session_schedule_fetch_failed";
      const accepted = await this.deps.finish(generation, null);
      diagnostic.completedAt = new Date(this.deps.now?.() ?? Date.now()).toISOString();
      diagnostic.status = accepted && invalidationVersion === this.invalidationVersion ? 'FAILED' : 'SUPERSEDED';
      diagnostic.reason = this.lastError;
    }
    this.lastAttemptDiagnostic = diagnostic;
    await this.invalidating;
    const finalEvidence = await this.deps.read();
    this.reconcileDiagnostic(finalEvidence, this.deps.now?.() ?? Date.now(), prepared);
    return finalEvidence;
  }
}
