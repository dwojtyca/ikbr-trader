import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReconciliationReader } from "./reconciliation-reader.js";

function makeReader(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): ReconciliationReader {
  return new ReconciliationReader({
    baseUrl: "http://execution:3103",
    bearerToken: "test",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

const runFixtureExposureComplete = {
  id: 42,
  accountId: "DU-1",
  sessionId: "sess-A",
  status: "CLEAN" as const,
  completedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  sourceCoverage: {
    positions: { available: true, boundedWindow: true },
    openOrders: { available: true, boundedWindow: true },
    executions: { available: true, window: { exposureWindowComplete: true, recoveryWindowComplete: true } },
    completedOrders: { available: true, boundedWindow: true },
    session: { available: true, boundedWindow: true },
  },
};

describe("ReconciliationReader (signal-engine, fail-closed)", () => {
  it("pass when latest run is clean, exposure complete, in-session, and no matching hold", async () => {
    const reader = makeReader(async (url) => {
      if (url.endsWith("/latest")) {
        return new Response(
          JSON.stringify({
            accountId: "DU-1",
            sessionId: "sess-A",
            run: runFixtureExposureComplete,
            stale: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/holds?active=true")) {
        return new Response(
          JSON.stringify({ accountId: "DU-1", holds: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const out = await reader.checkInstrument({ instrument: "AAPL", conId: "123" });
    assert.equal(out.kind, "pass");
  });

  it("stale run → stale", async () => {
    const reader = makeReader(async (url) => {
      if (url.endsWith("/latest")) {
        return new Response(
          JSON.stringify({
            accountId: "DU-1",
            sessionId: "sess-A",
            run: runFixtureExposureComplete,
            stale: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ accountId: "DU-1", holds: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await reader.checkInstrument({ instrument: "AAPL" });
    assert.equal(out.kind, "stale");
  });

  it("wrong-session run → unavailable(wrong_session)", async () => {
    const reader = makeReader(async (url) => {
      if (url.endsWith("/latest")) {
        // Server reports latest.sessionId=sess-A but the run
        // itself is under sess-B — a foreign run.
        return new Response(
          JSON.stringify({
            accountId: "DU-1",
            sessionId: "sess-A",
            run: { ...runFixtureExposureComplete, sessionId: "sess-B" },
            stale: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ accountId: "DU-1", holds: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await reader.checkInstrument({ instrument: "AAPL", conId: "123" });
    assert.equal(out.kind, "unavailable");
    if (out.kind === "unavailable")
      assert.equal(out.reason, "reconciliation_wrong_session");
  });

  it("active hold matching identity → hold; different identity → pass", async () => {
    const holds = [
      {
        id: 1,
        active: true,
        identityKey: "conid:DU-1|123",
        reason: "position_mismatch",
        severity: "error",
        instrument: "AAPL",
        conId: "123",
      },
    ];
    const reader = makeReader(async (url) => {
      if (url.endsWith("/latest")) {
        return new Response(
          JSON.stringify({
            accountId: "DU-1",
            sessionId: "sess-A",
            run: runFixtureExposureComplete,
            stale: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ accountId: "DU-1", holds }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const aapl = await reader.checkInstrument({ instrument: "AAPL", conId: "123" });
    assert.equal(aapl.kind, "hold");
    const goog = await reader.checkInstrument({ instrument: "GOOG", conId: "999" });
    assert.equal(goog.kind, "pass");
  });

  it("transport error → unavailable (fail-closed)", async () => {
    const reader = makeReader(async () => {
      throw new Error("boom");
    });
    const out = await reader.checkInstrument({ instrument: "AAPL" });
    assert.equal(out.kind, "unavailable");
    if (out.kind === "unavailable") assert.equal(out.reason, "transport");
  });

  it("malformed body → unavailable (fail-closed)", async () => {
    const reader = makeReader(async () => {
      return new Response(JSON.stringify({ garbage: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const out = await reader.checkInstrument({ instrument: "AAPL" });
    assert.equal(out.kind, "unavailable");
    if (out.kind === "unavailable") assert.equal(out.reason, "malformed_body");
  });

  it("exposureComplete=false in latest run → unavailable(incomplete_exposure)", async () => {
    const reader = makeReader(async (url) => {
      if (url.endsWith("/latest")) {
        return new Response(
          JSON.stringify({
            accountId: "DU-1",
            sessionId: "sess-A",
            run: {
              ...runFixtureExposureComplete,
              status: "INCOMPLETE",
              sourceCoverage: {
                ...runFixtureExposureComplete.sourceCoverage,
                positions: { available: false, boundedWindow: false },
              },
            },
            stale: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ accountId: "DU-1", holds: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await reader.checkInstrument({ instrument: "AAPL" });
    assert.equal(out.kind, "unavailable");
    if (out.kind === "unavailable")
      assert.equal(out.reason, "reconciliation_incomplete_exposure");
  });
});
