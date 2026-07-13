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
}

export interface ReadinessCheckReport {
  brokerSocket: boolean;
  activeAccountKnown: boolean;
  accountMatchesEnvironment: boolean;
  auditWriteAvailable: boolean;
  reconciliationFresh: boolean;
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
