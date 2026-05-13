import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const DEFAULT_SECURITY_TYPE = "STK";

export interface WatchlistInstrument {
  symbol: string;
  conid?: string;
  secType?: string;
  exchange?: string;
  primaryExchange?: string;
  currency?: string;
}

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const schema = z.object({
  BACKTEST_PORT: z.coerce.number().default(3104),
  LOG_LEVEL: z.string().default("info"),
  POSTGRES_ADMIN_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/postgres"),
  BACKTEST_POSTGRES_URL: z
    .string()
    .default(
      "postgresql://postgres:postgres@localhost:5432/ikbr_trader_backtest",
    ),
  IB_SOCKET_HOST: z.string().default("127.0.0.1"),
  IB_SOCKET_PORT: z.coerce.number().default(4002),
  BACKTEST_IB_CLIENT_ID: z.coerce.number().default(104),
  IB_EXCHANGE: z.string().default("SMART"),
  IB_PRIMARY_EXCHANGE: optionalTrimmedString,
  IB_CURRENCY: z.string().default("USD"),
  WATCHLIST_SYMBOLS: z.string().default("AAPL,MSFT,XOM"),
  WATCHLIST_CONTRACT_OVERRIDES: z.string().default(""),
  SIGNAL_MIN_CANDLES: z.coerce.number().default(220),
  ACCOUNT_EQUITY: z.coerce.number().default(100000),
  MAX_RISK_PER_TRADE_PCT: z.coerce.number().default(0.5),
  MAX_EXPOSURE_PCT: z.coerce.number().default(25),
  MAX_NOTIONAL_PER_TRADE_PCT: z.coerce.number().default(10),
  MAX_OPEN_POSITIONS: z.coerce.number().default(5),
  MAX_SPREAD_BPS: z.coerce.number().default(12),
  MIN_CANDLE_VOLUME_1M: z.coerce.number().default(100),
  SIGNAL_MIN_CONFIDENCE: z.coerce.number().default(0.55),
  SIGNAL_LMT_ENTRY_MODE: z.enum(["touch", "last", "mid"]).default("touch"),
  SIGNAL_LMT_ENTRY_BUFFER_BPS: z.coerce.number().min(0).default(0),
  SIGNAL_FRACTIONAL_SYMBOLS: z.string().default(""),
  SIGNAL_FRACTIONAL_QUANTITY_STEP: z.coerce.number().positive().default(0.0001),
  SIGNAL_MIN_STOP_BPS_STK: z.coerce.number().min(0).default(12),
  SIGNAL_MIN_STOP_BPS_IND: z.coerce.number().min(0).default(10),
  SIGNAL_MIN_STOP_BPS_CMDTY: z.coerce.number().min(0).default(14),
  SIGNAL_STRATEGY_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(12 * 60 * 60 * 1000),
  SIGNAL_PRICE_MULTIPLIER_OVERRIDES: z.string().default(""),
  BACKTEST_COMMISSION_BPS: z.coerce.number().min(0).default(5),
  BACKTEST_SYNTHETIC_SPREAD_BPS: z.coerce.number().min(0).default(2),
  BACKTEST_ORDER_TTL_CANDLES: z.coerce.number().int().min(1).default(2),
  BACKTEST_STRATEGY_LAB_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(4)
    .default(2),
});

const env = schema.parse(process.env);

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

  for (const entry of raw
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [symbolRaw, pairsRaw = ""] = entry.split(":", 2);
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol || !allowed.has(symbol)) continue;

    const patch: Omit<WatchlistInstrument, "symbol"> = {};
    for (const pair of pairsRaw
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [keyRaw, valueRaw = ""] = pair.split("=", 2);
      const key = mapOverrideKey(keyRaw);
      const value = valueRaw.trim();
      if (!key || !value) continue;
      patch[key] = value;
    }

    if (Object.keys(patch).length > 0) out.set(symbol, patch);
  }

  return out;
}

function buildWatchlistInstruments(): WatchlistInstrument[] {
  const symbols = parseWatchlistSymbols(env.WATCHLIST_SYMBOLS);
  const overrides = parseWatchlistContractOverrides(
    env.WATCHLIST_CONTRACT_OVERRIDES,
    symbols,
  );
  return symbols.map((symbol) => ({
    symbol,
    ...overrides.get(symbol.toUpperCase()),
  }));
}

function buildCurrencyBySymbol(
  instruments: WatchlistInstrument[],
  baseCurrency: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const instrument of instruments) {
    out[instrument.symbol.toUpperCase()] = (instrument.currency ?? baseCurrency)
      .trim()
      .toUpperCase();
  }
  return out;
}

function parsePriceMultiplierOverrides(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [symbolRaw, multiplierRaw] = entry
      .split(":")
      .map((value) => value.trim());
    const multiplier = Number(multiplierRaw);
    if (!symbolRaw || !Number.isFinite(multiplier) || multiplier <= 0) continue;
    out[symbolRaw.toUpperCase()] = multiplier;
  }
  return out;
}

const watchlistInstruments = buildWatchlistInstruments();

export const config = {
  ...env,
  defaultSecurityType: DEFAULT_SECURITY_TYPE,
  watchlistInstruments,
  watchlistSymbols: parseWatchlistSymbols(env.WATCHLIST_SYMBOLS),
  currencyBySymbol: buildCurrencyBySymbol(
    watchlistInstruments,
    env.IB_CURRENCY,
  ),
  priceMultiplierOverrides: parsePriceMultiplierOverrides(
    env.SIGNAL_PRICE_MULTIPLIER_OVERRIDES,
  ),
  fractionalSymbols: new Set(
    env.SIGNAL_FRACTIONAL_SYMBOLS.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
};
