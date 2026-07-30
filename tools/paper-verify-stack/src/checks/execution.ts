/**
 * PR15.1 — execution-engine classifier (plan §4.3, §4.4).
 *
 * Order:
 *   1. /health
 *   2. /ready (Bearer)
 *   3. reconciliation /latest + /holds?active=true (Bearer)
 *   4. account-summary (Bearer, opt-in — issued FIRST of
 *      the cache-coupled pair per plan §4.4)
 *   5. kill-switch (Bearer)
 *
 * Kill-switch is only issued if either
 *   - opt-in path AND account-summary reached HEALTHY, OR
 *   - opt-out path (default) — cache-missing is UNHEALTHY.
 */

import type { Transport } from "../http.js";
import type { ToolConfig } from "../config.js";
import {
  ExecutionHealthSchema,
  ExecutionReadySchema,
  KillSwitchSchema,
  ReconLatestSchema,
  ReconHoldsSchema,
  AccountSummarySchema,
  type ExecutionReady,
  type KillSwitch,
  type ReconLatest,
  type ReconHolds,
} from "../schema.js";
import {
  classifyHttp,
  classifyReadiness,
  reasonTokenForHttpProblem,
  severityForHttpProblem,
  type CheckResult,
  type HttpProblem,
} from "./types.js";

function fail(id: string, problem: HttpProblem): CheckResult {
  const token = reasonTokenForHttpProblem(problem);
  return {
    id,
    service: "execution",
    status: severityForHttpProblem(problem),
    summary: `${id} failed: ${token}`,
    reasons: [`${id}:${token}`],
  };
}

export async function runExecutionChecks(
  transport: Transport,
  cfg: ToolConfig,
  now = Date.now(),
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // /health (no bearer)
  const h = classifyHttp(
    await transport.get("EXECUTION_HEALTH"),
    ExecutionHealthSchema,
  );
  if (!h.ok) {
    out.push(fail("execution.health", h));
  } else {
    const j = h.json as { ok: boolean; twsConnected: boolean };
    const reasons: string[] = [];
    if (!j.ok) reasons.push("ok_false");
    if (!j.twsConnected) reasons.push("tws_not_connected");
    out.push({
      id: "execution.health",
      service: "execution",
      status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
      summary:
        reasons.length === 0
          ? "execution-engine connected to TWS"
          : `execution health degraded: ${reasons.join(",")}`,
      reasons: reasons.map((r) => `execution.health:${r}`),
      details: { ok: j.ok, twsConnected: j.twsConnected },
    });
  }

  const tokenAvailable =
    typeof cfg.executionToken === "string" && cfg.executionToken.length > 0;
  if (!tokenAvailable) {
    // Defense-in-depth: parseConfig already CONFIG_ERRORs on
    // missing token so this branch is unreachable in normal
    // operation. Kept fail-closed to catch mis-wiring.
    out.push({
      id: "execution.token",
      service: "execution",
      status: "CONFIG_ERROR",
      summary: "execution token unavailable",
      reasons: ["execution.token:missing"],
    });
    void now;
    return out;
  }

  // /ready
  const rd = classifyReadiness(
    await transport.get("EXECUTION_READY"),
    ExecutionReadySchema,
  );
  if (!rd.ok) {
    out.push(fail("execution.ready", rd));
  } else {
    const j = rd.json as ExecutionReady;
    const reasons: string[] = [];
    if (!j.ready) reasons.push("not_ready");
    if (j.environment !== "paper") reasons.push("environment_not_paper");
    if (j.account === null) reasons.push("account_null");
    for (const [k, v] of Object.entries(j.checks)) {
      if (v === false) reasons.push(`check_${k}_false`);
    }
    for (const r of j.reasons) reasons.push(`reason_${r}`);
    out.push({
      id: "execution.ready",
      service: "execution",
      status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
      summary:
        reasons.length === 0
          ? `execution ready (env=${j.environment}, tradingEnabled=${j.tradingEnabled})`
          : `execution not ready: ${reasons.join(",")}`,
      reasons: reasons.map((r) => `execution.ready:${r}`),
      details: {
        ready: j.ready,
        environment: j.environment,
        tradingEnabled: j.tradingEnabled,
        account: j.account,
        reconciliation: j.reconciliation,
        checks: j.checks,
      },
    });
  }

  // /reconciliation/latest
  const rl = classifyHttp(
    await transport.get("RECON_LATEST"),
    ReconLatestSchema,
  );
  if (!rl.ok) {
    out.push(fail("execution.reconciliation.latest", rl));
  } else {
    const j = rl.json as ReconLatest;
    const reasons: string[] = [];
    if (j.stale === true) reasons.push("stale");
    if (j.run === null) {
      reasons.push("no_run_recorded");
    } else {
      // Cross-session run means we are looking at somebody
      // else's reconciliation. Never trust it.
      if (j.run.sessionId !== j.sessionId) {
        reasons.push("wrong_session");
      }
      if (j.run.snapshotComplete === false) {
        reasons.push("snapshot_incomplete");
      }
      switch (j.run.status) {
        case "CLEAN":
          break;
        case "MISMATCH":
          // MISMATCH is a genuine broker/local divergence.
          // Policy: covered by the active-holds check below —
          // the reconciliation service is expected to open a
          // hold for any MISMATCH that requires operator
          // action. We therefore do NOT flip UNHEALTHY on
          // MISMATCH alone; the holds probe carries that
          // verdict. See docs/runbooks/PAPER_STACK_VERIFICATION.md.
          break;
        case "RUNNING":
          reasons.push("status_running");
          break;
        case "FAILED":
          reasons.push("status_failed");
          break;
        case "INCOMPLETE":
          reasons.push("status_incomplete");
          break;
        case "ABANDONED":
          reasons.push("status_abandoned");
          break;
      }
    }
    out.push({
      id: "execution.reconciliation.latest",
      service: "execution",
      status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
      summary:
        reasons.length === 0
          ? `reconciliation fresh (status=${j.run?.status ?? "-"})`
          : `reconciliation: ${reasons.join(",")}`,
      reasons: reasons.map((r) => `execution.reconciliation.latest:${r}`),
      details: {
        stale: j.stale,
        maxAgeSeconds: j.maxAgeSeconds,
        run: j.run,
        accountId: j.accountId,
        sessionId: j.sessionId,
      },
    });
  }

  // /reconciliation/holds?active=true
  const holds = classifyHttp(
    await transport.get("RECON_HOLDS_ACTIVE"),
    ReconHoldsSchema,
  );
  if (!holds.ok) {
    out.push(fail("execution.reconciliation.holds", holds));
  } else {
    const j = holds.json as ReconHolds;
    const active = j.holds.filter((x) => x.active);
    out.push({
      id: "execution.reconciliation.holds",
      service: "execution",
      status: active.length === 0 ? "HEALTHY" : "UNHEALTHY",
      summary:
        active.length === 0
          ? "no active reconciliation holds"
          : `${active.length} active reconciliation hold(s)`,
      reasons: active.map((x) => `execution.reconciliation.holds:${x.reason}`),
      details: { activeCount: active.length, total: j.holds.length },
    });
  }

  // Account-summary / kill-switch cache coupling.
  let accountSummaryHealthy = false;
  if (cfg.includeAccountSummary) {
    const as = classifyHttp(
      await transport.get("EXECUTION_ACCOUNT_SUMMARY"),
      AccountSummarySchema,
    );
    if (!as.ok) {
      const status = severityForHttpProblem(as);
      const token = reasonTokenForHttpProblem(as);
      out.push({
        id: "execution.account.summary",
        service: "execution",
        status,
        summary: `account-summary failed: ${token}`,
        reasons: [`execution.account.summary:${token}`],
      });
    } else {
      accountSummaryHealthy = true;
      out.push({
        id: "execution.account.summary",
        service: "execution",
        status: "HEALTHY",
        summary: "account-summary refreshed broker snapshot cache",
        reasons: [],
      });
    }
  } else {
    out.push({
      id: "execution.account.summary",
      service: "execution",
      status: "DISABLED",
      summary: "account-summary skipped (opt-in only)",
      reasons: [],
    });
  }

  if (cfg.includeAccountSummary && !accountSummaryHealthy) {
    // Do NOT issue kill-switch — record dependency failure.
    out.push({
      id: "execution.kill_switch",
      service: "execution",
      status: "UNHEALTHY",
      summary:
        "kill-switch not evaluated: account-summary dependency did not reach HEALTHY",
      reasons: ["execution.kill_switch:dependency_failed_account_summary"],
    });
    return out;
  }

  const ks = classifyHttp(
    await transport.get("EXECUTION_KILL_SWITCH"),
    KillSwitchSchema,
  );
  if (!ks.ok) {
    out.push(fail("execution.kill_switch", ks));
    return out;
  }
  const j = ks.json as KillSwitch;
  const reasons: string[] = [];
  const cacheAge = j.diagnostics.snapshotCacheAgeMs;
  const cacheUnpopulated = cacheAge === undefined || cacheAge <= 0;
  const netLiqMissingOrZero =
    j.netLiquidation === undefined || j.netLiquidation <= 0;

  if (j.triggered) reasons.push("triggered");
  if (j.enabled === false) {
    // Informational — protection disabled.
    out.push({
      id: "execution.kill_switch",
      service: "execution",
      status: "DEGRADED",
      summary: "kill-switch enabled=false — daily-loss protection disabled",
      reasons: ["execution.kill_switch:enabled_false"],
      details: {
        enabled: false,
        triggered: j.triggered,
        dailyRealizedPnL: j.dailyRealizedPnL,
      },
    });
    return out;
  }
  // enabled === true beyond here
  if (j.diagnostics.complete === false) reasons.push("kill_switch_incomplete");
  if (netLiqMissingOrZero) {
    reasons.push(
      cacheUnpopulated
        ? "kill_switch_cache_unpopulated"
        : "kill_switch_netliquidation_unavailable",
    );
  }
  if (!cacheUnpopulated && cacheAge! > cfg.maxAccountSnapshotAgeMs) {
    reasons.push("kill_switch_snapshot_stale");
  } else if (cacheUnpopulated && !reasons.includes("kill_switch_cache_unpopulated")) {
    reasons.push("kill_switch_cache_unpopulated");
  }
  const hint = reasons.includes("kill_switch_cache_unpopulated")
    ? " (hint: enable PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true to refresh account cache)"
    : "";
  out.push({
    id: "execution.kill_switch",
    service: "execution",
    status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
    summary:
      reasons.length === 0
        ? `kill-switch armed, pnl=${j.dailyRealizedPnL}`
        : `kill-switch: ${reasons.join(",")}${hint}`,
    reasons: reasons.map((r) => `execution.kill_switch:${r}`),
    details: {
      enabled: j.enabled,
      triggered: j.triggered,
      dailyRealizedPnL: j.dailyRealizedPnL,
      baseCurrency: j.baseCurrency,
      snapshotCacheAgeMs: cacheAge ?? null,
      netLiquidation: j.netLiquidation ?? null,
      diagnostics: j.diagnostics,
    },
  });

  void now;
  return out;
}
