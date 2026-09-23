import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const DEFAULT_SECURITY_TYPE = "STK";

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

// -----------------------------------------------------------------------
// Execution Security (Phase 1, PR1) — schema-only in this PR.
// No runtime enforcement is added yet; the values are parsed, validated,
// and logged at startup. Runtime enforcement lands in PR2..PR5.
// -----------------------------------------------------------------------
const rawSchema = z.object({
  EXECUTION_BROKER_TIME_ZONE: z.preprocess(
    value => value === "" ? undefined : value, z.literal("UTC").optional()),
  EXECUTION_INGESTION_BASE_URL: z.string().url().default("http://ingestion:3101"),
  EXECUTION_AI_MAX_NOTIONAL_PCT: z.coerce.number().positive().max(100).default(10),
  EXECUTION_AI_MAX_STOP_RISK_PCT: z.coerce.number().positive().max(100).default(0.5),
  EXECUTION_AI_MAX_EXPOSURE_PCT: z.coerce.number().positive().max(100).default(25),
  EXECUTION_AI_MAX_NOTIONAL_PLN: z.coerce.number().finite().positive().default(500),
  EXECUTION_AI_MAX_STOP_RISK_PLN: z.coerce.number().finite().positive().default(5),
  EXECUTION_AI_FEE_RESERVE_PLN: z.coerce.number().finite().positive().default(30),
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

  // --- Phase 1 / PR1: Execution Security envs (schema-only). ---
  // Source of truth for broker environment. NEVER inferred from IB_SOCKET_PORT.
  IBKR_ENVIRONMENT: z.enum(["paper", "live"]).default("paper"),
  // Master switch for write actions. Required = true to trade in live.
  // Runtime enforcement in PR3.
  // Strict binary: must be the literal string 'true' or 'false'.
  TRADING_ENABLED: z.enum(["true", "false"]).default("false"),
  // Whitelists of IBKR account IDs per environment (CSV).
  // Fail-closed at bootstrap when active account is not in the whitelist
  // corresponding to IBKR_ENVIRONMENT (enforced in PR3).
  ALLOWED_PAPER_ACCOUNTS: z.string().default(""),
  ALLOWED_LIVE_ACCOUNTS: z.string().default(""),
  // Fastify listen host.
  //
  // Runtime enforcement nastąpi w PR2 (zmiana `app.listen({ host })`
  // w apps/execution-engine/src/index.ts).
  // W PR1 pole istnieje wyłącznie jako część nowego modelu konfiguracji —
  // nikt jeszcze go nie czyta w runtime.
  //
  // Domyślnie 127.0.0.1 dla lokalnego dev; docker-compose nadpisuje na
  // 0.0.0.0 jawnie, żeby sibling-kontenery mogły dosięgnąć serwisu.
  EXECUTION_BIND_HOST: z.string().default("127.0.0.1"),
  // Bearer token for Authorization header on all mutating endpoints.
  // Runtime enforcement (middleware) in PR2. In PR1 we only validate
  // presence/length when running in live or trading-enabled configurations.
  //
  // Phase 1 constraint (ADR-001): the SAME token value is used by every
  // internal client (llm-agent, signal-engine, ui). Per-client tokens
  // require multi-token server support and are deferred.
  EXECUTION_API_TOKEN: optionalTrimmedString,
  // Allow orderType='MKT'. Default off; runtime enforcement in PR5.
  // Strict binary.
  EXECUTION_ALLOW_MKT: z.enum(["true", "false"]).default("false"),
  // Allow POST /execution/execute-ticket with persist=false.
  // Default off; runtime enforcement in PR4. Strict binary.
  EXECUTION_ALLOW_DIRECT_TICKET: z.enum(["true", "false"]).default("false"),
  // Max age (seconds) of the last reconciliation for /ready to stay 200.
  // Runtime enforcement in PR3.
  EXECUTION_READY_RECONCILIATION_MAX_AGE_S: z.coerce
    .number()
    .int()
    .min(0)
    .default(900),
  // PR14 round-4 blocker — freshness threshold for the persisted
  // broker-position snapshot returned by the
  // `/execution/account/summary` DISPLAY endpoint (UI cache TTL).
  // NOT used by the write-path exposure guard; see
  // `EXECUTION_POSITION_GUARD_MAX_AGE_S`.
  EXECUTION_POSITION_MAX_AGE_S: z.coerce.number().int().min(1).default(60),
  // PR14 round-7 blocker — SEPARATE freshness threshold for the
  // authoritative write-path exposure guard
  // (`tryStartSubmissionWithExposureGuard` +
  // `insertProposedFromTicket`). Must be significantly shorter
  // than the display cache TTL because the guard controls
  // exposure-increasing writes — a 60 s window is wide enough
  // for many broker fills to land undetected between the snapshot
  // and the write. Default 10 s; production deployments should
  // tighten further and rely on the broker-driven refresh path
  // (fill events / reconnect / position callback) to keep the
  // snapshot within the window.
  EXECUTION_POSITION_GUARD_MAX_AGE_S: z.coerce
    .number()
    .int()
    .min(1)
    .default(10),

  // --- PR15: Durable reconciliation + recovery ---
  // Master switch for the reconciliation scheduler. Default on for
  // paper. Even when off the routes stay available so operators
  // can trigger a run manually. When on, the scheduler ticks at
  // RECONCILIATION_INTERVAL_MS (with a floor of MIN_INTERVAL_MS).
  RECONCILIATION_LOOP_ENABLED: z.enum(["true", "false"]).default("true"),
  RECONCILIATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(60_000),
  RECONCILIATION_STARTUP_DELAY_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(2_000),
  RECONCILIATION_MIN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(15_000),
  RECONCILIATION_SOURCE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .default(8_000),
  RECONCILIATION_RUN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(45_000),
  RECONCILIATION_EXECUTION_SAFETY_MARGIN_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(300_000),
  // Secondary token for POST /execution/reconciliation/holds/:id/resolve.
  // MUST differ from EXECUTION_API_TOKEN. If empty, the resolve
  // endpoint is 403 by design.
  EXECUTION_RECONCILIATION_RESOLVE_TOKEN: optionalTrimmedString,

  // --- PR15.2: Authoritative instrument binding ---
  // Optional JSON array pinning logical registry `instrumentId`s to
  // exact IBKR contract identities (conId + localSymbol +
  // tradingClass + exchange + currency). Empty / unset means no
  // registry-bound Phase 2 tickets are accepted; the legacy
  // `/execution/execute-proposed/:id` path continues to work. See
  // `docs/architecture/INSTRUMENT_REGISTRY.md` §Bindings.
  //
  // NEVER log the raw value — an operator may reasonably paste a
  // production-facing dated contract mapping and we treat it like
  // any other secret.
  INSTRUMENT_BINDINGS_JSON: z.string().default(""),
});

const parseBoolFlag = (raw: "true" | "false"): boolean => raw === "true";

const parseAccountList = (raw: string): readonly string[] =>
  Object.freeze(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

type RawExecutionEnv = z.infer<typeof rawSchema>;

/**
 * Cross-field validation for the Phase 1 Execution Security envs.
 *
 * Extracted from the schema so that:
 *  - the schema stays a flat description of shapes,
 *  - the safety rules are readable in one place,
 *  - unit tests can (in future PRs) exercise the validator directly if needed.
 *
 * Kept side-effect free: it only calls `ctx.addIssue(...)`. The actual
 * "throw" happens inside Zod's `.parse(...)`.
 */
function validateExecutionSecurity(
  data: RawExecutionEnv,
  ctx: z.RefinementCtx,
): void {
  const tradingEnabled = parseBoolFlag(data.TRADING_ENABLED);
  const isLive = data.IBKR_ENVIRONMENT === "live";

  // Token is required when we are (or want to be) able to trade.
  // Even if runtime enforcement lands in PR2, we reject misconfiguration
  // now so that operators cannot bring the process up in a state that
  // *would* be unsafe once PR2 merges.
  if (isLive || tradingEnabled) {
    const token = data.EXECUTION_API_TOKEN ?? "";
    if (token.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EXECUTION_API_TOKEN"],
        message:
          "EXECUTION_API_TOKEN is required and must be at least 32 characters " +
          "when IBKR_ENVIRONMENT=live or TRADING_ENABLED=true. " +
          "Generate one with: openssl rand -hex 32",
      });
    }
  }

  if (isLive) {
    const liveAccounts = parseAccountList(data.ALLOWED_LIVE_ACCOUNTS);
    if (liveAccounts.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ALLOWED_LIVE_ACCOUNTS"],
        message:
          "ALLOWED_LIVE_ACCOUNTS must contain at least one account ID " +
          "when IBKR_ENVIRONMENT=live",
      });
    }
  }

  // TRADING_ENABLED=true in paper is legal but slightly unusual;
  // TRADING_ENABLED=true in live requires the token check above.
  // We do NOT force TRADING_ENABLED=true for live here — an operator may
  // legitimately boot execution-engine in live environment with trading
  // disabled (audit/observation mode).
}

const schema = rawSchema.superRefine(validateExecutionSecurity);

export type ExecutionConfigInput = z.input<typeof rawSchema>;

interface Phase1DerivedFields {
  tradingEnabled: boolean;
  allowMkt: boolean;
  allowDirectTicket: boolean;
  allowedPaperAccounts: readonly string[];
  allowedLiveAccounts: readonly string[];
  allowedAccountsForEnvironment(): readonly string[];
}

/**
 * Compute the Phase 1 derived fields (booleans + parsed whitelists +
 * environment-aware helper). Split out from `buildExecutionConfig` so that
 * the factory stays a thin assembly step and the rules that turn raw envs
 * into runtime primitives live in one place.
 */
function buildPhase1Derived(env: RawExecutionEnv): Phase1DerivedFields {
  const tradingEnabled = parseBoolFlag(env.TRADING_ENABLED);
  const allowMkt = parseBoolFlag(env.EXECUTION_ALLOW_MKT);
  const allowDirectTicket = parseBoolFlag(env.EXECUTION_ALLOW_DIRECT_TICKET);
  const allowedPaperAccounts = parseAccountList(env.ALLOWED_PAPER_ACCOUNTS);
  const allowedLiveAccounts = parseAccountList(env.ALLOWED_LIVE_ACCOUNTS);
  return {
    tradingEnabled,
    allowMkt,
    allowDirectTicket,
    allowedPaperAccounts,
    allowedLiveAccounts,
    allowedAccountsForEnvironment(): readonly string[] {
      return env.IBKR_ENVIRONMENT === "live"
        ? allowedLiveAccounts
        : allowedPaperAccounts;
    },
  };
}

/**
 * Compute legacy (pre-Phase-1) derived fields that were previously inlined
 * at the module-level `export const config = { ... }`. Split out so that
 * `buildExecutionConfig` stays readable.
 */
function buildLegacyDerived(env: RawExecutionEnv) {
  return {
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
}

/**
 * Build the execution-engine config from an arbitrary env object.
 * Used by both the module-level `config` singleton and unit tests
 * (so tests can drive different env combinations without mutating
 * process.env or re-importing the module).
 */
export function buildExecutionConfig(
  rawEnv: NodeJS.ProcessEnv | Record<string, unknown>,
) {
  const env = schema.parse(rawEnv);
  return {
    ...env,
    ...buildLegacyDerived(env),
    ...buildPhase1Derived(env),
  };
}

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

export const config = buildExecutionConfig(process.env);
