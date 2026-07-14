import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  HttpTradingExposureReader,
  TradingExposureReadError,
  classifyExposure,
} from "./exposure-reader.js";

// ---------------------------------------------------------------------------
// classifyExposure — pure filter logic
// ---------------------------------------------------------------------------

function order(
  overrides: Parameters<typeof classifyExposure>[0][number],
): Parameters<typeof classifyExposure>[0][number] {
  return overrides;
}

describe("classifyExposure — orders (non-terminal blocks; terminal does not)", () => {
  it("no orders + no positions → every flag false", () => {
    const result = classifyExposure([], { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() }, "AAPL");
    assert.deepEqual(result, {
      hasOpenPosition: false,
      hasActiveOrder: false,
      hasAmbiguousSubmission: false,
      hasPendingProposal: false,
    });
  });

  it("SUBMITTED for the symbol → hasActiveOrder", () => {
    const result = classifyExposure(
      [order({ instrument: "AAPL", status: "SUBMITTED" })],
      { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasActiveOrder, true);
    assert.equal(result.hasAmbiguousSubmission, false);
    assert.equal(result.hasPendingProposal, false);
  });

  it("SUBMITTED for a DIFFERENT symbol is ignored", () => {
    const result = classifyExposure(
      [order({ instrument: "MSFT", status: "SUBMITTED" })],
      { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasActiveOrder, false);
  });

  it("PROPOSED + executionAttemptedAt → hasAmbiguousSubmission (marker set)", () => {
    const result = classifyExposure(
      [
        order({
          instrument: "AAPL",
          status: "PROPOSED",
          executionAttemptedAt: new Date(),
        }),
      ],
      { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasAmbiguousSubmission, true);
    assert.equal(result.hasPendingProposal, false);
    assert.equal(result.hasActiveOrder, false);
  });

  it("PROPOSED + brokerOrderId → hasAmbiguousSubmission", () => {
    const result = classifyExposure(
      [
        order({
          instrument: "AAPL",
          status: "PROPOSED",
          brokerOrderId: "b-1",
        }),
      ],
      { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasAmbiguousSubmission, true);
    assert.equal(result.hasPendingProposal, false);
  });

  it("clean PROPOSED (no markers) → hasPendingProposal (round-2 blocker fix)", () => {
    // Round 2: a clean orphan PROPOSED is safe to RESUME under its
    // own clientOrderId but MUST NOT be shadowed by a fresh insert
    // under a NEW clientOrderId. The loop must therefore block.
    const result = classifyExposure(
      [order({ instrument: "AAPL", status: "PROPOSED" })],
      { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasPendingProposal, true);
    assert.equal(result.hasAmbiguousSubmission, false);
    assert.equal(result.hasActiveOrder, false);
  });

  it("clean PROPOSED with executionAttemptedAt=null (explicitly null) → hasPendingProposal", () => {
    const result = classifyExposure(
      [
        order({
          instrument: "AAPL",
          status: "PROPOSED",
          executionAttemptedAt: null,
          brokerOrderId: null,
        }),
      ],
      { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasPendingProposal, true);
    assert.equal(result.hasAmbiguousSubmission, false);
  });

  it("terminal statuses do NOT signal any exposure on their own", () => {
    for (const status of [
      "REJECTED",
      "CANCELLED",
      "SUPERSEDED",
      "EXPIRED",
      "FILLED",
    ] as const) {
      const result = classifyExposure(
        [order({ instrument: "AAPL", status })],
        { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() },
        "AAPL",
      );
      assert.equal(result.hasActiveOrder, false, `status=${status}`);
      assert.equal(result.hasAmbiguousSubmission, false, `status=${status}`);
      assert.equal(result.hasPendingProposal, false, `status=${status}`);
    }
  });
});

describe("classifyExposure — positions", () => {
  it("positive position → LONG open", () => {
    const result = classifyExposure(
      [],
      { positions: [{ symbol: "AAPL", position: 100 }], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasOpenPosition, true);
    assert.equal(result.positionSide, "LONG");
    assert.equal(result.quantity, 100);
  });

  it("negative position → SHORT open", () => {
    const result = classifyExposure(
      [],
      { positions: [{ symbol: "AAPL", position: -50 }], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasOpenPosition, true);
    assert.equal(result.positionSide, "SHORT");
    assert.equal(result.quantity, 50);
  });

  it("zero position (flat) → no open position", () => {
    const result = classifyExposure(
      [],
      { positions: [{ symbol: "AAPL", position: 0 }], source: "live" as const, retrievedAt: new Date().toISOString() },
      "AAPL",
    );
    assert.equal(result.hasOpenPosition, false);
    assert.equal(result.positionSide, undefined);
    assert.equal(result.quantity, undefined);
  });
});

// ---------------------------------------------------------------------------
// HttpTradingExposureReader — fetch integration
// ---------------------------------------------------------------------------

function fakeFetch(
  responder: (url: string) => { status?: number; body: unknown },
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    void init;
    const url = typeof input === "string" ? input : (input as URL).toString();
    const { status = 200, body } = responder(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function reader(fetchImpl: typeof fetch): HttpTradingExposureReader {
  return new HttpTradingExposureReader({
    engineUrl: "http://execution:3103",
    bearerToken: "t",
    requestTimeoutMs: 1_000,
    fetch: fetchImpl,
  });
}

describe("HttpTradingExposureReader — happy path with schema validation", () => {
  it("combines orders + summary into a TradingExposure", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) {
          return {
            body: [
              {
                instrument: "AAPL",
                status: "SUBMITTED",
                executionAttemptedAt: new Date().toISOString(),
                brokerOrderId: "b-1",
              },
            ],
          };
        }
        return {
          body: { positions: [{ symbol: "AAPL", position: 100 }], source: "live" as const, retrievedAt: new Date().toISOString() },
        };
      }),
    );
    const exposure = await r.readExposure({
      instrumentId: "aapl_stk",
      brokerSymbol: "AAPL",
    });
    assert.equal(exposure.hasActiveOrder, true);
    assert.equal(exposure.hasOpenPosition, true);
    assert.equal(exposure.positionSide, "LONG");
  });

  it("empty orders + empty positions → all flags false", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
      }),
    );
    const exposure = await r.readExposure({
      instrumentId: "aapl_stk",
      brokerSymbol: "AAPL",
    });
    assert.equal(exposure.hasActiveOrder, false);
    assert.equal(exposure.hasOpenPosition, false);
    assert.equal(exposure.hasAmbiguousSubmission, false);
    assert.equal(exposure.hasPendingProposal, false);
  });
});

// ---------------------------------------------------------------------------
// HttpTradingExposureReader — fail-closed validation (round 2 blocker)
// ---------------------------------------------------------------------------

describe("HttpTradingExposureReader — fail-closed schema validation", () => {
  it("summary WITHOUT positions field → malformed_summary error", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { body: { /* positions missing */ } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "malformed_summary",
    );
  });

  it("summary.positions is not an array → malformed_summary", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { body: { positions: { symbol: "AAPL", position: 1 } } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "malformed_summary",
    );
  });

  it("position with NaN quantity → malformed_summary", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { body: { positions: [{ symbol: "AAPL", position: NaN }] } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "malformed_summary",
    );
  });

  it("position with string quantity → malformed_summary", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { body: { positions: [{ symbol: "AAPL", position: "100" }] } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "malformed_summary",
    );
  });

  it("order with unknown status → malformed_orders", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) {
          return { body: [{ instrument: "AAPL", status: "WEIRD" }] };
        }
        return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "malformed_orders",
    );
  });

  it("order missing instrument → malformed_orders", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) {
          return { body: [{ status: "SUBMITTED" }] };
        }
        return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "malformed_orders",
    );
  });

  it("orders body is an object (not an array) → malformed_orders", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) {
          return { body: { not: "an array" } };
        }
        return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "malformed_orders",
    );
  });

  it("HTTP 500 on /execution/orders → http_error", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) {
          return { status: 500, body: { error: "boom" } };
        }
        return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "http_error",
    );
  });

  it("HTTP 500 on /execution/account/summary → http_error", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { status: 500, body: { error: "boom" } };
      }),
    );
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "http_error",
    );
  });

  it("network error → network_error", async () => {
    const r = new HttpTradingExposureReader({
      engineUrl: "http://execution:3103",
      bearerToken: "t",
      requestTimeoutMs: 1_000,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "AAPL" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "network_error",
    );
  });

  it("missing brokerSymbol → invalid_input, no network call", async () => {
    let called = false;
    const r = new HttpTradingExposureReader({
      engineUrl: "http://execution:3103",
      bearerToken: "t",
      requestTimeoutMs: 1_000,
      fetch: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await assert.rejects(
      r.readExposure({ instrumentId: "aapl_stk", brokerSymbol: "" }),
      (err) =>
        err instanceof TradingExposureReadError && err.code === "invalid_input",
    );
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// probeReady — round-3 blocker fix: checks BOTH endpoints
// ---------------------------------------------------------------------------

describe("HttpTradingExposureReader.probeReady", () => {
  function bothOk(): typeof fetch {
    return fakeFetch((url) => {
      if (url.includes("/execution/orders")) return { body: [] };
      return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
    });
  }

  it("both endpoints OK → { ok: true }", async () => {
    const r = reader(bothOk());
    assert.deepEqual(await r.probeReady(), { ok: true });
  });

  it("orders 500 → { ok: false }, error mentions orders", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { status: 500, body: {} };
        return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
      }),
    );
    const result = await r.probeReady();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /orders/);
    assert.match(result.message, /http_error/);
  });

  it("account_summary 500 → { ok: false }, error mentions account_summary", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { status: 500, body: {} };
      }),
    );
    const result = await r.probeReady();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /account_summary/);
    assert.match(result.message, /http_error/);
  });

  it("malformed orders body → { ok: false }, orders branch", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: { not: "array" } };
        return { body: { positions: [], source: "live" as const, retrievedAt: new Date().toISOString() } };
      }),
    );
    const result = await r.probeReady();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /orders/);
  });

  it("malformed summary body (missing positions) → { ok: false }, summary branch", async () => {
    const r = reader(
      fakeFetch((url) => {
        if (url.includes("/execution/orders")) return { body: [] };
        return { body: { /* positions missing */ } };
      }),
    );
    const result = await r.probeReady();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /account_summary/);
  });

  it("both endpoints failing → single message mentions BOTH", async () => {
    const r = reader(fakeFetch(() => ({ status: 500, body: {} })));
    const result = await r.probeReady();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.message, /orders/);
    assert.match(result.message, /account_summary/);
  });

  it("network error → { ok: false }, NEVER throws", async () => {
    const r = new HttpTradingExposureReader({
      engineUrl: "http://execution:3103",
      bearerToken: "t",
      requestTimeoutMs: 1_000,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const result = await r.probeReady();
    assert.equal(result.ok, false);
  });
});
