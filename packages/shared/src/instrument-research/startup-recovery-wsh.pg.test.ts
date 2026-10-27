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
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && (url.port === '55434' && url.pathname === '/ikbr_startup_recovery_test' || process.env.CI === 'true' && url.port === '5432' && url.pathname === '/ikbr_trader_ci'));
  url.pathname = '/postgres'; const admin = new Pool({ connectionString: url.href }), name = 'startup_wsh_' + randomUUID().replaceAll('-', '');
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

test('legacy pending WSH recovery settles only missing outcomes, preserves budgets and requires fresh data', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }), id = await pendingLegacy(f);
  const before = (await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n;
  await advance(40000); await f.observe(); await pause(f, pool);
  const c = await f.store.prepareResearchRecovery(recoveryIdentity(f)); assert.equal(c.predecessors.length, 1); assert.equal(c.predecessors[0].kind, 'WSH_ACQUISITION');
  const { input, receipt } = await commit(f, c);
  assert.equal((await f.store.readResearchRecoveryReceipt(c.id, input.operationId))?.evidenceHash, researchHash(input.evidence));
  assert.equal((await f.store.readResearchRecoveryReceipt(c.id, randomUUID())), null);
  assert.equal((await pool.query('SELECT state FROM research_wsh_acquisitions WHERE id=$1', [id])).rows[0].state, 'UNKNOWN');
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_call_reservations')).rows[0].n, before);
  assert.equal((await pool.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1', [c.endpointId])).rows[0].generation, String(Number(c.endpointGeneration) + 1));
  await f.observe(); assert.notEqual((await f.store.prepareRepair(f.identity)).state, 'READY');
  await advance(3600000); await f.observe(); await f.publishWsh(); await f.publishNews();
  assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
  await assert.rejects(pool.query('DELETE FROM research_wsh_recovery_receipts WHERE id=$1', [receipt.id]), /immutable/i);
}));

test('PREPARED hold fences usable cleanup-unknown success and receipt cannot resurrect that cache', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }), id = await publishUnknownCleanup(f);
  assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
  const old = (await pool.query('SELECT row_to_json(a) AS value FROM research_wsh_refresh_attempts a WHERE id=$1', [id])).rows[0].value;
  await pause(f, pool); const c = await f.store.prepareResearchRecovery(recoveryIdentity(f));
  await f.observe(); assert.equal((await f.store.prepareRepair(f.identity)).state, 'HOLD');
  const other = f.manifest.instruments.find(p => p.instrumentId !== f.identity.instrumentId)!;
  assert.equal((await f.store.prepareRepair({ ...f.identity, instrumentId: other.instrumentId })).state, 'HOLD');
  await pause(f, pool); await commit(f, c); await f.observe();
  assert.deepEqual((await pool.query('SELECT row_to_json(a) AS value FROM research_wsh_refresh_attempts a WHERE id=$1', [id])).rows[0].value, old);
  assert.notEqual((await f.store.prepareRepair(f.identity)).state, 'READY');
  await advance(3600000); await f.observe();
  await f.store.withWshEndpointLock(c.endpointId!, async lease => {
    const claim = await f.store.claimWshAttempt(lease, { ...wshIdentity(f), sessionId: randomUUID() }, 'regular'); assert.equal(claim.state, 'CLAIMED');
  });
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_recovery_successors')).rows[0].n, 1);
  await advance(40000); await f.observe();
  assert.notEqual((await f.store.prepareRepair(f.identity)).state, 'READY');
  await f.store.withWshEndpointLock(c.endpointId!, async lease => {
    const claim = await f.store.claimWshAttempt(lease, { ...wshIdentity(f), sessionId: randomUUID() }, 'regular'); assert.notEqual(claim.state, 'CLAIMED');
  });
}));

test('WSH reset proof rejects wrong account, changed predecessor hash and unconfirmed local close', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }); await pendingLegacy(f); await advance(40000); await f.observe(); await pause(f, pool);
  const c = await f.store.prepareResearchRecovery(recoveryIdentity(f));
  for (const defect of ['account', 'hash', 'closure']) {
    const e = evidence(c); if (defect === 'account') e.reconnect.accountId = 'DU_OTHER';
    if (defect === 'hash') e.challengeHash = '0'.repeat(64); if (defect === 'closure') e.reconnect.cleanup.verifiedLocalClosure = false;
    await assert.rejects(f.store.commitResearchRecovery({ challengeId: c.id, challengeHash: c.challengeHash, operationId: randomUUID(), actor: c.actor, pauseRevision: c.pauseRevision, evidence: e }));
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_recovery_receipts')).rows[0].n, 0);
  assert.equal((await f.store.readResearchRecovery(c.id))?.state, 'PREPARED');
}));

test('endpoint recovery includes another issuer and account scope without fabricating local closure', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false });
  const other = f.manifest.instruments.find(p => p.instrumentId !== f.identity.instrumentId)!, source = other.sources.find(s => s.adapter === 'ibkr-wsh')!;
  const id = await pendingLegacy({ ...f, policy: other, wshSource: source, identity: { ...f.identity, accountId: 'DU_OTHER', instrumentId: other.instrumentId } });
  await advance(40000); await f.observe(); await pause(f, pool);
  const c = await f.store.prepareResearchRecovery(recoveryIdentity(f));
  assert.equal(c.predecessors[0].id, id); assert.equal(c.predecessors[0].ledgerKey, `ibkr-wsh:${source.parserConfig.isin}`);
  await commit(f, c);
  const stored = (await pool.query('SELECT state,session_id FROM research_wsh_acquisitions WHERE id=$1', [id])).rows[0];
  assert.equal(stored.state, 'UNKNOWN'); assert.equal(stored.session_id, c.predecessors[0].sessionId);
}));

test('two competing operator commits produce exactly one receipt and one endpoint generation change', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }); await pendingLegacy(f); await advance(40000); await f.observe(); await pause(f, pool);
  const c = await f.store.prepareResearchRecovery(recoveryIdentity(f));
  const make = () => ({ challengeId: c.id, challengeHash: c.challengeHash, operationId: randomUUID(), actor: c.actor, pauseRevision: c.pauseRevision, evidence: evidence(c) });
  const result = await Promise.allSettled([f.store.commitResearchRecovery(make()), f.store.commitResearchRecovery(make())]);
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_recovery_receipts')).rows[0].n, 1);
  assert.equal(Number((await pool.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1', [c.endpointId])).rows[0].generation), Number(c.endpointGeneration) + 1);
}));

test('same issuer uncertainty on another historical endpoint requires that endpoint proof', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false, configureManifest: manifest => {
    manifest.instruments.find(p => p.instrumentId === 'aapl_smart')!.sources.find(s => s.adapter === 'ibkr-wsh')!.parserConfig.endpointId = 'other-endpoint';
  } });
  await pendingLegacy(f); await advance(40000);
  // Synthetic historical authority transition; ordinary adoption correctly rejects unfinished work.
  // Both canonical manifests remain stored; no production transition is relaxed.
  f.wshSource.parserConfig.endpointId = 'fixture-endpoint';
  f.identity.manifestHash = researchHash(f.manifest);
  await f.store.registerManifest({ manifest: f.manifest, configuration: f.config, tradingEnabled: false, adopt: false });
  await pool.query('UPDATE research_authority SET manifest_hash=$1 WHERE config_hash=$2', [f.identity.manifestHash, f.configHash]);
  await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds'");
  await pool.query("UPDATE trading_configuration_observations SET observed_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 seconds'");
  await f.store.observe({ ...f.identity, service: 'execution-engine', processId: randomUUID(), tradingEnabled: false });
  await pause(f, pool);
  await assert.rejects(f.store.prepareResearchRecovery(recoveryIdentity(f)), /OTHER_ENDPOINT_REQUIRED/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM research_recovery_challenges')).rows[0].n, 0);
}));

test('expired challenge and changed endpoint generation preserve hold without receipts', { skip: !connection }, async () => {
  for (const defect of ['expired', 'generation']) await isolated(async (pool, advance) => {
    const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }); await pendingLegacy(f); await advance(40000); await f.observe(); await pause(f, pool);
    const c = await f.store.prepareResearchRecovery(recoveryIdentity(f));
    if (defect === 'expired') { await advance(900001); await f.observe(); await pause(f, pool); }
    else await pool.query('UPDATE research_wsh_endpoints SET generation=generation+1 WHERE endpoint_id=$1', [c.endpointId]);
    await assert.rejects(commit(f, c), /CHALLENGE_EXPIRED|ENDPOINT_CHANGED/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_recovery_receipts')).rows[0].n, 0);
    await f.observe(); assert.equal((await f.store.prepareRepair(f.identity)).state, 'HOLD');
  });
});

test('receipt first successor is regular; its confirmed transient failure permits retry and new UNKNOWN blocks again', {skip:!connection},()=>isolated(async(pool,advance)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false}),oldId=await publishUnknownCleanup(f);await pause(f,pool);
 const c=await f.store.prepareResearchRecovery(recoveryIdentity(f));await commit(f,c);await f.observe();
 await f.store.withWshEndpointLock(c.endpointId!,async lease=>{
  const retry=await f.store.claimWshAttempt(lease,{...wshIdentity(f),sessionId:randomUUID()},'retry');assert.equal(retry.state,'DEFERRED');
  if(retry.state==='DEFERRED')assert.equal(retry.reason,'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED');
 });
 await assert.rejects(pool.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,predecessor_id,endpoint_id,session_id,started_at,deadline_at,state)
  SELECT $1,cycle_id,1,id,endpoint_id,$2,clock_timestamp(),clock_timestamp()+interval '35 seconds','STARTED' FROM research_wsh_refresh_attempts WHERE id=$3`,[randomUUID(),randomUUID(),oldId]),/CLEANUP_RECOVERY_REQUIRED/);
 await advance(3600000);await f.observe();
 let firstId='';
 const fail=async(kind:'regular'|'retry',uncertain:boolean)=>f.store.withWshEndpointLock(c.endpointId!,async lease=>{
  const claimed=await f.store.claimWshAttempt(lease,{...wshIdentity(f),sessionId:randomUUID()},kind);assert.equal(claimed.state,'CLAIMED');if(claimed.state!=='CLAIMED')return;
  if(kind==='regular')firstId=claimed.ticket.id;else assert.equal(claimed.ticket.ordinal,1);
  const stamp=new Date(await f.clock()).toISOString(),snapshot=f.empty(stamp);snapshot.coverage.push({sourceId:f.wshSource.id,role:'calendar',status:'ERROR',complete:false,checkedAt:stamp,windowStart:stamp,windowEnd:stamp,evidenceRefs:[],reason:'RESEARCH_WSH_TEST_FAILURE'});
  await f.store.finishWshAttempt(lease,claimed.ticket,{outcome:uncertain?'UNKNOWN':'FAILED',failureClass:uncertain?'UNCERTAIN':'TRANSIENT',failureReason:'RESEARCH_WSH_TEST_FAILURE',stage:'connect',snapshot,
   cleanup:{sessionId:claimed.ticket.sessionId,state:uncertain?'UNKNOWN':'CONFIRMED',verifiedLocalClosure:!uncertain,completedAt:stamp,cancellationAttemptedAt:null,disconnectRequestedAt:stamp,localClosedAt:uncertain?null:stamp}});
 });
 await fail('regular',false);assert.equal((await pool.query('SELECT attempt_id FROM research_wsh_recovery_successors')).rows[0].attempt_id,firstId);
 await advance(31000);await f.observe();await fail('retry',true);await advance(121000);await f.observe();
 await f.store.withWshEndpointLock(c.endpointId!,async lease=>{
  const retry=await f.store.claimWshAttempt(lease,{...wshIdentity(f),sessionId:randomUUID()},'retry');assert.equal(retry.state,'DEFERRED');if(retry.state==='DEFERRED')assert.equal(retry.reason,'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED');
 });
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_recovery_successors')).rows[0].n,1);
}));

function heldPreparePool(pool:any){
 let release!:()=>void,notify!:()=>void;const reached=new Promise<void>(r=>{notify=r;}),gate=new Promise<void>(r=>{release=r;});
 return {reached,release:()=>release(),pool:{query:pool.query.bind(pool),connect:async()=>{
  const client=await pool.connect();let targeted=false;
  return {release:client.release.bind(client),query:async(sql:string,values?:unknown[])=>{
   if(sql.includes('INSERT INTO research_recovery_challenges('))targeted=true;
   if(targeted&&sql==='COMMIT'){notify();await gate;}
   return client.query(sql,values);
  }};
 }}};
}
async function expectChallengeLock(pool:any,pid:number){
 const end=Date.now()+2000;
 while(Date.now()<end){const row=(await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='research_recovery_challenges'::regclass AND mode='ShareLock' AND NOT granted",[pid])).rows[0];if(row)return;await new Promise<void>(resolve=>setImmediate(resolve));}
 assert.fail('SQL admission did not wait for the uncommitted maintenance hold');
}
for(const kind of ['acquisition','attempt'] as const)test(`SQL ${kind} admission waits for uncommitted PREPARED hold then rejects`,{skip:!connection},()=>isolated(async(pool)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await publishUnknownCleanup(f);
 const other=f.manifest.instruments.find(p=>p.instrumentId!==f.identity.instrumentId)!,source=other.sources.find(s=>s.adapter==='ibkr-wsh')!,cycle=randomUUID();
 if(kind==='attempt')await pool.query(`INSERT INTO research_wsh_refresh_cycles(id,ledger_key,config_hash,manifest_hash,instrument_id,source_id,account_id,source_policy_hash,started_at,next_regular_at)
  SELECT $1,$2,$3,$4,$5,$6,$7,$8,stamp,stamp+interval '1 hour' FROM (SELECT clock_timestamp() AS stamp) t`,[cycle,`ibkr-wsh:${source.parserConfig.isin}`,f.configHash,f.manifestHash,other.instrumentId,source.id,f.accountId,researchHash(source)]);
 await pause(f,pool);const held=heldPreparePool(pool),store=new ResearchStore(held.pool),preparing=store.prepareResearchRecovery(recoveryIdentity(f));
 await held.reached;const client=await pool.connect();let inserting:Promise<unknown>|undefined;
 try{
  const pid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  inserting=(kind==='acquisition'?client.query(`INSERT INTO research_wsh_acquisitions(id,endpoint_id,generation,session_id,source_id,instrument_id,ledger_key,config_hash,manifest_hash,state)
   VALUES($1,$2,999,$3,$4,$5,$6,$7,$8,'PENDING')`,[randomUUID(),String(f.wshSource.parserConfig.endpointId),randomUUID(),source.id,other.instrumentId,`ibkr-wsh:${source.parserConfig.isin}`,f.configHash,f.manifestHash]):
   client.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,endpoint_id,session_id,started_at,deadline_at,state)
    SELECT $1,id,0,$2,$3,started_at,started_at+interval '35 seconds','STARTED' FROM research_wsh_refresh_cycles WHERE id=$4`,[randomUUID(),String(f.wshSource.parserConfig.endpointId),randomUUID(),cycle]));
  const rejected=assert.rejects(inserting,/RESEARCH_RECOVERY_MAINTENANCE_HOLD/);await expectChallengeLock(pool,pid);held.release();await preparing;await rejected;
 }finally{held.release();await preparing.catch(()=>{});if(inserting)await inserting.catch(()=>{});client.release();}
}));

for(const defect of ['fresh drifting llm','stale execution','changed execution process'] as const)test(`${defect} rejects maintenance commit without releasing hold`,{skip:!connection},()=>isolated(async(pool)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await publishUnknownCleanup(f);await pause(f,pool);
 const c=await f.store.prepareResearchRecovery(recoveryIdentity(f));
 if(defect==='fresh drifting llm'){
  const manifest=structuredClone(f.manifest);manifest.instruments[0].business+=' Other manifest.';
  const {hash}=await f.store.registerManifest({manifest,configuration:f.config,tradingEnabled:false,adopt:false});
  await f.store.observe({...f.identity,manifestHash:hash,service:'llm-agent',processId:randomUUID(),tradingEnabled:false});
 }else if(defect==='stale execution')await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds' WHERE service='execution-engine'");
 else{
  await pool.query("UPDATE research_observations SET observed_at=clock_timestamp()-interval '31 seconds',expires_at=clock_timestamp()-interval '2 seconds' WHERE service='execution-engine'");
  await f.store.observe({...f.identity,service:'execution-engine',processId:randomUUID(),tradingEnabled:false});
 }
 await assert.rejects(commit(f,c),/EXECUTION_AUTHORITY_INVALID/);
 assert.equal((await pool.query('SELECT state FROM research_recovery_challenges WHERE id=$1',[c.id])).rows[0].state,'PREPARED');
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_recovery_receipts')).rows[0].n,0);
}));

test('PREPARED hold rejects both actual bind and validation of an otherwise eligible binding', {skip:!connection},()=>isolated(async(pool)=>{
 const f=await seedTwoSourceResearchStore(pool,{publishWsh:false});await publishUnknownCleanup(f);
 const hash='b'.repeat(64),listing=f.policy.listing,stamp=new Date(await f.clock()).toISOString(),attribution=buildStrategyAttribution(f.config,f.identity.instrumentId,'momentum_default');
 const trigger={version:1,source:'evaluation_bucket',timeframe:'1m',observedAt:stamp,bucketStartMs:Math.floor(Date.parse(stamp)/60000)*60000};
 const row=(await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger)
  VALUES($1,$2,$3,'BUY','LMT',1,100,99,102,'fixture',1,'PASS',$4,2,$5,$6) RETURNING id`,[listing.symbol,f.identity.instrumentId,String(listing.conId),hash,attribution,trigger])).rows[0];
 await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger)
  VALUES($1,$2,$3,$4,$5,'fixture',2,$6,$7)`,[row.id,hash,f.identity.instrumentId,String(listing.conId),f.accountId,attribution,trigger]);
 const binding={...f.identity,proposalId:Number(row.id),clientOrderHash:hash};
 assert.equal((await f.store.bind(binding)).eligibility.eligible,true);assert.equal((await f.store.validateBinding(binding)).eligibility.eligible,true);
 await pause(f,pool);await f.store.prepareResearchRecovery(recoveryIdentity(f));await f.observe();
 await assert.rejects(f.store.bind(binding),/RESEARCH_RECOVERY_MAINTENANCE_HOLD/);
 await assert.rejects(f.store.validateBinding(binding),/RESEARCH_RECOVERY_MAINTENANCE_HOLD/);
 assert.equal((await pool.query('SELECT count(*)::int n FROM research_bindings')).rows[0].n,1);
}));


test('created producer WSH proof retains reset requirements, PREPARED hold, immutable history and budgets', { skip: !connection }, () => isolated(async (pool, advance) => {
  const f = await seedTwoSourceResearchStore(pool, { publishWsh: false }), id = await publishUnknownCleanup(f);
  const original = (await pool.query('SELECT * FROM research_wsh_refresh_attempts WHERE id=$1', [id])).rows[0];
  const acquisitions = (await pool.query('SELECT * FROM research_wsh_acquisitions ORDER BY id')).rows;
  const reservations = (await pool.query('SELECT * FROM research_call_reservations ORDER BY call_key')).rows;
  const outcomes = (await pool.query('SELECT * FROM research_call_outcomes ORDER BY call_key')).rows;
  await pause(f, pool); const c = await f.store.prepareResearchRecovery(recoveryIdentity(f));
  const proof = evidence(c);
  proof.producers = [{ ...proof.producers[0], state: 'created', createdAt: proof.producers[0].startedAt!, startedAt: null, finishedAt: null }];
  for (const defect of ['missing-before', 'missing-stopped', 'missing-after', 'missing-reconnect', 'same-process', 'account', 'cleanup']) {
    const invalid = structuredClone(proof);
    if (defect.startsWith('missing-')) Reflect.deleteProperty(invalid, defect.slice(8));
    if (defect === 'same-process') invalid.after.process.startIdentity = invalid.before.process.startIdentity;
    if (defect === 'account') invalid.reconnect.accountId = 'DU_OTHER';
    if (defect === 'cleanup') invalid.reconnect.cleanup.verifiedLocalClosure = false;
    await assert.rejects(f.store.commitResearchRecovery({ challengeId: c.id, challengeHash: c.challengeHash, operationId: randomUUID(), actor: c.actor, pauseRevision: 1, evidence: invalid }));
    assert.equal((await f.store.readResearchRecovery(c.id))?.state, 'PREPARED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM research_wsh_recovery_receipts')).rows[0].n, 0);
    assert.deepEqual((await pool.query('SELECT * FROM research_call_reservations ORDER BY call_key')).rows, reservations);
  }
  await f.observe(); assert.equal((await f.store.prepareRepair(f.identity)).state, 'HOLD'); await pause(f, pool);
  const operationId = randomUUID(), receipt = await f.store.commitResearchRecovery({ challengeId: c.id, challengeHash: c.challengeHash, operationId, actor: c.actor, pauseRevision: 1, evidence: proof });
  const audit = (await pool.query('SELECT evidence_json,evidence_hash FROM research_recovery_audit WHERE operation_id=$1', [operationId])).rows[0];
  assert.deepEqual(JSON.parse(audit.evidence_json), proof); assert.equal(audit.evidence_hash, researchHash(proof)); assert.equal(receipt.evidenceHash, researchHash(proof));
  assert.deepEqual((await pool.query('SELECT * FROM research_wsh_refresh_attempts WHERE id=$1', [id])).rows[0], original);
  assert.deepEqual((await pool.query('SELECT * FROM research_wsh_acquisitions ORDER BY id')).rows, acquisitions);
  assert.deepEqual((await pool.query('SELECT * FROM research_call_reservations ORDER BY call_key')).rows, reservations);
  assert.deepEqual((await pool.query('SELECT * FROM research_call_outcomes ORDER BY call_key')).rows, outcomes);
  assert.equal(Number((await pool.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1', [c.endpointId])).rows[0].generation), Number(c.endpointGeneration) + 1);
  await f.observe(); assert.notEqual((await f.store.prepareRepair(f.identity)).state, 'READY');
  await advance(3600000); await f.observe(); await f.publishWsh(); await f.publishNews();
  assert.equal((await f.store.prepareRepair(f.identity)).state, 'READY');
}));
