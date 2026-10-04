import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { buildInstrumentSessionIdentity, requireSessionSchedule, type BoundInstrument, type ProposedOrder, type SessionScheduleEvidence } from '@ikbr/shared';
import { computeClientOrderHash } from '@ikbr/shared/client-order-hash';
import { canonicalJson } from '@ikbr/shared/trading-config';
import type { ExecutionRepository } from '../repository.js';
import { deriveExitSession, tightenExitSession, type PinnedExitSession } from './exit-session.js';

export interface LifecycleSupervision extends PinnedExitSession {
  proposalId: number; accountId: string; originalHash: string; instrumentId: string; conid: string;
  status: string; terminalProof: Record<string, unknown> | null; terminalFingerprint: string | null;
  automaticRequestId: string | null; automaticLimitPrice: number | null; automaticClaimedAt: string | null;
}
const iso = (v: Date | string) => new Date(v).toISOString();
export async function readLifecycleSession(db: Pick<PoolClient, 'query'>, bound: BoundInstrument): Promise<SessionScheduleEvidence | null> {
  const { rows } = await db.query('SELECT generation,status,evidence,updated_at FROM instrument_session_schedules WHERE instrument_id=$1 AND conid=$2 AND use_rth=true FOR SHARE', [bound.instrumentId, String(bound.conId)]);
  const row = rows[0];
  return row ? { generation: Number(row.generation), status: row.status, schedule: row.evidence, updatedAt: iso(row.updated_at) } : null;
}
export async function pinLifecycleEntryPolicy(db: PoolClient, order: ProposedOrder, bound: BoundInstrument, accountId: string, attemptedAt: Date, marginMinutes: number, policySource: 'ENTRY_RESERVATION' | 'DISABLED_ADOPTION' = 'ENTRY_RESERVATION'): Promise<void> {
  if (!order.id || order.instrumentId !== bound.instrumentId || order.conid !== String(bound.conId) || !accountId || (order.executionAccountId && order.executionAccountId !== accountId)) throw new Error('lifecycle_policy_identity_invalid');
  const now = new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  const pinned = deriveExitSession(bound, await readLifecycleSession(db, bound), attemptedAt.getTime(), now, marginMinutes);
  if (policySource === 'ENTRY_RESERVATION' && now >= Date.parse(pinned.exitDeadline)) throw new Error('lifecycle_entry_exit_deadline_passed');
  const hash = computeClientOrderHash(order);
  await db.query(`INSERT INTO lifecycle_supervision(original_proposal_id,account_id,original_hash,instrument_id,conid,config_hash,policy_source,exit_before_close_minutes,session_date,session_start,session_end,exit_deadline,session_generation,session_identity)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(original_proposal_id) DO NOTHING`,
  [order.id, accountId, hash, order.instrumentId, order.conid, order.strategyAttribution?.effectiveConfigHash ?? null, policySource, marginMinutes, pinned.sessionDate, pinned.sessionStart, pinned.sessionEnd, pinned.exitDeadline, pinned.sessionGeneration, buildInstrumentSessionIdentity(bound.instrument,bound)]);
  const existing = (await db.query('SELECT * FROM lifecycle_supervision WHERE original_proposal_id=$1 FOR UPDATE', [order.id])).rows[0];
  if (existing.account_id !== accountId || existing.original_hash !== hash || existing.instrument_id !== bound.instrumentId || existing.conid !== String(bound.conId) || existing.config_hash !== (order.strategyAttribution?.effectiveConfigHash ?? null)) throw new Error('lifecycle_pinned_identity_changed');
}
export async function assertLifecycleEntryDeadline(db: PoolClient, proposalId: number, accountId: string): Promise<number> {
  const row = (await db.query('SELECT * FROM lifecycle_supervision WHERE original_proposal_id=$1 AND account_id=$2 FOR UPDATE', [proposalId, accountId])).rows[0];
  if (!row) throw new Error('lifecycle_entry_exit_policy_missing');
  const stored = (await db.query('SELECT generation,status,evidence,updated_at FROM instrument_session_schedules WHERE instrument_id=$1 AND conid=$2 AND use_rth=true FOR SHARE', [row.instrument_id,row.conid])).rows[0];
  const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  const evidence:SessionScheduleEvidence|null=stored?{generation:Number(stored.generation),status:stored.status,schedule:stored.evidence,updatedAt:iso(stored.updated_at)}:null;
  const schedule=requireSessionSchedule(evidence,row.session_identity,now);
  const session=schedule.sessions.find(s=>s.date===row.session_date&&s.start===iso(row.session_start));
  if(!session)throw new Error('lifecycle_original_session_unavailable');
  const deadline=Math.min(new Date(row.exit_deadline).getTime(),Date.parse(session.end)-row.exit_before_close_minutes*60000);
  if(!Number.isFinite(deadline)||now>=deadline)throw new Error('lifecycle_entry_exit_deadline_passed');
  await db.query('UPDATE lifecycle_supervision SET exit_deadline=LEAST(exit_deadline,$2),session_end=LEAST(session_end,$3),session_generation=$4,updated_at=clock_timestamp() WHERE original_proposal_id=$1',[proposalId,new Date(deadline),session.end,evidence!.generation]);
  return Math.min(deadline,Date.parse(schedule.receivedAt)+6*3600000,Date.parse(evidence!.updatedAt)+6*3600000,Date.parse(schedule.coverageEnd));
}

export class LifecycleObserverRepository {
  constructor(readonly pool: Pool, readonly execution: ExecutionRepository) {}
  async withAccountLease<T>(accountId: string, work: () => Promise<T>): Promise<T | null> {
    const db = await this.pool.connect(); let acquired = false;
    try {
      acquired = (await db.query("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired", [`lifecycle:${accountId}`])).rows[0].acquired === true;
      return acquired ? await work() : null;
    } finally { if (acquired) await db.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [`lifecycle:${accountId}`]); db.release(); }
  }
  async listCandidates(accountId: string): Promise<number[]> {
    const { rows } = await this.pool.query(`SELECT id FROM proposed_orders WHERE side='BUY' AND execution_attempted_at IS NOT NULL AND (execution_account_id=$1 OR execution_account_id IS NULL)
      UNION SELECT original_proposal_id AS id FROM lifecycle_close_operations WHERE account_id=$1
      ORDER BY id`, [accountId]);
    return rows.map(row => Number(row.id));
  }
  async get(id: number): Promise<LifecycleSupervision | null> {
    const row = (await this.pool.query('SELECT * FROM lifecycle_supervision WHERE original_proposal_id=$1', [id])).rows[0];
    return row ? { proposalId: Number(row.original_proposal_id), accountId: row.account_id, originalHash: row.original_hash, instrumentId: row.instrument_id, conid: row.conid,
      status: row.status, terminalProof: row.terminal_proof, terminalFingerprint: row.terminal_fingerprint,
      automaticRequestId: row.automatic_request_id, automaticLimitPrice: row.automatic_limit_price, automaticClaimedAt: row.automatic_claimed_at ? iso(row.automatic_claimed_at) : null,
      sessionDate: row.session_date, sessionStart: iso(row.session_start), sessionEnd: iso(row.session_end), exitDeadline: iso(row.exit_deadline), sessionGeneration: Number(row.session_generation), marginMinutes: row.exit_before_close_minutes } : null;
  }
  async adopt(order: ProposedOrder, bound: BoundInstrument, accountId: string, marginMinutes: number): Promise<void> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`snap:${accountId}`]);
      await pinLifecycleEntryPolicy(db, order, bound, accountId, new Date(order.executionAttemptedAt!), marginMinutes, 'DISABLED_ADOPTION'); await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async validateSession(row: LifecycleSupervision, order: ProposedOrder, bound: BoundInstrument, nowMs: number): Promise<LifecycleSupervision> {
    if (row.accountId !== order.executionAccountId || row.originalHash !== computeClientOrderHash(order) || row.instrumentId !== order.instrumentId || row.conid !== order.conid) throw new Error('lifecycle_original_identity_changed');
    const current = deriveExitSession(bound, await readLifecycleSession(this.pool, bound), new Date(order.executionAttemptedAt!).getTime(), nowMs, row.marginMinutes);
    const next = tightenExitSession(row, current);
    await this.pool.query('UPDATE lifecycle_supervision SET session_end=LEAST(session_end,$2),exit_deadline=LEAST(exit_deadline,$3),session_generation=$4,updated_at=clock_timestamp() WHERE original_proposal_id=$1', [row.proposalId, next.sessionEnd, next.exitDeadline, next.sessionGeneration]);
    return (await this.get(row.proposalId))!;
  }
  async claimAutomatic(row: LifecycleSupervision, limitPrice: number): Promise<LifecycleSupervision | null> {
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) throw new Error('lifecycle_close_price_invalid');
    const result = await this.pool.query(`UPDATE lifecycle_supervision SET automatic_request_id=$2,automatic_limit_price=$3,automatic_claimed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE original_proposal_id=$1 AND automatic_request_id IS NULL AND exit_deadline<=clock_timestamp() RETURNING original_proposal_id`, [row.proposalId, randomUUID(), limitPrice]);
    return result.rowCount === 1 ? this.get(row.proposalId) : null;
  }
  async observe(id: number, status: string, observation: unknown, terminal?: { proof: Record<string, unknown>; fingerprint: string }): Promise<void> {
    await this.pool.query(`UPDATE lifecycle_supervision SET status=$2,observation=$3,observed_at=clock_timestamp(),updated_at=clock_timestamp(),
      terminal_proof=COALESCE(terminal_proof,$4),terminal_fingerprint=COALESCE(terminal_fingerprint,$5) WHERE original_proposal_id=$1`, [id, status, JSON.stringify(observation), terminal ? JSON.stringify(terminal.proof) : null, terminal?.fingerprint ?? null]);
  }
  async health(accountId: string, sessionId: string, healthy: boolean, reason: string | null): Promise<void> {
    await this.pool.query(`INSERT INTO lifecycle_observer_health(account_id,session_id,observed_at,healthy,reason) VALUES($1,$2,clock_timestamp(),$3,$4)
      ON CONFLICT(account_id) DO UPDATE SET session_id=EXCLUDED.session_id,observed_at=EXCLUDED.observed_at,healthy=EXCLUDED.healthy,reason=EXCLUDED.reason`, [accountId, sessionId, healthy, reason]);
  }
  async overdueProtection(accountId: string): Promise<number[]> {
    const result = await this.pool.query(`SELECT DISTINCT c.original_proposal_id FROM lifecycle_close_operations c,
      jsonb_array_elements(c.cancel_attempts) a WHERE c.account_id=$1 AND c.state<>'COMPLETED' AND a->>'role' IN ('TP','SL')
      AND (a->>'observedAt')::timestamptz + interval '15 seconds' <= clock_timestamp()`, [accountId]);
    return result.rows.map(row => Number(row.original_proposal_id));
  }
  async accountFresh(accountId: string, sessionId: string): Promise<boolean> {
    const { rows } = await this.pool.query(`SELECT r.status,r.session_id,r.completed_at,r.broker_snapshot,s.complete,s.observed_at,s.session_id AS position_session,
      clock_timestamp() AS now,(SELECT count(*) FROM reconciliation_holds WHERE account_id=$1 AND active) AS holds
      FROM reconciliation_runs r LEFT JOIN broker_snapshot_syncs s ON s.account_id=r.account_id WHERE r.account_id=$1 ORDER BY r.started_at DESC,r.id DESC LIMIT 1`, [accountId]);
    const row = rows[0]; if (!row) return false;
    const now = new Date(row.now).getTime();
    return row.status === 'CLEAN' && row.session_id === sessionId && row.position_session === sessionId && row.complete === true && Number(row.holds) === 0 && row.broker_snapshot?.exposureComplete === true &&
      [row.completed_at,row.observed_at].every(value => value && new Date(value).getTime() <= now && now-new Date(value).getTime() < 10000);
  }
  async fingerprint(id: number): Promise<string> {
    const { rows } = await this.pool.query(`SELECT p.client_order_hash,p.instrument_id,p.conid,p.execution_account_id,p.execution_attempted_at,
      (SELECT jsonb_agg(jsonb_build_object('proposal',l.proposed_order_id,'role',l.role,'ordinal',l.role_ordinal,'account',l.account_id,'id',l.broker_order_id,'ref',l.order_ref,'perm',l.perm_id) ORDER BY l.proposed_order_id,l.role,l.role_ordinal) FROM broker_order_links l WHERE l.proposed_order_id=p.id OR l.proposed_order_id=c.close_proposal_id) AS links,
      (SELECT jsonb_agg(jsonb_build_object('exec',f.exec_id,'proposal',f.proposed_order_id,'account',f.account_id,'conid',f.conid,'id',f.broker_order_id,'side',f.side,'shares',f.shares,'price',f.price,'currency',f.currency,'at',f.executed_at,'commission',f.commission,'commissionCurrency',f.commission_currency,'realizedPnl',f.realized_pnl,'secType',f.sec_type,'typeConflict',f.sec_type_conflict) ORDER BY f.exec_id) FROM broker_execution_fills f WHERE f.proposed_order_id=p.id OR f.proposed_order_id=c.close_proposal_id OR (f.account_id=p.execution_account_id AND f.broker_order_id IN (SELECT broker_order_id FROM broker_order_links WHERE proposed_order_id=p.id OR proposed_order_id=c.close_proposal_id))) AS fills,
      c.close_proposal_id,c.submission_attempted_at,c.state AS close_state,c.terminals
      FROM proposed_orders p LEFT JOIN lifecycle_close_operations c ON c.original_proposal_id=p.id WHERE p.id=$1`, [id]);
    if (rows.length !== 1) throw new Error('lifecycle_original_missing');
    return createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(rows[0])))).digest('hex');
  }
}
