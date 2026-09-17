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

export type CmeAggregateTimeframe = "5m" | "1h" | "4h" | "12h" | "1d" | "1w";

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

function weekMonday(id: string): string {
  const day = weekday(id);
  return addUtcDays(id, -(day === 0 ? 6 : day - 1));
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
    const session = this.sessionForTradeDate(sessionId);
    if (!session) return null;
    const { openAt, closeAt } = session;
    return timestamp >= openAt && timestamp < closeAt ? { id: sessionId, openAt, closeAt } : null;
  }

  completedAt(timestamp: Date, timeframe: CmeAggregateTimeframe): Date {
    const session = this.sessionFor(timestamp);
    if (!session) throw new Error("Timestamp is outside a tradable CME session");
    if (timeframe === "1d") return session.closeAt;
    if (timeframe === "1w") {
      const monday = weekMonday(session.id);
      for (let offset = 4; offset >= 0; offset -= 1) {
        const candidate = this.sessionForTradeDate(addUtcDays(monday, offset));
        if (candidate) return candidate.closeAt;
      }
      throw new Error(`CME week ${monday} has no tradable session`);
    }
    const hours = timeframe === "5m" ? 5 / 60
      : timeframe === "1h" ? 1
      : timeframe === "4h" ? 4 : 12;
    const bucketMs = hours * 60 * 60 * 1000;
    const elapsed = timestamp.getTime() - session.openAt.getTime();
    return new Date(Math.min(session.openAt.getTime() + (Math.floor(elapsed / bucketMs) + 1) * bucketMs, session.closeAt.getTime()));
  }

  bucketStart(timestamp: Date, timeframe: CmeAggregateTimeframe): Date {
    const session = this.sessionFor(timestamp);
    if (!session) throw new Error("Timestamp is outside a tradable CME session");
    if (timeframe === "1d" || timeframe === "1w") return session.openAt;
    const minutes = timeframe === "5m" ? 5
      : timeframe === "1h" ? 60
      : timeframe === "4h" ? 240 : 720;
    const bucketMs = minutes * 60_000;
    const elapsed = timestamp.getTime() - session.openAt.getTime();
    return new Date(session.openAt.getTime() + Math.floor(elapsed / bucketMs) * bucketMs);
  }

  tradeWeekId(timestamp: Date): string {
    const session = this.sessionFor(timestamp);
    if (!session) throw new Error("Timestamp is outside a tradable CME session");
    return weekMonday(session.id);
  }

  private sessionForTradeDate(sessionId: string): CmeSession | null {
    this.assertCovered(sessionId);
    if (weekday(sessionId) === 0 || weekday(sessionId) === 6 || this.closures.has(sessionId)) return null;
    // Monday's trade-date session opens Sunday at 17:00 Chicago time.
    return {
      id: sessionId,
      openAt: chicagoWallToUtc(addUtcDays(sessionId, -1), "17:00"),
      closeAt: chicagoWallToUtc(sessionId, this.definition.earlyCloses[sessionId] ?? "16:00"),
    };
  }

  private assertCovered(id: string): void {
    if (id < this.definition.coverageStart || id > this.definition.coverageEnd)
      throw new Error(`CME calendar ${this.definition.version} has no coverage for ${id}`);
  }
}

export function aggregateCmeFuturesCandles(
  candles: readonly Candle[],
  timeframe: CmeAggregateTimeframe,
  calendar: CmeSessionCalendar,
): Candle[] {
  const buckets = new Map<string, { start: Date; rows: Candle[] }>();
  for (const candle of candles) {
    const session = calendar.sessionFor(candle.ts);
    if (!session) continue;
    const weekId = timeframe === "1w" ? calendar.tradeWeekId(candle.ts) : undefined;
    const start = timeframe === "1w"
      ? session.openAt
      : calendar.bucketStart(candle.ts, timeframe);
    const bucketId = timeframe === "1w" ? weekId! : start.toISOString();
    const key = `${candle.symbol.toUpperCase()}|${candle.conid}|${timeframe}|${bucketId}`;
    const bucket = buckets.get(key) ?? { start, rows: [] };
    bucket.rows.push(candle);
    buckets.set(key, bucket);
  }
  const completed: Candle[] = [];
  for (const { start, rows } of buckets.values()) {
    if (timeframe === "1w") {
      try {
        calendar.completedAt(start, timeframe);
      } catch (error) {
        if ((error as Error).message.includes("has no coverage")) continue;
        throw error;
      }
    }
    completed.push({
      symbol: rows[0].symbol, conid: rows[0].conid, timeframe,
      ts: start,
      open: rows[0].open, high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)), close: rows[rows.length - 1].close,
      volume: rows.reduce((sum, r) => sum + r.volume, 0),
    });
  }
  return completed.sort((a, b) => a.ts.getTime() - b.ts.getTime() ||
    Number(a.conid) - Number(b.conid));
}
