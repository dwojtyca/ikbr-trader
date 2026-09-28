import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TradingLoopResultView } from "./TradingLoopResult";
import {
  fetchOperatorApi,
  parseTradingLoopResult,
  requestTradingLoopRunOnce,
  TRADING_LOOP_RUN_ONCE_PATH,
} from "./trading-loop";

const cycle = {
  cycleId: "cycle-1",
  startedAt: "2026-09-28T10:00:00.000Z",
  finishedAt: "2026-09-28T10:00:01.000Z",
  durationMs: 1000,
  reports: [
    {
      instrumentId: "pko_wse",
      startedAt: "2026-09-28T10:00:00.100Z",
      finishedAt: "2026-09-28T10:00:00.900Z",
      durationMs: 800,
      outcome: {
        kind: "UNKNOWN",
        reason: "submission outcome is unknown",
        message: "Check reconciliation",
        idempotencyKey: "cycle-key-1",
      },
    },
  ],
};

test("operator API requests carry only the fixed same-origin intent policy", async () => {
  const originalFetch = globalThis.fetch;
  let observed: [RequestInfo | URL, RequestInit | undefined] | undefined;
  globalThis.fetch = (async (input, init) => {
    observed = [input, init];
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await fetchOperatorApi("/api/example", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(observed?.[0], "/api/example");
  const init = observed?.[1];
  assert.equal(new Headers(init?.headers).get("X-Operator-Request"), "1");
  assert.equal(init?.credentials, "same-origin");
  assert.equal(init?.redirect, "error");
});

test("run-once sends an empty body to the configured-instrument endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let observed: [RequestInfo | URL, RequestInit | undefined] | undefined;
  globalThis.fetch = (async (input, init) => {
      observed = [input, init];
    return Response.json(cycle);
  }) as typeof fetch;
  try {
    const result = await requestTradingLoopRunOnce();
    assert.equal(result.cycleId, "cycle-1");
    assert.equal(result.reports[0]?.outcome.kind, "UNKNOWN");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(observed?.[0], TRADING_LOOP_RUN_ONCE_PATH);
  assert.equal(observed?.[1]?.method, "POST");
  assert.equal(observed?.[1]?.body, undefined);
  assert.equal(new Headers(observed?.[1]?.headers).has("content-type"), false);
  assert.equal(new Headers(observed?.[1]?.headers).get("X-Operator-Request"), "1");
});

test("unexpected result data and HTTP failures remain unavailable errors", async () => {
  assert.throws(
    () => parseTradingLoopResult({ ...cycle, reports: [{ ...cycle.reports[0], outcome: { kind: "FUTURE" } }] }),
    /unavailable/,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(requestTradingLoopRunOnce(), /Paper guard rejected.*503/);
    for (const [status, expected] of [
      [401, /authentication required/],
      [403, /origin or request was rejected/],
      [404, /endpoint unavailable/],
    ] as const) {
      globalThis.fetch = (async () => new Response("", { status })) as typeof fetch;
      await assert.rejects(requestTradingLoopRunOnce(), expected);
    }
    globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch;
    await assert.rejects(requestTradingLoopRunOnce(), /invalid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("result rendering distinguishes unknown outcomes and an empty instrument set", () => {
  const unknownMarkup = renderToStaticMarkup(
    createElement(TradingLoopResultView, {
      result: parseTradingLoopResult(cycle),
    }),
  );
  assert.match(unknownMarkup, /pko_wse: UNKNOWN/);
  assert.match(unknownMarkup, /submission outcome is unknown/);
  assert.match(unknownMarkup, /Check reconciliation/);
  assert.match(unknownMarkup, /cycle-key-1/);

  const outcomeKinds = [
    "SUBMITTED",
    "DUPLICATE",
    "PENDING",
    "AWAITING_AI",
    "CONFLICT",
    "UNKNOWN",
    "NOT_SUBMITTED",
    "SKIPPED",
    "ERROR",
  ];
  const outcomesMarkup = renderToStaticMarkup(
    createElement(TradingLoopResultView, {
      result: parseTradingLoopResult({
        ...cycle,
        reports: outcomeKinds.map((kind, index) => ({
          instrumentId: `instrument-${index}`,
          startedAt: "2026-09-28T10:00:00.100Z",
          finishedAt: "2026-09-28T10:00:00.900Z",
          durationMs: 800,
          outcome: { kind, reason: `reason-${kind}`, message: `message-${kind}` },
        })),
      }),
    }),
  );
  for (const kind of outcomeKinds) {
    assert.ok(outcomesMarkup.includes(`${kind}</strong>`));
    assert.ok(outcomesMarkup.includes(`reason-${kind}`));
    assert.ok(outcomesMarkup.includes(`message-${kind}`));
  }

  const emptyMarkup = renderToStaticMarkup(
    createElement(TradingLoopResultView, {
      result: parseTradingLoopResult({ ...cycle, reports: [] }),
    }),
  );
  assert.match(emptyMarkup, /No configured instruments were evaluated/);

  const escapedMarkup = renderToStaticMarkup(
    createElement(TradingLoopResultView, {
      result: parseTradingLoopResult({
        ...cycle,
        cycleId: "<script>",
        reports: [],
      }),
    }),
  );
  assert.doesNotMatch(escapedMarkup, /<script>/);
  assert.match(escapedMarkup, /&lt;script&gt;/);
});
