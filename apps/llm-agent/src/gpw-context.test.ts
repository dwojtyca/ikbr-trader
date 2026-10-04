import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewFixture } from "./research-review.testfixture.js";
import { buildResearchModelRequest } from "./research-decision.js";
for(const id of ["pko_wse","aapl_smart","xyz_nyse"])test(`configured issuer and order context: ${id}`,()=>{
 const f=reviewFixture(Date.now(),id);const request=buildResearchModelRequest(f.claim,f.research,f.context);
 assert.equal(request.context.research.eligibility.eligible,true);
 assert.equal(request.context.research.manifest.instruments.find(p=>p.instrumentId===id)?.issuerId,f.policy.issuerId);
 assert.equal(request.context.orderContext.valuation.quoteCurrency,f.policy.listing.currency);
 assert.equal(request.context.orderContext.fees.estimateStatus,"UNAVAILABLE");
 assert.deepEqual(request.context.identity.strategyAttribution,f.claim.order.strategyAttribution);
 if(f.policy.profile==="bank")assert.ok(f.snapshot.facts.some(x=>x.metric==="tier1_ratio"));
});
