import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { canonicalizeTradingConfiguration } from '@ikbr/shared/trading-config';
import { runMigrations } from './migrations.js';
import { paperPolicyFixture } from './paper-run-policy.fixture.js';
import { parsePaperRunPolicy, paperLocalDate, type PaperRunPolicy } from './paper-run-policy.js';
import { adoptPaperEntryBudget, bindPaperProposal, checkPaperEntryBudget, reservePaperEntryAttempt, readPaperRoundTripWindow } from './paper-entry-budget.js';
import { ExecutionRepository } from './repository.js';
import { PaperPolicyAuthority, type PolicyControlRequest } from './paper-policy-authority.js';
import { EntryControlStore } from './entry-control.js';
import { LifecycleAlertStore } from './lifecycle/lifecycle-alerts.js';
import type { SessionEntryGuard } from './session-entry-guard.js';

const url = process.env.TEST_POSTGRES_URL, skip = !url, sessionId = 'pp7-fixture';
const coverage = { positions: { available: true, boundedWindow: true, timedOut: false }, openOrders: { available: true, boundedWindow: true, timedOut: false },
  executions: { available: true, timedOut: false, window: { exposureWindowComplete: true } }, session: { available: true, timedOut: false }, completedOrders: { available: true, boundedWindow: true } };
const session: SessionEntryGuard = async (_db, _order, window) => ({ ok: true, generation: 1, endsAtMs: Date.parse(window!.endsAt) });
async function transaction<T>(pool: Pool, run: (db: PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await run(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const name = `pp7_policy_${randomUUID().replaceAll('-', '')}`, target = new URL(url!); target.pathname = '/postgres';
  const admin = new Pool({ connectionString: target.toString() }); await admin.query(`CREATE DATABASE ${name}`); target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.toString() });
  try { await runMigrations(pool); await run(await setup(pool)); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function setup(pool: Pool) {
  const now = Date.now(), f = paperPolicyFixture(new Date(now-60000).toISOString(), new Date(now+60000).toISOString(), true), accountId = f.policy.accountId;
  await pool.query('INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)', [f.loaded.effectiveHash, canonicalizeTradingConfiguration(f.loaded.configuration)]);
  await transaction(pool, db => adoptPaperEntryBudget(db, f.policy, { tradingEnabled: false }));
  const entry = new EntryControlStore(pool), alerts = new LifecycleAlertStore(pool);
  await entry.adopt(accountId, false);
  await pool.query("INSERT INTO lifecycle_observer_health(account_id,session_id,observed_at,healthy) VALUES($1,$2,clock_timestamp(),true)", [accountId,sessionId]);
  await pool.query("INSERT INTO lifecycle_alert_workers(account_id,process_id,heartbeat_at,transport_enabled) VALUES($1,$2,clock_timestamp(),true)", [accountId,sessionId]);
  await pool.query("INSERT INTO lifecycle_alert_outbox(account_id,probe_process_id,status) VALUES($1,$2,'DELIVERED')", [accountId,sessionId]);
  await pool.query("INSERT INTO reconciliation_runs(account_id,session_id,status,completed_at,source_coverage) VALUES($1,$2,'CLEAN',clock_timestamp(),$3)", [accountId,sessionId,coverage]);
  await pool.query(`INSERT INTO broker_snapshot_syncs(account_id,session_id,complete,observed_at,generation) VALUES($1,$2,true,clock_timestamp(),1)`, [accountId,sessionId]);
  await pool.query(`UPDATE reconciliation_runs SET position_generation=1,snapshot_complete=true,broker_snapshot=$1`, [{accountId,sessionId,connectionGeneration:1,exposureComplete:true,recoveryComplete:true,capturedAt:new Date().toISOString(),sourceCoverage:coverage}]);
  const repo = new ExecutionRepository(pool,undefined,undefined,session,undefined,{ policy:f.policy, context:()=>null, resolveManagement:async()=>undefined });
  let selected: PaperRunPolicy = f.policy;
  const state = { writes: false, startupPause: true, localHealthy: true, readinessCalls: 0, breakOnCall: 0 };
  const store = new PaperPolicyAuthority(pool, {
    policy: () => selected,
    assertDisabledPaused: async db => {
      if (state.writes || !state.startupPause || (await db.query('SELECT paused FROM execution_entry_controls WHERE account_id=$1', [accountId])).rows[0]?.paused !== true) throw new Error('disabled_paused_required');
    },
    readiness: async db => {
      state.readinessCalls++;
      const permit = await entry.observationPermit(db, { accountId, sessionId }, { assertCurrent() { if (!state.localHealthy || state.breakOnCall === state.readinessCalls) throw new Error('local_unhealthy'); }, alertFailure: (client,a,p) => alerts.entryFailure(client,a,p) });
      const flat = await repo.assertPaperPolicyFlat(db, accountId, sessionId, 1);
      return { ...permit, evidence: { sessionId, ...flat } };
    },
  });
  const target = async (offset: number, kind: 'scheduled' | 'supervised' = 'scheduled') => {
    const startsAt = new Date(now + offset * 86400000 - 60000).toISOString(), endsAt = new Date(now + offset * 86400000 + 60000).toISOString();
    const date = paperLocalDate(Date.parse(startsAt), 'Europe/Warsaw');
    const manifest = { ...f.manifest, runId: `run_${randomUUID().replaceAll('-', '')}`, windows: f.manifest.windows.map(w => ({ ...w, startsAt, endsAt })),
      ...(kind === 'scheduled' ? { version: 2, kind: 'bounded_scheduled', maxAttemptsPerAccountDay: 2, effectiveAccountDate: date, expiresAfterAccountDate: date } : {}) };
    selected = parsePaperRunPolicy({ ...f.env, PAPER_RUN_POLICY_JSON: manifest }, f.loaded)!;
    await transaction(pool, db => adoptPaperEntryBudget(db, selected, { tradingEnabled: false }));
    return selected;
  };
  const request = (policy: PaperRunPolicy, expectedRevision = 0): PolicyControlRequest => ({ requestId: randomUUID(), expectedRevision, manifestHash: policy.manifestHash, priorManifestHash: f.policy.manifestHash, reason: 'isolated acceptance fixture' });
  return { ...f, pool, accountId, state, store, target, request, select: (policy: PaperRunPolicy) => { selected = policy; } };
}

async function seedPreviouslyScheduled(f: Awaited<ReturnType<typeof setup>>, policy: PaperRunPolicy, effective = policy.effectiveAccountDate!, expiry = policy.expiresAfterAccountDate!) {
  // Historical pending transition fixture: production cannot schedule today's date.
  // Only this isolated database disables its INSERT guard while restoring yesterday's state.
  await transaction(f.pool, async db => {
    await db.query(`INSERT INTO paper_policy_events(account_id,revision,request_id,action,request,active_run_id,pending_run_id,effective_date,expires_after_date,actor,evidence)
      VALUES($1,1,$2,'SCHEDULE','{}',$3,$4,$5,$6,'historical_fixture','{}')`, [f.accountId,randomUUID(),f.policy.runId,policy.runId,effective,expiry]);
    await db.query('ALTER TABLE paper_policy_authorities DISABLE TRIGGER paper_policy_authority_guard');
    await db.query(`INSERT INTO paper_policy_authorities(account_id,revision,active_run_id,pending_run_id,effective_date,expires_after_date) VALUES($1,1,$2,$3,$4,$5)`, [f.accountId,f.policy.runId,policy.runId,effective,expiry]);
    await db.query('ALTER TABLE paper_policy_authorities ENABLE TRIGGER paper_policy_authority_guard');
  });
}
async function proposal(f: Awaited<ReturnType<typeof setup>>, policy: PaperRunPolicy, index: number) {
  const w = policy.windows[index];
  const id = Number((await f.pool.query(`INSERT INTO proposed_orders(instrument,conid,side,position_effect,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status)
    VALUES($1,$2,'BUY','OPEN_OR_ADD','LMT',1,100,99,105,'fixture',0.8,'PASS') RETURNING id`, [w.instrument,String(w.conId)])).rows[0].id);
  const order = { id, instrumentId: w.instrumentId, instrument: w.instrument, conid: String(w.conId), positionEffect: 'OPEN_OR_ADD' };
  await transaction(f.pool, db => bindPaperProposal(db,policy,id,order));
  return order;
}
async function terminal(f: Awaited<ReturnType<typeof setup>>, order: Awaited<ReturnType<typeof proposal>>) {
  await f.pool.query(`INSERT INTO lifecycle_supervision(original_proposal_id,account_id,original_hash,instrument_id,conid,session_identity,policy_source,exit_before_close_minutes,session_date,session_start,session_end,exit_deadline,session_generation,status,terminal_proof)
    VALUES($1,$2,'fixture',$3,$4,'{}','ENTRY_RESERVATION',15,'fixture',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '45 minutes',1,'TERMINAL_UNFILLED','{"fixture":"authoritative_zero_fill"}')`, [order.id,f.accountId,order.instrumentId,order.conid]);
}

test('v2 registration grants no authority; future scheduling bootstraps exact v1, CAS and replay never silently replace pending policy', { skip }, () => fixture(async f => {
  const policy = await f.target(1), req = f.request(policy);
  assert.equal((await f.store.read(f.accountId)).authority, null);
  const order = { instrumentId: policy.windows[0].instrumentId, instrument: policy.windows[0].instrument, conid: String(policy.windows[0].conId) };
  assert.deepEqual(await checkPaperEntryBudget(f.pool,policy,f.accountId,order,{},session), { ok: false, reason: 'paper_budget_policy_adoption_required' });
  await assert.rejects(f.store.change(f.accountId,'SCHEDULE',{ ...req, priorManifestHash: '0'.repeat(64) },'test'), /PRIOR_REQUIRED/);
  const concurrent = await Promise.allSettled([req,{ ...req,requestId:randomUUID() }].map(r => f.store.change(f.accountId,'SCHEDULE',r,'test')));
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length,1);
  const winner = concurrent[0].status === 'fulfilled' ? req : null;
  if (winner) {
    assert.deepEqual(await f.store.change(f.accountId,'SCHEDULE',winner,'test'), { revision:1,replay:true });
    await assert.rejects(f.store.change(f.accountId,'SCHEDULE',{ ...winner,reason:'changed' },'test'), /REQUEST_REUSED/);
  }
  await assert.rejects(f.store.change(f.accountId,'SCHEDULE',{ ...f.request(policy,1) },'test'), /TRANSITION_PENDING/);
  await assert.rejects(f.store.change(f.accountId,'ADOPT',f.request(policy,1),'test'), /ADOPTION_OUTSIDE_DATES/);
  assert.equal((await f.pool.query('SELECT paused FROM execution_entry_controls')).rows[0].paused,true);
  await assert.rejects(f.pool.query('DELETE FROM paper_policy_authorities'), /DURABLE/);
  await assert.rejects(f.pool.query('DELETE FROM paper_policy_events'), /IMMUTABLE/);
}));

test('cancellation before effective day is audited, requires exact pending hash and preserves strict authority and pause', { skip }, () => fixture(async f => {
  const policy=await f.target(1); await f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test');
  await assert.rejects(f.store.change(f.accountId,'CANCEL',{ ...f.request(policy,1),manifestHash:'0'.repeat(64) },'test'), /PENDING_MISMATCH/);
  await f.store.change(f.accountId,'CANCEL',f.request(policy,1),'test');
  const read=await f.store.read(f.accountId);assert.equal(read.authority.active_run_id,f.policy.runId);assert.equal(read.authority.pending_run_id,null);assert.equal(read.events.length,2);
  await assert.rejects(f.pool.query('SELECT paper_policy_cap($1,$2)',[f.accountId,policy.runId]), /AUTHORITY_MISMATCH/);
  assert.equal((await f.pool.query('SELECT paper_policy_cap($1,$2) cap',[f.accountId,f.policy.runId])).rows[0].cap,1);
}));

test('disabled paused scheduling repeats real observer/reconciliation/alert checks; failures leave no guessed authority', { skip }, () => fixture(async f => {
  const policy=await f.target(1);
  f.state.writes=true;await assert.rejects(f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test'),/disabled_paused/);f.state.writes=false;
  for (const [breakSql,restoreSql,reason] of [
    ["UPDATE lifecycle_observer_health SET healthy=false","UPDATE lifecycle_observer_health SET healthy=true",/OBSERVER_UNHEALTHY/],
    ["UPDATE reconciliation_runs SET source_coverage='{}'","UPDATE reconciliation_runs SET source_coverage=$1",/RECONCILIATION_INCOMPLETE/],
    ["UPDATE lifecycle_alert_outbox SET status='UNKNOWN'","UPDATE lifecycle_alert_outbox SET status='DELIVERED'",/transport_unverified/],
    ["UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp()-interval '16 seconds'","UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp()",/worker_stale/],
  ] as const) {
    await f.pool.query(breakSql); await assert.rejects(f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test'),reason);
    await f.pool.query(restoreSql,restoreSql.includes('$1')?[coverage]:[]);
  }
  await f.pool.query('UPDATE broker_snapshot_syncs SET generation=2');await assert.rejects(f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test'),/RECONCILIATION_CHANGED/);
  await f.pool.query('UPDATE broker_snapshot_syncs SET generation=1');
  f.state.localHealthy=false;await assert.rejects(f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test'),/local_unhealthy/);
  assert.equal((await f.store.read(f.accountId)).authority,null);assert.equal((await f.store.read(f.accountId)).events.length,0);
}));

test('due-day adoption rechecks readiness and blocks old writers; second instrument follows terminal proof and shared max2', { skip }, () => fixture(async f => {
  const policy=await f.target(0); await seedPreviouslyScheduled(f,policy);
  await assert.rejects(f.pool.query('SELECT paper_policy_cap($1,$2)',[f.accountId,f.policy.runId]),/AUTHORITY_MISMATCH/);
  const priorWindow=f.policy.windows[0];
  assert.deepEqual(await checkPaperEntryBudget(f.pool,f.policy,f.accountId,{instrumentId:priorWindow.instrumentId,instrument:priorWindow.instrument,conid:String(priorWindow.conId)},{},session),{ok:false,reason:'paper_budget_policy_authority_mismatch'});
  f.state.localHealthy=false;await assert.rejects(f.store.change(f.accountId,'ADOPT',f.request(policy,1),'test'),/local_unhealthy/);f.state.localHealthy=true;
  await f.store.change(f.accountId,'ADOPT',f.request(policy,1),'test');
  assert.equal((await f.pool.query('SELECT paused FROM execution_entry_controls')).rows[0].paused,true);
  await assert.rejects(f.pool.query('SELECT paper_policy_cap($1,$2)',[f.accountId,f.policy.runId]),/AUTHORITY_MISMATCH/);
  const a=await proposal(f,policy,0), b=await proposal(f,policy,1), c=await proposal(f,policy,2);
  const reserved=await Promise.all([a,b].map(o=>transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,o,session))));
  assert.equal(reserved.filter(r=>r.ok).length,1);assert.equal(reserved.filter(r=>!r.ok&&r.reason==='paper_budget_active_attempt').length,1);
  const winner=reserved[0].ok?a:b, second=reserved[0].ok?b:a;
  assert.equal((await checkPaperEntryBudget(f.pool,policy,f.accountId,winner,{proposalId:winner.id,dispatch:true},session)).ok,true);
  const report=await readPaperRoundTripWindow(f.pool,winner.id);assert.equal(report?.policyKind,'bounded_scheduled');assert.equal(report?.policyVersion,2);
  const same=await proposal(f,policy,reserved[0].ok?0:1);
  assert.deepEqual(await transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,same,session)),{ok:false,reason:'paper_budget_consumed'});
  await terminal(f,winner);
  assert.equal((await transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,second,session))).ok,true);
  assert.equal((await checkPaperEntryBudget(f.pool,policy,f.accountId,second,{proposalId:second.id,dispatch:true},session)).ok,true);
  assert.deepEqual(await transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,c,session)),{ok:false,reason:'paper_budget_consumed'});
  assert.equal((await f.pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'2');
  await assert.rejects(transaction(f.pool,db=>db.query(`INSERT INTO paper_entry_attempts(proposed_order_id,account_id,broker,conid,account_date,session_date,session_timezone,attempted_at,run_id,source)
    SELECT $1,$2,'ibkr',$3,(t AT TIME ZONE 'Europe/Warsaw')::date,(t AT TIME ZONE $4)::date,$4,t,$5,'generic' FROM (SELECT clock_timestamp() t) s`,[c.id,f.accountId,c.conid,policy.windows[2].sessionTimeZone,policy.runId])),/CONSUMED/);
}));

test('missed/expired pending adoption remains blocked and cannot cancel back to old authority', { skip }, () => fixture(async f => {
  const policy=await f.target(-1);await seedPreviouslyScheduled(f,policy);
  await assert.rejects(f.store.change(f.accountId,'ADOPT',f.request(policy,1),'test'),/ADOPTION_OUTSIDE_DATES/);
  await assert.rejects(f.store.change(f.accountId,'CANCEL',f.request(policy,1),'test'),/CANCEL_TOO_LATE/);
  await assert.rejects(f.pool.query('SELECT paper_policy_cap($1,$2)',[f.accountId,f.policy.runId]),/AUTHORITY_MISMATCH/);
  assert.equal((await f.store.read(f.accountId)).authority.pending_run_id,policy.runId);
}));

test('flat adoption rejects current holdings, incomplete position evidence, pending intents and orphan attempted reservations', { skip }, () => fixture(async f => {
  const policy=await f.target(1), change=()=>f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test');
  await f.pool.query(`INSERT INTO broker_position_snapshots(account_id,session_id,instrument,conid,quantity,observed_at) VALUES($1,$2,$3,$4,1,clock_timestamp())`,[f.accountId,sessionId,f.policy.windows[0].instrument,String(f.policy.windows[0].conId)]);
  await assert.rejects(change(),/NOT_FLAT/);
  await f.pool.query('DELETE FROM broker_position_snapshots');
  await f.pool.query('UPDATE broker_snapshot_syncs SET complete=false');await assert.rejects(change(),/POSITION_UNAVAILABLE/);
  await f.pool.query('UPDATE broker_snapshot_syncs SET complete=true');
  const order=await proposal(f,f.policy,0);await assert.rejects(change(),/UNRESOLVED_OWNERSHIP/);
  await f.pool.query("UPDATE proposed_orders SET status='EXPIRED' WHERE id=$1",[order.id]);
  assert.equal((await transaction(f.pool,db=>reservePaperEntryAttempt(db,f.policy,f.accountId,order,session))).ok,true);
  await assert.rejects(change(),/UNRESOLVED_ATTEMPT/);
  assert.equal((await f.store.read(f.accountId)).authority,null);
  assert.equal((await f.pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'1');
}));

test('raw SQL cannot claim scheduled attempts without adoption or revive a prior run after authority bootstrap', { skip }, () => fixture(async f => {
  const policy=await f.target(0), order=await proposal(f,policy,0);
  const raw=()=>transaction(f.pool,db=>db.query(`INSERT INTO paper_entry_attempts(proposed_order_id,account_id,broker,conid,account_date,session_date,session_timezone,attempted_at,run_id,source)
    SELECT $1,$2,'ibkr',$3,(t AT TIME ZONE 'Europe/Warsaw')::date,(t AT TIME ZONE $4)::date,$4,t,$5,'generic' FROM (SELECT clock_timestamp() t) s`,[order.id,f.accountId,order.conid,policy.windows[0].sessionTimeZone,policy.runId]));
  await assert.rejects(raw(),/ADOPTION_REQUIRED/);
  await f.pool.query("UPDATE proposed_orders SET status='EXPIRED' WHERE id=$1",[order.id]);
  const future=await f.target(1);await f.store.change(f.accountId,'SCHEDULE',f.request(future),'test');
  await assert.rejects(raw(),/AUTHORITY_MISMATCH/);
  assert.equal((await f.pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'0');
}));

test('rollback to supervised keeps earlier attempts and unknown reservations immutable', { skip }, () => fixture(async f => {
  const policy=await f.target(0);await seedPreviouslyScheduled(f,policy);await f.store.change(f.accountId,'ADOPT',f.request(policy,1),'test');
  const order=await proposal(f,policy,0);assert.equal((await transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,order,session))).ok,true);
  await f.pool.query("UPDATE proposed_orders SET status='EXPIRED' WHERE id=$1",[order.id]);
  const rollback=await f.target(1,'supervised');
  await assert.rejects(f.store.change(f.accountId,'SCHEDULE',{...f.request(rollback,2),priorManifestHash:policy.manifestHash},'test'),/UNRESOLVED_ATTEMPT/);
  await terminal(f,order);
  await f.store.change(f.accountId,'SCHEDULE',{...f.request(rollback,2),priorManifestHash:policy.manifestHash},'test');
  assert.equal((await f.pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'1');
  await assert.rejects(f.pool.query('UPDATE paper_entry_attempts SET account_date=account_date+1'),/IMMUTABLE/);
  await assert.rejects(f.pool.query('TRUNCATE paper_policy_authorities'),/IMMUTABLE/);
  assert.equal((await f.store.read(f.accountId)).authority.pending_run_id,rollback.runId);
}));

test('configured exit margin is enforced for the whole window and stale calendar cannot release an unknown attempt', { skip }, () => fixture(async f => {
  const policy=await f.target(0);await seedPreviouslyScheduled(f,policy);await f.store.change(f.accountId,'ADOPT',f.request(policy,1),'test');
  const order=await proposal(f,policy,0);
  let end='';const guard:SessionEntryGuard=async(_db,_order,w)=>{end=w!.endsAt;return{ok:false,reason:'session_window_invalid'};};
  assert.deepEqual(await transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,order,guard,60)),{ok:false,reason:'paper_budget_session_window_invalid'});
  assert.equal(Date.parse(end)-Date.parse(policy.windows[0].endsAt),3600000);
  assert.equal((await transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,order,session))).ok,true);
  assert.deepEqual(await checkPaperEntryBudget(f.pool,policy,f.accountId,order,{proposalId:order.id,dispatch:true},async()=>({ok:false,reason:'session_schedule_stale'})),{ok:false,reason:'paper_budget_session_schedule_stale'});
  assert.equal((await f.pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'1');
}));

test('readiness loss on the final fence rolls back event and authority atomically', { skip }, () => fixture(async f => {
  const policy=await f.target(1);
  f.state.breakOnCall=3;
  await assert.rejects(f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test'),/local_unhealthy/);
  assert.deepEqual(await f.store.read(f.accountId),{authority:null,events:[]});
  assert.equal((await f.pool.query('SELECT paused FROM execution_entry_controls')).rows[0].paused,true);
}));

test('a reservation waiting for the account lock uses fresh database time and cannot cross its pinned window boundary', { skip }, () => fixture(async f => {
  const base=await f.target(0);
  const manifest=JSON.parse(base.canonicalManifest);
  manifest.runId='expires_under_lock';
  manifest.windows=manifest.windows.map((w:Record<string,unknown>)=>({...w,endsAt:new Date(Date.now()+600).toISOString()}));
  const policy=parsePaperRunPolicy({...f.env,PAPER_RUN_POLICY_JSON:manifest},f.loaded)!;
  await transaction(f.pool,db=>adoptPaperEntryBudget(db,policy,{tradingEnabled:false}));f.select(policy);
  await seedPreviouslyScheduled(f,policy);await f.store.change(f.accountId,'ADOPT',f.request(policy,1),'test');
  const order=await proposal(f,policy,0), holder=await f.pool.connect();
  try {
    await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtext('snap:'||$1))",[f.accountId]);
    const waiting=transaction(f.pool,db=>reservePaperEntryAttempt(db,policy,f.accountId,order,session));
    await new Promise(resolve=>setTimeout(resolve,700));await holder.query('COMMIT');
    assert.deepEqual(await waiting,{ok:false,reason:'paper_budget_outside_window'});
    assert.equal((await f.pool.query('SELECT count(*) FROM paper_entry_attempts')).rows[0].count,'0');
  } finally {await holder.query('ROLLBACK');holder.release();}
}));

test('Warsaw PostgreSQL DATE decoding agrees with SQL before the pending effective day', { skip }, () => fixture(async f => {
  const before=process.env.TZ;process.env.TZ='Europe/Warsaw';
  try {
    const policy=await f.target(1);await f.store.change(f.accountId,'SCHEDULE',f.request(policy),'test');
    const w=f.policy.windows[0], order={instrumentId:w.instrumentId,instrument:w.instrument,conid:String(w.conId)};
    assert.equal((await checkPaperEntryBudget(f.pool,f.policy,f.accountId,order,{},session)).ok,true);
    assert.equal((await f.pool.query('SELECT paper_policy_cap($1,$2) cap',[f.accountId,f.policy.runId])).rows[0].cap,1);
    const next=(await f.pool.query('SELECT effective_date,effective_date::text AS effective_day FROM paper_policy_authorities')).rows[0];
    assert.equal(next.effective_day,policy.effectiveAccountDate);
    assert.notEqual(new Date(next.effective_date).toISOString().slice(0,10),next.effective_day);
  } finally {if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
}));
