/**
 * PR15.1 — end-to-end fetch-fixture tests covering
 * severity taxonomy, HTTP taxonomy, per-service health,
 * expected-state matrix, kill-switch cache coupling,
 * DISABLED-neutral aggregation, and transport safety.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { run } from "./index.js";
import { ENDPOINTS, type EndpointKey } from "./endpoints.js";
import {
  aggregate,
  type CheckResult,
  type CheckStatus,
} from "./checks/types.js";

type FixtureResponse = { status: number; body: string };
type Handler = (url: string, init: RequestInit) =>
  | FixtureResponse
  | Promise<FixtureResponse>;
type Handlers = Partial<Record<EndpointKey, Handler>>;

const NOW = Date.parse("2025-05-08T12:00:00.000Z");
const FRESH_ISO = new Date(NOW - 5_000).toISOString();
const STALE_ISO = new Date(NOW - 10 * 60_000).toISOString();

function jsonBody(payload: unknown, status = 200): FixtureResponse {
  return { status, body: JSON.stringify(payload) };
}

const OK: Record<EndpointKey, FixtureResponse> = {
  INGESTION_HEALTH: jsonBody({
    ok: true,
    connected: true,
    bootstrapped: true,
    bootstrapping: false,
    lastBootstrapAt: FRESH_ISO,
    lastTickAt: FRESH_ISO,
    lastCandleAt: FRESH_ISO,
  }),
  INGESTION_WATCHLIST: jsonBody({
    connected: true,
    bootstrapped: true,
    watchlist: [
      {
        symbol: "AAPL",
        displayName: "Apple",
        conid: "265598",
        subscribed: true,
        marketState: { ts: FRESH_ISO },
        latestCandle1m: { ts: FRESH_ISO },
      },
    ],
  }),
  SIGNAL_HEALTH: jsonBody({ ok: true }),
  SIGNAL_RUNTIME_HEALTH: jsonBody({ ok: true }),
  SIGNAL_RUNTIME_READY: jsonBody({
    ready: true,
    checks: { init: { ok: true } },
  }),
  SIGNAL_EXECUTE_READY: jsonBody({
    ready: true,
    checks: {
      redis: { ok: true },
      postgres: { ok: true },
      paperGuard: { ok: true },
    },
  }),
  SIGNAL_LOOP_STATUS: jsonBody({
    enabled: false,
    running: false,
    startedAt: null,
    lastCycleAt: null,
    nextCycleAt: null,
    activeInstruments: [],
    cycleCount: 0,
    lastOutcomes: {},
  }),
  SIGNAL_LOOP_READY: jsonBody({
    ready: true,
    enabled: false,
    checks: { init: { ok: true } },
  }),
  EXECUTION_HEALTH: jsonBody({ ok: true, twsConnected: true }),
  EXECUTION_READY: jsonBody({
    ready: true,
    environment: "paper",
    tradingEnabled: false,
    account: "DU1234567",
    reconciliation: {
      ageSeconds: 5,
      maxAgeSeconds: 300,
      lastRanAt: FRESH_ISO,
    },
    checks: {
      brokerSocket: true,
      activeAccountKnown: true,
      accountMatchesEnvironment: true,
      auditWriteAvailable: true,
      reconciliationFresh: true,
      positionSnapshotHealthy: true,
    },
    reasons: [],
  }),
  RECON_LATEST: jsonBody({
    accountId: "DU1234567",
    sessionId: "sess-1",
    run: {
      sessionId: "sess-1",
      accountId: "DU1234567",
      completedAt: FRESH_ISO,
      status: "CLEAN",
      snapshotComplete: true,
    },
    stale: false,
    maxAgeSeconds: 300,
  }),
  RECON_HOLDS_ACTIVE: jsonBody({ holds: [] }),
  EXECUTION_ACCOUNT_SUMMARY: jsonBody({
    accountId: "DU1234567",
    netLiquidation: 100_000,
  }),
  EXECUTION_KILL_SWITCH: jsonBody({
    enabled: true,
    triggered: false,
    dailyRealizedPnL: 0,
    baseCurrency: "USD",
    since: FRESH_ISO,
    thresholds: { maxDailyLossPct: 5 },
    netLiquidation: 100_000,
    diagnostics: {
      missingFxRates: 0,
      missingCommissionReports: 0,
      complete: true,
      snapshotCacheAgeMs: 1_000,
    },
  }),
};

function installFetch(overrides: Handlers = {}): {
  calls: Array<{ method: string; url: string; headers: Headers }>;
} {
  const calls: Array<{ method: string; url: string; headers: Headers }> = [];
  const routes = new Map<string, Handler>();
  for (const key of Object.keys(ENDPOINTS) as EndpointKey[]) {
    const d = ENDPOINTS[key];
    const base =
      d.service === "ingestion"
        ? "http://127.0.0.1:3101"
        : d.service === "signal"
          ? "http://127.0.0.1:3102"
          : "http://127.0.0.1:3103";
    const fallback: Handler = () => OK[key];
    routes.set(`${base}${d.path}`, overrides[key] ?? fallback);
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const headers = new Headers(init?.headers ?? {});
    calls.push({
      method: String(init?.method ?? "GET"),
      url,
      headers,
    });
    const h = routes.get(url);
    if (!h) return new Response("not_found", { status: 404 });
    const res = await h(url, init ?? {});
    return new Response(res.body, { status: res.status });
  }) as typeof globalThis.fetch;
  return { calls };
}

const BASE_ENV = {
  PAPER_VERIFY_EXECUTION_TOKEN: "test-token-abcdefghijklmnopqrstuvwxyz-1234",
  PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
  PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "disabled",
};

let originalFetch: typeof globalThis.fetch;

function parse(output: string): {
  overall: CheckStatus;
  exitCode: number;
  results: Array<{ id: string; status: CheckStatus; reasons: string[] }>;
} {
  return JSON.parse(output);
}

function get(
  j: ReturnType<typeof parse>,
  id: string,
): { id: string; status: CheckStatus; reasons: string[] } {
  const r = j.results.find((x) => x.id === id);
  assert.ok(r, `result ${id} not present`);
  return r;
}

describe("PR15.1 end-to-end", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("A — fully healthy paper stack → HEALTHY, exit 0", async () => {
    installFetch();
    const r = await run(["--json"], BASE_ENV, NOW);
    assert.equal(r.exitCode, 0, r.output);
    const j = parse(r.output);
    assert.equal(j.overall, "HEALTHY");
  });

  it("B — execution URL connection refused → UNREACHABLE, exit 20", async () => {
    installFetch({
      EXECUTION_HEALTH: () => {
        const err = new Error("fetch failed");
        (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        throw err;
      },
      EXECUTION_READY: () => {
        const err = new Error("fetch failed");
        (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        throw err;
      },
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    assert.equal(r.exitCode, 20);
    const j = parse(r.output);
    assert.equal(j.overall, "UNREACHABLE");
  });

  it("C — malformed body → UNHEALTHY (malformed_response) on that check", async () => {
    installFetch({
      SIGNAL_EXECUTE_READY: () => ({
        status: 200,
        body: JSON.stringify({ ready: true, checks: { redis: {} } }),
      }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    assert.equal(r.exitCode, 30);
    const j = parse(r.output);
    assert.equal(j.overall, "UNHEALTHY");
    const e = get(j, "signal.execute.ready");
    assert.equal(e.status, "UNHEALTHY");
    assert.match(e.reasons.join(","), /malformed_response/);
  });

  it("D — request exceeds timeout → UNREACHABLE, exit 20", async () => {
    installFetch({
      INGESTION_HEALTH: (async (_url: string, init: RequestInit) => {
        await new Promise<never>((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as { name: string }).name = "AbortError";
            reject(err);
          });
        });
        return { status: 200, body: "{}" };
      }) as Handler,
    });
    const env = { ...BASE_ENV, PAPER_VERIFY_TIMEOUT_MS: "20" };
    const r = await run(["--json"], env, NOW);
    const j = parse(r.output);
    const h = get(j, "ingestion.health");
    assert.equal(h.status, "UNREACHABLE");
  });

  it("E — EXECUTION_READY environment=live → UNHEALTHY", async () => {
    installFetch({
      EXECUTION_READY: () =>
        jsonBody({
          ready: true,
          environment: "live",
          tradingEnabled: false,
          account: "U9999999",
          reconciliation: {
            ageSeconds: 5,
            maxAgeSeconds: 300,
            lastRanAt: FRESH_ISO,
          },
          checks: {
            brokerSocket: true,
            activeAccountKnown: true,
            accountMatchesEnvironment: true,
            auditWriteAvailable: true,
            reconciliationFresh: true,
            positionSnapshotHealthy: true,
          },
          reasons: [],
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const e = get(j, "execution.ready");
    assert.equal(e.status, "UNHEALTHY");
    assert.match(e.reasons.join(","), /environment_not_paper/);
  });

  it("F — no token configured → CONFIG_ERROR, exit 10, ZERO requests", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const env = {
      ...BASE_ENV,
      PAPER_VERIFY_EXECUTION_TOKEN: "",
      EXECUTION_API_TOKEN: "",
    };
    const r = await run(["--json"], env, NOW);
    assert.equal(r.exitCode, 10);
    assert.equal(called, 0);
    const j = JSON.parse(r.output);
    assert.equal(j.overall, "CONFIG_ERROR");
    assert.equal(j.reason, "execution_token_missing");
  });

  it("G — stale ingestion tick → UNHEALTHY", async () => {
    installFetch({
      INGESTION_HEALTH: () =>
        jsonBody({
          ok: true,
          connected: true,
          bootstrapped: true,
          bootstrapping: false,
          lastBootstrapAt: FRESH_ISO,
          lastTickAt: STALE_ISO,
          lastCandleAt: FRESH_ISO,
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    assert.equal(j.overall, "UNHEALTHY");
    const h = get(j, "ingestion.health");
    assert.match(h.reasons.join(","), /stale_last_tick/);
  });

  it("H — RECON_LATEST.stale=true → UNHEALTHY", async () => {
    installFetch({
      RECON_LATEST: () =>
        jsonBody({
          accountId: "DU1234567",
          sessionId: "sess-1",
          run: {
            sessionId: "sess-1",
            accountId: "DU1234567",
            completedAt: STALE_ISO,
            status: "CLEAN",
            snapshotComplete: true,
          },
          stale: true,
          maxAgeSeconds: 300,
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const rl = get(j, "execution.reconciliation.latest");
    assert.equal(rl.status, "UNHEALTHY");
    assert.match(rl.reasons.join(","), /stale/);
  });

  it("I — active reconciliation hold → UNHEALTHY", async () => {
    installFetch({
      RECON_HOLDS_ACTIVE: () =>
        jsonBody({
          holds: [
            { id: 1, reason: "manual_hold", severity: "critical", active: true },
          ],
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const h = get(j, "execution.reconciliation.holds");
    assert.equal(h.status, "UNHEALTHY");
    assert.match(h.reasons.join(","), /manual_hold/);
  });

  it("J2 — trading-loop expected disabled but response enabled → UNHEALTHY", async () => {
    installFetch({
      SIGNAL_LOOP_STATUS: () =>
        jsonBody({
          enabled: true,
          running: true,
          startedAt: FRESH_ISO,
          lastCycleAt: FRESH_ISO,
          nextCycleAt: FRESH_ISO,
          activeInstruments: ["AAPL"],
          cycleCount: 3,
          lastOutcomes: {},
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const s = get(j, "signal.trading_loop.status");
    assert.equal(s.status, "UNHEALTHY");
    assert.match(s.reasons.join(","), /unexpectedly_enabled/);
  });

  it("K — RUNTIME=registered but /runtime/health 404 → UNHEALTHY", async () => {
    installFetch({
      SIGNAL_RUNTIME_HEALTH: () => ({ status: 404, body: "not found" }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const rh = get(j, "signal.runtime.health");
    assert.equal(rh.status, "UNHEALTHY");
    assert.match(rh.reasons.join(","), /endpoint_not_registered/);
  });

  it("L — EXECUTION_RUNTIME=absent skips execute/loop endpoints entirely", async () => {
    const { calls } = installFetch();
    const env = {
      ...BASE_ENV,
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "absent",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "absent",
    };
    await run(["--json"], env, NOW);
    for (const c of calls) {
      assert.ok(
        !c.url.includes("/runtime/execute/"),
        `unexpected call: ${c.url}`,
      );
      assert.ok(
        !c.url.includes("/runtime/trading-loop/"),
        `unexpected call: ${c.url}`,
      );
    }
  });

  it("L2 — RUNTIME=absent skips /runtime/* entirely", async () => {
    const { calls } = installFetch();
    const env = {
      ...BASE_ENV,
      PAPER_VERIFY_RUNTIME_EXPECTED_STATE: "absent",
      PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "absent",
      PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "absent",
    };
    await run(["--json"], env, NOW);
    for (const c of calls) {
      assert.ok(!c.url.includes("/runtime/"), `unexpected call: ${c.url}`);
    }
  });

  it("L3 — invalid expected-state combos → CONFIG_ERROR, exit 10", async () => {
    installFetch();
    const bad = [
      {
        env: {
          PAPER_VERIFY_RUNTIME_EXPECTED_STATE: "absent",
          PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
        },
      },
      {
        env: {
          PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "absent",
          PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "enabled",
        },
      },
      {
        env: {
          PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: "registered",
          PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "absent",
        },
      },
    ];
    for (const c of bad) {
      const r = await run(["--json"], c.env, NOW);
      assert.equal(r.exitCode, 10, JSON.stringify(c.env));
    }
  });

  it("M — account IDs masked in every render", async () => {
    installFetch();
    const r = await run(["--json"], BASE_ENV, NOW);
    assert.equal(
      r.output.includes("DU1234567"),
      false,
      "raw account ID leaked",
    );
    assert.match(r.output, /DU-\*\*\*567/);
  });

  it("P — every recorded request is GET on an allowlisted path", async () => {
    const { calls } = installFetch();
    const env = { ...BASE_ENV, PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY: "true" };
    await run(["--json"], env, NOW);
    const allowed = new Set<string>();
    for (const key of Object.keys(ENDPOINTS) as EndpointKey[]) {
      const d = ENDPOINTS[key];
      const base =
        d.service === "ingestion"
          ? "http://127.0.0.1:3101"
          : d.service === "signal"
            ? "http://127.0.0.1:3102"
            : "http://127.0.0.1:3103";
      allowed.add(`${base}${d.path}`);
    }
    for (const c of calls) {
      assert.equal(c.method, "GET");
      assert.ok(allowed.has(c.url), `URL not allowlisted: ${c.url}`);
    }
  });

  it("R — token never appears in output", async () => {
    installFetch({
      EXECUTION_READY: () => ({
        status: 200,
        body: "not-json-with-test-token-abcdefghijklmnopqrstuvwxyz-1234-inside",
      }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    assert.equal(
      r.output.includes("test-token-abcdefghijklmnopqrstuvwxyz-1234"),
      false,
    );
  });

  it("T — opt-out (default) never calls /execution/account/summary", async () => {
    const { calls } = installFetch();
    await run(["--json"], BASE_ENV, NOW);
    assert.equal(
      calls.some((c) => c.url.includes("/execution/account/summary")),
      false,
    );
  });

  it("V2 — kill-switch triggered → UNHEALTHY", async () => {
    installFetch({
      EXECUTION_KILL_SWITCH: () =>
        jsonBody({
          enabled: true,
          triggered: true,
          dailyRealizedPnL: -1000,
          baseCurrency: "USD",
          since: FRESH_ISO,
          thresholds: { maxDailyLossPct: 5 },
          netLiquidation: 100_000,
          diagnostics: {
            missingFxRates: 0,
            missingCommissionReports: 0,
            complete: true,
            snapshotCacheAgeMs: 1_000,
          },
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const ks = get(j, "execution.kill_switch");
    assert.equal(ks.status, "UNHEALTHY");
    assert.match(ks.reasons.join(","), /triggered/);
  });

  it("V5a — kill-switch cache missing → UNHEALTHY + hint (opt-out)", async () => {
    installFetch({
      EXECUTION_KILL_SWITCH: () =>
        jsonBody({
          enabled: true,
          triggered: false,
          dailyRealizedPnL: 0,
          baseCurrency: "USD",
          since: FRESH_ISO,
          thresholds: { maxDailyLossPct: 5 },
          diagnostics: {
            missingFxRates: 0,
            missingCommissionReports: 0,
            complete: true,
            // snapshotCacheAgeMs omitted
          },
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const ks = get(j, "execution.kill_switch");
    assert.equal(ks.status, "UNHEALTHY");
    assert.match(ks.reasons.join(","), /kill_switch_cache_unpopulated/);
    assert.match(r.output, /PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY=true/);
  });

  it("V5b — kill-switch cache stale → UNHEALTHY", async () => {
    installFetch({
      EXECUTION_KILL_SWITCH: () =>
        jsonBody({
          enabled: true,
          triggered: false,
          dailyRealizedPnL: 0,
          baseCurrency: "USD",
          since: FRESH_ISO,
          thresholds: { maxDailyLossPct: 5 },
          netLiquidation: 100_000,
          diagnostics: {
            missingFxRates: 0,
            missingCommissionReports: 0,
            complete: true,
            snapshotCacheAgeMs: 600_000,
          },
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const ks = get(j, "execution.kill_switch");
    assert.equal(ks.status, "UNHEALTHY");
    assert.match(ks.reasons.join(","), /kill_switch_snapshot_stale/);
  });

  it("V6 — kill-switch enabled=false → DEGRADED", async () => {
    installFetch({
      EXECUTION_KILL_SWITCH: () =>
        jsonBody({
          enabled: false,
          triggered: false,
          dailyRealizedPnL: 0,
          baseCurrency: "USD",
          since: FRESH_ISO,
          thresholds: { maxDailyLossPct: 5 },
          diagnostics: {
            missingFxRates: 0,
            missingCommissionReports: 0,
            complete: true,
          },
        }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const ks = get(j, "execution.kill_switch");
    assert.equal(ks.status, "DEGRADED");
    assert.equal(j.overall, "DEGRADED");
    assert.equal(r.exitCode, 40);
  });

  it("W3 — Bearer endpoint 401 → CONFIG_ERROR, exit 10", async () => {
    installFetch({
      EXECUTION_READY: () => ({ status: 401, body: "unauth" }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    assert.equal(r.exitCode, 10);
    const j = parse(r.output);
    const e = get(j, "execution.ready");
    assert.equal(e.status, "CONFIG_ERROR");
    assert.match(e.reasons.join(","), /auth_rejected/);
    assert.equal(
      r.output.includes("test-token-abcdefghijklmnopqrstuvwxyz-1234"),
      false,
    );
  });

  it("W7 — signal execute readiness 503 with parseable body → UNHEALTHY", async () => {
    installFetch({
      SIGNAL_EXECUTE_READY: () => ({
        status: 503,
        body: JSON.stringify({
          ready: false,
          checks: {
            redis: { ok: false, error: "ECONNREFUSED" },
            postgres: { ok: true },
            paperGuard: { ok: true },
          },
        }),
      }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const e = get(j, "signal.execute.ready");
    assert.equal(e.status, "UNHEALTHY");
    assert.match(e.reasons.join(","), /:redis/);
  });

  it("X11d — EXECUTION_READY.checks.brokerSocket=false → UNHEALTHY", async () => {
    installFetch({
      EXECUTION_READY: () =>
        jsonBody(
          {
            ready: false,
            environment: "paper",
            tradingEnabled: false,
            account: "DU1234567",
            reconciliation: {
              ageSeconds: 5,
              maxAgeSeconds: 300,
              lastRanAt: FRESH_ISO,
            },
            checks: {
              brokerSocket: false,
              activeAccountKnown: true,
              accountMatchesEnvironment: true,
              auditWriteAvailable: true,
              reconciliationFresh: true,
              positionSnapshotHealthy: true,
            },
            reasons: ["broker_socket_down"],
          },
          503,
        ),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = parse(r.output);
    const e = get(j, "execution.ready");
    assert.equal(e.status, "UNHEALTHY");
    assert.match(e.reasons.join(","), /check_brokerSocket_false/);
  });

  it("Z2 — opt-in account-summary HEALTHY, cache fresh → HEALTHY, account-summary precedes kill-switch", async () => {
    const { calls } = installFetch();
    const env = { ...BASE_ENV, PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY: "true" };
    const r = await run(["--json"], env, NOW);
    assert.equal(r.exitCode, 0, r.output);
    const j = parse(r.output);
    assert.equal(j.overall, "HEALTHY");
    const asIdx = calls.findIndex((c) =>
      c.url.endsWith("/execution/account/summary"),
    );
    const ksIdx = calls.findIndex((c) =>
      c.url.endsWith("/execution/kill-switch"),
    );
    assert.ok(asIdx >= 0 && ksIdx >= 0 && asIdx < ksIdx);
  });

  it("Z3a — opt-in + account-summary ECONNREFUSED → UNREACHABLE, kill-switch NOT issued", async () => {
    const { calls } = installFetch({
      EXECUTION_ACCOUNT_SUMMARY: () => {
        const err = new Error("fetch failed");
        (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        throw err;
      },
    });
    const env = { ...BASE_ENV, PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY: "true" };
    const r = await run(["--json"], env, NOW);
    const j = parse(r.output);
    const acct = get(j, "execution.account.summary");
    assert.equal(acct.status, "UNREACHABLE");
    const ks = get(j, "execution.kill_switch");
    assert.match(ks.reasons.join(","), /dependency_failed_account_summary/);
    assert.equal(
      calls.some((c) => c.url.endsWith("/execution/kill-switch")),
      false,
      "kill-switch must not be issued when account-summary failed",
    );
    assert.equal(j.overall, "UNREACHABLE");
    assert.equal(r.exitCode, 20);
  });

  it("Z4a — opt-in + account-summary 401 → CONFIG_ERROR aggregate, kill-switch NOT issued", async () => {
    const { calls } = installFetch({
      EXECUTION_ACCOUNT_SUMMARY: () => ({ status: 401, body: "" }),
    });
    const env = { ...BASE_ENV, PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY: "true" };
    const r = await run(["--json"], env, NOW);
    const j = parse(r.output);
    assert.equal(j.overall, "CONFIG_ERROR");
    assert.equal(r.exitCode, 10);
    assert.equal(
      calls.some((c) => c.url.endsWith("/execution/kill-switch")),
      false,
    );
  });
});

describe("Y-set — aggregator DISABLED-neutral", () => {
  function mk(id: string, status: CheckStatus): CheckResult {
    return { id, service: "execution", status, summary: id, reasons: [] };
  }
  it("Y1 — HEALTHY + DISABLED → HEALTHY, exit 0", () => {
    const s = aggregate([mk("a", "HEALTHY"), mk("b", "DISABLED")]);
    assert.equal(s.overall, "HEALTHY");
    assert.equal(s.exitCode, 0);
  });
  it("Y2 — all DISABLED → DISABLED, exit 0", () => {
    const s = aggregate([mk("a", "DISABLED"), mk("b", "DISABLED")]);
    assert.equal(s.overall, "DISABLED");
    assert.equal(s.exitCode, 0);
  });
  it("Y3 — DEGRADED + DISABLED → DEGRADED, exit 40", () => {
    const s = aggregate([mk("a", "DEGRADED"), mk("b", "DISABLED")]);
    assert.equal(s.overall, "DEGRADED");
    assert.equal(s.exitCode, 40);
  });
  it("Y4 — UNHEALTHY + DISABLED → UNHEALTHY, exit 30", () => {
    const s = aggregate([mk("a", "UNHEALTHY"), mk("b", "DISABLED")]);
    assert.equal(s.overall, "UNHEALTHY");
    assert.equal(s.exitCode, 30);
  });
  it("Y5 — UNREACHABLE + DISABLED → UNREACHABLE, exit 20", () => {
    const s = aggregate([mk("a", "UNREACHABLE"), mk("b", "DISABLED")]);
    assert.equal(s.overall, "UNREACHABLE");
    assert.equal(s.exitCode, 20);
  });
  it("CONFIG_ERROR dominates UNREACHABLE", () => {
    const s = aggregate([
      mk("a", "UNREACHABLE"),
      mk("b", "CONFIG_ERROR"),
      mk("c", "HEALTHY"),
    ]);
    assert.equal(s.overall, "CONFIG_ERROR");
    assert.equal(s.exitCode, 10);
  });
});
