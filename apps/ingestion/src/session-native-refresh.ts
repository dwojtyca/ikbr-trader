import { SESSION_REQUIRED_CANDLES, matchesSessionSlot, evaluateSessionCandles, expectedSessionSlot, filterClosedSessionCandles, classifySessionHistoryPreparation,
  type InstrumentSessionIdentity, type SessionScheduleEvidence, type SessionTimeframe, type Candle } from '@ikbr/shared';
import type { InstrumentSubscription } from './types.js';
export const SESSION_POLLING_CAPACITY = Math.floor((50 - 20) / 12);
export const sessionKey = (identity: InstrumentSessionIdentity): string => `${identity.instrumentId}:${identity.conId}:${identity.useRTH ? 'rth' : 'full'}`;
export interface SessionWarmupStatus {
  identity?: InstrumentSessionIdentity; instrumentId?: string; conid: string; timeframe: SessionTimeframe;
  preparationState: 'READY' | 'WAITING' | 'HOLD'; historyCoverage: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  countsMeasured: boolean; nextCheckAt: string; preparationReason?: string;
  required: number; available: number; nativeClosed: number; latest: string | null; latestEnd: string | null;
  expectedStart?: string; expectedEnd?: string; generation?: number; scheduleStatus?: string; scheduleReceivedAt?: string;
  coverageStart?: string; coverageEnd?: string; sessionDate?: string; checkedAt: string; error?: string;
}
interface RefreshAttempt {
  attemptedAt: number;
  completedAt?: number;
  expectedEnd?: number;
  success: boolean;
}
export class SessionNativeRefresh {
  private running: Promise<void> | undefined;
  private attempts = new Map<string, RefreshAttempt>();
  private rotation = 0;
  readonly status = new Map<string, SessionWarmupStatus>();
  constructor(private readonly deps: {
    identity(sub: InstrumentSubscription): InstrumentSessionIdentity;
    schedule(identity: InstrumentSessionIdentity): Promise<SessionScheduleEvidence | null>;
    readSchedule(identity: InstrumentSessionIdentity): Promise<SessionScheduleEvidence | null>;
    invalidate(identity: InstrumentSessionIdentity): Promise<void>;
    read(identity: InstrumentSessionIdentity, tf: SessionTimeframe, limit: number): Promise<Candle[]>;
    fetch(sub: InstrumentSubscription, identity: InstrumentSessionIdentity, tf: SessionTimeframe, count: number): Promise<Candle[]>;
    write(candle: Candle): Promise<void>; now?: () => number;
  }) {}
  idle(): Promise<void> { return this.running ?? Promise.resolve(); }
  run(subscriptions: readonly InstrumentSubscription[]): Promise<void> {
    if (this.running) return this.running;
    this.running = this.refresh(subscriptions).finally(() => { this.running = undefined; });
    return this.running;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private blocked(sub: InstrumentSubscription, error: string, identity?: InstrumentSessionIdentity): void {
    const now = this.now();
    for (const tf of Object.keys(SESSION_REQUIRED_CANDLES) as SessionTimeframe[]) this.status.set(`${sub.instrumentId ?? 'unbound'}:${sub.conid}:${identity?.useRTH ? 'rth' : 'full'}:${tf}`, {
      identity, instrumentId: sub.instrumentId, conid: sub.conid, timeframe: tf, required: SESSION_REQUIRED_CANDLES[tf], available: 0,
      nativeClosed: 0, latest: null, latestEnd: null, checkedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(), error,
      preparationState: error === 'session_refresh_queued' ? 'WAITING' : 'HOLD', historyCoverage: 'UNAVAILABLE', countsMeasured: false,
      nextCheckAt: new Date((Number.isFinite(now) ? now : Date.now()) + 60000).toISOString(), preparationReason: error });
  }
  private async refresh(subscriptions: readonly InstrumentSubscription[]): Promise<void> {
    const entries: Array<{ sub: InstrumentSubscription; identity: InstrumentSessionIdentity }> = [];
    this.status.clear();
    for (const sub of subscriptions) {
      if (!sub.instrumentId) { this.blocked(sub, 'session_binding_required'); continue; }
      try { const identity = this.deps.identity(sub); entries.push({ sub, identity }); this.blocked(sub, 'session_refresh_queued', identity); }
      catch (error) { this.blocked(sub, error instanceof Error ? error.message : 'session_identity_invalid'); }
    }
    const conflictingMode = entries.some(({ identity }) => entries.some(other => other.identity.conId === identity.conId && other.identity.useRTH !== identity.useRTH));
    if (entries.length > SESSION_POLLING_CAPACITY || conflictingMode) {
      const reason = conflictingMode ? 'session_mode_conflict' : 'session_polling_capacity_exceeded';
      for (const { sub, identity } of entries) {
        try { await this.deps.invalidate(identity); this.blocked(sub, reason, identity); }
        catch { this.blocked(sub, 'session_invalidation_failed', identity); }
      }
      return;
    }
    if (!entries.length) return;
    const offset = this.rotation++ % entries.length;
    const ordered = [...entries.slice(offset), ...entries.slice(0, offset)];
    let maintenanceAt = -Infinity;
    const maintainMinutes = async () => {
      maintenanceAt = this.now();
      for (const entry of ordered) await this.refreshTimeframe(entry.sub, entry.identity, '1m');
    };
    await maintainMinutes();
    for (const tf of ['5m', '1h', '4h', '1d', '1w'] as SessionTimeframe[]) for (const { sub, identity } of ordered) {
      // A cold higher-timeframe bootstrap cannot monopolize the polling budget ahead of due minutes.
      if (this.now() - maintenanceAt >= 60000) await maintainMinutes();
      await this.refreshTimeframe(sub, identity, tf);
    }
  }
  private async refreshTimeframe(sub: InstrumentSubscription, identity: InstrumentSessionIdentity, tf: SessionTimeframe): Promise<void> {
    const key = `${sessionKey(identity)}:${tf}`, required = SESSION_REQUIRED_CANDLES[tf];
    let evidence: SessionScheduleEvidence | null = null;
    let observedAt = NaN;
    let latestObservedAt = -Infinity;
    const observe = () => {
      const now = this.now();
      if (!Number.isFinite(now) || now < latestObservedAt) throw new Error('session_timestamp_invalid');
      latestObservedAt = now;
      return now;
    };
    const preparationFor = (value: SessionScheduleEvidence | null, now: number) => {
      const preparation = classifySessionHistoryPreparation(value, identity, now);
      if (preparation.state === 'UNAVAILABLE') throw new Error(preparation.reason);
      if (tf === '1w' && preparation.state === 'PARTIAL') throw new Error('session_weekly_coverage_pending');
      return preparation;
    };
    try {
      evidence = await this.deps.schedule(identity);
      observedAt = observe();
      if (!Number.isFinite(observedAt)) throw new Error('session_timestamp_invalid');
      preparationFor(evidence, observedAt);
      const current = await this.deps.read(identity, tf, required + 10);
      const now = observe();
      if (!Number.isFinite(now) || now < observedAt) throw new Error('session_timestamp_invalid');
      const schedule = preparationFor(evidence, now).schedule;
      const closed = filterClosedSessionCandles(current, tf, schedule, now);
      const expected = expectedSessionSlot(tf, schedule, now);
      const missing = expected !== undefined && !matchesSessionSlot(closed.at(-1)?.ts.toISOString(), expected);
      const previous = this.attempts.get(key);
      const sinceAttempt = previous === undefined ? Infinity : now - previous.attemptedAt;
      const sinceCompletion = previous?.completedAt === undefined ? Infinity : now - previous.completedAt;
      const newerSlot = previous?.success === true && previous.expectedEnd !== undefined && expected !== undefined
        && Date.parse(expected.end) > previous.expectedEnd;
      const eligible = previous === undefined || (sinceAttempt >= 0 && sinceCompletion >= 0
        && (!previous.success ? sinceAttempt >= 60000
          : sinceCompletion >= 15000 && (sinceAttempt >= 60000 || newerSlot)));
      let attempted = false;
      let fetchedTarget = false;
      if ((closed.length < required || missing) && eligible) {
        attempted = true;
        this.attempts.set(key, { attemptedAt: now, success: false });
        const fetched = await this.deps.fetch(sub, identity, tf, required + 10);
        observe();
        const freshEvidence = await this.deps.readSchedule(identity);
        const fetchedAt = observe();
        preparationFor(freshEvidence, fetchedAt);
        if (freshEvidence?.generation !== evidence?.generation) throw new Error('session_schedule_generation_changed');
        const fetchedClosed = filterClosedSessionCandles(fetched, tf, schedule, fetchedAt);
        fetchedTarget = expected !== undefined && fetchedClosed.some(candle => matchesSessionSlot(candle.ts.toISOString(), expected));
        for (const candle of fetchedClosed) { observe(); await this.deps.write(candle); }
      }
      const rows = await this.deps.read(identity, tf, required + 10), finalEvidence = await this.deps.readSchedule(identity), checkedAt = observe();
      const finalPreparation = preparationFor(finalEvidence, checkedAt);
      if (finalEvidence?.generation !== evidence?.generation) throw new Error('session_schedule_generation_changed');
      const result = evaluateSessionCandles(rows, tf, finalEvidence, identity, checkedAt);
      const finalClosed = filterClosedSessionCandles(rows, tf, schedule, checkedAt), finalExpected = expectedSessionSlot(tf, schedule, checkedAt);
      if (attempted) {
        const success = Number.isFinite(checkedAt) && checkedAt >= now && fetchedTarget && expected !== undefined
          && finalClosed.length >= required && !result.reason
          && finalClosed.some(candle => matchesSessionSlot(candle.ts.toISOString(), expected));
        this.attempts.set(key, { attemptedAt: now, success,
          ...(success ? { completedAt: checkedAt, expectedEnd: Date.parse(expected!.end) } : {}) });
      }
      const latest = finalClosed.at(-1)?.ts.toISOString();
      const error = finalClosed.length < required ? 'insufficient_native_closed_candles' : result.reason;
      const preparationReason = finalPreparation.state === 'PARTIAL' ? 'session_history_partial' : error;
      const waiting = finalPreparation.state === 'PARTIAL' || ['insufficient_native_closed_candles', 'session_closed',
        'session_current_interval_minute_missing', 'session_expected_slot_unavailable', 'session_expected_candle_missing',
        'session_schedule_coverage_missing'].includes(error ?? '');
      this.status.set(key, { identity, instrumentId: identity.instrumentId, conid: String(identity.conId), timeframe: tf, required,
        available: rows.length, nativeClosed: finalClosed.length, latest: latest ?? null, latestEnd: result.latestEnd ?? (matchesSessionSlot(latest, finalExpected) ? finalExpected?.end ?? null : null),
        expectedStart: finalExpected?.start, expectedEnd: finalExpected?.end, generation: finalEvidence?.generation, scheduleStatus: finalEvidence?.status,
        scheduleReceivedAt: schedule.receivedAt, coverageStart: schedule.coverageStart, coverageEnd: schedule.coverageEnd,
        sessionDate: schedule.sessions.find(x => Date.parse(x.start) <= checkedAt && checkedAt < Date.parse(x.end))?.date,
        checkedAt: new Date(checkedAt).toISOString(), ...(error ? { error } : {}),
        preparationState: waiting ? 'WAITING' : error ? 'HOLD' : 'READY', historyCoverage: finalPreparation.state,
        countsMeasured: true, nextCheckAt: new Date(checkedAt + 60000).toISOString(), ...(preparationReason ? { preparationReason } : {}) });
    } catch (error) {
      const current = this.now(), prior = this.attempts.get(key);
      const reason = error instanceof Error ? error.message : 'session_native_refresh_failed';
      const weeklyPending = reason === 'session_weekly_coverage_pending';
      const attemptedAt = Math.max(Number.isFinite(prior?.attemptedAt) ? prior!.attemptedAt : -Infinity,
        Number.isFinite(prior?.completedAt) ? prior!.completedAt! : -Infinity,
        Number.isFinite(observedAt) ? observedAt : -Infinity,
        Number.isFinite(latestObservedAt) ? latestObservedAt : -Infinity,
        Number.isFinite(current) ? current : -Infinity);
      if (Number.isFinite(attemptedAt)) this.attempts.set(key, { attemptedAt, success: false });
      this.status.set(key, { identity, instrumentId: identity.instrumentId, conid: String(identity.conId), timeframe: tf, required, available: 0,
        nativeClosed: 0, latest: null, latestEnd: null, generation: evidence?.generation, scheduleStatus: evidence?.status ?? 'FAILED',
        checkedAt: new Date(Number.isFinite(current) ? current : Date.now()).toISOString(), error: reason,
        preparationState: weeklyPending ? 'WAITING' : 'HOLD', historyCoverage: weeklyPending ? 'PARTIAL' : 'UNAVAILABLE',
        countsMeasured: false, nextCheckAt: new Date((Number.isFinite(current) ? current : Date.now()) + 60000).toISOString(), preparationReason: reason });
    }
  }
}
