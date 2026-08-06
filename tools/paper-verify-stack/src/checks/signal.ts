/**
 * PR15.1 — signal-engine classifier (plan §4.3).
 */

import type { Transport } from "../http.js";
import type { ToolConfig } from "../config.js";
import {
  SignalHealthSchema,
  SignalRuntimeHealthSchema,
  SignalRuntimeReadySchema,
  SignalExecuteReadySchema,
  SignalLoopStatusSchema,
  SignalLoopReadySchema,
  type SignalLoopStatus,
} from "../schema.js";
import {
  classifyHttp,
  classifyReadiness,
  reasonTokenForHttpProblem,
  severityForHttpProblem,
  type CheckResult,
  type HttpProblem,
} from "./types.js";

function fail(
  id: string,
  problem: HttpProblem,
  prefix = id,
): CheckResult {
  const token = reasonTokenForHttpProblem(problem);
  return {
    id,
    service: "signal",
    status: severityForHttpProblem(problem),
    summary: `${id} failed: ${token}`,
    reasons: [`${prefix}:${token}`],
  };
}

export async function runSignalChecks(
  transport: Transport,
  cfg: ToolConfig,
  now = Date.now(),
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  const health = classifyHttp(
    await transport.get("SIGNAL_HEALTH"),
    SignalHealthSchema,
  );
  if (!health.ok) {
    out.push(fail("signal.health", health));
  } else {
    const ok = (health.json as { ok: boolean }).ok === true;
    out.push({
      id: "signal.health",
      service: "signal",
      status: ok ? "HEALTHY" : "UNHEALTHY",
      summary: ok ? "signal-engine reachable" : "signal-engine /health ok=false",
      reasons: ok ? [] : ["signal.health:ok_false"],
    });
  }

  const runtimeExpected = cfg.runtimeExpected;
  if (runtimeExpected === "absent") {
    out.push({
      id: "signal.runtime.health",
      service: "signal",
      status: "DISABLED",
      summary: "runtime expected absent (skipped)",
      reasons: [],
    });
    out.push({
      id: "signal.runtime.ready",
      service: "signal",
      status: "DISABLED",
      summary: "runtime readiness skipped",
      reasons: [],
    });
  } else {
    const rh = classifyHttp(
      await transport.get("SIGNAL_RUNTIME_HEALTH"),
      SignalRuntimeHealthSchema,
    );
    if (!rh.ok) {
      out.push(fail("signal.runtime.health", rh));
    } else {
      const ok = (rh.json as { ok: boolean }).ok === true;
      out.push({
        id: "signal.runtime.health",
        service: "signal",
        status: ok ? "HEALTHY" : "UNHEALTHY",
        summary: ok
          ? "runtime registered and healthy"
          : "runtime /health ok=false",
        reasons: ok ? [] : ["signal.runtime.health:ok_false"],
      });
    }
    const rr = classifyReadiness(
      await transport.get("SIGNAL_RUNTIME_READY"),
      SignalRuntimeReadySchema,
    );
    if (!rr.ok) {
      out.push(fail("signal.runtime.ready", rr));
    } else {
      const j = rr.json as {
        ready: boolean;
        checks: Record<string, { ok: boolean; error?: string }>;
      };
      const failed = Object.entries(j.checks)
        .filter(([, v]) => !v.ok)
        .map(([k]) => k);
      const unhealthy = !j.ready || failed.length > 0;
      out.push({
        id: "signal.runtime.ready",
        service: "signal",
        status: unhealthy ? "UNHEALTHY" : "HEALTHY",
        summary: unhealthy
          ? `signal runtime not ready (${failed.join(",") || "unknown"})`
          : "signal runtime ready",
        reasons: failed.map((k) => `signal.runtime.ready:${k}`),
        details: { ready: j.ready, failed },
      });
    }
  }

  const execExpected = cfg.executionRuntimeExpected;
  if (execExpected === "absent") {
    out.push({
      id: "signal.execute.ready",
      service: "signal",
      status: "DISABLED",
      summary: "execution runtime expected absent (skipped)",
      reasons: [],
    });
    out.push({
      id: "signal.trading_loop.status",
      service: "signal",
      status: "DISABLED",
      summary: "trading-loop status skipped (execution runtime absent)",
      reasons: [],
    });
    out.push({
      id: "signal.trading_loop.ready",
      service: "signal",
      status: "DISABLED",
      summary: "trading-loop readiness skipped (execution runtime absent)",
      reasons: [],
    });
    void now;
    return out;
  }

  const er = classifyReadiness(
    await transport.get("SIGNAL_EXECUTE_READY"),
    SignalExecuteReadySchema,
  );
  if (!er.ok) {
    out.push(fail("signal.execute.ready", er));
  } else {
    const j = er.json as {
      ready: boolean;
      checks: {
        redis: { ok: boolean; error?: string };
        postgres: { ok: boolean; error?: string };
        paperGuard: { ok: boolean; error?: string };
      };
    };
    const failed: string[] = [];
    if (!j.checks.redis.ok) failed.push("redis");
    if (!j.checks.postgres.ok) failed.push("postgres");
    // PR15.3 r3 (hostile-review Finding 2) — `PaperGuard` now
    // cross-checks execution-engine's `/ready.tradingEnabled`
    // and refuses when writes are administratively disabled.
    // That is the intended state during Phase A of the Paper
    // Entry E2E runbook: infrastructure must still be verifiable
    // even though PaperGuard.check() returns { ok: false,
    // reason: /tradingEnabled=false/ }.
    //
    // We therefore treat that SPECIFIC paperGuard failure as an
    // infrastructure-side pass ONLY when the operator explicitly
    // declared `PAPER_VERIFY_EXECUTION_WRITE_EXPECTED_STATE=disabled`.
    // Every other paperGuard failure (network error, environment
    // mismatch, account mismatch, missing tradingEnabled field)
    // still surfaces as UNHEALTHY. The `POST /runtime/execute`
    // and `POST /runtime/trading-loop/run-once` handlers are
    // unchanged — they continue to fail-closed on
    // `paperGuard.ok=false`, so this expected-state gate CANNOT
    // enable a submission by itself.
    const paperGuardOk = j.checks.paperGuard.ok;
    const paperGuardErr = j.checks.paperGuard.error ?? "";
    const paperGuardFailureIsExpectedKillSwitch =
      cfg.executionWriteExpected === "disabled" &&
      !paperGuardOk &&
      /tradingEnabled=false/.test(paperGuardErr);
    if (!paperGuardOk && !paperGuardFailureIsExpectedKillSwitch) {
      failed.push("paperGuard");
    }
    // Even in the accepted case, expose the runtime's raw
    // `ready:false` verdict as a distinct signal so the operator
    // knows the endpoint returned 503 (which is expected in Phase
    // A). The check itself remains HEALTHY.
    const rawReadyFalse = !j.ready;
    const unhealthy = failed.length > 0 ||
      (rawReadyFalse && !paperGuardFailureIsExpectedKillSwitch);
    out.push({
      id: "signal.execute.ready",
      service: "signal",
      status: unhealthy ? "UNHEALTHY" : "HEALTHY",
      summary: unhealthy
        ? `signal execution not ready (${failed.join(",") || "unknown"})`
        : paperGuardFailureIsExpectedKillSwitch
          ? "signal execution infrastructure ready; paper-guard reports " +
            "tradingEnabled=false (writes disabled as expected in Phase A)"
          : "signal execution ready",
      reasons: failed.map((f) => `signal.execute.ready:${f}`),
      details: {
        ready: j.ready,
        failed,
        paperGuardOk,
        writeExpected: cfg.executionWriteExpected,
        paperGuardFailureAcceptedAsKillSwitch:
          paperGuardFailureIsExpectedKillSwitch,
      },
    });
  }

  const ls = classifyHttp(
    await transport.get("SIGNAL_LOOP_STATUS"),
    SignalLoopStatusSchema,
  );
  let loopBody: SignalLoopStatus | undefined;
  if (!ls.ok) {
    out.push(fail("signal.trading_loop.status", ls));
  } else {
    loopBody = ls.json as SignalLoopStatus;
    const expected = cfg.tradingLoopExpected;
    if (expected === "disabled") {
      if (loopBody.enabled === false) {
        out.push({
          id: "signal.trading_loop.status",
          service: "signal",
          status: "DISABLED",
          summary: "trading-loop registered but disabled as expected",
          reasons: [],
          details: { enabled: false },
        });
      } else {
        out.push({
          id: "signal.trading_loop.status",
          service: "signal",
          status: "UNHEALTHY",
          summary: "trading-loop unexpectedly enabled",
          reasons: ["signal.trading_loop.status:unexpectedly_enabled"],
          details: { enabled: loopBody.enabled, running: loopBody.running },
        });
      }
    } else {
      // expected=enabled
      const reasons: string[] = [];
      if (!loopBody.enabled) reasons.push("not_enabled");
      const startedRecently =
        loopBody.startedAt !== null &&
        now - Date.parse(loopBody.startedAt) < cfg.loopStartupGraceMs;
      if (loopBody.enabled && !loopBody.running && !startedRecently) {
        reasons.push("not_running");
      }
      out.push({
        id: "signal.trading_loop.status",
        service: "signal",
        status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
        summary:
          reasons.length === 0
            ? `trading-loop enabled, cycleCount=${loopBody.cycleCount}`
            : `trading-loop not ready: ${reasons.join(",")}`,
        reasons: reasons.map((r) => `signal.trading_loop.status:${r}`),
        details: {
          enabled: loopBody.enabled,
          running: loopBody.running,
          cycleCount: loopBody.cycleCount,
          activeInstruments: loopBody.activeInstruments,
          lastCycleAt: loopBody.lastCycleAt,
          nextCycleAt: loopBody.nextCycleAt,
        },
      });
    }
  }

  const lr = classifyReadiness(
    await transport.get("SIGNAL_LOOP_READY"),
    SignalLoopReadySchema,
  );
  if (!lr.ok) {
    out.push(fail("signal.trading_loop.ready", lr));
  } else {
    const j = lr.json as {
      ready: boolean;
      enabled: boolean;
      checks: Record<string, { ok: boolean; error?: string }>;
    };
    const failed = Object.entries(j.checks)
      .filter(([, v]) => !v.ok)
      .map(([k]) => k);
    if (cfg.tradingLoopExpected === "enabled") {
      const reasons: string[] = [];
      if (!j.enabled) reasons.push("not_enabled");
      if (!j.ready) reasons.push("not_ready");
      for (const k of failed) reasons.push(`check_${k}`);
      // Cross-consistency between status and ready.
      if (loopBody && loopBody.enabled !== j.enabled) {
        reasons.push("enabled_status_ready_mismatch");
      }
      out.push({
        id: "signal.trading_loop.ready",
        service: "signal",
        status: reasons.length === 0 ? "HEALTHY" : "UNHEALTHY",
        summary:
          reasons.length === 0
            ? "trading-loop ready"
            : `trading-loop not ready: ${reasons.join(",")}`,
        reasons: reasons.map((r) => `signal.trading_loop.ready:${r}`),
        details: { ready: j.ready, enabled: j.enabled, failed },
      });
    } else {
      // expected=disabled — probe informationally; we already
      // encoded the disabled-state verdict via status above.
      out.push({
        id: "signal.trading_loop.ready",
        service: "signal",
        status: "DISABLED",
        summary: `trading-loop readiness probed (ready=${j.ready}) — expected disabled`,
        reasons: [],
        details: { ready: j.ready, enabled: j.enabled, failed },
      });
    }
  }

  void now;
  return out;
}
