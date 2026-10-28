import { performance } from "node:perf_hooks";
import { ClockRecoveryStore } from "./clock-recovery-store.js";
import type { AccountingSourceOwner } from "./source-owner.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { paperAccountDate, paperAccountDayStart } from "../paper-daily-loss.js";
import { parseQualification, automaticQualificationSchema } from "./config.js";
import { qualificationExpired, accountingError, accountingHash, accountingReference, accountingNumber, type AccountingCapture, type AccountingLane, type LaneBarrier,
  type ClockRecoveryEvidence, type ClockRecoveryReservation, type ClockRecoveryReceipt, type SourceInspection, type StoredQualification } from "./types.js";

export interface SourceControl { source_id: string; process_session_id: string; connection_generation: string | number;
  semantic_revision: string | number; qualification_id: string | null; gap: boolean; hold: string | null;
  settings_hash: string; lanes: Record<AccountingLane, LaneBarrier> }
export interface SourceObservation {
  id: string; lane: AccountingLane; laneSequence: number; generation: number; requestId?: number;
  kind: string; key?: string; value: unknown; raw?: unknown; receivedAt: string;
}
export class AccountingSourceStore {
  readonly recovery = new ClockRecoveryStore(this);
  owner: AccountingSourceOwner | undefined;
  constructor(readonly pool: Pool, readonly sourceId: string, readonly sessionId: string) {}
  async transaction<T>(fn: (db: PoolClient) => Promise<T>, beforeCommit?: () => void): Promise<T> {
    const deadline = performance.now() + 2000;
    let expired = false;
    const connection = this.pool.connect();
    const timeout = setTimeout(() => { expired = true; }, 2000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const db = await Promise.race([connection, new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(accountingError("PERSISTENCE_TIMEOUT")), 2000);
    })]).catch(error => { void connection.then(client => client.release(true),()=>undefined); throw error; }).finally(() => { clearTimeout(timer); clearTimeout(timeout); });
    if (expired) { db.release(true); throw accountingError("PERSISTENCE_TIMEOUT"); }
    let committing = false, destroy = false;
    const query = db.query.bind(db);
    const bounded = new Proxy(db, { get(target, property) {
      if (property !== 'query') return Reflect.get(target,property);
      return async (text: string, values?: unknown[]) => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) throw accountingError("PERSISTENCE_TIMEOUT");
        const config = { text, values, query_timeout: remaining };
        return query(config);
      };
    } });
    try {
      await bounded.query("BEGIN");
      await bounded.query("SET LOCAL statement_timeout='1900ms'; SET LOCAL lock_timeout='1800ms'");
      await this.owner?.assertInTransaction(bounded);
      const result = await fn(bounded); beforeCommit?.(); this.owner?.assertHeld();
      committing = true; await bounded.query("COMMIT"); return result;
    } catch (error) {
      const rollback = {text:"ROLLBACK",query_timeout:100};
      await query(rollback).catch(() => {destroy=true;});
      if (committing && error instanceof Error) Object.assign(error,{commitUnknown:true});
      throw error;
    } finally { db.release(destroy || performance.now() >= deadline); }
  }

  async control(db: Pick<Pool | PoolClient, "query"> = this.pool, lock = false): Promise<SourceControl> {
    const row = (await db.query<SourceControl>(`SELECT * FROM broker_accounting_sources WHERE source_id=$1${lock ? " FOR UPDATE" : ""}`, [this.sourceId])).rows[0];
    if (!row || row.process_session_id !== this.sessionId) throw accountingError("SOURCE_SESSION_CHANGED");
    return row;
  }
  async begin(accountId: string, settingsHash: string): Promise<SourceControl> {
    if (!this.owner) throw accountingError("SOURCE_OWNER_REQUIRED");
    this.owner.assertCurrent();
    return this.transaction(async db => {
      await db.query(`INSERT INTO broker_accounting_sources(source_id,account_id,settings_hash,process_session_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(source_id) DO UPDATE SET process_session_id=$4, connection_generation=0,
        gap=true, semantic_revision=broker_accounting_sources.semantic_revision+1,
        qualification_id=CASE WHEN broker_accounting_sources.settings_hash=$3 THEN broker_accounting_sources.qualification_id ELSE NULL END,
        settings_hash=$3, lanes='{"accounting":{"received":0,"persisted":0,"pending":0},"execution":{"received":0,"persisted":0,"pending":0}}',updated_at=clock_timestamp()`,
      [this.sourceId, accountId, settingsHash, this.sessionId]);
      return this.control(db, true);
    });
  }
  private async insertObservation(db: Pick<Pool | PoolClient, "query">, o: SourceObservation): Promise<void> {
    await db.query(`INSERT INTO broker_accounting_observations(id,source_id,process_session_id,connection_generation,lane,lane_sequence,request_id,kind,event_key,received_at,payload,payload_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [o.id, this.sourceId, this.sessionId, o.generation, o.lane, o.laneSequence, o.requestId ?? null, o.kind, o.key ?? null,
      o.receivedAt, { value: o.value, ...(o.raw === undefined ? {} : { raw: o.raw }) }, accountingHash(o.value)]);
  }
  async append(o: SourceObservation): Promise<{ control: SourceControl; value: unknown }> {
    return this.transaction(async db => {
      const control = await this.control(db, true);
      let changed = false, hold = control.hold, value = o.value;
      if (o.kind === "execution" || o.kind === "commission") {
        const prior = (await db.query(`SELECT payload->'value' AS value FROM broker_accounting_observations
          WHERE source_id=$1 AND kind=$2 AND event_key=$3 ORDER BY sequence DESC LIMIT 1`, [this.sourceId, o.kind, o.key])).rows[0]?.value;
        if (prior && o.kind === "execution") value = { ...prior, ...(value as object) };
        changed = !prior || accountingHash(prior) !== accountingHash(value);
        if (prior && changed) hold = this.preserveHold(hold, "ACCOUNTING_CORRECTION_UNRESOLVED");
        if (!prior && o.kind === "execution" && o.key?.includes(".")) {
          const family = o.key.slice(0, o.key.lastIndexOf(".") + 1);
          const sibling = await db.query(`SELECT 1 FROM broker_accounting_observations WHERE source_id=$1 AND kind='execution'
            AND left(event_key,length($2))=$2 AND event_key<>$3 LIMIT 1`, [this.sourceId, family, o.key]);
          if (sibling.rowCount) hold = this.preserveHold(hold, "ACCOUNTING_CORRECTION_UNRESOLVED");
        }
      }
      await this.insertObservation(db, { ...o, value });
      const lanes = { ...control.lanes, [o.lane]: { received: o.laneSequence, persisted: o.laneSequence, pending: 0 } };
      await db.query(`UPDATE broker_accounting_sources SET lanes=$2,semantic_revision=semantic_revision+$3,hold=$4,
        updated_at=clock_timestamp() WHERE source_id=$1`, [this.sourceId, lanes, changed ? 1 : 0, hold]);
      return { control: await this.control(db), value };
    });
  }
  private preserveHold(current: string | null, incoming: string): string {
    return current && current !== "ACCOUNTING_CLOCK_INVALID" && current !== "ACCOUNTING_SOURCE_GAP" ? current : incoming;
  }
  async gap(generation: number, hold?: string, revoke = false, reason?: string): Promise<SourceControl> {
    return this.transaction(async db => {
      await this.control(db, true);
      await this.insertObservation(db, { id: randomUUID(), lane: "accounting", laneSequence: 0, generation,
        kind: revoke ? "revocation" : "gap", value: { hold: hold ?? "ACCOUNTING_SOURCE_GAP", ...(reason ? { reason } : {}) }, receivedAt: new Date().toISOString() });
      await db.query(`UPDATE broker_accounting_sources SET gap=true,connection_generation=$2,semantic_revision=semantic_revision+1,
        qualification_id=CASE WHEN $4 THEN NULL ELSE qualification_id END,
        hold=CASE WHEN $3::text IS NULL THEN hold
          WHEN hold IS NOT NULL AND hold NOT IN ('ACCOUNTING_CLOCK_INVALID','ACCOUNTING_SOURCE_GAP') THEN hold
          WHEN $3='ACCOUNTING_SOURCE_GAP' THEN hold ELSE $3 END,updated_at=clock_timestamp() WHERE source_id=$1`,
      [this.sourceId, generation, hold ?? null, revoke]);
      await this.recovery.observe(db);
      return this.control(db);
    });
  }
  async recoverClock(e: ClockRecoveryEvidence, assertCurrent: () => void, reservation: ClockRecoveryReservation): Promise<{ control: SourceControl; receipt: ClockRecoveryReceipt }> {
    const fresh = () => {
      assertCurrent();
      const through = Date.parse(e.inspection.brokerTime), now = Date.now();
      if (!Number.isFinite(through) || through > now || now - through >= 10_000 || paperAccountDate(through) !== paperAccountDate(now)) throw accountingError("CLOCK_RECOVERY_STALE");
    };
    return this.transaction(async db => {
      const control = await this.control(db, true); fresh();
      await this.recovery.assertReservation(db,reservation);
      const identity = (await db.query("SELECT account_id,clock_timestamp() AS now FROM broker_accounting_sources WHERE source_id=$1", [this.sourceId])).rows[0];
      const databaseNow = new Date(identity.now).getTime(), through = Date.parse(e.inspection.brokerTime);
      if (control.hold !== "ACCOUNTING_CLOCK_INVALID") throw accountingError("CLOCK_RECOVERY_HOLD_MISMATCH");
      if (identity.account_id !== e.accountId || control.settings_hash !== e.settingsHash
        || Number(control.connection_generation) !== e.barrier.sourceConnectionGeneration || Number(control.semantic_revision) !== e.barrier.semanticRevision
        || e.barrier.sourceId !== this.sourceId || e.barrier.sourceProcessSessionId !== this.sessionId
        || accountingHash(control.lanes) !== accountingHash(e.barrier.lanes)
        || Object.values(e.barrier.lanes).some(l => l.pending || l.received !== l.persisted)
        || e.inspection.sourceId !== this.sourceId || e.inspection.processSessionId !== this.sessionId
        || e.inspection.connectionGeneration !== Number(control.connection_generation)
        || !Number.isFinite(databaseNow) || through > databaseNow || databaseNow - through >= 10_000
        || paperAccountDate(through) !== paperAccountDate(databaseNow)) throw accountingError("CLOCK_RECOVERY_EVIDENCE_INVALID");
      const hidden = await db.query(`SELECT 1 FROM broker_accounting_observations WHERE source_id=$1 AND
        (kind='invalid_broker_event' OR (kind IN ('gap','revocation') AND payload->'value'->>'hold' NOT IN ('ACCOUNTING_CLOCK_INVALID','ACCOUNTING_SOURCE_GAP')))
        UNION ALL SELECT 1 FROM broker_accounting_observations WHERE source_id=$1 AND kind IN ('execution','commission')
          GROUP BY kind,event_key HAVING count(DISTINCT payload_hash)>1
        UNION ALL SELECT 1 FROM broker_accounting_observations a WHERE a.source_id=$1 AND a.kind='execution' AND strpos(a.event_key,'.')>0
          AND NOT EXISTS(SELECT 1 FROM broker_accounting_observations prior WHERE prior.source_id=a.source_id AND prior.kind='execution'
            AND prior.event_key=a.event_key AND prior.sequence<a.sequence)
          AND EXISTS(SELECT 1 FROM broker_accounting_observations sibling WHERE sibling.source_id=a.source_id AND sibling.kind='execution'
            AND sibling.event_key<>a.event_key AND sibling.sequence<a.sequence
            AND left(sibling.event_key,length(regexp_replace(a.event_key,'[^.]*$','')))=regexp_replace(a.event_key,'[^.]*$','')) LIMIT 1`, [this.sourceId]);
      if (hidden.rowCount) throw accountingError("CLOCK_RECOVERY_HISTORY_CONFLICT");
      const failed = (await db.query(`SELECT id FROM broker_accounting_observations WHERE source_id=$1 AND kind='gap'
        AND payload->'value'->>'hold'='ACCOUNTING_CLOCK_INVALID' ORDER BY sequence DESC LIMIT 1`, [this.sourceId])).rows[0];
      if (!failed) throw accountingError("CLOCK_RECOVERY_HISTORY_UNAVAILABLE");
      const ids = [...new Set([...e.inspection.observationIds, e.inspection.id, ...e.observationIds])];
      const rows = (await db.query(`SELECT id,kind,request_id,process_session_id,connection_generation,lane,lane_sequence,sequence,payload->'value' AS value,payload_hash
        FROM broker_accounting_observations WHERE source_id=$1 AND id=ANY($2::uuid[])`, [this.sourceId, ids])).rows;
      if (rows.length !== ids.length || rows.some(r => accountingHash(r.value) !== r.payload_hash)) throw accountingError("CLOCK_RECOVERY_EVIDENCE_INVALID");
      const current = rows.filter(r => r.process_session_id === this.sessionId && Number(r.connection_generation) === e.barrier.sourceConnectionGeneration);
      const inspection = current.find(r => r.id === e.inspection.id && r.kind === "inspection");
      const request = current.filter(r => Number(r.request_id) === e.inspection.replayId);
      const clock = request.find(r => r.kind === "clock" && r.value.brokerTime === e.inspection.brokerTime);
      const start = request.find(r => r.kind === "replay_start"), end = request.find(r => r.kind === "replay_end" && r.id === e.inspection.replayEndId);
      if (!inspection || accountingHash(inspection.value) !== accountingHash(e.inspection) || !clock || !start || !end
        || !(Number(clock.sequence) < Number(start.sequence) && Number(start.sequence) < Number(end.sequence) && Number(end.sequence) < Number(inspection.sequence))
        || !current.some(r => r.kind === "handshake" && r.value.protocolVersion === e.inspection.protocolVersion)
        || !current.some(r => r.kind === "managed_accounts" && accountingHash(r.value) === accountingHash(e.inspection.accounts) && r.value.includes(e.accountId))
        || current.some(r => Number(r.lane_sequence) > e.barrier.lanes[r.lane as AccountingLane].persisted)) throw accountingError("CLOCK_RECOVERY_EVIDENCE_INVALID");
      const replay = new Map(request.filter(r => r.kind === "execution").map(r => [r.value.execId, r.value]));
      if (accountingHash([...replay.keys()].sort()) !== accountingHash([...e.inspection.executionIds].sort())
        || [...replay.values()].some(v => v.accountId !== e.accountId || !Number.isFinite(Date.parse(v.executedAt)) || Date.parse(v.executedAt) > through)) throw accountingError("CLOCK_RECOVERY_EVIDENCE_INVALID");
      const latest = (await db.query(`SELECT DISTINCT ON(kind,event_key) kind,event_key,payload->'value' AS value,payload_hash
        FROM broker_accounting_observations WHERE source_id=$1 AND kind IN ('execution','commission') ORDER BY kind,event_key,sequence DESC`, [this.sourceId])).rows;
      if (latest.some(r => accountingHash(r.value) !== r.payload_hash)) throw accountingError("CLOCK_RECOVERY_EVIDENCE_INVALID");
      const executions = latest.filter(r => r.kind === "execution"), fees = latest.filter(r => r.kind === "commission");
      const today = executions.filter(r => Date.parse(r.value.executedAt) >= paperAccountDayStart(through)).map(r => r.value).sort((a,b) => a.execId.localeCompare(b.execId));
      if (fees.some(f => !executions.some(x => x.event_key === f.event_key)) || accountingHash(today) !== accountingHash(e.executions)
        || e.commissions.length !== today.length || new Set(e.commissions.map(f => f.execId)).size !== today.length) throw accountingError("CLOCK_RECOVERY_EVIDENCE_INVALID");
      for (const execution of today) {
        const fee = e.commissions.find(f => f.execId === execution.execId), saved = fees.find(f => f.event_key === execution.execId);
        if (!replay.has(execution.execId) || accountingHash(replay.get(execution.execId)) !== accountingHash(execution) || execution.pendingPriceRevision
          || !accountingNumber(execution.price) || execution.price <= 0 || !accountingNumber(execution.shares) || execution.shares <= 0
          || !fee || !saved || accountingHash(saved.value) !== accountingHash(fee) || fee.currency !== execution.currency
          || !accountingNumber(fee.commission) || !accountingNumber(fee.realizedPnL)) throw accountingError("CLOCK_RECOVERY_EVIDENCE_INVALID");
      }
      fresh();
      const receipt: ClockRecoveryReceipt = { id: e.id, inspectionId: e.inspection.id, sourceId: this.sourceId,
        connectionGeneration: e.inspection.connectionGeneration, recoveredAt: new Date().toISOString(), qualificationId: control.qualification_id, gap: true, brokerReadOnly: true };
      await this.insertObservation(db, { id: receipt.id, lane: "accounting", laneSequence: 0, generation: receipt.connectionGeneration,
        kind: "clock_recovery", value: { receipt, failedClockObservationId: failed.id, settingsHash: e.settingsHash, barrier: e.barrier,
          gapEpoch: e.gapEpoch, observationIds: ids }, receivedAt: receipt.recoveredAt });
      await db.query(`UPDATE broker_accounting_sources SET hold=NULL,gap=true,semantic_revision=semantic_revision+1,updated_at=clock_timestamp()
        WHERE source_id=$1 AND hold='ACCOUNTING_CLOCK_INVALID'`, [this.sourceId]);
      await this.recovery.verified(db,reservation,receipt.id);
      const next = await this.control(db);
      const finalNow = new Date((await db.query("SELECT clock_timestamp() AS recovery_database_now")).rows[0].recovery_database_now).getTime();
      if (!Number.isFinite(finalNow) || through > finalNow || finalNow - through >= 10_000 || paperAccountDate(through) !== paperAccountDate(finalNow)) throw accountingError("CLOCK_RECOVERY_STALE");
      fresh(); return { control: next, receipt };
    }, fresh);
  }
  async recoveryReceipt(id: string): Promise<ClockRecoveryReceipt> {
    return this.transaction(async db => {
      const row=(await db.query(`SELECT payload->'value' AS value,payload_hash FROM broker_accounting_observations WHERE id=$1 AND source_id=$2 AND kind='clock_recovery'`,[id,this.sourceId])).rows[0];
      if(!row || accountingHash(row.value)!==row.payload_hash || row.value.receipt.id!==id) throw accountingError('CLOCK_RECOVERY_EVIDENCE_INVALID');
      return row.value.receipt;
    });
  }
  async rejectedClock(db: Pick<Pool | PoolClient,"query"> = this.pool) {
    const row=(await db.query(`SELECT payload->'value' AS value,connection_generation FROM broker_accounting_observations WHERE source_id=$1 AND kind='clock_rejected' ORDER BY sequence DESC LIMIT 1`,[this.sourceId])).rows[0];
    return row ? {...row.value,generation:Number(row.connection_generation)} : null;
  }
  async latestValues(): Promise<Array<{ id: string; kind: string; value: unknown }>> {
    return (await this.pool.query(`SELECT DISTINCT ON(kind,event_key) id,kind,payload->'value' AS value FROM broker_accounting_observations
      WHERE source_id=$1 AND kind IN('execution','commission') ORDER BY kind,event_key,sequence DESC`, [this.sourceId])).rows;
  }
  async inspection(id: string): Promise<SourceInspection> {
    const row = (await this.pool.query(`SELECT payload->'value' AS value FROM broker_accounting_observations
      WHERE id=$1 AND source_id=$2 AND process_session_id=$3 AND kind='inspection'`, [id, this.sourceId, this.sessionId])).rows[0];
    if (!row) throw accountingError("INSPECTION_INVALID");
    return row.value;
  }
  async qualification(db: Pick<Pool | PoolClient, "query"> = this.pool): Promise<StoredQualification | null> {
    const control = await this.control(db);
    if (!control.qualification_id) return null;
    return (await db.query(`SELECT record FROM broker_accounting_qualifications WHERE id=$1 AND source_id=$2`, [control.qualification_id, this.sourceId])).rows[0]?.record ?? null;
  }
  async recordQualification(record: StoredQualification, assertCurrent: () => void): Promise<SourceControl> {
    return this.transaction(async db => {
      const control = await this.control(db, true);
      const inspection = await db.query(`SELECT payload->'value' AS value,clock_timestamp() AS database_now FROM broker_accounting_observations WHERE id=$1 AND source_id=$2 AND process_session_id=$3
        AND connection_generation=$4 AND kind='inspection'`, [record.inspectionId, this.sourceId, this.sessionId, control.connection_generation]);
      if (!inspection.rowCount) throw accountingError("INSPECTION_INVALID");
      const now = Math.max(Date.now(), new Date(inspection.rows[0].database_now).getTime()), evidence = inspection.rows[0].value;
      if (record.input.schemaVersion === 2) {
        automaticQualificationSchema.parse(record.input);
        if (record.expiresAt !== null || record.input.processSessionId !== this.sessionId || record.input.connectionGeneration !== Number(control.connection_generation)
          || record.input.inspectionId !== record.inspectionId || record.input.executionTimeZone !== record.settings.executionTimeZone || record.protocolVersion < 219
          || !evidence.capability || record.input.sdkSha256 !== evidence.capability.sdkSha256 || !evidence.accounts.includes(record.settings.accountId)) throw accountingError('INSPECTION_INVALID');
        const proof = (await db.query(`SELECT id,lane_sequence,kind,request_id,connection_generation,process_session_id,payload->'value' AS value,payload_hash
          FROM broker_accounting_observations WHERE source_id=$1 AND id=ANY($2::uuid[])`, [this.sourceId, evidence.observationIds])).rows;
        this.verifyCapability(proof, evidence, record.settings.accountId, Number(control.connection_generation));
      } else parseQualification(record.input, now);
      assertCurrent();
      if (now - Date.parse(evidence.brokerTime) >= 10_000 || Date.parse(evidence.brokerTime) > now || qualificationExpired(record, now)
        || record.input.settingsSha256 !== control.settings_hash || evidence.protocolVersion !== record.protocolVersion) throw accountingError("INSPECTION_INVALID");
      await db.query(`INSERT INTO broker_accounting_qualifications(id,source_id,inspection_id,record,expires_at) VALUES($1,$2,$3,$4,$5)`,
        [record.id, this.sourceId, record.inspectionId, record, record.expiresAt]);
      await db.query(`UPDATE broker_accounting_sources SET qualification_id=$2,semantic_revision=semantic_revision+1,gap=true WHERE source_id=$1`, [this.sourceId, record.id]);
      assertCurrent();
      return this.control(db);
    });
  }
  async publish(capture: AccountingCapture, assertCurrent: () => void): Promise<void> {
    let verificationDeadline:number|null=null;
    await this.transaction(async db => {
      const c = await this.control(db, true), q = await this.qualification(db);
      assertCurrent();
      if (!q || q.id !== capture.qualificationId || qualificationExpired(q) || c.hold || Number(c.semantic_revision) !== capture.barrier.semanticRevision
        || Number(c.connection_generation) !== capture.barrier.sourceConnectionGeneration) throw accountingError("REVISION_CHANGED");
      const run = (await db.query(`SELECT position_generation FROM reconciliation_runs WHERE id=$1 AND account_id=$2 AND session_id=$3 AND status='RUNNING'`,
        [capture.reconciliationRunId, capture.accountId, capture.barrier.executionSessionId])).rows[0];
      const sync = (await db.query(`SELECT generation FROM broker_snapshot_syncs WHERE account_id=$1`, [capture.accountId])).rows[0];
      if (!run || !sync || Number(run.position_generation) !== capture.positionGeneration || Number(sync.generation) !== capture.positionGeneration) throw accountingError("REVISION_CHANGED");
      await this.verifyObservations(db, capture, q);
      await this.insertObservation(db, { id: capture.connectionReceiptId, lane: "accounting", laneSequence: 0,
        generation: capture.barrier.sourceConnectionGeneration, kind: "connection_receipt", value: this.receipt(capture), receivedAt: capture.capturedAt });
      await db.query(`INSERT INTO broker_accounting_captures(id,source_id,qualification_id,receipt_id,reconciliation_run_id,position_generation,semantic_revision,record,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [capture.captureId, this.sourceId, q.id, capture.connectionReceiptId, capture.reconciliationRunId,
          capture.positionGeneration, capture.barrier.semanticRevision, capture, capture.fingerprint]);
      const episode = await this.recovery.active(db,true);
      if (episode?.state === "VERIFYING") verificationDeadline=await this.recovery.complete(db,capture.captureId);
      await db.query(`UPDATE broker_accounting_sources SET gap=false WHERE source_id=$1`, [this.sourceId]);
      assertCurrent();
    },()=>{assertCurrent();if(verificationDeadline!==null && performance.now()>=verificationDeadline) throw accountingError("CLOCK_RECOVERY_VERIFY_TIMEOUT");});
  }
  private receipt(capture: AccountingCapture) {
    return { reference: accountingReference(capture), accountId: capture.accountId, replayId: capture.replayId,
      replayEndId: capture.replayEndId, observationIds: capture.observationIds };
  }
  private verifyCapability(rows: Array<{id: string; lane_sequence: number; kind: string; request_id: number; process_session_id: string; connection_generation: number; value: Record<string, unknown>; payload_hash: string}>, inspection: SourceInspection, accountId: string, generation: number): void {
    const capability = inspection.capability;
    if (!capability || inspection.protocolVersion < 219 || inspection.processSessionId !== this.sessionId || inspection.connectionGeneration !== generation) throw accountingError('CAPTURE_INVALID');
    const request = rows.filter(r => Number(r.request_id) === inspection.replayId && r.process_session_id === this.sessionId && Number(r.connection_generation) === generation);
    if (request.some(r => accountingHash(r.value) !== r.payload_hash)) throw accountingError('CAPTURE_INVALID');
    const start = request.find(r => r.kind === 'replay_start');
    const before = request.find(r => r.kind === 'configuration' && r.value.stage === 'before');
    const after = request.find(r => r.kind === 'configuration' && r.value.stage === 'after');
    const end = request.find(r => r.kind === 'replay_end' && r.id === inspection.replayEndId);
    const from = Date.parse(capability.certifiedFrom), through = Date.parse(inspection.brokerTime);
    const expectedFilter = { clientId: 0, acctCode: accountId, time: new Date(Number.isFinite(from) ? from : 0).toISOString().slice(0, 10).replaceAll('-', '') + '-' + new Date(Number.isFinite(from) ? from : 0).toISOString().slice(11, 19), lastNDays: 7, symbol: '', secType: '', exchange: '', side: '' };
    if (!start || accountingHash(start.value.capability) !== accountingHash(capability) || accountingHash(capability.filter) !== accountingHash(expectedFilter)
      || !Number.isFinite(from) || from % 1000 !== 0 || from > paperAccountDayStart(through) || from < through - 7 * 86400_000
      || capability.sdkSha256 !== '50a459ed09f0030df25125a177e57b69bdf576ec3a89fcb1f81fdff95bbf6316' || capability.masterClientId !== 0
      || !before || !after || [before, after].some(r => r.value.masterClientIdPresent !== true || r.value.masterClientId !== 0 || r.value.sdkSha256 !== capability.sdkSha256)
      || !end || Number(before.lane_sequence) >= Number(start.lane_sequence) || Number(after.lane_sequence) <= Number(end.lane_sequence)) throw accountingError('CAPTURE_INVALID');
  }
  private async verifyObservations(db: Pick<Pool | PoolClient, "query">, capture: AccountingCapture, q: StoredQualification): Promise<void> {
    const through = Date.parse(capture.coveredThrough), start = paperAccountDayStart(through);
    if (!Number.isFinite(through) || capture.periodStart !== new Date(start).toISOString() || capture.accountDate !== paperAccountDate(through)
      || (q.input.schemaVersion === 1 && capture.certifiedFrom !== new Date(through - 48 * 3600_000).toISOString()) || Date.parse(capture.capturedAt) < through
      || Date.parse(capture.capturedAt) - through >= 10_000 || capture.accountId !== q.settings.accountId || capture.qualificationId !== q.id
      || capture.barrier.sourceId !== this.sourceId || capture.barrier.sourceProcessSessionId !== this.sessionId
      || Object.values(capture.barrier.lanes).some(lane => lane.pending !== 0 || lane.received !== lane.persisted)) throw accountingError("CAPTURE_INVALID");
    const rows = (await db.query(`SELECT id,kind,request_id,process_session_id,connection_generation,lane,lane_sequence,sequence,payload->'value' AS value,payload_hash
      FROM broker_accounting_observations WHERE source_id=$1 AND id=ANY($2::uuid[])`, [this.sourceId, capture.observationIds])).rows;
    if (rows.length !== capture.observationIds.length || rows.some(r => accountingHash(r.value) !== r.payload_hash)) throw accountingError("CAPTURE_INVALID");
    const current = rows.filter(r => r.process_session_id === this.sessionId && Number(r.connection_generation) === capture.barrier.sourceConnectionGeneration);
    if (current.some(r => Number(r.lane_sequence) > capture.barrier.lanes[r.lane as AccountingLane].persisted)) throw accountingError("CAPTURE_INVALID");
    const request = current.filter(r => Number(r.request_id) === capture.replayId);
    const inspection = current.find(r => r.kind === "inspection" && r.value.replayEndId === capture.replayEndId && r.value.brokerTime === capture.coveredThrough);
    if (!request.some(r => r.kind === "replay_start") || !request.some(r => r.kind === "replay_end" && r.id === capture.replayEndId)
      || !request.some(r => r.kind === "clock" && r.value.brokerTime === capture.coveredThrough)
      || !current.some(r => r.kind === "handshake" && r.value.protocolVersion === q.protocolVersion)
      || !current.some(r => r.kind === "managed_accounts" && Array.isArray(r.value) && r.value.includes(capture.accountId)) || !inspection
      || inspection.value.sourceId !== this.sourceId || inspection.value.processSessionId !== this.sessionId
      || inspection.value.connectionGeneration !== capture.barrier.sourceConnectionGeneration || inspection.value.replayId !== capture.replayId
      || inspection.value.observationIds.some((id: string) => !capture.observationIds.includes(id))) throw accountingError("CAPTURE_INVALID");
    if (q.input.schemaVersion === 2) {
      if (q.input.processSessionId !== this.sessionId || q.input.connectionGeneration !== capture.barrier.sourceConnectionGeneration || capture.certifiedFrom !== inspection.value.capability?.certifiedFrom) throw accountingError('CAPTURE_INVALID');
      this.verifyCapability(rows, inspection.value, capture.accountId, capture.barrier.sourceConnectionGeneration);
    }
    const allExecutions = new Map(request.filter(r => r.kind === "execution").map(r => [r.value.execId, r.value]));
    if (accountingHash([...allExecutions.keys()].sort()) !== accountingHash([...inspection.value.executionIds].sort())) throw accountingError("CAPTURE_INVALID");
    const expected = [...allExecutions.values()].filter(e => Date.parse(e.executedAt) >= start).sort((a, b) => a.execId.localeCompare(b.execId));
    if (expected.some(e => e.accountId !== capture.accountId || !Number.isFinite(Date.parse(e.executedAt)) || Date.parse(e.executedAt) > through)
      || accountingHash(expected) !== accountingHash(capture.executions) || capture.commissions.length !== expected.length
      || new Set(capture.commissions.map(c => c.execId)).size !== expected.length) throw accountingError("CAPTURE_INVALID");
    for (const execution of capture.executions) {
      const fee = capture.commissions.find(c => c.execId === execution.execId);
      const observed = rows.filter(r => r.kind === "commission" && r.value.execId === execution.execId).sort((a, b) => Number(b.sequence) - Number(a.sequence))[0];
      if (!fee || fee.currency !== execution.currency || !accountingNumber(fee.commission) || !accountingNumber(fee.realizedPnL)
        || !observed || accountingHash(observed.value) !== accountingHash(fee)) throw accountingError("CAPTURE_INVALID");
    }
  }
  async readCapture(db: Pick<Pool | PoolClient, "query">, id: string, lock: boolean): Promise<{ capture: AccountingCapture; control: SourceControl; qualification: StoredQualification | null }> {
    const control = await this.control(db, lock), qualification = await this.qualification(db);
    const row = (await db.query(`SELECT c.*,o.source_id AS receipt_source,o.process_session_id AS receipt_session,o.connection_generation AS receipt_generation,
      o.payload->'value' AS receipt,o.payload_hash AS receipt_hash,r.account_id AS run_account,r.session_id AS run_session,r.position_generation AS run_generation
      FROM broker_accounting_captures c JOIN broker_accounting_observations o ON o.id=c.receipt_id
      JOIN reconciliation_runs r ON r.id=c.reconciliation_run_id WHERE c.id=$1 AND c.source_id=$2 AND o.kind='connection_receipt'`, [id, this.sourceId])).rows[0];
    const capture: AccountingCapture | undefined = row?.record;
    if (!row || !capture || !qualification || row.fingerprint !== capture.fingerprint || accountingHash({ ...capture, fingerprint: undefined }) !== row.fingerprint
      || row.id !== capture.captureId || row.qualification_id !== capture.qualificationId || row.receipt_id !== capture.connectionReceiptId
      || Number(row.reconciliation_run_id) !== capture.reconciliationRunId || Number(row.position_generation) !== capture.positionGeneration
      || Number(row.semantic_revision) !== capture.barrier.semanticRevision || row.receipt_source !== this.sourceId || row.receipt_session !== this.sessionId
      || Number(row.receipt_generation) !== capture.barrier.sourceConnectionGeneration || row.run_account !== capture.accountId
      || row.run_session !== capture.barrier.executionSessionId || Number(row.run_generation) !== capture.positionGeneration
      || accountingHash(row.receipt) !== row.receipt_hash || accountingHash(row.receipt) !== accountingHash(this.receipt(capture))) throw accountingError("CAPTURE_INVALID");
    await this.verifyObservations(db, capture, qualification);
    return { capture, control, qualification };
  }
}
