import { test } from "node:test";
import assert from "node:assert/strict";
import { BoundReviewWorker } from "./bound-review-worker.js";
import type { BoundClaim, BoundDecision } from "./bound-review-repository.js";
for (const items of [[], [{headline:"Unverified PKO listing news",summary:"Company results"}]]) {
  test(`PKO coverage excludes symbol-only news (${items.length} item) and marks missing research`, async () => {
    const claim: BoundClaim = { order: {id:1,instrument:"PKO",conid:"35146360",side:"BUY",orderType:"LMT",quantity:1,
      entry:80,stop:79,takeProfit:82,confidence:.8,reason:"test",strategy:"momentum_breakout_long_v1",riskCheckStatus:"PASS",
      status:"PROPOSED",timestamp:new Date().toISOString(),createdAt:new Date()},
      identity:{instrumentId:"pko_wse",conid:"35146360",accountId:"DU_TEST",sessionId:"session",clientOrderHash:"test"},token:"test"};
    let saved: BoundDecision | undefined;
    const worker = new BoundReviewWorker({ repository: {claim:async()=>claim,finalize:async(_c,d)=>{saved=d;return false;},recordDelivery:async()=>{}},
      execution:{getAccountSummary:async()=>({source:"live",accountId:"DU_TEST",retrievedAt:new Date().toISOString(),positions:[],
        totals:{positionsCount:0,grossExposure:0,netExposure:0,unrealizedPnL:0,realizedPnL:0}}),executeBoundProposed:async()=>{throw new Error("unexpected");}},
      news:{isConfigured:()=>true,getNewsForSymbol:async()=>items},
      decider:{isConfigured:()=>true,decide:async c=>{assert.deepEqual(c.news,[]);return {decision:"REJECT",confidence:.2,reason:"insufficient context",riskFlags:[]};}},
      model:"fixture",promptVersion:"v1",newsWindowHours:24,maxNewsItems:3 });
    await worker.pollOnce();
    const context = saved!.context as {coverage:Record<string,string>;instrument:{currency:string};news:{unverifiedItemsCount:number}};
    assert.equal(context.instrument.currency,"PLN");
    assert.equal(context.coverage.instrumentMatchedNews,items.length?"UNVERIFIED_IDENTITY":"EMPTY");
    for (const key of ["financialStatements","earnings","macro","broaderMarketTrends"]) assert.equal(context.coverage[key],"UNAVAILABLE");
    assert.equal(context.news.unverifiedItemsCount,items.length);
  });
}
