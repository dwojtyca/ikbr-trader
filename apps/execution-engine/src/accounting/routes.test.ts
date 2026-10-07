import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAccountingRoutes } from "./routes.js";
import type { AccountingSourceService } from "./source-service.js";
import { registerExecutionAuth, AuthFailureBurstTracker } from "../auth.js";
import { isWriteGuardExempt } from "../write-guard-exemptions.js";
import { assertActiveAccountAllowed, assertEnvironmentAllowsWrite } from "../env-guard.js";
test("source auth/account guards remain with writes disabled; only qualification needs pause", async () => {
  const app = Fastify({ logger: false }), token = "a".repeat(64);
  let paused = true, account: string | null = "TEST", revoked = 0, inspected = 0;
  const cfg = { environment: "paper" as const, tradingEnabled: false, allowedPaperAccounts: ["TEST"], allowedLiveAccounts: [] };
  registerExecutionAuth(app, { token, burstTracker: new AuthFailureBurstTracker(() => {}), publicPaths: new Set(), writeAudit: () => {}, logger: { warn: () => {} } });
  app.addHook("preHandler", async req => {
    if (req.method === "POST") {
      if (isWriteGuardExempt(req.method, req.routeOptions.url)) assertActiveAccountAllowed(cfg, account, { requireKnownAccount: true });
      else assertEnvironmentAllowsWrite(cfg, account);
    }
  });
  const source = { status: () => ({ configured: true }), inspect: async () => { inspected++; return { inspected: true }; },
    qualify: async () => ({ qualified: true }), invalidate: async () => { revoked++; } } as unknown as AccountingSourceService;
  registerAccountingRoutes(app, { source, assertAccount: () => assertActiveAccountAllowed(cfg, account, { requireKnownAccount: true }), entriesPaused: async () => paused });
  try {
    for (const path of ["status", "inspect", "qualify", "invalidate"]) assert.equal((await app.inject({ method: path === "status" ? "GET" : "POST", url: `/execution/accounting/source/${path}` })).statusCode, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/inspect", headers })).statusCode, 200); assert.equal(inspected, 1);
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/qualify", headers, payload: {} })).statusCode, 200);
    paused = false;
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/qualify", headers, payload: {} })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/invalidate", headers, payload: { reason: "settings changed" } })).statusCode, 200); assert.equal(revoked, 1);
    for (account of [null, "FOREIGN"]) {
      assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/inspect", headers })).statusCode, 423);
      assert.equal((await app.inject({ method: "GET", url: "/execution/accounting/source/status", headers })).statusCode, 409);
    }
    for (const path of ["qualify/anything", "qualify/", "other"]) assert.equal(isWriteGuardExempt("POST", `/execution/accounting/source/${path}`), false);
  } finally { await app.close(); }
});
