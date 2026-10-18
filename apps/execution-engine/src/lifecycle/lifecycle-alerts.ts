import type { NotificationEligibility, NotificationProof } from "./notification-checkpoint.js";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LifecycleFaultCode, LifecycleFaultInput, LifecycleFaultSink } from "./fault-contract.js";

export type LifecycleDeliveryStatus = "PENDING" | "SENDING" | "DELIVERED" | "FAILED" | "UNKNOWN" | "DISABLED" | "COALESCED";

export interface LifecycleTransport {
  readonly enabled: boolean;
  send(text: string): Promise<{ status: "DELIVERED"; messageId: string } | { status: "FAILED" | "UNKNOWN"; errorCode: string }>;
}

export interface LifecycleAlertStatus {
  accountId: string;
  faults: Array<{ id: number; proposalId: number | null; code: LifecycleFaultCode; evidence: Record<string, unknown>; firstObservedAt: Date; lastObservedAt: Date; occurrences: number; active: boolean; resolvedAt: Date | null; delivery: LifecycleDeliveryStatus; attempts: number; providerMessageId: string | null; notificationPolicy: string | null; notificationDeadline: Date | null; checkpointRunId: number | null; coalescedAt: Date | null }>;
  probes: Array<{ processId: string; heartbeatAt: Date | null; heartbeatFresh: boolean; transportEnabled: boolean; delivery: LifecycleDeliveryStatus; attempts: number; deliveredAt: Date | null }>;
  deliveryAttempts: Array<{ outboxId: number; faultId: number | null; probeProcessId: string | null; attemptNumber: number; status: "SENDING" | "DELIVERED" | "FAILED" | "UNKNOWN"; startedAt: Date; endedAt: Date | null; providerMessageId: string | null; errorCode: string | null }>;
  transport: "UNVERIFIED" | "VERIFIED" | "DISABLED";
}

type OutboxRow = { id: string; account_id: string; fault_id: string | null; probe_process_id: string | null; code: string | null; attempts: number; lease_token: string };

function safeEvidence(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeEvidence(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/token|secret|chat|url|body|error|password|credential/i.test(key))
      .slice(0, 30).map(([key, item]) => [key, safeEvidence(item, depth + 1)]));
  }
  return null;
}

class NotificationProofChanged extends Error {}
function lockUnavailable(error:unknown):boolean {
  return typeof error==='object'&&error!==null&&'code' in error&&error.code==='55P03';
}

async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>, beforeCommit?:()=>void): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await work(db);
    beforeCommit?.();
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

// Clock notifications must leave the shared pool and account locks available for exits.
async function clockAlertTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>, beforeCommit?: () => void): Promise<T> {
  const deadline = performance.now() + 1750;
  if (pool.idleCount === 0 && pool.totalCount >= (pool.options.max ?? 10)) throw new Error("ACCOUNTING_CLOCK_RECOVERY_ALERT_BUSY");
  let client: PoolClient | undefined, expired = false, released = false, committing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = (destroy: boolean) => { if (client && !released) { released = true; client.release(destroy); } };
  const check = () => {
    const remaining = Math.floor(deadline - performance.now());
    if (expired || released || remaining <= 0) throw new Error("ACCOUNTING_CLOCK_RECOVERY_ALERT_TIMEOUT");
    return remaining;
  };
  const operation = async () => {
    client = await pool.connect();
    if (expired || performance.now() >= deadline) { dispose(true); throw new Error("ACCOUNTING_CLOCK_RECOVERY_ALERT_TIMEOUT"); }
    const query = client.query.bind(client);
    const bounded = new Proxy(client, { get(target, key) {
      if (key !== 'query') return Reflect.get(target, key);
      return async (text: string, values?: unknown[]) => {
        let remaining = check();
        // Server cancellation bounds SQL work, not merely its response wait.
        if (text !== 'BEGIN') {
          const configure = { text: "SELECT set_config('statement_timeout',$1,true)", values: [String(Math.max(1, remaining - 25))], query_timeout: remaining };
          await query(configure); remaining = check();
        }
        const config = { text, values, query_timeout: remaining };
        const result = await query(config); check(); return result;
      };
    } });
    await bounded.query('BEGIN');
    await bounded.query("SET LOCAL lock_timeout='100ms'; SET LOCAL idle_in_transaction_session_timeout='1750ms'");
    const result = await work(bounded);
    // Execute deferred work while statement cancellation can still roll back the transaction.
    await bounded.query('SET CONSTRAINTS ALL IMMEDIATE');
    check(); beforeCommit?.(); check(); committing = true;
    await bounded.query('COMMIT'); check(); dispose(false); return result;
  };
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true; dispose(true); reject(new Error("ACCOUNTING_CLOCK_RECOVERY_ALERT_TIMEOUT"));
      }, 1750);
    })]);
  } catch (error) {
    // Destroying the session rolls back unfinished work. A lost COMMIT response remains unknown.
    expired = true; dispose(true);
    if (committing && error instanceof Error) Object.assign(error, { commitUnknown: true });
    throw error;
  } finally { clearTimeout(timer); }
}

export class LifecycleAlertStore implements LifecycleFaultSink {
  constructor(private readonly pool: Pool, private readonly notification?: NotificationEligibility) {}

  private live(accountId:string,proof:NotificationProof|null):proof is NotificationProof {
    if(!proof||!this.notification)return false;
    try{return this.notification.isCurrent(accountId,proof);}catch{return false;}
  }
  private immediateDrift(accountId:string):Promise<void> {
    return this.recordFault({accountId,proposalId:null,code:'BROKER_STATE_STALE',evidence:{reason:'notification_identity_changed'}});
  }
  private async proof(db: PoolClient, accountId: string, resolving=false) {
    if(!this.notification)return null;
    await db.query('SAVEPOINT notification_proof');
    try {
      const previous=String((await db.query("SELECT setting FROM pg_settings WHERE name='statement_timeout'")).rows[0].setting);
      await db.query("SELECT set_config('statement_timeout',$1,true)",[String(Math.min(Number(previous)||1000,1000))]);
      const result=await this.notification.eligible(db,accountId,resolving);
      await db.query("SELECT set_config('statement_timeout',$1,true)",[previous]);
      await db.query('RELEASE SAVEPOINT notification_proof'); return this.live(accountId,result)?result:null;
    }
    catch { await db.query('ROLLBACK TO SAVEPOINT notification_proof'); await db.query('RELEASE SAVEPOINT notification_proof'); return null; }
  }

  async recordFault(input: LifecycleFaultInput): Promise<void> {
    let committedProof:NotificationProof|null=null;
    const transact = input.code === "ACCOUNTING_CLOCK_RECOVERY_REQUIRED" ? clockAlertTransaction : transaction;
    try { await transact(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`snap:${input.accountId}`]);
      let proof = input.notification === 'FLAT_WATCHDOG_V1' && input.proposalId === null && input.code === 'BROKER_STATE_STALE'
        && input.evidence.reason === 'lifecycle_observation_overdue' ? await this.proof(db,input.accountId) : null;
      const episodeId = input.code === "ACCOUNTING_CLOCK_RECOVERY_REQUIRED" && input.proposalId === null
        && typeof input.evidence.episodeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.evidence.episodeId)
        ? input.evidence.episodeId : null;
      const evidence = { ...safeEvidence(input.evidence) as Record<string, unknown>, ...(episodeId ? { episodeId } : {}) };
      if (episodeId) await db.query(`UPDATE lifecycle_faults SET active=false,resolved_at=clock_timestamp()
        WHERE account_id=$1 AND original_proposal_id IS NULL AND code=$2 AND active AND evidence->>'episodeId' IS DISTINCT FROM $3`,
        [input.accountId,input.code,episodeId]);
      const active = await db.query<{ id: string }>(
        `SELECT id FROM lifecycle_faults WHERE account_id=$1 AND original_proposal_id IS NOT DISTINCT FROM $2 AND code=$3 AND active FOR UPDATE`,
        [input.accountId, input.proposalId, input.code],
      );
      let id: string;
      if (active.rows[0]) {
        id = active.rows[0].id;
        await db.query(
          `UPDATE lifecycle_faults SET evidence=$2::jsonb, last_observed_at=clock_timestamp(), occurrences=occurrences+1 WHERE id=$1`,
          [id, JSON.stringify(evidence)],
        );
      } else {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO lifecycle_faults(account_id,original_proposal_id,code,evidence) VALUES($1,$2,$3,$4::jsonb) RETURNING id`,
          [input.accountId, input.proposalId, input.code, JSON.stringify(evidence)],
        );
        id = inserted.rows[0].id;
      }
      if(!this.live(input.accountId,proof))proof=null;
      committedProof=proof;
      await db.query(
        `INSERT INTO lifecycle_alert_outbox(account_id,fault_id,notification_policy,notification_deadline,checkpoint_run_id,notification_session_id,notification_generation,next_attempt_at)
         SELECT $1,id,CASE WHEN q.qualified THEN 'FLAT_WATCHDOG_V1' END,
          CASE WHEN q.qualified THEN first_observed_at+interval '5 seconds' END,CASE WHEN q.qualified THEN $3::bigint END,CASE WHEN q.qualified THEN $4::text END,CASE WHEN q.qualified THEN $5::bigint END,
          CASE WHEN q.qualified THEN first_observed_at+interval '5 seconds' ELSE clock_timestamp() END
         FROM lifecycle_faults CROSS JOIN (SELECT $3::bigint IS NOT NULL AND clock_timestamp()<$6::timestamptz AS qualified) q WHERE id=$2 ON CONFLICT DO NOTHING`,
        [input.accountId, id, proof?.runId ?? null,proof?.sessionId??null,proof?.generation??null,proof?.validUntil??null],
      );
      if(proof&&!this.live(input.accountId,proof))throw new NotificationProofChanged();
      await db.query(`UPDATE lifecycle_alert_outbox SET next_attempt_at=LEAST(next_attempt_at,clock_timestamp()),notification_promoted_at=COALESCE(notification_promoted_at,clock_timestamp())
        WHERE fault_id=$1 AND notification_policy='FLAT_WATCHDOG_V1' AND status='PENDING'
        AND ($2::text IS NULL OR notification_session_id<>$2 OR notification_generation<>$3 OR clock_timestamp()>=$4::timestamptz)`,[id,proof?.sessionId??null,proof?.generation??null,proof?.validUntil??null]);
    },()=>{if(committedProof&&!this.live(input.accountId,committedProof))throw new NotificationProofChanged();}); }
    catch(error){if(error instanceof NotificationProofChanged){await this.immediateDrift(input.accountId);return;}throw error;}
    if(committedProof&&!this.live(input.accountId,committedProof))await this.immediateDrift(input.accountId);
  }

  async resolveScope(accountId: string, proposalId: number | null, activeCodes: readonly LifecycleFaultCode[]): Promise<void> {
    let committedProof:NotificationProof|null=null;
    try { await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`snap:${accountId}`]);
      const resolved=await db.query<{id:string}>(
        `UPDATE lifecycle_faults SET active=FALSE,resolved_at=clock_timestamp()
         WHERE account_id=$1 AND original_proposal_id IS NOT DISTINCT FROM $2 AND active AND code<>'ACCOUNTING_CLOCK_RECOVERY_REQUIRED' AND NOT (code=ANY($3::text[])) RETURNING id`,
        [accountId, proposalId, activeCodes],
      );
      const proof=proposalId===null && !activeCodes.includes('BROKER_STATE_STALE') ? await this.proof(db,accountId,true) : null;
      const liveProof=this.live(accountId,proof);
      if(proof&&!liveProof)throw new NotificationProofChanged();
      if (liveProof) {
        committedProof=proof;
        await db.query(`UPDATE lifecycle_alert_outbox o SET status='COALESCED',coalesced_at=clock_timestamp()
          FROM lifecycle_faults f WHERE f.id=o.fault_id AND f.account_id=$1 AND f.code='BROKER_STATE_STALE'
          AND f.original_proposal_id IS NULL AND NOT f.active AND f.resolved_at<=o.notification_deadline AND clock_timestamp()<=o.notification_deadline
          AND o.notification_policy='FLAT_WATCHDOG_V1' AND o.status='PENDING' AND o.attempts=0
          AND o.notification_promoted_at IS NULL AND o.notification_session_id=$2 AND o.notification_generation=$3 AND f.id=ANY($4::bigint[]) AND clock_timestamp()<$5::timestamptz
          AND o.lease_token IS NULL AND o.lease_expires_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM lifecycle_alert_delivery_attempts a WHERE a.outbox_id=o.id)`,[accountId,proof.sessionId,proof.generation,resolved.rows.map(r=>r.id),proof.validUntil]);
        if(!this.live(accountId,proof))throw new NotificationProofChanged();
      } else {
        await db.query(`UPDATE lifecycle_alert_outbox SET next_attempt_at=LEAST(next_attempt_at,clock_timestamp()),notification_promoted_at=COALESCE(notification_promoted_at,clock_timestamp())
          WHERE fault_id=ANY($1::bigint[]) AND notification_policy='FLAT_WATCHDOG_V1' AND status='PENDING'`,[resolved.rows.map(r=>r.id)]);
      }
    },()=>{if(committedProof&&!this.live(accountId,committedProof))throw new NotificationProofChanged();}); }
    catch(error){if(error instanceof NotificationProofChanged){await this.immediateDrift(accountId);return;}throw error;}
    if(committedProof&&!this.live(accountId,committedProof))await this.immediateDrift(accountId);
  }

  async resolveClockRecovery(accountId: string, assertRecovered: () => void): Promise<void> {
    await clockAlertTransaction(this.pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`snap:${accountId}`]);
      assertRecovered();
      await db.query(`UPDATE lifecycle_faults SET active=FALSE,resolved_at=clock_timestamp()
        WHERE account_id=$1 AND original_proposal_id IS NULL AND active AND code='ACCOUNTING_CLOCK_RECOVERY_REQUIRED'`, [accountId]);
    }, assertRecovered);
  }

  async startWorkerSession(accountId: string, processId: string): Promise<void> {
    await transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`snap:${accountId}`]);
      await db.query(
        `INSERT INTO lifecycle_alert_workers(account_id,process_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [accountId, processId],
      );
      await db.query(
        `INSERT INTO lifecycle_alert_outbox(account_id,probe_process_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
        [accountId, processId],
      );
      await db.query(
        `INSERT INTO lifecycle_alert_outbox(account_id,fault_id)
         SELECT account_id,id FROM lifecycle_faults WHERE account_id=$1 AND active ON CONFLICT DO NOTHING`,
        [accountId],
      );
    });
  }

  async heartbeatWorker(accountId: string, processId: string, transportEnabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE lifecycle_alert_workers SET heartbeat_at=clock_timestamp(),transport_enabled=$3 WHERE account_id=$1 AND process_id=$2`,
      [accountId, processId, transportEnabled],
    );
  }

  async readStatus(accountId: string, processId?: string): Promise<LifecycleAlertStatus> {
    const [faults, probes, attempts] = await Promise.all([
      this.pool.query<{
        id: string; original_proposal_id: string | null; code: LifecycleFaultCode; evidence: Record<string, unknown>; first_observed_at: Date; last_observed_at: Date; occurrences: number; active: boolean; resolved_at: Date | null; status: LifecycleDeliveryStatus | null; attempts: number | null; provider_message_id: string | null; notification_policy: string | null; notification_deadline: Date | null; checkpoint_run_id: string | null; coalesced_at: Date | null;
      }>(`SELECT f.*,o.status,o.attempts,o.provider_message_id,o.notification_policy,o.notification_deadline,o.checkpoint_run_id,o.coalesced_at FROM lifecycle_faults f LEFT JOIN lifecycle_alert_outbox o ON o.fault_id=f.id WHERE f.account_id=$1 ORDER BY f.id DESC`, [accountId]),
      this.pool.query<{ process_id: string; heartbeat_at: Date | null; heartbeat_fresh: boolean; transport_enabled: boolean | null; status: LifecycleDeliveryStatus; attempts: number; delivered_at: Date | null }>(
        `SELECT o.probe_process_id AS process_id,w.heartbeat_at,
                COALESCE(w.heartbeat_at BETWEEN clock_timestamp()-interval '15 seconds' AND clock_timestamp(),FALSE) AS heartbeat_fresh,
                w.transport_enabled,o.status,o.attempts,o.delivered_at
         FROM lifecycle_alert_outbox o LEFT JOIN lifecycle_alert_workers w ON w.account_id=o.account_id AND w.process_id=o.probe_process_id
         WHERE o.account_id=$1 AND o.probe_process_id IS NOT NULL AND ($2::text IS NULL OR o.probe_process_id=$2) ORDER BY o.id DESC`, [accountId, processId ?? null],
      ),
      this.pool.query<{ outbox_id: string; fault_id: string | null; probe_process_id: string | null; attempt_number: number; status: "SENDING" | "DELIVERED" | "FAILED" | "UNKNOWN"; started_at: Date; ended_at: Date | null; provider_message_id: string | null; error_code: string | null }>(
        `SELECT a.outbox_id,o.fault_id,o.probe_process_id,a.attempt_number,a.status,a.started_at,a.ended_at,a.provider_message_id,a.error_code
         FROM lifecycle_alert_delivery_attempts a JOIN lifecycle_alert_outbox o ON o.id=a.outbox_id WHERE o.account_id=$1 ORDER BY a.id DESC`, [accountId],
      ),
    ]);
    return {
      accountId,
      faults: faults.rows.map((r) => ({ id: Number(r.id), proposalId: r.original_proposal_id === null ? null : Number(r.original_proposal_id), code: r.code, evidence: r.evidence, firstObservedAt: r.first_observed_at, lastObservedAt: r.last_observed_at, occurrences: r.occurrences, active: r.active, resolvedAt: r.resolved_at, delivery: r.status ?? "PENDING", attempts: r.attempts ?? 0, providerMessageId: r.provider_message_id, notificationPolicy:r.notification_policy, notificationDeadline:r.notification_deadline, checkpointRunId:r.checkpoint_run_id===null?null:Number(r.checkpoint_run_id), coalescedAt:r.coalesced_at })),
      probes: probes.rows.map((r) => ({ processId: r.process_id, heartbeatAt: r.heartbeat_at, heartbeatFresh: r.heartbeat_fresh, transportEnabled: r.transport_enabled ?? false, delivery: r.status, attempts: r.attempts, deliveredAt: r.delivered_at })),
      deliveryAttempts: attempts.rows.map((r) => ({ outboxId: Number(r.outbox_id), faultId: r.fault_id === null ? null : Number(r.fault_id), probeProcessId: r.probe_process_id, attemptNumber: r.attempt_number, status: r.status, startedAt: r.started_at, endedAt: r.ended_at, providerMessageId: r.provider_message_id, errorCode: r.error_code })),
      transport: !probes.rows[0]?.heartbeat_fresh ? "UNVERIFIED" : probes.rows[0]?.transport_enabled === false ? "DISABLED" : probes.rows[0]?.status === "DELIVERED" ? "VERIFIED" : probes.rows[0]?.status === "DISABLED" ? "DISABLED" : "UNVERIFIED",
    };
  }

  async entryFailure(db: PoolClient, accountId: string, processId: string): Promise<string | null> {
    const result = await db.query<{ heartbeat_fresh: boolean; transport_enabled: boolean; probe_status: LifecycleDeliveryStatus | null; active_faults: string; pending_deliveries: string }>(
      `SELECT
        COALESCE((SELECT heartbeat_at BETWEEN clock_timestamp()-interval '15 seconds' AND clock_timestamp() FROM lifecycle_alert_workers WHERE account_id=$1 AND process_id=$2),FALSE) AS heartbeat_fresh,
        COALESCE((SELECT transport_enabled FROM lifecycle_alert_workers WHERE account_id=$1 AND process_id=$2),FALSE) AS transport_enabled,
        (SELECT status FROM lifecycle_alert_outbox WHERE account_id=$1 AND probe_process_id=$2) AS probe_status,
        (SELECT count(*)::text FROM lifecycle_faults WHERE account_id=$1 AND active) AS active_faults,
        (SELECT count(*)::text FROM lifecycle_alert_outbox o JOIN lifecycle_faults f ON f.id=o.fault_id WHERE f.account_id=$1 AND o.status<>'DELIVERED' AND NOT(o.status='COALESCED' AND NOT f.active AND o.notification_policy='FLAT_WATCHDOG_V1' AND o.attempts=0)) AS pending_deliveries`,
      [accountId, processId],
    );
    const row = result.rows[0];
    if (!row.heartbeat_fresh) return "lifecycle_alert_worker_stale";
    if (!row.transport_enabled) return "lifecycle_alert_transport_disabled";
    if (row.probe_status !== "DELIVERED") return "lifecycle_alert_transport_unverified";
    if (Number(row.pending_deliveries) > 0) return "lifecycle_critical_delivery_unconfirmed";
    if (Number(row.active_faults) > 0) return "lifecycle_active_fault";
    return null;
  }

  async markDisabled(accountIds: readonly string[]): Promise<void> {
    for(const account of [...new Set(accountIds)].sort()) { try { await transaction(this.pool,async db=>{
      await db.query("SELECT set_config('lock_timeout','100ms',true)");
      if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS acquired",[`snap:${account}`])).rows[0]?.acquired)return;
      const locked=await db.query<{id:string}>(`SELECT id FROM lifecycle_alert_outbox WHERE account_id=$1
        AND status IN ('PENDING','FAILED','UNKNOWN') AND attempts<3 ORDER BY id FOR UPDATE SKIP LOCKED`,[account]);
      if(locked.rowCount)await db.query(`UPDATE lifecycle_alert_outbox SET status='DISABLED',last_error_code='transport_disabled' WHERE id=ANY($1::bigint[])`,[locked.rows.map(r=>r.id)]);
    }); } catch(error){if(!lockUnavailable(error))throw error;} }
  }

  async claimNext(accountIds: readonly string[], processId: string): Promise<OutboxRow | null> {
    if (accountIds.length === 0) return null;
    for (const account of [...new Set(accountIds)].sort()) {
      let committedProof:NotificationProof|null=null;
      try { await transaction(this.pool,async db=>{
        await db.query("SELECT set_config('lock_timeout','100ms',true)");
        if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS acquired",[`snap:${account}`])).rows[0]?.acquired)return;
        const delayed=await db.query(`SELECT id,notification_session_id,notification_generation FROM lifecycle_alert_outbox WHERE account_id=$1
          AND notification_policy='FLAT_WATCHDOG_V1' AND status='PENDING' ORDER BY id FOR UPDATE SKIP LOCKED`,[account]);
        let proof=delayed.rowCount?await this.proof(db,account):null;
        if(!this.live(account,proof))proof=null;
        committedProof=proof;
        if(delayed.rowCount) await db.query(`UPDATE lifecycle_alert_outbox SET next_attempt_at=LEAST(next_attempt_at,clock_timestamp()),notification_promoted_at=COALESCE(notification_promoted_at,clock_timestamp())
          WHERE id=ANY($1::bigint[]) AND notification_policy='FLAT_WATCHDOG_V1' AND status='PENDING' AND ($2::text IS NULL OR notification_session_id<>$2 OR notification_generation<>$3 OR clock_timestamp()>=$4::timestamptz)`,[delayed.rows.map(r=>r.id),proof?.sessionId??null,proof?.generation??null,proof?.validUntil??null]);
        if(proof&&!this.live(account,proof))throw new NotificationProofChanged();
        const expired=await db.query<{id:string;lease_token:string;attempts:number}>(`SELECT id,lease_token,attempts FROM lifecycle_alert_outbox
          WHERE account_id=$1 AND (fault_id IS NOT NULL OR probe_process_id=$2) AND status='SENDING' AND lease_expires_at<=clock_timestamp()
          ORDER BY id FOR UPDATE SKIP LOCKED`,[account,processId]);
        for(const row of expired.rows) {
          await db.query(`UPDATE lifecycle_alert_delivery_attempts SET status='UNKNOWN',ended_at=clock_timestamp(),error_code='lease_expired'
            WHERE outbox_id=$1 AND lease_token=$2 AND status='SENDING'`,[row.id,row.lease_token]);
          await db.query(`UPDATE lifecycle_alert_outbox SET status='UNKNOWN',lease_token=NULL,lease_expires_at=NULL,last_error_code='lease_expired',
            next_attempt_at=clock_timestamp()+($2::int * interval '1 second') WHERE id=$1`,[row.id,row.attempts===1?5:15]);
        }
      },()=>{if(committedProof&&!this.live(account,committedProof))throw new NotificationProofChanged();}); }
      catch(error){if(error instanceof NotificationProofChanged){await this.immediateDrift(account);continue;}if(lockUnavailable(error))continue;throw error;}
      if(committedProof&&!this.live(account,committedProof))await this.immediateDrift(account);
    }
    // Candidate reads do not lock rows. Every mutation takes the account lock first.
    const candidates=await this.pool.query<{id:string;account_id:string}>(`SELECT id,account_id FROM lifecycle_alert_outbox
      WHERE account_id=ANY($1::text[]) AND (fault_id IS NOT NULL OR probe_process_id=$2)
      AND status IN ('PENDING','FAILED','UNKNOWN','DISABLED') AND attempts<3 AND next_attempt_at<=clock_timestamp()
      ORDER BY next_attempt_at,id`,[accountIds,processId]);
    for(const candidate of candidates.rows) {
      const claimed=await transaction(this.pool, async db=>{
        await db.query("SELECT set_config('lock_timeout','100ms',true)");
        if(!(await db.query("SELECT pg_try_advisory_xact_lock(hashtext($1)::bigint) AS acquired",[`snap:${candidate.account_id}`])).rows[0]?.acquired)return null;
        const due=await db.query<OutboxRow>(`SELECT o.id,o.account_id,o.fault_id,o.probe_process_id,f.code,o.attempts,o.lease_token
          FROM lifecycle_alert_outbox o LEFT JOIN lifecycle_faults f ON f.id=o.fault_id WHERE o.id=$1 AND o.account_id=$2
          AND (o.fault_id IS NOT NULL OR o.probe_process_id=$3) AND o.status IN ('PENDING','FAILED','UNKNOWN','DISABLED')
          AND o.attempts<3 AND o.next_attempt_at<=clock_timestamp() FOR UPDATE OF o SKIP LOCKED`,[candidate.id,candidate.account_id,processId]);
        if(!due.rows[0])return null;
        const row=due.rows[0], token=randomUUID(), attempt=row.attempts+1;
        await db.query(`UPDATE lifecycle_alert_outbox SET status='SENDING',attempts=$2,lease_token=$3,
          lease_expires_at=clock_timestamp()+interval '5 seconds',last_error_code=NULL WHERE id=$1`,[row.id,attempt,token]);
        await db.query(`INSERT INTO lifecycle_alert_delivery_attempts(outbox_id,attempt_number,lease_token,status) VALUES($1,$2,$3,'SENDING')`,[row.id,attempt,token]);
        return {...row,attempts:attempt,lease_token:token};
      }).catch(error=>{if(lockUnavailable(error))return null;throw error;});
      if(claimed)return claimed;
    }
    return null;
  }

  async complete(id: string, token: string, result: Awaited<ReturnType<LifecycleTransport["send"]>>): Promise<boolean> {
    const identity=(await this.pool.query<{account_id:string}>('SELECT account_id FROM lifecycle_alert_outbox WHERE id=$1',[id])).rows[0];
    if(!identity)return false;
    return transaction(this.pool, async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",[`snap:${identity.account_id}`]);
      const current = await db.query<{ attempts: number }>(`SELECT attempts FROM lifecycle_alert_outbox WHERE id=$1 AND lease_token=$2 AND status='SENDING' AND lease_expires_at>clock_timestamp() FOR UPDATE`, [id, token]);
      if (!current.rows[0]) return false;
      const status = result.status;
      const errorCode = status === "DELIVERED" ? null : result.errorCode;
      const messageId = status === "DELIVERED" ? result.messageId : null;
      await db.query(`UPDATE lifecycle_alert_delivery_attempts SET status=$3,ended_at=clock_timestamp(),provider_message_id=$4,error_code=$5 WHERE outbox_id=$1 AND lease_token=$2`, [id, token, status, messageId, errorCode]);
      await db.query(`UPDATE lifecycle_alert_outbox SET status=$3,lease_token=NULL,lease_expires_at=NULL,provider_message_id=$4,last_error_code=$5,delivered_at=CASE WHEN $3='DELIVERED' THEN clock_timestamp() ELSE delivered_at END,next_attempt_at=clock_timestamp()+($6::int * interval '1 second') WHERE id=$1 AND lease_token=$2`, [id, token, status, messageId, errorCode, current.rows[0].attempts === 1 ? 5 : 15]);
      return true;
    });
  }
}

export class LifecycleAlertWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly store: LifecycleAlertStore, private readonly transport: LifecycleTransport, private readonly deps: { accountIds: readonly string[]; processId: string; tickMs?: number }) {}

  async start(): Promise<void> {
    if (this.timer) return;
    for (const accountId of this.deps.accountIds) await this.store.startWorkerSession(accountId, this.deps.processId);
    await this.triggerNow();
    this.timer = setInterval(() => { void this.triggerNow().catch(() => undefined); }, this.deps.tickMs ?? 5000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }

  triggerNow(): Promise<void> {
    if (this.running) return this.running;
    const work = this.tick();
    this.running = work.finally(() => { this.running = null; });
    return this.running;
  }

  private async tick(): Promise<void> {
    for (const accountId of this.deps.accountIds) await this.store.heartbeatWorker(accountId, this.deps.processId, this.transport.enabled);
    if (!this.transport.enabled) { await this.store.markDisabled(this.deps.accountIds); return; }
    const claimed = await this.store.claimNext(this.deps.accountIds, this.deps.processId);
    if (!claimed) return;
    const text = claimed.fault_id
      ? `🚨 Lifecycle fault LF-${claimed.fault_id} account ${claimed.account_id}: ${claimed.code ?? "UNKNOWN"}`
      : `Lifecycle transport check account ${claimed.account_id} process ${claimed.probe_process_id}`;
    let result: Awaited<ReturnType<LifecycleTransport["send"]>>;
    try { result = await this.transport.send(text); }
    catch { result = { status: "UNKNOWN", errorCode: "transport_exception" }; }
    await this.store.complete(claimed.id, claimed.lease_token, result);
  }
}

export function createTelegramLifecycleTransport(config: { botToken?: string; chatId?: string; fetch?: typeof globalThis.fetch }): LifecycleTransport {
  const token = config.botToken;
  const chatId = config.chatId;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  return {
    enabled: Boolean(token && chatId),
    async send(message) {
      if (!token || !chatId) return { status: "FAILED", errorCode: "transport_disabled" };
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(Object.assign(new Error("deadline"), { name: "AbortError" })); }, 5000);
      });
      try {
        const request = async () => {
          const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
          signal: controller.signal,
          redirect: "error",
          });
          const size = Number(response.headers.get("content-length"));
          if (Number.isFinite(size) && size > 65_536) return { status: "UNKNOWN" as const, errorCode: "provider_response_oversize" };
          if (!response.body) return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" };
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > 65_536) { void reader.cancel().catch(() => undefined); return { status: "UNKNOWN" as const, errorCode: "provider_response_oversize" }; }
            chunks.push(part.value);
          }
          let payload: unknown;
          try { payload = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
          catch { return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" }; }
          if (typeof payload !== "object" || payload === null) return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" };
          const ack = payload as { ok?: unknown; result?: { message_id?: unknown } };
          if (ack.ok === false) return { status: "FAILED" as const, errorCode: "provider_rejected" };
          if (!response.ok || ack.ok !== true || !Number.isSafeInteger(ack.result?.message_id) || Number(ack.result?.message_id) <= 0) return { status: "UNKNOWN" as const, errorCode: "provider_invalid_ack" };
          return { status: "DELIVERED" as const, messageId: String(ack.result!.message_id) };
        };
        return await Promise.race([request(), deadline]);
      } catch (error) {
        return { status: "UNKNOWN", errorCode: error instanceof Error && error.name === "AbortError" ? "transport_timeout" : "provider_request_uncertain" };
      } finally { clearTimeout(timeout); }
    },
  };
}
