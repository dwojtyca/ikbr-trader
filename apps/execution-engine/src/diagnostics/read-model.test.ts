import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createDiagnosticReadModel } from './read-model.js';
import type { DiagnosticQuery } from '@ikbr/shared/diagnostics';

const query:DiagnosticQuery={mode:'events',from:'2026-10-04T08:00:00.000Z',to:'2026-10-04T09:00:00.000Z',limit:20};

describe('diagnostic read model scope',()=>{
  it('does not query across accounts when account is unavailable',async()=>{
    const pool={query:async()=>{throw Error('must not query');}} as unknown as Pick<Pool,'query'>;
    const report=await createDiagnosticReadModel({pool,currentAccountId:()=>null,currentSessionId:()=>'',
      configuration:()=>({configHash:null,instruments:[]})}).read(query);
    assert.equal(report.events.length,0);
    assert.equal(report.coverage[0]?.status,'UNAVAILABLE');
  });
  it('uses account and time parameters and namespaces stable source IDs',async()=>{
    const calls:Array<{sql:string;values:unknown[]}>=[];
    const pool={query:async(sql:string,values:unknown[]=[])=>{
      calls.push({sql,values});
      if(sql.includes('AS account_proposal_mismatch'))return {rows:[{account_proposal_mismatch:false}]};
      if(sql.includes('FROM diagnostic_evaluations WHERE')) return {rows:[{source:'diagnostic_evaluations',id:'7',
        occurred_at:new Date('2026-10-04T08:30:00Z'),recorded_at:new Date('2026-10-04T08:30:01Z'),
        code:'CONFIGURED_EVALUATION',reason:'NO_SIGNAL',severity:'INFO',instrument_id:'pko_wse'}]};
      return {rows:[]};
    }} as unknown as Pick<Pool,'query'>;
    const report=await createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',
      currentSessionId:()=> 'process-fixture',configuration:()=>({configHash:null,instruments:[]})}).read(query);
    assert.equal(report.events[0]?.id,'diagnostic_evaluations:7');
    assert.equal(report.events[0]?.message,'Strategia nie wygenerowała sygnału.');
    assert.ok(calls.every(call=>call.values[0]==='paper-fixture'));
    assert.ok(calls.some(call=>call.sql.includes('occurred_at >= $2::timestamptz')));
  });
  it('does not resolve an ambiguous evaluation to the first proposal when display limit is one',async()=>{
    const pool={query:async(sql:string)=>({rows:sql.includes('AS account_proposal_mismatch')?[{account_proposal_mismatch:false}]:sql.includes('SELECT DISTINCT proposal_id')?[{proposal_id:'42'},{proposal_id:'43'}]:[]})} as unknown as Pick<Pool,'query'>;
    const report=await createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',currentSessionId:()=> 'process-fixture',
      configuration:()=>({configHash:null,instruments:[]})}).read({...query,mode:'timeline',evaluationId:'ambiguous',limit:1});
    assert.ok(report.coverage.some(row=>row.reasons.includes('AMBIGUOUS_PROPOSAL_LINK')));
  });
  it('discards projected data if account correlation changes before the response',async()=>{
    let checks=0;
    const pool={query:async(sql:string)=>({rows:sql.includes('AS account_proposal_mismatch')?[{account_proposal_mismatch:++checks>1}]:
      sql.includes('FROM diagnostic_evaluations WHERE')?[{source:'diagnostic_evaluations',id:'7',occurred_at:query.from,recorded_at:query.from,
        code:'CONFIGURED_EVALUATION',reason:'NO_SIGNAL',severity:'INFO',instrument_id:'private-instrument'}]:[]})} as unknown as Pick<Pool,'query'>;
    const report=await createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',currentSessionId:()=> 'process-fixture',
      configuration:()=>({configHash:null,instruments:[]})}).read(query);
    assert.equal(checks,2);assert.equal(report.events.length,0);assert.equal(report.counters.length,0);
    assert.ok(report.coverage.some(row=>row.reasons.includes('ACCOUNT_PROPOSAL_MISMATCH')));
    assert.doesNotMatch(JSON.stringify(report),/private-instrument/);
  });
  it('reports an unavailable identity check without leaking database errors or inventing zero counts',async()=>{
    const pool={query:async()=>{throw Error('private database credential');}} as unknown as Pick<Pool,'query'>;
    const report=await createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',currentSessionId:()=> 'process-fixture',
      configuration:()=>({configHash:null,instruments:[]})}).read(query);
    assert.equal(report.counters.length,0);
    assert.equal(report.coverage[0].status,'UNAVAILABLE');
    assert.deepEqual(report.coverage[0].reasons,['ACCOUNT_IDENTITY_CHECK_UNAVAILABLE']);
    assert.doesNotMatch(JSON.stringify(report),/private database credential/);
  });
});
