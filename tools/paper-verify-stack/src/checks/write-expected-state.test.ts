/**
 * PR15.3 r3 (hostile-review Finding 2) — expected-write-state
 * regression for the paper-verify-stack tool. Bypasses HTTP by
 * driving `runExecutionChecks` / `runSignalChecks` with a fake
 * `Transport` so we can prove each combination without spinning
 * up the fixture stack.
 *
 * Scenarios:
 *
 *   Phase A (writes expected disabled):
 *     A1. tradingEnabled=false, paperGuard.ok=false with
 *         `tradingEnabled=false` in the reason → BOTH checks
 *         HEALTHY (this is the false-green fix — Phase A must
 *         be able to verify infrastructure while writes are
 *         administratively paused).
 *     A2. tradingEnabled=true → execution.ready UNHEALTHY with
 *         `write_expected_disabled_but_enabled`; the operator
 *         forgot to switch back to Phase A.
 *     A3. paperGuard failure UNRELATED to tradingEnabled
 *         (e.g. environment=live) → signal.execute.ready
 *         UNHEALTHY — the exemption is narrow.
 *
 *   Phase B (writes expected enabled):
 *     B1. tradingEnabled=true, paperGuard.ok=true → HEALTHY.
 *     B2. tradingEnabled=false → execution.ready UNHEALTHY with
 *         `write_expected_enabled_but_disabled`.
 *
 *   Legacy (no expectation set, `absent`):
 *     L1. tradingEnabled=false → execution.ready still HEALTHY.
 *         Pre-PR15.3-r3 behaviour is preserved for callers that
 *         never set the flag.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Transport, TransportOutcome } from "../http.js";
import type { EndpointKey } from "../endpoints.js";
import type { ToolConfig } from "../config.js";

import { runExecutionChecks } from "./execution.js";
import { runSignalChecks } from "./signal.js";

interface Overrides {
  readonly executionReady?: Record<string, unknown>;
  readonly signalExecuteReady?: Record<string, unknown>;
}

const FRESH_ISO = "2026-08-06T00:00:00.000Z";

function makeTransport(overrides: Overrides = {}): Transport {
  const bodies: Partial<Record<EndpointKey, { status: number; body: unknown }>> = {
    INGESTION_HEALTH: { status: 200, body: { ok: true, connected: true, bootstrapped: true } },
    INGESTION_WATCHLIST: {
      status: 200,
      body: { watchlist: [], bindings: { boundCount: 0, ids: [] } },
    },
    SIGNAL_HEALTH: { status: 200, body: { ok: true } },
    SIGNAL_RUNTIME_HEALTH: { status: 200, body: { ok: true } },
    SIGNAL_RUNTIME_READY: { status: 200, body: { ready: true, checks: {} } },
    SIGNAL_EXECUTE_READY: {
      status: 200,
      body: overrides.signalExecuteReady ?? {
        ready: true,
        checks: {
          redis: { ok: true },
          postgres: { ok: true },
          paperGuard: { ok: true },
        },
      },
    },
    SIGNAL_LOOP_STATUS: {
      status: 200,
      body: {
        enabled: false,
        running: false,
        startedAt: null,
        lastCycleAt: null,
        nextCycleAt: null,
        activeInstruments: [],
        cycleCount: 0,
        lastOutcomes: {},
      },
    },
    SIGNAL_LOOP_READY: {
      status: 200,
      body: { ready: true, enabled: false, checks: {} },
    },
    EXECUTION_HEALTH: { status: 200, body: { ok: true, twsConnected: true } },
    EXECUTION_READY: {
      status: 200,
      body: overrides.executionReady ?? {
        ready: true,
        environment: "paper",
        tradingEnabled: false,
        account: "DU-TEST",
        reconciliation: { ageSeconds: 5, maxAgeSeconds: 300, lastRanAt: FRESH_ISO },
        checks: {
          brokerSocket: true,
          activeAccountKnown: true,
          accountMatchesEnvironment: true,
          auditWriteAvailable: true,
          reconciliationFresh: true,
          positionSnapshotHealthy: true,
        },
        reasons: [],
      },
    },
    EXECUTION_KILL_SWITCH: {
      status: 200,
      body: {
        enabled: true,
        triggered: false,
        dailyRealizedPnL: 0,
        dailyLossLimitAbs: 1000,
        dailyLossLimitPctEquity: 0.02,
        pauseUntil: null,
      },
    },
    RECON_LATEST: {
      status: 200,
      body: {
        accountId: "DU-TEST",
        sessionId: "sess-1",
        stale: false,
        maxAgeSeconds: 300,
        run: {
          id: 1,
          accountId: "DU-TEST",
          sessionId: "sess-1",
          status: "CLEAN",
          startedAt: FRESH_ISO,
          completedAt: FRESH_ISO,
          snapshotCapturedAt: FRESH_ISO,
          snapshotComplete: true,
          sourceCoverage: { orders: true, positions: true },
          expectedPositionsCount: 0,
          brokerPositionsCount: 0,
          matches: 0,
          mismatchesCount: 0,
          error: null,
          report: null,
        },
        latestInSession: null,
        latestOverall: null,
      },
    },
    RECON_HOLDS_ACTIVE: {
      status: 200,
      body: { accountId: "DU-TEST", holds: [] },
    },
    EXECUTION_ACCOUNT_SUMMARY: {
      status: 200,
      body: {
        accountId: "DU-TEST",
        environment: "paper",
        observedAt: FRESH_ISO,
        summary: {},
      },
    },
  };
  return {
    async get(key: EndpointKey): Promise<TransportOutcome> {
      const entry = bodies[key];
      if (!entry) {
        return {
          kind: "response",
          status: 404,
          bodyText: "not_found",
        };
      }
      return {
        kind: "response",
        status: entry.status,
        bodyText: JSON.stringify(entry.body),
      };
    },
  };
}

function makeConfig(overrides: Partial<ToolConfig>): ToolConfig {
  return {
    ingestionUrl: "http://127.0.0.1:0",
    signalUrl: "http://127.0.0.1:0",
    executionUrl: "http://127.0.0.1:0",
    executionToken: "x".repeat(64),
    timeoutMs: 1000,
    allowNonLoopback: false,
    includeAccountSummary: false,
    runtimeExpected: "registered",
    executionRuntimeExpected: "registered",
    tradingLoopExpected: "disabled",
    executionWriteExpected: "absent",
    maxTickAgeMs: 120_000,
    maxCandleAgeMs: 180_000,
    maxMarketStateAgeMs: 120_000,
    maxAccountSnapshotAgeMs: 60_000,
    loopStartupGraceMs: 0,
    json: true,
    ...overrides,
  };
}

function pick(results: ReadonlyArray<{ id: string; status: string; reasons: readonly string[] }>, id: string) {
  const r = results.find((x) => x.id === id);
  if (!r) throw new Error(`missing check ${id} in results`);
  return r;
}

describe("paper-verify-stack — Phase A (write expected disabled)", () => {
  it("A1: tradingEnabled=false + paperGuard.error mentions tradingEnabled=false → HEALTHY on both checks", async () => {
    const transport = makeTransport({
      executionReady: {
        ready: true,
        environment: "paper",
        tradingEnabled: false,
        account: "DU-TEST",
        reconciliation: { ageSeconds: 5, maxAgeSeconds: 300, lastRanAt: FRESH_ISO },
        checks: {
          brokerSocket: true,
          activeAccountKnown: true,
          accountMatchesEnvironment: true,
          auditWriteAvailable: true,
          reconciliationFresh: true,
          positionSnapshotHealthy: true,
        },
        reasons: [],
      },
      signalExecuteReady: {
        ready: false,
        checks: {
          redis: { ok: true },
          postgres: { ok: true },
          paperGuard: {
            ok: false,
            error:
              "execution-engine reports tradingEnabled=false (TRADING_ENABLED=false — administrative kill switch)",
          },
        },
      },
    });
    const cfg = makeConfig({ executionWriteExpected: "disabled" });
    const execResults = await runExecutionChecks(transport, cfg);
    const signalResults = await runSignalChecks(transport, cfg);
    assert.equal(
      pick(execResults, "execution.ready").status,
      "HEALTHY",
      "Phase A infrastructure MUST pass with tradingEnabled=false",
    );
    assert.equal(
      pick(signalResults, "signal.execute.ready").status,
      "HEALTHY",
      "Phase A infrastructure MUST accept the tradingEnabled=false paperGuard failure",
    );
  });

  it("A2: tradingEnabled=true under writeExpected=disabled → execution.ready UNHEALTHY", async () => {
    const transport = makeTransport({
      executionReady: {
        ready: true,
        environment: "paper",
        tradingEnabled: true,
        account: "DU-TEST",
        reconciliation: { ageSeconds: 5, maxAgeSeconds: 300, lastRanAt: FRESH_ISO },
        checks: {
          brokerSocket: true,
          activeAccountKnown: true,
          accountMatchesEnvironment: true,
          auditWriteAvailable: true,
          reconciliationFresh: true,
          positionSnapshotHealthy: true,
        },
        reasons: [],
      },
    });
    const cfg = makeConfig({ executionWriteExpected: "disabled" });
    const results = await runExecutionChecks(transport, cfg);
    const ready = pick(results, "execution.ready");
    assert.equal(ready.status, "UNHEALTHY");
    assert.ok(
      ready.reasons.some((r) =>
        r.includes("write_expected_disabled_but_enabled"),
      ),
      "expected the disabled-but-enabled reason",
    );
  });

  it("A3: paperGuard failure UNRELATED to kill switch stays UNHEALTHY", async () => {
    const transport = makeTransport({
      signalExecuteReady: {
        ready: false,
        checks: {
          redis: { ok: true },
          postgres: { ok: true },
          paperGuard: {
            ok: false,
            error:
              'execution-engine reports environment="live", expected "paper"',
          },
        },
      },
    });
    const cfg = makeConfig({ executionWriteExpected: "disabled" });
    const results = await runSignalChecks(transport, cfg);
    const ready = pick(results, "signal.execute.ready");
    assert.equal(
      ready.status,
      "UNHEALTHY",
      "Phase A must NOT accept a paperGuard failure that is not about the kill switch",
    );
    assert.ok(
      ready.reasons.some((r) => r.includes("paperGuard")),
      "paperGuard failure must still surface",
    );
  });
});

describe("paper-verify-stack — Phase B (write expected enabled)", () => {
  it("B1: tradingEnabled=true + paperGuard.ok=true → HEALTHY", async () => {
    const transport = makeTransport({
      executionReady: {
        ready: true,
        environment: "paper",
        tradingEnabled: true,
        account: "DU-TEST",
        reconciliation: { ageSeconds: 5, maxAgeSeconds: 300, lastRanAt: FRESH_ISO },
        checks: {
          brokerSocket: true,
          activeAccountKnown: true,
          accountMatchesEnvironment: true,
          auditWriteAvailable: true,
          reconciliationFresh: true,
          positionSnapshotHealthy: true,
        },
        reasons: [],
      },
      signalExecuteReady: {
        ready: true,
        checks: {
          redis: { ok: true },
          postgres: { ok: true },
          paperGuard: { ok: true },
        },
      },
    });
    const cfg = makeConfig({ executionWriteExpected: "enabled" });
    const execResults = await runExecutionChecks(transport, cfg);
    const signalResults = await runSignalChecks(transport, cfg);
    assert.equal(pick(execResults, "execution.ready").status, "HEALTHY");
    assert.equal(pick(signalResults, "signal.execute.ready").status, "HEALTHY");
  });

  it("B2: tradingEnabled=false under writeExpected=enabled → execution.ready UNHEALTHY", async () => {
    const transport = makeTransport({
      executionReady: {
        ready: true,
        environment: "paper",
        tradingEnabled: false,
        account: "DU-TEST",
        reconciliation: { ageSeconds: 5, maxAgeSeconds: 300, lastRanAt: FRESH_ISO },
        checks: {
          brokerSocket: true,
          activeAccountKnown: true,
          accountMatchesEnvironment: true,
          auditWriteAvailable: true,
          reconciliationFresh: true,
          positionSnapshotHealthy: true,
        },
        reasons: [],
      },
    });
    const cfg = makeConfig({ executionWriteExpected: "enabled" });
    const results = await runExecutionChecks(transport, cfg);
    const ready = pick(results, "execution.ready");
    assert.equal(ready.status, "UNHEALTHY");
    assert.ok(
      ready.reasons.some((r) =>
        r.includes("write_expected_enabled_but_disabled"),
      ),
    );
  });
});

describe("paper-verify-stack — legacy behaviour (write expected absent)", () => {
  it("L1: no expectation → tradingEnabled=false still HEALTHY (backwards compat)", async () => {
    const transport = makeTransport();
    const cfg = makeConfig({ executionWriteExpected: "absent" });
    const results = await runExecutionChecks(transport, cfg);
    assert.equal(pick(results, "execution.ready").status, "HEALTHY");
  });
});
