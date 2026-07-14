import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { SignalTicket } from "@ikbr/shared";

import { HttpExecutionTicketSubmitter } from "./submitter.js";

const TICKET: SignalTicket = {
  instrument: "RTX",
  side: "BUY",
  orderType: "LMT",
  quantity: 10,
  entry: 100.5,
  stop: 99,
  takeProfit: 102,
  reason: "test",
  confidence: 1,
  timestamp: "2026-07-14T12:00:00.000Z",
  riskCheckStatus: "PASS",
};

const INPUT = {
  ticket: TICKET,
  strategy: "execution-runtime",
  clientOrderId: "idem-1",
  clientOrderHash: "abc",
};

function fakeFetch(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return await responder(String(url), init);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe("HttpExecutionTicketSubmitter — construction", () => {
  it("throws when engineUrl is missing", () => {
    assert.throws(
      () =>
        new HttpExecutionTicketSubmitter({
          // @ts-expect-error deliberate misuse
          engineUrl: undefined,
          bearerToken: "t",
          requestTimeoutMs: 1000,
        }),
      /engineUrl is required/,
    );
  });

  it("throws when requestTimeoutMs is non-positive", () => {
    assert.throws(
      () =>
        new HttpExecutionTicketSubmitter({
          engineUrl: "http://x",
          bearerToken: "t",
          requestTimeoutMs: 0,
        }),
      /requestTimeoutMs must be > 0/,
    );
  });
});

describe("HttpExecutionTicketSubmitter.submit — request shape", () => {
  it("posts { ticket, persist=true, strategy, clientOrderId, clientOrderHash } with Bearer auth", async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            outcome: "SUBMITTED",
            execution: {
              accountId: "P1",
              brokerOrderId: "b-1",
              status: "SUBMITTED",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const submitter = new HttpExecutionTicketSubmitter({
      engineUrl: "http://engine:3103",
      bearerToken: "secret",
      requestTimeoutMs: 5000,
      fetchImpl: fetch,
    });
    await submitter.submit(INPUT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://engine:3103/execution/execute-ticket");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer secret");
    assert.equal(headers["content-type"], "application/json");
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.persist, true);
    assert.equal(body.strategy, "execution-runtime");
    assert.equal(body.clientOrderId, "idem-1");
    assert.equal(body.clientOrderHash, "abc");
    assert.equal(body.ticket.instrument, "RTX");
  });

  it("strips a trailing slash from engineUrl", async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            outcome: "SUBMITTED",
            execution: {
              accountId: "P1",
              brokerOrderId: "b-1",
              status: "SUBMITTED",
            },
          }),
          { status: 200 },
        ),
    );
    const submitter = new HttpExecutionTicketSubmitter({
      engineUrl: "http://engine:3103/",
      bearerToken: "s",
      requestTimeoutMs: 5000,
      fetchImpl: fetch,
    });
    await submitter.submit(INPUT);
    assert.equal(calls[0].url, "http://engine:3103/execution/execute-ticket");
  });
});

describe("HttpExecutionTicketSubmitter.submit — outcome mapping (PR13 discriminator)", () => {
  async function submitWith(
    responder: (url: string, init: RequestInit) => Response,
  ) {
    const { fetch } = fakeFetch(responder);
    const submitter = new HttpExecutionTicketSubmitter({
      engineUrl: "http://engine",
      bearerToken: "s",
      requestTimeoutMs: 5000,
      fetchImpl: fetch,
    });
    return submitter.submit(INPUT);
  }

  it('200 { outcome: "SUBMITTED", execution } → submitted', async () => {
    const result = await submitWith(
      () =>
        new Response(
          JSON.stringify({
            outcome: "SUBMITTED",
            execution: {
              accountId: "P1",
              brokerOrderId: "b-1",
              status: "SUBMITTED",
            },
          }),
          { status: 200 },
        ),
    );
    assert.equal(result.kind, "submitted");
    if (result.kind !== "submitted") return;
    assert.equal(result.response.execution.brokerOrderId, "b-1");
  });

  it('200 { outcome: "RESUMED" } → resumed', async () => {
    const result = await submitWith(
      () =>
        new Response(
          JSON.stringify({
            outcome: "RESUMED",
            execution: {
              accountId: "P1",
              brokerOrderId: "b-2",
              status: "SUBMITTED",
            },
            resumed: true,
          }),
          { status: 200 },
        ),
    );
    assert.equal(result.kind, "resumed");
  });

  it('200 { outcome: "DUPLICATE_SUBMITTED" } → duplicate_submitted', async () => {
    const result = await submitWith(
      () =>
        new Response(
          JSON.stringify({
            outcome: "DUPLICATE_SUBMITTED",
            duplicate: true,
            order: { id: 42, status: "SUBMITTED" },
          }),
          { status: 200 },
        ),
    );
    assert.equal(result.kind, "duplicate_submitted");
  });

  it('200 { outcome: "DUPLICATE_TERMINAL" } → duplicate_terminal', async () => {
    const result = await submitWith(
      () =>
        new Response(
          JSON.stringify({
            outcome: "DUPLICATE_TERMINAL",
            duplicate: true,
            order: { id: 42, status: "REJECTED" },
          }),
          { status: 200 },
        ),
    );
    assert.equal(result.kind, "duplicate_terminal");
  });

  it('200 { outcome: "DUPLICATE_PENDING_AMBIGUOUS" } → duplicate_pending_ambiguous', async () => {
    const result = await submitWith(
      () =>
        new Response(
          JSON.stringify({
            outcome: "DUPLICATE_PENDING_AMBIGUOUS",
            duplicate: true,
            order: { id: 42, status: "PROPOSED" },
          }),
          { status: 200 },
        ),
    );
    assert.equal(result.kind, "duplicate_pending_ambiguous");
  });

  it('200 { outcome: "PENDING_CLAIMED" } → pending_claimed', async () => {
    const result = await submitWith(
      () =>
        new Response(
          JSON.stringify({
            outcome: "PENDING_CLAIMED",
            duplicate: true,
            order: { id: 42, status: "PROPOSED" },
          }),
          { status: 200 },
        ),
    );
    assert.equal(result.kind, "pending_claimed");
  });

  it("200 without a recognised outcome → unknown (defensive; no silent fall-through to submitted)", async () => {
    const result = await submitWith(
      () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );
    assert.equal(result.kind, "unknown");
  });

  it("200 { outcome: legacy-truthy } but with no execution field → unknown", async () => {
    // Even a legacy `{ duplicate: true }` without an `outcome`
    // discriminator MUST NOT be classified — the runtime cannot
    // tell submitted from terminal from pending.
    const result = await submitWith(
      () =>
        new Response(JSON.stringify({ duplicate: true, order: { id: 42 } }), {
          status: 200,
        }),
    );
    assert.equal(result.kind, "unknown");
  });

  it("409 → conflict", async () => {
    const result = await submitWith(
      () =>
        new Response(JSON.stringify({ error: "idempotency_conflict" }), {
          status: 409,
        }),
    );
    assert.equal(result.kind, "conflict");
  });

  it("400 → not_submitted (deterministic rejection)", async () => {
    const result = await submitWith(
      () =>
        new Response(JSON.stringify({ error: "invalid_ticket" }), {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    assert.equal(result.kind, "not_submitted");
    if (result.kind !== "not_submitted") return;
    assert.equal(result.statusCode, 400);
    assert.match(result.message, /invalid_ticket/);
  });

  it("423 (kill-switch) → not_submitted", async () => {
    const result = await submitWith(
      () =>
        new Response(JSON.stringify({ error: "kill_switch" }), {
          status: 423,
        }),
    );
    assert.equal(result.kind, "not_submitted");
    if (result.kind !== "not_submitted") return;
    assert.equal(result.statusCode, 423);
  });

  it("500 → unknown (never retry)", async () => {
    const result = await submitWith(
      () =>
        new Response(JSON.stringify({ error: "internal" }), {
          status: 500,
          statusText: "Internal Server Error",
        }),
    );
    assert.equal(result.kind, "unknown");
    if (result.kind !== "unknown") return;
    assert.match(result.reason, /500/);
  });

  it("502 → unknown (never retry)", async () => {
    const result = await submitWith(
      () =>
        new Response(JSON.stringify({}), {
          status: 502,
          statusText: "Bad Gateway",
        }),
    );
    assert.equal(result.kind, "unknown");
  });

  it("network error → unknown", async () => {
    const submitter = new HttpExecutionTicketSubmitter({
      engineUrl: "http://engine",
      bearerToken: "s",
      requestTimeoutMs: 5000,
      fetchImpl: async () => {
        throw new TypeError("connect ECONNREFUSED 127.0.0.1:3103");
      },
    });
    const result = await submitter.submit(INPUT);
    assert.equal(result.kind, "unknown");
    if (result.kind !== "unknown") return;
    assert.match(result.reason, /ECONNREFUSED/);
  });

  it("timeout / AbortError → unknown with timeout-shaped reason", async () => {
    const submitter = new HttpExecutionTicketSubmitter({
      engineUrl: "http://engine",
      bearerToken: "s",
      requestTimeoutMs: 5000,
      fetchImpl: async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    const result = await submitter.submit(INPUT);
    assert.equal(result.kind, "unknown");
    if (result.kind !== "unknown") return;
    assert.match(result.reason, /timed out/);
  });
});
