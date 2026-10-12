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

test("explicit startup preparation requires authentication and exact revision; derives instruments and preserves preparation classifications", async () => {
  const { registerStartupResearchPrepareRoute } = await import("./research-prepare-route.js");
  const { EntryControlError } = await import("./entry-control.js");
  const app = Fastify(); let authorizationCalls = 0, fences = 0, failFence = false, allowed = true;
  const prepared: string[] = [], transaction = {} as import("pg").PoolClient;
  registerExecutionAuth(app, { token: "fixture", publicPaths: new Set(), writeAudit: () => {}, burstTracker: new AuthFailureBurstTracker(() => {}), logger: { warn: () => {} } });
  registerStartupResearchPrepareRoute(app, {
    authorize: async () => {
      authorizationCalls++;
      if (!allowed) throw new EntryControlError("ENTRY_START_CONFIGURATION_UNAVAILABLE");
      return { accountId: "DU_TEST", instruments: ["pko_wse", "aapl_us"].map(instrumentId => ({ accountId: "DU_TEST", instrumentId, configHash: "a".repeat(64), manifestHash: "b".repeat(64) })),
        assertCurrent: async () => { fences++; if (failFence && fences % 2 === 0) throw new EntryControlError("ENTRY_START_CONNECTION_CHANGED"); } };
    },
    controls: { withStartupPause: async (accountId, revision, work) => {
      assert.equal(accountId, "DU_TEST");
      if (revision !== 2) throw new EntryControlError("ENTRY_CONTROL_REVISION_CHANGED");
      return work(transaction);
    } },
    store: { prepareRepair: async (identity, db) => {
      assert.equal(db, transaction); prepared.push(identity.instrumentId);
      return { state: identity.instrumentId === "pko_wse" ? "WAITING" : "HOLD", reasons: [identity.instrumentId === "pko_wse" ? "RESEARCH_SOURCE_MISSING" : "RESEARCH_BUDGET_EXHAUSTED"], sources: [], snapshotId: null, nextCheckAt: null };
    } },
  });
  const url = "/execution/entry-control/start/prepare", headers = { authorization: "Bearer fixture" };
  try {
    assert.equal((await app.inject({ method: "POST", url, payload: { expectedRevision: 2 } })).statusCode, 401);
    for (const payload of [{}, { expectedRevision: 2, accountId: "FOREIGN" }, { expectedRevision: "2" }, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }])
      assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 400);
    assert.equal(authorizationCalls, 0);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { expectedRevision: 1 } })).statusCode, 423);
    assert.deepEqual(prepared, []);
    const result = await app.inject({ method: "POST", url, headers, payload: { expectedRevision: 2 } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().instruments.map((i: { state: string }) => i.state), ["WAITING", "HOLD"]);
    assert.deepEqual(prepared, ["pko_wse", "aapl_us"]); assert.equal(fences, 2);
    failFence = true;
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { expectedRevision: 2 } })).statusCode, 423);
    allowed = false;
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { expectedRevision: 2 } })).statusCode, 423);
    assert.equal(prepared.length, 4);
  } finally { await app.close(); }
});
