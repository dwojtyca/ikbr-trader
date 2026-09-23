import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerLifecycleRoutes } from "./routes.js";
import { registerCancelProposedRoute } from "./cancel-route.js";
import { registerExecutionAuth, AuthFailureBurstTracker } from "../auth.js";

test("lifecycle evidence and cancel routes retain real global bearer protection", async () => {
  const app = Fastify(); const token = "test-only-token".repeat(4);
  let reads = 0, cancels = 0;
  registerExecutionAuth(app, { token, publicPaths: new Set(["/health"]),
    burstTracker: new AuthFailureBurstTracker(() => {}, {windowMs:60000,threshold:3}),
    writeAudit: () => {}, logger: {warn: () => {}} });
  registerLifecycleRoutes(app, { repository: {getLifecycleEvidence: async () => { reads++; return null; }},
    currentAccountId: () => "TEST", currentSessionId: () => "session", boundInstrument: () => null });
  registerCancelProposedRoute(app, { repository: {getProposedOrderById: async () => { reads++; return null; }},
    broker: {cancelBrokerOrder: async () => { cancels++; throw new Error("unexpected"); }}, requestReconciliation: () => {} });
  try {
    for (const [method,url] of [["GET","/execution/lifecycle/1"],["POST","/execution/cancel-proposed/1"]] as const)
      assert.equal((await app.inject({method,url})).statusCode,401);
    assert.equal(reads,0); assert.equal(cancels,0);
    const headers = {authorization:`Bearer ${token}`};
    assert.equal((await app.inject({method:"GET",url:"/execution/lifecycle/1",headers})).statusCode,404);
    assert.equal(reads,1);
    assert.equal((await app.inject({method:"GET",url:"/execution/lifecycle/invalid",headers})).statusCode,400);
    assert.equal(reads,1);
  } finally { await app.close(); }
});
