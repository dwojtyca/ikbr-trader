import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations } from '../migrations.js';
import { createDiagnosticReadModel } from './read-model.js';
import { DiagnosticStore, boundDiagnosticReport, parseDiagnosticReport } from '@ikbr/shared/diagnostics';

const url=process.env.TEST_POSTGRES_URL;
const suite=url?describe:describe.skip;

suite('diagnostic read queries against production schema',()=>{
  it('reads empty evidence without source SQL errors or fabricated account facts',async()=>{
    const dbName=`pp6_read_${randomUUID().replaceAll('-','')}`;
    const adminUrl=new URL(url!);adminUrl.pathname='/postgres';
    const admin=new Pool({connectionString:adminUrl.toString()});
    await admin.query(`CREATE DATABASE ${dbName}`);
    const dbUrl=new URL(url!);dbUrl.pathname=`/${dbName}`;
    const pool=new Pool({connectionString:dbUrl.toString()});
    try{
      await runMigrations(pool);
      const report=await createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',
        currentSessionId:()=> 'process-fixture',configuration:()=>({configHash:null,instruments:[]})})
        .read({mode:'events',from:'2026-10-04T08:00:00.000Z',to:'2026-10-04T09:00:00.000Z',limit:20});
      assert.ok(report.coverage.filter(row=>!['scheduler','diagnostic_retention','proposal_transitions'].includes(row.source))
        .every(row=>row.status!=='UNAVAILABLE'),
        JSON.stringify(report.coverage));
      assert.ok(report.coverage.some(row=>row.source==='diagnostic_retention'&&row.status==='UNAVAILABLE'));
      assert.equal(report.events.length,0);
      const store=new DiagnosticStore(pool);
      const second=new Date(),first=new Date(second.getTime()-15000),processId='fixture-process';
      const firstCycle=randomUUID();
      for(const [index,stamp] of [first,second].entries()) await store.recordEvaluation({accountId:'paper-fixture',processId,
        cycleId:index===0?firstCycle:randomUUID(),instrumentId:'pko_wse',occurredAt:stamp,outcome:'CONFIGURED_EVALUATION',reason:'NO_SIGNAL',revision:2});
      await store.heartbeat({accountId:'paper-fixture',processId,startedAt:first,
        seenAt:second,expectedIntervalMs:5000,enabled:true});
      const observed=await createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',
        currentSessionId:()=> processId,configuration:()=>({configHash:null,instruments:[{id:'pko_wse',symbol:'PKO',
          listing:'WSE',conId:'123',implementationId:null,instanceId:null,revision:null}]})})
        .read({mode:'events',from:new Date(first.getTime()-1000).toISOString(),to:new Date(second.getTime()+1000).toISOString(),limit:20});
      assert.ok(observed.coverage.some(row=>row.reasons.some(reason=>reason.startsWith('SCHEDULED_INTERVAL_GAP'))));
      const trace=await createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',
        currentSessionId:()=> processId,configuration:()=>({configHash:null,instruments:[]})})
        .read({mode:'timeline',evaluationId:firstCycle,instrumentId:'pko_wse',from:'2026-09-01T08:00:00.000Z',to:'2026-09-01T09:00:00.000Z',limit:20});
      assert.ok(trace.events.some(row=>row.evaluationId===firstCycle));
      assert.equal(parseDiagnosticReport(boundDiagnosticReport(trace)).events[0].revision,2);
      assert.ok(trace.coverage.filter(row=>row.source!=='proposal_link').every(row=>row.reasons[0]!=='SOURCE_READ_FAILED'),
        JSON.stringify(trace.coverage));
      const foreign=(await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,side,order_type,quantity,entry,reason,confidence,risk_check_status,status,execution_account_id)
        VALUES('FOREIGN_SENTINEL','foreign_instrument','BUY','LMT',1,100,'fixture',1,'PASS','FILLED','foreign-account') RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO broker_execution_fills(exec_id,proposed_order_id,account_id,executed_at,conid,side,shares,price)
        VALUES('own-wrong-link',$1,'paper-fixture',clock_timestamp(),'123','BUY',1,100),
          ('own-unattributed',NULL,'paper-fixture',clock_timestamp(),'456','BUY',1,100)`,[foreign]);
      await pool.query(`INSERT INTO broker_order_links(proposed_order_id,account_id,role,order_ref)
        VALUES($1,'paper-fixture','PARENT','own-wrong-ref')`,[foreign]);
      const model=createDiagnosticReadModel({pool,currentAccountId:()=> 'paper-fixture',currentSessionId:()=> processId,
        configuration:()=>({configHash:null,instruments:[]})});
      const interval={from:new Date(first.getTime()-1000).toISOString(),to:new Date(Date.now()+1000).toISOString(),limit:100};
      for(const mode of ['events','status','timeline'] as const){
        const refused=await model.read({...interval,mode,...(mode==='timeline'?{proposalId:String(foreign)}:{})});
        assert.equal(refused.events.length,0);assert.equal(refused.counters.length,0);
        assert.ok(refused.coverage.some(row=>row.status==='UNAVAILABLE'&&row.reasons.includes('ACCOUNT_PROPOSAL_MISMATCH')));
        assert.doesNotMatch(JSON.stringify(refused),/FOREIGN_SENTINEL|foreign_instrument|foreign-account|execution\/lifecycle\//);
      }
      await pool.query("DELETE FROM broker_order_links WHERE order_ref='own-wrong-ref'");
      await pool.query("DELETE FROM broker_execution_fills WHERE exec_id='own-wrong-link'");
      const intact=await model.read({...interval,mode:'events'});
      assert.ok(intact.events.some(row=>row.id==='broker_execution_fills:own-unattributed'&&row.proposalId===null));
      assert.ok(intact.events.some(row=>row.evaluationId===firstCycle));
      const fault=(await pool.query(`INSERT INTO lifecycle_faults(account_id,original_proposal_id,code)
        VALUES('foreign-account',$1,'FOREIGN_FAULT') RETURNING id`,[foreign])).rows[0].id;
      await pool.query(`INSERT INTO lifecycle_alert_outbox(account_id,fault_id) VALUES('paper-fixture',$1)`,[fault]);
      const deliveryConflict=await model.read({...interval,mode:'events'});
      assert.equal(deliveryConflict.events.length,0);
      assert.ok(deliveryConflict.coverage.some(row=>row.reasons.includes('ACCOUNT_PROPOSAL_MISMATCH')));
      assert.doesNotMatch(JSON.stringify(deliveryConflict),/FOREIGN_SENTINEL|FOREIGN_FAULT|foreign-account|foreign_instrument/);
    }finally{
      await pool.end();
      await admin.query(`DROP DATABASE ${dbName}`);
      await admin.end();
    }
  });
});
