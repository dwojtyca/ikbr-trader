import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const DEFAULT_SECURITY_TYPE = 'STK';

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional()
);

const schema = z.object({
  EXECUTION_PORT: z.coerce.number().default(3103),
  LOG_LEVEL: z.string().default('info'),
  POSTGRES_URL: z.string().default('postgresql://postgres:postgres@localhost:5432/ikbr_trader'),
  IB_SOCKET_HOST: z.string().default('127.0.0.1'),
  IB_SOCKET_PORT: z.coerce.number().default(4002),
  EXECUTION_CLIENT_ID: z.coerce.number().default(102),
  IB_EXCHANGE: z.string().default('SMART'),
  IB_PRIMARY_EXCHANGE: optionalTrimmedString,
  IB_CURRENCY: z.string().default('USD'),
  WATCHLIST_CONTRACT_OVERRIDES: z.string().default(''),
  IBKR_ACCOUNT_ID: optionalTrimmedString,
  EXECUTION_DEFAULT_TIF: z.string().default('DAY'),
  EXECUTION_ORDER_TIMEOUT_MS: z.coerce.number().default(15000),
  EXECUTION_SUBMITTED_AUTO_CANCEL_MS: z.coerce.number().int().min(0).default(0),
  EXECUTION_RETRY_AS_MKT_ON_CODE_110: z.string().default('false'),
  // Daily loss kill-switch. When daily realized PnL (in base currency)
  // drops below the configured threshold, the execution-engine refuses
  // any new OPEN_OR_ADD orders. CLOSE_OR_REDUCE always passes so the bot
  // can still exit existing positions. Set USD or PCT (or both); 0 disables
  // that bound. PCT is evaluated against last-known account netLiquidation.
  EXECUTION_MAX_DAILY_LOSS_USD: z.coerce.number().min(0).default(0),
  EXECUTION_MAX_DAILY_LOSS_PCT: z.coerce.number().min(0).max(100).default(0)
});

const env = schema.parse(process.env);

type OverrideKey = 'conid' | 'secType' | 'exchange' | 'primaryExchange' | 'currency';

function mapOverrideKey(raw: string): OverrideKey | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'conid') return 'conid';
  if (normalized === 'sectype') return 'secType';
  if (normalized === 'exchange') return 'exchange';
  if (normalized === 'primaryexchange' || normalized === 'primaryexch' || normalized === 'primary') return 'primaryExchange';
  if (normalized === 'currency') return 'currency';
  return undefined;
}

interface ContractFallback {
  symbol: string;
  secType?: string;
  exchange?: string;
  primaryExch?: string;
  currency?: string;
}

function parseContractFallbackByConid(raw: string): Record<string, ContractFallback> {
  const out: Record<string, ContractFallback> = {};
  const entries = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [symbolRaw, pairsRaw = ''] = entry.split(':', 2);
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol) continue;

    const patch: { conid?: string; secType?: string; exchange?: string; primaryExchange?: string; currency?: string } = {};
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

    if (!patch.conid) continue;

    out[patch.conid] = {
      symbol,
      secType: patch.secType,
      exchange: patch.exchange,
      primaryExch: patch.primaryExchange,
      currency: patch.currency
    };
  }

  return out;
}

export const config = {
  ...env,
  defaultSecurityType: DEFAULT_SECURITY_TYPE,
  executionRetryAsMktOnCode110: env.EXECUTION_RETRY_AS_MKT_ON_CODE_110.toLowerCase() === 'true',
  contractFallbackByConid: parseContractFallbackByConid(env.WATCHLIST_CONTRACT_OVERRIDES)
};
