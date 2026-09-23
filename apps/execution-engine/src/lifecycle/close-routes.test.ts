import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { registerFullCloseRoutes } from "./close-routes.js";
import { registerExecutionAuth, AuthFailureBurstTracker } from "../auth.js";
import { assertEnvironmentAllowsWrite, EnvironmentGuardError } from "../env-guard.js";
import { isWriteGuardExempt } from "../write-guard-exemptions.js";
import type { CloseOperation } from "./close-types.js";

test("full close routes use bearer, normal write/account guard and strict request schema", async () => {
  const app = Fastify(), token = "fixture-token".repeat(4); let writes = 0, reads = 0;
  const state = { enabled: false, account: "DU_TEST" };
  registerExecutionAuth(app, { token, publicPaths: new Set(["/health"]),
    burstTracker: new AuthFailureBurstTracker(() => {}, { windowMs: 60000, threshold: 3 }),
    writeAudit: () => {}, logger: { warn: () => {} } });
  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "GET") return;
    assert.equal(isWriteGuardExempt(request.method, request.routeOptions.url), false);
    try { assertEnvironmentAllowsWrite({ environment: "paper", tradingEnabled: state.enabled,
      allowedPaperAccounts: ["DU_TEST"], allowedLiveAccounts: [] }, state.account); }
    catch (error) { if (error instanceof EnvironmentGuardError) return reply.code(423).send({ error: error.reason }); throw error; }
  });
  registerFullCloseRoutes(app, { get: async () => { reads++; return null; }, request: async () => {
    writes++; return { id: 1, state: "SUBMITTED" } as CloseOperation;
  }, reconcile: async () => { writes++; return { id: 1, state: "COMPLETED" } as CloseOperation; } });
  const headers = { authorization: `Bearer ${token}` }, body = { requestId: randomUUID(), limitPrice: 100 };
  try {
    for (const [method, url] of [["GET", "/execution/lifecycle/1/close"], ["POST", "/execution/lifecycle/1/close"], ["POST", "/execution/lifecycle/1/close/reconcile"]] as const)
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    assert.equal(reads + writes, 0);
    assert.equal((await app.inject({ method: "POST", url: "/execution/lifecycle/1/close", headers, payload: body })).statusCode, 423);
    state.enabled = true; state.account = "OTHER";
    assert.equal((await app.inject({ method: "POST", url: "/execution/lifecycle/1/close", headers, payload: body })).statusCode, 423);
    state.account = "DU_TEST";
    for (const payload of [{}, { ...body, limitPrice: -1 }, { ...body, requestId: "bad" }, { ...body, quantity: 2 }])
      assert.equal((await app.inject({ method: "POST", url: "/execution/lifecycle/1/close", headers, payload })).statusCode, 400);
    assert.equal(writes, 0);
    assert.equal((await app.inject({ method: "POST", url: "/execution/lifecycle/1/close", headers, payload: body })).statusCode, 202);
    assert.equal((await app.inject({ method: "POST", url: "/execution/lifecycle/1/close/reconcile", headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/execution/lifecycle/1/close", headers })).statusCode, 404);
    assert.equal(writes, 2);
  } finally { await app.close(); }
});
