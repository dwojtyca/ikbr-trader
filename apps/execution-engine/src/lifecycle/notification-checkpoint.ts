import type { Pool, PoolClient } from 'pg';
import type { ExecutionRepository } from '../repository.js';
import type { BrokerReconciliationCaptureRequest, BrokerReconciliationSnapshot } from '../reconciliation/broker-adapter.js';
import { findAccountReservation } from '../ai-proposal-review.js';
import type { LifecycleLegLink } from './ownership.js';
import type { LifecycleCycle } from './cycle-evidence.js';
import { terminalCycleFailure, cycleForRow, matchesCycleLink } from './cycle-evidence.js';

export interface NotificationContext { accountId: string; sessionId: string; generation: number; connected: boolean }
export interface NotificationProof { runId: number; sessionId: string; generation: number; validUntil: Date }
export interface NotificationEligibility {
  isCurrent(accountId: string, proof: NotificationProof): boolean;
  eligible(db: PoolClient, accountId: string, resolving?: boolean): Promise<NotificationProof | null>;
}
const terminal = (status: string) => typeof status==='string' && ['FILLED','CANCELLED','APICANCELLED','INACTIVE'].includes(status.replaceAll(' ', '').toUpperCase());
export function isFlatNotificationSnapshot(s: BrokerReconciliationSnapshot): boolean {
  if (!s || !s.sourceCoverage || !Array.isArray(s.positions)||!Array.isArray(s.openOrders)||!Array.isArray(s.completedOrders)||!Array.isArray(s.executions))return false;
  if (!s.exposureComplete || !s.recoveryComplete || !Number.isSafeInteger(s.connectionGeneration) || Number(s.connectionGeneration)<=0) return false;
  for (const name of ['positions','openOrders','executions','completedOrders','session'] as const) {
    const c=s.sourceCoverage[name];
    if(!c || typeof c!=='object')return false;
    if (!c.available || c.timedOut || !Number.isSafeInteger(c.count) || c.count<0 ||
      (name!=='executions' && (!('boundedWindow' in c) || !c.boundedWindow))) return false;
  }
  if (s.sourceCoverage.positions.count<s.positions.length || s.sourceCoverage.openOrders.count!==s.openOrders.length ||
      s.sourceCoverage.executions.count!==s.executions.length || s.sourceCoverage.completedOrders.count!==s.completedOrders.length) return false;
  const known = (r: { accountId?: string | null; conId?: string | null; secType?: string | null }) =>
    typeof r.accountId==='string' && r.accountId.length>0 && typeof r.conId==='string' && r.conId.length>0 && typeof r.secType==='string' && r.secType.length>0;
  return s.positions.every(r=>!!r && known(r) && Number.isFinite(r.position) && (r.accountId!==s.accountId || r.position===0)) &&
    s.openOrders.every(r=>!!r && known(r) && r.accountId!==s.accountId) &&
    s.completedOrders.every(r=>!!r && known(r) && Number.isFinite(r.remaining) && Number(r.remaining)>=0 && terminal(r.terminalStatus ?? r.status)) &&
    s.executions.every(r=>!!r && known(r) && Number.isFinite(r.shares) && r.shares>0) &&
    s.sourceCoverage.executions.window?.exposureWindowComplete && s.sourceCoverage.executions.window.recoveryWindowComplete;
}

export class LifecycleNotificationCheckpoint implements NotificationEligibility {
  private readonly proofExpiries=new WeakMap<NotificationProof,number>();
  isCurrent(accountId:string,proof:NotificationProof):boolean {
    const expires=this.proofExpiries.get(proof);
    return expires!==undefined && performance.now()<expires && this.current(accountId,proof.sessionId,proof.generation);
  }
  constructor(private readonly pool: Pool, private readonly execution: Pick<ExecutionRepository,'getRoundTripEvidence'>,
    private readonly context: ()=>NotificationContext|null) {}
  private current(accountId: string, sessionId: string, generation: number): boolean {
    const c=this.context(); return !!c && c.connected && c.accountId===accountId && c.sessionId===sessionId && c.generation===generation;
  }
  async publish(snapshot: BrokerReconciliationSnapshot, req: BrokerReconciliationCaptureRequest, startedAt: Date, sources: Record<string,string>): Promise<void> {
    if (!req.reconciliationRunId || !req.positionGeneration || !isFlatNotificationSnapshot(snapshot) ||
      !this.current(snapshot.accountId,snapshot.sessionId,snapshot.connectionGeneration!)) return;
    const budget=Math.min(1000,req.sourceTimeoutMs);
    const deadline=Date.now()+budget;
    let expired=false, db:PoolClient|undefined, released=false;
    let rejectBudget!:(error:Error)=>void;
    const cancelled=new Promise<never>((_resolve,reject)=>{rejectBudget=reject;});
    const expire=()=>{expired=true;if(db&&!released){released=true;db.release(true);}rejectBudget(new Error('notification_checkpoint_deadline'));};
    const timer=setTimeout(expire,budget);
    req.abortSignal.addEventListener('abort',expire,{once:true});
    const work=(async()=>{
    db=await this.pool.connect();
    if(expired||req.abortSignal.aborted){if(!released){released=true;db.release();}return;}
    try {
      await db.query('BEGIN');
      await db.query("SELECT set_config('statement_timeout',$1,true)",[String(Math.max(1,deadline-Date.now()))]);
      const locked=(await db.query('SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS acquired',[`snap:${snapshot.accountId}`])).rows[0]?.acquired;
      if(!locked){await db.query('ROLLBACK');return;}
      const row=(await db.query(`SELECT r.id,s.generation,clock_timestamp() AS now FROM reconciliation_runs r
        JOIN broker_snapshot_syncs s ON s.account_id=r.account_id WHERE r.id=$1 AND r.account_id=$2 AND r.session_id=$3 AND r.status='RUNNING'
        AND r.position_generation=$4 AND s.generation=$4 AND s.session_id=$3 AND s.complete
        AND r.id=(SELECT id FROM reconciliation_runs WHERE account_id=$2 ORDER BY started_at DESC,id DESC LIMIT 1)`,
      [req.reconciliationRunId,snapshot.accountId,snapshot.sessionId,req.positionGeneration])).rows[0];
      const now=row?new Date(row.now).getTime():NaN;
      if (!expired && !req.abortSignal.aborted && row && startedAt.getTime()<=now && now-startedAt.getTime()<10000 && this.current(snapshot.accountId,snapshot.sessionId,snapshot.connectionGeneration!)) {
        await db.query(`INSERT INTO lifecycle_notification_checkpoints(account_id,session_id,connection_generation,reconciliation_run_id,position_generation,acquisition_started_at,sources_completed_at,captured_at,snapshot)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb) ON CONFLICT(account_id) DO UPDATE SET session_id=EXCLUDED.session_id,
          connection_generation=EXCLUDED.connection_generation,reconciliation_run_id=EXCLUDED.reconciliation_run_id,position_generation=EXCLUDED.position_generation,
          acquisition_started_at=EXCLUDED.acquisition_started_at,sources_completed_at=EXCLUDED.sources_completed_at,captured_at=EXCLUDED.captured_at,snapshot=EXCLUDED.snapshot`,
        [snapshot.accountId,snapshot.sessionId,snapshot.connectionGeneration,req.reconciliationRunId,req.positionGeneration,startedAt,JSON.stringify(sources),snapshot.capturedAt,JSON.stringify(snapshot)]);
      }
      if(expired||req.abortSignal.aborted)return;
      await db.query('COMMIT');
    } catch(e) { if(!released)await db.query('ROLLBACK').catch(()=>undefined); throw e; }
    finally { if(!released){released=true;db.release();} }
    })();
    try { await Promise.race([work,cancelled]); }
    finally { clearTimeout(timer);req.abortSignal.removeEventListener('abort',expire); }
  }
  async eligible(db: PoolClient, accountId: string, resolving=false): Promise<NotificationProof|null> {
    const configured=Number((await db.query("SELECT setting FROM pg_settings WHERE name='statement_timeout'")).rows[0].setting);
    const deadline=performance.now()+Math.min(configured||1000,1000);
    const connection=db;
    db=new Proxy(connection,{get(target,key,receiver){
      if(key!=='query')return Reflect.get(target,key,receiver);
      return async(...args:unknown[])=>{
        const remaining=Math.floor(deadline-performance.now());
        if(remaining<=0)throw new Error('notification_proof_deadline');
        await target.query("SELECT set_config('statement_timeout',$1,true)",[String(remaining)]);
        return Reflect.apply(target.query,target,args);
      };
    }});
    const row=(await db.query(`SELECT c.*,clock_timestamp() AS now,r.status AS run_status,r.completed_at,r.broker_snapshot AS final_snapshot,s.observed_at,
      (SELECT count(*) FROM reconciliation_holds WHERE account_id=$1 AND active) AS holds,
      (SELECT count(*) FROM lifecycle_faults WHERE account_id=$1 AND active AND NOT(code='BROKER_STATE_STALE' AND original_proposal_id IS NULL)) AS faults
      FROM lifecycle_notification_checkpoints c JOIN reconciliation_runs r ON r.id=c.reconciliation_run_id
      JOIN broker_snapshot_syncs s ON s.account_id=c.account_id
      WHERE c.account_id=$1 AND r.session_id=c.session_id AND r.account_id=c.account_id AND r.position_generation=c.position_generation
      AND s.session_id=c.session_id AND s.generation=c.position_generation AND s.complete
      AND r.id=(SELECT id FROM reconciliation_runs WHERE account_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1)`,[accountId])).rows[0];
    if (!row || !this.current(accountId,row.session_id,Number(row.connection_generation)) || Number(row.holds)!==0 || Number(row.faults)!==0) return null;
    const now=new Date(row.now).getTime(), start=new Date(row.acquisition_started_at).getTime();
    const fresh=(v:unknown)=>{const t=new Date(v as string).getTime();return Number.isFinite(t)&&t<=now&&now-t<10000;};
    if (!fresh(row.acquisition_started_at)||!fresh(row.captured_at)||!fresh(row.observed_at)||!['RUNNING','CLEAN'].includes(row.run_status)||
        !isFlatNotificationSnapshot(row.snapshot)) return null;
    for(const key of ['sessionBefore','positions','openOrders','executions','completedOrders','sessionAfter']) {
      const stamp=row.sources_completed_at?.[key]; if(!fresh(stamp)||new Date(stamp).getTime()<start) return null;
    }
    if (resolving && (row.run_status!=='CLEAN'||!fresh(row.completed_at)||!row.final_snapshot||!isFlatNotificationSnapshot(row.final_snapshot))) return null;
    if (await findAccountReservation(db,accountId)) return null;
    const unsafe=await db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM lifecycle_close_operations WHERE account_id=$1 AND state<>'COMPLETED')
      OR EXISTS(SELECT 1 FROM lifecycle_supervision WHERE account_id=$1 AND automatic_request_id IS NOT NULL AND terminal_proof IS NULL)
      OR EXISTS(SELECT 1 FROM paper_entry_migration_holds WHERE account_id=$1 OR account_id IS NULL)
      OR EXISTS(SELECT 1 FROM broker_position_snapshots WHERE account_id=$1 AND quantity<>0)
      OR EXISTS(SELECT 1 FROM paper_entry_attempts a LEFT JOIN lifecycle_supervision s ON s.original_proposal_id=a.proposed_order_id
        WHERE a.account_id=$1 AND (s.terminal_proof IS NULL OR s.status NOT IN ('FLAT','TERMINAL_UNFILLED')))`,[accountId]);
    if(unsafe.rowCount) return null;
    const candidates=await db.query(`SELECT p.id FROM proposed_orders p LEFT JOIN proposal_ai_reviews a ON a.proposed_order_id=p.id
      WHERE p.execution_attempted_at IS NOT NULL AND COALESCE(p.position_effect,'OPEN_OR_ADD')<>'CLOSE_OR_REDUCE'
      AND (p.execution_account_id=$1 OR a.account_id=$1 OR (p.execution_account_id IS NULL AND a.account_id IS NULL)) ORDER BY p.id`,[accountId]);
    const acceptedCycles:LifecycleCycle[]=[];
    const acceptedLegs:Array<{link:LifecycleLegLink;cycle:LifecycleCycle;conid:string|null|undefined;quantity:number;currency:string|null}>=[];
    for(const r of candidates.rows) {
      const id=Number(r.id), evidence=await this.execution.getRoundTripEvidence(id,accountId,db);
      const cycle=evidence?.lifecycle.cycles?.find(c=>c.proposalId===id);
      if(!evidence||!cycle||terminalCycleFailure(cycle,evidence.lifecycle,{accountId,sessionId:row.session_id,nowMs:now,bound:null})) return null;
      acceptedCycles.push(cycle);
      for(const link of cycle.links)acceptedLegs.push({link,cycle,conid:evidence.lifecycle.order.conid,quantity:evidence.lifecycle.order.quantity,currency:cycle.terminalProof!.report.quoteCurrency});
    }
    const executionIds=new Set<string>();
    const instant=(value:unknown)=>value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;
    for(const execution of row.snapshot.executions as Record<string,unknown>[]) {
      if(execution.accountId!==accountId)continue;
      if(typeof execution.execId!=='string'||!execution.execId||executionIds.has(execution.execId))return null;
      executionIds.add(execution.execId);
      const cycle=cycleForRow(execution,acceptedCycles);
      if(!cycle||!cycle.terminalProof!.executionIds.includes(execution.execId))return null;
      const owners=acceptedLegs.filter(leg=>leg.cycle===cycle&&matchesCycleLink(execution,leg.link));
      const fills=cycle.terminalProof!.report.fills.filter(fill=>fill.execId===execution.execId);
      if(owners.length!==1||fills.length!==1)return null;
      const {link,conid}=owners[0],fill=fills[0],executedAt=instant(execution.executedAt);
      if(fill.role!==link.role||execution.conId!==conid||execution.secType!=='STK'||
        typeof fill.currency!=='string'||!fill.currency||execution.currency!==fill.currency||
        !Number.isFinite(execution.shares)||Number(execution.shares)<=0||execution.shares!==fill.quantity||
        !Number.isFinite(execution.price)||Number(execution.price)<=0||execution.price!==fill.price||
        !Number.isFinite(executedAt)||executedAt!==instant(fill.executedAt)||
        !(link.role==='PARENT'?['BUY','BOT']:['SELL','SLD']).includes(String(execution.side)))return null;
    }
    const completedIdentities=new Set<string>();
    for(const completed of row.snapshot.completedOrders as BrokerReconciliationSnapshot['completedOrders']) {
      if(completed.accountId!==accountId)continue;
      const owners=acceptedLegs.filter(({link})=>typeof completed.permId==='string'&&completed.permId.length>0&&typeof completed.orderRef==='string'&&completed.orderRef.length>0&&
        link.account_id===accountId&&link.perm_id===completed.permId&&link.order_ref===completed.orderRef&&
        (completed.brokerOrderId===null||completed.brokerOrderId===undefined||completed.brokerOrderId===link.broker_order_id));
      if(owners.length!==1)return null;
      const {link,cycle,conid,quantity,currency}=owners[0], key=`${accountId}:${completed.permId}:${completed.orderRef}`;
      if(completedIdentities.has(key)||cycle.links.filter(l=>l.role===link.role).length!==1)return null;
      completedIdentities.add(key);
      const filled=cycle.terminalProof!.report.fills.filter(fill=>fill.role===link.role).reduce((total,fill)=>total+fill.quantity,0);
      const status=typeof completed.status==='string'?completed.status.toUpperCase().replaceAll(' ',''):'';
      if(completed.conId!==conid||completed.secType!=='STK'||completed.currency!==currency||completed.action!==(link.role==='PARENT'?'BUY':'SELL')||
        !Number.isFinite(quantity)||quantity<=0||!Number.isFinite(completed.filled)||Number(completed.filled)<0||completed.filled!==filled||
        !Number.isFinite(completed.remaining)||Number(completed.remaining)<0||Number(completed.remaining)+filled!==quantity||
        (completed.totalQuantity!==null&&completed.totalQuantity!==undefined&&(!Number.isFinite(completed.totalQuantity)||completed.totalQuantity<0||(completed.totalQuantity>0&&completed.totalQuantity!==quantity)))||
        !terminal(status)||(completed.terminalStatus!==null&&completed.terminalStatus!==undefined&&completed.terminalStatus.toUpperCase().replaceAll(' ','')!==status)||(status==='FILLED'&&(completed.remaining!==0||filled!==quantity)))return null;
    }
    const finalCheckStarted=performance.now();
    const checkedAt=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
    const validUntil=Math.min(start+10000,new Date(row.observed_at).getTime()+10000,new Date(row.captured_at).getTime()+10000);
    if(!Number.isFinite(checkedAt)||checkedAt<now||checkedAt>=validUntil||!this.current(accountId,row.session_id,Number(row.connection_generation)))return null;
    const proof={runId:Number(row.reconciliation_run_id),sessionId:row.session_id,generation:Number(row.connection_generation),validUntil:new Date(validUntil)};
    this.proofExpiries.set(proof,finalCheckStarted+validUntil-checkedAt);
    return proof;
  }
}
