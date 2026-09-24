import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations } from '../migrations.js';
import { ReconciliationRepository } from './repository.js';
import { loadDurableReadiness } from './durable-readiness.js';
const url=process.env.TEST_POSTGRES_URL;
test('PG latest durable result advances readiness; failed/running/foreign rows never borrow older CLEAN', {skip:!url},async()=>{
 const connection=new URL(url!);connection.pathname='/postgres';const admin=new Pool({connectionString:connection.toString()});const name='ready_'+randomUUID().replaceAll('-','');
 await admin.query(`CREATE DATABASE ${name}`);connection.pathname='/'+name;const pool=new Pool({connectionString:connection.toString()});
 try{
  await runMigrations(pool);const repo=new ReconciliationRepository(pool);
  const cov={positions:{available:true,boundedWindow:true},openOrders:{available:true,boundedWindow:true},session:{available:true},completedOrders:{available:true,boundedWindow:true},executions:{available:true,window:{exposureWindowComplete:true,recoveryWindowComplete:true}}};
  const insert=async(status:string,session:string,time:string)=>pool.query(`INSERT INTO reconciliation_runs(account_id,session_id,status,started_at,completed_at,source_coverage) VALUES('PAPER-TEST',$1,$2,$3,$3,$4)`,[session,status,time,JSON.stringify(cov)]);
  const get=()=>loadDurableReadiness({repository:repo,current:()=>({accountId:'PAPER-TEST',generation:1,connected:true}),sessionId:'current',now:()=>new Date('2026-09-24T12:00:00Z')});
  await insert('CLEAN','current','2026-09-24T11:00:00Z');await insert('CLEAN','current','2026-09-24T11:59:00Z');
  assert.equal((await get()).lastReconciliationAt?.toISOString(),'2026-09-24T11:59:00.000Z');
  await insert('FAILED','current','2026-09-24T11:59:10Z');assert.equal((await get()).reconciliationRunHealth.kind,'failed');
  await insert('RUNNING','current','2026-09-24T11:59:20Z');assert.equal((await get()).reconciliationRunHealth.kind,'running');
  await pool.query("UPDATE reconciliation_runs SET status='ABANDONED' WHERE status='RUNNING'");
  await insert('CLEAN','foreign','2026-09-24T11:59:30Z');assert.equal((await get()).reconciliationRunHealth.kind,'wrong_session');
 }finally{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();}
});
