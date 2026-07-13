// Paper/Live environment guards. See ADR-001 §3.2 / §3.3.
//
// Port numbers are intentionally NOT an input: IBKR_ENVIRONMENT is the
// sole source of truth. `activeAccountId === null` skips the whitelist
// check (bootstrap phase) — the account is validated separately by
// `ensureBrokerSession()` once the broker resolves managed accounts.

export type EnvironmentGuardReason =
  | "live_trading_disabled"
  | "account_not_allowed_for_live"
  | "account_not_allowed_for_paper";

/**
 * Thrown by `assertEnvironmentAllowsWrite` and by `ensureBrokerSession`
 * on account/environment mismatch. The Fastify error handler translates
 * this into a `423 Locked` HTTP response with a JSON body carrying
 * `{ error, reason }`.
 *
 * `423 Locked` (RFC 4918 §11.3) is deliberately different from `401`
 * (missing auth) and `403` (forbidden by permissions). It signals
 * "the resource is temporarily blocked by policy — retry after the
 * operator changes configuration".
 */
export class EnvironmentGuardError extends Error {
  readonly statusCode = 423;
  readonly reason: EnvironmentGuardReason;

  constructor(reason: EnvironmentGuardReason, message: string) {
    super(message);
    this.name = "EnvironmentGuardError";
    this.reason = reason;
  }
}

export interface EnvironmentGuardConfig {
  environment: "paper" | "live";
  tradingEnabled: boolean;
  allowedPaperAccounts: readonly string[];
  allowedLiveAccounts: readonly string[];
}

export function assertEnvironmentAllowsWrite(
  cfg: EnvironmentGuardConfig,
  activeAccountId: string | null,
): void {
  if (cfg.environment === "live") {
    if (!cfg.tradingEnabled) {
      throw new EnvironmentGuardError(
        "live_trading_disabled",
        "Live trading is disabled: TRADING_ENABLED=false. " +
          "Set TRADING_ENABLED=true (and restart execution-engine) to enable write actions in live.",
      );
    }
    if (
      activeAccountId !== null &&
      !cfg.allowedLiveAccounts.includes(activeAccountId)
    ) {
      throw new EnvironmentGuardError(
        "account_not_allowed_for_live",
        `Active account ${activeAccountId} is not in ALLOWED_LIVE_ACCOUNTS`,
      );
    }
    return;
  }

  // paper
  if (
    activeAccountId !== null &&
    !cfg.allowedPaperAccounts.includes(activeAccountId)
  ) {
    throw new EnvironmentGuardError(
      "account_not_allowed_for_paper",
      `Active account ${activeAccountId} is not in ALLOWED_PAPER_ACCOUNTS`,
    );
  }
}

/**
 * Convenience that returns the whitelist relevant to the current
 * environment. Consumed by `ensureBrokerSession()` when it needs to
 * decide whether the just-fetched managed account is allowed here.
 */
export function whitelistForEnvironment(
  cfg: EnvironmentGuardConfig,
): readonly string[] {
  return cfg.environment === "live"
    ? cfg.allowedLiveAccounts
    : cfg.allowedPaperAccounts;
}
