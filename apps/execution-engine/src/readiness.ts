// Readiness evaluator for GET /ready. Distinct from /health (liveness).
// See ADR-001 §3.6 for semantics, including decision D7 (TRADING_ENABLED=false
// in live remains ready:true — administratively paused is a policy state,
// not a readiness failure).

export interface ReadinessInputs {
  now: Date;
  environment: "paper" | "live";
  tradingEnabled: boolean;
  brokerSocketUp: boolean;
  activeAccountId: string | null;
  accountAllowedByEnvironment: boolean;
  auditWriteAvailable: boolean;
  lastReconciliationAt: Date | null;
  reconciliationMaxAgeSeconds: number;
  /**
   * PR14 round-7 blocker — health of the broker-driven
   * position-snapshot refresher for the active account. When
   * missing / in-flight / failed the write path is fail-closed
   * (guard returns `POSITION_STATE_UNAVAILABLE`); `/ready` must
   * surface that so operators can distinguish it from a broker
   * socket outage.
   */
  positionSnapshotHealth?: PositionSnapshotHealthInput;
}

export type PositionSnapshotHealthInput =
  | { readonly kind: "never" }
  | { readonly kind: "healthy" }
  | { readonly kind: "in_flight" }
  | { readonly kind: "failed"; readonly error: string };

export interface ReadinessCheckReport {
  brokerSocket: boolean;
  activeAccountKnown: boolean;
  accountMatchesEnvironment: boolean;
  auditWriteAvailable: boolean;
  reconciliationFresh: boolean;
  positionSnapshotHealthy: boolean;
}

export interface ReadinessResponse {
  ready: boolean;
  environment: "paper" | "live";
  tradingEnabled: boolean;
  account: string | null;
  reconciliation: {
    ageSeconds: number | null;
    maxAgeSeconds: number;
    lastRanAt: string | null;
  };
  checks: ReadinessCheckReport;
  reasons: string[];
}

export interface ReadinessResult {
  statusCode: 200 | 503;
  body: ReadinessResponse;
}

export function evaluateReadiness(input: ReadinessInputs): ReadinessResult {
  const activeAccountKnown = input.activeAccountId !== null;

  const ageMs =
    input.lastReconciliationAt !== null
      ? Math.max(
          0,
          input.now.getTime() - input.lastReconciliationAt.getTime(),
        )
      : null;
  const ageSeconds = ageMs === null ? null : Math.floor(ageMs / 1000);
  const reconciliationFresh =
    ageSeconds !== null && ageSeconds <= input.reconciliationMaxAgeSeconds;

  const checks: ReadinessCheckReport = {
    brokerSocket: input.brokerSocketUp,
    activeAccountKnown,
    accountMatchesEnvironment:
      activeAccountKnown && input.accountAllowedByEnvironment,
    auditWriteAvailable: input.auditWriteAvailable,
    reconciliationFresh,
    // Round-7 blocker: absent input is treated as HEALTHY only
    // when there is no active account (bootstrap pending — the
    // `no_active_account` reason already covers it). Otherwise
    // the refresher MUST have run at least once with success.
    positionSnapshotHealthy:
      !activeAccountKnown ||
      (input.positionSnapshotHealth !== undefined &&
        input.positionSnapshotHealth.kind === "healthy"),
  };

  const reasons: string[] = [];
  if (!checks.brokerSocket) reasons.push("broker_socket_down");
  if (!checks.activeAccountKnown) reasons.push("no_active_account");
  else if (!checks.accountMatchesEnvironment) {
    reasons.push(
      input.environment === "live"
        ? "account_not_allowed_for_live"
        : "account_not_allowed_for_paper",
    );
  }
  if (!checks.auditWriteAvailable) reasons.push("audit_write_unavailable");
  if (!checks.reconciliationFresh) {
    reasons.push(
      input.lastReconciliationAt === null
        ? "no_reconciliation_yet"
        : "reconciliation_stale",
    );
  }
  if (activeAccountKnown && !checks.positionSnapshotHealthy) {
    const h = input.positionSnapshotHealth;
    reasons.push(
      h === undefined || h.kind === "never"
        ? "position_snapshot_never_synced"
        : h.kind === "in_flight"
          ? "position_snapshot_refresh_in_flight"
          : "position_snapshot_refresh_failed",
    );
  }

  // Decision D7: tradingEnabled=false does NOT block readiness.
  const ready = reasons.length === 0;

  const body: ReadinessResponse = {
    ready,
    environment: input.environment,
    tradingEnabled: input.tradingEnabled,
    account: input.activeAccountId,
    reconciliation: {
      ageSeconds,
      maxAgeSeconds: input.reconciliationMaxAgeSeconds,
      lastRanAt:
        input.lastReconciliationAt !== null
          ? input.lastReconciliationAt.toISOString()
          : null,
    },
    checks,
    reasons,
  };

  return {
    statusCode: ready ? 200 : 503,
    body,
  };
}
