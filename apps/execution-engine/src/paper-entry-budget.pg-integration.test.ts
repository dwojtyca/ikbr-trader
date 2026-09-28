import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { canonicalizeTradingConfiguration } from '@ikbr/shared/trading-config';
import { runMigrations, resolveMigrationsDir } from './migrations.js';
import { adoptPaperEntryBudget, bindPaperProposal, checkPaperEntryBudget, readPaperRoundTripWindow, reservePaperEntryAttempt } from './paper-entry-budget.js';
import { paperPolicyFixture } from './paper-run-policy.fixture.js';
import type { SessionEntryGuard } from './session-entry-guard.js';
import { parsePaperRunPolicy } from './paper-run-policy.js';
const url = process.env.TEST_POSTGRES_URL;
const skip = !url;
const session: SessionEntryGuard = async (_db, _order, window) => ({ ok: true, generation: 1, endsAtMs: Date.parse(window!.endsAt) });
async function fixture(body: (pool: Pool) => Promise<void>, beforeMigration?: (pool: Pool) => Promise<void>) {
  const name = `pp3_budget_${randomUUID().replaceAll('-', '')}`, target = new URL(url!); target.pathname = '/postgres';
  const admin = new Pool({ connectionString: target.toString() }); await admin.query(`CREATE DATABASE ${name}`); target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.toString() });
  try {
    if (beforeMigration) {
      const dir = resolveMigrationsDir();
      for (const file of readdirSync(dir).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
        if (file.startsWith('000019')) await beforeMigration(pool);
        await pool.query(readFileSync(`${dir}/${file}`, 'utf8'));
      }
    } else await runMigrations(pool);
    await body(pool);
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function proposal(pool: Pool, conid='987654', instrument='QZXP', account: string | null=null, at: string | null=null, effect='OPEN_OR_ADD') {
  const row = (await pool.query(`INSERT INTO proposed_orders(instrument,conid,side,position_effect,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,execution_account_id,execution_attempted_at)
    VALUES($1,$2,'BUY',$5,'LMT',1,100,99,105,'fixture',0.8,'PASS',$3,$4) RETURNING id`, [instrument,conid,account,at,effect])).rows[0];
  return Number(row.id);
}
async function configured(pool: Pool) {
  const now = (await pool.query('SELECT clock_timestamp() now')).rows[0].now.getTime();
  const f = paperPolicyFixture(new Date(now-60000).toISOString(), new Date(now+60000).toISOString());
  await pool.query('INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)', [f.loaded.effectiveHash, canonicalizeTradingConfiguration(f.loaded.configuration)]);
  await transaction(pool, async client => { assert.deepEqual(await adoptPaperEntryBudget(client,f.policy,{tradingEnabled:false}),{ok:true}); });
  const order = { id: await proposal(pool), instrumentId: 'xyz_nyse', instrument: 'QZXP', conid: '987654', positionEffect: 'OPEN_OR_ADD' };
  await transaction(pool, client => bindPaperProposal(client,f.policy,order.id,order));
  return { ...f, order };
}

test('migration imports consumed and attempted legacy once, keeps original charged NY date and close is excluded', {skip}, () => fixture(async pool => {
  const rows = await pool.query('SELECT *,account_date::text account_day,session_date::text session_day FROM paper_entry_attempts'); assert.equal(rows.rowCount,1);
  assert.equal(rows.rows[0].account_day,'2026-09-29');
  assert.equal(rows.rows[0].session_day,'2026-09-28');
  const debts = await pool.query('SELECT *,charged_date::text charged_day FROM paper_entry_legacy_day_debts'); assert.equal(debts.rowCount,1);
  assert.equal(debts.rows[0].charged_day,'2026-09-28');
  await pool.query('SELECT import_paper_entry_legacy()'); assert.equal((await pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_migration_holds')).rows[0].count,'0');
  await assert.rejects(pool.query('DELETE FROM paper_entry_attempts'),/IMMUTABLE/);
  await assert.rejects(pool.query('UPDATE paper_entry_attempts SET conid=\'1\''),/IMMUTABLE/);
  await assert.rejects(pool.query('TRUNCATE paper_entry_attempts'),/IMMUTABLE/);
}, async pool => {
  const id=await proposal(pool,'265598','AAPL','DU_LEGACY','2026-09-28T22:01:00.050Z');
  await pool.query(`INSERT INTO aapl_windows(run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
    VALUES('legacy','DU_LEGACY','2026-09-28','2026-09-28T22:00:00Z','2026-09-28T22:30:00Z',$1,'2026-09-28T22:01:00Z')`,[id]);
  await proposal(pool,'1','CLOSE','DU_LEGACY','2026-09-28T22:02:00Z','CLOSE_OR_REDUCE');
}));

test('migration holds missing/contradictory accounts globally and missing contract or timezone by account', {skip}, () => fixture(async pool => {
  const holds=(await pool.query('SELECT * FROM paper_entry_migration_holds ORDER BY evidence_key')).rows;
  assert.equal(holds.length,4); assert.equal(holds.filter(h=>h.account_id===null).length,2);
  assert.ok(holds.some(h=>h.account_id==='DU_CONTRACT' && h.reason.includes('CONTRACT')));
  assert.ok(holds.some(h=>h.account_id==='DU_ZONE' && h.reason.includes('TIMEZONE')));
}, async pool => {
  await proposal(pool,'111','UNKNOWN',null,'2026-09-28T14:00:00Z');
  await proposal(pool,'111','UNKNOWN','DU_ZONE','2026-09-28T14:00:00Z');
  const conflict=await proposal(pool,'265598','AAPL','DU_ONE','2026-09-28T14:00:00Z');
  const contract=await proposal(pool,'999','AAPL','DU_CONTRACT','2026-09-28T14:00:00Z');
  for (const [id,account,run] of [[conflict,'DU_TWO','conflict'],[contract,'DU_CONTRACT','contract']]) await pool.query(`INSERT INTO aapl_windows(run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
    VALUES($1,$2,'2026-09-28','2026-09-28T13:55:00Z','2026-09-28T14:30:00Z',$3,'2026-09-28T14:00:00Z')`,[run,account,id]);
}));

test('adoption commits newly discovered hold without latching and rejects enabled-write adoption', {skip}, () => fixture(async pool => {
  const f=paperPolicyFixture(); await proposal(pool,'999','OLD',f.policy.accountId,'2026-09-28T14:00:00Z');
  await transaction(pool, async client => {
    await assert.rejects(adoptPaperEntryBudget(client,f.policy,{tradingEnabled:true}),/DISABLED_WRITES/);
    assert.deepEqual(await adoptPaperEntryBudget(client,f.policy,{tradingEnabled:false}),{ok:false,reason:'PAPER_BUDGET_MIGRATION_HOLD'});
  });
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_migration_holds')).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_budget_adoptions')).rows[0].count,'0');
}));

test('two contracts race under account lock: one durable attempt, replay/restart and new run cannot refund it', {skip}, () => fixture(async pool => {
  const f=await configured(pool);
  const second={id:await proposal(pool,'265598','AAPL'),instrumentId:'aapl_smart',instrument:'AAPL',conid:'265598',positionEffect:'OPEN_OR_ADD'};
  await transaction(pool,client=>bindPaperProposal(client,f.policy,second.id,second));
  const results=await Promise.all([f.order,second].map(order=>transaction(pool,client=>reservePaperEntryAttempt(client,f.policy,f.policy.accountId,order,session))));
  assert.equal(results.filter(r=>r.ok).length,1); assert.equal(results.filter(r=>!r.ok && r.reason==='paper_budget_consumed').length,1);
  const winner=results[0].ok?f.order:second;
  const report=await readPaperRoundTripWindow(pool,winner.id);assert.equal(report?.attemptId,String(winner.id));assert.equal(report?.source,'paper');assert.equal(report?.runPolicyHash,f.policy.manifestHash);assert.match(report!.accountDate,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await checkPaperEntryBudget(pool,f.policy,f.policy.accountId,winner,{proposalId:winner.id,dispatch:true},session)).ok,true);
  assert.deepEqual(await transaction(pool,client=>reservePaperEntryAttempt(client,f.policy,f.policy.accountId,winner,session)),{ok:false,reason:'paper_budget_consumed'});
  await pool.query("UPDATE proposed_orders SET execution_attempted_at=(SELECT attempted_at FROM paper_entry_attempts WHERE proposed_order_id=$1),execution_account_id=$2 WHERE id=$1",[winner.id,f.policy.accountId]);
  await assert.rejects(pool.query('UPDATE proposed_orders SET execution_attempted_at=NULL WHERE id=$1',[winner.id]),/IMMUTABLE/);
  const next=parsePaperRunPolicy({...f.env,PAPER_RUN_POLICY_JSON:{...f.manifest,runId:'next_run'}},f.loaded)!;
  assert.deepEqual(await checkPaperEntryBudget(pool,next,next.accountId,f.order,{},session),{ok:false,reason:'paper_budget_consumed'});
  await transaction(pool,async client=>{assert.deepEqual(await adoptPaperEntryBudget(client,f.policy,{tradingEnabled:false}),{ok:true});});
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'1');
}));

test('adopted account refuses stale unbound marker and legacy window writers; other account remains compatible', {skip}, () => fixture(async pool => {
  const f=await configured(pool), id=await proposal(pool);
  await assert.rejects(pool.query('UPDATE proposed_orders SET execution_attempted_at=clock_timestamp(),execution_account_id=$2 WHERE id=$1',[id,f.policy.accountId]),/LEGACY_WRITER_DISABLED/);
  await assert.rejects(proposal(pool,'444','OLD',f.policy.accountId,new Date().toISOString()),/LEGACY_WRITER_DISABLED/);
  await assert.rejects(pool.query(`INSERT INTO aapl_windows(run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
    VALUES('stale',$1,CURRENT_DATE,clock_timestamp(),clock_timestamp()+interval '1 minute',$2,clock_timestamp())`,[f.policy.accountId,id]),/LEGACY_WRITER_DISABLED/);
  const other=await proposal(pool,'444','OLD','DU_OTHER',new Date().toISOString());assert.ok(other);
}));

test('run hash reuse, window expiry and session failure deny without consumption; exit margin is checked', {skip}, () => fixture(async pool => {
  const f=await configured(pool);
  let observedWindow: {startsAt:string;endsAt:string}|undefined;
  const guard:SessionEntryGuard=async (_db,_order,w)=>{observedWindow=w;return {ok:false,reason:'session_window_invalid'};};
  assert.deepEqual(await transaction(pool,client=>reservePaperEntryAttempt(client,f.policy,f.policy.accountId,f.order,guard)),{ok:false,reason:'paper_budget_session_window_invalid'});
  assert.equal(Date.parse(observedWindow!.endsAt)-Date.parse(f.policy.windows[0].endsAt),900000);
  const altered=parsePaperRunPolicy({...f.env,PAPER_RUN_POLICY_JSON:{...f.manifest,currencyCaps:{...f.manifest.currencyCaps,USD:{...f.manifest.currencyCaps.USD,maxDailyLoss:19}}}},f.loaded)!;
  assert.deepEqual(await checkPaperEntryBudget(pool,altered,altered.accountId,f.order,{},session),{ok:false,reason:'paper_budget_configuration_changed'});
  await assert.rejects(transaction(pool,client=>bindPaperProposal(client,altered,f.order.id,f.order)),/RUN_ID_REUSED/);
  const expired=parsePaperRunPolicy({...f.env,PAPER_RUN_POLICY_JSON:{...f.manifest,runId:'expired',windows:f.manifest.windows.map(w=>({...w,startsAt:new Date(Date.now()-120000).toISOString(),endsAt:new Date(Date.now()-60000).toISOString()}))}},f.loaded)!;
  assert.deepEqual(await checkPaperEntryBudget(pool,expired,expired.accountId,f.order,{},session),{ok:false,reason:'paper_budget_outside_window'});
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'0');
}));

test('consumed-only legacy unknown is charged while contradictory reservation timestamps hold', {skip}, () => fixture(async pool => {
  const ledger=(await pool.query('SELECT * FROM paper_entry_attempts')).rows;
  assert.equal(ledger.length,1);assert.equal(ledger[0].account_id,'DU_UNKNOWN');
  assert.equal(ledger[0].attempted_at.toISOString(),'2026-09-28T14:00:00.000Z');
  const holds=(await pool.query('SELECT account_id,reason FROM paper_entry_migration_holds')).rows;
  assert.equal(holds.length,1);assert.deepEqual(holds[0],{account_id:'DU_TIME',reason:'LEGACY_ATTEMPT_TIME_CONFLICTING'});
}, async pool => {
  const unknown=await proposal(pool,'265598','AAPL',null,null);
  const conflict=await proposal(pool,'265598','AAPL','DU_TIME','2026-09-28T13:59:59Z');
  for (const [id,account,run] of [[unknown,'DU_UNKNOWN','unknown'],[conflict,'DU_TIME','time']]) await pool.query(`INSERT INTO aapl_windows(run_id,account_id,trade_date,starts_at,ends_at,consumed_proposal_id,consumed_at)
    VALUES($1,$2,'2026-09-28','2026-09-28T13:55:00Z','2026-09-28T14:30:00Z',$3,'2026-09-28T14:00:00Z')`,[run,account,id]);
}));

test('in-flight legacy writer blocks adoption and its committed attempt cannot disappear', {skip}, () => fixture(async pool => {
  const f=paperPolicyFixture(), id=await proposal(pool), old=await pool.connect();
  try {
    await old.query('BEGIN');
    await old.query("UPDATE proposed_orders SET reason='legacy writer preparing' WHERE id=$1",[id]);
    await assert.rejects(transaction(pool,client=>adoptPaperEntryBudget(client,f.policy,{tradingEnabled:false})),/could not obtain lock/);
    await old.query('UPDATE proposed_orders SET execution_attempted_at=clock_timestamp(),execution_account_id=$2 WHERE id=$1',[id,f.policy.accountId]);
    await old.query('COMMIT');
    const result=await transaction(pool,client=>adoptPaperEntryBudget(client,f.policy,{tradingEnabled:false}));
    assert.deepEqual(result,{ok:false,reason:'PAPER_BUDGET_MIGRATION_HOLD'});
    assert.equal((await pool.query('SELECT count(*) FROM paper_entry_migration_holds WHERE account_id=$1',[f.policy.accountId])).rows[0].count,'1');
  } finally {await old.query('ROLLBACK');old.release();}
}));

test('dispatch rechecks session, exact proposal binding and deadline without releasing durable unknown', {skip}, () => fixture(async pool => {
  const f=await configured(pool);
  assert.equal((await transaction(pool,client=>reservePaperEntryAttempt(client,f.policy,f.policy.accountId,f.order,session))).ok,true);
  const unavailable:SessionEntryGuard=async()=>({ok:false,reason:'session_generation_changed'});
  assert.deepEqual(await checkPaperEntryBudget(pool,f.policy,f.policy.accountId,f.order,{proposalId:f.order.id,dispatch:true},unavailable),{ok:false,reason:'paper_budget_session_generation_changed'});
  const expired:SessionEntryGuard=async()=>({ok:true,generation:1,endsAtMs:0});
  assert.deepEqual(await checkPaperEntryBudget(pool,f.policy,f.policy.accountId,f.order,{proposalId:f.order.id,dispatch:true},expired),{ok:false,reason:'paper_budget_outside_window'});
  assert.deepEqual(await checkPaperEntryBudget(pool,f.policy,f.policy.accountId,f.order,{proposalId:f.order.id+1,dispatch:true},session),{ok:false,reason:'paper_budget_proposal_binding_mismatch'});
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'1');
}));

test('disabled adoption permits enabled compatible restart and preserves attempts, debt and manifest identity', {skip}, () => fixture(async pool => {
  const f=await configured(pool);
  assert.equal((await transaction(pool,client=>reservePaperEntryAttempt(client,f.policy,f.policy.accountId,f.order,session))).ok,true);
  await pool.query(`INSERT INTO paper_entry_legacy_day_debts(proposed_order_id,account_id,charged_date,source) VALUES($1,$2,'2026-03-20','fixture_prior_day')`,[f.order.id,f.policy.accountId]);
  const before=(await pool.query(`SELECT (SELECT jsonb_agg(a) FROM paper_entry_attempts a) attempts,
    (SELECT jsonb_agg(d) FROM paper_entry_legacy_day_debts d) debts,
    (SELECT jsonb_agg(a) FROM paper_entry_budget_adoptions a) adoption,
    (SELECT jsonb_agg(r) FROM paper_runs r) runs`)).rows[0];
  assert.deepEqual(await transaction(pool,client=>adoptPaperEntryBudget(client,f.policy,{tradingEnabled:true})),{ok:true});
  const after=(await pool.query(`SELECT (SELECT jsonb_agg(a) FROM paper_entry_attempts a) attempts,
    (SELECT jsonb_agg(d) FROM paper_entry_legacy_day_debts d) debts,
    (SELECT jsonb_agg(a) FROM paper_entry_budget_adoptions a) adoption,
    (SELECT jsonb_agg(r) FROM paper_runs r) runs`)).rows[0];
  assert.deepEqual(after,before);
  assert.deepEqual(await transaction(pool,client=>reservePaperEntryAttempt(client,f.policy,f.policy.accountId,f.order,session)),{ok:false,reason:'paper_budget_consumed'});
  const changed=parsePaperRunPolicy({...f.env,PAPER_RUN_POLICY_JSON:{...f.manifest,currencyCaps:{...f.manifest.currencyCaps,USD:{...f.manifest.currencyCaps.USD,maxDailyLoss:19}}}},f.loaded)!;
  await assert.rejects(transaction(pool,client=>adoptPaperEntryBudget(client,changed,{tradingEnabled:true})),/RUN_ID_REUSED/);
  assert.deepEqual((await pool.query('SELECT manifest_hash FROM paper_runs WHERE run_id=$1',[f.policy.runId])).rows[0],{manifest_hash:f.policy.manifestHash});
  await pool.query(`INSERT INTO paper_entry_migration_holds(evidence_key,account_id,reason,evidence) VALUES('restart_hold',$1,'fixture_late_hold','{}')`,[f.policy.accountId]);
  assert.deepEqual(await transaction(pool,client=>adoptPaperEntryBudget(client,f.policy,{tradingEnabled:true})),{ok:false,reason:'PAPER_BUDGET_MIGRATION_HOLD'});
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'1');
}));

test('first adoption requires disabled writes and fixes run identity before any proposal exists', {skip}, () => fixture(async pool => {
  const f=paperPolicyFixture();
  await pool.query('INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)',[f.loaded.effectiveHash,canonicalizeTradingConfiguration(f.loaded.configuration)]);
  await assert.rejects(transaction(pool,client=>adoptPaperEntryBudget(client,f.policy,{tradingEnabled:true})),/ADOPTION_REQUIRES_DISABLED_WRITES/);
  assert.equal((await pool.query('SELECT count(*) FROM paper_entry_budget_adoptions')).rows[0].count,'0');
  assert.deepEqual(await transaction(pool,client=>adoptPaperEntryBudget(client,f.policy,{tradingEnabled:false})),{ok:true});
  assert.equal((await pool.query('SELECT count(*) FROM proposed_orders')).rows[0].count,'0');
  const changed=parsePaperRunPolicy({...f.env,PAPER_RUN_POLICY_JSON:{...f.manifest,currencyCaps:{...f.manifest.currencyCaps,PLN:{...f.manifest.currencyCaps.PLN,maxStopRisk:9}}}},f.loaded)!;
  await assert.rejects(transaction(pool,client=>adoptPaperEntryBudget(client,changed,{tradingEnabled:true})),/RUN_ID_REUSED/);
  assert.deepEqual(await transaction(pool,client=>adoptPaperEntryBudget(client,f.policy,{tradingEnabled:true})),{ok:true});
}));
