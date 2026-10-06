import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { checkPaperEntryBudget } from './paper-entry-budget.js';
import { paperPolicyFixture } from './paper-run-policy.fixture.js';

test('Warsaw effective dates compare as civil dates across both DST changes', async () => {
  const previous=process.env.TZ;process.env.TZ='Europe/Warsaw';
  try {
    for(const [prior,effective] of [['2026-03-28','2026-03-29'],['2026-10-24','2026-10-25']]) {
      for(const day of [prior,effective]) {
        const start=`${day}T14:00:00Z`,end=`${day}T14:30:00Z`,now=new Date(`${day}T14:10:00Z`);
        const f=paperPolicyFixture(start,end),w=f.policy.windows[0];
        const db={query:async(sql:string)=>{
          if(sql.includes('AS adopted'))return{rows:[{now,adopted:true,held:false}]};
          if(sql.includes('FROM paper_policy_authorities')) {
            assert.match(sql,/effective_date::text AS effective_day/);
            return{rows:[{active_run_id:f.policy.runId,manifest_hash:f.policy.manifestHash,pending_run_id:'next',effective_day:effective,effective_date:new Date(`${effective}T00:00:00`)}]};
          }
          if(sql.includes('clock_timestamp()'))return{rows:[{now}]};
          return{rows:[]};
        }} as unknown as Pick<Pool,'query'>;
        const result=await checkPaperEntryBudget(db,f.policy,f.policy.accountId,{instrumentId:w.instrumentId,instrument:w.instrument,conid:String(w.conId)},{},async()=>({ok:true,generation:1,endsAtMs:Date.parse(end)}));
        if(day===prior)assert.equal(result.ok,true);
        else assert.deepEqual(result,{ok:false,reason:'paper_budget_policy_authority_mismatch'});
      }
    }
  } finally {if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
