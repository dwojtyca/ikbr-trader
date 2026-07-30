/**
 * PR15.1 — table-driven coverage per PR15_1_PLAN §5:
 *   C-set : invalid JSON + malformed shape for all 14 endpoints
 *   L4/L3 : every allowed combination + every rejected combination
 *   W-set : full HTTP taxonomy per endpoint category
 *   H2    : reconciliation status matrix + wrong-session
 *   J2/J3/J4 + status/ready mismatch : trading-loop inconsistencies
 *   Q     : transport rejects non-allowlisted endpoint keys
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { run } from "./index.js";
import { ENDPOINTS, type EndpointKey } from "./endpoints.js";
import { createTransport } from "./http.js";

type FixtureResponse = { status: number; body: string };
type Handler = () => FixtureResponse;
type Handlers = Partial<Record<EndpointKey, Handler>>;

const NOW = Date.parse("2025-05-08T12:00:00.000Z");
const FRESH_ISO = new Date(NOW - 5_000).toISOString();

const OK_PAYLOADS: Record<EndpointKey, unknown> = {
  INGESTION_HEALTH: {
    ok: true,
    connected: true,
    bootstrapped: true,
    bootstrapping: false,
    lastBootstrapAt: FRESH_ISO,
    lastTickAt: FRESH_ISO,
    lastCandleAt: FRESH_ISO,
  },
  INGESTION_WATCHLIST: {
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
  },
  SIGNAL_HEALTH: { ok: true },
  SIGNAL_RUNTIME_HEALTH: { ok: true },
  SIGNAL_RUNTIME_READY: { ready: true, checks: { init: { ok: true } } },
  SIGNAL_EXECUTE_READY: {
    ready: true,
    checks: {
      redis: { ok: true },
      postgres: { ok: true },
      paperGuard: { ok: true },
    },
  },
  SIGNAL_LOOP_STATUS: {
    enabled: false,
    running: false,
    startedAt: null,
    lastCycleAt: null,
    nextCycleAt: null,
    activeInstruments: [],
    cycleCount: 0,
    lastOutcomes: {},
  },
  SIGNAL_LOOP_READY: {
    ready: true,
    enabled: false,
    checks: { init: { ok: true } },
  },
  EXECUTION_HEALTH: { ok: true, twsConnected: true },
  EXECUTION_READY: {
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
  },
  RECON_LATEST: {
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
  },
  RECON_HOLDS_ACTIVE: { holds: [] },
  EXECUTION_ACCOUNT_SUMMARY: {
    accountId: "DU1234567",
    netLiquidation: 100_000,
  },
  EXECUTION_KILL_SWITCH: {
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
  },
};

function ok(key: EndpointKey): FixtureResponse {
  return { status: 200, body: JSON.stringify(OK_PAYLOADS[key]) };
}

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
    const fallback: Handler = () => ok(key);
    routes.set(`${base}${d.path}`, overrides[key] ?? fallback);
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({
      method: String(init?.method ?? "GET"),
      url,
      headers: new Headers(init?.headers ?? {}),
    });
    const h = routes.get(url);
    if (!h) return new Response("not_found", { status: 404 });
    const res = h();
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

// -----------------------------------------------------------------
// C-set: invalid JSON + malformed shape for every endpoint
// -----------------------------------------------------------------

const CHECK_ID_FOR_KEY: Record<EndpointKey, string> = {
  INGESTION_HEALTH: "ingestion.health",
  INGESTION_WATCHLIST: "ingestion.watchlist",
  SIGNAL_HEALTH: "signal.health",
  SIGNAL_RUNTIME_HEALTH: "signal.runtime.health",
  SIGNAL_RUNTIME_READY: "signal.runtime.ready",
  SIGNAL_EXECUTE_READY: "signal.execute.ready",
  SIGNAL_LOOP_STATUS: "signal.trading_loop.status",
  SIGNAL_LOOP_READY: "signal.trading_loop.ready",
  EXECUTION_HEALTH: "execution.health",
  EXECUTION_READY: "execution.ready",
  EXECUTION_KILL_SWITCH: "execution.kill_switch",
  RECON_LATEST: "execution.reconciliation.latest",
  RECON_HOLDS_ACTIVE: "execution.reconciliation.holds",
  EXECUTION_ACCOUNT_SUMMARY: "execution.account.summary",
};

describe("C-set — invalid JSON per endpoint", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const key of Object.keys(ENDPOINTS) as EndpointKey[]) {
    it(`${key} — invalid JSON → UNHEALTHY (malformed_response)`, async () => {
      installFetch({ [key]: () => ({ status: 200, body: "<not-json>" }) });
      const env = { ...BASE_ENV, PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY: "true" };
      const r = await run(["--json"], env, NOW);
      const j = JSON.parse(r.output);
      const check = j.results.find(
        (x: { id: string }) => x.id === CHECK_ID_FOR_KEY[key],
      );
      assert.ok(check, `missing check ${CHECK_ID_FOR_KEY[key]}`);
      assert.equal(check.status, "UNHEALTHY");
      assert.match(check.reasons.join(","), /malformed_response|invalid_json/);
    });
  }
});

describe("C-set — malformed shape per endpoint", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const key of Object.keys(ENDPOINTS) as EndpointKey[]) {
    it(`${key} — schema mismatch → UNHEALTHY (malformed_response)`, async () => {
      installFetch({
        [key]: () => ({ status: 200, body: JSON.stringify({ nope: true }) }),
      });
      const env = { ...BASE_ENV, PAPER_VERIFY_INCLUDE_ACCOUNT_SUMMARY: "true" };
      const r = await run(["--json"], env, NOW);
      const j = JSON.parse(r.output);
      const check = j.results.find(
        (x: { id: string }) => x.id === CHECK_ID_FOR_KEY[key],
      );
      assert.ok(check, `missing check ${CHECK_ID_FOR_KEY[key]}`);
      assert.equal(check.status, "UNHEALTHY");
      assert.match(check.reasons.join(","), /malformed_response/);
    });
  }
});

// -----------------------------------------------------------------
// L3 — every rejected expected-state combination
// -----------------------------------------------------------------

const ALLOWED = [
  { r: "absent", e: "absent", l: "absent" },
  { r: "registered", e: "absent", l: "absent" },
  { r: "registered", e: "registered", l: "enabled" },
  { r: "registered", e: "registered", l: "disabled" },
];

const ALL: Array<{ r: string; e: string; l: string }> = [];
for (const r of ["registered", "absent"]) {
  for (const e of ["registered", "absent"]) {
    for (const l of ["enabled", "disabled", "absent"]) {
      ALL.push({ r, e, l });
    }
  }
}
const REJECTED = ALL.filter(
  (c) => !ALLOWED.some((a) => a.r === c.r && a.e === c.e && a.l === c.l),
);

describe("L4 — every allowed combination parses", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const c of ALLOWED) {
    it(`allowed: r=${c.r} e=${c.e} l=${c.l}`, async () => {
      installFetch();
      const env = {
        ...BASE_ENV,
        PAPER_VERIFY_RUNTIME_EXPECTED_STATE: c.r,
        PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: c.e,
        PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: c.l,
      };
      const r = await run(["--json"], env, NOW);
      const j = JSON.parse(r.output);
      assert.notEqual(j.overall, "CONFIG_ERROR");
    });
  }
});

describe("L3 — every rejected combination → CONFIG_ERROR, zero requests", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const c of REJECTED) {
    it(`rejected: r=${c.r} e=${c.e} l=${c.l}`, async () => {
      let called = 0;
      globalThis.fetch = (async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch;
      const env = {
        ...BASE_ENV,
        PAPER_VERIFY_RUNTIME_EXPECTED_STATE: c.r,
        PAPER_VERIFY_EXECUTION_RUNTIME_EXPECTED_STATE: c.e,
        PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: c.l,
      };
      const r = await run(["--json"], env, NOW);
      assert.equal(r.exitCode, 10);
      assert.equal(called, 0);
    });
  }
});

// -----------------------------------------------------------------
// W-set — full HTTP taxonomy on a bearer endpoint
// -----------------------------------------------------------------

const TAXONOMY: Array<{
  status: number;
  body: string;
  expect: "UNHEALTHY" | "CONFIG_ERROR" | "UNREACHABLE";
}> = [
  { status: 401, body: "", expect: "CONFIG_ERROR" },
  { status: 403, body: "", expect: "CONFIG_ERROR" },
  { status: 404, body: "not found", expect: "UNHEALTHY" },
  { status: 409, body: "conflict", expect: "UNHEALTHY" },
  { status: 418, body: "teapot", expect: "UNHEALTHY" },
  { status: 500, body: "boom", expect: "UNHEALTHY" },
  { status: 502, body: "bad gateway", expect: "UNHEALTHY" },
];

describe("W-set — HTTP taxonomy on execution.reconciliation.latest", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const t of TAXONOMY) {
    it(`HTTP ${t.status} → ${t.expect}`, async () => {
      installFetch({ RECON_LATEST: () => ({ status: t.status, body: t.body }) });
      const r = await run(["--json"], BASE_ENV, NOW);
      const j = JSON.parse(r.output);
      const check = j.results.find(
        (x: { id: string }) => x.id === "execution.reconciliation.latest",
      );
      assert.equal(check.status, t.expect);
    });
  }

  it("readiness endpoint HTTP 503 with parseable body → UNHEALTHY (not UNREACHABLE)", async () => {
    installFetch({
      EXECUTION_READY: () => ({
        status: 503,
        body: JSON.stringify({
          ready: false,
          environment: "paper",
          tradingEnabled: false,
          account: null,
          reconciliation: {
            ageSeconds: null,
            maxAgeSeconds: 300,
            lastRanAt: null,
          },
          checks: {
            brokerSocket: false,
            activeAccountKnown: false,
            accountMatchesEnvironment: false,
            auditWriteAvailable: true,
            reconciliationFresh: false,
            positionSnapshotHealthy: false,
          },
          reasons: ["broker_down"],
        }),
      }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "execution.ready",
    );
    assert.equal(check.status, "UNHEALTHY");
  });
});

// -----------------------------------------------------------------
// H2 — reconciliation status matrix + wrong-session
// -----------------------------------------------------------------

const RECON_STATUSES: Array<{
  status: "CLEAN" | "MISMATCH" | "RUNNING" | "FAILED" | "INCOMPLETE" | "ABANDONED";
  expect: "HEALTHY" | "UNHEALTHY";
}> = [
  { status: "CLEAN", expect: "HEALTHY" },
  { status: "MISMATCH", expect: "HEALTHY" },
  { status: "RUNNING", expect: "UNHEALTHY" },
  { status: "FAILED", expect: "UNHEALTHY" },
  { status: "INCOMPLETE", expect: "UNHEALTHY" },
  { status: "ABANDONED", expect: "UNHEALTHY" },
];

describe("H2 — reconciliation status matrix", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const c of RECON_STATUSES) {
    it(`status=${c.status} → ${c.expect}`, async () => {
      installFetch({
        RECON_LATEST: () => ({
          status: 200,
          body: JSON.stringify({
            accountId: "DU1234567",
            sessionId: "sess-1",
            run: {
              sessionId: "sess-1",
              accountId: "DU1234567",
              completedAt: FRESH_ISO,
              status: c.status,
              snapshotComplete: true,
            },
            stale: false,
            maxAgeSeconds: 300,
          }),
        }),
      });
      const r = await run(["--json"], BASE_ENV, NOW);
      const j = JSON.parse(r.output);
      const check = j.results.find(
        (x: { id: string }) => x.id === "execution.reconciliation.latest",
      );
      assert.equal(check.status, c.expect, JSON.stringify(check));
    });
  }

  it("wrong-session (run.sessionId ≠ top-level) → UNHEALTHY", async () => {
    installFetch({
      RECON_LATEST: () => ({
        status: 200,
        body: JSON.stringify({
          accountId: "DU1234567",
          sessionId: "sess-1",
          run: {
            sessionId: "sess-DIFFERENT",
            accountId: "DU1234567",
            completedAt: FRESH_ISO,
            status: "CLEAN",
            snapshotComplete: true,
          },
          stale: false,
          maxAgeSeconds: 300,
        }),
      }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "execution.reconciliation.latest",
    );
    assert.equal(check.status, "UNHEALTHY");
    assert.match(check.reasons.join(","), /wrong_session/);
  });

  it("unknown status → malformed_response (schema rejects)", async () => {
    installFetch({
      RECON_LATEST: () => ({
        status: 200,
        body: JSON.stringify({
          accountId: "DU1234567",
          sessionId: "sess-1",
          run: {
            sessionId: "sess-1",
            accountId: "DU1234567",
            completedAt: FRESH_ISO,
            status: "SOMETHING_ELSE",
            snapshotComplete: true,
          },
          stale: false,
          maxAgeSeconds: 300,
        }),
      }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "execution.reconciliation.latest",
    );
    assert.equal(check.status, "UNHEALTHY");
    assert.match(check.reasons.join(","), /malformed_response/);
  });

  it("run=null → UNHEALTHY", async () => {
    installFetch({
      RECON_LATEST: () => ({
        status: 200,
        body: JSON.stringify({
          accountId: "DU1234567",
          sessionId: "sess-1",
          run: null,
          stale: false,
          maxAgeSeconds: 300,
        }),
      }),
    });
    const r = await run(["--json"], BASE_ENV, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "execution.reconciliation.latest",
    );
    assert.equal(check.status, "UNHEALTHY");
    assert.match(check.reasons.join(","), /no_run_recorded/);
  });
});

// -----------------------------------------------------------------
// Trading-loop status/ready inconsistencies
// -----------------------------------------------------------------

describe("trading-loop status/ready consistency", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const ENABLED_ENV = {
    ...BASE_ENV,
    PAPER_VERIFY_TRADING_LOOP_EXPECTED_STATE: "enabled",
  };

  it("status.enabled=true but ready.enabled=false → UNHEALTHY", async () => {
    installFetch({
      SIGNAL_LOOP_STATUS: () => ({
        status: 200,
        body: JSON.stringify({
          enabled: true,
          running: true,
          startedAt: FRESH_ISO,
          lastCycleAt: FRESH_ISO,
          nextCycleAt: FRESH_ISO,
          activeInstruments: [],
          cycleCount: 1,
          lastOutcomes: {},
        }),
      }),
      SIGNAL_LOOP_READY: () => ({
        status: 200,
        body: JSON.stringify({
          ready: true,
          enabled: false,
          checks: { init: { ok: true } },
        }),
      }),
    });
    const r = await run(["--json"], ENABLED_ENV, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "signal.trading_loop.ready",
    );
    assert.equal(check.status, "UNHEALTHY");
    assert.match(check.reasons.join(","), /enabled_status_ready_mismatch/);
  });

  it("status.enabled=true, running=false past grace → UNHEALTHY", async () => {
    installFetch({
      SIGNAL_LOOP_STATUS: () => ({
        status: 200,
        body: JSON.stringify({
          enabled: true,
          running: false,
          startedAt: new Date(NOW - 60_000).toISOString(),
          lastCycleAt: null,
          nextCycleAt: null,
          activeInstruments: [],
          cycleCount: 0,
          lastOutcomes: {},
        }),
      }),
    });
    const r = await run(["--json"], ENABLED_ENV, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "signal.trading_loop.status",
    );
    assert.equal(check.status, "UNHEALTHY");
    assert.match(check.reasons.join(","), /not_running/);
  });

  it("running=false but startedRecently inside grace → HEALTHY", async () => {
    installFetch({
      SIGNAL_LOOP_STATUS: () => ({
        status: 200,
        body: JSON.stringify({
          enabled: true,
          running: false,
          startedAt: new Date(NOW - 2_000).toISOString(),
          lastCycleAt: null,
          nextCycleAt: null,
          activeInstruments: [],
          cycleCount: 0,
          lastOutcomes: {},
        }),
      }),
    });
    const env = {
      ...ENABLED_ENV,
      PAPER_VERIFY_LOOP_STARTUP_GRACE_MS: "30000",
    };
    const r = await run(["--json"], env, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "signal.trading_loop.status",
    );
    assert.equal(check.status, "HEALTHY");
  });

  it("ready.checks.*.ok=false → UNHEALTHY", async () => {
    installFetch({
      SIGNAL_LOOP_STATUS: () => ({
        status: 200,
        body: JSON.stringify({
          enabled: true,
          running: true,
          startedAt: FRESH_ISO,
          lastCycleAt: FRESH_ISO,
          nextCycleAt: FRESH_ISO,
          activeInstruments: [],
          cycleCount: 1,
          lastOutcomes: {},
        }),
      }),
      SIGNAL_LOOP_READY: () => ({
        status: 200,
        body: JSON.stringify({
          ready: true,
          enabled: true,
          checks: { redis: { ok: false, error: "boom" } },
        }),
      }),
    });
    const r = await run(["--json"], ENABLED_ENV, NOW);
    const j = JSON.parse(r.output);
    const check = j.results.find(
      (x: { id: string }) => x.id === "signal.trading_loop.ready",
    );
    assert.equal(check.status, "UNHEALTHY");
    assert.match(check.reasons.join(","), /check_redis/);
  });
});

// -----------------------------------------------------------------
// Q — transport rejects non-allowlisted endpoint keys
// -----------------------------------------------------------------

describe("Q — transport rejects unknown endpoint keys before any network call", () => {
  it("throws before invoking fetch", async () => {
    let called = 0;
    const t = createTransport({
      ingestionUrl: "http://127.0.0.1:3101",
      signalUrl: "http://127.0.0.1:3102",
      executionUrl: "http://127.0.0.1:3103",
      token: "x",
      timeoutMs: 500,
      fetchImpl: (async () => {
        called += 1;
        return new Response("{}", { status: 200 });
      }) as typeof globalThis.fetch,
    });
    await assert.rejects(
      () => t.get("NOT_A_REAL_KEY" as EndpointKey),
      /allowlist/i,
    );
    assert.equal(called, 0);
  });
});

// -----------------------------------------------------------------
// Global request-log invariant across all coverage
// -----------------------------------------------------------------

describe("global request-log invariant", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("every issued request is GET and hits an allowlisted URL", async () => {
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
      assert.equal(c.method, "GET", `non-GET request: ${JSON.stringify(c)}`);
      assert.ok(allowed.has(c.url), `not allowlisted: ${c.url}`);
    }
  });
});
