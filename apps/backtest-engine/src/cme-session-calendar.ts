import type { Candle } from "@ikbr/shared";

export interface CmeCalendarDefinition {
  version: string;
  coverageStart: string;
  coverageEnd: string;
  fullClosures: readonly string[];
  earlyCloses: Readonly<Record<string, string>>;
}

export interface CmeSession {
  id: string;
  openAt: Date;
  closeAt: Date;
}

export function parseCmeCalendarsJson(raw: string): ReadonlyMap<string, CmeCalendarDefinition> {
  if (!raw.trim()) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("BACKTEST_FUTURES_CALENDARS_JSON must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("BACKTEST_FUTURES_CALENDARS_JSON must be an object");
  const out = new Map<string, CmeCalendarDefinition>();
  for (const [version, rawValue] of Object.entries(parsed)) {
    const value = rawValue as Partial<CmeCalendarDefinition>;
    if (value.version !== version || typeof value.coverageStart !== "string" ||
      typeof value.coverageEnd !== "string" || !Array.isArray(value.fullClosures) ||
      !value.earlyCloses || typeof value.earlyCloses !== "object")
      throw new Error(`Malformed CME calendar definition ${version}`);
    const definition: CmeCalendarDefinition = {
      version, coverageStart: value.coverageStart, coverageEnd: value.coverageEnd,
      fullClosures: value.fullClosures.map(String),
      earlyCloses: Object.fromEntries(Object.entries(value.earlyCloses).map(([k, v]) => [k, String(v)])),
    };
    new CmeSessionCalendar(definition);
    out.set(version, Object.freeze(definition));
  }
  return out;
}

const TIME_ZONE = "America/Chicago";
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function wallParts(date: Date): Record<string, number> {
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((p) => p.type !== "literal")
    .map((p) => [p.type, Number(p.value)]));
}

function dateId(parts: Record<string, number>): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addUtcDays(id: string, days: number): string {
  const [year, month, day] = id.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekday(id: string): number {
  return new Date(`${id}T12:00:00Z`).getUTCDay();
}

export function chicagoWallToUtc(id: string, time: string): Date {
  const [year, month, day] = id.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let i = 0; i < 3; i += 1) {
    const p = wallParts(new Date(guess));
    const actual = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += desired - actual;
  }
  return new Date(guess);
}

export class CmeSessionCalendar {
  private readonly closures: Set<string>;

  constructor(private readonly definition: CmeCalendarDefinition) {
    if (!definition.version.trim()) throw new Error("Calendar version is required");
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const validDate = (value: string) => datePattern.test(value) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!validDate(definition.coverageStart) || !validDate(definition.coverageEnd))
      throw new Error("Calendar coverage must use valid YYYY-MM-DD dates");
    if (definition.coverageStart > definition.coverageEnd)
      throw new Error("Invalid calendar coverage");
    for (const closure of definition.fullClosures) {
      if (!validDate(closure) || closure < definition.coverageStart || closure > definition.coverageEnd)
        throw new Error(`Invalid or uncovered full closure ${closure}`);
    }
    for (const [date, time] of Object.entries(definition.earlyCloses)) {
      if (!validDate(date) || date < definition.coverageStart || date > definition.coverageEnd ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || time > "16:00")
        throw new Error(`Invalid or uncovered early close ${date}`);
    }
    this.closures = new Set(definition.fullClosures);
  }

  sessionFor(timestamp: Date): CmeSession | null {
    if (Number.isNaN(timestamp.getTime())) throw new Error("Invalid timestamp");
    const p = wallParts(timestamp);
    const localId = dateId(p);
    const minutes = p.hour * 60 + p.minute;
    let sessionId = localId;
    if (minutes >= 17 * 60) sessionId = addUtcDays(localId, 1);
    this.assertCovered(sessionId);
    if (weekday(sessionId) === 0 || weekday(sessionId) === 6 || this.closures.has(sessionId)) return null;
    // Monday's trade-date session opens Sunday at 17:00 Chicago time.
    const openAt = chicagoWallToUtc(addUtcDays(sessionId, -1), "17:00");
    const closeAt = chicagoWallToUtc(sessionId, this.definition.earlyCloses[sessionId] ?? "16:00");
    return timestamp >= openAt && timestamp < closeAt ? { id: sessionId, openAt, closeAt } : null;
  }

  completedAt(timestamp: Date, timeframe: "1h" | "4h" | "1d"): Date {
    const session = this.sessionFor(timestamp);
    if (!session) throw new Error("Timestamp is outside a tradable CME session");
    if (timeframe === "1d") return session.closeAt;
    const bucketMs = (timeframe === "1h" ? 1 : 4) * 60 * 60 * 1000;
    const elapsed = timestamp.getTime() - session.openAt.getTime();
    return new Date(Math.min(session.openAt.getTime() + (Math.floor(elapsed / bucketMs) + 1) * bucketMs, session.closeAt.getTime()));
  }

  private assertCovered(id: string): void {
    if (id < this.definition.coverageStart || id > this.definition.coverageEnd)
      throw new Error(`CME calendar ${this.definition.version} has no coverage for ${id}`);
  }
}

export function aggregateCmeFuturesCandles(
  candles: readonly Candle[],
  timeframe: "1h" | "4h" | "1d",
  calendar: CmeSessionCalendar,
): Candle[] {
  const buckets = new Map<string, { start: Date; rows: Candle[] }>();
  for (const candle of candles) {
    const session = calendar.sessionFor(candle.ts);
    if (!session) continue;
    const bucketMs = timeframe === "1d" ? Number.POSITIVE_INFINITY
      : (timeframe === "1h" ? 1 : 4) * 60 * 60 * 1000;
    const offset = timeframe === "1d" ? 0
      : Math.floor((candle.ts.getTime() - session.openAt.getTime()) / bucketMs) * bucketMs;
    const start = new Date(session.openAt.getTime() + offset);
    const key = `${candle.symbol.toUpperCase()}|${candle.conid}|${session.id}|${timeframe}|${start.toISOString()}`;
    const bucket = buckets.get(key) ?? { start, rows: [] };
    bucket.rows.push(candle);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(({ start, rows }) => ({
    symbol: rows[0].symbol, conid: rows[0].conid, timeframe,
    ts: start,
    open: rows[0].open, high: Math.max(...rows.map((r) => r.high)),
    low: Math.min(...rows.map((r) => r.low)), close: rows[rows.length - 1].close,
    volume: rows.reduce((sum, r) => sum + r.volume, 0),
  })).sort((a, b) => a.ts.getTime() - b.ts.getTime());
}
