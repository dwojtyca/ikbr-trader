import type { Candle, CandleTimeframe } from "./index.js";
export const WSE_REQUIRED_CANDLES = Object.freeze({ "1m": 220, "5m": 50, "1h": 50, "4h": 50, "1d": 50, "1w": 50 });
export type WseTimeframe = keyof typeof WSE_REQUIRED_CANDLES;
export const WSE_NATIVE_SOURCE = "ibkr_wse_native_v1";
const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function warsawMidnight(year: number, month: number, day: number): Date {
  const target = new Date(Date.UTC(year, month - 1, day));
  const wanted = [target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate()];
  for (const offset of [1, 2]) {
    const candidate = new Date(target.getTime() - offset * 3600000);
    const p = Object.fromEntries(local.formatToParts(candidate).map(v => [v.type, v.value]));
    if (+p.year === wanted[0] && +p.month === wanted[1] && +p.day === wanted[2] && p.hour === "00" && p.minute === "00") return candidate;
  }
  throw new Error("wse_calendar_invalid");
}
export function wseCandleEnd(ts: Date, timeframe: CandleTimeframe): number {
  if (!Number.isFinite(ts.getTime())) return NaN;
  const durations: Partial<Record<CandleTimeframe, number>> = { "1m": 60000, "5m": 300000, "1h": 3600000, "4h": 14400000 };
  if (durations[timeframe]) return ts.getTime() + durations[timeframe]!;
  if (timeframe !== "1d" && timeframe !== "1w") return NaN;
  const p = Object.fromEntries(local.formatToParts(ts).map(v => [v.type, v.value]));
  const weekday = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
  const days = timeframe === "1d" ? 1 : (8 - weekday) % 7 || 7;
  return warsawMidnight(+p.year, +p.month, +p.day + days).getTime();
}
export function validClosedWseCandle(c: Candle, nowMs: number): boolean {
  const end = wseCandleEnd(c.ts, c.timeframe);
  return c.source === WSE_NATIVE_SOURCE && Number.isFinite(nowMs) && Number.isFinite(end) && end <= nowMs
    && c.ts.getTime() > 0 && [c.open, c.high, c.low, c.close].every(p => Number.isFinite(p) && p > 0)
    && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)
    && Number.isFinite(c.volume) && c.volume >= 0;
}
