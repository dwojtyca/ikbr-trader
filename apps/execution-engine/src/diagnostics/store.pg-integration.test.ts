import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { DiagnosticStore } from '@ikbr/shared/diagnostics';

const url=process.env.TEST_POSTGRES_URL;
const suite=url?describe:describe.skip;

suite('diagnostic append store',()=>{
  it('persists deduplicated evaluations and an outage recovery gap in isolated PostgreSQL',async()=>{
    const schema=`pp6_diag_${randomUUID().replaceAll('-','')}`;
    const admin=new Pool({connectionString:url});
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
    try {
      const sql=await readFile(new URL('../../../../infra/sql/migrations/000025_operator_diagnostics.sql',import.meta.url),'utf8');
      await pool.query(sql);
      const store=new DiagnosticStore(pool);
      const now=new Date();
      const cycleId=randomUUID();
      const input={accountId:'paper-fixture',processId:'process-fixture',cycleId,instrumentId:'pko_wse',
        occurredAt:now,outcome:'CONFIGURED_EVALUATION',reason:'NO_SIGNAL',configHash:'a'.repeat(64),
        reasons:['RSI_TOO_HIGH'],entryBlockers:['PP4_RESEARCH_UNAVAILABLE'],
        assignedInstances:[{implementationId:'momentum_breakout_long_v1',instanceId:'pko_momo',revision:1}]};
      const first=await store.recordEvaluation(input);
      const duplicate=await store.recordEvaluation(input);
      assert.equal(duplicate?.id,first?.id);
      const result=await pool.query('SELECT count(*)::int AS n FROM diagnostic_evaluations');
      assert.equal(result.rows[0].n,1);
      const persisted=await pool.query('SELECT reasons,entry_blockers,assigned_instances FROM diagnostic_evaluations');
      assert.deepEqual(persisted.rows[0].reasons,['RSI_TOO_HIGH']);
      assert.deepEqual(persisted.rows[0].entry_blockers,['PP4_RESEARCH_UNAVAILABLE']);
      assert.equal(persisted.rows[0].assigned_instances[0].instanceId,'pko_momo');
      const oldId=randomUUID();
      await store.recordEvaluation({...input,cycleId:oldId,occurredAt:new Date(now.getTime()-32*86400000)});
      await pool.query("UPDATE diagnostic_evaluations SET recorded_at=clock_timestamp()-interval '32 days' WHERE cycle_id=$1::uuid",[oldId]);
      await store.recordEvaluation({...input,cycleId:randomUUID()});
      const retention=await pool.query('SELECT pruned_count,pruned_through_at FROM diagnostic_retention WHERE account_id=$1',['paper-fixture']);
      assert.ok(Number(retention.rows[0].pruned_count)>=1);
      assert.ok(retention.rows[0].pruned_through_at);
      await store.heartbeat({accountId:'paper-fixture',processId:'process-fixture',startedAt:new Date(now.getTime()-1000),
        seenAt:now,expectedIntervalMs:5000,enabled:true,failedSince:new Date(now.getTime()-500),failureCount:1});
      const gaps=await pool.query('SELECT kind,from_at,to_at FROM diagnostic_coverage_gaps');
      assert.equal(gaps.rows.length,1);
      assert.equal(gaps.rows[0].kind,'SINK_FAILURE');
      assert.equal((await pool.query('SELECT failure_count FROM diagnostic_process_heartbeats')).rows[0].failure_count,'1');
    }finally{
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
