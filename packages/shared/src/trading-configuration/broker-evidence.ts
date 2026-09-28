import {
  requireSessionHistorySchedule,
  type InstrumentSessionIdentity,
  type SessionScheduleEvidence,
} from "../instrument-sessions.js";
import { tickSizesEqual } from "../instruments/bindings.js";
import type { TradingConfigurationV1 } from "./types.js";

type ConfigurationInstrument = TradingConfigurationV1["instruments"][number];
export type TradingConfigurationEvidenceStatus = "unknown" | "verified" | "mismatch" | "unavailable";
export interface TradingConfigurationEvidenceComponent {
  readonly status: TradingConfigurationEvidenceStatus;
  readonly reason: string;
}
export type ConfigurationMetadataUnavailableReason =
  | "BROKER_METADATA_TIMEOUT" | "BROKER_METADATA_DISCONNECTED"
  | "BROKER_METADATA_ERROR" | "BROKER_METADATA_ACCOUNT_MISMATCH"
  | "BROKER_METADATA_API_UNAVAILABLE" | "BROKER_METADATA_CONNECT_FAILED";
export interface TradingConfigurationBrokerObservation {
  readonly requestStartedAt: string;
  readonly observedAt: string;
  readonly candidates: readonly unknown[];
  readonly marketRule?: unknown;
  readonly sessionEvidence?: SessionScheduleEvidence | null;
  readonly quote?: unknown;
  readonly unavailableReason?: ConfigurationMetadataUnavailableReason;
}
export interface TradingConfigurationBrokerEvidence {
  readonly instrumentId: string;
  readonly observedAt?: string;
  readonly identity: TradingConfigurationEvidenceComponent;
  readonly session: TradingConfigurationEvidenceComponent;
  readonly priceGrid: TradingConfigurationEvidenceComponent;
  readonly quote: TradingConfigurationEvidenceComponent;
  readonly sessionOpen: boolean | null;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const component = (status: TradingConfigurationEvidenceStatus, reason: string): TradingConfigurationEvidenceComponent =>
  Object.freeze({ status, reason });
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : undefined;
}

export function configurationSessionIdentity(instrument: ConfigurationInstrument): InstrumentSessionIdentity {
  const c = instrument.contract;
  return { instrumentId: instrument.id, conId: c.conId, symbol: c.symbol, secType: "STK",
    exchange: c.exchange, primaryExchange: c.primaryExchange, currency: c.currency,
    localSymbol: c.localSymbol, tradingClass: c.tradingClass, useRTH: instrument.session.useRTH,
    timeZone: instrument.session.timeZone };
}

/** Select a routing rule only after validating the complete broker mapping. */
export function configurationMarketRuleId(candidate: unknown, exchange: string): number | undefined {
  const row = record(candidate);
  if (!row || !Array.isArray(row.validExchanges) || !Array.isArray(row.marketRuleIds)) return undefined;
  const routes = row.validExchanges, ids = row.marketRuleIds;
  if (!routes.length || routes.length > 256 || routes.length !== ids.length ||
      routes.some(route => typeof route !== "string" || !/^[A-Z][A-Z0-9._-]*$/.test(route)) ||
      new Set(routes).size !== routes.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return undefined;
  const index = routes.indexOf(exchange);
  return index < 0 ? undefined : ids[index] as number;
}

function identityEvidence(instrument: ConfigurationInstrument, observation: TradingConfigurationBrokerObservation | undefined,
  nowMs: number): TradingConfigurationEvidenceComponent {
  if (!observation) return component("unknown", "BROKER_METADATA_UNOBSERVED");
  const start = timestamp(observation.requestStartedAt), end = timestamp(observation.observedAt);
  if (!Number.isFinite(nowMs) || start === undefined || end === undefined || start > end || end > nowMs)
    return component("unavailable", "BROKER_METADATA_TIMESTAMP_INVALID");
  if (nowMs - start > 60_000) return component("unavailable", "BROKER_METADATA_STALE");
  if (observation.unavailableReason && observation.unavailableReason !== "BROKER_METADATA_API_UNAVAILABLE")
    return component("unavailable", observation.unavailableReason);
  if (!Array.isArray(observation.candidates)) return component("mismatch", "BROKER_METADATA_MALFORMED");
  if (!observation.candidates.length) return component("unavailable", "BROKER_CONTRACT_NOT_FOUND");
  if (observation.candidates.length !== 1) return component("mismatch", "BROKER_CONTRACT_AMBIGUOUS");
  const details = record(observation.candidates[0]), returned = record(details?.contract);
  if (!details || !returned) return component("unknown", "BROKER_CONTRACT_FIELDS_MISSING");
  const c = instrument.contract;
  const expected = { conId: c.conId, symbol: c.symbol, secType: "STK", exchange: c.exchange,
    primaryExchange: c.primaryExchange, currency: c.currency, localSymbol: c.localSymbol, tradingClass: c.tradingClass };
  const actual = { ...returned, primaryExchange: returned.primaryExchange ?? returned.primaryExch };
  if (returned.primaryExch !== undefined && returned.primaryExchange !== undefined && returned.primaryExch !== returned.primaryExchange)
    return component("mismatch", "BROKER_PRIMARY_LISTING_MISMATCH");
  let missing = false;
  for (const [key, value] of Object.entries(expected)) {
    const observed = actual[key as keyof typeof actual];
    if (observed === undefined || observed === null) missing = true;
    else if (observed !== value) return component("mismatch", "BROKER_CONTRACT_IDENTITY_MISMATCH");
  }
  if (details.minTick === undefined || details.minTick === null) missing = true;
  else if (!positive(details.minTick) || !tickSizesEqual(details.minTick, c.expectedMinTick))
    return component("mismatch", "BROKER_MIN_TICK_MISMATCH");
  return missing ? component("unknown", "BROKER_CONTRACT_FIELDS_MISSING") : component("verified", "BROKER_CONTRACT_VERIFIED");
}

function gridEvidence(instrument: ConfigurationInstrument, observation: TradingConfigurationBrokerObservation | undefined,
  identity: TradingConfigurationEvidenceComponent): TradingConfigurationEvidenceComponent {
  if (!observation) return component("unknown", "PRICE_GRID_UNOBSERVED");
  if (identity.status !== "verified") return component(identity.status, "PRICE_GRID_IDENTITY_UNVERIFIED");
  const detail = record(observation.candidates[0]);
  if (detail?.validExchanges === undefined || detail.marketRuleIds === undefined)
    return component("unavailable", "PRICE_GRID_MAPPING_UNAVAILABLE");
  const ruleId = configurationMarketRuleId(detail, instrument.contract.exchange);
  if (ruleId === undefined) return component("mismatch", "PRICE_GRID_MAPPING_INVALID");
  if (observation.marketRule === undefined) return component("unavailable", "PRICE_GRID_RULE_UNAVAILABLE");
  const rule = record(observation.marketRule);
  if (!rule || rule.id !== ruleId || !Array.isArray(rule.bands) || !rule.bands.length || rule.bands.length > 256)
    return component("mismatch", "PRICE_GRID_RULE_INVALID");
  let previous = -1;
  for (const value of rule.bands) {
    const band = record(value);
    if (!band || typeof band.lowEdge !== "number" || !Number.isFinite(band.lowEdge) || band.lowEdge < 0 ||
        band.lowEdge <= previous || (previous === -1 && band.lowEdge !== 0) || !positive(band.increment))
      return component("mismatch", "PRICE_GRID_BANDS_INVALID");
    previous = band.lowEdge;
  }
  return component("verified", "PRICE_GRID_VERIFIED");
}

function sessionEvidence(instrument: ConfigurationInstrument, observation: TradingConfigurationBrokerObservation | undefined,
  nowMs: number): { session: TradingConfigurationEvidenceComponent; sessionOpen: boolean | null } {
  const evidence = observation?.sessionEvidence;
  if (!evidence) return { session: component("unknown", "SESSION_UNOBSERVED"), sessionOpen: null };
  if (!Number.isFinite(nowMs) || evidence.status !== "READY")
    return { session: component("unavailable", "SESSION_UNAVAILABLE"), sessionOpen: null };
  try {
    const schedule = requireSessionHistorySchedule(evidence, configurationSessionIdentity(instrument), nowMs);
    if (Date.parse(schedule.coverageEnd) <= nowMs || Date.parse(schedule.coverageStart) > nowMs)
      return { session: component("unavailable", "SESSION_CURRENT_COVERAGE_MISSING"), sessionOpen: null };
    const open = schedule.sessions.some(s => Date.parse(s.start) <= nowMs && nowMs < Date.parse(s.end));
    return { session: component("verified", open ? "SESSION_OPEN" : "SESSION_CLOSED"), sessionOpen: open };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const unavailable = ["session_schedule_unavailable", "session_schedule_stale", "session_schedule_coverage_missing"].includes(message);
    return { session: component(unavailable ? "unavailable" : "mismatch", unavailable ? "SESSION_UNAVAILABLE" : "SESSION_EVIDENCE_INVALID"), sessionOpen: null };
  }
}

function quoteEvidence(instrument: ConfigurationInstrument, observation: TradingConfigurationBrokerObservation | undefined,
  nowMs: number): TradingConfigurationEvidenceComponent {
  if (observation?.quote === undefined) return component("unknown", "QUOTE_UNOBSERVED");
  const quote = record(observation.quote);
  if (!quote) return component("mismatch", "QUOTE_MALFORMED");
  const expected = { instrumentId: instrument.id, conId: instrument.contract.conId, source: "ibkr" };
  let missing = false;
  for (const [key, value] of Object.entries(expected)) {
    if (quote[key] === undefined || quote[key] === null) missing = true;
    else if (quote[key] !== value) return component("mismatch", "QUOTE_IDENTITY_MISMATCH");
  }
  if (missing) return component("unknown", "QUOTE_IDENTITY_MISSING");
  if (quote.marketDataType === undefined) return component("unknown", "QUOTE_TYPE_MISSING");
  if (quote.marketDataType !== 1) return component("unavailable", "QUOTE_NOT_REALTIME");
  if (!positive(quote.bid) || !positive(quote.ask) || quote.bid > quote.ask) return component("mismatch", "QUOTE_PRICES_INVALID");
  const bid = timestamp(quote.bidObservedAt), ask = timestamp(quote.askObservedAt);
  if (!Number.isFinite(nowMs) || bid === undefined || ask === undefined || bid > nowMs || ask > nowMs)
    return component("unavailable", "QUOTE_TIMESTAMP_INVALID");
  if (nowMs - bid >= 10_000 || nowMs - ask >= 10_000) return component("unavailable", "QUOTE_STALE");
  return component("verified", "QUOTE_VERIFIED");
}

export function evaluateTradingConfigurationBrokerEvidence(instrument: ConfigurationInstrument,
  observation: TradingConfigurationBrokerObservation | undefined, nowMs: number): TradingConfigurationBrokerEvidence {
  const identity = identityEvidence(instrument, observation, nowMs);
  const session = sessionEvidence(instrument, observation, nowMs);
  const observedAt = timestamp(observation?.observedAt);
  return Object.freeze({ instrumentId: instrument.id,
    ...(observedAt !== undefined && observedAt <= nowMs ? { observedAt: observation!.observedAt } : {}),
    identity, ...session, priceGrid: gridEvidence(instrument, observation, identity), quote: quoteEvidence(instrument, observation, nowMs) });
}
