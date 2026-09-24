import type { Candle, CandleTimeframe } from "./index.js";

export const AAPL_NATIVE_SOURCE = "ibkr_aapl_rth_native_v1";
export const AAPL_REQUIRED_CANDLES = Object.freeze({ "1m": 220, "5m": 50, "1h": 50, "4h": 50, "1d": 50, "1w": 50 });
export type AaplTimeframe = keyof typeof AAPL_REQUIRED_CANDLES;
const local = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const parts = (date: Date) => Object.fromEntries(local.formatToParts(date).map(value => [value.type, value.value]));

export function newYorkMidnight(year: number, month: number, day: number): Date {
  const target = new Date(Date.UTC(year, month - 1, day));
  if (![year, month, day].every(Number.isInteger) || year < 2000 || year > 2100 ||
    target.getUTCFullYear() !== year || target.getUTCMonth() + 1 !== month || target.getUTCDate() !== day)
    throw new Error("aapl_calendar_invalid");
  for (const offset of [4, 5]) {
    const candidate = new Date(target.getTime() + offset * 3600000), p = parts(candidate);
    if (+p.year === year && +p.month === month && +p.day === day && p.hour === "00" && p.minute === "00") return candidate;
  }
  throw new Error("aapl_calendar_invalid");
}

export function aaplCandleEnd(ts: Date, timeframe: CandleTimeframe): number {
  if (!Number.isFinite(ts.getTime())) return NaN;
  const durations: Partial<Record<CandleTimeframe, number>> = { "1m": 60000, "5m": 300000, "1h": 3600000, "4h": 14400000 };
  if (durations[timeframe]) return ts.getTime() + durations[timeframe]!;
  if (timeframe !== "1d" && timeframe !== "1w") return NaN;
  const p = parts(ts), date = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  date.setUTCDate(date.getUTCDate() + (timeframe === "1d" ? 1 : ((8 - date.getUTCDay()) % 7 || 7)));
  try { return newYorkMidnight(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()).getTime(); }
  catch { return NaN; }
}

export function validClosedAaplCandle(c: Candle, nowMs: number): boolean {
  const end = aaplCandleEnd(c.ts, c.timeframe);
  if (c.source !== AAPL_NATIVE_SOURCE || c.symbol !== "AAPL" || c.conid !== "265598" || !Number.isFinite(nowMs) ||
    !Number.isFinite(end) || end > nowMs || c.ts.getTime() <= 0 || c.ts.getTime() % 60000 !== 0) return false;
  const p = parts(c.ts), weekday = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
  const minute = +p.hour * 60 + +p.minute;
  if (weekday === 0 || weekday === 6 || (c.timeframe === "1d" || c.timeframe === "1w" ? minute !== 0 : minute < 570 || minute >= 960)) return false;
  return [c.open, c.high, c.low, c.close].every(value => Number.isFinite(value) && value > 0)
    && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)
    && Number.isFinite(c.volume) && c.volume >= 0;
}
