import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerExecutionAuth, AuthFailureBurstTracker } from "./auth.js";
import { registerResearchPrepareRoute } from "./research-prepare-route.js";

test("research prepare requires auth, exact body, and server-authorized identity before durable enqueue", async () => {
  const app = Fastify(); let calls = 0, allowed = true;
  registerExecutionAuth(app, { token: "fixture", publicPaths: new Set(), writeAudit: () => {}, burstTracker: new AuthFailureBurstTracker(() => {}), logger: { warn: () => {} } });
  registerResearchPrepareRoute(app, { authorize: async input => {
    if (!allowed || input.conid !== "123") throw Error("not allowed");
    return { accountId: "DU_TEST", instrumentId: input.instrumentId, configHash: input.effectiveConfigHash, manifestHash: "b".repeat(64) };
  }, store: { prepareRepair: async () => { calls++; return { state: "WAITING", reasons: ["RESEARCH_SOURCE_MISSING"], sources: [], snapshotId: null, nextCheckAt: new Date().toISOString() }; } } });
  const body = { instrumentId: "stock", conid: "123", effectiveConfigHash: "a".repeat(64) }, headers = { authorization: "Bearer fixture" };
  for (const payload of [body, { ...body, accountId: "FOREIGN" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/execution/research/prepare", payload })).statusCode, 401);
  }
  assert.equal((await app.inject({ method: "POST", url: "/execution/research/prepare", headers, payload: { ...body, accountId: "FOREIGN" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/execution/research/prepare", headers, payload: { ...body, conid: "999" } })).statusCode, 423);
  allowed = false;
  assert.equal((await app.inject({ method: "POST", url: "/execution/research/prepare", headers, payload: body })).statusCode, 423);
  assert.equal(calls, 0); allowed = true;
  assert.equal((await app.inject({ method: "POST", url: "/execution/research/prepare", headers, payload: body })).json().state, "WAITING");
  assert.equal(calls, 1); await app.close();
});
