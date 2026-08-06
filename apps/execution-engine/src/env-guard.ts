// Paper/Live environment guards. See ADR-001 §3.2 / §3.3.
//
// Port numbers are intentionally NOT an input: IBKR_ENVIRONMENT is the
// sole source of truth. `activeAccountId === null` skips the whitelist
// check for NORMAL writes (bootstrap phase) — the account is validated
// separately by `ensureBrokerSession()` once the broker resolves managed
// accounts. Exempt / risk-reducing routes are stricter: they MUST target
// an identified account (see `assertActiveAccountAllowed(..., { requireKnownAccount: true })`).
//
// PR15.3 r3 hostile-review Finding 1 — `TRADING_ENABLED=false` is an
// administrative write switch that blocks every mutating
// `/execution/*` operation that could CREATE or EXPAND broker
// exposure — `execute-ticket`, `execute-proposed/:id`, `bootstrap`,
// `refresh-position-snapshot`, and any similar path that talks to the
// broker with the intent of establishing new state. Historically the
// flag only fired in Live; that was safe while every Paper seed
// shipped with `executionEnabled=false` but became unsafe as soon as
// a seed activation flowed a Paper ticket through this guard, so the
// r3 pass extended the check to both environments.
//
// The switch is NOT a universal block on every mutating request. A
// closed exemption list in `write-guard-exemptions.ts` lets
// RISK-REDUCING and diagnostic operations continue while writes are
// administratively paused:
//   - `POST /execution/cancel-proposed/:id`         — risk-reducing broker cancel.
//   - `POST /execution/reconciliation/run`          — operator diagnostic.
//   - `POST /execution/reconciliation/holds/:id/acknowledge`
//   - `POST /execution/reconciliation/holds/:id/resolve`
// Those exemptions bypass ONLY `assertTradingEnabled`. Bearer auth,
// audit, environment + account allowlist, and the
// `requireKnownAccount: true` variant of `assertActiveAccountAllowed`
// (see r4 below) still fire on every request.
//
// `/ready` intentionally stays 200 with `tradingEnabled=false`
// (Decision D7 — administrative pause is a policy state, not a health
// failure), so the block is enforced on the write path only.
//
// PR15.3 r4 hostile-review Finding 1 — the guard was split into two
// composable helpers: `assertTradingEnabled` (administrative write
// switch) and `assertActiveAccountAllowed` (environment + whitelist +
// optional known-account requirement). The composite
// `assertEnvironmentAllowsWrite` is preserved for the normal
// `/execution/*` write path; the closed exemption list in
// `write-guard-exemptions.ts` runs ONLY the account helper (with
// `requireKnownAccount: true`) so risk-reducing operations bypass
// ONLY the write switch, never the account allowlist, bearer auth, or
// audit.

export type EnvironmentGuardReason =
  | "live_trading_disabled"
  | "paper_trading_disabled"
  | "account_not_allowed_for_live"
  | "account_not_allowed_for_paper"
  | "no_active_account_for_exempt_route";

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

/**
 * PR15.3 r4 — pure administrative write-switch check. Emits a
 * `paper_trading_disabled` / `live_trading_disabled`
 * `EnvironmentGuardError` when `TRADING_ENABLED=false`, regardless of
 * environment. Called BEFORE the account check by the composite
 * `assertEnvironmentAllowsWrite` so the diagnostic reason
 * distinguishes an administrative pause from a wrong account.
 *
 * The closed exempt-routes list (`write-guard-exemptions.ts`)
 * INTENTIONALLY skips this helper for risk-reducing endpoints
 * (`cancel-proposed/:id` + reconciliation operator surface) so an
 * operator can neutralise broker exposure or resolve holds while
 * writes are administratively paused. Every other check
 * (`assertActiveAccountAllowed`, bearer auth, audit) still applies.
 */
export function assertTradingEnabled(cfg: EnvironmentGuardConfig): void {
  if (cfg.tradingEnabled) return;
  if (cfg.environment === "live") {
    throw new EnvironmentGuardError(
      "live_trading_disabled",
      "Live trading is disabled: TRADING_ENABLED=false. " +
        "Set TRADING_ENABLED=true (and restart execution-engine) to enable write actions in live. " +
        "This administrative switch blocks operations that create or expand broker exposure; " +
        "a closed list of risk-reducing endpoints (POST /execution/cancel-proposed/:id and " +
        "the operator reconciliation surface) remains available after bearer, audit, and " +
        "account-allowlist checks.",
    );
  }
  throw new EnvironmentGuardError(
    "paper_trading_disabled",
    "Paper trading is disabled: TRADING_ENABLED=false. " +
      "Set TRADING_ENABLED=true (and restart execution-engine) to enable write actions in paper. " +
      "This administrative switch blocks operations that create or expand broker exposure; " +
      "a closed list of risk-reducing endpoints (POST /execution/cancel-proposed/:id and " +
      "the operator reconciliation surface) remains available after bearer, audit, and " +
      "account-allowlist checks.",
  );
}

export interface AccountAllowedOptions {
  /**
   * PR15.3 r4 hostile-review Finding 1 — when true, the guard also
   * refuses `activeAccountId === null`. Set for RISK-REDUCING /
   * DIAGNOSTIC endpoints on the exempt list (`cancel-proposed/:id`,
   * reconciliation operator surface): if the process has not yet
   * resolved a broker account, there is no order or hold to cancel /
   * resolve, so accepting a null account would either be a no-op
   * (best case) or a leak (worst case, if a future refactor makes
   * the endpoint account-inference-based).
   *
   * Kept FALSE for normal write endpoints so `POST /execution/bootstrap`
   * (which is itself the endpoint that resolves the account) can
   * pass the pre-check and delegate the whitelist verification to
   * `ensureBrokerSession()`.
   */
  readonly requireKnownAccount?: boolean;
}

/**
 * PR15.3 r4 — environment + account allowlist check. Distinct from
 * `assertTradingEnabled` so the closed exempt-routes list can bypass
 * the kill switch WITHOUT bypassing the whitelist. Errors carry the
 * environment-specific reason (`account_not_allowed_for_paper` /
 * `account_not_allowed_for_live`) so the log fingerprint distinguishes
 * a Paper-to-Live cross-list attempt from an unknown DU account.
 *
 * The `requireKnownAccount` mode adds `no_active_account_for_exempt_route`
 * for risk-reducing endpoints so a pre-bootstrap process cannot
 * silently accept a cancel/reconcile against an unresolved account.
 */
export function assertActiveAccountAllowed(
  cfg: EnvironmentGuardConfig,
  activeAccountId: string | null,
  opts: AccountAllowedOptions = {},
): void {
  if (activeAccountId === null) {
    if (opts.requireKnownAccount) {
      throw new EnvironmentGuardError(
        "no_active_account_for_exempt_route",
        "No active broker account resolved yet — refusing exempt / " +
          "risk-reducing operation. The exempt-routes list " +
          "(cancel-proposed, reconciliation operator surface) requires " +
          "an identified account to guarantee the operation targets the " +
          "intended broker. Bootstrap the broker session first, or wait " +
          "for the ready reconciliation to identify the active account.",
      );
    }
    return;
  }
  const whitelist =
    cfg.environment === "live"
      ? cfg.allowedLiveAccounts
      : cfg.allowedPaperAccounts;
  if (!whitelist.includes(activeAccountId)) {
    throw new EnvironmentGuardError(
      cfg.environment === "live"
        ? "account_not_allowed_for_live"
        : "account_not_allowed_for_paper",
      `Active account ${activeAccountId} is not in ${
        cfg.environment === "live"
          ? "ALLOWED_LIVE_ACCOUNTS"
          : "ALLOWED_PAPER_ACCOUNTS"
      }`,
    );
  }
}

/**
 * PR15.3 r4 — composite guard for the NORMAL `/execution/*` write
 * path. Preserved as a single call for compile-time backwards
 * compatibility with the pre-r4 caller shape and the existing
 * env-guard.test.ts assertions on error reason precedence
 * (`live_trading_disabled` fires BEFORE the whitelist check).
 */
export function assertEnvironmentAllowsWrite(
  cfg: EnvironmentGuardConfig,
  activeAccountId: string | null,
): void {
  assertTradingEnabled(cfg);
  assertActiveAccountAllowed(cfg, activeAccountId);
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
