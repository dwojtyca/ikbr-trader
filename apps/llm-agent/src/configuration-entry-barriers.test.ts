import test from "node:test";
import assert from "node:assert/strict";
import { TradingConfigurationRuntime, TradingConfigurationStore, type TradingConfigurationAdmissionState } from "@ikbr/shared/trading-config";
import { BoundReviewWorker } from "./bound-review-worker.js";
import { createLegacyReviewWorker } from "./legacy-review-worker.js";
import type { BoundClaim } from "./bound-review-repository.js";
import { reviewFixture } from "./research-review.testfixture.js";
import { researchRequestHash } from "./research-decision.js";
import type { AccountSummary } from "./execution-api-client.js";

const claim: BoundClaim = {
  order: { id: 9, instrument: "QZXP", conid: "42", side: "BUY", orderType: "LMT", quantity: 1,
    entry: 100, stop: 99, takeProfit: 102, confidence: 0.7, reason: "fixture", strategy: "test",
    riskCheckStatus: "PASS", status: "PROPOSED", timestamp: new Date().toISOString(), createdAt: new Date() },
  identity: { clientOrderHash: "hash", instrumentId: "xyz_nyse", conid: "42", accountId: "DU_TEST", sessionId: "session" }, token: "test-claim",
};
const account: AccountSummary = { accountId: "DU_TEST", source: "live", retrievedAt: new Date().toISOString(), positions: [],
  metrics: {}, totals: { positionsCount: 0, grossExposure: 0, netExposure: 0, unrealizedPnL: 0, realizedPnL: 0 } };

async function admission(initial: "allowed" | "prepare" | "latched" | "drift" | "db-failure") {
  let state = initial;
  class Store extends TradingConfigurationStore {
    override async register() { return { preparationPending: false, managementAuthority: null, ownership: [], legacySourceHash: null }; }
    override async readAdmissionState(): Promise<TradingConfigurationAdmissionState> {
      if (state === "db-failure") throw new Error("fixture DB outage");
      const now = Date.now();
      return { latched: state === "latched", nowMs: now, observations: state === "drift" ? [{ service: "ingestion", processId: "peer", mode: "bundle",
        schemaVersion: 1, canonicalVersion: 1, effectiveHash: "a".repeat(64), migrationPrepared: false, legacySourceHash: null,
        observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString() }] : [] };
    }
  }
  const store = new Store({ query: async () => { throw new Error("unexpected SQL"); }, connect: async () => { throw new Error("unexpected SQL"); } });
  const runtime = new TradingConfigurationRuntime({ service: "llm-agent", store, loaded: { mode: "legacy", migrationPrepare: initial === "prepare", diagnostics: [] }, tradingEnabled: false });
  await runtime.initialize();
  return { check: () => runtime.assertEntryAllowed(), pause: () => { state = "latched"; } };
}

for (const pauseAt of ["prepare", "latched", "drift", "db-failure", "claim", "account", "research", "reservation", "model", "finalize", "allowed"] as const) {
 test(`bound actual worker configuration barrier: ${pauseAt}`,async()=>{
  const gate=await admission(["prepare","latched","drift","db-failure"].includes(pauseAt)?pauseAt as "prepare"|"latched"|"drift"|"db-failure":"allowed");
  const f=reviewFixture(),calls:string[]=[];const hit=(step:string)=>{calls.push(step);if(step===pauseAt)gate.pause();};
  const worker=new BoundReviewWorker({assertEntryAllowed:gate.check,
   repository:{claim:async()=>{hit("claim");return f.claim;},prepareResearch:async()=>{hit("research");return f.research;},
    reserveModel:async(_c,r)=>{hit("reservation");return{startedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+10000).toISOString(),requestHash:researchRequestHash(r),callKey:"fixture"};},
    recordModelOutcome:async()=>{},finalize:async(_c,d)=>{hit("finalize");return d.decision==="EXECUTE";},recordDelivery:async()=>{hit("record");}},
   execution:{getAiContext:async()=>{hit("account");return f.context;},executeBoundProposed:async()=>{hit("delivery");return"SUBMITTED";}},
   researchDecider:{isConfigured:()=>true,decide:async()=>{hit("model");return{decision:{decision:"EXECUTE",confidence:.8,reason:"fixture",riskFlags:[],evidenceRefs:["reports"]},actualModel:"fixture",usage:null};}},model:"fixture",promptVersion:"pp4-research-v1"});
  if(pauseAt==="allowed"){await worker.pollOnce();assert.deepEqual(calls,["claim","research","account","reservation","model","finalize","delivery","record"]);}
  else{await assert.rejects(worker.pollOnce());assert.equal(calls.includes("delivery"),false);assert.equal(calls.includes("record"),false);
   if(["prepare","latched","drift","db-failure"].includes(pauseAt))assert.deepEqual(calls,[]);
   if(pauseAt==="reservation")assert.equal(calls.includes("model"),false);
  }
 });
}

for (const pauseAt of ["prepare", "latched", "drift", "db-failure", "claim", "account", "news", "model", "decision", "cooldown", "allowed"] as const) {
  test(`legacy actual worker configuration barrier: ${pauseAt}`, async () => {
    const gate = await admission(["prepare", "latched", "drift", "db-failure"].includes(pauseAt) ? pauseAt as "prepare" | "latched" | "drift" | "db-failure" : "allowed");
    const calls: string[] = [];
    const hit = (step: string) => { calls.push(step); if (step === pauseAt) gate.pause(); };
    const worker = createLegacyReviewWorker({ assertEntryAllowed: gate.check, workerId: "fixture", log: () => {},
      config: { LLM_AGENT_PROMPT_VERSION: "fixture", LLM_AGENT_MODEL: "fixture", LLM_AGENT_SYMBOL_COOLDOWN_MS: 1,
        LLM_AGENT_NEWS_WINDOW_HOURS: 1, LLM_AGENT_MAX_NEWS_ITEMS: 1, LLM_AGENT_CLAIM_STALE_MS: 1, llmAgentFailClosed: true },
      repo: { claimNextProposed: async () => { hit("claim"); return claim.order; }, releaseClaim: async () => { calls.push("release"); },
        isSymbolInCooldown: async () => { hit("cooldown"); return pauseAt === "cooldown"; }, deleteProposedOrderIfPending: async () => { hit("delete"); return true; },
        insertDecision: async () => { hit("decision"); return 1; }, updateDecisionError: async () => { hit("error"); } },
      executionApi: { getAccountSummary: async () => { hit("account"); return account; }, executeProposed: async () => { hit("delivery"); }, rejectProposed: async () => { hit("reject"); } },
      marketaux: { isConfigured: () => true, getNewsForSymbol: async () => { hit("news"); return []; } },
      decider: { isConfigured: () => true, decide: async () => { hit("model"); return { decision: "EXECUTE", reason: "fixture", confidence: .8, riskFlags: [] }; } } });
    if (pauseAt === "allowed") { await worker.pollOnce(); assert.equal(calls.filter(x => x === "delivery").length, 1); }
    else { await assert.rejects(worker.pollOnce(), /CONFIGURATION_ENTRY_PAUSED/);
      assert.equal(calls.includes("delivery"), false); assert.equal(calls.includes("reject"), false); assert.equal(calls.includes("delete"), false);
      if (["prepare", "latched", "drift", "db-failure"].includes(pauseAt)) assert.deepEqual(calls, []);
      else { assert.equal(calls.at(-1), "release"); assert.equal(calls.at(-2), pauseAt); }
    }
  });
}
