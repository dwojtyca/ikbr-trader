import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerAccountingRoutes } from "./routes.js";
import type { AccountingSourceService } from "./source-service.js";
import { registerExecutionAuth, AuthFailureBurstTracker } from "../auth.js";
import { isWriteGuardExempt } from "../write-guard-exemptions.js";
import { assertActiveAccountAllowed, assertEnvironmentAllowsWrite } from "../env-guard.js";
test("source auth/account guards and disabled-Paper paused clock recovery remain exact", async () => {
  const app = Fastify({ logger: false }), token = "a".repeat(64);
  let paused = true, account: string | null = "TEST", revoked = 0, inspected = 0, recovered = 0;
  const cfg = { environment: "paper" as "paper" | "live", tradingEnabled: false, allowedPaperAccounts: ["TEST"], allowedLiveAccounts: ["TEST"] };
  registerExecutionAuth(app, { token, burstTracker: new AuthFailureBurstTracker(() => {}), publicPaths: new Set(), writeAudit: () => {}, logger: { warn: () => {} } });
  app.addHook("preHandler", async req => {
    if (req.method === "POST") {
      if (isWriteGuardExempt(req.method, req.routeOptions.url)) assertActiveAccountAllowed(cfg, account, { requireKnownAccount: true });
      else assertEnvironmentAllowsWrite(cfg, account);
    }
  });
  const source = { status: () => ({ configured: true }), inspect: async () => { inspected++; return { inspected: true }; },
    recoverClock: async () => { recovered++; return { recovered: true }; }, qualify: async () => ({ qualified: true }), invalidate: async () => { revoked++; } } as unknown as AccountingSourceService;
  registerAccountingRoutes(app, { source, recoveryEnvironment: () => cfg, assertAccount: () => assertActiveAccountAllowed(cfg, account, { requireKnownAccount: true }), entriesPaused: async () => paused });
  try {
    for (const path of ["status", "inspect", "qualify", "invalidate", "recover-clock"]) assert.equal((await app.inject({ method: path === "status" ? "GET" : "POST", url: `/execution/accounting/source/${path}` })).statusCode, 401);
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/inspect", headers })).statusCode, 200); assert.equal(inspected, 1);
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/qualify", headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/recover-clock", headers })).statusCode, 200); assert.equal(recovered, 1);
    for (const mode of ["write", "live", "body"]) {
      cfg.tradingEnabled = mode === "write"; cfg.environment = mode === "live" ? "live" : "paper";
      assert.notEqual((await app.inject({ method: "POST", url: "/execution/accounting/source/recover-clock", headers,
        ...(mode === "body" ? { payload: { tradingEnabled: false } } : {}) })).statusCode, 200);
    }
    cfg.tradingEnabled = false; cfg.environment = "paper";
    paused = false;
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/recover-clock", headers })).statusCode, 409); assert.equal(recovered, 1);
    for (const method of ["GET", "PUT", "DELETE"]) assert.equal(isWriteGuardExempt(method, "/execution/accounting/source/recover-clock"), false);
    for (const path of ["recover-clock/", "recover-clock/other"]) assert.equal(isWriteGuardExempt("POST", `/execution/accounting/source/${path}`), false);
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/qualify", headers, payload: {} })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/invalidate", headers, payload: { reason: "settings changed" } })).statusCode, 200); assert.equal(revoked, 1);
    for (account of [null, "FOREIGN"]) {
      assert.equal((await app.inject({ method: "POST", url: "/execution/accounting/source/inspect", headers })).statusCode, 423);
      assert.equal((await app.inject({ method: "GET", url: "/execution/accounting/source/status", headers })).statusCode, 409);
    }
    for (const path of ["qualify/anything", "qualify/", "other"]) assert.equal(isWriteGuardExempt("POST", `/execution/accounting/source/${path}`), false);
  } finally { await app.close(); }
});
