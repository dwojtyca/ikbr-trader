import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { seedTwoSourceResearchStore } from './research.fixture.js';
import { buildStrategyAttribution } from '../trading-config.js';
import { ResearchStore } from './store.js';
import { researchHash } from './validation.js';
import { parseWshConfig, wshRequestDates, wshReceiptPolicy } from './wsh.js';
import type { RecoveryIdentity, RecoveryChallenge, WshRecoveryEvidence } from './startup-recovery.js';
const { Pool } = createRequire(new URL('../../../../apps/llm-agent/package.json', import.meta.url))('pg');
const connection = process.env.TEST_POSTGRES_URL;
async function isolated(run: (pool: any, advance: (ms: number) => Promise<void>) => Promise<void>) {
  const url = new URL(connection!);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && (url.port === '55438' && url.pathname === '/ikbr_owner_recovery_test' || process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci'));
  url.pathname = '/postgres'; const admin = new Pool({ connectionString: url.href }), name = 'auto_wsh_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE DATABASE ${name}`); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: url.href, options: '-c search_path=public,pg_catalog' });
  try {
    await pool.query('CREATE TABLE fixture_clock(offset_ms bigint NOT NULL); INSERT INTO fixture_clock VALUES(0)');
    await pool.query("CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.clock_timestamp()+(SELECT offset_ms FROM fixture_clock)*interval '1 millisecond' $$");
    const directory = new URL('../../../../infra/sql/migrations/', import.meta.url);
    for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) await pool.query(readFileSync(new URL(file, directory), 'utf8'));
    await run(pool, async ms => { await pool.query('UPDATE fixture_clock SET offset_ms=offset_ms+$1', [ms]); });
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
type Fixture = Awaited<ReturnType<typeof seedTwoSourceResearchStore>>;
const wshIdentity = (f: Fixture) => ({ ...f.identity, sourceId: f.wshSource.id });
const recoveryIdentity = (f: Fixture): RecoveryIdentity => ({ ...wshIdentity(f), kind: 'WSH_ENDPOINT_RESET', pauseRevision: 1, actor: 'operator:test', operationId: randomUUID() });
async function pause(f: Fixture, pool: any) {
  await pool.query('INSERT INTO execution_entry_controls(account_id) VALUES($1) ON CONFLICT DO NOTHING', [f.accountId]);
  await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds' WHERE service='llm-agent'");
}
function evidence(c: RecoveryChallenge): WshRecoveryEvidence {
  const now = Date.now(), stamp = (ms: number) => new Date(now + ms).toISOString(), sessionId = randomUUID();
  const settings = { endpointId: c.endpointId!, host: 'host.docker.internal', port: 7497, clientId: 156 };
  return { version: 'local-research-recovery-v1', kind: 'WSH_ENDPOINT_RESET', challengeId: c.id, challengeHash: c.challengeHash, nonce: c.nonce,
    platform: 'darwin', hostIdHash: 'a'.repeat(64), deploymentHash: 'b'.repeat(64), collectorStartedAt: stamp(-10000), producerCheckedAt: stamp(-9000), producerRecheckedAt: stamp(-1000),
    producers: [{ containerId: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}`, project: 'fixture', service: 'llm-agent', startedAt: stamp(-20000), finishedAt: stamp(-11000), state: 'exited' }], runningProducerIds: [],
    ...settings, endpointSettingsHash: researchHash(settings), before: { observedAt: stamp(-8000), process: { pid: 100, startIdentity: 'old', executableHash: 'e'.repeat(64) } },
    stopped: { observedAt: stamp(-7000), processAbsent: true, listenerAbsent: true }, after: { observedAt: stamp(-6000), process: { pid: 200, startIdentity: 'new', executableHash: 'e'.repeat(64) } },
    reconnect: { startedAt: stamp(-5000), completedAt: stamp(-4000), sessionId, accountId: c.accountId, serverVersion: 180, sdkVersion: '1.6.10', cleanup: {
      sessionId, state: 'CONFIRMED', verifiedLocalClosure: true, cancellationAttemptedAt: null, disconnectRequestedAt: stamp(-3000), localClosedAt: stamp(-2000), completedAt: stamp(-1500),
    } } };
}
async function commit(f: Fixture, c: RecoveryChallenge) {
  const input = { challengeId: c.id, challengeHash: c.challengeHash, operationId: randomUUID(), actor: 'operator:test', pauseRevision: c.pauseRevision, evidence: evidence(c) };
  return { input, receipt: await f.store.commitResearchRecovery(input) };
}
async function pendingLegacy(f: Fixture) {
  let acquisitionId = '';
  await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId), async lease => {
    const callKey = 'pending_' + randomUUID();
    const acquisition = await f.store.beginWshAcquisition(lease, { ...wshIdentity(f), sessionId: randomUUID(), reservation: { ...f.identity,
      provider: 'ibkr-wsh', kind: 'source', callKey, requestHash: 'a'.repeat(64), deadlineAt: new Date(await f.clock() + 9000).toISOString(),
      reservedCostMicros: 0, maxRequestsPerDay: f.wshSource.maxRequestsPerDay, maxCostMicrosPerDay: f.wshSource.maxCostMicrosPerDay } });
    acquisitionId = acquisition.id;
  }); return acquisitionId;
}
async function publishUnknownCleanup(f: Fixture) {
  let attemptId = '';
  const config = parseWshConfig(f.wshSource, f.policy);
  await f.store.withWshEndpointLock(config.endpointId, async lease => {
    const claimed = await f.store.claimWshAttempt(lease, { ...wshIdentity(f), sessionId: randomUUID() }, 'regular');
    assert.equal(claimed.state, 'CLAIMED'); if (claimed.state !== 'CLAIMED') return;
    const ticket = claimed.ticket; attemptId = ticket.id; await f.store.confirmWshPreflight(lease, ticket);
    const base = { ...f.identity, provider: 'ibkr-wsh', kind: 'source' as const, reservedCostMicros: 0, maxRequestsPerDay: f.wshSource.maxRequestsPerDay, maxCostMicrosPerDay: f.wshSource.maxCostMicrosPerDay };
    const meta = { ...base, callKey: 'meta_' + randomUUID(), requestHash: 'a'.repeat(64), deadlineAt: new Date(await f.clock() + 9000).toISOString() };
    const acquisition = await f.store.beginWshAcquisition(lease, { ...wshIdentity(f), sessionId: ticket.sessionId, reservation: meta }, ticket);
    await f.store.recordCallOutcome(meta.callKey, 'SUCCEEDED');
    const now = new Date(await f.clock()).toISOString(), dates = wshRequestDates(config, now), requestHash = researchHash({ endpointId: config.endpointId, sessionId: ticket.sessionId, requestId: 2, method: 'reqWshEventData', request: {
      conId: config.conId, filter: '', fillWatchlist: false, fillPortfolio: false, fillCompetitors: false, ...dates, totalLimit: 100 } });
    await f.store.reserveWshCall(lease, acquisition, { ...base, callKey: 'events_' + randomUUID(), requestHash, deadlineAt: new Date(await f.clock() + 9000).toISOString() });
    const snapshot = f.empty(now);
    snapshot.coverage.push({ sourceId: f.wshSource.id, role: 'calendar', status: 'EMPTY', complete: true, checkedAt: now, windowStart: now, windowEnd: now, evidenceRefs: [], reason: 'RESEARCH_WSH_PROVIDER_QUERY_COMPLETE',
      wshAcquisition: { ...wshReceiptPolicy(config), coverageBasis: 'PROVIDER_REPORTED_QUERY', acquisitionId: acquisition.id, generation: acquisition.generation, sessionId: ticket.sessionId,
        requestId: 2, requestAsOf: now, requestStartDate: dates.startDate, requestEndDate: dates.endDate, totalLimit: 100, rowCount: 0, duplicateCount: 0, requestHash, receiptHash: 'e'.repeat(64), metadataHash: config.qualification.metadataHash } });
    await f.store.publishWshSnapshot(lease, acquisition, snapshot);
    await f.store.finishWshAttempt(lease, ticket, { outcome: 'SUCCEEDED', acquisition, cleanup: { sessionId: ticket.sessionId, state: 'UNKNOWN', verifiedLocalClosure: false,
      completedAt: now, cancellationAttemptedAt: now, disconnectRequestedAt: now, localClosedAt: null } });
  }); return attemptId;
}

test('automatic pending acquisition retirement preserves charged unknown calls and original pacing', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false}),id=await pendingLegacy(f);
 const before=(await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r ORDER BY call_key')).rows;
 assert.equal((await f.store.recoverExpiredWshReads(wshIdentity(f))).state,'WAITING');
 await advance(40000);await f.observe();
 const result=await f.store.recoverExpiredWshReads(wshIdentity(f));assert.equal(result.state,'RECOVERED');
 assert.deepEqual((await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r ORDER BY call_key')).rows,before);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_outcomes o JOIN research_wsh_acquisition_calls c USING(call_key) WHERE c.acquisition_id=$1',[id])).rows[0].n,0);
 const ac=(await pool.query('SELECT * FROM research_wsh_acquisitions WHERE id=$1',[id])).rows[0];assert.equal(ac.state,'UNKNOWN');assert.ok(ac.retired_at);
 const receipt=(await pool.query('SELECT canonical_json FROM research_wsh_read_recoveries')).rows[0];const record=JSON.parse(receipt.canonical_json);
 assert.equal(Date.parse(record.issuers[0].nextRegularAt),ac.started_at.getTime()+3600000);
 assert.equal((await f.store.recoverExpiredWshReads(wshIdentity(f))).state,'NOT_REQUIRED');
 const state=await f.store.readWshRefreshState(wshIdentity(f));assert.equal(state.blocksCachedEvidence,true);assert.equal(Date.parse(state.nextRegularAt!),ac.started_at.getTime()+3600000);
 const waitingDue=await f.store.dueWshAttempts(f.identity);
 assert.equal(waitingDue.some(x=>x.identity.instrumentId===f.identity.instrumentId),false);
 assert.ok(waitingDue.some(x=>x.identity.instrumentId==='pko_wse'||x.identity.instrumentId==='xyz_nyse'));
 await assert.rejects(pool.query('DELETE FROM research_wsh_read_recoveries'),/immutable/i);
 await assert.rejects(f.store.recordCallOutcome(before.find((r:any)=>r.data.provider==='ibkr-wsh').data.call_key,'SUCCEEDED'),/GENERATION_RETIRED/);
 await advance(3600000);await f.observe();
 await publishUnknownCleanup(f);
 assert.equal((await f.store.readWshRefreshState(wshIdentity(f))).blocksCachedEvidence,false);
}));

test('automatic recovery resolves a lost COMMIT response by exact receipt without advancing twice', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await pendingLegacy(f);await advance(40000);await f.observe();
 let lost=false;
 const wrapped={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();let inserted=false;return {release:(destroy?:boolean)=>client.release(destroy),query:async(sql:string,values?:unknown[])=>{
   const result=await client.query(sql,values);if(sql.includes('INSERT INTO research_wsh_read_recoveries'))inserted=true;
   if(sql==='COMMIT'&&inserted&&!lost){lost=true;throw new Error('fixture lost COMMIT response');}return result;
 }}}};
 const store=new ResearchStore(wrapped),first=await store.recoverExpiredWshReads(wshIdentity(f));assert.equal(first.state,'WAITING');assert.ok(first.recoveryId);
 const generation=(await pool.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1',[f.wshSource.parserConfig.endpointId])).rows[0].generation;
 const second=await store.recoverExpiredWshReads(wshIdentity(f));assert.equal(second.state,'RECOVERED');assert.equal(second.recoveryId,first.recoveryId);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,1);
 assert.equal((await pool.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1',[f.wshSource.parserConfig.endpointId])).rows[0].generation,generation);
}));

test('legacy PREPARED WSH challenge receives exact disposition and delayed finalizers fail', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await pendingLegacy(f);await advance(40000);await f.observe();await pause(f,pool);
 const c=await f.store.prepareResearchRecovery(recoveryIdentity(f));const before=(await pool.query('SELECT to_jsonb(c) data FROM research_recovery_challenges c WHERE id=$1',[c.id])).rows[0].data;
 const delayed=await pool.connect();await delayed.query('BEGIN');await delayed.query('SELECT challenge_hash FROM research_recovery_challenges WHERE id=$1',[c.id]);
 await f.observe();assert.equal((await f.store.recoverExpiredWshReads(wshIdentity(f))).state,'RECOVERED');
 try{await assert.rejects(delayed.query("UPDATE research_recovery_challenges SET state='CANCELLED' WHERE id=$1",[c.id]),/RESEARCH_WSH_READ_CHALLENGE_SUPERSEDED/);}finally{delayed.release(true);}
 assert.deepEqual((await pool.query('SELECT to_jsonb(c) data FROM research_recovery_challenges c WHERE id=$1',[c.id])).rows[0].data,before);
 assert.equal((await pool.query('SELECT challenge_hash FROM research_wsh_read_recovery_challenges WHERE challenge_id=$1',[c.id])).rows[0].challenge_hash,c.challengeHash);
 assert.equal((await pool.query('SELECT research_recovery_held($1,$2,$3) held',[c.accountId,c.predecessors[0].ledgerKey,c.endpointId])).rows[0].held,false);
 await pause(f,pool);
 await assert.rejects(commit(f,c),/RESEARCH_WSH_READ_CHALLENGE_SUPERSEDED/);
 await assert.rejects(pool.query("UPDATE research_recovery_challenges SET state='CANCELLED' WHERE id=$1",[c.id]),/RESEARCH_WSH_READ_CHALLENGE_SUPERSEDED|RESEARCH_RECOVERY_CHALLENGE/);
}));

test('automatic terminal cleanup retirement preserves terminal result and requires current fresh acquisition', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false}),id=await publishUnknownCleanup(f);
 const before=(await pool.query('SELECT to_jsonb(a) data FROM research_wsh_refresh_attempts a WHERE id=$1',[id])).rows[0].data;
 const calls=(await pool.query('SELECT to_jsonb(r) reservation,to_jsonb(o) outcome FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key) ORDER BY call_key')).rows;
 await advance(40000);await f.observe();assert.equal((await f.store.recoverExpiredWshReads(wshIdentity(f))).state,'RECOVERED');
 assert.deepEqual((await pool.query('SELECT to_jsonb(a) data FROM research_wsh_refresh_attempts a WHERE id=$1',[id])).rows[0].data,before);
 assert.deepEqual((await pool.query('SELECT to_jsonb(r) reservation,to_jsonb(o) outcome FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key) ORDER BY call_key')).rows,calls);
 assert.equal((await f.store.readWshRefreshState(wshIdentity(f))).blocksCachedEvidence,true);
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{
   const claim=await f.store.claimWshAttempt(lease,{...wshIdentity(f),sessionId:randomUUID()},'retry');assert.notEqual(claim.state,'CLAIMED');
 });
}));

test('related old-manifest endpoints retire atomically, busy try-lock releases the partial set', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const first=await seedTwoSourceResearchStore(pool,{publishWsh:false,publishNews:false,configureManifest:m=>{for(const p of m.instruments)for(const s of p.sources)if(s.adapter==='ibkr-wsh')s.parserConfig.endpointId='fixture-a';}});
 const old=await pendingLegacy(first);
 await pool.query("UPDATE research_wsh_acquisitions SET state='UNKNOWN',retired_at=clock_timestamp() WHERE id=$1",[old]);
 await advance(3600100);
 const manifest=structuredClone(first.manifest);for(const p of manifest.instruments)for(const s of p.sources)if(s.adapter==='ibkr-wsh')s.parserConfig.endpointId='fixture-b';
 await first.store.registerManifest({manifest,configuration:first.config,tradingEnabled:false,adopt:true});
 const identity={...first.identity,manifestHash:researchHash(manifest)},policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId)!;
 const observe=async()=>{await pool.query("UPDATE trading_configuration_observations SET observed_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 seconds'");for(const service of ['execution-engine','llm-agent'] as const)await first.store.observe({...identity,service,processId:'new-'+service,tradingEnabled:false});};
 const second={...first,manifest,manifestHash:identity.manifestHash,identity,policy,wshSource:policy.sources.find(s=>s.adapter==='ibkr-wsh')!,observe};await observe();
 const current=await pendingLegacy(second);await advance(40000);await second.observe();
 const before=(await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r ORDER BY call_key')).rows;
 const blocker=await pool.connect();await blocker.query("SELECT pg_advisory_lock(hashtext('research-wsh-endpoint:fixture-b')::bigint)");
 try{
  assert.equal((await second.store.recoverExpiredWshReads(wshIdentity(second))).state,'BUSY');
  const probe=await pool.connect();try{assert.equal((await probe.query("SELECT pg_try_advisory_lock(hashtext('research-wsh-endpoint:fixture-a')::bigint) locked")).rows[0].locked,true);}finally{probe.release(true);}
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,0);
 }finally{blocker.release(true);}
 assert.equal((await second.store.recoverExpiredWshReads(wshIdentity(second))).state,'RECOVERED');
 const record=JSON.parse((await pool.query('SELECT canonical_json FROM research_wsh_read_recoveries')).rows[0].canonical_json);
 assert.deepEqual(record.endpoints.map((e:any)=>e.endpointId),['fixture-a','fixture-b']);
 assert.deepEqual(record.predecessors.map((p:any)=>p.id).sort(),[old,current].sort());
 assert.deepEqual((await pool.query('SELECT to_jsonb(r) data FROM research_call_reservations r ORDER BY call_key')).rows,before);
}));

test('direct SQL cannot commit an incomplete retirement receipt', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await pendingLegacy(f);await advance(40000);await f.observe();
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_lock(hashtext($1)::bigint)',[`research-wsh-endpoint:${f.wshSource.parserConfig.endpointId}`]);
  const record=(await db.query('SELECT research_wsh_read_recovery_record($1::jsonb,clock_timestamp()) record',[JSON.stringify(wshIdentity(f))])).rows[0].record;
  await db.query(`INSERT INTO research_wsh_read_recoveries(id,account_id,config_hash,manifest_hash,instrument_id,source_id,recorded_at,canonical_json,record_hash)
   SELECT $1,$2,$3,$4,$5,$6,$7,research_recovery_canonical($8::jsonb),encode(sha256(convert_to(research_recovery_canonical($8::jsonb),'UTF8')),'hex')`,[randomUUID(),f.accountId,f.identity.configHash,f.identity.manifestHash,f.identity.instrumentId,f.wshSource.id,record.recordedAt,JSON.stringify(record)]);
  await assert.rejects(db.query('COMMIT'),/RESEARCH_WSH_READ_RECOVERY_INCOMPLETE/);
 }finally{db.release(true);}
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,0);
}));

test('expired pre-acquisition attempt establishes initial endpoint generation without charging or inventing closure', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false,publishNews:false});let ticket:any;
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{const c=await f.store.claimWshAttempt(lease,{...wshIdentity(f),sessionId:randomUUID()},'regular');assert.equal(c.state,'CLAIMED');if(c.state==='CLAIMED')ticket=c.ticket;});
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_endpoints')).rows[0].n,0);
 assert.equal((await f.store.recoverExpiredWshReads(wshIdentity(f))).state,'WAITING');
 await advance(40000);await f.observe();assert.equal((await f.store.recoverExpiredWshReads(wshIdentity(f))).state,'RECOVERED');
 assert.equal((await pool.query('SELECT generation FROM research_wsh_endpoints')).rows[0].generation,'1');
 const row=(await pool.query('SELECT * FROM research_wsh_refresh_attempts WHERE id=$1',[ticket.id])).rows[0];assert.equal(row.state,'UNKNOWN');assert.equal(row.verified_local_closure,false);assert.equal(row.acquisition_id,null);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n,0);
 assert.equal(Date.parse((await f.store.readWshRefreshState(wshIdentity(f))).nextRegularAt!),Date.parse(ticket.nextRegularAt));
 await f.store.withWshEndpointLock(String(f.wshSource.parserConfig.endpointId),async lease=>{
  await assert.rejects(f.store.confirmWshPreflight(lease,ticket),/GENERATION_RETIRED/);
  await assert.rejects(f.store.finishWshAttempt(lease,ticket,{outcome:'SUCCEEDED',cleanup:{sessionId:ticket.sessionId,state:'UNKNOWN',verifiedLocalClosure:false,completedAt:new Date(await f.clock()).toISOString(),cancellationAttemptedAt:null,disconnectRequestedAt:null,localClosedAt:null}} as any),/EXPIRED|GENERATION_RETIRED/);
 });
}));

test('COMMIT failure before persistence keeps operation identity and commits once on a later tick', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await pendingLegacy(f);await advance(40000);await f.observe();let failed=false;
 const wrapped={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();let inserted=false;return {release:(destroy?:boolean)=>client.release(destroy),query:async(sql:string,values?:unknown[])=>{
  if(sql==='COMMIT'&&inserted&&!failed){failed=true;throw new Error('fixture COMMIT not delivered');}
  const result=await client.query(sql,values);if(sql.includes('INSERT INTO research_wsh_read_recoveries'))inserted=true;return result;
 }}}};
 const store=new ResearchStore(wrapped),first=await store.recoverExpiredWshReads(wshIdentity(f));assert.equal(first.state,'WAITING');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,0);
 const second=await store.recoverExpiredWshReads(wshIdentity(f));assert.equal(second.state,'RECOVERED');assert.equal(second.recoveryId,first.recoveryId);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,1);
}));

for(const defect of ['foreign-account','corrupt-ledger'] as const)test(`automatic read recovery rejects ${defect}`,{skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false}),id=await pendingLegacy(f);await advance(40000);await f.observe();
 if(defect==='corrupt-ledger')await pool.query("UPDATE research_wsh_acquisitions SET ledger_key='ibkr-wsh:invalid' WHERE id=$1",[id]);
 await assert.rejects(f.store.recoverExpiredWshReads({...wshIdentity(f),...(defect==='foreign-account'?{accountId:'DU_OTHER'}:{})}),/RESEARCH_WSH_READ_RECOVERY_IDENTITY_INVALID/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,0);
}));

test('changed predecessor outcomes under discovered locks cause rediscovery without partial retirement', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false}),id=await pendingLegacy(f);await advance(40000);await f.observe();let changed=false;
 const call=(await pool.query('SELECT call_key FROM research_wsh_acquisition_calls WHERE acquisition_id=$1',[id])).rows[0].call_key;
 const wrapped={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return {release:(destroy?:boolean)=>client.release(destroy),query:async(sql:string,values?:unknown[])=>{
  const result=await client.query(sql,values);if(sql.includes('SELECT research_wsh_read_recovery_record')&&!changed){changed=true;await f.store.recordCallOutcome(call,'UNKNOWN');}return result;
 }}}};
 const store=new ResearchStore(wrapped);assert.equal((await store.recoverExpiredWshReads(wshIdentity(f))).state,'WAITING');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,0);
 assert.equal((await store.recoverExpiredWshReads(wshIdentity(f))).state,'RECOVERED');
 assert.equal((await pool.query('SELECT outcome FROM research_call_outcomes WHERE call_key=$1',[call])).rows[0].outcome,'UNKNOWN');
}));

test('WSH automatic retirement leaves Marketaux PREPARED maintenance hold intact', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false,publishNews:false});await pendingLegacy(f);const claim=await f.store.claimMarketauxAttempt(f.identity);assert.equal(claim.claimed,true);
 await advance(126000);await f.observe();await pause(f,pool);
 const c=await f.store.prepareResearchRecovery({...f.identity,kind:'MARKETAUX_PRODUCER_QUIESCENCE',pauseRevision:1,actor:'operator:test',operationId:randomUUID()});
 await f.observe();assert.equal((await f.store.recoverExpiredWshReads(wshIdentity(f))).state,'RECOVERED');
 assert.equal((await pool.query('SELECT state FROM research_recovery_challenges WHERE id=$1',[c.id])).rows[0].state,'PREPARED');
 assert.equal((await pool.query('SELECT research_recovery_held($1,$2,NULL) held',[c.accountId,c.predecessors[0].ledgerKey])).rows[0].held,true);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recovery_challenges WHERE challenge_id=$1',[c.id])).rows[0].n,0);
}));

test('direct SQL rechecks manifest authority after waiting for the recovery table lock', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await pendingLegacy(f);await advance(40000);await f.observe();
 const next=structuredClone(f.manifest);next.instruments[0].business+=' Revised fixture description.';
 await f.store.registerManifest({manifest:next,configuration:f.config,tradingEnabled:false,adopt:false});
 const db=await pool.connect(),blocker=await pool.connect();let outcome:Promise<void>|undefined;
 try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_lock(hashtext($1)::bigint)',[`research-wsh-endpoint:${f.wshSource.parserConfig.endpointId}`]);
  const pid=(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const record=(await db.query('SELECT research_wsh_read_recovery_record($1::jsonb,clock_timestamp()) record',[JSON.stringify(wshIdentity(f))])).rows[0].record;
  await blocker.query('BEGIN');await blocker.query('LOCK TABLE research_recovery_challenges IN ROW EXCLUSIVE MODE');
  outcome=assert.rejects(db.query(`INSERT INTO research_wsh_read_recoveries(id,account_id,config_hash,manifest_hash,instrument_id,source_id,recorded_at,canonical_json,record_hash)
   SELECT $1,$2,$3,$4,$5,$6,$7,research_recovery_canonical($8::jsonb),encode(sha256(convert_to(research_recovery_canonical($8::jsonb),'UTF8')),'hex')`,[randomUUID(),f.accountId,f.identity.configHash,f.identity.manifestHash,f.identity.instrumentId,f.wshSource.id,record.recordedAt,JSON.stringify(record)]),/RESEARCH_AUTHORITY_MISMATCH/);
  let waiting=false;const deadline=Date.now()+2000;
  while(Date.now()<deadline){waiting=(await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='research_recovery_challenges'::regclass AND mode='ShareLock' AND NOT granted",[pid])).rows.length>0;if(waiting)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(waiting,true);
  await blocker.query('UPDATE research_authority SET manifest_hash=$1 WHERE config_hash=$2',[researchHash(next),f.configHash]);await blocker.query('COMMIT');
  await outcome;
 }finally{blocker.release(true);db.release(true);await outcome?.catch(()=>undefined);}
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_read_recoveries')).rows[0].n,0);
}));
