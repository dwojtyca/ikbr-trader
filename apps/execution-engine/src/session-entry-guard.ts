import type { Pool, PoolClient } from 'pg';
import { buildInstrumentSessionIdentity, checkSessionWindow, requireSessionSchedule, type BoundInstrument, type SessionScheduleEvidence } from '@ikbr/shared';
export interface SessionEntryOrder { instrumentId?: string | null; instrument: string; conid?: string | null; positionEffect?: string | null }
export type SessionEntryResult = { ok: true; endsAtMs: number; generation: number } | { ok: false; reason: string };
export type SessionEntryGuard = (db: Pick<Pool | PoolClient, 'query'>, order: SessionEntryOrder, window?: { startsAt: string; endsAt: string }) => Promise<SessionEntryResult>;
export const unavailableSessionEntryGuard: SessionEntryGuard = async () => ({ ok: false, reason: 'session_entry_guard_unavailable' });
export function createSessionEntryGuard(resolve: (id: string) => BoundInstrument | null | undefined): SessionEntryGuard {
  return async (db, order, window) => {
    if (order.positionEffect === 'CLOSE_OR_REDUCE') return { ok: false, reason: 'session_close_requires_lifecycle' };
    if (!order.instrumentId) return { ok: false, reason: 'session_entry_binding_required' };
    try {
      const bound = resolve(order.instrumentId);
      if (!bound || bound.instrumentId !== order.instrumentId || bound.brokerSymbol !== order.instrument || String(bound.conId) !== order.conid) return { ok: false, reason: 'session_entry_identity_mismatch' };
      const identity = buildInstrumentSessionIdentity(bound.instrument, bound);
      const result = await db.query(`SELECT generation,status,evidence,updated_at FROM instrument_session_schedules
        WHERE instrument_id=$1 AND conid=$2 AND use_rth=$3 FOR SHARE`, [bound.instrumentId, String(bound.conId), bound.instrument.session.useRegularTradingHours]);
      const row = result.rows[0];
      const now = new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
      const evidence: SessionScheduleEvidence | null = row ? { generation: Number(row.generation), status: row.status, schedule: row.evidence, updatedAt: new Date(row.updated_at).toISOString() } : null;
      const schedule = requireSessionSchedule(evidence, identity, now);
      checkSessionWindow(evidence, identity, now, window ? Date.parse(window.startsAt) : now, window ? Date.parse(window.endsAt) : now + 1);
      const active = schedule.sessions.find(s => Date.parse(s.start) <= now && now < Date.parse(s.end));
      if (!active) return { ok: false, reason: 'session_entry_closed' };
      return { ok: true, generation: evidence!.generation, endsAtMs: Math.min(Date.parse(active.end), Date.parse(schedule.coverageEnd), Date.parse(schedule.receivedAt) + 6 * 3600000, Date.parse(evidence!.updatedAt) + 6 * 3600000, window ? Date.parse(window.endsAt) : Infinity) };
    } catch (error) { return { ok: false, reason: error instanceof Error && /^(session_|instrument_session_)/.test(error.message) ? error.message : 'session_entry_evidence_unavailable' }; }
  };
}
