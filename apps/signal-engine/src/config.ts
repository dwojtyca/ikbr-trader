import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  SIGNAL_PORT: z.coerce.number().default(3102),
  LOG_LEVEL: z.string().default("info"),
  POSTGRES_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/ikbr_trader"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  EXECUTION_BASE_URL: z.string().default("http://localhost:3103"),
  IB_MARKET_DATA_TYPE: z.coerce.number().default(3),
  WATCHLIST_SYMBOLS: z.string().default("AAPL,MSFT,XOM"),
  SIGNAL_EVENT_DRIVEN: z.string().default("true"),
  SIGNAL_MIN_CANDLES: z.coerce.number().default(220),
  SIGNAL_PROPOSAL_TTL_MS: z.coerce.number().int().min(0).default(120000),
  ACCOUNT_EQUITY: z.coerce.number().default(100000),
  SIGNAL_MAX_MARKET_STATE_AGE_MS: z.coerce.number().int().min(0).default(90000),
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
  WATCHLIST_CONTRACT_OVERRIDES: z.string().default(""),
  IB_CURRENCY: z.string().default("USD"),
  SIGNAL_PRICE_MULTIPLIER_OVERRIDES: z.string().default(""),
});

const env = schema.parse(process.env);

type ContractOverrideKey = "currency";

function parseWatchlistSymbols(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseContractCurrencies(
  raw: string,
  symbols: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = new Set(symbols.map((symbol) => symbol.toUpperCase()));

  for (const entry of raw
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const [symbolRaw, pairsRaw = ""] = entry.split(":", 2);
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol || !allowed.has(symbol)) continue;

    for (const pair of pairsRaw
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [keyRaw, valueRaw = ""] = pair.split("=", 2);
      const key = keyRaw.trim().toLowerCase() as ContractOverrideKey;
      const value = valueRaw.trim().toUpperCase();
      if (key === "currency" && value) {
        out[symbol] = value;
      }
    }
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

export const config = {
  ...env,
  watchlistSymbols: parseWatchlistSymbols(env.WATCHLIST_SYMBOLS),
  signalEventDriven: env.SIGNAL_EVENT_DRIVEN.toLowerCase() === "true",
  volumeFilterMode:
    env.IB_MARKET_DATA_TYPE === 1 ? ("strict" as const) : ("off" as const),
  currencyBySymbol: parseContractCurrencies(
    env.WATCHLIST_CONTRACT_OVERRIDES,
    parseWatchlistSymbols(env.WATCHLIST_SYMBOLS),
  ),
  baseCurrency: env.IB_CURRENCY,
  priceMultiplierOverrides: parsePriceMultiplierOverrides(
    env.SIGNAL_PRICE_MULTIPLIER_OVERRIDES,
  ),
  fractionalSymbols: new Set(
    env.SIGNAL_FRACTIONAL_SYMBOLS.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
};
