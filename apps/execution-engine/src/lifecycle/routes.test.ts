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
  registerLifecycleRoutes(app, { repository: {getRoundTripEvidence: async () => { reads++; return null; }, getLifecycleEvidence: async () => { reads++; return null; }},
    currentAccountId: () => "TEST", currentSessionId: () => "session", boundInstrument: () => null });
  registerCancelProposedRoute(app, { repository: {getProposedOrderById: async () => { reads++; return null; }},
    broker: {cancelBrokerOrder: async () => { cancels++; throw new Error("unexpected"); }}, requestReconciliation: () => {} });
  try {
    for (const [method,url] of [["GET","/execution/lifecycle/1/round-trip"],["GET","/execution/lifecycle/1"],["POST","/execution/cancel-proposed/1"]] as const)
      assert.equal((await app.inject({method,url})).statusCode,401);
    assert.equal(reads,0); assert.equal(cancels,0);
    const headers = {authorization:`Bearer ${token}`};
    assert.equal((await app.inject({method:"GET",url:"/execution/lifecycle/1",headers})).statusCode,404);
    assert.equal(reads,1);
    assert.equal((await app.inject({method:"GET",url:"/execution/lifecycle/invalid",headers})).statusCode,400);
    assert.equal(reads,1);
  } finally { await app.close(); }
});

test("round-trip GET rechecks account/session after collection and has no mutation dependency", async () => {
  const { roundTrip } = await import("./round-trip-test-fixture.js");
  const f=roundTrip(), app=Fastify(); let account=f.context.accountId, session=f.context.sessionId, reads=0;
  registerLifecycleRoutes(app,{repository:{getLifecycleEvidence:async()=>null,getRoundTripEvidence:async()=>{
    reads++; session="new-session"; return f.evidence;
  }},currentAccountId:()=>account,currentSessionId:()=>session,boundInstrument:()=>f.context.bound,now:()=>f.context.nowMs});
  try {
    const invalid=await app.inject({method:"GET",url:"/execution/lifecycle/invalid/round-trip"});
    assert.equal(invalid.statusCode,400);assert.equal(reads,0);
    const result=await app.inject({method:"GET",url:"/execution/lifecycle/42/round-trip"});
    assert.equal(result.statusCode,200);assert.equal(result.json().status,"NOT_PROVEN");
    assert.ok(result.json().reasons.includes("current_identity_missing"));
    account=null;
  } finally {await app.close();}
});

test("round-trip GET labels instrument completion and exposes unrelated SMR activity", async () => {
  const { roundTripWithSmr } = await import("./round-trip-test-fixture.js");
  const f = roundTripWithSmr(), app = Fastify();
  registerLifecycleRoutes(app, { repository: { getLifecycleEvidence: async () => null, getRoundTripEvidence: async () => f.evidence },
    currentAccountId: () => f.context.accountId, currentSessionId: () => f.context.sessionId,
    boundInstrument: () => f.context.bound, now: () => f.context.nowMs });
  try {
    const response = await app.inject({ method: "GET", url: "/execution/lifecycle/42/round-trip" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, "COMPLETED"); assert.equal(body.completionScope, "INSTRUMENT");
    assert.equal(body.outsideScope.positions[0].instrument, "SMR");
    assert.equal(body.outsideScope.workingOrderCount, 1); assert.equal(body.netPnlPLN, 1);
    assert.equal(body.canSubmit, false);
  } finally { await app.close(); }
});
