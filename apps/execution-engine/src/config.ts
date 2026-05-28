import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const DEFAULT_SECURITY_TYPE = "STK";

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const schema = z.object({
  EXECUTION_PORT: z.coerce.number().default(3103),
  LOG_LEVEL: z.string().default("info"),
  POSTGRES_URL: z
    .string()
    .default("postgresql://postgres:postgres@localhost:5432/ikbr_trader"),
  IB_SOCKET_HOST: z.string().default("127.0.0.1"),
  IB_SOCKET_PORT: z.coerce.number().default(4002),
  EXECUTION_CLIENT_ID: z.coerce.number().default(102),
  IB_EXCHANGE: z.string().default("SMART"),
  IB_PRIMARY_EXCHANGE: optionalTrimmedString,
  IB_CURRENCY: z.string().default("USD"),
  WATCHLIST_CONTRACT_OVERRIDES: z.string().default(""),
  IBKR_ACCOUNT_ID: optionalTrimmedString,
  EXECUTION_DEFAULT_TIF: z.string().default("DAY"),
  EXECUTION_ORDER_TIMEOUT_MS: z.coerce.number().default(15000),
  EXECUTION_SUBMITTED_AUTO_CANCEL_MS: z.coerce.number().int().min(0).default(0),
  EXECUTION_RETRY_AS_MKT_ON_CODE_110: z.string().default("false"),
  // Fractional-share whitelist. Symbols listed here may be sent to the
  // broker with non-integer quantities (mega-cap US stocks/ETFs that
  // support fractional trading). Any symbol NOT in this list will have
  // its quantity floored to a whole share at the execution boundary as
  // a defense-in-depth guard against IBKR cancel code 320.
  EXECUTION_FRACTIONAL_SYMBOLS: z.string().default(""),
  // US Regular Trading Hours guard. When enabled, orders for US stocks
  // (USD currency) are rejected outside 09:30-16:00 America/New_York.
  // The buffer fields shrink the allowed window by N minutes after open
  // and N minutes before close to avoid auto-cancel timeouts at the bell.
  EXECUTION_BLOCK_OUTSIDE_US_RTH: z.string().default("true"),
  EXECUTION_US_RTH_OPEN_BUFFER_MIN: z.coerce.number().min(0).default(0),
  EXECUTION_US_RTH_CLOSE_BUFFER_MIN: z.coerce.number().min(0).default(10),
  // Daily loss kill-switch. When daily realized PnL (in base currency)
  // drops by more than this percent of last-known account netLiquidation,
  // the execution-engine refuses any new OPEN_OR_ADD orders.
  // CLOSE_OR_REDUCE always passes so the bot can still exit existing
  // positions. 0 disables the kill-switch.
  EXECUTION_MAX_DAILY_LOSS_PCT: z.coerce.number().min(0).max(100).default(0),
  // Alert sink. When ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID
  // are both set the execution-engine will POST alerts to that Telegram
  // chat. All alerts are always persisted to the system_alerts table.
  // ALERT_MIN_SEVERITY filters Telegram delivery only (db keeps all).
  ALERT_TELEGRAM_BOT_TOKEN: optionalTrimmedString,
  ALERT_TELEGRAM_CHAT_ID: optionalTrimmedString,
  ALERT_MIN_SEVERITY: z.enum(["info", "warn", "error"]).default("warn"),
});

const env = schema.parse(process.env);

type OverrideKey =
  | "conid"
  | "secType"
  | "exchange"
  | "primaryExchange"
  | "currency";

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

interface ContractFallback {
  symbol: string;
  secType?: string;
  exchange?: string;
  primaryExch?: string;
  currency?: string;
}

function parseContractFallbackByConid(
  raw: string,
): Record<string, ContractFallback> {
  const out: Record<string, ContractFallback> = {};
  const entries = raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [symbolRaw, pairsRaw = ""] = entry.split(":", 2);
    const symbol = symbolRaw.trim().toUpperCase();
    if (!symbol) continue;

    const patch: {
      conid?: string;
      secType?: string;
      exchange?: string;
      primaryExchange?: string;
      currency?: string;
    } = {};
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

    if (!patch.conid) continue;

    out[patch.conid] = {
      symbol,
      secType: patch.secType,
      exchange: patch.exchange,
      primaryExch: patch.primaryExchange,
      currency: patch.currency,
    };
  }

  return out;
}

export const config = {
  ...env,
  defaultSecurityType: DEFAULT_SECURITY_TYPE,
  executionRetryAsMktOnCode110:
    env.EXECUTION_RETRY_AS_MKT_ON_CODE_110.toLowerCase() === "true",
  blockOutsideUsRth:
    env.EXECUTION_BLOCK_OUTSIDE_US_RTH.toLowerCase() === "true",
  fractionalSymbols: new Set(
    env.EXECUTION_FRACTIONAL_SYMBOLS.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  ),
  contractFallbackByConid: parseContractFallbackByConid(
    env.WATCHLIST_CONTRACT_OVERRIDES,
  ),
};
