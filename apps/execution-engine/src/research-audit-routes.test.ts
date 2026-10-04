import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import type { ResearchStore } from '@ikbr/shared/instrument-research';
import { registerResearchAuditRoute } from './research-audit-routes.js';
import { registerExecutionAuth, AuthFailureBurstTracker } from './auth.js';

test('authenticated historical research audit returns pinned evidence without current eligibility or new calls',async()=>{
 const app=Fastify();let reads=0;
 registerExecutionAuth(app,{token:'fixture-token',publicPaths:new Set(),writeAudit:()=>{},burstTracker:new AuthFailureBurstTracker(()=>{}),logger:{warn:()=>{}}});
 const binding={snapshotId:'historical'},snapshot={id:'historical',snapshot:{evidence:[{ref:'annual',url:'https://www.sec.gov/fixture'}]}};
 const row={id:1,status:'APPROVED',expires_at:'old-time',decision_json:{riskFlags:['historical'],evidenceRefs:['annual']},risk_evidence:{},request_hash:'hash',request_json:{context:{research:{stored:snapshot}}},started_at:'old-time',deadline_at:'old-time',outcome_json:{kind:'COMPLETED'},received_at:'old-time'};
 registerResearchAuditRoute(app,{pool:{query:async()=>{reads++;return {rows:[row]};}} as unknown as Pool,
  store:{getBinding:async()=>binding,readSnapshot:async()=>snapshot} as unknown as Pick<ResearchStore,'getBinding'|'readSnapshot'>});
 assert.equal((await app.inject({url:'/execution/orders/1/research'})).statusCode,401);assert.equal(reads,0);
 const response=await app.inject({url:'/execution/orders/1/research',headers:{authorization:'Bearer fixture-token'}});
 assert.equal(response.statusCode,200);assert.deepEqual(response.json().snapshot,snapshot);assert.deepEqual(response.json().review.decision.riskFlags,['historical']);
 assert.equal(response.json().modelCall.requestHash,'hash');await app.close();
});
