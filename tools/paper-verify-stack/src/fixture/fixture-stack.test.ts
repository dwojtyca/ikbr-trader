/**
 * PR15.1 follow-up — fixture-stack unit tests.
 *
 * Focus areas:
 *   - dynamic-port allocation (three non-zero, distinct,
 *     loopback ports);
 *   - startup is not reported complete before all servers
 *     are listening;
 *   - fixture works even when the default paper-stack ports
 *     (`3101` / `3102` / `3103`) are already occupied;
 *   - shutdown is idempotent and actually closes sockets;
 *   - allowlist agreement — every response path is derived
 *     from the shared `endpoints.ts` registry, so drift is
 *     impossible.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer as createNetServer, type Server as NetServer } from "node:net";
import { ENDPOINTS, type EndpointKey } from "../endpoints.js";
import { startFixtureStack } from "./fixture-stack.js";

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), 500);
  });
}

function listenOnDefaultPorts(): Promise<NetServer[]> {
  const ports = [3101, 3102, 3103];
  return Promise.all(
    ports.map(
      (p) =>
        new Promise<NetServer>((resolve, reject) => {
          const s = createNetServer();
          s.once("error", reject);
          s.listen(p, "127.0.0.1", () => resolve(s));
        }),
    ),
  );
}

async function closeAll(servers: NetServer[]): Promise<void> {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
}

describe("startFixtureStack — dynamic ports", () => {
  it("assigns three non-zero, distinct, loopback ports", async () => {
    const stack = await startFixtureStack();
    try {
      const { ingestion, signal, execution } = stack.ports;
      assert.ok(ingestion > 0, "ingestion port must be >0");
      assert.ok(signal > 0, "signal port must be >0");
      assert.ok(execution > 0, "execution port must be >0");
      assert.equal(
        new Set([ingestion, signal, execution]).size,
        3,
        "ports must be distinct",
      );
      for (const url of [
        stack.ingestionUrl,
        stack.signalUrl,
        stack.executionUrl,
      ]) {
        const parsed = new URL(url);
        assert.equal(parsed.hostname, "127.0.0.1");
        assert.equal(parsed.protocol, "http:");
        assert.notEqual(parsed.port, "");
      }
    } finally {
      await stack.shutdown();
    }
  });

  it("all three servers are actually listening before startFixtureStack resolves", async () => {
    const stack = await startFixtureStack();
    try {
      assert.equal(await isPortListening(stack.ports.ingestion), true);
      assert.equal(await isPortListening(stack.ports.signal), true);
      assert.equal(await isPortListening(stack.ports.execution), true);
    } finally {
      await stack.shutdown();
    }
  });

  it("succeeds even when default paper-stack ports 3101/3102/3103 are occupied", async () => {
    // If the host already binds 3101/3102/3103 (e.g. Docker
    // is up), this test skips its own occupation step and
    // asserts the fixture still binds successfully.
    let occupied: NetServer[] = [];
    try {
      occupied = await listenOnDefaultPorts();
    } catch {
      occupied = [];
    }
    try {
      const stack = await startFixtureStack();
      try {
        for (const p of [
          stack.ports.ingestion,
          stack.ports.signal,
          stack.ports.execution,
        ]) {
          assert.notEqual(p, 3101, "must not collide with 3101");
          assert.notEqual(p, 3102, "must not collide with 3102");
          assert.notEqual(p, 3103, "must not collide with 3103");
        }
      } finally {
        await stack.shutdown();
      }
    } finally {
      if (occupied.length > 0) await closeAll(occupied);
    }
  });

  it("shutdown is idempotent and actually closes sockets", async () => {
    const stack = await startFixtureStack();
    const ports = { ...stack.ports };
    assert.equal(stack.isShutdown(), false);
    await stack.shutdown();
    // Second and third calls must not throw or hang.
    await stack.shutdown();
    await stack.shutdown();
    assert.equal(stack.isShutdown(), true);
    assert.equal(await isPortListening(ports.ingestion), false);
    assert.equal(await isPortListening(ports.signal), false);
    assert.equal(await isPortListening(ports.execution), false);
  });

  it("every response path is derived from the shared endpoint registry", async () => {
    // The fixture must own the same 14 keys — no independent
    // second allowlist can silently drift.
    const stack = await startFixtureStack();
    try {
      // Fire one GET per allowlisted key and verify every
      // response is 2xx JSON (implicitly asserts the fixture
      // knows every path).
      for (const key of Object.keys(ENDPOINTS) as EndpointKey[]) {
        const d = ENDPOINTS[key];
        const base =
          d.service === "ingestion"
            ? stack.ingestionUrl
            : d.service === "signal"
              ? stack.signalUrl
              : stack.executionUrl;
        const res = await globalThis.fetch(`${base}${d.path}`);
        assert.equal(
          res.status,
          200,
          `expected 200 for ${key} ${d.path}, got ${res.status}`,
        );
        const body: unknown = await res.json();
        assert.ok(body && typeof body === "object", `${key}: body not object`);
      }
    } finally {
      await stack.shutdown();
    }
  });

  it("rejects non-GET requests with 404 (allowlist matching is method+key, not key alone)", async () => {
    const stack = await startFixtureStack();
    try {
      const res = await globalThis.fetch(
        `${stack.executionUrl}/execution/kill-switch`,
        { method: "POST" },
      );
      assert.equal(res.status, 404);
      const log = stack.requestLog();
      const post = log.find((r) => r.method === "POST");
      assert.ok(post, "POST must be recorded in the log");
      // Path resolves to the endpoint key (path is the same),
      // but harness gating relies on method === "GET". Prove
      // the method was recorded so a consumer scanning the
      // log can differentiate.
      assert.equal(post.method, "POST");
    } finally {
      await stack.shutdown();
    }
  });

  it("records the resolved endpoint key for every allowlisted GET", async () => {
    const stack = await startFixtureStack();
    try {
      await globalThis.fetch(`${stack.executionUrl}/execution/kill-switch`);
      const log = stack.requestLog();
      assert.equal(log.length, 1);
      assert.equal(log[0].method, "GET");
      assert.equal(log[0].key, "EXECUTION_KILL_SWITCH");
      assert.equal(log[0].service, "execution");
    } finally {
      await stack.shutdown();
    }
  });
});

describe("startFixtureStack — request log lifecycle", () => {
  let occupied: NetServer[] = [];
  beforeEach(() => {
    occupied = [];
  });
  afterEach(async () => {
    if (occupied.length > 0) await closeAll(occupied);
  });

  it("clearRequestLog empties the log without affecting future requests", async () => {
    const stack = await startFixtureStack();
    try {
      await globalThis.fetch(`${stack.signalUrl}/health`);
      assert.equal(stack.requestLog().length, 1);
      stack.clearRequestLog();
      assert.equal(stack.requestLog().length, 0);
      await globalThis.fetch(`${stack.signalUrl}/health`);
      assert.equal(stack.requestLog().length, 1);
    } finally {
      await stack.shutdown();
    }
  });
});

describe("startFixtureStack — exact query-string matching", () => {
  it("canonical GET /execution/reconciliation/holds?active=true → 200 + key=RECON_HOLDS_ACTIVE", async () => {
    const stack = await startFixtureStack();
    try {
      const res = await globalThis.fetch(
        `${stack.executionUrl}/execution/reconciliation/holds?active=true`,
      );
      assert.equal(res.status, 200);
      const body: unknown = await res.json();
      assert.ok(
        body && typeof body === "object" && "holds" in body,
        "expected {holds: []} shape",
      );
      const log = stack.requestLog();
      const entry = log.find((r) =>
        r.url.startsWith("/execution/reconciliation/holds"),
      );
      assert.ok(entry, "canonical URL must be logged");
      assert.equal(entry.method, "GET");
      assert.equal(entry.key, "RECON_HOLDS_ACTIVE");
      assert.equal(entry.service, "execution");
      assert.equal(
        entry.url,
        "/execution/reconciliation/holds?active=true",
        "raw URL must equal ENDPOINTS[key].path exactly",
      );
    } finally {
      await stack.shutdown();
    }
  });

  it("missing query on a query-bearing endpoint → 404, key=null", async () => {
    const stack = await startFixtureStack();
    try {
      const res = await globalThis.fetch(
        `${stack.executionUrl}/execution/reconciliation/holds`,
      );
      assert.equal(res.status, 404);
      const log = stack.requestLog();
      const entry = log[log.length - 1];
      assert.equal(entry.method, "GET");
      assert.equal(entry.key, null);
      assert.equal(entry.url, "/execution/reconciliation/holds");
    } finally {
      await stack.shutdown();
    }
  });

  it("wrong query value on a query-bearing endpoint → 404, key=null", async () => {
    const stack = await startFixtureStack();
    try {
      const res = await globalThis.fetch(
        `${stack.executionUrl}/execution/reconciliation/holds?active=false`,
      );
      assert.equal(res.status, 404);
      const log = stack.requestLog();
      const entry = log[log.length - 1];
      assert.equal(entry.key, null);
      assert.equal(
        entry.url,
        "/execution/reconciliation/holds?active=false",
      );
    } finally {
      await stack.shutdown();
    }
  });

  it("additional query parameters on a query-bearing endpoint → 404, key=null", async () => {
    const stack = await startFixtureStack();
    try {
      const res = await globalThis.fetch(
        `${stack.executionUrl}/execution/reconciliation/holds?active=true&extra=1`,
      );
      assert.equal(res.status, 404);
      const log = stack.requestLog();
      const entry = log[log.length - 1];
      assert.equal(entry.key, null);
      assert.equal(
        entry.url,
        "/execution/reconciliation/holds?active=true&extra=1",
      );
    } finally {
      await stack.shutdown();
    }
  });

  it("additional query parameters on a query-less endpoint → 404, key=null", async () => {
    const stack = await startFixtureStack();
    try {
      const res = await globalThis.fetch(
        `${stack.executionUrl}/execution/kill-switch?force=1`,
      );
      assert.equal(res.status, 404);
      const log = stack.requestLog();
      const entry = log[log.length - 1];
      assert.equal(entry.key, null);
      assert.equal(entry.url, "/execution/kill-switch?force=1");
    } finally {
      await stack.shutdown();
    }
  });

  it("POST to the canonical URL is still rejected", async () => {
    const stack = await startFixtureStack();
    try {
      const res = await globalThis.fetch(
        `${stack.executionUrl}/execution/reconciliation/holds?active=true`,
        { method: "POST" },
      );
      assert.equal(res.status, 404);
      const log = stack.requestLog();
      const entry = log[log.length - 1];
      // Path resolves to the endpoint key (fixture logs it),
      // but the method is POST → response is 404, and the
      // harness's method-gate keeps this out of any HEALTHY
      // path.
      assert.equal(entry.method, "POST");
    } finally {
      await stack.shutdown();
    }
  });
});
