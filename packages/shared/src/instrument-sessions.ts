import type { Candle } from './index.js';
import type { Instrument } from './instruments/types.js';
import type { BoundInstrument } from './instruments/bindings.js';
import { mapAssetClassToIbkrSecType } from './instruments/bindings.js';

export const SESSION_REQUIRED_CANDLES = Object.freeze({ '1m': 220, '5m': 50, '1h': 50, '4h': 50, '1d': 50, '1w': 50 });
export type SessionTimeframe = keyof typeof SESSION_REQUIRED_CANDLES;
export interface InstrumentSessionIdentity {
  instrumentId: string; conId: number; symbol: string; secType: string; exchange: string; currency: string;
  localSymbol?: string; tradingClass?: string; primaryExchange?: string; useRTH: boolean; timeZone: string;
}
export interface SessionInterval { date: string; start: string; end: string }
export interface SessionSchedule {
  source: 'ibkr_session_schedule_v1'; identity: InstrumentSessionIdentity;
  coverageStart: string; coverageEnd: string; requestedAt: string; receivedAt: string; sessions: SessionInterval[];
}
export interface SessionScheduleEvidence {
  generation: number; status: 'READY' | 'REFRESHING' | 'FAILED'; updatedAt: string; schedule?: SessionSchedule | null;
}
export interface SessionSlot { start: string; end: string; alternativeStarts?: readonly string[] }
export function matchesSessionSlot(start: string | undefined, slot: SessionSlot | undefined): boolean {
  return start !== undefined && slot !== undefined && (start === slot.start || slot.alternativeStarts?.includes(start) === true);
}
const fail = (reason: string): never => { throw new Error(reason); };
const formatters = new Map<string, Intl.DateTimeFormat>();
export function canonicalSessionTimeZone(zone: string): string {
  try { return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone; }
  catch { return fail('session_timezone_invalid'); }
}
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) { value = new Intl.DateTimeFormat('en-CA', { timeZone: canonicalSessionTimeZone(zone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); formatters.set(zone, value); }
  return value;
}
function localParts(ms: number, zone: string): Record<string, string> {
  return Object.fromEntries(formatter(zone).formatToParts(ms).map(p => [p.type, p.value]));
}
export function sessionDateAt(ms: number, zone: string): string {
  const p = localParts(ms, zone); return `${p.year}-${p.month}-${p.day}`;
}
function validDate(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date || Number(date.slice(0, 4)) < 2000 || Number(date.slice(0, 4)) > 2100) return fail('session_date_invalid');
  return ms;
}
export function shiftSessionDate(date: string, days: number): string { return new Date(validDate(date) + days * 86400000).toISOString().slice(0, 10); }
function monday(date: string): string { return shiftSessionDate(date, -((new Date(validDate(date)).getUTCDay() + 6) % 7)); }
export function sessionLocalTime(date: string, hour: number, minute: number, second: number, zone: string): number {
  const base = validDate(date);
  if (![hour, minute, second].every(Number.isInteger) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return fail('session_timestamp_invalid');
  const target = base + (hour * 3600 + minute * 60 + second) * 1000;
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const sample = target + delta * 3600000, p = localParts(sample, zone);
    offsets.add(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - sample);
  }
  const matches = [...offsets].map(offset => target - offset).filter(ms => {
    const p = localParts(ms, zone);
    return `${p.year}-${p.month}-${p.day}` === date && +p.hour === hour && +p.minute === minute && +p.second === second;
  });
  if (matches.length !== 1) return fail('session_dst_invalid');
  return matches[0];
}
const midnightCache = new Map<string, number>();
export function sessionLocalMidnight(date: string, zone: string): number {
  const key = `${zone}:${date}`, cached = midnightCache.get(key);
  if (cached !== undefined) return cached;
  const value = sessionLocalTime(date, 0, 0, 0, zone);
  if (midnightCache.size >= 4096) midnightCache.clear();
  midnightCache.set(key, value); return value;
}
function isoMs(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return fail('session_timestamp_invalid');
  return ms;
}
function brokerTime(value: unknown, zone: string): string {
  if (typeof value !== 'string') return fail('session_timestamp_invalid');
  const match = /^(\d{4})(\d{2})(\d{2})[ -](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return fail('session_timestamp_invalid');
  return new Date(sessionLocalTime(`${match[1]}-${match[2]}-${match[3]}`, +match[4], +match[5], +match[6], zone)).toISOString();
}
function validateIdentity(identity: InstrumentSessionIdentity): void {
  if (!identity || !Number.isSafeInteger(identity.conId) || identity.conId <= 0 || typeof identity.useRTH !== 'boolean') fail('session_identity_invalid');
  for (const key of ['instrumentId', 'symbol', 'secType', 'exchange', 'currency', 'timeZone'] as const)
    if (typeof identity[key] !== 'string' || !identity[key].trim() || identity[key] !== identity[key].trim()) fail('session_identity_invalid');
  for (const key of ['localSymbol', 'tradingClass', 'primaryExchange'] as const)
    if (identity[key] !== undefined && (typeof identity[key] !== 'string' || !identity[key]!.trim() || identity[key] !== identity[key]!.trim())) fail('session_identity_invalid');
  canonicalSessionTimeZone(identity.timeZone);
}
function identityEqual(a: InstrumentSessionIdentity, b: InstrumentSessionIdentity): boolean {
  validateIdentity(a); validateIdentity(b);
  return (['instrumentId', 'conId', 'symbol', 'secType', 'exchange', 'currency', 'localSymbol', 'tradingClass', 'primaryExchange', 'useRTH'] as const).every(k => a[k] === b[k])
    && canonicalSessionTimeZone(a.timeZone) === canonicalSessionTimeZone(b.timeZone);
}
export function buildInstrumentSessionIdentity(instrument: Instrument, bound: BoundInstrument): InstrumentSessionIdentity {
  if (bound.instrumentId !== instrument.id || bound.brokerSymbol !== instrument.brokerSymbol || bound.currency !== instrument.currency || bound.exchange !== instrument.exchange) return fail('session_binding_identity_invalid');
  const identity: InstrumentSessionIdentity = { instrumentId: instrument.id, conId: bound.conId, symbol: bound.brokerSymbol,
    secType: mapAssetClassToIbkrSecType(instrument.assetClass), exchange: bound.exchange, currency: bound.currency,
    localSymbol: bound.localSymbol, tradingClass: bound.tradingClass,
    ...(instrument.primaryExchange ? { primaryExchange: instrument.primaryExchange } : {}),
    useRTH: instrument.session.useRegularTradingHours, timeZone: canonicalSessionTimeZone(instrument.session.timezone) };
  validateIdentity(identity); return identity;
}
export function sessionNativeSource(identity: Pick<InstrumentSessionIdentity, 'useRTH'>): string {
  if (typeof identity.useRTH !== 'boolean') return fail('session_mode_invalid');
  return identity.useRTH ? 'ibkr_session_rth_native_v1' : 'ibkr_session_full_native_v1';
}
export function validateSessionSchedule(schedule: SessionSchedule, identity: InstrumentSessionIdentity = schedule?.identity): void {
  if (!schedule || schedule.source !== 'ibkr_session_schedule_v1' || !identityEqual(schedule.identity, identity)) fail('session_schedule_identity_invalid');
  const start = isoMs(schedule.coverageStart), end = isoMs(schedule.coverageEnd), request = isoMs(schedule.requestedAt), received = isoMs(schedule.receivedAt);
  if (start >= end || request > received || !Array.isArray(schedule.sessions) || !schedule.sessions.length) fail('session_schedule_envelope_invalid');
  let previousEnd = start, previousDate = '';
  for (const session of schedule.sessions) {
    validDate(session.date);
    const a = isoMs(session.start), b = isoMs(session.end);
    const ref = validDate(session.date), localStart = validDate(sessionDateAt(a, identity.timeZone)), localEnd = validDate(sessionDateAt(b - 1, identity.timeZone));
    if (a < start || b > end || a >= b || a < previousEnd || session.date < previousDate || b - a > 48 * 3600000 || Math.abs(localStart - ref) > 86400000 || Math.abs(localEnd - ref) > 86400000) fail('session_schedule_intervals_invalid');
    previousEnd = b; previousDate = session.date;
  }
}
export function parseBrokerSessionSchedule(raw: { startDateTime: unknown; endDateTime: unknown; timeZone: unknown; sessions: unknown }, identity: InstrumentSessionIdentity, requestedAt: string, receivedAt: string): SessionSchedule {
  validateIdentity(identity);
  if (typeof raw.timeZone !== 'string' || canonicalSessionTimeZone(raw.timeZone) !== canonicalSessionTimeZone(identity.timeZone) || !Array.isArray(raw.sessions)) return fail('session_schedule_timezone_invalid');
  const schedule: SessionSchedule = { source: 'ibkr_session_schedule_v1', identity: { ...identity, timeZone: canonicalSessionTimeZone(raw.timeZone) },
    coverageStart: brokerTime(raw.startDateTime, raw.timeZone), coverageEnd: brokerTime(raw.endDateTime, raw.timeZone), requestedAt, receivedAt,
    sessions: raw.sessions.map(row => {
      if (!row || typeof row.refDate !== 'string' || !/^\d{8}$/.test(row.refDate)) return fail('session_date_invalid');
      return { date: `${row.refDate.slice(0, 4)}-${row.refDate.slice(4, 6)}-${row.refDate.slice(6)}`, start: brokerTime(row.startDateTime, raw.timeZone as string), end: brokerTime(row.endDateTime, raw.timeZone as string) };
    }) };
  validateSessionSchedule(schedule, identity); return schedule;
}
export function requireSessionHistorySchedule(evidence: SessionScheduleEvidence | null | undefined, identity: InstrumentSessionIdentity, nowMs: number): SessionSchedule {
  if (!evidence || evidence.status !== 'READY' || !Number.isSafeInteger(evidence.generation) || evidence.generation <= 0 || !evidence.schedule) return fail('session_schedule_unavailable');
  const schedule = evidence.schedule;
  validateSessionSchedule(schedule, identity);
  const received = isoMs(schedule.receivedAt), updated = isoMs(evidence.updatedAt);
  if (!Number.isFinite(nowMs) || nowMs < received || nowMs < updated || nowMs - received > 6 * 3600000 || nowMs - updated > 6 * 3600000) return fail('session_schedule_stale');
  const priorSunday = sessionLocalMidnight(shiftSessionDate(monday(sessionDateAt(nowMs, identity.timeZone)), -8), identity.timeZone);
  const currentMonday = sessionLocalMidnight(monday(sessionDateAt(nowMs, identity.timeZone)), identity.timeZone);
  if (isoMs(schedule.coverageStart) > priorSunday || isoMs(schedule.coverageEnd) < currentMonday) return fail('session_schedule_coverage_missing');
  return schedule;
}
export function requireSessionSchedule(evidence: SessionScheduleEvidence | null | undefined, identity: InstrumentSessionIdentity, nowMs: number): SessionSchedule {
  const schedule = requireSessionHistorySchedule(evidence, identity, nowMs);
  if (isoMs(schedule.coverageEnd) < nowMs) return fail('session_schedule_coverage_missing');
  return schedule;
}
export function checkSessionWindow(evidence: SessionScheduleEvidence | null | undefined, identity: InstrumentSessionIdentity, nowMs: number, startMs: number, endMs: number): void {
  const schedule = requireSessionSchedule(evidence, identity, nowMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || !schedule.sessions.some(x => nowMs >= isoMs(x.start) && nowMs < isoMs(x.end) && startMs >= isoMs(x.start) && endMs <= isoMs(x.end))) fail('session_window_invalid');
}
const slotCache = new WeakMap<SessionSchedule, { signature: string; values: Map<SessionTimeframe, SessionSlot[]> }>();
export function sessionCandleSlots(schedule: SessionSchedule, timeframe: SessionTimeframe): SessionSlot[] {
  validateSessionSchedule(schedule);
  if (!Object.hasOwn(SESSION_REQUIRED_CANDLES, timeframe)) return fail('session_timeframe_unsupported');
  const signature = JSON.stringify([schedule.identity, schedule.coverageStart, schedule.coverageEnd, schedule.sessions]);
  const previous = slotCache.get(schedule);
  const cache = previous?.signature === signature ? previous : { signature, values: new Map<SessionTimeframe, SessionSlot[]>() };
  const cached = cache.values.get(timeframe);
  if (cached) return cached;
  const zone = schedule.identity.timeZone, result: SessionSlot[] = [];
  const add = (start: number, end: number, alternativeStart?: number) => result.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(alternativeStart === undefined ? {} : { alternativeStarts: Object.freeze([new Date(alternativeStart).toISOString()]) }) });
  if (timeframe === '1d' || timeframe === '1w') {
    const groups = new Map<string, SessionInterval[]>();
    for (const session of schedule.sessions) {
      const key = timeframe === '1d' ? session.date : monday(session.date);
      groups.set(key, [...(groups.get(key) ?? []), session]);
    }
    for (const [key, intervals] of groups) {
      if (timeframe === '1w' && sessionLocalMidnight(shiftSessionDate(key, -1), zone) < isoMs(schedule.coverageStart)) continue;
      const label = timeframe === '1d' ? key : intervals.at(-1)!.date;
      const boundary = sessionLocalMidnight(shiftSessionDate(key, timeframe === '1d' ? 1 : 7), zone);
      if (timeframe === '1w' && boundary > isoMs(schedule.coverageEnd)) continue;
      add(sessionLocalMidnight(label, zone), Math.max(boundary, ...intervals.map(x => isoMs(x.end))), timeframe === '1w' ? sessionLocalMidnight(shiftSessionDate(label, 1), zone) : undefined);
    }
  } else {
    const duration = { '1m': 60000, '5m': 300000, '1h': 3600000, '4h': 14400000 }[timeframe];
    for (const interval of schedule.sessions) {
      const end = isoMs(interval.end);
      let start = isoMs(interval.start);
      while (start < end) {
        const origin = timeframe === '4h' ? 0 : sessionLocalMidnight(sessionDateAt(start, zone), zone);
        const next = Math.min(origin + (Math.floor((start - origin) / duration) + 1) * duration, end);
        if (next <= start) return fail('session_slot_invalid');
        add(start, next); start = next;
      }
    }
  }
  for (const slot of result) Object.freeze(slot);
  Object.freeze(result);
  cache.values.set(timeframe, result); slotCache.set(schedule, cache);
  return result;
}
export function expectedSessionSlot(timeframe: SessionTimeframe, schedule: SessionSchedule, nowMs: number): SessionSlot | undefined {
  return sessionCandleSlots(schedule, timeframe).filter(x => isoMs(x.end) <= nowMs).at(-1);
}
function olderCandleEnd(candle: Candle, identity: InstrumentSessionIdentity): number {
  const start = candle.ts.getTime(), zone = identity.timeZone;
  const duration: Partial<Record<SessionTimeframe, number>> = { '1m': 60000, '5m': 300000, '1h': 3600000, '4h': 14400000 };
  if (duration[candle.timeframe as SessionTimeframe]) return start + duration[candle.timeframe as SessionTimeframe]!;
  const date = sessionDateAt(start, zone);
  if (start !== sessionLocalMidnight(date, zone)) return NaN;
  if (candle.timeframe === '1d') return sessionLocalMidnight(shiftSessionDate(date, 2), zone);
  if (candle.timeframe === '1w') return sessionLocalMidnight(shiftSessionDate(monday(date), 8), zone);
  return NaN;
}
export function filterClosedSessionCandles(rows: Candle[], timeframe: SessionTimeframe, schedule: SessionSchedule, nowMs: number): Candle[] {
  validateSessionSchedule(schedule);
  if (!Number.isFinite(nowMs)) return fail('session_timestamp_invalid');
  const lattice = new Map<number, SessionSlot[]>();
  for (const slot of sessionCandleSlots(schedule, timeframe)) for (const start of [slot.start, ...(slot.alternativeStarts ?? [])]) {
    const key = isoMs(start); lattice.set(key, [...(lattice.get(key) ?? []), slot]);
  }
  const result: Candle[] = [], seen = new Set<number>(), seenPeriods = new Set<string>(), identity = schedule.identity;
  for (const candle of rows) {
    const start = candle.ts instanceof Date ? candle.ts.getTime() : NaN;
    if (candle.timeframe !== timeframe || candle.source !== sessionNativeSource(identity) || candle.symbol !== identity.symbol || candle.conid !== String(identity.conId) || !Number.isFinite(start)) return fail('session_candle_identity_invalid');
    if (seen.has(start)) return fail('session_candle_duplicate');
    seen.add(start);
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) || candle.low > Math.min(candle.open, candle.close) || candle.high < Math.max(candle.open, candle.close) || !Number.isFinite(candle.volume) || (candle.volume < 0 && candle.volume !== -1)) return fail('session_candle_values_invalid');
    if (start % 60000 !== 0) return fail('session_candle_alignment_invalid');
    const older = start < isoMs(schedule.coverageStart) || (timeframe === '1w' && sessionLocalMidnight(shiftSessionDate(monday(sessionDateAt(start, identity.timeZone)), -1), identity.timeZone) < isoMs(schedule.coverageStart));
    const matches = lattice.get(start) ?? [];
    if (matches.length > 1) return fail('session_weekly_label_ambiguous');
    if (timeframe === '1w' && older && new Date(validDate(sessionDateAt(start, identity.timeZone))).getUTCDay() === 1) return fail('session_weekly_label_ambiguous');
    const end = older ? olderCandleEnd(candle, identity) : matches[0] ? isoMs(matches[0].end) : undefined;
    if (timeframe === '1w') {
      const period = older ? monday(sessionDateAt(start, identity.timeZone)) : matches[0]?.end;
      if (period !== undefined) {
        if (seenPeriods.has(period)) return fail('session_candle_duplicate_period');
        seenPeriods.add(period);
      }
      // A broker can label its provisional week with today's date before its final label is known.
      if (end === undefined && sessionLocalMidnight(shiftSessionDate(monday(sessionDateAt(start, identity.timeZone)), 7), identity.timeZone) > nowMs) continue;
    }
    if (start >= isoMs(schedule.coverageEnd) && end === undefined) continue;
    if (end === undefined || !Number.isFinite(end)) return fail('session_candle_alignment_invalid');
    if (end > nowMs) continue;
    result.push(candle);
  }
  return result.sort((a, b) => a.ts.getTime() - b.ts.getTime());
}
export function evaluateSessionCandles(rows: Candle[], timeframe: SessionTimeframe, evidence: SessionScheduleEvidence | null | undefined, identity: InstrumentSessionIdentity, nowMs: number): { candles: Candle[]; expectedStart?: string; expectedEnd?: string; latestStart?: string; latestEnd?: string; reason?: string } {
  try {
    const schedule = requireSessionSchedule(evidence, identity, nowMs), active = schedule.sessions.find(x => isoMs(x.start) <= nowMs && nowMs < isoMs(x.end));
    const candles = filterClosedSessionCandles(rows, timeframe, schedule, nowMs);
    const eligible = sessionCandleSlots(schedule, timeframe).filter(x => isoMs(x.end) <= nowMs);
    const expected = eligible.at(-1), previous = eligible.at(-2), latest = candles.at(-1);
    const latestSlot = latest && sessionCandleSlots(schedule, timeframe).find(x => matchesSessionSlot(latest.ts.toISOString(), x));
    const result = { candles, expectedStart: expected?.start, expectedEnd: expected?.end, latestStart: latest?.ts.toISOString(), latestEnd: latestSlot?.end };
    if (!active) return { ...result, reason: 'session_closed' };
    if (!expected) return { ...result, reason: 'session_expected_slot_unavailable' };
    if (timeframe === '1m' && (!latest || latest.ts.getTime() < isoMs(active.start))) return { ...result, reason: 'session_current_interval_minute_missing' };
    if (matchesSessionSlot(result.latestStart, expected)) return result;
    if (previous && nowMs - isoMs(expected.end) <= 90000 && matchesSessionSlot(result.latestStart, previous)) return result;
    return { ...result, reason: 'session_expected_candle_missing' };
  } catch (error) { return { candles: [], reason: error instanceof Error ? error.message : 'session_schedule_invalid' }; }
}
