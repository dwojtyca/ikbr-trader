import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTransport, type TransportRequestLog } from "./http.js";

function makeFetch(
  handler: (
    url: string,
    init: RequestInit,
  ) => Promise<{ status: number; body: string }>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const res = await handler(url, init ?? {});
    return new Response(res.body, { status: res.status });
  };
}

describe("transport", () => {
  it("issues GET-only against allowlisted endpoints", async () => {
    const requestLog: TransportRequestLog[] = [];
    const seen: Array<{ method: string; url: string }> = [];
    const t = createTransport({
      ingestionUrl: "http://127.0.0.1:3101",
      signalUrl: "http://127.0.0.1:3102",
      executionUrl: "http://127.0.0.1:3103",
      token: undefined,
      timeoutMs: 500,
      requestLog,
      fetchImpl: makeFetch(async (url, init) => {
        seen.push({ method: String(init.method), url });
        return { status: 200, body: JSON.stringify({ ok: true }) };
      }),
    });
    const r = await t.get("INGESTION_HEALTH");
    assert.equal(r.kind, "response");
    assert.deepEqual(seen, [
      { method: "GET", url: "http://127.0.0.1:3101/health" },
    ]);
    assert.deepEqual(requestLog, [
      {
        method: "GET",
        url: "http://127.0.0.1:3101/health",
        key: "INGESTION_HEALTH",
      },
    ]);
  });

  it("rejects bearer endpoints when no token is configured", async () => {
    const t = createTransport({
      ingestionUrl: "http://127.0.0.1:3101",
      signalUrl: "http://127.0.0.1:3102",
      executionUrl: "http://127.0.0.1:3103",
      token: undefined,
      timeoutMs: 500,
      fetchImpl: makeFetch(async () => ({ status: 200, body: "{}" })),
    });
    await assert.rejects(() => t.get("EXECUTION_READY"), /bearer/i);
  });

  it("classifies timeouts", async () => {
    const t = createTransport({
      ingestionUrl: "http://127.0.0.1:3101",
      signalUrl: "http://127.0.0.1:3102",
      executionUrl: "http://127.0.0.1:3103",
      token: undefined,
      timeoutMs: 20,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as { name: string }).name = "AbortError";
            reject(err);
          });
        });
      }) as typeof globalThis.fetch,
    });
    const r = await t.get("INGESTION_HEALTH");
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.equal(r.reason, "timeout");
  });

  it("classifies connection refused as network", async () => {
    const t = createTransport({
      ingestionUrl: "http://127.0.0.1:3101",
      signalUrl: "http://127.0.0.1:3102",
      executionUrl: "http://127.0.0.1:3103",
      token: undefined,
      timeoutMs: 200,
      fetchImpl: (async () => {
        const err = new Error("fetch failed");
        (err as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
        throw err;
      }) as typeof globalThis.fetch,
    });
    const r = await t.get("INGESTION_HEALTH");
    assert.equal(r.kind, "error");
    if (r.kind !== "error") return;
    assert.equal(r.reason, "network");
  });
});
