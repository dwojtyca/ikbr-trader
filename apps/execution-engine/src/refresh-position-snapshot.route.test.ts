/**
 * PR14 round-8 blocker — `POST /execution/refresh-position-snapshot`
 * MUST go through the global Bearer auth + audit middleware.
 *
 * This test wires the same `registerExecutionAuth` used in
 * production and registers a stub refresh route that mirrors
 * the shape used in `index.ts`. It verifies:
 *   - no token → 401 (denied by auth middleware)
 *   - correct token + healthy refresh → 200
 *   - correct token + failed refresh → 503 with the error
 *   - every response is audited
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import {
  AuthFailureBurstTracker,
  registerExecutionAuth,
  type ExecutionAuditRecord,
} from "./auth.js";

const TOKEN = "a".repeat(64);

type RefreshOutcome =
  | { readonly kind: "healthy" }
  | { readonly kind: "failed"; readonly error: string };

interface Harness {
  app: ReturnType<typeof Fastify>;
  audits: ExecutionAuditRecord[];
  setRefreshOutcome: (o: RefreshOutcome) => void;
  refreshCalls: () => number;
}

function buildRefreshHarness(): Harness {
  const audits: ExecutionAuditRecord[] = [];
  const app = Fastify({ logger: false });
  let refreshOutcome: RefreshOutcome = { kind: "healthy" };
  let refreshCalls = 0;

  registerExecutionAuth(app, {
    token: TOKEN,
    publicPaths: new Set(["/health"]),
    burstTracker: new AuthFailureBurstTracker(() => undefined, {
      windowMs: 60_000,
      threshold: 3,
    }),
    writeAudit: (row) => {
      audits.push(row);
    },
    logger: { warn: () => undefined },
  });

  // Stub of the production endpoint. Mirrors the response shape
  // in `apps/execution-engine/src/index.ts` — 200 on healthy,
  // 503 on failed.
  app.post("/execution/refresh-position-snapshot", async (_request, reply) => {
    refreshCalls += 1;
    if (refreshOutcome.kind === "healthy") {
      return { accountId: "PAPER-ACCT", status: "healthy" };
    }
    return reply.code(503).send({
      accountId: "PAPER-ACCT",
      status: "failed",
      error: refreshOutcome.error,
    });
  });

  return {
    app,
    audits,
    setRefreshOutcome: (o) => {
      refreshOutcome = o;
    },
    refreshCalls: () => refreshCalls,
  };
}

describe("POST /execution/refresh-position-snapshot — auth + failure semantics (round-8)", () => {
  let h: Harness;
  beforeEach(() => {
    h = buildRefreshHarness();
  });

  it("no Bearer token → 401 (auth middleware denies before handler)", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/execution/refresh-position-snapshot",
    });
    assert.equal(res.statusCode, 401);
    assert.equal(h.refreshCalls(), 0);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].outcome, "DENY_AUTH");
  });

  it("wrong Bearer token → 401", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/execution/refresh-position-snapshot",
      headers: { authorization: `Bearer ${"b".repeat(64)}` },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(h.refreshCalls(), 0);
  });

  it("valid Bearer token + healthy refresh → 200 with { status: healthy }", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/execution/refresh-position-snapshot",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as {
      status: string;
      accountId: string;
    };
    assert.equal(body.status, "healthy");
    assert.equal(body.accountId, "PAPER-ACCT");
    assert.equal(h.refreshCalls(), 1);
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].route, "/execution/refresh-position-snapshot");
    assert.equal(h.audits[0].method, "POST");
  });

  it("valid Bearer token + failed refresh → 503 with { status: failed, error }", async () => {
    h.setRefreshOutcome({ kind: "failed", error: "broker unreachable" });
    const res = await h.app.inject({
      method: "POST",
      url: "/execution/refresh-position-snapshot",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body) as {
      status: string;
      error: string;
    };
    assert.equal(body.status, "failed");
    assert.equal(body.error, "broker unreachable");
    // Auditted even on 503 — the request DID execute.
    assert.equal(h.audits.length, 1);
  });
});
