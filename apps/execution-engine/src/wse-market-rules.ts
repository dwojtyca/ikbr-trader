import type { BoundInstrument, SignalTicket } from "@ikbr/shared";

export interface WseMarketMetadata {
  accountId: string; instrumentId: string; conId: number; symbol: string;
  localSymbol: string; tradingClass: string; exchange: "WSE"; currency: "PLN"; secType: "STK";
  marketRuleId: number; priceIncrements: Array<{ lowEdge: number; increment: number }>;
  timeZoneId: string; liquidHours: string; requestStartedAtMs: number; receivedAtMs: number;
}
export function isWseBound(bound: BoundInstrument): boolean {
  return bound.broker === "ibkr" && bound.instrument.broker === "ibkr" && bound.instrument.assetClass === "stock"
    && bound.exchange === "WSE" && bound.instrument.exchange === "WSE"
    && bound.currency === "PLN" && bound.instrument.currency === "PLN"
    && bound.instrumentId === bound.instrument.id && bound.brokerSymbol === bound.instrument.brokerSymbol;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function localParts(ms: number): string {
  const p = Object.fromEntries(formatter.formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}:${p.hour}${p.minute}`;
}
function localTimestamp(value: string): number {
  if (!/^\d{8}:\d{4}$/.test(value)) throw new Error("wse_session_invalid");
  const y = Number(value.slice(0, 4)), m = Number(value.slice(4, 6)), d = Number(value.slice(6, 8));
  const h = Number(value.slice(9, 11)), minute = Number(value.slice(11));
  const utc = Date.UTC(y, m - 1, d, h, minute);
  const date = new Date(utc);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || date.getUTCDate() !== d || h > 23 || minute > 59) throw new Error("wse_session_invalid");
  const matches = [utc - 3600000, utc - 7200000].filter(ms => localParts(ms) === value);
  if (matches.length !== 1) throw new Error("wse_session_invalid");
  return matches[0];
}
function sessionEnd(hours: string, now: number): number {
  const days = new Map<string, Array<[number, number]>>();
  let previousDay = "";
  for (const item of hours.split(";")) {
    const match = /^(\d{8}):(.*)$/.exec(item);
    if (!match || match[1] <= previousDay) throw new Error("wse_session_invalid");
    const day = match[1]; previousDay = day;
    localTimestamp(`${day}:1200`);
    const intervals: Array<[number, number]> = [];
    if (match[2] !== "CLOSED") for (const interval of match[2].split(",")) {
      const pair = /^(\d{4})-(\d{8}:\d{4})$/.exec(interval);
      if (!pair || pair[2].slice(0, 8) !== day) throw new Error("wse_session_invalid");
      const start = localTimestamp(`${day}:${pair[1]}`), end = localTimestamp(pair[2]);
      if (end <= start || (intervals.length > 0 && start < intervals[intervals.length - 1][1])) throw new Error("wse_session_invalid");
      intervals.push([start, end]);
    }
    days.set(day, intervals);
  }
  const today = localParts(now).slice(0, 8);
  const weekday = new Date(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T12:00:00Z`).getUTCDay();
  const windowStart = localTimestamp(`${today}:0905`), windowEnd = localTimestamp(`${today}:1645`);
  if (weekday === 0 || weekday === 6 || now < windowStart || now >= windowEnd) throw new Error("wse_session_closed");
  const current = days.get(today)?.find(([start, end]) => start <= now && now < end);
  if (!current) throw new Error("wse_session_closed");
  return Math.min(current[1], windowEnd);
}
export function validateWseOrder(metadata: unknown, bound: BoundInstrument, accountId: string, ticket: SignalTicket, nowMs: number):
  { ok: true; expiresAtMs: number; metadata: WseMarketMetadata } | { ok: false; reason: string } {
  try {
    if (!isWseBound(bound) || !record(metadata)) throw new Error("wse_metadata_identity_invalid");
    const m = metadata;
    if ((bound.instrument.conId !== undefined && bound.instrument.conId !== bound.conId)
      || (bound.instrument.localSymbol !== undefined && bound.instrument.localSymbol !== bound.localSymbol)
      || (bound.instrument.tradingClass !== undefined && bound.instrument.tradingClass !== bound.tradingClass)) throw new Error("wse_metadata_identity_invalid");
    const expected = { accountId, instrumentId: bound.instrumentId, conId: bound.conId, symbol: bound.brokerSymbol,
      localSymbol: bound.localSymbol, tradingClass: bound.tradingClass, exchange: "WSE", currency: "PLN", secType: "STK" };
    if (!accountId || !Number.isSafeInteger(bound.conId) || bound.conId <= 0 || Object.entries(expected).some(([key, value]) => !value || m[key] !== value)) throw new Error("wse_metadata_identity_invalid");
    if (!finite(nowMs) || !finite(m.requestStartedAtMs) || !finite(m.receivedAtMs) || m.requestStartedAtMs <= 0 || m.requestStartedAtMs > m.receivedAtMs || m.receivedAtMs > nowMs || nowMs >= m.requestStartedAtMs + 60000) throw new Error("wse_metadata_stale");
    if (!Number.isSafeInteger(m.marketRuleId) || (m.marketRuleId as number) <= 0 || !Array.isArray(m.priceIncrements) || m.priceIncrements.length === 0 || m.priceIncrements.length > 256) throw new Error("wse_market_rule_invalid");
    let last = -1;
    for (const band of m.priceIncrements) {
      if (!record(band) || !finite(band.lowEdge) || !finite(band.increment) || band.lowEdge < 0 || band.lowEdge <= last || band.increment <= 0 || (last === -1 && band.lowEdge !== 0)) throw new Error("wse_market_rule_invalid");
      last = band.lowEdge;
    }
    if (!ticket || ticket.instrumentId !== bound.instrumentId || ticket.instrument !== bound.brokerSymbol || ticket.conid !== String(bound.conId)
      || ticket.quantity !== 1 || ticket.orderType !== "LMT" || ticket.trailingStopPct !== undefined || ticket.trailingStopActivationR !== undefined
      || (ticket.partialTakeProfits !== undefined && (!Array.isArray(ticket.partialTakeProfits) || ticket.partialTakeProfits.length !== 0))) throw new Error("wse_order_shape_invalid");
    const close = ticket.side === "SELL" && ticket.positionEffect === "CLOSE_OR_REDUCE";
    const entry = ticket.side === "BUY" && (ticket.positionEffect === undefined || ticket.positionEffect === "OPEN_OR_ADD");
    if ((!close && !entry) || (close && (ticket.stop !== undefined || ticket.takeProfit !== undefined))
      || (entry && (!finite(ticket.entry) || !finite(ticket.stop) || !finite(ticket.takeProfit) || ticket.stop >= ticket.entry || ticket.takeProfit <= ticket.entry))) throw new Error("wse_order_shape_invalid");
    const bands = m.priceIncrements as WseMarketMetadata["priceIncrements"];
    for (const price of close ? [ticket.entry] : [ticket.entry, ticket.stop, ticket.takeProfit]) {
      if (!finite(price) || price <= 0) throw new Error("wse_price_invalid");
      const band = [...bands].reverse().find(b => price >= b.lowEdge)!;
      const ticks = (price - band.lowEdge) / band.increment;
      if (!Number.isFinite(ticks) || Math.abs(ticks - Math.round(ticks)) > Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(price / band.increment), Math.abs(band.lowEdge / band.increment)) * 8)) throw new Error("wse_price_off_band");
    }
    if ((m.timeZoneId !== "Europe/Warsaw" && m.timeZoneId !== "Poland") || typeof m.liquidHours !== "string" || !m.liquidHours || m.liquidHours.length > 65536) throw new Error("wse_session_invalid");
    const expiresAtMs = Math.min(m.requestStartedAtMs + 60000, sessionEnd(m.liquidHours, nowMs));
    return { ok: true, expiresAtMs, metadata: Object.freeze({ ...(metadata as unknown as WseMarketMetadata), priceIncrements: Object.freeze(bands.map(band => Object.freeze({ ...band }))) as unknown as WseMarketMetadata["priceIncrements"] }) };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "wse_metadata_invalid" }; }
}
