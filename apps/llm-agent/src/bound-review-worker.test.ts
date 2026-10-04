import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundReviewWorker } from "./bound-review-worker.js";
import type { BoundClaim, BoundDecision, DeliveryOutcome } from "./bound-review-repository.js";
import { ExecutionApiClient } from "./execution-api-client.js";
import { ResearchOpenAiDecider, researchRequestHash, type ResearchModelRequest } from "./research-decision.js";
import { reviewFixture } from "./research-review.testfixture.js";
import type { ResearchReviewStore } from "./research-review-repository.js";

for (const scenario of ["approve", "reject", "missing", "stale-context", "budget", "ai-error", "ai-malformed", "unknown-ref", "missing-ref", "stale", "timeout", "5xx", "malformed2xx", "refused"] as const) {
  test(`cached bound worker one-shot semantics: ${scenario}`, async t => {
    const f = reviewFixture(); let available = true, saved: BoundDecision | undefined, outcome: DeliveryOutcome | undefined;
    let deliveries = 0, modelCalls = 0, reserved = 0, modelOutcome: unknown;
    const store: ResearchReviewStore = {
      claim: async () => { if (!available) return null; available = false; return f.claim; },
      prepareResearch: async () => { if (scenario === "missing") throw new Error("RESEARCH_SNAPSHOT_MISSING"); return f.research; },
      reserveModel: async (_claim, request) => {
        if (scenario === "budget") throw new Error("RESEARCH_BUDGET_EXHAUSTED");
        reserved++; return { startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 1000).toISOString(), requestHash: researchRequestHash(request), callKey: "model:proposal:1" };
      },
      recordModelOutcome: async (_claim, _reservation, value) => { modelOutcome = value; },
      finalize: async (_claim, decision) => { if (scenario === "stale") return false; saved = decision; return decision.decision === "EXECUTE"; },
      recordDelivery: async (_claim, value) => { outcome = value; },
    };
    t.mock.method(globalThis, "fetch", async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/ai-context")) return Response.json(scenario === "stale-context" ? { ...f.context, requestedAt: new Date(Date.now() - 20000).toISOString() } : f.context);
      if (path.includes("ai.test")) {
        modelCalls++; assert.equal(reserved, 1);
        const body = JSON.parse(String(init?.body));
        assert.match(body.messages[0].content, /untrusted data/); assert.equal(body.max_completion_tokens, 1000);
        assert.equal(body.response_format.json_schema.strict, true); assert.equal(body.tools, undefined);
        if (scenario === "ai-error") return new Response("secret should not be logged", { status: 503 });
        const decision = { decision: scenario === "reject" ? "REJECT" : "EXECUTE", confidence: .8, reason: "supported fixture", riskFlags: ["fixture-risk"],
          evidenceRefs: scenario === "unknown-ref" ? ["invented"] : scenario === "missing-ref" ? [] : ["reports"] };
        return Response.json({ model: "fixture-model-version", choices: [{ finish_reason: "stop", message: { content: scenario === "ai-malformed" ? '{"decision":"EXECUTE"}' : JSON.stringify(decision) } }] });
      }
      assert.ok(path.includes("/execute-proposed/1")); deliveries++; assert.equal(saved?.decision, "EXECUTE");
      if (scenario === "timeout") throw new DOMException("timeout", "AbortError");
      if (scenario === "5xx") return new Response("uncertain", { status: 500 });
      if (scenario === "refused") return new Response("denied", { status: 409 });
      return Response.json(scenario === "malformed2xx" ? { ok: true } : { outcome: "SUBMITTED", order: { id: 1, status: "SUBMITTED" } });
    });
    const worker = new BoundReviewWorker({ repository: store, execution: new ExecutionApiClient("https://execution.test", 1000, "fixture"),
      researchDecider: new ResearchOpenAiDecider({ apiKey: "fake", baseUrl: "https://ai.test" }), model: "fixture", promptVersion: "pp4-research-v1" });
    assert.equal(await worker.pollOnce(), true); assert.equal(await worker.pollOnce(), false);
    const approved = ["approve", "timeout", "5xx", "malformed2xx", "refused"].includes(scenario);
    assert.equal(deliveries, approved ? 1 : 0); assert.equal(saved?.decision, scenario === "stale" ? undefined : approved ? "EXECUTE" : "REJECT");
    assert.equal(modelCalls, ["missing", "stale-context", "budget"].includes(scenario) ? 0 : 1);
    if (approved) { assert.deepEqual(saved?.riskFlags, ["fixture-risk"]); assert.deepEqual(saved?.evidenceRefs, ["reports"]);
      assert.ok(saved?.contextHash); assert.ok(modelOutcome); assert.equal(outcome, scenario === "approve" ? "SUBMITTED" : scenario === "refused" ? "REFUSED" : "UNKNOWN"); }
  });
}

test("no research configuration refuses before account, news or model calls", async () => {
  const f = reviewFixture(); let saved: BoundDecision | undefined;
  const worker = new BoundReviewWorker({ repository: { claim: async () => f.claim, finalize: async (_c, d) => { saved = d; return false; }, recordDelivery: async () => {} },
    execution: { executeBoundProposed: async () => { throw new Error("must not execute"); } },
    model: "fixture", promptVersion: "v1" });
  await worker.pollOnce(); assert.equal(saved?.reason, "RESEARCH_UNAVAILABLE");
});

test("model timeout is bounded even for an uncooperative transport and late response is audit only", async () => {
  const f=reviewFixture(); let resolve: ((r: {decision:{decision:"EXECUTE";confidence:number;reason:string;riskFlags:string[];evidenceRefs:string[]};actualModel:string;usage:null})=>void)|undefined;
  const records:string[]=[]; let deliveries=0; let saved:BoundDecision|undefined;
  const worker=new BoundReviewWorker({repository:{claim:async()=>f.claim,prepareResearch:async()=>f.research,
    reserveModel:async(_c:BoundClaim,r:ResearchModelRequest)=>({startedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+20).toISOString(),requestHash:researchRequestHash(r),callKey:"fixture"}),
    recordModelOutcome:async(_c,_r,outcome)=>{records.push(outcome.kind);},finalize:async(_c,d)=>{saved=d;return false;},recordDelivery:async()=>{}},
    execution:{getAiContext:async()=>f.context,executeBoundProposed:async()=>{deliveries++;return"UNKNOWN";}},
    researchDecider:{isConfigured:()=>true,decide:()=>new Promise(r=>{resolve=r;})},model:"fixture",promptVersion:"pp4-research-v1"});
  await worker.pollOnce(); assert.equal(saved?.decision,"REJECT"); assert.equal(deliveries,0);
  resolve!({decision:{decision:"EXECUTE",confidence:.8,reason:"late approval",riskFlags:[],evidenceRefs:["reports"]},actualModel:"fixture",usage:null});
  await new Promise(r=>setImmediate(r));assert.deepEqual(records,["UNKNOWN_OR_INVALID","LATE_RESPONSE"]);assert.equal(deliveries,0);
});
