import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundReviewWorker } from "./bound-review-worker.js";
import type { BoundClaim, BoundDecision, BoundReviewStore, DeliveryOutcome } from "./bound-review-repository.js";
import { ExecutionApiClient } from "./execution-api-client.js";
import { MarketAuxClient } from "./marketaux-client.js";
import { OpenAiDecider } from "./openai-decider.js";

const claim: BoundClaim = {
  order: { id: 1, instrument: "MSFT", conid: "42", side: "BUY", orderType: "LMT", quantity: 1,
    entry: 100, stop: 99, takeProfit: 102, confidence: 0.7, reason: "strategy breakout", strategy: "test",
    riskCheckStatus: "PASS", status: "PROPOSED", timestamp: new Date().toISOString(), createdAt: new Date() },
  identity: { clientOrderHash: "hash", instrumentId: "msft", conid: "42", accountId: "DU1", sessionId: "session" },
  token: "00000000-0000-4000-8000-000000000001",
};

class MemoryStore implements BoundReviewStore {
  decision?: BoundDecision;
  outcome?: DeliveryOutcome;
  available = true;
  stale = false;
  async claim() { if (!this.available) return null; this.available = false; return claim; }
  async finalize(_claim: BoundClaim, decision: BoundDecision) {
    if (this.stale) return false;
    this.decision = decision;
    return decision.decision === "EXECUTE";
  }
  async recordDelivery(_claim: BoundClaim, outcome: DeliveryOutcome) { this.outcome = outcome; }
}

for (const scenario of ["approve", "reject", "news-error", "news-malformed", "ai-error", "ai-malformed", "stale", "timeout", "5xx", "malformed2xx", "refused"] as const) {
  test(`bound worker uses real clients and preserves one-shot semantics: ${scenario}`, async (t) => {
    const store = new MemoryStore();
    store.stale = scenario === "stale";
    let deliveries = 0;
    let modelCalls = 0;
    t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/account/summary")) return Response.json({
        accountId: "DU1", source: "live", retrievedAt: new Date().toISOString(), positions: [],
        metrics: { netLiquidation: 10000 }, totals: { positionsCount: 0, grossExposure: 0, netExposure: 0, unrealizedPnL: 0, realizedPnL: 0 },
      });
      if (path.includes("news.test")) {
        if (scenario === "news-error") return new Response("unavailable", { status: 503 });
        if (scenario === "news-malformed") return Response.json({ error: "bad" });
        return Response.json({ data: [] });
      }
      if (path.includes("ai.test")) {
        modelCalls++;
        const body = JSON.parse(String(init?.body));
        assert.match(body.messages[0].content, /untrusted data/);
        assert.match(body.messages[1].content, /UNAVAILABLE/);
        if (scenario === "ai-error") return new Response("unavailable", { status: 503 });
        return Response.json({ choices: [{ message: { content: scenario === "ai-malformed" ? '{"decision":"EXECUTE"}' :
          JSON.stringify({ decision: scenario === "reject" ? "REJECT" : "EXECUTE", confidence: 0.8, reason: "context supports trade" }) } }] });
      }
      assert.ok(path.includes("/execute-proposed/1"));
      deliveries++;
      assert.equal(store.decision?.decision, "EXECUTE");
      if (scenario === "timeout") throw new DOMException("timeout", "AbortError");
      if (scenario === "5xx") return new Response("uncertain", { status: 500 });
      if (scenario === "refused") return new Response("blocked", { status: 409 });
      if (scenario === "malformed2xx") return Response.json({ ok: true });
      return Response.json({ outcome: "SUBMITTED", order: { id: 1, status: "SUBMITTED" } });
    });
    const worker = new BoundReviewWorker({ repository: store,
      execution: new ExecutionApiClient("https://execution.test", 100, "test-only"),
      news: new MarketAuxClient({ apiKey: "fake", baseUrl: "https://news.test", timeoutMs: 100 }),
      decider: new OpenAiDecider({ apiKey: "fake", baseUrl: "https://ai.test", timeoutMs: 100,
        model: "fake-model", promptVersion: "bound-v1", maxOpenNotionalPct: 10 }),
      model: "fake-model", promptVersion: "bound-v1", newsWindowHours: 24, maxNewsItems: 3 });
    assert.equal(await worker.pollOnce(), true);
    assert.equal(await worker.pollOnce(), false);
    if (["reject", "news-error", "news-malformed", "ai-error", "ai-malformed", "stale"].includes(scenario)) {
      assert.equal(deliveries, 0);
      assert.equal(store.decision?.decision, scenario === "stale" ? undefined : "REJECT");
    } else {
      assert.equal(deliveries, 1);
      assert.equal(store.decision?.decision, "EXECUTE");
      assert.equal(store.outcome, scenario === "approve" ? "SUBMITTED" : scenario === "refused" ? "REFUSED" : "UNKNOWN");
      assert.ok(JSON.stringify(store.decision?.context).includes('"availability":"EMPTY"'));
    }
    if (scenario.startsWith("news-")) assert.equal(modelCalls, 0);
  });
}

test("bound path always rejects missing providers without attempting sources", async () => {
  const repository = new MemoryStore();
  const worker = new BoundReviewWorker({ repository,
    execution: { getAccountSummary: async () => { throw new Error("must not fetch"); }, executeBoundProposed: async () => { throw new Error("must not execute"); } },
    news: { isConfigured: () => false, getNewsForSymbol: async () => { throw new Error("must not fetch"); } },
    decider: { isConfigured: () => false, decide: async () => { throw new Error("must not fetch"); } },
    model: "fake", promptVersion: "v1", newsWindowHours: 24, maxNewsItems: 3 });
  await worker.pollOnce();
  assert.equal(repository.decision?.reason, "NEWS_NOT_CONFIGURED");
});
