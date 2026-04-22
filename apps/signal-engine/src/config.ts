import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  SIGNAL_PORT: z.coerce.number().default(3102),
  LOG_LEVEL: z.string().default('info'),
  POSTGRES_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/ikbr_trader'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  EXECUTION_BASE_URL: z.string().default('http://localhost:3103'),
  IB_MARKET_DATA_TYPE: z.coerce.number().default(3),
  WATCHLIST_SYMBOLS: z.string().default('AAPL,MSFT,XOM'),
  SIGNAL_EVENT_DRIVEN: z.string().default('true'),
  SIGNAL_MIN_CANDLES: z.coerce.number().default(220),
  SIGNAL_HOLD_REJECT_DEDUP_MS: z.coerce.number().int().min(0).default(900000),
  SIGNAL_PROPOSAL_TTL_MS: z.coerce.number().int().min(0).default(120000),
  ACCOUNT_EQUITY: z.coerce.number().default(100000),
  SIGNAL_MAX_MARKET_STATE_AGE_MS: z.coerce.number().int().min(0).default(90000),
  MAX_RISK_PER_TRADE_PCT: z.coerce.number().default(0.5),
  MAX_EXPOSURE_PCT: z.coerce.number().default(25),
  MAX_NOTIONAL_PER_TRADE_PCT: z.coerce.number().default(10),
  MAX_OPEN_POSITIONS: z.coerce.number().default(5),
  MAX_SPREAD_BPS: z.coerce.number().default(12),
  MIN_CANDLE_VOLUME_1M: z.coerce.number().default(100),
  ATR_STOP_MULT: z.coerce.number().default(1.5),
  ATR_TP_MULT: z.coerce.number().default(3),
  SIGNAL_MIN_CONFIDENCE: z.coerce.number().default(0.55),
  SIGNAL_LMT_ENTRY_MODE: z.enum(['touch', 'last', 'mid']).default('touch'),
  SIGNAL_LMT_ENTRY_BUFFER_BPS: z.coerce.number().min(0).default(0),
  SIGNAL_MIN_STOP_BPS_STOCK: z.coerce.number().min(0).default(12),
  SIGNAL_MIN_STOP_BPS_INDEX: z.coerce.number().min(0).default(10),
  SIGNAL_MIN_STOP_BPS_COMMODITY: z.coerce.number().min(0).default(14),
  SIGNAL_ASSET_CLASS_OVERRIDES: z.string().default('')
});

const env = schema.parse(process.env);

function parseAssetClassOverrides(raw: string): Record<string, 'stock' | 'commodity' | 'index'> {
  const entries = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  const out: Record<string, 'stock' | 'commodity' | 'index'> = {};
  for (const entry of entries) {
    const [symbolRaw, clsRaw] = entry.split(':').map((v) => v.trim());
    if (!symbolRaw || !clsRaw) continue;

    const normalizedClass = clsRaw.toLowerCase();
    if (normalizedClass !== 'stock' && normalizedClass !== 'commodity' && normalizedClass !== 'index') continue;

    out[symbolRaw.toUpperCase()] = normalizedClass;
  }
  return out;
}

export const config = {
  ...env,
  watchlistSymbols: env.WATCHLIST_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean),
  signalEventDriven: env.SIGNAL_EVENT_DRIVEN.toLowerCase() === 'true',
  volumeFilterMode: env.IB_MARKET_DATA_TYPE === 1 ? 'strict' as const : 'off' as const,
  assetClassOverrides: parseAssetClassOverrides(env.SIGNAL_ASSET_CLASS_OVERRIDES)
};
