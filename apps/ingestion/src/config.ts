import dotenv from "dotenv";
import { z } from "zod";
import { WatchlistInstrument } from "./types.js";
import {
  buildInstrumentBindingAuthority,
  buildConfiguredInstrumentRegistry,
  InstrumentBindingAuthority,
} from "@ikbr/shared";
import { buildMergedWatchlist } from "./bound-watchlist.js";

dotenv.config();

const DEFAULT_SECURITY_TYPE = "STK";

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const optionalNumberFromEnv = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.coerce.number().optional(),
);

const schema = z.object({
  INGESTION_PORT: optionalNumberFromEnv,
  LOG_LEVEL: z.string().default("info"),
  IB_SOCKET_HOST: z.string().default("127.0.0.1"),
  IB_SOCKET_PORT: z.coerce.number().default(4002),
  INGESTION_CLIENT_ID: z.coerce.number().default(101),
  AAPL_SCHEDULE_CLIENT_ID: z.coerce.number().int().positive().max(2147483647).default(154),
  IB_EXCHANGE: z.string().default("SMART"),
  IB_PRIMARY_EXCHANGE: optionalTrimmedString,
  IB_CURRENCY: z.string().default("USD"),
  IB_MARKET_DATA_TYPE: z.coerce.number().default(3),
  IBKR_ACCOUNT_ID: optionalTrimmedString,
  WATCHLIST_SYMBOLS: z.string().default("AAPL,MSFT,XOM"),
  WATCHLIST_CONTRACT_OVERRIDES: z.string().default(""),
  INGESTION_SIGNAL_ENGINE_BASE_URL: z.string().default("http://localhost:3102"),
  INGESTION_TRIGGER_SIGNALS_ON_CANDLE: z.string().default("true"),
  INGESTION_BACKFILL_1M_CANDLES: optionalNumberFromEnv,
  INGESTION_BACKFILL_5M_CANDLES: optionalNumberFromEnv,
  INGESTION_BACKFILL_1H_CANDLES: optionalNumberFromEnv,
  INGESTION_BACKFILL_4H_CANDLES: optionalNumberFromEnv,
  INGESTION_BACKFILL_12H_CANDLES: optionalNumberFromEnv,
  INGESTION_BACKFILL_1D_CANDLES: optionalNumberFromEnv,
  INGESTION_BACKFILL_1W_CANDLES: optionalNumberFromEnv,
  POSTGRES_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/ikbr_trader"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  // PR15.2 — same shared JSON payload consumed by signal-engine
  // and execution-engine. Empty → no bound instruments; the
  // legacy WATCHLIST_SYMBOLS list is used as-is. NEVER logged.
  INSTRUMENT_BINDINGS_JSON: z.string().default(""),
});

const env = schema.parse(process.env);
const otherClientIds = [env.INGESTION_CLIENT_ID, ...Object.entries({ EXECUTION_CLIENT_ID: 102, BACKTEST_INGESTION_CLIENT_ID: 104,
  IB_METADATA_CLIENT_ID: 119, IB_COMPLETED_ORDERS_CLIENT_ID: 120, IBKR_ES_ACQUISITION_CLIENT_ID: 91551 })
  .map(([key, fallback]) => Number(process.env[key] ?? fallback))];
if (otherClientIds.includes(env.AAPL_SCHEDULE_CLIENT_ID)) throw new Error("AAPL_SCHEDULE_CLIENT_ID must be distinct from existing broker clients");

type OverrideKey =
  | "conid"
  | "secType"
  | "exchange"
  | "primaryExchange"
  | "currency";

function parseWatchlistSymbols(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapOverrideKey(raw: string): OverrideKey | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "conid") return "conid";
  if (normalized === "sectype") return "secType";
  if (normalized === "exchange") return "exchange";
  if (
    normalized === "primaryexchange" ||
    normalized === "primaryexch" ||
    normalized === "primary"
  )
    return "primaryExchange";
  if (normalized === "currency") return "currency";
  return undefined;
}

function parseWatchlistContractOverrides(
  raw: string,
  symbols: string[],
): Map<string, Omit<WatchlistInstrument, "symbol">> {
  const out = new Map<string, Omit<WatchlistInstrument, "symbol">>();
  const allowed = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  const entries = raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [symbolRaw, pairsRaw = ""] = entry.split(":", 2);
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol || !allowed.has(symbol)) continue;

    const patch: Omit<WatchlistInstrument, "symbol"> = {};
    const pairs = pairsRaw
      .split("|")
      .map((pair) => pair.trim())
      .filter(Boolean);

    for (const pair of pairs) {
      const [keyRaw, valueRaw = ""] = pair.split("=", 2);
      const key = mapOverrideKey(keyRaw);
      const value = valueRaw.trim();
      if (!key || !value) continue;
      patch[key] = value;
    }

    if (Object.keys(patch).length > 0) {
      out.set(symbol, patch);
    }
  }

  return out;
}

function buildWatchlistInstruments(
  envValue: typeof env,
): WatchlistInstrument[] {
  const watchlistSymbols = parseWatchlistSymbols(envValue.WATCHLIST_SYMBOLS);
  const overrides = parseWatchlistContractOverrides(
    envValue.WATCHLIST_CONTRACT_OVERRIDES,
    watchlistSymbols,
  );
  return watchlistSymbols.map((symbol) => {
    const symbolKey = symbol.toUpperCase();
    const patch = overrides.get(symbolKey);
    return {
      symbol,
      ...patch,
    };
  });
}

const watchlistInstruments = buildWatchlistInstruments(env);
const ingestionPort = env.INGESTION_PORT ?? 3101;

// PR15.2 — build the ingestion-side `InstrumentBindingAuthority`
// from the same shared JSON as signal-engine and execution-engine.
// Failure here throws at module load so the process refuses to
// start on a bad configuration. Raw payload is never logged.
const bindingResult = buildInstrumentBindingAuthority(
  env.INSTRUMENT_BINDINGS_JSON,
  buildConfiguredInstrumentRegistry(process.env),
);
if (!bindingResult.ok) {
  const summary = bindingResult.errors
    .slice(0, 5)
    .map(
      (e) =>
        `#${e.index}${e.instrumentId ? ` (${e.instrumentId})` : ""}: ${e.message}`,
    )
    .join("; ");
  throw new Error(
    `INSTRUMENT_BINDINGS_JSON is invalid — refusing to start. ${summary}` +
      (bindingResult.errors.length > 5
        ? ` (+${bindingResult.errors.length - 5} more)`
        : ""),
  );
}
const instrumentBindingAuthority: InstrumentBindingAuthority =
  bindingResult.authority;

// PR15.2 hostile-review round-6 — a single production merge
// function owns the collision-aware combining of the legacy
// watchlist and the authoritative bound entries. `config.ts`
// deliberately does NOT re-implement the merge shape; the
// regression test in `bound-watchlist.test.ts` exercises this
// same function so a wiring regression is caught by CI.
const mergedResult = buildMergedWatchlist({
  authority: instrumentBindingAuthority,
  legacyWatchlist: watchlistInstruments,
});
const boundWatchlistInstruments = mergedResult.boundWatchlist;
const mergedWatchlistInstruments: WatchlistInstrument[] = [
  ...mergedResult.mergedWatchlist,
];

export const config = {
  ...env,
  ingestionPort,
  defaultSecurityType: DEFAULT_SECURITY_TYPE,
  watchlistSymbols: mergedWatchlistInstruments.map((item) => item.symbol),
  watchlistInstruments: mergedWatchlistInstruments,
  // PR15.2 — expose the authority + bound-only view for the
  // `/watchlist` diagnostic endpoint. Callers MUST NOT log
  // `INSTRUMENT_BINDINGS_JSON` — use `toDiagnostics()` instead.
  instrumentBindingAuthority,
  boundWatchlistInstruments,
  ingestionTriggerSignalsOnCandle:
    env.INGESTION_TRIGGER_SIGNALS_ON_CANDLE.toLowerCase() === "true",
  backfill1mCandles: Math.max(0, env.INGESTION_BACKFILL_1M_CANDLES ?? 220),
  // Native higher-TF backfill counts. These are fetched directly from
  // IBKR via reqHistoricalData on startup so the bot has enough bars to
  // compute EMA50/EMA200 / regimeScore from the first tick rather than
  // waiting weeks for live aggregation to build them up.
  backfill5mCandles: Math.max(0, env.INGESTION_BACKFILL_5M_CANDLES ?? 500),
  backfill1hCandles: Math.max(0, env.INGESTION_BACKFILL_1H_CANDLES ?? 400),
  backfill4hCandles: Math.max(0, env.INGESTION_BACKFILL_4H_CANDLES ?? 200),
  backfill12hCandles: Math.max(0, env.INGESTION_BACKFILL_12H_CANDLES ?? 120),
  backfill1dCandles: Math.max(0, env.INGESTION_BACKFILL_1D_CANDLES ?? 260),
  backfill1wCandles: Math.max(0, env.INGESTION_BACKFILL_1W_CANDLES ?? 104),
};
