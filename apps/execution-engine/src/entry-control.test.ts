import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { buildExecutionConfig } from "./config.js";
import { EntryControlError, registerEntryControlRoutes, type EntryControlStore } from "./entry-control.js";
import { registerExecutionAuth, AuthFailureBurstTracker } from "./auth.js";
import { assertActiveAccountAllowed, assertEnvironmentAllowsWrite } from "./env-guard.js";
import { isWriteGuardExempt } from "./write-guard-exemptions.js";

test("PP5 defaults pause entries and preserve master; historical adoption requires explicit disabled rollout", () => {
  const config = buildExecutionConfig({});
  assert.equal(config.tradingEnabled, false);
  assert.equal(config.EXECUTION_ENTRIES_PAUSED, "true");
  assert.equal(config.EXECUTION_LIFECYCLE_AUTOMATION_ENABLED, "false");
  for (const value of ["yes", "1", "FALSE"]) assert.throws(() => buildExecutionConfig({ EXECUTION_ENTRIES_PAUSED: value }));
  for (const value of [0, 14, 61, 15.5]) assert.throws(() => buildExecutionConfig({ EXECUTION_EXIT_BEFORE_CLOSE_MINUTES: value }));
  assert.throws(() => buildExecutionConfig({ EXECUTION_LIFECYCLE_ADOPT_EXISTING: "true", EXECUTION_ENTRIES_PAUSED: "false" }), /DISABLED_WRITES/);
  assert.throws(() => buildExecutionConfig({ EXECUTION_LIFECYCLE_AUTOMATION_ENABLED: "true", IBKR_ENVIRONMENT: "live", EXECUTION_API_TOKEN: "x".repeat(64), ALLOWED_LIVE_ACCOUNTS: "U_TEST" }), /REQUIRES_PAPER/);
  assert.equal(isWriteGuardExempt("POST", "/execution/lifecycle/:id/close"), false);
  assert.equal(isWriteGuardExempt("POST", "/execution/lifecycle/:id/close/reconcile"), true);
  assert.equal(isWriteGuardExempt("POST", "/execution/entry-control/resume"), false);
});

test("pause remains authenticated/account-scoped with writes off, resume remains guarded and malformed reasons reject", async () => {
  const app = Fastify(); const token = "fixture-pp5-token".repeat(4);
  const guard = { environment: "paper" as const, tradingEnabled: false, allowedPaperAccounts: ["DU_TEST"], allowedLiveAccounts: [] };
  let account: string | null = "DU_TEST", pauses = 0;
  registerExecutionAuth(app, { token, publicPaths: new Set(), writeAudit: () => {},
    burstTracker: new AuthFailureBurstTracker(() => {}), logger: app.log });
  app.addHook("preHandler", async request => {
    if (request.method !== "POST") return;
    if (isWriteGuardExempt(request.method, request.routeOptions.url)) assertActiveAccountAllowed(guard, account, { requireKnownAccount: true });
    else assertEnvironmentAllowsWrite(guard, account);
  });
  const store = { read: async () => ({ control: { paused: true } }), setPaused: async () => { pauses++; } } as unknown as EntryControlStore;
  registerEntryControlRoutes(app, { store, context: () => ({ accountId: account!, sessionId: "fixture", entriesPaused: true, automationEnabled: false }),
    assertAccount: () => assertActiveAccountAllowed(guard, account, { requireKnownAccount: true }),
    resumeGate: async () => { throw new EntryControlError("denied"); } });
  try {
    const request = { method: "POST" as const, url: "/execution/entry-control/pause", payload: { reason: "pause fixture" } };
    assert.equal((await app.inject(request)).statusCode, 401);
    assert.equal((await app.inject({ ...request, headers: { authorization: `Bearer ${token}` } })).statusCode, 200);
    assert.equal((await app.inject({ ...request, payload: { reason: "" }, headers: { authorization: `Bearer ${token}` } })).statusCode, 400);
    assert.equal((await app.inject({ ...request, url: "/execution/entry-control/resume", headers: { authorization: `Bearer ${token}` } })).statusCode, 423);
    account = null;
    assert.equal((await app.inject({ ...request, headers: { authorization: `Bearer ${token}` } })).statusCode, 423);
    assert.equal(pauses, 1);
  } finally { await app.close(); }
});
