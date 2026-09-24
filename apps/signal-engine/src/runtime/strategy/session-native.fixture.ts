import {
  buildInstrumentSessionIdentity, sessionLocalMidnight, sessionDateAt,
  sessionCandleSlots, sessionNativeSource,
  type BoundInstrument, type Candle, type SessionTimeframe, type InstrumentSessionIdentity, type SessionScheduleEvidence,
} from '@ikbr/shared';

export const SESSION_TIMEFRAMES = ['1m','5m','1h','4h','1d','1w'] as const;
export function fixtureSessionSchedule(identity: InstrumentSessionIdentity, now: Date, openMinutes = 0, closeMinutes = 1440, lookback = 22): SessionScheduleEvidence {
  const today = sessionDateAt(now.getTime(), identity.timeZone);
  const noon = Date.parse(today + 'T12:00:00Z');
  const sessions = [];
  for (let day = lookback; day >= -1; day--) {
    const label = new Date(noon - day * 86400000).toISOString().slice(0,10);
    const weekday = new Date(label + 'T12:00:00Z').getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const midnight = sessionLocalMidnight(label, identity.timeZone);
    sessions.push({ date: label, start: new Date(midnight + openMinutes * 60000).toISOString(), end: new Date(midnight + closeMinutes * 60000).toISOString() });
  }
  return { generation: 1, status: 'READY', updatedAt: now.toISOString(), schedule: {
    source: 'ibkr_session_schedule_v1', identity, coverageStart: new Date(Math.min(Date.parse(sessions[0].start), sessionLocalMidnight(sessions[0].date, identity.timeZone))).toISOString(), coverageEnd: new Date(noon + 2 * 86400000).toISOString(),
    requestedAt: now.toISOString(), receivedAt: now.toISOString(), sessions,
  } };
}
export function fixtureSessionCandles(bound: BoundInstrument, now: Date, openMinutes = 0, closeMinutes = 1440): Record<SessionTimeframe, Candle[]> {
  const identity = buildInstrumentSessionIdentity(bound.instrument, bound);
  const evidence = fixtureSessionSchedule(identity, now, openMinutes, closeMinutes, 800);
  const result = {} as Record<SessionTimeframe, Candle[]>;
  for (const tf of SESSION_TIMEFRAMES) {
    // Limit minute enumeration while retaining enough history for each indicator.
    const days = tf === '1m' || tf === '5m' ? 7 : tf === '1h' ? 30 : tf === '4h' ? 90 : 800;
    const calendar = { ...evidence.schedule!, sessions: evidence.schedule!.sessions.filter(s => Date.parse(s.end) >= now.getTime() - days * 86400000) };
    const slots = sessionCandleSlots(calendar, tf).filter(s => Date.parse(s.end) <= now.getTime()).slice(-(tf === '1m' ? 300 : 60));
    result[tf] = slots.map((slot, i) => ({ conid: String(bound.conId), symbol: bound.brokerSymbol, timeframe: tf,
      ts: new Date(slot.start), source: sessionNativeSource(identity), open: 150 + i * .001,
      high: 150.05 + i * .001, low: 149.95 + i * .001, close: 150 + i * .001, volume: 1000 + i }));
  }
  return result;
}
