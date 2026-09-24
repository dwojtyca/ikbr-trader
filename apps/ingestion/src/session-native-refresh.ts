import { SESSION_REQUIRED_CANDLES, matchesSessionSlot, evaluateSessionCandles, expectedSessionSlot, filterClosedSessionCandles, requireSessionHistorySchedule,
  type InstrumentSessionIdentity, type SessionScheduleEvidence, type SessionTimeframe, type Candle } from '@ikbr/shared';
import type { InstrumentSubscription } from './types.js';
export const SESSION_POLLING_CAPACITY = Math.floor((50 - 20) / 12);
export const sessionKey = (identity: InstrumentSessionIdentity): string => `${identity.instrumentId}:${identity.conId}:${identity.useRTH ? 'rth' : 'full'}`;
export interface SessionWarmupStatus {
  identity?: InstrumentSessionIdentity; instrumentId?: string; conid: string; timeframe: SessionTimeframe;
  required: number; available: number; nativeClosed: number; latest: string | null; latestEnd: string | null;
  expectedStart?: string; expectedEnd?: string; generation?: number; scheduleStatus?: string; scheduleReceivedAt?: string;
  coverageStart?: string; coverageEnd?: string; sessionDate?: string; checkedAt: string; error?: string;
}
export class SessionNativeRefresh {
  private running: Promise<void> | undefined;
  private checked = new Map<string, number>();
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
    for (const tf of Object.keys(SESSION_REQUIRED_CANDLES) as SessionTimeframe[]) this.status.set(`${sub.instrumentId ?? 'unbound'}:${sub.conid}:${identity?.useRTH ? 'rth' : 'full'}:${tf}`, {
      identity, instrumentId: sub.instrumentId, conid: sub.conid, timeframe: tf, required: SESSION_REQUIRED_CANDLES[tf], available: 0,
      nativeClosed: 0, latest: null, latestEnd: null, checkedAt: new Date(this.now()).toISOString(), error });
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
    try {
      evidence = await this.deps.schedule(identity);
      const now = this.now(), schedule = requireSessionHistorySchedule(evidence, identity, now);
      const current = await this.deps.read(identity, tf, required + 10);
      const closed = filterClosedSessionCandles(current, tf, schedule, now);
      const expected = expectedSessionSlot(tf, schedule, now);
      const missing = expected !== undefined && !matchesSessionSlot(closed.at(-1)?.ts.toISOString(), expected);
      const previous = this.checked.get(key);
      if ((closed.length < required || missing) && (previous === undefined || now - previous >= 60000)) {
        this.checked.set(key, now);
        const fetched = await this.deps.fetch(sub, identity, tf, required + 10);
        const freshEvidence = await this.deps.readSchedule(identity);
        requireSessionHistorySchedule(freshEvidence, identity, this.now());
        if (freshEvidence?.generation !== evidence?.generation) throw new Error('session_schedule_generation_changed');
        for (const candle of filterClosedSessionCandles(fetched, tf, schedule, this.now())) await this.deps.write(candle);
      }
      const rows = await this.deps.read(identity, tf, required + 10), finalEvidence = await this.deps.readSchedule(identity), checkedAt = this.now();
      requireSessionHistorySchedule(finalEvidence, identity, checkedAt);
      if (finalEvidence?.generation !== evidence?.generation) throw new Error('session_schedule_generation_changed');
      const result = evaluateSessionCandles(rows, tf, finalEvidence, identity, checkedAt);
      const finalClosed = filterClosedSessionCandles(rows, tf, schedule, checkedAt), finalExpected = expectedSessionSlot(tf, schedule, checkedAt);
      const latest = finalClosed.at(-1)?.ts.toISOString();
      this.status.set(key, { identity, instrumentId: identity.instrumentId, conid: String(identity.conId), timeframe: tf, required,
        available: rows.length, nativeClosed: finalClosed.length, latest: latest ?? null, latestEnd: result.latestEnd ?? (matchesSessionSlot(latest, finalExpected) ? finalExpected?.end ?? null : null),
        expectedStart: finalExpected?.start, expectedEnd: finalExpected?.end, generation: finalEvidence?.generation, scheduleStatus: finalEvidence?.status,
        scheduleReceivedAt: schedule.receivedAt, coverageStart: schedule.coverageStart, coverageEnd: schedule.coverageEnd,
        sessionDate: schedule.sessions.find(x => Date.parse(x.start) <= checkedAt && checkedAt < Date.parse(x.end))?.date,
        checkedAt: new Date(checkedAt).toISOString(), ...(finalClosed.length < required ? { error: 'insufficient_native_closed_candles' } : result.reason ? { error: result.reason } : {}) });
    } catch (error) {
      this.checked.set(key, this.now());
      this.status.set(key, { identity, instrumentId: identity.instrumentId, conid: String(identity.conId), timeframe: tf, required, available: 0,
        nativeClosed: 0, latest: null, latestEnd: null, generation: evidence?.generation, scheduleStatus: evidence?.status ?? 'FAILED',
        checkedAt: new Date(this.now()).toISOString(), error: error instanceof Error ? error.message : 'session_native_refresh_failed' });
    }
  }
}
