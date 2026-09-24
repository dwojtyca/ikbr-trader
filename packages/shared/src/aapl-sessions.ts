import type { Candle } from './index.js';
import { AAPL_NATIVE_SOURCE, aaplCandleEnd, newYorkMidnight, validClosedAaplCandle, type AaplTimeframe } from './aapl-candles.js';

export interface AaplSchedule {
  source: 'ibkr_aapl_schedule_v1'; conId: 265598; symbol: 'AAPL'; exchange: 'SMART'; currency: 'USD'; secType: 'STK';
  timeZone: 'America/New_York'; coverageStart: string; coverageEnd: string; requestedAt: string; receivedAt: string;
  sessions: Array<{ date: string; start: string; end: string }>;
}
export interface AaplScheduleEvidence { generation: number; status: 'READY' | 'REFRESHING' | 'FAILED'; updatedAt: string; schedule?: AaplSchedule | null }
export interface AaplSlot { start: string; end: string }
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const local = (ms: number) => Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
const dateAt = (ms: number) => { const p = local(ms); return `${p.year}-${p.month}-${p.day}`; };
const fail = (reason: string): never => { throw new Error(reason); };
const isoMs = (s: string) => { const n = Date.parse(s); if (!Number.isFinite(n) || new Date(n).toISOString() !== s) fail('aapl_schedule_timestamp_invalid'); return n; };
const midnight = (date: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date); if (!m) return fail('aapl_schedule_date_invalid'); return newYorkMidnight(+m[1], +m[2], +m[3]).getTime(); };
const shiftDate = (date: string, days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const monday = (date: string) => shiftDate(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
function brokerTime(value: unknown): string {
  if (typeof value !== 'string') return fail('aapl_schedule_timestamp_invalid');
  const m = /^(\d{4})(\d{2})(\d{2})[ -](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!m) return fail('aapl_schedule_timestamp_invalid');
  newYorkMidnight(+m[1], +m[2], +m[3]);
  const candidates: number[] = [];
  for (const offset of [4, 5]) {
    const n = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + offset, +m[5], +m[6]), p = local(n);
    if (p.year === m[1] && p.month === m[2] && p.day === m[3] && p.hour === m[4] && p.minute === m[5] && p.second === m[6]) candidates.push(n);
  }
  if (candidates.length !== 1) return fail('aapl_schedule_dst_invalid');
  return new Date(candidates[0]).toISOString();
}
function validateSchedule(s: AaplSchedule): void {
  if (!s || s.source !== 'ibkr_aapl_schedule_v1' || s.conId !== 265598 || s.symbol !== 'AAPL' || s.exchange !== 'SMART' || s.currency !== 'USD' || s.secType !== 'STK' || s.timeZone !== 'America/New_York') fail('aapl_schedule_identity_invalid');
  const start = isoMs(s.coverageStart), end = isoMs(s.coverageEnd), request = isoMs(s.requestedAt), received = isoMs(s.receivedAt);
  if (start >= end || request > received || !Array.isArray(s.sessions) || s.sessions.length === 0) fail('aapl_schedule_envelope_invalid');
  let previousEnd = start - 1, previousDate = '';
  for (const session of s.sessions) {
    midnight(session.date);
    const a = isoMs(session.start), b = isoMs(session.end);
    if (a < start || b > end || a >= b || a < previousEnd || session.date <= previousDate || dateAt(a) !== session.date || dateAt(b - 1) !== session.date) fail('aapl_schedule_sessions_invalid');
    previousEnd = b; previousDate = session.date;
  }
}
export function parseBrokerAaplSchedule(raw: { startDateTime: unknown; endDateTime: unknown; timeZone: unknown; sessions: unknown }, requestedAt: string, receivedAt: string): AaplSchedule {
  if (!['US/Eastern', 'America/New_York'].includes(String(raw.timeZone)) || !Array.isArray(raw.sessions)) return fail('aapl_schedule_timezone_invalid');
  const s: AaplSchedule = { source: 'ibkr_aapl_schedule_v1', conId: 265598, symbol: 'AAPL', exchange: 'SMART', currency: 'USD', secType: 'STK', timeZone: 'America/New_York', coverageStart: brokerTime(raw.startDateTime), coverageEnd: brokerTime(raw.endDateTime), requestedAt, receivedAt,
    sessions: raw.sessions.map((row: { refDate: unknown; startDateTime: unknown; endDateTime: unknown }) => {
      if (typeof row.refDate !== 'string' || !/^\d{8}$/.test(row.refDate)) return fail('aapl_schedule_date_invalid');
      return { date: `${row.refDate.slice(0, 4)}-${row.refDate.slice(4, 6)}-${row.refDate.slice(6)}`, start: brokerTime(row.startDateTime), end: brokerTime(row.endDateTime) };
    }) };
  validateSchedule(s); return s;
}
export function requireAaplSchedule(e: AaplScheduleEvidence | null | undefined, nowMs: number): AaplSchedule {
  if (!e || e.status !== 'READY' || !Number.isSafeInteger(e.generation) || e.generation <= 0 || !e.schedule) return fail('aapl_schedule_unavailable');
  validateSchedule(e.schedule);
  const age = nowMs - isoMs(e.schedule.receivedAt), updated = isoMs(e.updatedAt);
  if (!Number.isFinite(nowMs) || age < 0 || age > 6 * 3600000 || updated > nowMs || nowMs - updated > 6 * 3600000) return fail('aapl_schedule_stale');
  const priorMonday = midnight(shiftDate(monday(dateAt(nowMs)), -7));
  if (isoMs(e.schedule.coverageStart) > priorMonday || isoMs(e.schedule.coverageEnd) < nowMs) return fail('aapl_schedule_coverage_missing');
  return e.schedule;
}
export function checkAaplSessionWindow(e: AaplScheduleEvidence | null | undefined, nowMs: number, startMs: number, endMs: number): void {
  const s = requireAaplSchedule(e, nowMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs || !s.sessions.some(x => nowMs >= isoMs(x.start) && nowMs < isoMs(x.end) && startMs >= isoMs(x.start) && endMs <= isoMs(x.end))) fail('aapl_session_window_invalid');
}
function slots(tf: AaplTimeframe, s: AaplSchedule): AaplSlot[] {
  if (tf === '1w') {
    const weeks = new Map<string, string>();
    for (const x of s.sessions) weeks.set(monday(x.date), x.date);
    return [...weeks].filter(([week]) => midnight(week) >= isoMs(s.coverageStart) && midnight(shiftDate(week, 7)) <= isoMs(s.coverageEnd)).map(([week, label]) => ({ start: new Date(midnight(label)).toISOString(), end: new Date(midnight(shiftDate(week, 7))).toISOString() }));
  }
  if (tf === '1d') return s.sessions.map(x => ({ start: new Date(midnight(x.date)).toISOString(), end: new Date(midnight(shiftDate(x.date, 1))).toISOString() }));
  const duration = { '1m': 60000, '5m': 300000, '1h': 3600000, '4h': 14400000 }[tf];
  const result: AaplSlot[] = [];
  for (const x of s.sessions) {
    const origin = tf === "4h" ? 0 : midnight(x.date), end = isoMs(x.end);
    let start = isoMs(x.start);
    while (start < end) {
      const next = Math.min(origin + (Math.floor((start - origin) / duration) + 1) * duration, end);
      result.push({ start: new Date(start).toISOString(), end: new Date(next).toISOString() }); start = next;
    }
  }
  return result;
}
export function aaplExpectedSlot(tf: AaplTimeframe, s: AaplSchedule, nowMs: number): AaplSlot | undefined {
  validateSchedule(s); return slots(tf, s).filter(x => isoMs(x.end) <= nowMs).at(-1);
}
export function aaplSessionCandleEnd(ts: Date, tf: AaplTimeframe, s: AaplSchedule): number {
  const date = dateAt(ts.getTime());
  if (ts.getTime() < isoMs(s.coverageStart) || (tf === "1w" && midnight(monday(date)) < isoMs(s.coverageStart))) return aaplCandleEnd(ts, tf);
  if (midnight(date) >= isoMs(s.coverageEnd)) return NaN;
  return Date.parse(slots(tf, s).find(x => x.start === ts.toISOString())?.end ?? '');
}
export function filterClosedAaplCandles(rows: Candle[], tf: AaplTimeframe, s: AaplSchedule, nowMs: number): Candle[] {
  validateSchedule(s);
  if (!Number.isFinite(nowMs)) fail('aapl_schedule_timestamp_invalid');
  const valid: Candle[] = [];
  const lattice = new Map(slots(tf, s).map(x => [isoMs(x.start), isoMs(x.end)]));
  for (const c of rows) {
    const start = c.ts.getTime();
    if (c.timeframe !== tf || c.source !== AAPL_NATIVE_SOURCE || c.symbol !== 'AAPL' || c.conid !== '265598' || !Number.isFinite(start)) continue;
    if (start < isoMs(s.coverageStart) || (tf === "1w" && midnight(monday(dateAt(start))) < isoMs(s.coverageStart))) { if (validClosedAaplCandle(c, nowMs)) valid.push(c); continue; }
    if (start >= isoMs(s.coverageEnd)) continue;
    if (tf === '1w' && aaplCandleEnd(c.ts, tf) > nowMs) continue;
    const end = lattice.get(start);
    if (end === undefined) fail('aapl_candle_alignment_invalid');
    if (end! > nowMs) continue;
    if (![c.open, c.high, c.low, c.close].every(v => Number.isFinite(v) && v > 0) || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) || !Number.isFinite(c.volume) || c.volume < 0) continue;
    valid.push(c);
  }
  return valid.sort((a, b) => a.ts.getTime() - b.ts.getTime());
}
export function evaluateAaplCandles(rows: Candle[], tf: AaplTimeframe, evidence: AaplScheduleEvidence | null | undefined, nowMs: number): { candles: Candle[]; expectedStart?: string; expectedEnd?: string; latestStart?: string; latestEnd?: string; reason?: string } {
  try {
    const s = requireAaplSchedule(evidence, nowMs), active = s.sessions.find(x => isoMs(x.start) <= nowMs && nowMs < isoMs(x.end));
    const candles = filterClosedAaplCandles(rows, tf, s, nowMs), eligible = slots(tf, s).filter(x => isoMs(x.end) <= nowMs), expected = eligible.at(-1), previous = eligible.at(-2), latest = candles.at(-1);
    const result = { candles, expectedStart: expected?.start, expectedEnd: expected?.end, latestStart: latest?.ts.toISOString(), latestEnd: latest ? new Date(aaplSessionCandleEnd(latest.ts, tf, s)).toISOString() : undefined };
    if (!active) return { ...result, reason: 'aapl_session_closed' };
    if (!expected) return { ...result, reason: 'aapl_expected_slot_unavailable' };
    if (tf === '1m' && (!latest || latest.ts.getTime() < isoMs(active.start))) return { ...result, reason: 'aapl_current_session_minute_missing' };
    if (result.latestStart === expected.start) return result;
    if (previous && nowMs - isoMs(expected.end) <= 90000 && result.latestStart === previous.start) return result;
    return { ...result, reason: 'aapl_expected_candle_missing' };
  } catch (error) { return { candles: [], reason: error instanceof Error ? error.message : 'aapl_schedule_invalid' }; }
}
