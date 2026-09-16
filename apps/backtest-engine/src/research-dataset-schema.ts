import { z } from "zod";
import {
  CmeSessionCalendar,
  type CmeCalendarDefinition,
} from "./cme-session-calendar.js";

export const RESEARCH_DATASET_SCHEMA_VERSION = "pr15.5c-es-dataset-v1";
export const RESEARCH_DATABASE_NAME = "ikbr_trader_backtest_pr15_5a";

const ascii = z.string().min(1).regex(/^[\x20-\x7e]+$/);
const id = ascii.regex(/^[A-Za-z0-9._-]+$/);
const positiveInteger = z.string().regex(/^[1-9][0-9]*$/);
const integer = z.string().regex(/^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/);
const unsignedInteger = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const positiveDecimal = z
  .string()
  .regex(/^(?:[1-9][0-9]*|0\.[0-9]*[1-9]|[1-9][0-9]*\.[0-9]*[1-9])$/);
const utcMinute = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
  .refine((value) => new Date(value).toISOString() === value, "invalid UTC minute");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const contractSchema = z
  .object({
    conId: positiveInteger,
    localSymbol: ascii,
    symbol: z.literal("ES"),
    tradingClass: z.literal("ES"),
    exchange: z.literal("CME"),
    currency: z.literal("USD"),
    expiry: utcMinute,
    lastTradeAt: utcMinute,
    validFrom: utcMinute,
    validTo: utcMinute,
    rollAt: utcMinute.nullable(),
    multiplier: z.literal("50"),
    minTick: z.literal("0.25"),
  })
  .strict();

export const researchManifestSchema = z
  .object({
    schemaVersion: z.literal(RESEARCH_DATASET_SCHEMA_VERSION),
    provenanceId: id,
    instrument: z.literal("ES"),
    timeframe: z.literal("1m"),
    dateFrom: utcMinute,
    dateTo: utcMinute,
    source: z
      .object({
        provider: ascii,
        artifactId: ascii,
        version: ascii,
        candlesSha256: sha256,
      })
      .strict(),
    aggregationAlgorithmVersion: z.literal("research-cme-aggregate-v1"),
    rollPolicy: z
      .object({
        version: id,
        contractOrder: z.array(positiveInteger).min(1),
      })
      .strict(),
    sessionPolicy: z
      .object({
        template: z.literal("cme_equity_index"),
        timezone: z.literal("America/Chicago"),
        calendarVersion: id,
      })
      .strict(),
    contracts: z.array(contractSchema).min(1),
  })
  .strict();

export const researchCandleSchema = z
  .object({
    symbol: z.literal("ES"),
    conId: positiveInteger,
    ts: utcMinute,
    openTicks: integer,
    highTicks: integer,
    lowTicks: integer,
    closeTicks: integer,
    volume: unsignedInteger,
  })
  .strict();

export type ResearchDatasetManifest = z.infer<typeof researchManifestSchema>;
export type ResearchDatasetContract = ResearchDatasetManifest["contracts"][number];
export type ResearchDatasetCandle = z.infer<typeof researchCandleSchema>;

function canonicalCandleLine(candle: ResearchDatasetCandle): string {
  return JSON.stringify({
    symbol: candle.symbol,
    conId: candle.conId,
    ts: candle.ts,
    openTicks: candle.openTicks,
    highTicks: candle.highTicks,
    lowTicks: candle.lowTicks,
    closeTicks: candle.closeTicks,
    volume: candle.volume,
  });
}

function assertManifestSemantics(
  manifest: ResearchDatasetManifest,
  calendars: ReadonlyMap<string, CmeCalendarDefinition>,
): void {
  if (manifest.dateTo < manifest.dateFrom)
    throw new Error("Manifest dateTo must not precede dateFrom");
  const calendar = calendars.get(manifest.sessionPolicy.calendarVersion);
  if (!calendar)
    throw new Error(`Unknown CME calendar ${manifest.sessionPolicy.calendarVersion}`);
  const fromDate = manifest.dateFrom.slice(0, 10);
  const toDate = manifest.dateTo.slice(0, 10);
  if (fromDate < calendar.coverageStart || toDate > calendar.coverageEnd)
    throw new Error("Manifest range exceeds CME calendar coverage");

  const contracts = new Map(manifest.contracts.map((contract) => [contract.conId, contract]));
  if (contracts.size !== manifest.contracts.length)
    throw new Error("Duplicate contract conId");
  if (new Set(manifest.contracts.map((contract) => contract.localSymbol)).size !== manifest.contracts.length)
    throw new Error("Duplicate contract localSymbol");
  if (manifest.rollPolicy.contractOrder.length !== manifest.contracts.length)
    throw new Error("Roll policy must include every contract exactly once");
  if (new Set(manifest.rollPolicy.contractOrder).size !== manifest.rollPolicy.contractOrder.length)
    throw new Error("Duplicate contract in roll policy");

  const ordered = manifest.rollPolicy.contractOrder.map((conId) => {
    const contract = contracts.get(conId);
    if (!contract) throw new Error(`Roll policy references unknown contract ${conId}`);
    return contract;
  });
  if (ordered[0].validFrom !== manifest.dateFrom || ordered.at(-1)?.validTo !== manifest.dateTo)
    throw new Error("Contract validity must cover the exact manifest range");
  for (let index = 0; index < ordered.length; index += 1) {
    const contract = ordered[index];
    if (contract.validTo < contract.validFrom)
      throw new Error(`Invalid validity range for ${contract.conId}`);
    if (contract.lastTradeAt > contract.expiry)
      throw new Error(`lastTradeAt exceeds expiry for ${contract.conId}`);
    if (contract.validTo > contract.lastTradeAt || contract.rollAt && contract.rollAt > contract.lastTradeAt)
      throw new Error(`Contract validity exceeds lastTradeAt for ${contract.conId}`);
    const next = ordered[index + 1];
    if (!next) {
      if (contract.rollAt !== null) throw new Error("Final contract rollAt must be null");
      continue;
    }
    const expectedNext = new Date(new Date(contract.validTo).getTime() + 60_000).toISOString();
    if (next.validFrom !== expectedNext || contract.rollAt !== next.validFrom)
      throw new Error("Contract validity ranges must be gap-free and non-overlapping");
  }
}

export function parseResearchManifest(
  input: unknown,
  calendars: ReadonlyMap<string, CmeCalendarDefinition>,
): ResearchDatasetManifest {
  const manifest = researchManifestSchema.parse(input);
  assertManifestSemantics(manifest, calendars);
  return manifest;
}

export function parseResearchCandles(
  raw: Buffer,
  manifest: ResearchDatasetManifest,
  calendars: ReadonlyMap<string, CmeCalendarDefinition>,
): ResearchDatasetCandle[] {
  if (raw.length === 0 || raw.at(-1) !== 0x0a)
    throw new Error("candles-1m.ndjson must be non-empty and LF-terminated");
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)
    throw new Error("candles-1m.ndjson must not contain a BOM");
  const text = raw.toString("utf8");
  if (Buffer.from(text, "utf8").compare(raw) !== 0)
    throw new Error("candles-1m.ndjson must be valid UTF-8");
  if (text.includes("\r")) throw new Error("candles-1m.ndjson must use LF line endings");

  const lines = text.slice(0, -1).split("\n");
  const candles: ResearchDatasetCandle[] = [];
  const validator = new ResearchCandleSequenceValidator(manifest, calendars);
  for (const [index, line] of lines.entries()) {
    const candle = validator.parseLine(line, index + 1);
    candles.push(candle);
  }
  return candles;
}

export class ResearchCandleSequenceValidator {
  private readonly calendar: CmeSessionCalendar;
  private readonly contracts: Map<string, ResearchDatasetContract>;
  private previous?: ResearchDatasetCandle;

  constructor(
    private readonly manifest: ResearchDatasetManifest,
    calendars: ReadonlyMap<string, CmeCalendarDefinition>,
  ) {
    const definition = calendars.get(manifest.sessionPolicy.calendarVersion);
    if (!definition) throw new Error("Manifest calendar disappeared during validation");
    this.calendar = new CmeSessionCalendar(definition);
    this.contracts = new Map(manifest.contracts.map((contract) => [contract.conId, contract]));
  }

  parseLine(line: string, lineNumber: number): ResearchDatasetCandle {
    if (!line) throw new Error(`Empty candle line ${lineNumber}`);
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`Invalid candle JSON at line ${lineNumber}`); }
    const candle = researchCandleSchema.parse(value);
    if (canonicalCandleLine(candle) !== line)
      throw new Error(`Non-canonical candle encoding at line ${lineNumber}`);
    const contract = this.contracts.get(candle.conId);
    if (!contract)
      throw new Error(`Candle references undeclared contract ${candle.conId}`);
    if (candle.ts > contract.lastTradeAt)
      throw new Error(`Candle exceeds lastTradeAt for contract ${candle.conId}`);
    if (candle.ts < this.manifest.dateFrom || candle.ts > this.manifest.dateTo)
      throw new Error(`Candle timestamp outside manifest range at line ${lineNumber}`);
    if (!this.calendar.sessionFor(new Date(candle.ts)))
      throw new Error(`Candle outside CME session at line ${lineNumber}`);
    const values = [candle.openTicks, candle.highTicks, candle.lowTicks, candle.closeTicks].map(BigInt);
    const [open, high, low, close] = values;
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    if (values.some((entry) => entry < -safe || entry > safe) || BigInt(candle.volume) > safe)
      throw new Error(`Candle numeric value exceeds exact storage range at line ${lineNumber}`);
    if (low > high || open < low || open > high || close < low || close > high)
      throw new Error(`Invalid OHLC at line ${lineNumber}`);
    if (this.previous) {
      const timeOrder = candle.ts.localeCompare(this.previous.ts);
      const conIdOrder = BigInt(candle.conId) - BigInt(this.previous.conId);
      if (timeOrder < 0 || (timeOrder === 0 && conIdOrder <= 0n))
        throw new Error(`Candles are not canonically ordered at line ${lineNumber}`);
    }
    this.previous = candle;
    return candle;
  }
}

export function databaseNameFromUrl(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("Malformed PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:")
    throw new Error("Research database URL must use postgres or postgresql");
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name || name.includes("/")) throw new Error("Research database URL must name one database");
  return name;
}

export function assertResearchDatabaseUrl(connectionString: string): void {
  const parsed = new URL(connectionString);
  if (parsed.search || parsed.hash)
    throw new Error("Research database URL must not override connection options");
  const name = databaseNameFromUrl(connectionString);
  if (name !== RESEARCH_DATABASE_NAME)
    throw new Error(`Research database must be exactly ${RESEARCH_DATABASE_NAME}; received ${name}`);
}
