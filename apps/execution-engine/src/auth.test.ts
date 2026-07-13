import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHash } from "node:crypto";

import {
  AuthFailureBurstTracker,
  fingerprintToken,
  hashRequest,
  registerExecutionAuth,
  verifyBearerToken,
  type ExecutionAuditRecord,
} from "./auth.js";

const TOKEN = "a".repeat(64);
const WRONG_TOKEN = "b".repeat(64);

interface Harness {
  app: ReturnType<typeof Fastify>;
  audits: ExecutionAuditRecord[];
  bursts: Array<{ ip: string | null; count: number }>;
  captured: Array<{ level: string; obj: unknown; msg?: string }>;
}

function buildHarness(overrides: {
  token?: string;
  publicPaths?: Set<string>;
} = {}): Harness {
  const audits: ExecutionAuditRecord[] = [];
  const bursts: Array<{ ip: string | null; count: number }> = [];
  const captured: Array<{ level: string; obj: unknown; msg?: string }> = [];

  const app = Fastify({ logger: false });

  const burstTracker = new AuthFailureBurstTracker(
    (burst) => {
      bursts.push({ ip: burst.ip, count: burst.count });
    },
    { windowMs: 60_000, threshold: 3 },
  );

  registerExecutionAuth(app, {
    token: overrides.token ?? TOKEN,
    publicPaths: overrides.publicPaths ?? new Set(["/health"]),
    burstTracker,
    writeAudit: (row) => {
      audits.push(row);
    },
    logger: {
      warn: (obj, msg) => captured.push({ level: "warn", obj, msg }),
    },
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/execution/orders", async () => ({ orders: [] }));
  app.post("/execution/execute-ticket", async (request) => ({
    echo: request.body ?? null,
  }));

  return { app, audits, bursts, captured };
}

describe("execution-engine auth (Phase 1 / PR2)", () => {
  describe("fingerprintToken", () => {
    it("returns first 12 hex chars of sha256(token)", () => {
      const expected = createHash("sha256")
        .update(TOKEN, "utf8")
        .digest("hex")
        .slice(0, 12);
      assert.equal(fingerprintToken(TOKEN), expected);
      assert.equal(fingerprintToken(TOKEN).length, 12);
    });

    it("returns empty string for empty input", () => {
      assert.equal(fingerprintToken(""), "");
    });
  });

  describe("verifyBearerToken", () => {
    it("accepts a valid Bearer token", () => {
      const result = verifyBearerToken(`Bearer ${TOKEN}`, TOKEN);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.tokenFingerprint, fingerprintToken(TOKEN));
      }
    });

    it("rejects a wrong-length token without exposing the expected length", () => {
      // Shorter, longer, and same-length-wrong tokens all fail with the
      // same reason so no length-oracle can leak through the response.
      const shorter = verifyBearerToken("Bearer short", TOKEN);
      const longer = verifyBearerToken(`Bearer ${TOKEN}${TOKEN}`, TOKEN);
      const sameLen = verifyBearerToken(`Bearer ${WRONG_TOKEN}`, TOKEN);
      for (const r of [shorter, longer, sameLen]) {
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.reason, "wrong_token");
      }
    });

    it("rejects missing header", () => {
      const r = verifyBearerToken(undefined, TOKEN);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "missing_header");
    });

    it("rejects malformed header (no Bearer prefix)", () => {
      const r = verifyBearerToken(`Token ${TOKEN}`, TOKEN);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "malformed");
    });

    it("rejects when server has no expected token configured", () => {
      const r = verifyBearerToken(`Bearer ${TOKEN}`, "");
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "wrong_token");
    });

    it("does not equate two different tokens sharing a padded suffix", () => {
      // Padded-buffer approach must include a length discriminant so that
      // two tokens equal up to min(len) but different lengths never match.
      const shortToken = "a".repeat(32);
      const longToken = "a".repeat(64);
      const r = verifyBearerToken(`Bearer ${shortToken}`, longToken);
      assert.equal(r.ok, false);
    });
  });

  describe("AuthFailureBurstTracker", () => {
    it("emits alert after threshold failures within window", () => {
      const alerts: Array<{ ip: string | null; count: number }> = [];
      const tracker = new AuthFailureBurstTracker(
        (b) => {
          alerts.push({ ip: b.ip, count: b.count });
        },
        { windowMs: 1000, threshold: 3 },
      );
      tracker.recordFailure("1.1.1.1", 1000);
      tracker.recordFailure("1.1.1.1", 1100);
      assert.equal(alerts.length, 0);
      tracker.recordFailure("1.1.1.1", 1200);
      assert.equal(alerts.length, 1);
      assert.deepEqual(alerts[0], { ip: "1.1.1.1", count: 3 });
    });

    it("does not emit for failures spread beyond the window", () => {
      const alerts: Array<{ ip: string | null }> = [];
      const tracker = new AuthFailureBurstTracker(
        (b) => {
          alerts.push({ ip: b.ip });
        },
        { windowMs: 1000, threshold: 3 },
      );
      tracker.recordFailure("2.2.2.2", 0);
      tracker.recordFailure("2.2.2.2", 1500);
      tracker.recordFailure("2.2.2.2", 3000);
      assert.equal(alerts.length, 0);
    });

    it("resets after emitting so next burst re-triggers", () => {
      const alerts: Array<{ ip: string | null }> = [];
      const tracker = new AuthFailureBurstTracker(
        (b) => {
          alerts.push({ ip: b.ip });
        },
        { windowMs: 1000, threshold: 3 },
      );
      for (let i = 0; i < 6; i++) tracker.recordFailure("3.3.3.3", 1000 + i);
      assert.equal(alerts.length, 2);
    });

    it("tracks per-IP independently", () => {
      const alerts: Array<{ ip: string | null }> = [];
      const tracker = new AuthFailureBurstTracker(
        (b) => {
          alerts.push({ ip: b.ip });
        },
        { windowMs: 1000, threshold: 3 },
      );
      tracker.recordFailure("a", 1);
      tracker.recordFailure("b", 2);
      tracker.recordFailure("a", 3);
      tracker.recordFailure("b", 4);
      assert.equal(alerts.length, 0);
      tracker.recordFailure("a", 5);
      assert.deepEqual(alerts, [{ ip: "a" }]);
    });
  });

  describe("Fastify plugin integration", () => {
    let h: Harness;
    beforeEach(() => {
      h = buildHarness();
    });

    it("allows GET /health without any token and does not audit it", async () => {
      const res = await h.app.inject({ method: "GET", url: "/health" });
      assert.equal(res.statusCode, 200);
      assert.ok(res.headers["x-correlation-id"]);
      assert.equal(h.audits.length, 0);
    });

    it("denies /execution/orders with no token (401, DENY_AUTH audit)", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/execution/orders",
      });
      assert.equal(res.statusCode, 401);
      assert.equal(h.audits.length, 1);
      const audit = h.audits[0];
      assert.equal(audit.outcome, "DENY_AUTH");
      assert.equal(audit.actorKind, "unauthenticated");
      assert.equal(audit.tokenFingerprint, null);
      assert.equal(audit.reason, "missing_header");
      assert.equal(audit.route, "/execution/orders");
      assert.equal(audit.method, "GET");
    });

    it("denies with a wrong token (401, DENY_AUTH, reason=wrong_token)", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/execution/orders",
        headers: { authorization: `Bearer ${WRONG_TOKEN}` },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(h.audits.length, 1);
      assert.equal(h.audits[0].outcome, "DENY_AUTH");
      assert.equal(h.audits[0].reason, "wrong_token");
    });

    it("allows /execution/orders with correct Bearer (200, ALLOW audit)", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/execution/orders",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(h.audits.length, 1);
      const audit = h.audits[0];
      assert.equal(audit.outcome, "ALLOW");
      assert.equal(audit.actorKind, "authenticated");
      assert.equal(audit.tokenFingerprint, fingerprintToken(TOKEN));
      assert.equal(audit.reason, null);
    });

    it("emits AUTH_FAILURE_BURST alert after 3 bad tokens in a row", async () => {
      for (let i = 0; i < 3; i++) {
        await h.app.inject({
          method: "GET",
          url: "/execution/orders",
          headers: { authorization: `Bearer ${WRONG_TOKEN}` },
        });
      }
      assert.equal(h.bursts.length, 1);
      assert.equal(h.bursts[0].count, 3);
    });

    it("propagates incoming X-Correlation-ID (UUID) to audit + response header", async () => {
      const uuid = "11111111-2222-4333-8444-555555555555";
      const res = await h.app.inject({
        method: "GET",
        url: "/execution/orders",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-correlation-id": uuid,
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["x-correlation-id"], uuid);
      assert.equal(h.audits[0].correlationId, uuid);
    });

    it("generates a new correlation ID when incoming value is not a valid UUID", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/execution/orders",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-correlation-id": "not-a-uuid'; DROP TABLE audit; --",
        },
      });
      assert.equal(res.statusCode, 200);
      const cid = String(res.headers["x-correlation-id"] ?? "");
      // Fresh UUID, not the injected string.
      assert.notEqual(cid, "not-a-uuid'; DROP TABLE audit; --");
      assert.match(
        cid,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it("audit never contains the raw token value", async () => {
      await h.app.inject({
        method: "GET",
        url: "/execution/orders",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const serialized = JSON.stringify(h.audits);
      assert.equal(serialized.includes(TOKEN), false);
      // Fingerprint is 12 hex chars and IS present.
      assert.ok(serialized.includes(fingerprintToken(TOKEN)));
    });

    it("captures request body in requestHash but not verbatim", async () => {
      const body = { instrument: "AAPL", side: "BUY", quantity: 1 };
      await h.app.inject({
        method: "POST",
        url: "/execution/execute-ticket",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: body,
      });
      const audit = h.audits[0];
      assert.ok(audit.requestHash);
      assert.equal(audit.requestHash!.length, 32);
      assert.equal(
        audit.requestHash,
        hashRequest({
          url: "/execution/execute-ticket",
          method: "POST",
          body,
        }),
      );
      // Raw body values are not stored in the audit record itself.
      assert.equal(JSON.stringify(audit).includes("AAPL"), false);
    });

    it("empty server token denies every request (fail-closed)", async () => {
      const bare = buildHarness({ token: "" });
      const res = await bare.app.inject({
        method: "GET",
        url: "/execution/orders",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(bare.audits[0].outcome, "DENY_AUTH");
    });
  });
});
