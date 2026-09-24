import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadDurableReadiness } from './durable-readiness.js';
import { evaluateReadiness } from '../readiness.js';
import type { ReconciliationRunRow } from './repository.js';
const now=new Date('2026-09-24T12:00:00Z');
export function readinessRun(patch:Partial<ReconciliationRunRow>={}):ReconciliationRunRow {
 return {id:1,accountId:'PAPER-TEST',sessionId:'session',startedAt:new Date(now.getTime()-2000),completedAt:new Date(now.getTime()-1000),status:'CLEAN',snapshotCapturedAt:now,snapshotComplete:true,
 sourceCoverage:{positions:{available:true,boundedWindow:true},openOrders:{available:true,boundedWindow:true},session:{available:true},completedOrders:{available:true,boundedWindow:true},executions:{available:true,window:{exposureWindowComplete:true,recoveryWindowComplete:true}}},expectedPositionsCount:0,brokerPositionsCount:0,matches:0,mismatchesCount:0,error:null,report:null,...patch};
}
for(const mode of ['fresh','stale','boundary','running','failed','abandoned','foreign','missing','null_time','future','invalid','db_error','reconnect','account_change'] as const)test(`durable production readiness ${mode}`,async()=>{
 const identity={accountId:'PAPER-TEST',generation:1,connected:true};let run:ReconciliationRunRow|null=readinessRun();
 if(mode==='stale')run=readinessRun({completedAt:new Date(now.getTime()-901000)});
 if(mode==='boundary')run=readinessRun({completedAt:new Date(now.getTime()-900000)});
 if(mode==='failed'||mode==='abandoned')run=readinessRun({status:mode==='failed'?'FAILED':'ABANDONED'});
 if(mode==='foreign')run=readinessRun({sessionId:'previous'});
 if(mode==='missing')run=null;
 if(mode==='null_time')run=readinessRun({completedAt:null});
 if(mode==='future')run=readinessRun({completedAt:new Date(now.getTime()+1)});
 if(mode==='invalid')run=readinessRun({completedAt:new Date(NaN)});
 const evidence=await loadDurableReadiness({sessionId:'session',now:()=>now,current:()=>identity,repository:{getReadinessEvidence:async()=>{
  if(mode==='db_error')throw Error('unavailable');if(mode==='reconnect')identity.generation++;if(mode==='account_change')identity.accountId='OTHER';
  return {running:mode==='running',latest:run};
 }}});
 const result=evaluateReadiness({...evidence,now,environment:'paper',tradingEnabled:false,brokerSocketUp:true,activeAccountId:'PAPER-TEST',accountAllowedByEnvironment:true,auditWriteAvailable:true,reconciliationMaxAgeSeconds:900,positionSnapshotHealth:{kind:'healthy'}});
 assert.equal(result.statusCode,['fresh','boundary'].includes(mode)?200:503);
 if(mode==='fresh')assert.equal(result.body.reconciliation.lastRanAt,run!.completedAt!.toISOString());
});
test('actual /ready wires freshness and health to same durable helper without legacy timestamp',async()=>{
 const source=await readFile(new URL('../index.ts',import.meta.url),'utf8');const handler=source.slice(source.indexOf('app.get("/ready"'),source.indexOf('app.get("/ready"')+2600);
 assert.match(handler,/await loadDurableReadiness/);assert.match(handler,/lastReconciliationAt: durable.lastReconciliationAt/);assert.match(handler,/reconciliationRunHealth: durable.reconciliationRunHealth/);
 assert.doesNotMatch(handler,/\n\s*lastReconciliationAt,/);
});

for (const mode of ['recovery_only', 'recovery_stale', 'recovery_future', 'exposure_missing'] as const) test(`durable readiness preserves per-instrument recovery policy ${mode}`, async () => {
 const run = readinessRun(mode === 'recovery_stale' ? { completedAt: new Date(now.getTime() - 901000) }
  : mode === 'recovery_future' ? { completedAt: new Date(now.getTime() + 1) } : {});
 const coverage = run.sourceCoverage as Record<string, unknown>;
 coverage.completedOrders = { available: false, boundedWindow: false };
 if (mode === 'exposure_missing') coverage.positions = { available: false, boundedWindow: false };
 const evidence = await loadDurableReadiness({ sessionId: 'session', now: () => now,
  current: () => ({ accountId: 'PAPER-TEST', generation: 1, connected: true }),
  repository: { getReadinessEvidence: async () => ({ running: false, latest: run }) } });
 const result = evaluateReadiness({ ...evidence, now, environment: 'paper', tradingEnabled: false,
  brokerSocketUp: true, activeAccountId: 'PAPER-TEST', accountAllowedByEnvironment: true,
  auditWriteAvailable: true, reconciliationMaxAgeSeconds: 900, positionSnapshotHealth: { kind: 'healthy' } });
 assert.equal(result.statusCode, mode === 'recovery_only' ? 200 : 503);
 if (mode === 'recovery_only') {
  assert.equal(evidence.reconciliationRunHealth.kind, 'incomplete_recovery');
  assert.equal(result.body.reconciliation.lastRanAt, run.completedAt!.toISOString());
 }
 if (mode === 'recovery_stale') assert.ok(result.body.reasons.includes('reconciliation_stale'));
 if (mode === 'exposure_missing') assert.ok(result.body.reasons.includes('reconciliation_incomplete_exposure'));
});
