import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {ResearchStore} from '@ikbr/shared/instrument-research';
import {researchFixture} from '@ikbr/shared/instrument-research-testfixture';
import {buildStrategyAttribution,canonicalizeTradingConfiguration} from '@ikbr/shared/trading-config';
import {DiagnosticStore} from '@ikbr/shared/diagnostics';
import {runMigrations} from '../migrations.js';
import {EntryControlStore} from '../entry-control.js';
import {LifecycleAlertStore} from '../lifecycle/lifecycle-alerts.js';
import {assertEnvironmentAllowsWrite} from '../env-guard.js';
import {ExecutionRepository} from '../repository.js';
import {CloseRepository} from '../lifecycle/close-repository.js';
import {FullCloseService} from '../lifecycle/close-service.js';
const account='DU_PP6_SYNTHETIC';
const tables=['schema_migrations','trading_configuration_snapshots','research_manifests','research_authority','research_snapshots','research_snapshot_heads','research_bindings',
 'proposed_orders','proposal_ai_reviews','paper_entry_attempts','broker_order_links','lifecycle_close_operations','lifecycle_supervision',
 'execution_entry_controls','execution_entry_control_events','lifecycle_faults','lifecycle_alert_outbox','lifecycle_alert_delivery_attempts','diagnostic_evaluations','diagnostic_process_heartbeats','diagnostic_retention','diagnostic_coverage_gaps'];
export async function recoveryFingerprint(pool:Pool) {
 const result:Record<string,{count:number;sha256:string}>={};
 for(const table of tables) {
  const rows=(await pool.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows.map(r=>r.row);
  result[table]={count:rows.length,sha256:createHash('sha256').update(rows.join('\n')).digest('hex')};
 }
 return result;
}
export async function seedRecoveryDrill(pool:Pool):Promise<void> {
 await runMigrations(pool); const f=researchFixture(),store=new ResearchStore(pool),listing=f.policy.listing;
 await pool.query('INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)',[f.configHash,canonicalizeTradingConfiguration(f.config)]);
 await store.registerManifest({manifest:f.manifest,configuration:f.config,tradingEnabled:false,adopt:true});
 for(const service of ['execution-engine','llm-agent'] as const) await store.observe({configHash:f.configHash,manifestHash:f.manifestHash,service,processId:service,tradingEnabled:false});
 await store.storeSnapshot(f.snapshot);
 const attribution=buildStrategyAttribution(f.config,f.policy.instrumentId,'momentum_default'),now=new Date(),hash='b'.repeat(64);
 const trigger={version:1,source:'evaluation_bucket',timeframe:'1m',observedAt:now.toISOString(),bucketStartMs:Math.floor(now.getTime()/60000)*60000};
 await pool.query(`INSERT INTO proposed_orders(id,instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,
   client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger,status,execution_account_id,execution_attempted_at)
   VALUES(42,$1,$2,$3,'BUY','LMT',1,100,99,102,'synthetic restore fixture',1,'PASS',$4,2,$5,$6,'PROPOSED',$7,NULL)`,
  [listing.symbol,f.policy.instrumentId,String(listing.conId),hash,attribution,trigger,account]);
 await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger)
   VALUES(42,$1,$2,$3,$4,'old-process',2,$5,$6)`,[hash,f.policy.instrumentId,String(listing.conId),account,attribution,trigger]);
 await store.bind({proposalId:42,clientOrderHash:hash,configHash:f.configHash,manifestHash:f.manifestHash,instrumentId:f.policy.instrumentId});
 await pool.query("UPDATE proposed_orders SET status='UNKNOWN',execution_attempted_at=$1 WHERE id=42",[now]);
 await pool.query(`UPDATE proposal_ai_reviews SET status='REJECTED',decision_json=$1,decided_at=$2 WHERE proposed_order_id=42`,[{decision:'REJECT',reason:'fixture-only'},now]);
 await pool.query(`INSERT INTO paper_entry_attempts(proposed_order_id,account_id,broker,conid,account_date,session_date,session_timezone,attempted_at,source)
   VALUES(42,$1,'ibkr',$2,($3::timestamptz AT TIME ZONE 'Europe/Warsaw')::date,($3::timestamptz AT TIME ZONE 'America/New_York')::date,'America/New_York',$3,'legacy')`,[account,String(listing.conId),now]);
 for(const [index,role] of ['PARENT','TP','SL'].entries()) await pool.query(`INSERT INTO broker_order_links(proposed_order_id,account_id,role,role_ordinal,broker_order_id,order_ref)
   VALUES(42,$1,$2,$3,$4,$5)`,[account,role,index,String(100+index),`synthetic-${role}`]);
 await pool.query(`INSERT INTO lifecycle_close_operations(original_proposal_id,request_id,account_id,session_id,client_id,socket_generation,original_hash,instrument_id,conid,limit_price,owner,actor,state,submission_attempted_at)
   VALUES(42,$1,$2,'old-process',7,1,$3,$4,$5,100,$6,'synthetic','SUBMISSION_UNKNOWN',$7)`,[randomUUID(),account,hash,f.policy.instrumentId,String(listing.conId),randomUUID(),now]);
 await pool.query(`INSERT INTO lifecycle_supervision(original_proposal_id,account_id,original_hash,instrument_id,conid,config_hash,session_identity,policy_source,exit_before_close_minutes,
   session_date,session_start,session_end,exit_deadline,session_generation,status,observation)
   VALUES(42,$1,$2,$3,$4,$5,'{}','ENTRY_RESERVATION',15,$6,$7,$8,$9,1,'HOLD',$10)`,
   [account,hash,f.policy.instrumentId,String(listing.conId),f.configHash,now.toISOString().slice(0,10),new Date(now.getTime()-3600000),new Date(now.getTime()+3600000),new Date(now.getTime()+2700000),{reason:'SUBMISSION_UNKNOWN'}]);
 await new EntryControlStore(pool).adopt(account,false);
 const alerts=new LifecycleAlertStore(pool);await alerts.recordFault({accountId:account,proposalId:42,code:'SUBMISSION_UNKNOWN',evidence:{reason:'fixture-only'}});
 await alerts.startWorkerSession(account,'old-process');
 const claim=await alerts.claimNext([account],'old-process');
 if(claim) await alerts.complete(claim.id,claim.lease_token,{status:'UNKNOWN',errorCode:'fixture_transport_ambiguous'});
 const diagnostic=new DiagnosticStore(pool);
 await diagnostic.heartbeat({accountId:account,processId:'old-process',startedAt:now,seenAt:now,expectedIntervalMs:30000,enabled:false,failedSince:new Date(now.getTime()-30000),failureCount:1});
 await pool.query('UPDATE diagnostic_retention SET pruned_through_at=$2,pruned_count=2 WHERE account_id=$1',[account,new Date(now.getTime()-86400000)]);
 await diagnostic.recordEvaluation({accountId:account,processId:'old-process',cycleId:randomUUID(),instrumentId:f.policy.instrumentId,occurredAt:now,outcome:'SKIPPED',reason:'ENTRY_PAUSED',configHash:f.configHash,proposalId:42});
}
export async function verifyRecoveryDrill(pool:Pool,expected:Awaited<ReturnType<typeof recoveryFingerprint>>):Promise<void> {
 assert.deepEqual(await recoveryFingerprint(pool),expected,'dump/restore changed evidence');
 const control=new EntryControlStore(pool);assert.equal((await control.read(account)).control.paused,true);
 await assert.rejects(control.check({accountId:account,sessionId:'restarted-process',entriesPaused:true,automationEnabled:false},
   {assertCurrent(){},alertFailure:async()=>null}),/PAUSED|OBSERVER|RECONCILIATION|AUTOMATION/);
 assert.throws(()=>assertEnvironmentAllowsWrite({environment:'paper',tradingEnabled:false,allowedPaperAccounts:[account],allowedLiveAccounts:[]},account));
 const close=(await pool.query('SELECT state,submission_attempted_at,request_id FROM lifecycle_close_operations WHERE original_proposal_id=42')).rows[0];
 assert.equal(close.state,'SUBMISSION_UNKNOWN');assert.ok(close.submission_attempted_at);assert.ok(close.request_id);
 let externalCalls=0;
 const forbidden=():never=>{externalCalls++;throw Error('RESTORE_MUST_NOT_CALL_BROKER_RISK_OR_ALERTS');};
 const closeService=new FullCloseService(new CloseRepository(pool,new ExecutionRepository(pool)),{
  context:forbidden,refresh:forbidden,evaluate:forbidden,assessRisk:forbidden,prepare:forbidden,
  validatePrepared:forbidden,cancel:forbidden,dispatch:forbidden,alert:forbidden,
 });
 const replay=await closeService.request(42,close.request_id,100,'restore-fixture');
 assert.equal(replay.state,'SUBMISSION_UNKNOWN');
 await assert.rejects(closeService.request(42,randomUUID(),100,'restore-fixture'),/close_request_conflict/);
 assert.equal(externalCalls,0,'restored unknown close must not refresh, cancel, dispatch or notify');
 assert.equal((await pool.query('SELECT status FROM lifecycle_supervision WHERE original_proposal_id=42')).rows[0].status,'HOLD');
 assert.equal((await pool.query('SELECT count(*)::int n FROM paper_entry_attempts WHERE proposed_order_id=42')).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM broker_order_links WHERE proposed_order_id=42')).rows[0].n,3);
 assert.deepEqual(await recoveryFingerprint(pool),expected,'verification mutated durable records');
}
async function main() {
 const target=process.env.TEST_POSTGRES_URL;
 if(!target||!/^\/pp6_restore_[a-z0-9_]+$/.test(new URL(target).pathname)) throw Error('ISOLATED_PP6_RESTORE_DATABASE_REQUIRED');
 const pool=new Pool({connectionString:target});
 try {
  if(process.argv[2]==='seed') { await seedRecoveryDrill(pool);process.stdout.write(JSON.stringify(await recoveryFingerprint(pool))+'\n'); }
  else if(process.argv[2]==='verify') { await verifyRecoveryDrill(pool,JSON.parse(readFileSync(0,'utf8')));process.stdout.write('PASS: kopia i odtworzenie zachowują dowody, pauzę i UNKNOWN; brak połączenia z brokerem.\n'); }
  else throw Error('RESTORE_DRILL_COMMAND_REQUIRED');
 }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(()=>{process.stderr.write('Próba odtworzenia NIEUDANA. Brak uprawnienia do uruchomienia handlu.\n');process.exitCode=1;});
