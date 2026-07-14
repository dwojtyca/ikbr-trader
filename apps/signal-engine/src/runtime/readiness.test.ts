import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkRuntimeReadiness } from "./readiness.js";

describe("checkRuntimeReadiness", () => {
  it("returns ready=true when both Redis and Postgres respond", async () => {
    const result = await checkRuntimeReadiness({
      redis: { ping: async () => "PONG" },
      postgres: { query: async () => ({ rows: [{ "?column?": 1 }] }) },
    });
    assert.equal(result.ready, true);
    assert.equal(result.checks.redis.ok, true);
    assert.equal(result.checks.postgres.ok, true);
  });

  it("returns ready=false and captures the Redis error", async () => {
    const result = await checkRuntimeReadiness({
      redis: {
        ping: async () => {
          throw new Error("redis unreachable");
        },
      },
      postgres: { query: async () => ({}) },
    });
    assert.equal(result.ready, false);
    assert.equal(result.checks.redis.ok, false);
    assert.match(result.checks.redis.error!, /redis unreachable/);
    assert.equal(result.checks.postgres.ok, true);
  });

  it("returns ready=false and captures the Postgres error", async () => {
    const result = await checkRuntimeReadiness({
      redis: { ping: async () => "PONG" },
      postgres: {
        query: async () => {
          throw new Error("pg unreachable");
        },
      },
    });
    assert.equal(result.ready, false);
    assert.equal(result.checks.postgres.ok, false);
    assert.match(result.checks.postgres.error!, /pg unreachable/);
  });

  it("does not include broker / IBKR / execution-engine in the readiness surface", async () => {
    // Structural check: PR12 readiness explicitly excludes broker
    // liveness. Adding those here would violate the "runtime readiness
    // reflects only dry-run dependencies" contract.
    const result = await checkRuntimeReadiness({
      redis: { ping: async () => "PONG" },
      postgres: { query: async () => ({}) },
    });
    const checkKeys = Object.keys(result.checks);
    assert.deepEqual(checkKeys.sort(), ["postgres", "redis"]);
  });
});
