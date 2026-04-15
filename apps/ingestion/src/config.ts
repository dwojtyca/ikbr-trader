import dotenv from 'dotenv';
import { z } from 'zod';
import { WatchlistInstrument } from './types.js';

dotenv.config();

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional()
);

const optionalNumberFromEnv = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.coerce.number().optional()
);

const schema = z.object({
  PORT: z.coerce.number().default(3101),
  LOG_LEVEL: z.string().default('info'),
  IB_SOCKET_HOST: z.string().default('127.0.0.1'),
  IB_SOCKET_PORT: z.coerce.number().default(4002),
  IB_CLIENT_ID: z.coerce.number().default(101),
  IB_SECURITY_TYPE: z.string().default('STK'),
  IB_EXCHANGE: z.string().default('SMART'),
  IB_PRIMARY_EXCHANGE: optionalTrimmedString,
  IB_CURRENCY: z.string().default('USD'),
  IB_MKT_DATA_SNAPSHOT: z.string().default('false'),
  IB_MARKET_DATA_TYPE: z.coerce.number().default(3),
  IBKR_ACCOUNT_ID: optionalTrimmedString,
  WATCHLIST_SYMBOLS: z.string().default('AAPL,MSFT,XOM'),
  WATCHLIST_CONTRACT_OVERRIDES: z.string().default(''),
  SIGNAL_MIN_CANDLES: z.coerce.number().default(220),
  INGESTION_BACKFILL_1M_CANDLES: optionalNumberFromEnv,
  POSTGRES_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/ikbr_trader'),
  REDIS_URL: z.string().default('redis://localhost:6379')
});

const env = schema.parse(process.env);

type OverrideKey = 'conid' | 'secType' | 'exchange' | 'primaryExchange' | 'currency';

function parseWatchlistSymbols(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapOverrideKey(raw: string): OverrideKey | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'conid') return 'conid';
  if (normalized === 'sectype') return 'secType';
  if (normalized === 'exchange') return 'exchange';
  if (normalized === 'primaryexchange' || normalized === 'primaryexch' || normalized === 'primary') return 'primaryExchange';
  if (normalized === 'currency') return 'currency';
  return undefined;
}

function parseWatchlistContractOverrides(
  raw: string,
  symbols: string[]
): Map<string, Omit<WatchlistInstrument, 'symbol'>> {
  const out = new Map<string, Omit<WatchlistInstrument, 'symbol'>>();
  const allowed = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  const entries = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [symbolRaw, pairsRaw = ''] = entry.split(':', 2);
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol || !allowed.has(symbol)) continue;

    const patch: Omit<WatchlistInstrument, 'symbol'> = {};
    const pairs = pairsRaw
      .split('|')
      .map((pair) => pair.trim())
      .filter(Boolean);

    for (const pair of pairs) {
      const [keyRaw, valueRaw = ''] = pair.split('=', 2);
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

function buildWatchlistInstruments(envValue: typeof env): WatchlistInstrument[] {
  const watchlistSymbols = parseWatchlistSymbols(envValue.WATCHLIST_SYMBOLS);
  const overrides = parseWatchlistContractOverrides(envValue.WATCHLIST_CONTRACT_OVERRIDES, watchlistSymbols);
  return watchlistSymbols.map((symbol) => {
    const symbolKey = symbol.toUpperCase();
    const patch = overrides.get(symbolKey);
    return {
      symbol,
      ...patch
    };
  });
}

const watchlistInstruments = buildWatchlistInstruments(env);

export const config = {
  ...env,
  watchlistSymbols: watchlistInstruments.map((item) => item.symbol),
  watchlistInstruments,
  ibMarketDataSnapshot: env.IB_MKT_DATA_SNAPSHOT.toLowerCase() === 'true',
  backfill1mCandles: Math.max(0, env.INGESTION_BACKFILL_1M_CANDLES ?? env.SIGNAL_MIN_CANDLES)
};
