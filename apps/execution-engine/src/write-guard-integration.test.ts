/**
 * PR15.3 r3/r4 (hostile-review Finding 1) — HTTP-level regression for
 * the environment write guard. Instantiates a minimal Fastify app
 * with the SAME `preHandler` shape used in `apps/execution-engine/src/index.ts`,
 * registers stub routes for the mutating endpoints under test, and
 * asserts the closed-list exemption behaviour AND the r4 rule that
 * exempt routes bypass ONLY the administrative write switch — every
 * other check (environment, account allowlist, known-account
 * requirement) still fires.
 *
 * Scenarios:
 *
 *   Paper + TRADING_ENABLED=false, ALLOWLISTED paper account:
 *       * execute-ticket / execute-proposed / bootstrap /
 *         refresh-position-snapshot / reject-proposed /
 *         alerts/test           → 423 paper_trading_disabled
 *       * cancel-proposed/:id  → 200 (reaches stub handler)
 *       * reconciliation/run   → 200
 *       * reconciliation/holds/:id/acknowledge → 200
 *       * reconciliation/holds/:id/resolve     → 200
 *       * legacy POST /execution/reconciliation → 423
 *       * fabricated /execution/reconciliation/holds/:id/close → 423
 *
 *   Paper + TRADING_ENABLED=true, ALLOWLISTED paper account:
 *       * execute-ticket → 200 (stub)
 *       * cancel-proposed/:id → 200 (idempotent w.r.t. write switch)
 *
 *   Paper + TRADING_ENABLED=false, NON-allowlisted account (r4):
 *       * cancel-proposed/:id → 423 account_not_allowed_for_paper
 *       * reconciliation/run  → 423 account_not_allowed_for_paper
 *
 *   Live + TRADING_ENABLED=false, ALLOWLISTED live account (r4):
 *       * execute-ticket → 423 live_trading_disabled
 *       * cancel-proposed/:id → 200 (broker cancel unconditional)
 *
 *   Live + non-allowlisted account (r4):
 *       * cancel-proposed/:id → 423 account_not_allowed_for_live
 *
 *   Paper + NO active account (bootstrap not yet done) (r4):
 *       * execute-ticket → 423 paper_trading_disabled (switch check
 *         still fires first for normal writes when tradingEnabled=false)
 *       * cancel-proposed/:id → 423 no_active_account_for_exempt_route
 *       * reconciliation/run  → 423 no_active_account_for_exempt_route
 *
 * We deliberately do NOT wire real broker / repo / audit dependencies
 * — the test is scoped to the guard behaviour. Bearer auth is not
 * added here because the production hook order is
 * `bearer → env-guard`, so an unauthenticated caller receives 401
 * BEFORE the guard runs; that path is already covered by
 * `auth.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import {
  EnvironmentGuardError,
  assertActiveAccountAllowed,
  assertEnvironmentAllowsWrite,
  type EnvironmentGuardConfig,
} from "./env-guard.js";
import { isWriteGuardExempt } from "./write-guard-exemptions.js";

interface HarnessOptions {
  readonly cfg: EnvironmentGuardConfig;
  readonly activeAccountId: string | null;
}

function buildTestApp(opts: HarnessOptions): FastifyInstance {
  const { cfg, activeAccountId } = opts;
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof EnvironmentGuardError) {
      reply.status(err.statusCode).send({
        error: err.message,
        reason: err.reason,
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    reply.status(500).send({ error: message });
  });

  app.addHook("preHandler", async (request) => {
    if (
      request.method !== "POST" &&
      request.method !== "PUT" &&
      request.method !== "PATCH" &&
      request.method !== "DELETE"
    ) {
      return;
    }
    if (!request.url.startsWith("/execution/")) return;
    if (
      isWriteGuardExempt(
        request.method,
        request.routeOptions.url ?? request.url,
      )
    ) {
      assertActiveAccountAllowed(cfg, activeAccountId, {
        requireKnownAccount: true,
      });
      return;
    }
    assertEnvironmentAllowsWrite(cfg, activeAccountId);
  });

  // Stub handlers — every route returns `{ handler: "<path>" }` so a
  // 200 response body proves the request reached the handler.
  const stubs = [
    "/execution/execute-ticket",
    "/execution/execute-proposed/:id",
    "/execution/reject-proposed/:id",
    "/execution/cancel-proposed/:id",
    "/execution/bootstrap",
    "/execution/refresh-position-snapshot",
    "/execution/alerts/test",
    "/execution/reconciliation",
    "/execution/reconciliation/run",
    "/execution/reconciliation/holds/:id/acknowledge",
    "/execution/reconciliation/holds/:id/resolve",
    // Fabricated path used ONLY to prove no accidental prefix
    // wildcard survives on `/execution/reconciliation/…`.
    "/execution/reconciliation/holds/:id/close",
  ];
  for (const path of stubs) {
    app.post(path, async () => ({ handler: path }));
  }

  return app;
}

const PAPER_ACCT = "DU-TEST";
const LIVE_ACCT = "U-TEST";
const OTHER_ACCT = "DU-OTHER";

const PAPER_WRITES_DISABLED: EnvironmentGuardConfig = {
  environment: "paper",
  tradingEnabled: false,
  allowedPaperAccounts: [PAPER_ACCT],
  allowedLiveAccounts: [],
};

const PAPER_WRITES_ENABLED: EnvironmentGuardConfig = {
  environment: "paper",
  tradingEnabled: true,
  allowedPaperAccounts: [PAPER_ACCT],
  allowedLiveAccounts: [],
};

const LIVE_WRITES_DISABLED: EnvironmentGuardConfig = {
  environment: "live",
  tradingEnabled: false,
  allowedPaperAccounts: [],
  allowedLiveAccounts: [LIVE_ACCT],
};

async function post(app: FastifyInstance, url: string) {
  return app.inject({ method: "POST", url });
}

describe("execution-engine environment write guard — Paper + TRADING_ENABLED=false + allowlisted account", () => {
  const harness = (): HarnessOptions => ({
    cfg: PAPER_WRITES_DISABLED,
    activeAccountId: PAPER_ACCT,
  });

  it("execute-ticket → 423 paper_trading_disabled", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/execute-ticket");
    assert.equal(res.statusCode, 423);
    const body = res.json() as { reason: string };
    assert.equal(body.reason, "paper_trading_disabled");
    await app.close();
  });

  it("execute-proposed/:id → 423 paper_trading_disabled", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/execute-proposed/42");
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "paper_trading_disabled",
    );
    await app.close();
  });

  it("bootstrap → 423 paper_trading_disabled (opens a broker session)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/bootstrap");
    assert.equal(res.statusCode, 423);
    await app.close();
  });

  it("refresh-position-snapshot → 423 (admin path stays guarded)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/refresh-position-snapshot");
    assert.equal(res.statusCode, 423);
    await app.close();
  });

  it("reject-proposed/:id → 423 (does not reduce broker exposure)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/reject-proposed/17");
    assert.equal(res.statusCode, 423);
    await app.close();
  });

  it("alerts/test → 423 (no accidental exemption)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/alerts/test");
    assert.equal(res.statusCode, 423);
    await app.close();
  });

  it("PR15.3 r3 abort procedure — cancel-proposed/:id PASSES the guard (risk-reducing)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/cancel-proposed/42");
    assert.equal(
      res.statusCode,
      200,
      "cancel-proposed MUST reach its handler while writes are disabled",
    );
    const body = res.json() as { handler: string };
    assert.equal(body.handler, "/execution/cancel-proposed/:id");
    await app.close();
  });

  it("reconciliation/run PASSES the guard (operator diagnostic path)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/reconciliation/run");
    assert.equal(res.statusCode, 200);
    await app.close();
  });

  it("reconciliation/holds/:id/acknowledge PASSES the guard", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/reconciliation/holds/3/acknowledge");
    assert.equal(res.statusCode, 200);
    await app.close();
  });

  it("reconciliation/holds/:id/resolve PASSES the guard", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/reconciliation/holds/3/resolve");
    assert.equal(res.statusCode, 200);
    await app.close();
  });

  it("legacy POST /execution/reconciliation (no trailing slash) → 423", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/reconciliation");
    assert.equal(res.statusCode, 423);
    await app.close();
  });

  it("fabricated route under reconciliation/ prefix → 423 (no wildcard exemption)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/reconciliation/holds/3/close");
    assert.equal(res.statusCode, 423);
    await app.close();
  });

  it("GET on an exempt route path is unaffected (guard already skips GET)", async () => {
    const app = buildTestApp(harness());
    // Register a GET on the exempted path to prove GET is inherently
    // outside the guard's scope.
    app.get("/execution/cancel-proposed/:id", async () => ({ ok: true }));
    const res = await app.inject({
      method: "GET",
      url: "/execution/cancel-proposed/42",
    });
    assert.equal(res.statusCode, 200);
    await app.close();
  });
});

describe("execution-engine environment write guard — Paper + TRADING_ENABLED=true + allowlisted account", () => {
  const harness = (): HarnessOptions => ({
    cfg: PAPER_WRITES_ENABLED,
    activeAccountId: PAPER_ACCT,
  });

  it("execute-ticket → 200 (stub) once writes are enabled", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/execute-ticket");
    assert.equal(res.statusCode, 200);
    await app.close();
  });

  it("cancel-proposed/:id → still 200 (exemption is idempotent w.r.t. tradingEnabled)", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/cancel-proposed/42");
    assert.equal(res.statusCode, 200);
    await app.close();
  });
});

describe("execution-engine environment write guard — Live + TRADING_ENABLED=false + allowlisted account", () => {
  const harness = (): HarnessOptions => ({
    cfg: LIVE_WRITES_DISABLED,
    activeAccountId: LIVE_ACCT,
  });

  it("execute-ticket → 423 live_trading_disabled", async () => {
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/execute-ticket");
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "live_trading_disabled",
    );
    await app.close();
  });

  it("cancel-proposed/:id → PASSES even in live (broker-cancel is unconditional)", async () => {
    // Cancelling an existing live broker order MUST remain
    // possible while writes are administratively paused — that is
    // exactly what the exemption exists for.
    const app = buildTestApp(harness());
    const res = await post(app, "/execution/cancel-proposed/42");
    assert.equal(res.statusCode, 200);
    await app.close();
  });
});

describe("execution-engine environment write guard — PR15.3 r4 account allowlist on exempt routes", () => {
  it("Paper + writes-off + WRONG paper account → cancel-proposed 423 account_not_allowed_for_paper", async () => {
    const app = buildTestApp({
      cfg: PAPER_WRITES_DISABLED,
      activeAccountId: OTHER_ACCT,
    });
    const res = await post(app, "/execution/cancel-proposed/42");
    assert.equal(
      res.statusCode,
      423,
      "cancel-proposed MUST NOT bypass the account allowlist",
    );
    assert.equal(
      (res.json() as { reason: string }).reason,
      "account_not_allowed_for_paper",
    );
    await app.close();
  });

  it("Paper + writes-off + WRONG account → reconciliation/run 423 account_not_allowed_for_paper", async () => {
    const app = buildTestApp({
      cfg: PAPER_WRITES_DISABLED,
      activeAccountId: OTHER_ACCT,
    });
    const res = await post(app, "/execution/reconciliation/run");
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "account_not_allowed_for_paper",
    );
    await app.close();
  });

  it("Paper + writes-off + WRONG account → reconciliation/holds/:id/resolve 423 account_not_allowed_for_paper", async () => {
    const app = buildTestApp({
      cfg: PAPER_WRITES_DISABLED,
      activeAccountId: OTHER_ACCT,
    });
    const res = await post(
      app,
      "/execution/reconciliation/holds/7/resolve",
    );
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "account_not_allowed_for_paper",
    );
    await app.close();
  });

  it("Live + writes-off + WRONG live account → cancel-proposed 423 account_not_allowed_for_live", async () => {
    const app = buildTestApp({
      cfg: LIVE_WRITES_DISABLED,
      activeAccountId: "U-BAD",
    });
    const res = await post(app, "/execution/cancel-proposed/42");
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "account_not_allowed_for_live",
    );
    await app.close();
  });

  it("Paper + writes-off + NO active account → cancel-proposed 423 no_active_account_for_exempt_route", async () => {
    // Bootstrap phase: no broker session yet. An operator MUST NOT
    // be able to cancel an order we cannot attribute to a known
    // account.
    const app = buildTestApp({
      cfg: PAPER_WRITES_DISABLED,
      activeAccountId: null,
    });
    const res = await post(app, "/execution/cancel-proposed/42");
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "no_active_account_for_exempt_route",
    );
    await app.close();
  });

  it("Paper + writes-off + NO active account → reconciliation/run 423 no_active_account_for_exempt_route", async () => {
    const app = buildTestApp({
      cfg: PAPER_WRITES_DISABLED,
      activeAccountId: null,
    });
    const res = await post(app, "/execution/reconciliation/run");
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "no_active_account_for_exempt_route",
    );
    await app.close();
  });

  it("Paper + writes-on + WRONG account → execute-ticket 423 account_not_allowed_for_paper (normal write path unchanged)", async () => {
    // Sanity check that r4 preserves the pre-existing normal write
    // path semantics for a non-exempt endpoint.
    const app = buildTestApp({
      cfg: PAPER_WRITES_ENABLED,
      activeAccountId: OTHER_ACCT,
    });
    const res = await post(app, "/execution/execute-ticket");
    assert.equal(res.statusCode, 423);
    assert.equal(
      (res.json() as { reason: string }).reason,
      "account_not_allowed_for_paper",
    );
    await app.close();
  });
});
