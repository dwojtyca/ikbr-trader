import { DIAGNOSTIC_LIMITS } from './types.js';

export interface DiagnosticDbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>;
  release():void;
}
export interface DiagnosticDbPool { connect():Promise<DiagnosticDbClient>; }

export interface DiagnosticEvaluationInput {
  accountId: string; processId: string; cycleId: string; instrumentId: string;
  occurredAt: Date; outcome: string; evaluationKind?: string | null; reason: string; configHash?: string | null;
  reasons?: readonly string[]; entryBlockers?: readonly string[];
  assignedInstances?: readonly { implementationId:string; instanceId:string; revision:number }[];
  conId?: string | null; symbol?: string | null; listing?: string | null;
  implementationId?: string | null; instanceId?: string | null; revision?: number | null;
  evaluationId?: string | null; proposalId?: number | null;
}
export interface DiagnosticHeartbeatInput {
  accountId: string; processId: string; startedAt: Date; seenAt: Date;
  expectedIntervalMs: number; enabled: boolean; failedSince?: Date | null; failureCount?: number;
}

const rowsLimit = DIAGNOSTIC_LIMITS.retentionRows;

export class DiagnosticStore {
  constructor(private readonly pool: DiagnosticDbPool) {}

  private async transaction<T>(work: (db: DiagnosticDbClient) => Promise<T>): Promise<T> {
    let timedOut=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const acquiring=this.pool.connect();
    void acquiring.then(client=>{if(timedOut)client.release();},()=>undefined);
    const db=await Promise.race([acquiring,new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>{timedOut=true;reject(Error('DIAGNOSTIC_POOL_ACQUIRE_TIMEOUT'));},2000);
      timer.unref?.();
    })]).finally(()=>{if(timer)clearTimeout(timer);});
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL statement_timeout = '2000ms'");
      await db.query("SET LOCAL lock_timeout = '500ms'");
      const value = await work(db);
      await db.query('COMMIT');
      return value;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { db.release(); }
  }

  async recordEvaluation(input: DiagnosticEvaluationInput): Promise<{id:string;recordedAt:Date}|null> {
    return this.transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext('diagnostic_evaluations')::bigint)");
      await db.query('INSERT INTO diagnostic_retention(account_id) VALUES($1) ON CONFLICT DO NOTHING',[input.accountId]);
      const removed = await db.query<{ account_id: string; occurred_at: Date }>(`
        WITH candidates AS (
          SELECT id FROM diagnostic_evaluations
          WHERE recorded_at < clock_timestamp() - interval '30 days'
          ORDER BY recorded_at,id LIMIT 500
        ), removed AS (
          DELETE FROM diagnostic_evaluations WHERE id IN (SELECT id FROM candidates)
          RETURNING account_id,occurred_at
        ) SELECT account_id,occurred_at FROM removed`);
      await this.recordWatermarks(db, removed.rows);
      const oldGaps=await db.query<{account_id:string;occurred_at:Date}>(`
        WITH candidates AS (SELECT id FROM diagnostic_coverage_gaps
          WHERE to_at < clock_timestamp()-interval '30 days' ORDER BY to_at,id LIMIT 500),
        removed AS (DELETE FROM diagnostic_coverage_gaps WHERE id IN (SELECT id FROM candidates)
          RETURNING account_id,to_at AS occurred_at)
        SELECT account_id,occurred_at FROM removed`);
      await this.recordWatermarks(db,oldGaps.rows);
      const oldProcesses=await db.query<{account_id:string;occurred_at:Date}>(`
        WITH candidates AS (SELECT process_id FROM diagnostic_process_heartbeats
          WHERE last_seen_at < clock_timestamp()-interval '30 days' ORDER BY last_seen_at,process_id LIMIT 500),
        removed AS (DELETE FROM diagnostic_process_heartbeats WHERE process_id IN (SELECT process_id FROM candidates)
          RETURNING account_id,last_seen_at AS occurred_at)
        SELECT account_id,occurred_at FROM removed`);
      await this.recordWatermarks(db,oldProcesses.rows);
      const count = Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM diagnostic_evaluations')).rows[0].n);
      if (count >= rowsLimit) {
        const excess = await db.query<{ account_id: string; occurred_at: Date }>(`
          WITH candidates AS (
            SELECT id FROM diagnostic_evaluations ORDER BY recorded_at,id LIMIT 500
          ), removed AS (
            DELETE FROM diagnostic_evaluations WHERE id IN (SELECT id FROM candidates)
            RETURNING account_id,occurred_at
          ) SELECT account_id,occurred_at FROM removed`);
        await this.recordWatermarks(db, excess.rows);
        if (count - excess.rows.length >= rowsLimit) {
          await db.query(`INSERT INTO diagnostic_coverage_gaps(account_id,process_id,kind,from_at,to_at)
            VALUES($1,$2,'CAPACITY_EXHAUSTED',$3,$3)`,[input.accountId,input.processId,input.occurredAt]);
          return null;
        }
      }
      const inserted=await db.query<{id:string;recorded_at:Date}>(`INSERT INTO diagnostic_evaluations(account_id,process_id,cycle_id,instrument_id,occurred_at,
        outcome,evaluation_kind,reason,reasons,entry_blockers,assigned_instances,config_hash,conid,symbol,listing,
        implementation_id,instance_id,revision,evaluation_id,proposal_id)
        VALUES($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT(cycle_id,instrument_id) DO NOTHING RETURNING id::text,recorded_at`, [input.accountId,input.processId,input.cycleId,
        input.instrumentId,input.occurredAt,input.outcome,input.evaluationKind??null,input.reason,JSON.stringify(input.reasons??[]),
        JSON.stringify(input.entryBlockers??[]),JSON.stringify(input.assignedInstances??[]),input.configHash??null,input.conId??null,
        input.symbol??null,input.listing??null,input.implementationId??null,input.instanceId??null,
        input.revision??null,input.evaluationId??null,input.proposalId??null]);
      const row=inserted.rows[0]??(await db.query<{id:string;recorded_at:Date}>(
        'SELECT id::text,recorded_at FROM diagnostic_evaluations WHERE cycle_id=$1::uuid AND instrument_id=$2',
        [input.cycleId,input.instrumentId])).rows[0];
      return row?{id:row.id,recordedAt:row.recorded_at}:null;
    });
  }

  private async recordWatermarks(db: DiagnosticDbClient, rows: { account_id: string; occurred_at: Date }[]): Promise<void> {
    const byAccount = new Map<string,{ max: Date; count: number }>();
    for (const row of rows) {
      const old = byAccount.get(row.account_id);
      byAccount.set(row.account_id,{ max: !old || row.occurred_at > old.max ? row.occurred_at : old.max,
        count:(old?.count??0)+1 });
    }
    for (const [accountId,value] of byAccount) await db.query(`INSERT INTO diagnostic_retention(account_id,pruned_through_at,pruned_count)
      VALUES($1,$2,$3) ON CONFLICT(account_id) DO UPDATE SET
      pruned_through_at=GREATEST(diagnostic_retention.pruned_through_at,EXCLUDED.pruned_through_at),
      pruned_count=diagnostic_retention.pruned_count+EXCLUDED.pruned_count,updated_at=clock_timestamp()`,
      [accountId,value.max,value.count]);
  }

  async heartbeat(input: DiagnosticHeartbeatInput): Promise<void> {
    await this.transaction(async db => {
      await db.query('INSERT INTO diagnostic_retention(account_id) VALUES($1) ON CONFLICT DO NOTHING',[input.accountId]);
      await db.query(`INSERT INTO diagnostic_process_heartbeats(process_id,account_id,started_at,last_seen_at,
        expected_interval_ms,enabled,failure_count,last_failure_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(process_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at,
          expected_interval_ms=EXCLUDED.expected_interval_ms,enabled=EXCLUDED.enabled,
          failure_count=diagnostic_process_heartbeats.failure_count+EXCLUDED.failure_count,
          last_failure_at=COALESCE(EXCLUDED.last_failure_at,diagnostic_process_heartbeats.last_failure_at)`,
      [input.processId,input.accountId,input.startedAt,input.seenAt,input.expectedIntervalMs,input.enabled,
        input.failureCount??0,input.failedSince??null]);
      if (input.failedSince) await db.query(`INSERT INTO diagnostic_coverage_gaps(account_id,process_id,kind,from_at,to_at)
        VALUES($1,$2,'SINK_FAILURE',$3,$4)`,[input.accountId,input.processId,input.failedSince,input.seenAt]);
    });
  }
}
