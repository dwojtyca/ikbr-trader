export const IBKR_ES_BAR_SOURCE_VERSION = "ibkr-es-1m-trades-v1";

export const IBKR_ES_BAR_REQUEST = Object.freeze({
  provider: "IBKR TWS API",
  secType: "FUT",
  symbol: "ES",
  tradingClass: "ES",
  exchange: "CME",
  currency: "USD",
  multiplier: "50",
  includeExpired: true,
  barSize: "1 min",
  whatToShow: "TRADES",
  useRTH: 0,
  formatDate: 2,
  keepUpToDate: false,
} as const);

export const CME_EQUITY_INDEX_CALENDAR_VERSION = "cme-equity-index-2024-2026-v1";
export const CME_EQUITY_INDEX_CALENDAR_V1 = Object.freeze({
  version: CME_EQUITY_INDEX_CALENDAR_VERSION,
  coverageStart: "2024-12-22",
  coverageEnd: "2026-08-31",
  fullClosures: Object.freeze(["2024-12-25", "2025-01-01", "2025-12-25", "2026-01-01"]),
  earlyCloses: Object.freeze({
  "2024-12-24": "12:15", "2025-01-20": "12:00", "2025-02-17": "12:00",
  "2025-01-09": "08:30",
  "2025-04-18": "08:15", "2025-05-26": "12:00", "2025-06-19": "12:00",
  "2025-07-03": "12:15", "2025-07-04": "12:00", "2025-09-01": "12:00",
  "2025-11-27": "12:00", "2025-11-28": "12:15", "2025-12-24": "12:15",
  "2026-01-19": "12:00", "2026-02-16": "12:00", "2026-04-03": "08:15",
  "2026-05-25": "12:00", "2026-06-19": "12:00", "2026-07-03": "12:00",
  }),
});
const CME_FULL_CLOSURES = new Set(CME_EQUITY_INDEX_CALENDAR_V1.fullClosures);
const cmeWallClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function addDateDays(id: string, days: number): string {
  const [year, month, day] = id.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function isCmeEquityIndexOpenMinuteV1(timestamp: Date): boolean {
  if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() % 60_000 !== 0) return false;
  const parts = Object.fromEntries(cmeWallClock.formatToParts(timestamp)
    .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const localId = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const minute = parts.hour * 60 + parts.minute;
  const sessionId = minute >= 17 * 60 ? addDateDays(localId, 1) : localId;
  if (sessionId < CME_EQUITY_INDEX_CALENDAR_V1.coverageStart || sessionId > CME_EQUITY_INDEX_CALENDAR_V1.coverageEnd) return false;
  const weekday = new Date(`${sessionId}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || CME_FULL_CLOSURES.has(sessionId)) return false;
  if (minute >= 16 * 60 && minute < 17 * 60) return false;
  const close: string | undefined = CME_EQUITY_INDEX_CALENDAR_V1.earlyCloses[sessionId as keyof typeof CME_EQUITY_INDEX_CALENDAR_V1.earlyCloses];
  if (localId === sessionId && close) {
    const [hour, minutes] = close.split(":").map(Number);
    if (minute >= hour * 60 + minutes) return false;
  }
  return true;
}

export interface IbkrEsContractIdentity {
  conId: number;
  localSymbol: string;
  lastTradeDateOrContractMonth: string;
  minTick: number;
  symbol: string;
  secType: string;
  tradingClass: string;
  exchange: string;
  currency: string;
  multiplier: string;
}

export function formatIbUtcEndDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid IBKR request end time");
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 19)}`;
}

export function buildExactIbkrEsHistoricalContract(
  identity: IbkrEsContractIdentity,
): Readonly<Record<string, unknown>> {
  assertExactIbkrEsContract(identity);
  return Object.freeze({
    conId: identity.conId,
    symbol: IBKR_ES_BAR_REQUEST.symbol,
    secType: IBKR_ES_BAR_REQUEST.secType,
    expiry: identity.lastTradeDateOrContractMonth,
    lastTradeDateOrContractMonth: identity.lastTradeDateOrContractMonth,
    multiplier: IBKR_ES_BAR_REQUEST.multiplier,
    exchange: IBKR_ES_BAR_REQUEST.exchange,
    currency: IBKR_ES_BAR_REQUEST.currency,
    localSymbol: identity.localSymbol,
    tradingClass: IBKR_ES_BAR_REQUEST.tradingClass,
    includeExpired: true,
  });
}

export function assertExactIbkrEsContract(
  identity: IbkrEsContractIdentity,
  expectedLocalSymbol?: string,
): void {
  if (!Number.isSafeInteger(identity.conId) || identity.conId <= 0)
    throw new Error("IBKR ES contract requires a positive integer conId");
  if (expectedLocalSymbol && identity.localSymbol !== expectedLocalSymbol)
    throw new Error(`IBKR substituted localSymbol ${identity.localSymbol}`);
  for (const [key, expected, actual] of [
    ["symbol", "ES", identity.symbol],
    ["secType", "FUT", identity.secType],
    ["tradingClass", "ES", identity.tradingClass],
    ["exchange", "CME", identity.exchange],
    ["currency", "USD", identity.currency],
    ["multiplier", "50", identity.multiplier],
  ] as const) {
    if (actual !== expected) throw new Error(`IBKR ES contract ${key} must be ${expected}; received ${actual}`);
  }
  if (!/^ES[HMUZ]\d$/.test(identity.localSymbol))
    throw new Error(`Unsupported ES quarterly localSymbol ${identity.localSymbol}`);
  if (!/^\d{6}(?:\d{2})?$/.test(identity.lastTradeDateOrContractMonth))
    throw new Error("IBKR ES contract requires an expiry discriminator");
  if (identity.minTick !== 0.25)
    throw new Error(`IBKR ES minTick must be 0.25; received ${identity.minTick}`);
}
