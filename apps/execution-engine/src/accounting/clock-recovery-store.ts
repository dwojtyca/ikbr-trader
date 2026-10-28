import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AccountingSourceStore } from './source-store.js';
import { accountingHash, accountingError, type ClockRecoveryReservation, type ClockRecoveryState, type AutomaticClockRecoveryStatus } from './types.js';

type DB = Pick<Pool | PoolClient, 'query'>;
export interface ClockEpisode {
  id: string; source_id: string; state: Exclude<ClockRecoveryState, 'IDLE'>; attempt_count: number;
  owner_session_id: string; fencing_generation: string; next_attempt_at: Date | null;
  first_error_at: Date; created_at: Date; updated_at: Date; verifying_at: Date | null; last_error: string;
  last_cause: AutomaticClockRecoveryStatus["originalCause"];
  receipt_id: string | null; capture_id: string | null;
}
export class ClockRecoveryStore {
  private continuous = false;
  constructor(private readonly source: AccountingSourceStore) {}
  async active(db: DB = this.source.pool, lock = false): Promise<ClockEpisode | null> {
    return (await db.query<ClockEpisode>(`SELECT * FROM broker_accounting_clock_episodes WHERE source_id=$1 AND state<>'RECOVERED'${lock ? ' FOR UPDATE' : ''}`, [this.source.sourceId])).rows[0] ?? null;
  }
  async latest(db: DB = this.source.pool): Promise<ClockEpisode | null> {
    if(db===this.source.pool) return this.source.transaction(client=>this.latest(client));
    return (await db.query<ClockEpisode>('SELECT * FROM broker_accounting_clock_episodes WHERE source_id=$1 ORDER BY created_at DESC LIMIT 1', [this.source.sourceId])).rows[0] ?? null;
  }
  async observe(db: PoolClient): Promise<void> {
    const c = await this.source.control(db);
    if (c.hold !== 'ACCOUNTING_CLOCK_INVALID') return;
    const active = await this.active(db, true);
    if (active) {
      if (active.state === 'VERIFYING') await db.query(`UPDATE broker_accounting_clock_episodes SET state=CASE WHEN attempt_count>=3 AND NOT $2::boolean THEN 'OPERATOR_REQUIRED' ELSE 'BACKOFF' END, next_attempt_at=CASE WHEN $2::boolean THEN GREATEST(next_attempt_at,lease_expires_at,clock_timestamp()+(CASE WHEN attempt_count<2 THEN 30 WHEN attempt_count<3 THEN 120 ELSE 300 END * interval '1 second')) ELSE clock_timestamp()+(CASE WHEN attempt_count<2 THEN 30 ELSE 120 END * interval '1 second') END,last_error='ACCOUNTING_CLOCK_INVALID',updated_at=clock_timestamp() WHERE id=$1`, [active.id,this.continuous]);
      return;
    }
    const origin = (await db.query(`SELECT id,received_at FROM broker_accounting_observations WHERE source_id=$1 AND kind='gap' AND payload->'value'->>'hold'='ACCOUNTING_CLOCK_INVALID' ORDER BY sequence DESC LIMIT 1`, [this.source.sourceId])).rows[0];
    if (!origin) throw accountingError('CLOCK_RECOVERY_HISTORY_UNAVAILABLE');
    await db.query(`INSERT INTO broker_accounting_clock_episodes(id,source_id,origin_observation_id,state,owner_session_id,first_error,last_error,first_error_at) VALUES($1,$2,$3,'WAITING',$4,'ACCOUNTING_CLOCK_INVALID','ACCOUNTING_CLOCK_INVALID',$5)`, [randomUUID(), this.source.sourceId, origin.id, this.source.sessionId,origin.received_at]);
  }
  async initialize(continuous = false): Promise<void> {
    this.continuous = continuous;
    await this.source.transaction(async db => {
      await this.source.control(db, true);
      const predecessor = await this.active(db, true);
      await this.observe(db);
      const episode = await this.active(db, true);
      if (episode && episode.owner_session_id !== this.source.sessionId) {
        if (this.continuous) {
          await db.query(`INSERT INTO accounting_clock_read_dispositions(id,episode_id,source_id,predecessor,successor_session_id)
            VALUES($1,$2,$3,$4::jsonb,$5)`, [randomUUID(),episode.id,this.source.sourceId,JSON.stringify(predecessor ?? episode),this.source.sessionId]);
          await db.query(`UPDATE broker_accounting_clock_episodes SET state='BACKOFF',owner_session_id=$2,fencing_generation=fencing_generation+1,
            next_attempt_at=GREATEST(next_attempt_at,lease_expires_at,clock_timestamp()+interval '30 seconds'),lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [episode.id,this.source.sessionId]);
          await db.query(`UPDATE broker_accounting_sources SET hold=COALESCE(hold,'ACCOUNTING_CLOCK_INVALID'),gap=true,semantic_revision=semantic_revision+1 WHERE source_id=$1`, [this.source.sourceId]);
          return;
        }
        await db.query(`UPDATE broker_accounting_clock_episodes SET state=CASE WHEN state='RECOVERING' THEN 'OUTCOME_UNKNOWN' WHEN attempt_count>0 OR state IN ('BACKOFF','VERIFYING') THEN 'OPERATOR_REQUIRED' ELSE state END,
          last_error=CASE WHEN attempt_count>0 THEN 'ACCOUNTING_CLOCK_RECOVERY_RESTART_REQUIRES_OPERATOR' ELSE last_error END,owner_session_id=$2,updated_at=clock_timestamp() WHERE id=$1`, [episode.id, this.source.sessionId]);
      }
    });
  }
  async claim(accountId: string, settingsHash: string, automatic: boolean, attemptId = randomUUID()): Promise<ClockRecoveryReservation | null> {
    return this.source.transaction(async db => {
      const control = await this.source.control(db, true); await this.observe(db);
      const e = await this.active(db, true);
      if (!e || control.hold !== 'ACCOUNTING_CLOCK_INVALID') throw accountingError('CLOCK_RECOVERY_HOLD_MISMATCH');
      if (control.settings_hash !== settingsHash || e.owner_session_id !== this.source.sessionId) throw accountingError('SOURCE_SESSION_CHANGED');
      if (e.state === 'OUTCOME_UNKNOWN' || e.state === 'RECOVERING') throw accountingError('CLOCK_RECOVERY_OUTCOME_UNKNOWN');
      const time = (await db.query(`SELECT clock_timestamp() AS now, count(*) AS attempts FROM broker_accounting_clock_attempts WHERE source_id=$1 AND started_at>clock_timestamp()-interval '1 hour'`, [this.source.sourceId])).rows[0];
      const now = new Date(time.now).getTime();
      if (automatic && !['WAITING','BACKOFF'].includes(e.state)) return null;
      const previous=(await db.query('SELECT owner_session_id FROM broker_accounting_clock_attempts WHERE source_id=$1 ORDER BY started_at DESC LIMIT 1',[this.source.sourceId])).rows[0];
      if(automatic && !this.continuous && previous && previous.owner_session_id!==this.source.sessionId) {
        await this.setState(db,e.id,'OPERATOR_REQUIRED','ACCOUNTING_CLOCK_RECOVERY_RESTART_REQUIRES_OPERATOR'); return null;
      }
      if (automatic && e.next_attempt_at && now < e.next_attempt_at.getTime()) return null;
      if (this.continuous && Number(time.attempts) >= 6) {
        await this.setState(db,e.id,'BACKOFF','ACCOUNTING_CLOCK_RECOVERY_RATE_LIMIT');
        await db.query(`UPDATE broker_accounting_clock_episodes SET next_attempt_at=(SELECT min(started_at)+interval '1 hour 1 second' FROM broker_accounting_clock_attempts
          WHERE source_id=$2 AND started_at>clock_timestamp()-interval '1 hour') WHERE id=$1`, [e.id,this.source.sourceId]); return null;
      }
      if ((!this.continuous && automatic && e.attempt_count >= 3) || Number(time.attempts) >= 6) {
        await this.setState(db, e.id, 'OPERATOR_REQUIRED', 'ACCOUNTING_CLOCK_RECOVERY_LIMIT'); return null;
      }
      const generation = Number(e.fencing_generation) + 1;
      await db.query(`UPDATE broker_accounting_clock_episodes SET state='RECOVERING',attempt_count=attempt_count+$3,fencing_generation=$2,lease_expires_at=clock_timestamp()+interval '13 seconds',next_attempt_at=NULL,updated_at=clock_timestamp() WHERE id=$1`, [e.id, generation,automatic ? 1 : 0]);
      await db.query(`INSERT INTO broker_accounting_clock_attempts(id,episode_id,source_id,owner_session_id,fencing_generation,automatic) VALUES($1,$2,$3,$4,$5,$6)`, [attemptId, e.id, this.source.sourceId, this.source.sessionId, generation, automatic]);
      return { episodeId: e.id, attemptId, sourceId: this.source.sourceId, ownerSessionId: this.source.sessionId, fencingGeneration: generation, accountId, settingsHash, automatic };
    });
  }
  async resolveClaim(attemptId: string, accountId: string, settingsHash: string, automatic: boolean): Promise<ClockRecoveryReservation | null> {
    return this.source.transaction(async db => {
      await this.source.control(db,true);
      const row=(await db.query('SELECT * FROM broker_accounting_clock_attempts WHERE id=$1 AND source_id=$2',[attemptId,this.source.sourceId])).rows[0];
      if(!row) return null;
      const reservation={episodeId:row.episode_id,attemptId,ownerSessionId:row.owner_session_id,fencingGeneration:Number(row.fencing_generation),sourceId:this.source.sourceId,accountId,settingsHash,automatic};
      await this.assertReservation(db,reservation); return reservation;
    });
  }
  async assertReservation(db: PoolClient, r: ClockRecoveryReservation): Promise<void> {
    const e = await this.active(db, true);
    const attempt = (await db.query(`SELECT 1 FROM broker_accounting_clock_attempts WHERE id=$1 AND episode_id=$2 AND owner_session_id=$3 AND fencing_generation=$4`, [r.attemptId,r.episodeId,r.ownerSessionId,r.fencingGeneration])).rowCount;
    if (!e || !attempt || e.id !== r.episodeId || e.state !== 'RECOVERING' || e.owner_session_id !== this.source.sessionId || Number(e.fencing_generation) !== r.fencingGeneration || r.sourceId !== this.source.sourceId) throw accountingError('CLOCK_RECOVERY_CHANGED');
  }
  async verified(db: PoolClient, r: ClockRecoveryReservation, receiptId: string): Promise<void> {
    await this.assertReservation(db,r);
    await db.query(`INSERT INTO broker_accounting_clock_outcomes(attempt_id,outcome,receipt_id) VALUES($1,'VERIFYING',$2)`, [r.attemptId,receiptId]);
    await db.query(`UPDATE broker_accounting_clock_episodes SET state='VERIFYING',receipt_id=$2,verifying_at=clock_timestamp(),updated_at=clock_timestamp(),lease_expires_at=NULL WHERE id=$1`, [r.episodeId,receiptId]);
  }
  async complete(db: PoolClient, captureId: string, manual = false): Promise<number | null> {
    const e = await this.active(db,true);
    if (!e) return null;
    if (!(e.state === 'VERIFYING' || manual && e.state === 'OPERATOR_REQUIRED') || !e.receipt_id) throw accountingError('CLOCK_RECOVERY_OPERATOR_REQUIRED');
    let remaining:number|null=null;
    if(!manual) {
      const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
      remaining=e.verifying_at ? 60000-(now-e.verifying_at.getTime()) : 0;
      if(remaining<=0 || remaining>60000) { await this.setState(db,e.id,'OPERATOR_REQUIRED','ACCOUNTING_CLOCK_RECOVERY_VERIFY_TIMEOUT');return null; }
    }
    const deadline=remaining===null?null:performance.now()+remaining;
    await db.query(`UPDATE broker_accounting_clock_episodes SET state='RECOVERED',capture_id=$2,updated_at=clock_timestamp(),next_attempt_at=NULL WHERE id=$1`, [e.id,captureId]);
    return deadline;
  }
  private async setState(db: PoolClient, episodeId: string, state: string, error: string): Promise<void> {
    await db.query(`UPDATE broker_accounting_clock_episodes SET state=$2,last_error=$3,updated_at=clock_timestamp(),lease_expires_at=NULL WHERE id=$1`, [episodeId,state,error]);
  }
  async fail(r: ClockRecoveryReservation, error: string, cleanup: boolean, unknown = false, cause: AutomaticClockRecoveryStatus["originalCause"] = null): Promise<void> {
    await this.source.transaction(async db => {
      await this.source.control(db,true); await this.assertReservation(db,r);
      const e = (await this.active(db))!;
      const retryable = ['ACCOUNTING_CLOCK_INVALID','ACCOUNTING_REPLAY_INCOMPLETE','ACCOUNTING_SOURCE_GAP','ACCOUNTING_CLOCK_RECOVERY_CHANGED','ACCOUNTING_REVISION_CHANGED'].includes(error);
      const c = await this.source.control(db);
      const state = unknown || !cleanup ? 'OUTCOME_UNKNOWN' : retryable && (this.continuous || e.attempt_count < 3) && (!c.hold || c.hold === 'ACCOUNTING_CLOCK_INVALID') ? 'BACKOFF' : 'OPERATOR_REQUIRED';
      await db.query(`INSERT INTO broker_accounting_clock_outcomes(attempt_id,outcome,error) VALUES($1,$2,$3)`, [r.attemptId,state,error]);
      await this.setState(db,e.id,state,error);
      await db.query("UPDATE broker_accounting_clock_episodes SET last_cause=$2 WHERE id=$1",[e.id,cause]);
      if (state === 'BACKOFF') await db.query(`UPDATE broker_accounting_clock_episodes SET next_attempt_at=clock_timestamp()+($2::int * interval '1 second') WHERE id=$1`, [e.id,e.attempt_count === 1 ? 30 : e.attempt_count === 2 ? 120 : 300]);
    });
  }
  async deferContinuous(error: string): Promise<void> {
    await this.source.transaction(async db => {
      const control = await this.source.control(db,true), e = await this.active(db,true);
      if (!e || ['OUTCOME_UNKNOWN','RECOVERING'].includes(e.state)) return;
      if (control.hold && control.hold !== 'ACCOUNTING_CLOCK_INVALID') return;
      await this.setState(db,e.id,'BACKOFF',error);
      await db.query("UPDATE broker_accounting_clock_episodes SET next_attempt_at=GREATEST(next_attempt_at,lease_expires_at,clock_timestamp()+interval '30 seconds') WHERE id=$1",[e.id]);
      await db.query("UPDATE broker_accounting_sources SET hold='ACCOUNTING_CLOCK_INVALID',gap=true,semantic_revision=semantic_revision+1 WHERE source_id=$1",[this.source.sourceId]);
    });
  }
  async requireOperator(error: string): Promise<void> {
    await this.source.transaction(async db => {
      await this.source.control(db,true); const e = await this.active(db,true);
      if (e && !['OUTCOME_UNKNOWN','RECOVERING'].includes(e.state)) await this.setState(db,e.id,'OPERATOR_REQUIRED',error);
    });
  }
  async resolve(r: ClockRecoveryReservation): Promise<'committed' | 'rolled_back' | 'unknown'> {
    return this.source.transaction(async db => {
      const c = await this.source.control(db,true), e = await this.active(db,true);
      const outcome = (await db.query('SELECT * FROM broker_accounting_clock_outcomes WHERE attempt_id=$1',[r.attemptId])).rows[0];
      if (e?.id === r.episodeId && e.state === 'VERIFYING' && outcome?.outcome === 'VERIFYING' && outcome.receipt_id === e.receipt_id && !c.hold && c.gap) {
        const receipt=(await db.query(`SELECT payload->'value' AS value,payload_hash FROM broker_accounting_observations WHERE id=$1 AND source_id=$2 AND process_session_id=$3 AND kind='clock_recovery'`,[outcome.receipt_id,this.source.sourceId,this.source.sessionId])).rows[0];
        if(receipt && accountingHash(receipt.value)===receipt.payload_hash && receipt.value.receipt.id===r.attemptId
          && receipt.value.receipt.qualificationId===c.qualification_id && receipt.value.settingsHash===c.settings_hash
          && Number(c.semantic_revision)===receipt.value.barrier.semanticRevision+1
          && Number(c.connection_generation)===receipt.value.barrier.sourceConnectionGeneration) return 'committed';
        return 'unknown';
      }
      if (e?.id === r.episodeId && e.state === 'RECOVERING' && !outcome && c.hold === 'ACCOUNTING_CLOCK_INVALID') return 'rolled_back';
      return 'unknown';
    });
  }
}
export function recoveryStatus(enabled: boolean, e: ClockEpisode | null, localUnknown = false, continuous = false): AutomaticClockRecoveryStatus {
  return { enabled,episodeId:e?.id ?? null,state:localUnknown ? 'OUTCOME_UNKNOWN' : e?.state ?? 'IDLE',attemptCount:e?.attempt_count ?? 0,attemptLimit:continuous ? null : 3,
    nextAttemptAt:e?.next_attempt_at?.toISOString() ?? null,firstErrorAt:e?.first_error_at.toISOString() ?? null,lastError:e?.last_error ?? null,
    receiptId:e?.receipt_id ?? null,captureId:e?.capture_id ?? null,originalCause:e?.last_cause ?? null,entryBlocked:localUnknown || !!e && e.state !== 'RECOVERED' };
}
