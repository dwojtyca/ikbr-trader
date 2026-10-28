import { MARKETAUX_RECOVERY_PROTOCOL, RECOVERY_CLOCK_TOLERANCE_MS, RECOVERY_EXPIRY_MARGIN_MS, systemResearchRecoveryClock, parseRecoveryIdentity, parseRecoveryEvidence, isRecoveryUuid, type ResearchRecoveryClock, type RecoveryIdentity, type RecoveryChallenge, type RecoveryPredecessor, type RecoveryCommit, type RecoveryReceipt, type RecoverySupersede, type MarketauxRecoveryResult, type ResearchRecoveryDiagnostic } from './startup-recovery.js';
import { isTwoSourceResearch } from "./policy.js";
import type { MarketauxAttemptIdentity, MarketauxAttemptTicket, MarketauxAttemptClaim, MarketauxAttemptFailure, MarketauxRefreshState } from "./marketaux-refresh.js";
import { earliestSourceValidityExpiry } from "./source-validity.js";
import {performance} from 'node:perf_hooks';
import {connectWshBounded,type WshBoundedConnection} from './wsh-db.js';
import { WSH_ATTEMPT_MS, WSH_RETRY_DELAYS_MS, type WshAttemptIdentity, type WshAttemptTicket, type WshAttemptKind, type WshAttemptClaim, type WshAttemptResult, type WshAttemptDiagnostic, type WshRefreshState, type WshDueAttempt } from "./wsh-refresh.js";
import { isResearchSourceError } from "./source-error.js";
import { isResearchProviderError } from "./provider-error.js";
import { parseWshConfig, wshQualificationDeadline, wshLedgerKey, type WshAcquisition, type WshAcquisitionRecord, type WshEndpointLease } from "./wsh.js";
import { randomUUID } from "node:crypto";
import { canonicalJson, decodeTradingConfigurationSnapshot } from "../trading-configuration/identity.js";
import type { TradingConfigurationV1 } from "../trading-configuration/types.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { inspectResearch, researchRefreshInterval, researchRefreshSlot, researchRefreshSlotKey, type ResearchPreparation, type ResearchRepairIdentity, type ResearchRole, type MarketauxLegacyRecoveryAssessment, type MarketauxBudgetRecoveryAssessment, type ResearchLocalBudgetDiagnostic, marketauxLocalBudgetFailure, marketauxTransientFailure } from "./repair.js";
import { marketauxCallIdentity, marketauxWindow, marketauxQualificationDeadline, parseMarketauxNewsConfig, type MarketauxRequest } from "./marketaux.js";
import { isResearchHash, parseResearchManifest, parseResearchSnapshot, researchAssert, researchHash, researchTime } from "./validation.js";
import type { ResearchSnapshot, ResearchSnapshotV2, ResearchConnection, ResearchBinding, ResearchBindingIdentity, ResearchCallReservation, ResearchDb, ResearchIdentity, ResearchManifest, ResearchPool, ResearchSourceError, StoredResearchSnapshot, ValidatedResearchBinding } from "./types.js";

class ResearchBudgetExhausted extends Error {
  constructor(readonly proof: { day: string; recordedAt: string; requests: number; cost: number; maxRequests: number; maxCost: number; nextCost: number }) { super("RESEARCH_BUDGET_EXHAUSTED"); }
}
const iso = (v: unknown): string => v instanceof Date ? v.toISOString() : String(v);
type WshReadRecoveryRecord = {
  identity: WshAttemptIdentity; recordedAt: string;
  endpoints: {endpointId:string; predecessorGeneration:number; successorGeneration:number}[];
  issuers: {ledgerKey:string; nextRegularAt:string}[];
  predecessors: {kind:'WSH_ATTEMPT'|'WSH_ACQUISITION'; id:string; identityHash:string; deadlineAt:string}[];
  challenges: {id:string; hash:string}[];
};
export class ResearchStore {
  private readonly wshRecoveryOperations = new Map<string, string>();
  async recoverExpiredWshReads(identity: WshAttemptIdentity): Promise<{ state: 'NOT_REQUIRED'|'RECOVERED'|'WAITING'|'BUSY'; nextCheckAt: string|null; recoveryId: string|null }> {
    const key = researchHash(identity), retry = () => new Date(Date.now()+1000).toISOString();
    const bounded = await connectWshBounded(this.pool), db = bounded.db;
    let committing = false;
    try {
      await db.query('BEGIN');
      await this.assertAuthority(identity, db);
      await this.wshSource(identity, db, false);
      const operationId = this.wshRecoveryOperations.get(key) ?? randomUUID();
      this.wshRecoveryOperations.set(key, operationId);
      const prior = (await db.query('SELECT canonical_json,record_hash FROM research_wsh_read_recoveries WHERE id=$1', [operationId])).rows[0];
      if (prior) {
        const record = JSON.parse(String(prior.canonical_json)) as WshReadRecoveryRecord;
        researchAssert(researchHash(record) === prior.record_hash && researchHash(record.identity) === key, 'RESEARCH_WSH_READ_RECOVERY_RECEIPT_INVALID');
        this.wshRecoveryOperations.delete(key);
        await db.query('COMMIT');
        return { state:'RECOVERED',nextCheckAt:null,recoveryId:operationId };
      }
      const read = async () => (await db.query('SELECT research_wsh_read_recovery_record($1::jsonb,clock_timestamp()) AS record', [JSON.stringify(identity)])).rows[0].record as WshReadRecoveryRecord;
      await db.query('COMMIT');
      const discovered = await read();
      if (!discovered.predecessors.length) { this.wshRecoveryOperations.delete(key); return {state:'NOT_REQUIRED',nextCheckAt:null,recoveryId:null}; }
      for (const endpoint of discovered.endpoints) {
        const lock = (await db.query('SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked',[`research-wsh-endpoint:${endpoint.endpointId}`])).rows[0];
        if (lock.locked !== true) return {state:'BUSY',nextCheckAt:retry(),recoveryId:null};
      }
      await db.query('BEGIN');
      await db.query('LOCK TABLE research_recovery_challenges IN SHARE MODE');
      await this.assertAuthority(identity, db);
      for (const endpoint of discovered.endpoints) {
        await db.query('INSERT INTO research_wsh_endpoints(endpoint_id) VALUES($1) ON CONFLICT DO NOTHING',[endpoint.endpointId]);
        await db.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1 FOR UPDATE',[endpoint.endpointId]);
      }
      for (const issuer of discovered.issuers) await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`research-wsh-issuer:${issuer.ledgerKey}`]);
      for (const predecessor of [...discovered.predecessors].sort((a,b)=>a.id.localeCompare(b.id)||a.kind.localeCompare(b.kind))) {
        if (predecessor.kind === 'WSH_ATTEMPT') await db.query('SELECT id FROM research_wsh_refresh_attempts WHERE id=$1 FOR UPDATE',[predecessor.id]);
        else await db.query('SELECT id FROM research_wsh_acquisitions WHERE id=$1 FOR UPDATE',[predecessor.id]);
      }
      const record = await read();
      const scope = (value:WshReadRecoveryRecord) => researchHash({...value,recordedAt:null});
      if (scope(record) !== scope(discovered)) { await db.query('ROLLBACK'); return {state:'WAITING',nextCheckAt:retry(),recoveryId:null}; }
      const deadline = Math.max(...record.predecessors.map(p=>Date.parse(p.deadlineAt)));
      if (deadline > Date.parse(record.recordedAt)) { await db.query('ROLLBACK'); return {state:'WAITING',nextCheckAt:new Date(deadline).toISOString(),recoveryId:null}; }
      await db.query(`INSERT INTO research_wsh_read_recoveries(id,account_id,config_hash,manifest_hash,instrument_id,source_id,recorded_at,canonical_json,record_hash)
        SELECT $1,$2,$3,$4,$5,$6,$7,research_recovery_canonical($8::jsonb),encode(sha256(convert_to(research_recovery_canonical($8::jsonb),'UTF8')),'hex')`,
        [operationId,identity.accountId,identity.configHash,identity.manifestHash,identity.instrumentId,identity.sourceId,record.recordedAt,JSON.stringify(record)]);
      for (const predecessor of record.predecessors) await db.query(`INSERT INTO research_wsh_read_recovery_predecessors(recovery_id,kind,predecessor_id,identity_hash) VALUES($1,$2,$3,$4)`,[operationId,predecessor.kind,predecessor.id,predecessor.identityHash]);
      for (const challenge of record.challenges) await db.query('INSERT INTO research_wsh_read_recovery_challenges(recovery_id,challenge_id,challenge_hash) VALUES($1,$2,$3)',[operationId,challenge.id,challenge.hash]);
      for (const predecessor of record.predecessors) {
        if (predecessor.kind === 'WSH_ATTEMPT') await db.query(`UPDATE research_wsh_refresh_attempts SET state='UNKNOWN',finished_at=$2,failure_class='UNCERTAIN',failure_reason='RESEARCH_WSH_READ_GENERATION_SUPERSEDED',failure_stage='cleanup' WHERE id=$1 AND state='STARTED'`,[predecessor.id,record.recordedAt]);
        else await db.query(`UPDATE research_wsh_acquisitions SET state=CASE WHEN state='PENDING' THEN 'UNKNOWN' ELSE state END,retired_at=coalesce(retired_at,$2) WHERE id=$1 AND (state='PENDING' OR retired_at IS NULL)`,[predecessor.id,record.recordedAt]);
      }
      for (const endpoint of record.endpoints) {
        const changed = await db.query('UPDATE research_wsh_endpoints SET generation=$3 WHERE endpoint_id=$1 AND generation=$2 RETURNING endpoint_id',[endpoint.endpointId,endpoint.predecessorGeneration,endpoint.successorGeneration]);
        researchAssert(changed.rows.length===1,'RESEARCH_WSH_READ_RECOVERY_ENDPOINT_CHANGED');
      }
      committing = true;
      await db.query('COMMIT');
      this.wshRecoveryOperations.delete(key);
      return {state:'RECOVERED',nextCheckAt:null,recoveryId:operationId};
    } catch (error) {
      if (committing) return {state:'WAITING',nextCheckAt:retry(),recoveryId:this.wshRecoveryOperations.get(key)??null};
      throw error;
    } finally { bounded.destroy(); }
  }

  private readonly marketauxTickets = new WeakMap<MarketauxAttemptTicket, { deadline: number; ticketHash: string; failureDeadline?: number; wall: number; mono: number; invalid: boolean }>();
  private marketauxBudget(ticket: MarketauxAttemptTicket, failure = false): number {
    const budget = this.marketauxTickets.get(ticket);
    researchAssert(budget && budget.ticketHash === researchHash(ticket), 'RESEARCH_MARKETAUX_TICKET_INVALID');
    if (!failure) this.assertMarketauxClock(ticket);
    if (failure) budget.failureDeadline ??= performance.now() + 3000;
    return failure ? budget.failureDeadline! : budget.deadline;
  }
  private assertMarketauxClock(ticket: MarketauxAttemptTicket, wallDeadline?: number, monoDeadline?: number): void {
    const b=this.marketauxTickets.get(ticket);
    researchAssert(b && b.ticketHash===researchHash(ticket),'RESEARCH_MARKETAUX_TICKET_INVALID');
    const wall=this.recoveryClock.wallNow(),mono=this.recoveryClock.monotonicNow();
    if(b.invalid || Math.abs((wall-b.wall)-(mono-b.mono))>RECOVERY_CLOCK_TOLERANCE_MS || wall>=Math.min(b.wall+120000,wallDeadline??Infinity)
      || mono>=b.mono+120000 || performance.now()>=Math.min(b.deadline,monoDeadline??Infinity)){
      b.invalid=true;throw new Error('RESEARCH_MARKETAUX_CLOCK_OR_DEADLINE_INVALID');
    }
  }
  private async recoveryClockSample(db:ResearchDb,ticket?:MarketauxAttemptTicket):Promise<{db:number;wall:number}> {
    const before=this.recoveryClock.monotonicNow(),wallBefore=this.recoveryClock.wallNow();
    const now=await this.now(db),wall=this.recoveryClock.wallNow(),after=this.recoveryClock.monotonicNow();
    if(Math.abs(now-wall)>RECOVERY_CLOCK_TOLERANCE_MS || after-before>RECOVERY_CLOCK_TOLERANCE_MS || wall-wallBefore>RECOVERY_CLOCK_TOLERANCE_MS
      || after<before || wall<wallBefore || Math.abs((wall-wallBefore)-(after-before))>RECOVERY_CLOCK_TOLERANCE_MS){
      const b=ticket&&this.marketauxTickets.get(ticket);if(b)b.invalid=true;
      throw new Error('RESEARCH_RECOVERY_CLOCK_UNPROVED');
    }
    if(ticket)this.assertMarketauxClock(ticket);return {db:now,wall};
  }
  // Marketaux writers lock the attempt table before authority SHARE, attempt rows and snapshot head.
  // Admission readers take authority SHARE, then attempt-table SHARE, then head; authority SHAREs
  // are compatible. Adoption takes authority UPDATE but never waits for this table/head protocol.
  // Callers must not pre-lock a head before entering bind/validateBinding/prepareRepair.
  private async marketauxTransaction<T>(run: (db: ResearchDb) => Promise<T>, deadline: number, readOnly = false): Promise<T> {
    const bounded = await connectWshBounded(this.pool, undefined, deadline);
    try {
      const db = bounded.db; await db.query('BEGIN');
      await db.query('LOCK TABLE research_recovery_challenges IN SHARE MODE');
      if (!readOnly) await db.query('LOCK TABLE research_marketaux_attempts IN ROW EXCLUSIVE MODE');
      const result = await run(db); await db.query('COMMIT'); return result;
    } catch (error) { bounded.destroy(); throw error; }
    finally { bounded.release(); }
  }
  private async marketauxSource(identity: ResearchIdentity & { instrumentId: string; sourceId: string }, db: ResearchDb) {
    const manifest = await this.readManifest(identity, db), policy = manifest.instruments.find(p => p.instrumentId === identity.instrumentId);
    const source = policy?.sources.find(s => s.id === identity.sourceId);
    researchAssert(isTwoSourceResearch(manifest) && policy && source, 'RESEARCH_MARKETAUX_SOURCE_INVALID');
    const config = parseMarketauxNewsConfig(source, policy);
    researchAssert(config.kind === 'marketaux-news-v2', 'RESEARCH_MARKETAUX_SOURCE_INVALID');
    return { manifest, policy, source, config, ledger: 'marketaux:ibkr-conid:' + config.qualification.conId };
  }
  private async marketauxTicketRow(ticket: MarketauxAttemptTicket, db: ResearchDb, states: string[]) {
    const row = (await db.query('SELECT * FROM research_marketaux_attempts WHERE id=$1 FOR UPDATE', [ticket.attemptId])).rows[0];
    researchAssert(row && states.includes(String(row.state)) && row.account_id === ticket.accountId && row.config_hash === ticket.configHash && row.manifest_hash === ticket.manifestHash && row.instrument_id === ticket.instrumentId && row.source_id === ticket.sourceId && row.source_hash === ticket.sourceHash && Number(row.slot) === ticket.slot && iso(row.started_at) === ticket.startedAt && iso(row.deadline_at) === ticket.deadlineAt, 'RESEARCH_MARKETAUX_TICKET_INVALID');
    return row;
  }
  async claimMarketauxAttempt(identity: MarketauxAttemptIdentity): Promise<MarketauxAttemptClaim> {
    const deadline = performance.now() + 120000, wall=this.recoveryClock.wallNow(),mono=this.recoveryClock.monotonicNow();
    return this.marketauxTransaction(async db => {
      researchAssert(/^[A-Za-z0-9_-]{1,80}$/.test(identity.accountId), 'RESEARCH_ACCOUNT_INVALID');
      await this.assertAuthority(identity, db);
      const { source, config, ledger, policy } = await this.marketauxSource(identity, db);
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`research-marketaux-issuer:${identity.accountId}:${ledger}`]);
      await this.assertAuthority(identity, db);
      const sample=await this.recoveryClockSample(db),now=sample.db; marketauxQualificationDeadline(config, now);
      await this.assertRecoveryAdmission(identity,db);
      researchAssert(source.automation === "PERMITTED" && source.retention === "FACTS_AND_REFERENCES" && policy.verification.outcome === "VERIFIED" && researchTime(policy.verification.verifiedAt) <= now, "RESEARCH_PERMISSION_UNVERIFIED");
      const prior = (await db.query('SELECT * FROM research_marketaux_attempts WHERE account_id=$1 AND ledger_key=$2 ORDER BY started_at DESC', [identity.accountId, ledger])).rows;
      const recovered=new Set((await db.query('SELECT attempt_id FROM research_marketaux_recoveries WHERE account_id=$1 AND ledger_key=$2',[identity.accountId,ledger])).rows.map(r=>r.attempt_id));
      const unresolved = prior.find(r => ['STARTED','FINALIZING','UNKNOWN'].includes(String(r.state)) && !recovered.has(r.id));
      if (unresolved) return { claimed: false, reason: 'RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED', nextCheckAt: unresolved.state === 'STARTED' && now < researchTime(iso(unresolved.deadline_at)) ? iso(unresolved.deadline_at) : null };
      const next = prior.length ? researchTime(iso(prior[0].started_at)) + 3600000 : null;
      if (next !== null && now < next) return { claimed: false, reason: 'RESEARCH_MARKETAUX_SLOT_TOO_EARLY', nextCheckAt: new Date(next).toISOString() };
      const slot = Math.floor(now / 3600000), window = marketauxWindow(slot, config);
      const ticket: MarketauxAttemptTicket = { ...identity, attemptId: randomUUID(), sourceHash: researchHash(source), slot, startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 120000).toISOString(), ...window, monotonicDeadlineMs: deadline };
      await db.query(`INSERT INTO research_marketaux_attempts(id,account_id,provider,config_hash,manifest_hash,instrument_id,source_id,ledger_key,source_hash,slot,started_at,deadline_at,state,recovery_protocol,clock_domain_id,clock_db_at,clock_wall_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'STARTED',$13,$14,$15,$16)`, [ticket.attemptId, identity.accountId, source.provider, identity.configHash, identity.manifestHash, identity.instrumentId, identity.sourceId, ledger, ticket.sourceHash, slot, ticket.startedAt, ticket.deadlineAt,MARKETAUX_RECOVERY_PROTOCOL,this.recoveryClock.domainId(),new Date(sample.db),new Date(sample.wall)]);
      this.marketauxTickets.set(ticket, { deadline, ticketHash: researchHash(ticket),wall,mono,invalid:false }); return { claimed: true, ticket };
    }, deadline);
  }
  async reserveMarketauxCall(ticket: MarketauxAttemptTicket, request: MarketauxRequest, reservation: Omit<ResearchCallReservation, 'deadlineAt'>): Promise<{ deadlineAt: string; monotonicDeadlineMs: number; assertActive:()=>void }> {
    const budget = this.marketauxBudget(ticket), entered = performance.now(), wallEntered=this.recoveryClock.wallNow();
    const result = await this.marketauxTransaction(async db => {
      await this.assertAuthority(ticket, db);
      const { source, config, policy } = await this.marketauxSource(ticket, db);
      await this.marketauxTicketRow(ticket, db, ['STARTED']);
      await this.assertRecoveryAdmission(ticket,db); await this.recoveryClockSample(db,ticket);
      researchAssert('kind' in request && request.kind === 'marketaux-news-v2' && request.attemptId === ticket.attemptId && request.slot === ticket.slot && request.windowStart === ticket.windowStart && request.asOf === ticket.asOf, 'RESEARCH_MARKETAUX_REQUEST_INVALID');
      const expected = marketauxCallIdentity(ticket.manifestHash, ticket.instrumentId, source, request), now = await this.now(db), expiry = marketauxQualificationDeadline(config, now);
      researchAssert(source.automation === "PERMITTED" && source.retention === "FACTS_AND_REFERENCES" && policy.verification.outcome === "VERIFIED" && researchTime(policy.verification.verifiedAt) <= now, "RESEARCH_PERMISSION_UNVERIFIED");
      researchAssert(source && researchHash(source) === ticket.sourceHash && reservation.callKey === expected.callKey && reservation.requestHash === expected.requestHash && reservation.accountId === ticket.accountId && reservation.provider === source.provider && reservation.kind === 'source' && reservation.configHash === ticket.configHash && reservation.manifestHash === ticket.manifestHash, 'RESEARCH_MARKETAUX_REQUEST_INVALID');
      const manifest = await this.readManifest(ticket,db), providers = manifest.instruments.flatMap(p=>p.sources).filter(s=>s.provider===source.provider);
      researchAssert(reservation.maxRequestsPerDay===Math.min(...providers.map(s=>s.maxRequestsPerDay)) && reservation.maxCostMicrosPerDay===Math.min(...providers.map(s=>s.maxCostMicrosPerDay)) && reservation.reservedCostMicros===Math.max(...providers.map(s=>s.costMicrosPerCall)), 'RESEARCH_BUDGET_MANIFEST_MISMATCH');
      const remaining = Math.min(10000, researchTime(ticket.deadlineAt) - now, budget - performance.now(), expiry === null ? 10000 : expiry - now);
      researchAssert(remaining > 0, 'RESEARCH_MARKETAUX_ATTEMPT_EXPIRED');
      const deadlineAt = new Date(Math.floor(now + remaining)).toISOString();
      try { await this.reserveCall({ ...reservation, deadlineAt }, db, ticket.attemptId); }
      catch (error) {
        if (!(error instanceof ResearchBudgetExhausted)) throw error;
        const p = error.proof;
        await db.query(`INSERT INTO research_marketaux_budget_denials(attempt_id,budget_day,recorded_at,requests_used,cost_used,max_requests,max_cost,next_cost)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [ticket.attemptId,p.day,p.recordedAt,p.requests,p.cost,p.maxRequests,p.maxCost,p.nextCost]);
        return { denied: true as const };
      }
      await db.query('INSERT INTO research_marketaux_attempt_calls(call_key,attempt_id,pass,page) VALUES($1,$2,$3,$4)', [expected.callKey,ticket.attemptId,request.pass,request.page]);
      return { deadlineAt, monotonicDeadlineMs: Math.min(budget, entered + remaining),wallDeadline:wallEntered+remaining };
    }, budget);
    if ("denied" in result) throw new Error("RESEARCH_BUDGET_EXHAUSTED");
    const assertActive=()=>this.assertMarketauxClock(ticket,result.wallDeadline,result.monotonicDeadlineMs);
    assertActive(); return {deadlineAt:result.deadlineAt,monotonicDeadlineMs:result.monotonicDeadlineMs,assertActive};
  }
  async recordMarketauxCallOutcome(ticket: MarketauxAttemptTicket, callKey: string, result: { outcome: 'SUCCEEDED'; contentHash: string } | { outcome: 'FAILED' | 'UNKNOWN' }): Promise<{ recordedAt: string }> {
    const deadline = this.marketauxBudget(ticket, result.outcome !== 'SUCCEEDED');
    return this.marketauxTransaction(async db => {
      await this.assertAuthority(ticket, db);
      await db.query('LOCK TABLE research_marketaux_attempts IN ROW EXCLUSIVE MODE');
      await this.marketauxTicketRow(ticket, db, ['STARTED']);
      const call = (await db.query(`SELECT r.* FROM research_marketaux_attempt_calls c JOIN research_call_reservations r USING(call_key) WHERE c.attempt_id=$1 AND c.call_key=$2`, [ticket.attemptId,callKey])).rows[0];
      researchAssert(call, 'RESEARCH_MARKETAUX_CALL_INVALID');
      const now = await this.now(db);
      if (result.outcome === 'SUCCEEDED') { await this.recoveryClockSample(db,ticket); await this.assertRecoveryAdmission(ticket,db); }
      if (result.outcome === 'SUCCEEDED') researchAssert(isResearchHash(result.contentHash) && now < researchTime(iso(call.deadline_at)) && now < researchTime(ticket.deadlineAt), 'RESEARCH_MARKETAUX_CALL_EXPIRED');
      const stamp = new Date(now).toISOString();
      await db.query('INSERT INTO research_call_outcomes(call_key,outcome,recorded_at) VALUES($1,$2,$3)', [callKey,result.outcome,stamp]);
      await db.query('INSERT INTO research_marketaux_response_receipts(call_key,content_hash,recorded_at) VALUES($1,$2,$3)', [callKey,result.outcome === 'SUCCEEDED' ? result.contentHash : null,stamp]);
      if(result.outcome==='SUCCEEDED')researchAssert((await this.recoveryClockSample(db,ticket)).db<researchTime(iso(call.deadline_at)),'RESEARCH_MARKETAUX_CALL_EXPIRED');
      return { recordedAt: stamp };
    }, deadline);
  }
  private async marketauxFinalizeFence(ticket: MarketauxAttemptTicket, deadline: number): Promise<void> {
    await this.marketauxTransaction(async db => {
      await this.assertAuthority(ticket, db); await this.marketauxTicketRow(ticket, db, ['STARTED']);
      await this.assertRecoveryAdmission(ticket,db);
      await db.query("UPDATE research_marketaux_attempts SET state='FINALIZING' WHERE id=$1", [ticket.attemptId]);
    }, deadline);
  }
  private async marketauxCalls(ticket: Pick<MarketauxAttemptTicket, "attemptId">, db: ResearchDb) {
    return (await db.query(`SELECT c.pass,c.page,r.*,o.outcome,o.recorded_at,receipt.content_hash,receipt.recorded_at AS receipt_at
      FROM research_marketaux_attempt_calls c JOIN research_call_reservations r USING(call_key)
      LEFT JOIN research_call_outcomes o USING(call_key) LEFT JOIN research_marketaux_response_receipts receipt USING(call_key)
      WHERE c.attempt_id=$1 ORDER BY c.pass,c.page`, [ticket.attemptId])).rows;
  }
  private marketauxProjection(snapshot: ResearchSnapshot, sourceId: string) {
    const evidence = snapshot.evidence.filter(e => e.sourceId === sourceId), refs = new Set(evidence.map(e => e.ref));
    return { coverage: snapshot.coverage.filter(c => c.sourceId === sourceId), evidence, news: snapshot.news.filter(n => refs.has(n.evidenceRef)) };
  }
  private async mergeMarketauxSnapshot(ticket: MarketauxAttemptTicket, incoming: ResearchSnapshot, manifest: ResearchManifest, db: ResearchDb): Promise<ResearchSnapshot> {
    const parsed = parseResearchSnapshot(incoming, manifest);
    researchAssert(isTwoSourceResearch(parsed) && parsed.instrumentId === ticket.instrumentId && parsed.configHash === ticket.configHash && parsed.manifestHash === ticket.manifestHash, 'RESEARCH_MARKETAUX_PUBLICATION_IDENTITY');
    const keys = [ticket.configHash,ticket.manifestHash,ticket.instrumentId];
    await db.query('INSERT INTO research_snapshot_heads(config_hash,manifest_hash,instrument_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', keys);
    const current = await this.latestSnapshot(ticket, db, true);
    if (!current) researchAssert(parsed.coverage.every(c => c.sourceId === ticket.sourceId) && parsed.evidence.every(e => e.sourceId === ticket.sourceId) && parsed.events.length === 0, "RESEARCH_MARKETAUX_SOURCE_PROJECTION_INVALID");
    const merged = structuredClone(current?.snapshot ?? parsed);
    researchAssert(isTwoSourceResearch(merged), 'RESEARCH_POLICY_INVALID');
    const oldRefs = new Set(merged.evidence.filter(e => e.sourceId === ticket.sourceId).map(e => e.ref));
    const projection = this.marketauxProjection(parsed, ticket.sourceId);
    merged.coverage = [...merged.coverage.filter(c => c.sourceId !== ticket.sourceId), ...projection.coverage];
    merged.evidence = [...merged.evidence.filter(e => e.sourceId !== ticket.sourceId), ...projection.evidence];
    merged.news = [...merged.news.filter(n => !oldRefs.has(n.evidenceRef)), ...projection.news] as typeof merged.news;
    merged.createdAt = parsed.createdAt; return merged;
  }
  async finalizeMarketauxSuccess(ticket: MarketauxAttemptTicket, build: (completedAt: string) => ResearchSnapshot): Promise<StoredResearchSnapshot> {
    const deadline = this.marketauxBudget(ticket);
    await this.marketauxFinalizeFence(ticket, deadline);
    return this.marketauxTransaction(async db => {
      await this.assertAuthority(ticket, db);
      const { manifest, config, source, policy } = await this.marketauxSource(ticket, db);
      await this.marketauxTicketRow(ticket, db, ['FINALIZING']);
      await db.query('INSERT INTO research_snapshot_heads(config_hash,manifest_hash,instrument_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ticket.configHash,ticket.manifestHash,ticket.instrumentId]);
      await this.latestSnapshot(ticket,db,true);
      const now = (await this.recoveryClockSample(db,ticket)).db; marketauxQualificationDeadline(config, now);
      researchAssert(source.automation === 'PERMITTED' && source.retention === 'FACTS_AND_REFERENCES' && policy.verification.outcome === 'VERIFIED' && researchTime(policy.verification.verifiedAt) <= now, 'RESEARCH_PERMISSION_UNVERIFIED');
      researchAssert(now < researchTime(ticket.deadlineAt), 'RESEARCH_MARKETAUX_ATTEMPT_EXPIRED');
      const completedAt = new Date(now).toISOString(), incoming = build(completedAt);
      researchAssert(incoming.createdAt === completedAt, 'RESEARCH_MARKETAUX_COMPLETION_INVALID');
      const snapshot = await this.mergeMarketauxSnapshot(ticket, incoming, manifest, db);
      const coverage = snapshot.coverage.find(c => c.sourceId === ticket.sourceId);
      researchAssert(coverage && 'acquisition' in coverage && coverage.complete && ['AVAILABLE','EMPTY'].includes(coverage.status) && coverage.acquisition?.kind === 'marketaux-news-v2', 'RESEARCH_MARKETAUX_RECEIPT_INVALID');
      const a = coverage.acquisition, calls = await this.marketauxCalls(ticket, db);
      researchAssert(a.attemptId === ticket.attemptId && a.startedAt === ticket.startedAt && a.completedAt === completedAt && a.sourceHash === ticket.sourceHash && a.slot === ticket.slot && a.asOf === ticket.asOf && coverage.windowStart === ticket.windowStart && calls.length === a.pages.length, 'RESEARCH_MARKETAUX_RECEIPT_INVALID');
      for (const page of a.pages) {
        const call = calls.find(c => c.call_key === page.callKey);
        researchAssert(call && call.outcome === 'SUCCEEDED' && Number(call.pass) === page.pass && Number(call.page) === page.page && call.request_hash === page.requestHash && call.content_hash === page.contentHash && iso(call.recorded_at) === page.fetchedAt && iso(call.receipt_at) === page.fetchedAt, 'RESEARCH_MARKETAUX_RECEIPT_INVALID');
      }
      const stored = await this.persistSnapshot(snapshot, researchRefreshSlotKey(ticket.manifestHash,ticket.instrumentId,ticket.sourceId,'news',ticket.slot), ticket.deadlineAt, db, undefined, ticket.attemptId);
      await db.query(`UPDATE research_marketaux_attempts SET state='SUCCEEDED',finished_at=$2,snapshot_id=$3,projection_hash=$4 WHERE id=$1`, [ticket.attemptId,completedAt,stored.id,researchHash(this.marketauxProjection(stored.snapshot,ticket.sourceId))]);
      researchAssert((await this.recoveryClockSample(db,ticket)).db<researchTime(ticket.deadlineAt),'RESEARCH_MARKETAUX_ATTEMPT_EXPIRED');
      return stored;
    }, deadline);
  }
  async finishMarketauxFailure(ticket: MarketauxAttemptTicket, failure: MarketauxAttemptFailure, buildNegative: (recordedAt: string) => ResearchSnapshot): Promise<{ retained: boolean; snapshot: StoredResearchSnapshot | null }> {
    const deadline = this.marketauxBudget(ticket, true);
    researchAssert(/^RESEARCH_[A-Z0-9_]{1,100}$/.test(failure.reason) && (!failure.sourceError || isResearchSourceError(failure.sourceError)), 'RESEARCH_MARKETAUX_FAILURE_INVALID');
    await this.marketauxFinalizeFence(ticket, deadline);
    return this.marketauxTransaction(async db => {
      await this.assertAuthority(ticket, db); const { manifest,config,source,policy } = await this.marketauxSource(ticket, db);
      await this.marketauxTicketRow(ticket, db, ['FINALIZING']);
      await db.query('INSERT INTO research_snapshot_heads(config_hash,manifest_hash,instrument_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ticket.configHash,ticket.manifestHash,ticket.instrumentId]);
      await this.latestSnapshot(ticket,db,true);
      const calls = await this.marketauxCalls(ticket, db), now = await this.now(db), stamp = new Date(now).toISOString();
      const known = calls.every(c => ['SUCCEEDED','FAILED'].includes(String(c.outcome)) && c.recorded_at && c.receipt_at && iso(c.recorded_at) === iso(c.receipt_at));
      try { await this.recoveryClockSample(db,ticket); } catch(error) {
        if(!(error instanceof Error)||!['RESEARCH_RECOVERY_CLOCK_UNPROVED','RESEARCH_MARKETAUX_CLOCK_OR_DEADLINE_INVALID'].includes(error.message))throw error;
      }
      if (failure.outcome === 'UNKNOWN' || this.marketauxTickets.get(ticket)?.invalid || !known) {
        await db.query("UPDATE research_marketaux_attempts SET state='UNKNOWN',finished_at=$2,failure_class='UNKNOWN',failure_reason=$3,source_error=$4 WHERE id=$1", [ticket.attemptId,stamp,failure.reason,failure.sourceError ?? null]);
        return { retained: false, snapshot: null };
      }
      const current = await this.latestSnapshot(ticket, db, true);
      if (current) await this.assertMarketauxSnapshotProvenance(current.snapshot, db);
      const old = current?.snapshot.coverage.find(c => c.sourceId === ticket.sourceId);
      const http = failure.sourceError?.httpStatus;
      const transient = http !== undefined && [429,500,502,503,504].includes(http) && failure.reason === `RESEARCH_SOURCE_HTTP_${http}` && calls.some(c => c.outcome === 'FAILED');
      const denial = (await db.query('SELECT * FROM research_marketaux_budget_denials WHERE attempt_id=$1',[ticket.attemptId])).rows[0];
      const budget = failure.reason === 'RESEARCH_BUDGET_EXHAUSTED' && failure.sourceError?.httpStatus === undefined && calls.every(c => c.outcome === 'SUCCEEDED') && Boolean(denial);
      let rights = false; try { marketauxQualificationDeadline(config, now); rights = source.automation === "PERMITTED" && source.retention === "FACTS_AND_REFERENCES" && policy.verification.outcome === "VERIFIED" && researchTime(policy.verification.verifiedAt) <= now; } catch { /* A failed qualification cannot retain cached news. */ }
      const retained = Boolean(current && old && old.complete && ['AVAILABLE','EMPTY'].includes(old.status) && now >= researchTime(old.checkedAt) && now < researchTime(old.checkedAt) + config.maxAgeMs && rights && (transient || budget));
      let stored = current;
      if (!retained) {
        const incoming = buildNegative(stamp);
        researchAssert(incoming.createdAt === stamp, 'RESEARCH_MARKETAUX_COMPLETION_INVALID');
        const projection = this.marketauxProjection(incoming,ticket.sourceId), negative = projection.coverage[0];
        researchAssert(projection.coverage.length === 1 && !projection.evidence.length && !projection.news.length && negative?.status === 'ERROR' && !negative.complete && negative.checkedAt === stamp && negative.reason === failure.reason && canonicalJson(negative.sourceError ?? null) === canonicalJson(failure.sourceError ?? null), 'RESEARCH_MARKETAUX_NEGATIVE_INVALID');
        const snapshot = await this.mergeMarketauxSnapshot(ticket,incoming,manifest,db);
        stored = await this.persistSnapshot(snapshot,researchRefreshSlotKey(ticket.manifestHash,ticket.instrumentId,ticket.sourceId,'news',ticket.slot),undefined,db);
      } else {
        await db.query('INSERT INTO research_refresh_slots(slot_key,snapshot_id) VALUES($1,$2)', [researchRefreshSlotKey(ticket.manifestHash,ticket.instrumentId,ticket.sourceId,'news',ticket.slot),stored!.id]);
      }
      researchAssert(stored, 'RESEARCH_MARKETAUX_PUBLICATION_INVALID');
      await db.query(`UPDATE research_marketaux_attempts SET state='FAILED',finished_at=$2,failure_reason=$3,source_error=$4,snapshot_id=$5,retained=$6,projection_hash=$7,failure_class=$8 WHERE id=$1`, [ticket.attemptId,stamp,failure.reason,failure.sourceError ?? null,stored.id,retained,researchHash(this.marketauxProjection(stored.snapshot,ticket.sourceId)),transient ? 'TRANSIENT' : budget ? 'BUDGET' : 'HARD']);
      await this.recoveryClockSample(db,ticket);
      return { retained, snapshot: stored };
    }, deadline);
  }
  private async assertMarketauxSnapshotProvenance(snapshot: ResearchSnapshot, db: ResearchDb, publishingId?: string): Promise<void> {
    if (!isTwoSourceResearch(snapshot)) return;
    for (const coverage of snapshot.coverage) {
      if (!('acquisition' in coverage) || coverage.acquisition?.kind !== 'marketaux-news-v2') continue;
      const row = (await db.query('SELECT * FROM research_marketaux_attempts WHERE id=$1', [coverage.acquisition.attemptId])).rows[0];
      researchAssert(row && row.config_hash === snapshot.configHash && row.manifest_hash === snapshot.manifestHash && row.instrument_id === snapshot.instrumentId && row.source_id === coverage.sourceId && (row.state === 'SUCCEEDED' || row.state === 'FINALIZING' && row.id === publishingId), 'RESEARCH_MARKETAUX_PROVENANCE_INVALID');
      if (row.state === 'SUCCEEDED') {
        const a = coverage.acquisition;
        researchAssert(row.projection_hash === researchHash(this.marketauxProjection(snapshot,coverage.sourceId)) && a.sourceHash === row.source_hash && a.startedAt === iso(row.started_at) && a.completedAt === iso(row.finished_at) && Number(row.slot) === a.slot && researchTime(a.completedAt) < researchTime(iso(row.deadline_at)), 'RESEARCH_MARKETAUX_PROVENANCE_INVALID');
        const original = await this.readSnapshot(String(row.snapshot_id),db);
        researchAssert(original && researchHash(this.marketauxProjection(original.snapshot,coverage.sourceId)) === row.projection_hash, 'RESEARCH_MARKETAUX_PROVENANCE_INVALID');
        const calls = await this.marketauxCalls({attemptId:String(row.id)},db);
        researchAssert(calls.length === a.pages.length && calls.length >= 2, 'RESEARCH_MARKETAUX_PROVENANCE_INVALID');
        for (const p of a.pages) {
          const c = calls.find(c=>c.call_key === p.callKey);
          researchAssert(c && c.outcome === 'SUCCEEDED' && c.account_id === row.account_id && c.config_hash === row.config_hash && c.manifest_hash === row.manifest_hash && c.content_hash === p.contentHash && c.request_hash === p.requestHash && Number(c.pass) === p.pass && Number(c.page) === p.page && iso(c.recorded_at) === p.fetchedAt && iso(c.receipt_at) === p.fetchedAt && researchTime(p.fetchedAt) < researchTime(iso(c.deadline_at)) && researchTime(iso(c.deadline_at)) <= researchTime(iso(row.deadline_at)), 'RESEARCH_MARKETAUX_PROVENANCE_INVALID');
        }
      }
    }
  }
  private async marketauxFailureProof(identity: ResearchIdentity & { instrumentId: string; sourceId?: string; accountId?: string }, db: ResearchDb): Promise<boolean> {
    const rows = (await db.query(`SELECT a.* FROM research_marketaux_attempts a WHERE a.config_hash=$1 AND a.manifest_hash=$2 AND a.instrument_id=$3 AND a.state='FAILED'
      AND ($4::text IS NULL OR a.source_id=$4) AND ($5::text IS NULL OR a.account_id=$5)
      AND NOT EXISTS(SELECT 1 FROM research_marketaux_attempts good WHERE good.config_hash=a.config_hash AND good.manifest_hash=a.manifest_hash AND good.instrument_id=a.instrument_id AND good.source_id=a.source_id AND good.account_id=a.account_id AND good.state='SUCCEEDED' AND good.started_at>a.started_at)`,[identity.configHash,identity.manifestHash,identity.instrumentId,identity.sourceId??null,identity.accountId??null])).rows;
    for (const row of rows) {
      if (!['TRANSIENT','BUDGET'].includes(String(row.failure_class))) return false;
      const error = row.source_error as ResearchSourceError | null;
      if (error && !isResearchSourceError(error)) return false;
      const original = row.snapshot_id ? await this.readSnapshot(String(row.snapshot_id),db) : null;
      if (!original || original.snapshot.configHash !== row.config_hash || original.snapshot.manifestHash !== row.manifest_hash || original.snapshot.instrumentId !== row.instrument_id || row.projection_hash !== researchHash(this.marketauxProjection(original.snapshot,String(row.source_id)))) return false;
      const calls = await this.marketauxCalls({attemptId:String(row.id)},db);
      if (calls.some(c=>!['SUCCEEDED','FAILED'].includes(String(c.outcome)) || !c.recorded_at || !c.receipt_at || iso(c.recorded_at)!==iso(c.receipt_at) || c.outcome==='SUCCEEDED'&&!isResearchHash(c.content_hash) || c.outcome==='FAILED'&&c.content_hash!==null || c.account_id!==row.account_id || c.config_hash!==row.config_hash || c.manifest_hash!==row.manifest_hash || researchTime(iso(c.recorded_at))>researchTime(iso(row.finished_at)))) return false;
      if (row.failure_class === 'TRANSIENT') {
        if (!error?.httpStatus || ![429,500,502,503,504].includes(error.httpStatus) || row.failure_reason!==`RESEARCH_SOURCE_HTTP_${error.httpStatus}` || !calls.some(c=>c.outcome==='FAILED')) return false;
      } else {
        const denial=(await db.query('SELECT * FROM research_marketaux_budget_denials WHERE attempt_id=$1',[row.id])).rows[0];
        if (row.failure_reason!=='RESEARCH_BUDGET_EXHAUSTED' || error?.httpStatus!==undefined || !denial || calls.some(c=>c.outcome!=='SUCCEEDED') || researchTime(iso(denial.recorded_at))<researchTime(iso(row.started_at)) || researchTime(iso(denial.recorded_at))>researchTime(iso(row.finished_at))) return false;
      }
      if (row.retained) {
        await this.assertMarketauxSnapshotProvenance(original.snapshot,db);
        const c=original.snapshot.coverage.find(c=>c.sourceId===row.source_id);
        const {config,source,policy}=await this.marketauxSource({...identity,sourceId:String(row.source_id)},db), at=researchTime(iso(row.finished_at));
        if (!c?.complete || !['AVAILABLE','EMPTY'].includes(c.status) || at<researchTime(c.checkedAt) || at>=researchTime(c.checkedAt)+config.maxAgeMs || source.automation!=='PERMITTED' || source.retention!=='FACTS_AND_REFERENCES' || policy.verification.outcome!=='VERIFIED') return false;
        try {marketauxQualificationDeadline(config,at);} catch {return false;}
      } else {
        const c=original.snapshot.coverage.find(c=>c.sourceId===row.source_id);
        if (!c || c.complete || c.status!=='ERROR' || c.reason!==row.failure_reason || canonicalJson(c.sourceError??null)!==canonicalJson(error)) return false;
      }
    }
    return true;
  }
  private async marketauxAdmissionReasons(identity: ResearchIdentity & { instrumentId: string; sourceId?: string; accountId?: string }, db: ResearchDb): Promise<string[]> {
    if (!(await this.marketauxFailureProof(identity,db))) return ['RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED'];
    const orphan = (await db.query(`SELECT 1 FROM research_call_reservations r WHERE r.config_hash=$1 AND r.manifest_hash=$2 AND r.provider='https://api.marketaux.com' AND r.kind='source'
      AND ($3::text IS NULL OR r.account_id=$3) AND NOT EXISTS(SELECT 1 FROM research_marketaux_attempt_calls c WHERE c.call_key=r.call_key) LIMIT 1`, [identity.configHash,identity.manifestHash,identity.accountId ?? null])).rows.length;
    if (orphan) return ['RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED'];
    const rows = (await db.query(`SELECT a.* FROM research_marketaux_attempts a WHERE a.config_hash=$1 AND a.manifest_hash=$2 AND a.instrument_id=$3
      AND ($4::text IS NULL OR a.source_id=$4) AND ($5::text IS NULL OR a.account_id=$5)
      AND ((a.state IN ('FINALIZING','UNKNOWN')) OR (a.state='STARTED' AND (a.deadline_at<=clock_timestamp() OR EXISTS(
       SELECT 1 FROM research_marketaux_attempt_calls c JOIN research_call_reservations r USING(call_key) LEFT JOIN research_call_outcomes o USING(call_key)
       WHERE c.attempt_id=a.id AND (o.outcome IN ('UNKNOWN','FAILED') OR o.call_key IS NULL AND r.deadline_at<=clock_timestamp()))))
       OR (a.state='FAILED' AND a.failure_class='HARD'))
      AND NOT EXISTS(SELECT 1 FROM research_marketaux_attempts good WHERE good.config_hash=a.config_hash AND good.manifest_hash=a.manifest_hash AND good.instrument_id=a.instrument_id AND good.source_id=a.source_id AND good.account_id=a.account_id AND good.state='SUCCEEDED' AND good.started_at>a.started_at) LIMIT 1`, [identity.configHash,identity.manifestHash,identity.instrumentId,identity.sourceId ?? null,identity.accountId ?? null])).rows;
    return rows.length ? ['RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED'] : [];
  }
  async readMarketauxRefreshState(identity: MarketauxAttemptIdentity, existing?: ResearchDb): Promise<MarketauxRefreshState> {
    const read = async (db: ResearchDb): Promise<MarketauxRefreshState> => {
      const { config,ledger } = await this.marketauxSource(identity,db), stored = await this.latestSnapshot(identity,db);
      if (stored) await this.assertMarketauxSnapshotProvenance(stored.snapshot,db);
      const coverage = stored?.snapshot.coverage.find(c => c.sourceId === identity.sourceId && c.complete && 'acquisition' in c && c.acquisition?.kind === 'marketaux-news-v2');
      const success = coverage ? researchTime(coverage.checkedAt) : null, expiry = earliestSourceValidityExpiry(config.qualification,config.entitlement);
      const rows = (await db.query('SELECT * FROM research_marketaux_attempts WHERE account_id=$1 AND ledger_key=$2 ORDER BY started_at DESC', [identity.accountId,ledger])).rows;
      const own = rows.filter(r => r.config_hash === identity.configHash && r.manifest_hash === identity.manifestHash && r.instrument_id === identity.instrumentId && r.source_id === identity.sourceId);
      const failure = own.find(r => r.state === 'FAILED' || r.state === 'UNKNOWN'), active = rows.find(r => r.state === 'STARTED' || r.state === 'FINALIZING');
      const holdReasons = await this.marketauxAdmissionReasons(identity,db);
      const now = await this.now(db);
      const recovered=new Set((await db.query('SELECT attempt_id FROM research_marketaux_recoveries WHERE account_id=$1 AND ledger_key=$2',[identity.accountId,ledger])).rows.map(r=>r.attempt_id));
      if (rows.filter(r=>!recovered.has(r.id)).some(r => r.state === 'UNKNOWN' || r.state === 'FINALIZING' || r.state === 'STARTED' && researchTime(iso(r.deadline_at)) <= now) && !holdReasons.length) holdReasons.push('RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED');
      return { recovery:await this.recoveryDiagnostic(identity,ledger,null,db),sourceId:identity.sourceId,lastSuccessfulAt:success === null ? null : new Date(success).toISOString(), expiresAt:success === null ? null : new Date(Math.min(success+config.maxAgeMs,expiry ?? success+config.maxAgeMs)).toISOString(),
        nextRegularAt:rows.length ? new Date(researchTime(iso(rows[0].started_at))+3600000).toISOString() : null, activeAttemptId:active ? String(active.id) : null, holdReasons,
        latestFailure:failure ? { attemptId:String(failure.id),recordedAt:iso(failure.finished_at),reason:String(failure.failure_reason),...(failure.source_error ? { sourceError:failure.source_error as ResearchSourceError } : {}),retainedSnapshotId:failure.retained ? String(failure.snapshot_id) : null,retainedProjectionHash:failure.retained ? String(failure.projection_hash) : null } : null };
    };
    return existing ? read(existing) : this.marketauxTransaction(read,performance.now()+3000,true);
  }

  private async assertRecoveryAdmission(identity:ResearchIdentity & {instrumentId:string;accountId?:string},db:ResearchDb):Promise<void> {
    await db.query('LOCK TABLE research_recovery_challenges IN SHARE MODE');
    const manifest=await this.readManifest(identity,db),policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId);
    researchAssert(policy,'RESEARCH_RECOVERY_SCOPE_INVALID');
    for(const source of policy.sources){
      let ledger:string,endpoint:string|null=null;
      if(source.adapter==='ibkr-wsh'){const c=parseWshConfig(source,policy);ledger=wshLedgerKey(c.isin);endpoint=c.endpointId;}
      else if(source.adapter==='marketaux-news'){const c=parseMarketauxNewsConfig(source,policy);ledger='marketaux:ibkr-conid:'+c.qualification.conId;}
      else continue;
      const held=(await db.query('SELECT research_recovery_held($1,$2,$3) AS held',[identity.accountId??null,ledger,endpoint])).rows[0]?.held;
      researchAssert(!held,'RESEARCH_RECOVERY_MAINTENANCE_HOLD');
    }
  }
  private marketauxPredecessor(row:Record<string,unknown>):RecoveryPredecessor {
    const identity={id:row.id,accountId:row.account_id,configHash:row.config_hash,manifestHash:row.manifest_hash,instrumentId:row.instrument_id,
      sourceId:row.source_id,sourceHash:row.source_hash,ledgerKey:row.ledger_key,startedAt:iso(row.started_at),deadlineAt:iso(row.deadline_at)};
    return {kind:'MARKETAUX_ATTEMPT',id:String(row.id),identityHash:researchHash(identity),state:String(row.state),endpointId:null,ledgerKey:String(row.ledger_key),sessionId:null,generation:null};
  }
  private async appendMarketauxRecovery(row:Record<string,unknown>,db:ResearchDb,proof:{id:string;challengeId?:string;evidenceHash:string;wall?:number}):Promise<void> {
    await db.query(`INSERT INTO research_marketaux_recoveries(id,attempt_id,account_id,ledger_key,identity_hash,original_state,method,original_deadline,original_protocol,clock_domain_id,clock_wall_at,challenge_id,evidence_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[proof.id,row.id,row.account_id,row.ledger_key,this.marketauxPredecessor(row).identityHash,row.state,
      proof.challengeId?'OPERATOR_PRODUCERS_STOPPED':'EXPIRED_FENCED_DEADLINE',row.deadline_at,row.recovery_protocol,proof.challengeId?null:this.recoveryClock.domainId(),proof.wall===undefined?null:new Date(proof.wall),proof.challengeId??null,proof.evidenceHash]);
    await db.query(`INSERT INTO research_call_outcomes(call_key,outcome) SELECT c.call_key,'UNKNOWN' FROM research_marketaux_attempt_calls c
      WHERE c.attempt_id=$1 AND NOT EXISTS(SELECT 1 FROM research_call_outcomes o WHERE o.call_key=c.call_key)`,[row.id]);
    if(row.state!=='UNKNOWN')await db.query("UPDATE research_marketaux_attempts SET state='UNKNOWN',finished_at=clock_timestamp(),failure_class='UNKNOWN',failure_reason='RESEARCH_MARKETAUX_RECOVERED_ABANDONED_ATTEMPT' WHERE id=$1 AND state IN ('STARTED','FINALIZING')",[row.id]);
  }
  async recoverMarketauxAttempts(identity:MarketauxAttemptIdentity):Promise<MarketauxRecoveryResult> {
    const deadline=performance.now()+3000,wall=this.recoveryClock.wallNow(),mono=this.recoveryClock.monotonicNow(),planned:string[]=[];
    try{return await this.marketauxTransaction(async db=>{
      await this.assertAuthority(identity,db);await this.assertRecoveryAdmission(identity,db);
      const {ledger}=await this.marketauxSource(identity,db);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`research-marketaux-issuer:${identity.accountId}:${ledger}`]);
      const rows=(await db.query(`SELECT a.* FROM research_marketaux_attempts a WHERE account_id=$1 AND ledger_key=$2 AND state IN ('STARTED','FINALIZING','UNKNOWN')
        AND NOT EXISTS(SELECT 1 FROM research_marketaux_recoveries r WHERE r.attempt_id=a.id) ORDER BY started_at FOR UPDATE`,[identity.accountId,ledger])).rows;
      if(!rows.length)return {state:'NOT_REQUIRED',reason:null,nextCheckAt:null,recoveryIds:[]};
      const now=await this.now(db);
      const waiting=rows.find(r=>researchTime(iso(r.deadline_at))+RECOVERY_EXPIRY_MARGIN_MS>now);
      if(waiting)return {state:'WAITING',reason:'RESEARCH_MARKETAUX_ATTEMPT_ACTIVE',nextCheckAt:new Date(researchTime(iso(waiting.deadline_at))+RECOVERY_EXPIRY_MARGIN_MS).toISOString(),recoveryIds:[]};
      const domain=this.recoveryClock.domainId();
      if(rows.some(r=>r.recovery_protocol!==MARKETAUX_RECOVERY_PROTOCOL || !domain || r.clock_domain_id!==domain || !r.clock_db_at || !r.clock_wall_at
        || Math.abs(researchTime(iso(r.clock_db_at))-researchTime(iso(r.clock_wall_at)))>RECOVERY_CLOCK_TOLERANCE_MS))
        return {state:'OPERATOR_REQUIRED',reason:'RESEARCH_MARKETAUX_PRODUCER_QUIESCENCE_REQUIRED',nextCheckAt:null,recoveryIds:[]};
      const sample=await this.recoveryClockSample(db),ids:string[]=[];
      for(const row of rows){const id=randomUUID();planned.push(id);await this.appendMarketauxRecovery(row,db,{id,wall:sample.wall,evidenceHash:researchHash({protocol:MARKETAUX_RECOVERY_PROTOCOL,domain,attemptId:row.id,deadlineAt:iso(row.deadline_at),db:sample.db,wall:sample.wall})});ids.push(id);}
      await this.recoveryClockSample(db);
      researchAssert(Math.abs((this.recoveryClock.wallNow()-wall)-(this.recoveryClock.monotonicNow()-mono))<=RECOVERY_CLOCK_TOLERANCE_MS,'RESEARCH_RECOVERY_CLOCK_UNPROVED');
      return {state:'RECOVERED',reason:null,nextCheckAt:null,recoveryIds:ids};
    },deadline);}catch(error){
      if(error instanceof Error&&error.message==='RESEARCH_RECOVERY_CLOCK_UNPROVED')return {state:'OPERATOR_REQUIRED',reason:error.message,nextCheckAt:null,recoveryIds:[]};
      if(planned.length&&performance.now()<deadline){
        try{const bounded=await connectWshBounded(this.pool,undefined,deadline);try{
          const rows=(await bounded.db.query('SELECT id FROM research_marketaux_recoveries WHERE id=ANY($1::uuid[]) AND account_id=$2',[planned,identity.accountId])).rows;
          if(rows.length===planned.length)return {state:'RECOVERED',reason:null,nextCheckAt:null,recoveryIds:planned};
        }finally{bounded.destroy();}}catch{/* Unknown readback retains the original scheduling hold. */}
      }
      throw error;
    }
  }
  async readMarketauxAttemptResult(attemptId:string):Promise<{attemptId:string;state:string;snapshotId:string|null;verified:boolean}|null>{
    researchAssert(isRecoveryUuid(attemptId),'RESEARCH_RECOVERY_ID_INVALID');
    return this.marketauxTransaction(async db=>{
      const row=(await db.query('SELECT * FROM research_marketaux_attempts WHERE id=$1',[attemptId])).rows[0];if(!row)return null;
      await this.assertAuthority({configHash:String(row.config_hash),manifestHash:String(row.manifest_hash)},db);
      let verified=false;
      if(row.state==='SUCCEEDED'){
        const snapshot=await this.readSnapshot(String(row.snapshot_id),db);researchAssert(snapshot,'RESEARCH_MARKETAUX_PROVENANCE_INVALID');
        await this.assertMarketauxSnapshotProvenance(snapshot.snapshot,db);
        researchAssert(researchHash(this.marketauxProjection(snapshot.snapshot,String(row.source_id)))===row.projection_hash,'RESEARCH_MARKETAUX_PROVENANCE_INVALID');verified=true;
      }
      return {attemptId,state:String(row.state),snapshotId:row.snapshot_id?String(row.snapshot_id):null,verified};
    },performance.now()+3000,true);
  }
  private async recoveryDiagnostic(identity:MarketauxAttemptIdentity|WshAttemptIdentity,ledger:string,endpoint:string|null,db:ResearchDb):Promise<ResearchRecoveryDiagnostic>{
    const base:ResearchRecoveryDiagnostic={state:'NOT_REQUIRED',reason:null,nextCheckAt:null,operatorAction:null,challengeId:null,lastRecoveryId:null};
    if(endpoint){
      const record=(await db.query('SELECT research_wsh_read_recovery_record($1::jsonb,clock_timestamp()) AS record',[JSON.stringify(identity)])).rows[0].record as WshReadRecoveryRecord;
      const now=await this.now(db);
      if(record.predecessors.length)return {...base,state:'WAITING',reason:'RESEARCH_WSH_READ_RECOVERY_PENDING',challengeId:record.challenges[0]?.id??null,nextCheckAt:new Date(Math.max(now+1000,...record.predecessors.map(p=>Date.parse(p.deadlineAt)))).toISOString()};
      const last=(await db.query(`SELECT r.id,max((i->>'nextRegularAt')::timestamptz) AS due FROM research_wsh_read_recoveries r CROSS JOIN LATERAL jsonb_array_elements(r.canonical_json::jsonb->'issuers') i
        WHERE i->>'ledgerKey'=$1 AND NOT EXISTS(SELECT 1 FROM research_wsh_acquisitions good WHERE good.state='PUBLISHED' AND good.config_hash=$2 AND good.manifest_hash=$3 AND good.instrument_id=$4 AND good.source_id=$5 AND good.started_at>r.recorded_at)
        GROUP BY r.id ORDER BY r.recorded_at DESC LIMIT 1`,[ledger,identity.configHash,identity.manifestHash,identity.instrumentId,identity.sourceId])).rows[0];
      if(last)return {...base,state:'WAITING',reason:'RESEARCH_WSH_READ_RECOVERY_WAITING_REGULAR',nextCheckAt:new Date(Math.max(now+1000,researchTime(iso(last.due)))).toISOString(),lastRecoveryId:String(last.id)};
    }
    const hold=(await db.query(`SELECT id FROM research_recovery_challenges c WHERE state='PREPARED' AND
      ((kind='MARKETAUX_PRODUCER_QUIESCENCE' AND account_id=$1 AND ledger_key=$2) OR
       (kind='WSH_ENDPOINT_RESET' AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_challenges d WHERE d.challenge_id=c.id AND d.challenge_hash=c.challenge_hash) AND (endpoint_id=$3 OR ledger_key=$2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(predecessors) p WHERE p->>'ledgerKey'=$2)))) ORDER BY created_at LIMIT 1`,[identity.accountId,ledger,endpoint])).rows[0];
    if(hold)return {...base,state:'PREPARED',reason:'RESEARCH_RECOVERY_MAINTENANCE_HOLD',challengeId:String(hold.id),operatorAction:endpoint?'COMPLETE_RECONNECT_PROOF':'STOP_PRODUCERS'};
    if(endpoint){
      const pending=(await db.query(`SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
        WHERE (a.endpoint_id=$1 OR c.ledger_key=$2) AND (a.state='STARTED' AND a.deadline_at<=clock_timestamp() OR a.cleanup_state='UNKNOWN')
        AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.attempt_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors p WHERE p.kind='WSH_ATTEMPT' AND p.predecessor_id=a.id)
        UNION ALL SELECT 1 FROM research_wsh_acquisitions a WHERE (endpoint_id=$1 OR ledger_key=$2) AND state IN ('PENDING','UNKNOWN')
        AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts t WHERE t.acquisition_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.acquisition_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors p WHERE p.kind='WSH_ACQUISITION' AND p.predecessor_id=a.id) LIMIT 1`,[endpoint,ledger])).rows.length;
      const last=(await db.query(`SELECT r.id FROM research_wsh_recovery_receipts r WHERE r.endpoint_id=$1 ORDER BY recorded_at DESC LIMIT 1`,[endpoint])).rows[0];
      return {...base,state:pending?'OPERATOR_REQUIRED':last?'RECOVERED':'NOT_REQUIRED',reason:pending?'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED':null,operatorAction:pending?'OBSERVE_LOCAL_GATEWAY_RESTART':null,lastRecoveryId:last?String(last.id):null};
    }
    const last=(await db.query('SELECT id FROM research_marketaux_recoveries WHERE account_id=$1 AND ledger_key=$2 ORDER BY recorded_at DESC LIMIT 1',[identity.accountId,ledger])).rows[0];
    const rows=(await db.query(`SELECT a.* FROM research_marketaux_attempts a WHERE account_id=$1 AND ledger_key=$2 AND state IN ('STARTED','FINALIZING','UNKNOWN')
      AND NOT EXISTS(SELECT 1 FROM research_marketaux_recoveries r WHERE r.attempt_id=a.id)`,[identity.accountId,ledger])).rows;
    if(!rows.length)return {...base,state:last?'RECOVERED':'NOT_REQUIRED',lastRecoveryId:last?String(last.id):null};
    const domain=this.recoveryClock.domainId(),now=await this.now(db);
    const proved=rows.every(r=>r.recovery_protocol===MARKETAUX_RECOVERY_PROTOCOL&&domain!==null&&r.clock_domain_id===domain)&&Math.abs(now-this.recoveryClock.wallNow())<=RECOVERY_CLOCK_TOLERANCE_MS;
    return {...base,state:proved?'WAITING':'OPERATOR_REQUIRED',reason:proved?'RESEARCH_RECOVERY_DEADLINE_WAIT':'RESEARCH_RECOVERY_CLOCK_UNPROVED',operatorAction:proved?null:'STOP_PRODUCERS',
      nextCheckAt:proved?new Date(Math.max(now,...rows.map(r=>researchTime(iso(r.deadline_at))+RECOVERY_EXPIRY_MARGIN_MS))).toISOString():null,lastRecoveryId:last?String(last.id):null};
  }
  async readResearchRecoveryReceipt(challengeId:string,operationId:string):Promise<RecoveryReceipt|null>{
    researchAssert(isRecoveryUuid(operationId),'RESEARCH_RECOVERY_ID_INVALID');
    const deadline=performance.now()+3000,c=await this.recoveryChallengeById(challengeId,deadline);if(!c)return null;
    return this.recoveryTransaction(this.recoveryIdentity(c),async db=>{
      const audit=(await db.query("SELECT * FROM research_recovery_audit WHERE operation_id=$1 AND challenge_id=$2 AND action='COMMIT'",[operationId,challengeId])).rows[0];if(!audit)return null;
      const current=(await db.query('SELECT state,receipt_id FROM research_recovery_challenges WHERE id=$1',[challengeId])).rows[0];
      const result=audit.result_json as RecoveryReceipt;
      researchAssert(typeof audit.evidence_json==='string'&&researchHash(JSON.parse(audit.evidence_json))===audit.evidence_hash&&result.evidenceHash===audit.evidence_hash
        &&result.id===current.receipt_id&&current.state==='COMMITTED'&&result.challengeId===challengeId&&result.kind===c.kind,'RESEARCH_RECOVERY_RECEIPT_INVALID');
      return result;
    },c.executionProcessId,deadline);
  }
  private async recoveryScope(identity:RecoveryIdentity,db:ResearchDb):Promise<{ledger:string;endpoint:string|null}> {
    if(identity.kind==='MARKETAUX_PRODUCER_QUIESCENCE')return {ledger:(await this.marketauxSource(identity,db)).ledger,endpoint:null};
    const {config}=await this.wshSource(identity,db,false);return {ledger:wshLedgerKey(config.isin),endpoint:config.endpointId};
  }
  private async assertRecoveryMaintenanceAuthority(identity:RecoveryIdentity,db:ResearchDb,expectedProcess?:string):Promise<string>{
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`snap:${identity.accountId}`]);
    const control=(await db.query('SELECT paused,revision FROM execution_entry_controls WHERE account_id=$1 FOR UPDATE',[identity.accountId])).rows[0];
    researchAssert(control?.paused===true&&Number(control.revision)===identity.pauseRevision,'RESEARCH_RECOVERY_PAUSE_CHANGED');
    await this.readManifest(identity,db);
    const adopted=(await db.query('SELECT manifest_hash FROM research_authority WHERE config_hash=$1 FOR SHARE',[identity.configHash])).rows[0];
    researchAssert(adopted?.manifest_hash===identity.manifestHash&&(await db.query('SELECT bundle_latched FROM trading_configuration_rollout WHERE singleton')).rows[0]?.bundle_latched===true,'RESEARCH_AUTHORITY_MISMATCH');
    await db.query('LOCK TABLE research_observations IN SHARE MODE');
    await db.query('LOCK TABLE trading_configuration_observations IN SHARE MODE');
    const observations=(await db.query('SELECT * FROM research_observations WHERE observed_at<=clock_timestamp() AND expires_at>clock_timestamp()')).rows;
    const execution=observations.filter(r=>r.service==='execution-engine');
    researchAssert(execution.length===1&&observations.every(r=>r.config_hash===identity.configHash&&r.manifest_hash===identity.manifestHash)
      &&(!expectedProcess||execution[0].process_id===expectedProcess),'RESEARCH_RECOVERY_EXECUTION_AUTHORITY_INVALID');
    const configs=(await db.query('SELECT * FROM trading_configuration_observations WHERE observed_at<=clock_timestamp() AND expires_at>clock_timestamp()')).rows;
    researchAssert(configs.some(r=>r.service==='execution-engine')&&configs.every(r=>r.mode==='bundle'&&r.effective_hash===identity.configHash),'RESEARCH_RECOVERY_EXECUTION_AUTHORITY_INVALID');
    return String(execution[0].process_id);
  }
  private decodeRecovery(row:Record<string,unknown>):RecoveryChallenge {
    researchAssert(typeof row.canonical_json==='string','RESEARCH_RECOVERY_CHALLENGE_INVALID');
    const data=JSON.parse(row.canonical_json) as Omit<RecoveryChallenge,'challengeHash'>;
    researchAssert(researchHash(data)===row.challenge_hash&&data.id===row.id,'RESEARCH_RECOVERY_CHALLENGE_INVALID');
    return {...data,challengeHash:String(row.challenge_hash),state:row.state as RecoveryChallenge['state'],receiptId:row.receipt_id?String(row.receipt_id):null};
  }
  private async recoveryTransaction<T>(identity:RecoveryIdentity,run:(db:ResearchDb,scope:{ledger:string;endpoint:string|null},execution:string)=>Promise<T>,expectedProcess?:string,deadline=performance.now()+3000):Promise<T>{
    const discovery=await connectWshBounded(this.pool,undefined,deadline);let scope:{ledger:string;endpoint:string|null};
    try{scope=await this.recoveryScope(identity,discovery.db);}finally{discovery.destroy();}
    const work=async(db:ResearchDb)=>{
      await db.query('BEGIN');
      const execution=await this.assertRecoveryMaintenanceAuthority(identity,db,expectedProcess);
      await db.query('LOCK TABLE research_recovery_challenges IN ROW EXCLUSIVE MODE');
      if(scope.endpoint){await db.query('INSERT INTO research_wsh_endpoints(endpoint_id) VALUES($1) ON CONFLICT DO NOTHING',[scope.endpoint]);await db.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1 FOR UPDATE',[scope.endpoint]);}
      else await db.query('LOCK TABLE research_marketaux_attempts IN ROW EXCLUSIVE MODE');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[scope.endpoint?`research-wsh-issuer:${scope.ledger}`:`research-marketaux-issuer:${identity.accountId}:${scope.ledger}`]);
      const result=await run(db,scope,execution);
      await this.assertRecoveryMaintenanceAuthority(identity,db,execution);
      researchAssert(performance.now()<deadline,'RESEARCH_RECOVERY_TIMEOUT');await db.query('COMMIT');return result;
    };
    if(scope.endpoint){let result:T|undefined;
      const locked=await this.withWshEndpointLock(scope.endpoint,async lease=>{
        const bounded=this.wshBounds.get(lease)!;bounded.beginOperation(undefined,deadline);
        try{result=await work(this.wshLeases.get(lease)!);}catch(error){bounded.destroy();throw error;}
      });researchAssert(locked,'RESEARCH_WSH_ENDPOINT_BUSY');return result as T;
    }
    const bounded=await connectWshBounded(this.pool,undefined,deadline);
    try{return await work(bounded.db);}catch(error){bounded.destroy();throw error;}finally{bounded.destroy();}
  }
  private async recoveryPredecessors(identity:RecoveryIdentity,scope:{ledger:string;endpoint:string|null},db:ResearchDb):Promise<RecoveryPredecessor[]>{
    if(!scope.endpoint){
      const rows=(await db.query(`SELECT a.* FROM research_marketaux_attempts a WHERE account_id=$1 AND ledger_key=$2 AND state IN ('STARTED','FINALIZING','UNKNOWN')
       AND NOT EXISTS(SELECT 1 FROM research_marketaux_recoveries r WHERE r.attempt_id=a.id) ORDER BY id FOR UPDATE`,[identity.accountId,scope.ledger])).rows;
      const now=await this.now(db);researchAssert(rows.every(r=>researchTime(iso(r.deadline_at))<=now),'RESEARCH_RECOVERY_ATTEMPT_ACTIVE');return rows.map(r=>this.marketauxPredecessor(r));
    }
    const attempts=(await db.query(`SELECT a.*,c.ledger_key,c.config_hash,c.manifest_hash,c.instrument_id,c.source_id,c.account_id,ac.generation
      FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id LEFT JOIN research_wsh_acquisitions ac ON ac.id=a.acquisition_id
      WHERE (a.endpoint_id=$1 OR c.ledger_key=$2) AND (a.state='STARTED' OR a.cleanup_state='UNKNOWN')
      AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.attempt_id=a.id) ORDER BY a.id FOR UPDATE OF a`,[scope.endpoint,scope.ledger])).rows;
    const acquisitions=(await db.query(`SELECT a.* FROM research_wsh_acquisitions a WHERE (endpoint_id=$1 OR ledger_key=$2) AND state IN ('PENDING','UNKNOWN')
      AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.acquisition_id=a.id)
      AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts t WHERE t.acquisition_id=a.id) ORDER BY id FOR UPDATE`,[scope.endpoint,scope.ledger])).rows;
    const now=await this.now(db);researchAssert(attempts.every(r=>r.state!=='STARTED'||researchTime(iso(r.deadline_at))<=now),'RESEARCH_RECOVERY_ATTEMPT_ACTIVE');
    researchAssert([...attempts,...acquisitions].every(r=>r.endpoint_id===scope.endpoint),'RESEARCH_RECOVERY_OTHER_ENDPOINT_REQUIRED');
    const make=(r:Record<string,unknown>,kind:'WSH_ATTEMPT'|'WSH_ACQUISITION'):RecoveryPredecessor=>{
      const immutable={id:r.id,endpointId:r.endpoint_id,sessionId:r.session_id,ledgerKey:r.ledger_key,configHash:r.config_hash,manifestHash:r.manifest_hash,instrumentId:r.instrument_id,sourceId:r.source_id,startedAt:iso(r.started_at),generation:r.generation===null||r.generation===undefined?null:Number(r.generation)};
      return {kind,id:String(r.id),identityHash:researchHash(immutable),state:String(r.state),endpointId:String(r.endpoint_id),ledgerKey:String(r.ledger_key),sessionId:String(r.session_id),generation:immutable.generation};
    };
    return [...attempts.map(r=>make(r,'WSH_ATTEMPT')),...acquisitions.map(r=>make(r,'WSH_ACQUISITION'))].sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
  }
  private async insertRecoveryChallenge(identity:RecoveryIdentity,scope:{ledger:string;endpoint:string|null},execution:string,predecessors:RecoveryPredecessor[],db:ResearchDb,predecessorId?:string):Promise<RecoveryChallenge>{
    researchAssert(predecessors.length>0&&predecessors.length<=256,'RESEARCH_RECOVERY_NOT_REQUIRED');
    const now=await this.now(db),generation=scope.endpoint?Number((await db.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1',[scope.endpoint])).rows[0].generation):null;
    const data={...identity,id:randomUUID(),nonce:randomUUID(),executionProcessId:execution,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+900000).toISOString(),state:'PREPARED' as const,
      endpointId:scope.endpoint,endpointGeneration:generation,predecessors,predecessorHash:researchHash(predecessors),receiptId:null};
    const challenge={...data,challengeHash:researchHash(data)};
    await db.query(`INSERT INTO research_recovery_challenges(id,operation_id,kind,account_id,config_hash,manifest_hash,instrument_id,source_id,ledger_key,endpoint_id,endpoint_generation,pause_revision,execution_process_id,nonce,created_at,expires_at,predecessors,predecessor_hash,canonical_json,challenge_hash,predecessor_challenge_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,[data.id,identity.operationId,identity.kind,identity.accountId,identity.configHash,identity.manifestHash,identity.instrumentId,identity.sourceId,scope.ledger,scope.endpoint,generation,identity.pauseRevision,execution,data.nonce,data.createdAt,data.expiresAt,JSON.stringify(predecessors),data.predecessorHash,canonicalJson(data),challenge.challengeHash,predecessorId??null]);
    return challenge;
  }
  async prepareResearchRecovery(raw:RecoveryIdentity):Promise<RecoveryChallenge>{
    const identity=parseRecoveryIdentity(raw);
    return this.recoveryTransaction(identity,async(db,scope,execution)=>{
      const prior=(await db.query('SELECT * FROM research_recovery_challenges WHERE operation_id=$1',[identity.operationId])).rows[0];
      if(prior){const c=this.decodeRecovery(prior);researchAssert(Object.entries(identity).every(([k,v])=>(c as unknown as Record<string,unknown>)[k]===v),'RESEARCH_RECOVERY_OPERATION_REUSED');return c;}
      researchAssert(!(await db.query('SELECT research_recovery_held($1,$2,$3) AS held',[identity.accountId,scope.ledger,scope.endpoint])).rows[0]?.held,'RESEARCH_RECOVERY_MAINTENANCE_HOLD');
      const predecessors=await this.recoveryPredecessors(identity,scope,db),c=await this.insertRecoveryChallenge(identity,scope,execution,predecessors,db);
      await db.query("INSERT INTO research_recovery_audit(operation_id,challenge_id,action,actor,request_hash,result_json) VALUES($1,$2,'PREPARE',$3,$4,$5)",[identity.operationId,c.id,identity.actor,researchHash(identity),JSON.stringify(c)]);return c;
    });
  }
  private async recoveryChallengeById(id:string,deadline=performance.now()+3000):Promise<RecoveryChallenge|null>{
    researchAssert(isRecoveryUuid(id),'RESEARCH_RECOVERY_ID_INVALID');const bounded=await connectWshBounded(this.pool,undefined,deadline);
    try{const row=(await bounded.db.query('SELECT * FROM research_recovery_challenges WHERE id=$1',[id])).rows[0];return row?this.decodeRecovery(row):null;}finally{bounded.destroy();}
  }
  private recoveryIdentity(c:RecoveryChallenge):RecoveryIdentity{return {kind:c.kind,accountId:c.accountId,instrumentId:c.instrumentId,sourceId:c.sourceId,configHash:c.configHash,manifestHash:c.manifestHash,pauseRevision:c.pauseRevision,actor:c.actor,operationId:c.operationId};}
  async readResearchRecovery(id:string):Promise<RecoveryChallenge|null>{
    const deadline=performance.now()+3000,c=await this.recoveryChallengeById(id,deadline);if(!c)return null;
    return this.recoveryTransaction(this.recoveryIdentity(c),async db=>this.decodeRecovery((await db.query('SELECT * FROM research_recovery_challenges WHERE id=$1',[id])).rows[0]),c.executionProcessId,deadline);
  }
  async readResearchRecoveryReplacement(operationId:string,raw:RecoveryIdentity):Promise<RecoveryChallenge|null>{
    const identity=parseRecoveryIdentity(raw);researchAssert(isRecoveryUuid(operationId)&&operationId===identity.operationId,'RESEARCH_RECOVERY_OPERATION_REUSED');
    return this.recoveryTransaction(identity,async(db,scope)=>{const row=(await db.query('SELECT * FROM research_recovery_challenges WHERE operation_id=$1',[operationId])).rows[0];
      if(!row)return null;const c=this.decodeRecovery(row);researchAssert(c.accountId===identity.accountId&&c.kind===identity.kind&&row.ledger_key===scope.ledger&&c.endpointId===scope.endpoint,'RESEARCH_RECOVERY_SCOPE_INVALID');return c;});
  }
  async supersedeResearchRecovery(input:RecoverySupersede):Promise<RecoveryChallenge>{
    const identity=parseRecoveryIdentity(input.replacement),evidence=parseRecoveryEvidence(input.evidence,true);
    researchAssert(evidence.kind==='PRODUCER_QUIESCENCE'&&isRecoveryUuid(input.challengeId)&&isResearchHash(input.challengeHash),'RESEARCH_RECOVERY_EVIDENCE_INVALID');
    return this.recoveryTransaction(identity,async(db,scope,execution)=>{
      const audit=(await db.query('SELECT * FROM research_recovery_audit WHERE operation_id=$1',[identity.operationId])).rows[0];
      if(audit){researchAssert(audit.action==='SUPERSEDE'&&audit.request_hash===researchHash(input),'RESEARCH_RECOVERY_OPERATION_REUSED');return audit.result_json as RecoveryChallenge;}
      if(identity.kind==='WSH_ENDPOINT_RESET')researchAssert(!(await db.query('SELECT 1 FROM research_wsh_read_recovery_challenges WHERE challenge_id=$1',[input.challengeId])).rows.length,'RESEARCH_WSH_READ_CHALLENGE_SUPERSEDED');
      const row=(await db.query('SELECT * FROM research_recovery_challenges WHERE id=$1 FOR UPDATE',[input.challengeId])).rows[0];researchAssert(row,'RESEARCH_RECOVERY_CHALLENGE_MISSING');
      const old=this.decodeRecovery(row);
      researchAssert(old.state==='PREPARED'&&old.challengeHash===input.challengeHash&&evidence.challengeId===old.id&&evidence.challengeHash===old.challengeHash&&evidence.nonce===old.nonce
        &&old.accountId===identity.accountId&&old.kind===identity.kind&&row.ledger_key===scope.ledger&&old.endpointId===scope.endpoint,'RESEARCH_RECOVERY_REPLACEMENT_INVALID');
      const current=await this.recoveryPredecessors(identity,scope,db);
      researchAssert(old.predecessors.every(p=>current.some(n=>n.kind===p.kind&&n.id===p.id&&n.identityHash===p.identityHash)),'RESEARCH_RECOVERY_PREDECESSOR_CHANGED');
      const next=await this.insertRecoveryChallenge(identity,scope,execution,current,db,old.id);
      await db.query("UPDATE research_recovery_challenges SET state='CANCELLED',successor_challenge_id=$2 WHERE id=$1",[old.id,next.id]);
      await db.query("INSERT INTO research_recovery_audit(operation_id,challenge_id,action,actor,request_hash,evidence_json,evidence_hash,result_json) VALUES($1,$2,'SUPERSEDE',$3,$4,$5,$6,$7)",[identity.operationId,next.id,identity.actor,researchHash(input),canonicalJson(evidence),researchHash(evidence),JSON.stringify(next)]);return next;
    });
  }
  async commitResearchRecovery(input:RecoveryCommit):Promise<RecoveryReceipt>{
    researchAssert(isRecoveryUuid(input.challengeId)&&isRecoveryUuid(input.operationId)&&isResearchHash(input.challengeHash)&&typeof input.actor==='string'&&/^[A-Za-z0-9_.:-]{1,80}$/.test(input.actor)&&Number.isSafeInteger(input.pauseRevision),'RESEARCH_RECOVERY_EVIDENCE_INVALID');
    const deadline=performance.now()+3000,evidence=parseRecoveryEvidence(input.evidence),initial=await this.recoveryChallengeById(input.challengeId,deadline);researchAssert(initial,'RESEARCH_RECOVERY_CHALLENGE_MISSING');
    const identity=this.recoveryIdentity(initial);identity.pauseRevision=input.pauseRevision;
    return this.recoveryTransaction(identity,async(db,scope)=>{
      if(identity.kind==='WSH_ENDPOINT_RESET')researchAssert(!(await db.query('SELECT 1 FROM research_wsh_read_recovery_challenges WHERE challenge_id=$1',[input.challengeId])).rows.length,'RESEARCH_WSH_READ_CHALLENGE_SUPERSEDED');
      const row=(await db.query('SELECT * FROM research_recovery_challenges WHERE id=$1 FOR UPDATE',[input.challengeId])).rows[0],c=this.decodeRecovery(row);
      const prior=(await db.query('SELECT * FROM research_recovery_audit WHERE operation_id=$1',[input.operationId])).rows[0];
      if(prior){researchAssert(prior.action==='COMMIT'&&prior.request_hash===researchHash(input),'RESEARCH_RECOVERY_OPERATION_REUSED');return prior.result_json as RecoveryReceipt;}
      researchAssert(c.state==='PREPARED'&&c.challengeHash===input.challengeHash&&c.pauseRevision===input.pauseRevision&&evidence.challengeId===c.id&&evidence.challengeHash===c.challengeHash&&evidence.nonce===c.nonce&&evidence.kind===c.kind,'RESEARCH_RECOVERY_CHALLENGE_INVALID');
      researchAssert(await this.now(db)<researchTime(c.expiresAt),'RESEARCH_RECOVERY_CHALLENGE_EXPIRED');
      const predecessors=await this.recoveryPredecessors(identity,scope,db);researchAssert(researchHash(predecessors)===c.predecessorHash,'RESEARCH_RECOVERY_PREDECESSOR_CHANGED');
      if(evidence.kind==='WSH_ENDPOINT_RESET')researchAssert(evidence.endpointId===scope.endpoint&&evidence.reconnect.accountId===c.accountId&&Number((await db.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1',[scope.endpoint])).rows[0].generation)===c.endpointGeneration,'RESEARCH_RECOVERY_ENDPOINT_CHANGED');
      const receipt:RecoveryReceipt={id:randomUUID(),challengeId:c.id,kind:c.kind,recordedAt:new Date(await this.now(db)).toISOString(),evidenceHash:researchHash(evidence),predecessorHash:c.predecessorHash,nextCheckAt:null};
      await db.query("INSERT INTO research_recovery_audit(operation_id,challenge_id,action,actor,request_hash,evidence_json,evidence_hash,result_json) VALUES($1,$2,'COMMIT',$3,$4,$5,$6,$7)",[input.operationId,c.id,input.actor,researchHash(input),canonicalJson(evidence),receipt.evidenceHash,JSON.stringify(receipt)]);
      if(!scope.endpoint){
        for(const p of predecessors){const a=(await db.query('SELECT * FROM research_marketaux_attempts WHERE id=$1 FOR UPDATE',[p.id])).rows[0];await this.appendMarketauxRecovery(a,db,{id:randomUUID(),challengeId:c.id,evidenceHash:receipt.evidenceHash});}
      }else{
        researchAssert(evidence.kind==='WSH_ENDPOINT_RESET','RESEARCH_RECOVERY_EVIDENCE_INVALID');
        await db.query(`INSERT INTO research_wsh_recovery_receipts(id,challenge_id,endpoint_id,prior_generation,resulting_generation,method,evidence_hash,reconnect_session_id,cleanup)
          VALUES($1,$2,$3,$4,$5,'OPERATOR_OBSERVED_LOCAL_GATEWAY_RESTART',$6,$7,$8)`,[receipt.id,c.id,scope.endpoint,c.endpointGeneration,Number(c.endpointGeneration)+1,receipt.evidenceHash,evidence.reconnect.sessionId,JSON.stringify(evidence.reconnect.cleanup)]);
        for(const p of predecessors){
          let acquisitionId:string|null=p.kind==='WSH_ACQUISITION'?p.id:null;
          if(p.kind==='WSH_ATTEMPT'){
            const a=(await db.query('SELECT * FROM research_wsh_refresh_attempts WHERE id=$1 FOR UPDATE',[p.id])).rows[0];acquisitionId=a.acquisition_id?String(a.acquisition_id):null;
            if(a.state==='STARTED')await db.query("UPDATE research_wsh_refresh_attempts SET state='UNKNOWN',finished_at=clock_timestamp(),failure_class='UNCERTAIN',failure_reason='RESEARCH_WSH_ABANDONED_ATTEMPT',failure_stage='cleanup',cleanup_state='UNKNOWN' WHERE id=$1",[p.id]);
          }
          if(acquisitionId){
            const a=(await db.query('SELECT * FROM research_wsh_acquisitions WHERE id=$1 FOR UPDATE',[acquisitionId])).rows[0];
            if(a?.state==='PENDING'){
              researchAssert(a.endpoint_id===scope.endpoint&&Number(a.generation)===c.endpointGeneration,'RESEARCH_WSH_GENERATION_RETIRED');
              await db.query(`INSERT INTO research_call_outcomes(call_key,outcome) SELECT call_key,'UNKNOWN' FROM research_wsh_acquisition_calls c WHERE acquisition_id=$1
                AND NOT EXISTS(SELECT 1 FROM research_call_outcomes o WHERE o.call_key=c.call_key)`,[acquisitionId]);
              await db.query("UPDATE research_wsh_acquisitions SET state='UNKNOWN',retired_at=clock_timestamp() WHERE id=$1",[acquisitionId]);
            }
          }
          await db.query('INSERT INTO research_wsh_recovery_predecessors(receipt_id,attempt_id,acquisition_id,identity_hash) VALUES($1,$2,$3,$4)',[receipt.id,p.kind==='WSH_ATTEMPT'?p.id:null,p.kind==='WSH_ACQUISITION'?p.id:null,p.identityHash]);
        }
        await db.query('UPDATE research_wsh_endpoints SET generation=generation+1 WHERE endpoint_id=$1',[scope.endpoint]);
      }
      await db.query("UPDATE research_recovery_challenges SET state='COMMITTED',receipt_id=$2 WHERE id=$1",[c.id,receipt.id]);return receipt;
    },initial.executionProcessId,deadline);
  }
  private wshDueCursor = 0;
  private readonly wshTicketDeadlines=new WeakMap<WshAttemptTicket,number>();
  private budgetDiscovery: { identity: string; nextScanAt: number; cursor: string } | undefined;
  private readonly wshBounds = new WeakMap<WshEndpointLease,WshBoundedConnection>();
  private readonly wshLeases = new WeakMap<WshEndpointLease, ResearchConnection>();
  constructor(private readonly pool: ResearchPool, private readonly recoveryClock:ResearchRecoveryClock=systemResearchRecoveryClock) {}
  async withRefreshLock(identity: ResearchIdentity & { instrumentId: string }, run: () => Promise<void>): Promise<boolean> {
    const db = await this.pool.connect();
    const key = `research-refresh:${identity.configHash}:${identity.manifestHash}:${identity.instrumentId}`;
    let locked = false;
    try {
      locked = (await db.query("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked", [key])).rows[0].locked === true;
      if (!locked) return false;
      await run(); return true;
    } finally {
      try { if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]); }
      finally { db.release(); }
    }
  }
  async hasRefreshSlot(slotKey: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM research_refresh_slots WHERE slot_key=$1", [slotKey])).rows.length > 0;
  }
  async prepareRepair(identity: ResearchRepairIdentity, existing?: ResearchDb): Promise<ResearchPreparation> {
    return this.transaction(async db => {
      researchAssert(/^[A-Za-z0-9_-]{1,80}$/.test(identity.accountId), "RESEARCH_ACCOUNT_INVALID");
      await this.assertAuthority(identity, db);
      await db.query('LOCK TABLE research_recovery_challenges IN SHARE MODE');
      const manifest = await this.readManifest(identity, db), now = await this.now(db);
      if (isTwoSourceResearch(manifest)) await db.query("LOCK TABLE research_marketaux_attempts IN SHARE MODE");
      const stored = await this.latestSnapshot(identity, db, true);
      const legacy = await this.legacyMarketauxRecoveries(identity, manifest, stored, now, db);
      const budget = await this.marketauxBudgetRecoveries(identity, manifest, stored, now, db);
      const wshStates:WshRefreshState[]=[];
      for(const source of manifest.instruments.find(p=>p.instrumentId===identity.instrumentId)?.sources??[])
        if(source.adapter==='ibkr-wsh')wshStates.push(await this.readWshRefreshState({...identity,sourceId:source.id},db));
      const marketauxStates: MarketauxRefreshState[] = [];
      if (isTwoSourceResearch(manifest)) for (const source of manifest.instruments.find(p=>p.instrumentId===identity.instrumentId)?.sources ?? [])
        if (source.adapter === 'marketaux-news') marketauxStates.push(await this.readMarketauxRefreshState({...identity,sourceId:source.id},db));
      const result = inspectResearch(manifest, identity.instrumentId, stored, now, legacy, budget.assessments,wshStates,marketauxStates);
      for (const row of result.sources) {
        const diagnostic = budget.diagnostics.get(row.sourceId);
        if (row.role === "news" && diagnostic) row.localBudget = diagnostic;
      }
      const policy = manifest.instruments.find(p => p.instrumentId === identity.instrumentId);
      for (const row of result.sources) {
        if (row.state !== "WAITING" || result.state === "HOLD") continue;
        const source = policy!.sources.find(s => s.id === row.sourceId)!;
        const providers = manifest.instruments.flatMap(p => p.sources).filter(s => s.provider === source.provider);
        const usage = (await db.query(`SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost
          FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3`, [identity.accountId, source.provider, new Date(now).toISOString().slice(0, 10)])).rows[0];
        if (Number(usage.requests) >= Math.min(...providers.map(s => s.maxRequestsPerDay)) || Number(usage.cost) + Math.max(...providers.map(s => s.costMicrosPerCall)) > Math.min(...providers.map(s => s.maxCostMicrosPerDay))) {
          row.state = isTwoSourceResearch(manifest) ? "WAITING" : "HOLD"; row.reasons = ["RESEARCH_BUDGET_EXHAUSTED"]; row.nextCheckAt = isTwoSourceResearch(manifest) ? new Date(Date.parse(new Date(now).toISOString().slice(0,10))+86400000).toISOString() : null; continue;
        }
        if (!isTwoSourceResearch(manifest) && source.adapter === "marketaux-news" && await this.hasUnresolvedMarketauxFailure(identity,manifest,source.id,now,db)) {
          row.state="HOLD";row.reasons=["RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE"];row.nextCheckAt=null;continue;
        }
        if (source.parserConfig.kind === 'marketaux-news-v2') {
          row.nextCheckAt = new Date(Math.max(now, row.marketauxRefresh?.nextRegularAt ? researchTime(row.marketauxRefresh.nextRegularAt) : now)).toISOString();
          continue;
        }
        if (Date.parse(row.nextCheckAt!) > now) continue;
        if(source.adapter==='ibkr-wsh' && row.wshRefresh){
          const state=row.wshRefresh;
          row.nextCheckAt=state.nextRetryAt??state.nextRegularAt??new Date(now).toISOString();
          if(Date.parse(row.nextCheckAt)<now)row.nextCheckAt=new Date(now).toISOString();
          continue;
        }
        const slot = researchRefreshSlot(source, row.role, now);
        if (source.adapter === "marketaux-news") {
          const config=parseMarketauxNewsConfig(source,policy!), previousWindow=marketauxWindow(slot-1), previousKeys:string[]=[];
          for (const pass of [1,2] as const) for (let page=1;page<=config.maxPagesPerPass;page++) previousKeys.push(marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...previousWindow,pass,page}).callKey);
          const pending=(await db.query(`SELECT r.deadline_at FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key)
            WHERE r.call_key=ANY($1::text[]) AND r.deadline_at>$2 AND (o.outcome IS NULL OR o.outcome='UNKNOWN')`,[previousKeys,new Date(now)])).rows;
          if (pending.length) {row.reasons=["RESEARCH_WAITING_EXISTING_ACQUISITION"];row.nextCheckAt=new Date(Math.max(...pending.map(call=>researchTime(iso(call.deadline_at))))).toISOString();continue;}
        }
        const slotKey = researchRefreshSlotKey(identity.manifestHash, identity.instrumentId, source.id, row.role, slot);
        if ((await db.query("SELECT 1 FROM research_refresh_slots WHERE slot_key=$1", [slotKey])).rows.length) {
          row.reasons = ["RESEARCH_WAITING_NEXT_SLOT"];
          row.nextCheckAt = new Date((slot + 1) * researchRefreshInterval(source, row.role)).toISOString(); continue;
        }
        const keys: string[] = [];
        if (source.adapter === "marketaux-news") {
          const config = parseMarketauxNewsConfig(source, policy!), window = marketauxWindow(slot);
          for (const pass of [1, 2] as const) for (let page = 1; page <= config.maxPagesPerPass; page++)
            keys.push(marketauxCallIdentity(identity.manifestHash, identity.instrumentId, source, { sourceUrl: source.urls[0], ...window, pass, page }).callKey);
        } else if (source.adapter !== "ibkr-wsh") {
          for (const url of source.urls) for (const attempt of [1, 2]) keys.push("research_source_" + researchHash({ manifestHash: identity.manifestHash, instrumentId: identity.instrumentId, sourceId: source.id, role: row.role, slot, url, attempt }));
        } else {
          const config=parseWshConfig(source,policy!);
          const baseline=await this.wshRegularNotBefore(wshLedgerKey(config.isin),config.refreshIntervalMs,db);
          if(baseline!==null && baseline>now){row.reasons=["RESEARCH_WAITING_ACQUISITION_OR_PACING"];row.nextCheckAt=new Date(baseline).toISOString();}
        }
        if (keys.length) {
          const calls = (await db.query(`SELECT r.deadline_at,o.outcome FROM research_call_reservations r
            LEFT JOIN research_call_outcomes o USING(call_key) WHERE r.call_key=ANY($1::text[])`, [keys])).rows;
          if (calls.length) {
            const unknown = calls.some(c => c.outcome === "UNKNOWN" || c.outcome == null && researchTime(iso(c.deadline_at)) <= now) || calls.every(c => researchTime(iso(c.deadline_at)) <= now);
            if (source.adapter === "marketaux-news" && calls.some(c=>c.outcome === "FAILED")) {
              row.state = "HOLD"; row.reasons = ["RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE"]; row.nextCheckAt = null;
            }
            else if (source.adapter === "marketaux-news" && unknown) {
              row.reasons = ["RESEARCH_WAITING_NEXT_SLOT"];
              row.nextCheckAt = new Date(Math.max((slot+1)*researchRefreshInterval(source,row.role), ...calls.map(c=>researchTime(iso(c.deadline_at))))).toISOString();
            }
            else if (unknown) { row.state = "HOLD"; row.reasons = ["RESEARCH_PROVIDER_OUTCOME_UNKNOWN"]; row.nextCheckAt = null; }
            else if (calls.some(c => c.outcome === "FAILED")) { row.state = "HOLD"; row.reasons = ["RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE"]; row.nextCheckAt = null; }
            else { row.reasons = ["RESEARCH_WAITING_EXISTING_ACQUISITION"]; row.nextCheckAt = new Date(now + 5_000).toISOString(); }
          }
        }
      }
      if (result.sources.some(row => row.state === "HOLD")) {
        result.state = "HOLD"; result.reasons = [...new Set([...result.reasons, ...result.sources.filter(s => s.state === "HOLD").flatMap(s => s.reasons)])].sort();
      }
      if (result.state === "WAITING") result.reasons = [...new Set(result.sources.filter(s => s.state === "WAITING").flatMap(s => s.reasons))].sort();
      result.nextCheckAt = result.state === "WAITING" ? new Date(Math.min(...result.sources.filter(s => s.state === "WAITING").map(s => Date.parse(s.nextCheckAt!)))).toISOString() : null;
      for (const row of result.sources) {
        const state = result.state === "HOLD" ? "HOLD" : row.state;
        const reasons = state === "HOLD" ? result.reasons : row.reasons;
        const next = state === "WAITING" ? row.nextCheckAt : null;
        const changed = await db.query(`INSERT INTO research_repair_requests(account_id,config_hash,manifest_hash,instrument_id,source_id,role,state,reasons,snapshot_id,next_check_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
          ON CONFLICT(account_id,config_hash,manifest_hash,instrument_id,source_id,role) DO UPDATE SET
            state=EXCLUDED.state,reasons=EXCLUDED.reasons,snapshot_id=EXCLUDED.snapshot_id,next_check_at=EXCLUDED.next_check_at,updated_at=clock_timestamp()
          WHERE ROW(research_repair_requests.state,research_repair_requests.reasons,research_repair_requests.snapshot_id,research_repair_requests.next_check_at)
            IS DISTINCT FROM ROW(EXCLUDED.state,EXCLUDED.reasons,EXCLUDED.snapshot_id,EXCLUDED.next_check_at) RETURNING id`,
        [identity.accountId, identity.configHash, identity.manifestHash, identity.instrumentId, row.sourceId, row.role, state, JSON.stringify(reasons), result.snapshotId, next]);
        if (changed.rows[0]) await db.query(`INSERT INTO research_repair_events(request_id,state,reasons,snapshot_id,next_check_at) VALUES($1,$2,$3::jsonb,$4,$5)`, [changed.rows[0].id, state, JSON.stringify(reasons), result.snapshotId, next]);
      }
      return result;
    }, existing);
  }
  async dueRepairs(identity: ResearchIdentity & { accountId: string }): Promise<(ResearchRepairIdentity & { sourceId: string; role: ResearchRole })[]> {
    await this.assertAuthority(identity);
    const rows = (await this.pool.query(`SELECT instrument_id,source_id,role,state,FALSE AS budget_candidate FROM research_repair_requests
      WHERE account_id=$1 AND config_hash=$2 AND manifest_hash=$3 AND
        ((state='WAITING' AND next_check_at<=clock_timestamp()) OR (state='HOLD' AND role='news' AND
          reasons ?| ARRAY['RESEARCH_MARKETAUX_ACQUISITION_FAILED','RESEARCH_SOURCE_TIMEOUT','RESEARCH_SOURCE_TRANSPORT_TRANSIENT',
          'RESEARCH_SOURCE_HTTP_429','RESEARCH_SOURCE_HTTP_500','RESEARCH_SOURCE_HTTP_502','RESEARCH_SOURCE_HTTP_503','RESEARCH_SOURCE_HTTP_504']))
      ORDER BY next_check_at NULLS LAST,id LIMIT 100`, [identity.accountId, identity.configHash, identity.manifestHash])).rows;
    const now = await this.now(this.pool), discoveryKey = researchHash(identity);
    const previous = this.budgetDiscovery?.identity === discoveryKey ? this.budgetDiscovery : undefined;
    const scanBudget = !previous || now >= previous.nextScanAt;
    let cursor = previous?.cursor ?? "0";
    if (scanBudget) {
      const query = `SELECT id,instrument_id,source_id,role,state,TRUE AS budget_candidate FROM research_repair_requests
        WHERE account_id=$1 AND config_hash=$2 AND manifest_hash=$3 AND state='HOLD' AND role='news'
          AND reasons ? 'RESEARCH_BUDGET_EXHAUSTED' AND id>$4::bigint ORDER BY id LIMIT 100`;
      let candidates = (await this.pool.query(query, [identity.accountId, identity.configHash, identity.manifestHash, cursor])).rows;
      if (!candidates.length && cursor !== "0") candidates = (await this.pool.query(query, [identity.accountId, identity.configHash, identity.manifestHash, "0"])).rows;
      cursor = candidates.length ? String(candidates[candidates.length - 1].id) : "0";
      rows.push(...candidates);
    }
    const manifest = rows.some(row=>row.state==='HOLD') ? await this.readManifest(identity,this.pool) : null;
    const result: (ResearchRepairIdentity & {sourceId:string;role:ResearchRole})[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const candidate = {...identity,instrumentId:String(row.instrument_id),sourceId:String(row.source_id),role:row.role as ResearchRole};
      if (row.state==='HOLD') {
        const source=manifest!.instruments.find(p=>p.instrumentId===candidate.instrumentId)?.sources.find(s=>s.id===candidate.sourceId);
        if (source?.adapter!=='marketaux-news') continue;
        const stored=await this.latestSnapshot(candidate);
        const coverage=stored?.snapshot.coverage.find(c=>c.sourceId===candidate.sourceId&&c.role==='news');
        if (coverage && marketauxLocalBudgetFailure(coverage) !== (row.budget_candidate === true)) continue;
        if (!coverage || !(marketauxTransientFailure(coverage) || marketauxLocalBudgetFailure(coverage) || coverage.status==='ERROR'&&!coverage.complete&&coverage.reason==='RESEARCH_MARKETAUX_ACQUISITION_FAILED'&&!Object.hasOwn(coverage,'sourceError'))) continue;
      }
      const key = JSON.stringify([candidate.instrumentId, candidate.sourceId, candidate.role]);
      if (!seen.has(key)) { result.push(candidate); seen.add(key); }
    }
    if (scanBudget) this.budgetDiscovery = { identity: discoveryKey, cursor, nextScanAt: Math.min(now + 60_000, Date.parse(new Date(now).toISOString().slice(0, 10)) + 86_400_000) };
    return result;
  }
  private async hasUnresolvedMarketauxFailure(identity: ResearchRepairIdentity, manifest: ResearchManifest, sourceId: string, now: number, db: ResearchDb): Promise<boolean> {
    if (isTwoSourceResearch(manifest)) return false;
    const policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId)!,source=policy.sources.find(s=>s.id===sourceId)!,config=parseMarketauxNewsConfig(source,policy);
    const calls=(await db.query(`SELECT r.*,o.recorded_at FROM research_call_reservations r JOIN research_call_outcomes o USING(call_key)
      WHERE r.account_id=$1 AND r.provider=$2 AND r.kind='source' AND r.config_hash=$3 AND r.manifest_hash=$4 AND o.outcome='FAILED'`,[identity.accountId,source.provider,identity.configHash,identity.manifestHash])).rows;
    let latestSuccessfulStart:number|undefined;
    for (const call of calls) {
      const reserved=researchTime(iso(call.reserved_at)), actualSlot=researchRefreshSlot(source,'news',reserved);
      let matchedSlot:number|undefined;
      for (const slot of [actualSlot,actualSlot-1]) {
        const window=marketauxWindow(slot);
        for (const pass of [1,2] as const) for (let page=1;page<=config.maxPagesPerPass;page++) {
          const expected=marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...window,pass,page});
          if (expected.callKey===call.call_key) {if(expected.requestHash!==call.request_hash)return true;matchedSlot=slot;}
        }
      }
      if (matchedSlot===undefined) continue;
      if (latestSuccessfulStart===undefined) {
        latestSuccessfulStart=-Infinity;
        const success=(await db.query(`SELECT s.* FROM research_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.canonical_json::jsonb->'coverage') c
          WHERE s.config_hash=$1 AND s.manifest_hash=$2 AND s.instrument_id=$3 AND c->>'sourceId'=$4 AND c->>'role'='news' AND c->>'complete'='true'
          ORDER BY c->>'checkedAt' DESC,s.sequence DESC LIMIT 1`,[identity.configHash,identity.manifestHash,identity.instrumentId,sourceId])).rows[0];
        if (success) {
          const snapshot=this.decode(success,manifest).snapshot,coverage=snapshot.coverage.find(c=>c.sourceId===sourceId&&c.role==='news');
          if (coverage?.complete && ['AVAILABLE','EMPTY'].includes(coverage.status) && 'acquisition' in coverage && coverage.acquisition?.pages.length) {
            const times=coverage.acquisition.pages.map(page=>researchTime(page.fetchedAt));
            if (Math.max(...times)<=now) latestSuccessfulStart=Math.min(researchTime(coverage.acquisition.asOf),...times);
          }
        }
      }
      if (latestSuccessfulStart>researchTime(iso(call.recorded_at))) continue;
      const slotKey=researchRefreshSlotKey(identity.manifestHash,identity.instrumentId,sourceId,'news',matchedSlot);
      const published=(await db.query(`SELECT s.* FROM research_refresh_slots r JOIN research_snapshots s ON s.id=r.snapshot_id WHERE r.slot_key=$1`,[slotKey])).rows[0];
      if (!published) return true;
      const snapshot=this.decode(published,manifest).snapshot,coverage=snapshot.coverage.find(c=>c.sourceId===sourceId&&c.role==='news');
      if (snapshot.configHash!==identity.configHash || snapshot.manifestHash!==identity.manifestHash || snapshot.instrumentId!==identity.instrumentId || !coverage || !marketauxTransientFailure(coverage)
        || coverage.checkedAt!==marketauxWindow(matchedSlot).asOf || researchTime(snapshot.createdAt)<researchTime(iso(call.recorded_at))) return true;
    }
    return false;
  }
  private async marketauxBudgetRecoveries(identity: ResearchRepairIdentity, manifest: ResearchManifest, stored: StoredResearchSnapshot | null, now: number, db: ResearchDb): Promise<{ assessments: MarketauxBudgetRecoveryAssessment[]; diagnostics: Map<string, ResearchLocalBudgetDiagnostic> }> {
    if (isTwoSourceResearch(manifest)) return { assessments: [], diagnostics: new Map() };
    const assessments: MarketauxBudgetRecoveryAssessment[] = [], diagnostics = new Map<string, ResearchLocalBudgetDiagnostic>();
    const policy = manifest.instruments.find(p => p.instrumentId === identity.instrumentId);
    if (!stored || !policy) return { assessments, diagnostics };
    const day = new Date(now).toISOString().slice(0, 10);
    for (const source of policy.sources.filter(s => s.adapter === "marketaux-news")) {
      const coverage = stored.snapshot.coverage.find(c => c.sourceId === source.id && c.role === "news");
      if (!coverage || !marketauxLocalBudgetFailure(coverage)) continue;
      const providers = manifest.instruments.flatMap(p => p.sources).filter(s => s.provider === source.provider);
      const maxRequestsPerDay = Math.min(...providers.map(s => s.maxRequestsPerDay)), maxCostMicrosPerDay = Math.min(...providers.map(s => s.maxCostMicrosPerDay));
      const nextCallCostMicros = Math.max(...providers.map(s => s.costMicrosPerCall));
      const usage = (await db.query(`SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost
        FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3`, [identity.accountId, source.provider, day])).rows[0];
      const requestsUsed = Number(usage.requests), costUsedMicros = Number(usage.cost);
      researchAssert([maxRequestsPerDay,maxCostMicrosPerDay,nextCallCostMicros,requestsUsed,costUsedMicros].every(n => Number.isSafeInteger(n) && n >= 0), "RESEARCH_BUDGET_INVALID");
      const diagnostic: ResearchLocalBudgetDiagnostic = { kind: "LOCAL_RESEARCH_BUDGET", failedBudgetDay: null, failureRecordedAt: null,
        currentBudgetDay: day, requestsUsed, maxRequestsPerDay, costUsedMicros, maxCostMicrosPerDay, nextCallCostMicros,
        nextBudgetResetAt: new Date(Date.parse(day) + 86_400_000).toISOString(), recoveryProof: "UNAVAILABLE" };
      diagnostics.set(source.id, diagnostic);
      if (maxRequestsPerDay === 0 || nextCallCostMicros > maxCostMicrosPerDay) continue;
      const interval = researchRefreshInterval(source, "news"), slot = researchRefreshSlot(source, "news", researchTime(coverage.checkedAt) + 1000), window = marketauxWindow(slot);
      if (window.asOf !== coverage.checkedAt || window.windowStart !== coverage.windowStart || window.asOf !== coverage.windowEnd) continue;
      const slotKey = researchRefreshSlotKey(identity.manifestHash, identity.instrumentId, source.id, "news", slot);
      const originalRow = (await db.query(`SELECT s.*,r.published_at AS slot_published_at FROM research_refresh_slots r
        JOIN research_snapshots s ON s.id=r.snapshot_id WHERE r.slot_key=$1`, [slotKey])).rows[0];
      if (!originalRow) continue;
      const original = this.decode(originalRow, manifest).snapshot;
      const originalCoverage = original.coverage.find(c => c.sourceId === source.id && c.role === "news");
      if (original.configHash !== identity.configHash || original.manifestHash !== identity.manifestHash || original.instrumentId !== identity.instrumentId
        || original.mappingHash !== stored.snapshot.mappingHash || !originalCoverage || canonicalJson(originalCoverage) !== canonicalJson(coverage)) continue;
      const recordedAt = researchTime(original.createdAt), publishedAt = researchTime(iso(originalRow.slot_published_at));
      if (recordedAt < slot * interval || publishedAt < recordedAt || publishedAt >= (slot + 1) * interval || publishedAt > now) continue;
      const failedDay = new Date(slot * interval).toISOString().slice(0, 10);
      if (new Date(recordedAt).toISOString().slice(0, 10) !== failedDay || new Date(publishedAt).toISOString().slice(0, 10) !== failedDay) continue;
      const config = parseMarketauxNewsConfig(source, policy), expected = new Map<string, { requestHash: string; pass: number; page: number }>();
      for (const pass of [1, 2] as const) for (let page = 1; page <= config.maxPagesPerPass; page++) {
        const call = marketauxCallIdentity(identity.manifestHash, identity.instrumentId, source, { sourceUrl: source.urls[0], ...window, pass, page });
        expected.set(call.callKey, { requestHash: call.requestHash, pass, page });
      }
      const calls = (await db.query(`SELECT r.*,r.budget_day::text AS budget_day,o.outcome,o.recorded_at FROM research_call_reservations r
        LEFT JOIN research_call_outcomes o USING(call_key) WHERE r.call_key=ANY($1::text[]) ORDER BY r.reserved_at,r.call_key`, [[...expected.keys()]])).rows;
      const firstKey = marketauxCallIdentity(identity.manifestHash, identity.instrumentId, source, { sourceUrl: source.urls[0], ...window, pass: 1, page: 1 }).callKey;
      if (calls.length && calls[0].call_key !== firstKey) continue;
      const acquisitionStart = calls.length ? researchTime(iso(calls[0].reserved_at)) : recordedAt;
      if (acquisitionStart < slot * interval || recordedAt - acquisitionStart > 120_000) continue;
      let invalid = false, previousPass = 1, previousPage = 0, previousOutcome = acquisitionStart;
      for (const call of calls) {
        const descriptor = expected.get(String(call.call_key))!;
        const reservedAt = researchTime(iso(call.reserved_at)), deadlineAt = researchTime(iso(call.deadline_at));
        const outcomeAt = call.recorded_at ? researchTime(iso(call.recorded_at)) : NaN;
        const callDay = String(call.budget_day);
        if (call.account_id !== identity.accountId || call.provider !== source.provider || call.kind !== "source" || call.config_hash !== identity.configHash || call.manifest_hash !== identity.manifestHash
          || call.request_hash !== descriptor.requestHash || callDay !== failedDay || new Date(reservedAt).toISOString().slice(0, 10) !== failedDay
          || Number(call.reserved_cost_micros) < nextCallCostMicros || reservedAt < previousOutcome || reservedAt >= deadlineAt || deadlineAt > reservedAt + 10_000 || deadlineAt > acquisitionStart + 120_000
          || call.outcome !== "SUCCEEDED" || !Number.isFinite(outcomeAt) || outcomeAt < reservedAt || outcomeAt >= deadlineAt || outcomeAt > recordedAt
          || descriptor.pass < previousPass || descriptor.page !== (descriptor.pass === previousPass ? previousPage + 1 : 1)) { invalid = true; break; }
        previousPass = descriptor.pass; previousPage = descriptor.page; previousOutcome = outcomeAt;
      }
      if (invalid) continue;
      const historical = (await db.query(`SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost
        FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3 AND reserved_at<=$4`, [identity.accountId, source.provider, failedDay, new Date(recordedAt)])).rows[0];
      if (Number(historical.requests) < maxRequestsPerDay && Number(historical.cost) + nextCallCostMicros <= maxCostMicrosPerDay) continue;
      diagnostic.failedBudgetDay = failedDay; diagnostic.failureRecordedAt = original.createdAt; diagnostic.recoveryProof = "VERIFIED";
      if (failedDay >= day || requestsUsed >= maxRequestsPerDay || costUsedMicros + nextCallCostMicros > maxCostMicrosPerDay) continue;
      assessments.push({ snapshotId: stored.id, sourceId: source.id, coverageHash: researchHash(coverage), slot, failedBudgetDay: failedDay,
        failureRecordedAt: original.createdAt, nextCheckAt: new Date(Math.max(now, (slot + 1) * interval)).toISOString() });
    }
    return { assessments, diagnostics };
  }
  private async legacyMarketauxRecoveries(identity: ResearchRepairIdentity, manifest: ResearchManifest, stored: StoredResearchSnapshot | null, now: number, db: ResearchDb): Promise<MarketauxLegacyRecoveryAssessment[]> {
    if (isTwoSourceResearch(manifest)) return [];
    const policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId), result:MarketauxLegacyRecoveryAssessment[]=[];
    if (!stored || !policy) return result;
    for (const source of policy.sources.filter(s=>s.adapter==='marketaux-news')) {
      const coverage=stored.snapshot.coverage.find(c=>c.sourceId===source.id&&c.role==='news');
      if (!coverage || coverage.status!=='ERROR' || coverage.complete || coverage.evidenceRefs.length || coverage.reason!=='RESEARCH_MARKETAUX_ACQUISITION_FAILED' || Object.hasOwn(coverage,'sourceError')) continue;
      const slot=researchRefreshSlot(source,'news',researchTime(coverage.checkedAt)+1000), window=marketauxWindow(slot);
      if (window.asOf!==coverage.checkedAt) continue;
      const slotKey=researchRefreshSlotKey(identity.manifestHash,identity.instrumentId,source.id,'news',slot);
      const originalRow=(await db.query(`SELECT s.*,r.published_at AS slot_published_at FROM research_refresh_slots r
        JOIN research_snapshots s ON s.id=r.snapshot_id WHERE r.slot_key=$1`,[slotKey])).rows[0];
      if (!originalRow) continue;
      const original=this.decode(originalRow,manifest);
      if (original.snapshot.configHash!==identity.configHash || original.snapshot.manifestHash!==identity.manifestHash || original.snapshot.instrumentId!==identity.instrumentId || original.snapshot.mappingHash!==stored.snapshot.mappingHash) continue;
      const originalCoverage=original.snapshot.coverage.find(c=>c.sourceId===source.id&&c.role==='news');
      if (!originalCoverage || canonicalJson(originalCoverage)!==canonicalJson(coverage)) continue;
      const config=parseMarketauxNewsConfig(source,policy), expected=new Map<string,string>();
      for (const pass of [1,2] as const) for (let page=1;page<=config.maxPagesPerPass;page++) {
        const call=marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...window,pass,page});expected.set(call.callKey,call.requestHash);
      }
      const calls=(await db.query(`SELECT r.*,o.outcome,o.recorded_at FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key) WHERE r.call_key=ANY($1::text[])`,[[...expected.keys()]])).rows;
      const firstKey=marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...window,pass:1,page:1}).callKey;
      const first=calls.find(call=>call.call_key===firstKey);
      if (!first) continue;
      const acquisitionStart=researchTime(iso(first.reserved_at));
      if (acquisitionStart<slot*researchRefreshInterval(source,'news') || acquisitionStart>=(slot+1)*researchRefreshInterval(source,'news')) continue;
      const publication=Math.min(researchTime(original.snapshot.createdAt),researchTime(iso(originalRow.slot_published_at)));
      if (!calls.length || publication>now || calls.some(call=>call.account_id!==identity.accountId || call.provider!==source.provider || call.kind!=='source' || call.config_hash!==identity.configHash || call.manifest_hash!==identity.manifestHash || call.request_hash!==expected.get(String(call.call_key))
        || researchTime(iso(call.reserved_at))<acquisitionStart || researchTime(iso(call.deadline_at))>acquisitionStart+120000 || researchTime(iso(call.reserved_at))>=researchTime(iso(call.deadline_at))
        || !['SUCCEEDED','UNKNOWN'].includes(String(call.outcome)) || !call.recorded_at || researchTime(iso(call.recorded_at))>publication || researchTime(iso(call.deadline_at))>now
        || call.outcome==='UNKNOWN'&&researchTime(iso(call.recorded_at))<researchTime(iso(call.deadline_at)))) continue;
      if (!calls.some(call=>call.outcome==='UNKNOWN')) continue;
      result.push({snapshotId:stored.id,sourceId:source.id,coverageHash:researchHash(coverage),slot,nextCheckAt:new Date(Math.max((slot+1)*researchRefreshInterval(source,'news'),...calls.map(call=>researchTime(iso(call.deadline_at))))).toISOString()});
    }
    return result;
  }
  private async transaction<T>(fn: (db: ResearchDb) => Promise<T>, existing?: ResearchDb): Promise<T> {
    if (existing) return fn(existing);
    const db = await this.pool.connect();
    try { await db.query("BEGIN"); const result = await fn(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  private async now(db: ResearchDb): Promise<number> { return researchTime(iso((await db.query("SELECT clock_timestamp() AS now")).rows[0].now)); }
  async registerManifest(input: { manifest: ResearchManifest; configuration: TradingConfigurationV1; tradingEnabled: boolean; adopt: boolean }): Promise<{ hash: string }> {
    const manifest = parseResearchManifest(input.manifest, input.configuration, input.manifest.configHash), hash = researchHash(manifest);
    return this.transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`research-authority:${manifest.configHash}`]);
      const config = (await db.query("SELECT canonical_json FROM trading_configuration_snapshots WHERE effective_hash=$1", [manifest.configHash])).rows[0];
      researchAssert(config && typeof config.canonical_json === "string", "RESEARCH_CONFIG_NOT_REGISTERED");
      parseResearchManifest(manifest, decodeTradingConfigurationSnapshot(config.canonical_json, manifest.configHash), manifest.configHash);
      const canonical = canonicalJson(manifest);
      await db.query("INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [hash, manifest.configHash, canonical]);
      researchAssert((await db.query("SELECT canonical_json FROM research_manifests WHERE manifest_hash=$1", [hash])).rows[0]?.canonical_json === canonical, "RESEARCH_MANIFEST_CONFLICT");
      const authority = (await db.query("SELECT manifest_hash FROM research_authority WHERE config_hash=$1 FOR UPDATE", [manifest.configHash])).rows[0];
      if (authority?.manifest_hash !== hash && input.adopt) {
        researchAssert(!input.tradingEnabled, "RESEARCH_ADOPTION_REQUIRES_DISABLED_WRITES");
        await db.query("LOCK TABLE research_observations IN SHARE MODE");
        const active = await db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM research_observations WHERE expires_at>clock_timestamp() AND trading_enabled)
          OR EXISTS(SELECT 1 FROM proposal_ai_reviews WHERE claim_until>clock_timestamp()
            OR (delivery_started_at IS NOT NULL AND (delivery_outcome IS NULL OR delivery_outcome ILIKE '%unknown%')))
          OR EXISTS(SELECT 1 FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key)
            WHERE r.kind='model' AND (o.call_key IS NULL OR o.outcome='UNKNOWN'))
          OR EXISTS(SELECT 1 FROM research_wsh_acquisitions WHERE state='PENDING' AND retired_at IS NULL)
          OR EXISTS(SELECT 1 FROM research_wsh_refresh_attempts WHERE state='STARTED')`);
        researchAssert(!active.rows.length, "RESEARCH_ADOPTION_ACTIVE_OR_UNKNOWN_WORK");
        const hasMarketaux = (await db.query("SELECT to_regclass('research_marketaux_attempts') AS table_name")).rows[0]?.table_name;
        if (hasMarketaux) researchAssert(!(await db.query("SELECT 1 FROM research_marketaux_attempts WHERE state IN ('STARTED','FINALIZING','UNKNOWN') LIMIT 1")).rows.length, "RESEARCH_ADOPTION_ACTIVE_OR_UNKNOWN_WORK");
        await db.query(`INSERT INTO research_authority(config_hash,manifest_hash) VALUES($1,$2) ON CONFLICT(config_hash)
          DO UPDATE SET manifest_hash=EXCLUDED.manifest_hash,adopted_at=clock_timestamp()`, [manifest.configHash, hash]);
        await db.query("INSERT INTO research_authority_history(config_hash,manifest_hash,previous_hash,entries_disabled) VALUES($1,$2,$3,TRUE)", [manifest.configHash, hash, authority?.manifest_hash ?? null]);
      }
      return { hash };
    });
  }
  async observe(input: ResearchIdentity & { service: "execution-engine" | "llm-agent"; processId: string; tradingEnabled: boolean }): Promise<void> {
    researchAssert(input.processId.length > 0 && input.processId.length <= 200 && typeof input.tradingEnabled === "boolean");
    const result = await this.pool.query(`WITH stamp AS (SELECT clock_timestamp() AS now)
      INSERT INTO research_observations(process_id,service,config_hash,manifest_hash,trading_enabled,observed_at,expires_at)
      SELECT $1,$2,$3,$4,$5,now,now+interval '30 seconds' FROM stamp
      ON CONFLICT(process_id) DO UPDATE SET observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,trading_enabled=EXCLUDED.trading_enabled
      WHERE research_observations.service=EXCLUDED.service AND research_observations.config_hash=EXCLUDED.config_hash AND research_observations.manifest_hash=EXCLUDED.manifest_hash RETURNING process_id`,
    [input.processId, input.service, input.configHash, input.manifestHash, input.tradingEnabled]);
    researchAssert(result.rows.length === 1, "RESEARCH_PROCESS_IDENTITY_CHANGED");
  }
  async assertAuthority(identity: ResearchIdentity, existing?: ResearchDb): Promise<{ validUntilMs: number }> {
    return this.transaction(async db => {
      researchAssert(isResearchHash(identity.configHash) && isResearchHash(identity.manifestHash));
      const row = (await db.query("SELECT manifest_hash FROM research_authority WHERE config_hash=$1 FOR SHARE", [identity.configHash])).rows[0];
      researchAssert(row?.manifest_hash === identity.manifestHash, "RESEARCH_AUTHORITY_MISMATCH");
      await db.query("LOCK TABLE research_observations IN SHARE MODE");
      const observations = (await db.query("SELECT * FROM research_observations WHERE expires_at>clock_timestamp() AND observed_at<=clock_timestamp()")).rows;
      for (const service of ["execution-engine", "llm-agent"]) {
        const peers = observations.filter(o => o.service === service);
        researchAssert(peers.length > 0 && peers.every(o => o.config_hash === identity.configHash && o.manifest_hash === identity.manifestHash), "RESEARCH_PEER_MISSING_OR_DRIFTED");
      }
      return { validUntilMs: Math.min(...observations.map(o => researchTime(iso(o.expires_at)))) };
    }, existing);
  }
  private async readManifest(identity: ResearchIdentity, db: ResearchDb): Promise<ResearchManifest> {
    const row = (await db.query(`SELECT r.canonical_json,c.canonical_json AS config_json FROM research_manifests r
      JOIN trading_configuration_snapshots c ON c.effective_hash=r.config_hash WHERE r.manifest_hash=$1 AND r.config_hash=$2`, [identity.manifestHash, identity.configHash])).rows[0];
    researchAssert(row && typeof row.canonical_json === "string" && typeof row.config_json === "string", "RESEARCH_MANIFEST_MISSING");
    const manifest = parseResearchManifest(JSON.parse(row.canonical_json), decodeTradingConfigurationSnapshot(row.config_json, identity.configHash), identity.configHash);
    researchAssert(researchHash(manifest) === identity.manifestHash && canonicalJson(manifest) === row.canonical_json, "RESEARCH_MANIFEST_CORRUPT"); return manifest;
  }
  private decode(row: Record<string, unknown>, manifest: ResearchManifest): StoredResearchSnapshot {
    researchAssert(typeof row.canonical_json === "string" && typeof row.id === "string");
    const snapshot = parseResearchSnapshot(JSON.parse(row.canonical_json), manifest), hash = researchHash(snapshot), sequence = Number(row.sequence);
    researchAssert(hash === row.snapshot_hash && canonicalJson(snapshot) === row.canonical_json && Number.isSafeInteger(sequence) && sequence > 0, "RESEARCH_SNAPSHOT_CORRUPT");
    return { id: row.id, hash, sequence, snapshot };
  }
  async storeSnapshot(input: ResearchSnapshot, refreshSlot?: string, admissionDeadlineAt?: string): Promise<StoredResearchSnapshot> {
    return this.persistSnapshot(input, refreshSlot, admissionDeadlineAt);
  }
  private async persistSnapshot(input: ResearchSnapshot, refreshSlot?: string, admissionDeadlineAt?: string, existing?: ResearchDb, publishingAcquisitionId?: string, publishingMarketauxId?: string): Promise<StoredResearchSnapshot> {
    if (admissionDeadlineAt !== undefined) researchTime(admissionDeadlineAt);
    return this.transaction(async db => {
      await this.assertAuthority(input, db); await this.assertRecoveryAdmission(input,db); const manifest = await this.readManifest(input, db), snapshot = parseResearchSnapshot(input, manifest);
      await this.assertWshSnapshotProvenance(snapshot, db, publishingAcquisitionId);
      await this.assertMarketauxSnapshotProvenance(snapshot, db, publishingMarketauxId);
      researchAssert(researchTime(snapshot.createdAt) <= await this.now(db), "RESEARCH_FUTURE_SNAPSHOT");
      const key = [snapshot.configHash, snapshot.manifestHash, snapshot.instrumentId];
      await db.query("INSERT INTO research_snapshot_heads(config_hash,manifest_hash,instrument_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", key);
      const head = (await db.query("SELECT sequence,snapshot_id FROM research_snapshot_heads WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3 FOR UPDATE", key)).rows[0];
      if (head.snapshot_id) {
        const previous = await this.readSnapshot(String(head.snapshot_id), db); researchAssert(previous, "RESEARCH_HEAD_CORRUPT");
        researchAssert(researchTime(snapshot.createdAt) >= researchTime(previous.snapshot.createdAt), "RESEARCH_REFRESH_OUT_OF_ORDER");
        for (const result of snapshot.coverage) {
          const old = previous.snapshot.coverage.find(c => c.sourceId === result.sourceId && c.role === result.role);
          researchAssert(!old || researchTime(result.checkedAt) >= researchTime(old.checkedAt), "RESEARCH_REFRESH_OUT_OF_ORDER");
        }
      }
      const sequence = Number(head.sequence) + 1; researchAssert(Number.isSafeInteger(sequence));
      const id = randomUUID(), hash = researchHash(snapshot);
      if (admissionDeadlineAt !== undefined) researchAssert(await this.now(db) < researchTime(admissionDeadlineAt), "RESEARCH_SNAPSHOT_ADMISSION_EXPIRED");
      const inserted = await db.query(`INSERT INTO research_snapshots(id,snapshot_hash,config_hash,manifest_hash,instrument_id,sequence,canonical_json)
        SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $8::timestamptz IS NULL OR clock_timestamp() < $8::timestamptz RETURNING id`,
        [id, hash, ...key, sequence, canonicalJson(snapshot), admissionDeadlineAt ?? null]);
      researchAssert(inserted.rows.length === 1, "RESEARCH_SNAPSHOT_ADMISSION_EXPIRED");
      await db.query("UPDATE research_snapshot_heads SET snapshot_id=$4,sequence=$5 WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3", [...key, id, sequence]);
      if (refreshSlot !== undefined) {
        researchAssert(refreshSlot.length > 0 && refreshSlot.length <= 1000, "RESEARCH_REFRESH_SLOT_INVALID");
        await db.query("INSERT INTO research_refresh_slots(slot_key,snapshot_id) VALUES($1,$2)", [refreshSlot, id]);
      }
      return { id, hash, sequence, snapshot };
    }, existing);
  }
  async latestSnapshot(identity: ResearchIdentity & { instrumentId: string }, existing?: ResearchDb, lockHead = false): Promise<StoredResearchSnapshot | null> {
    return this.transaction(async db => {
      const manifest = await this.readManifest(identity, db);
      const head = (await db.query(`SELECT snapshot_id FROM research_snapshot_heads WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3${lockHead ? " FOR UPDATE" : ""}`, [identity.configHash, identity.manifestHash, identity.instrumentId])).rows[0];
      if (!head?.snapshot_id) return null;
      const row = (await db.query("SELECT * FROM research_snapshots WHERE id=$1", [head.snapshot_id])).rows[0];
      researchAssert(row, "RESEARCH_HEAD_CORRUPT"); return this.decode(row, manifest);
    }, existing);
  }
  async readSnapshot(id: string, existing?: ResearchDb,deadlineAt?:string|WshAttemptTicket): Promise<StoredResearchSnapshot | null> {
    if(deadlineAt!==undefined&&!existing)return this.wshRead(db=>this.readSnapshot(id,db),deadlineAt);
    return this.transaction(async db => {
      const row = (await db.query("SELECT * FROM research_snapshots WHERE id=$1", [id])).rows[0];
      if (!row) return null;
      const manifest = await this.readManifest({ configHash: String(row.config_hash), manifestHash: String(row.manifest_hash) }, db);
      return this.decode(row, manifest);
    }, existing);
  }
  async getBinding(proposalId: number, existing?: ResearchDb): Promise<ResearchBinding | null> {
    const row = (await (existing ?? this.pool).query("SELECT * FROM research_bindings WHERE proposed_order_id=$1", [proposalId])).rows[0];
    return row ? { proposalId: Number(row.proposed_order_id), clientOrderHash: String(row.client_order_hash), instrumentId: String(row.instrument_id), configHash: String(row.config_hash), manifestHash: String(row.manifest_hash), snapshotId: String(row.snapshot_id), snapshotHash: String(row.snapshot_hash), sequence: Number(row.sequence) } : null;
  }
  async bind(input: ResearchBindingIdentity, existing?: ResearchDb): Promise<ValidatedResearchBinding> {
    return this.transaction(async db => {
      const proposal = (await db.query("SELECT * FROM proposed_orders WHERE id=$1 FOR UPDATE", [input.proposalId])).rows[0];
      const review = (await db.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1 FOR UPDATE", [input.proposalId])).rows[0];
      researchAssert(proposal && review && proposal.client_order_hash_version === 2 && review.client_order_hash_version === 2 &&
        canonicalJson(proposal.strategy_attribution) === canonicalJson(review.strategy_attribution) && canonicalJson(proposal.strategy_trigger) === canonicalJson(review.strategy_trigger) &&
        proposal.conid === review.conid && review.instrument_id === input.instrumentId && proposal.client_order_hash === input.clientOrderHash && proposal.instrument_id === input.instrumentId && proposal.strategy_configuration_hash === input.configHash && review.client_order_hash === input.clientOrderHash && review.status === "PENDING" && !review.decision_json && !review.decided_at && !review.delivery_started_at && !review.delivery_outcome && proposal.status === "PROPOSED" && !proposal.execution_attempted_at && !proposal.broker_order_id, "RESEARCH_PROPOSAL_BINDING_INVALID");
      await this.assertAuthority(input, db);
      await this.assertRecoveryAdmission(input,db);
      if (!(await this.getBinding(input.proposalId, db))) {
        const manifest = await this.readManifest(input, db);
        if (isTwoSourceResearch(manifest)) await db.query("LOCK TABLE research_marketaux_attempts IN SHARE MODE");
        const stored = await this.latestSnapshot(input, db, true);
        researchAssert(stored, "RESEARCH_SNAPSHOT_MISSING"); const eligibility = evaluateResearchEligibility(stored.snapshot, manifest, await this.now(db));
        researchAssert(eligibility.eligible, `RESEARCH_INELIGIBLE:${eligibility.reasons.join(",")}`);
        await db.query("INSERT INTO research_bindings(proposed_order_id,client_order_hash,config_hash,manifest_hash,instrument_id,snapshot_id,snapshot_hash,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [input.proposalId, input.clientOrderHash, input.configHash, input.manifestHash, input.instrumentId, stored.id, stored.hash, stored.sequence]);
      }
      return this.validateBinding(input, db, true);
    }, existing);
  }
  async validateBinding(input: ResearchBindingIdentity, existing?: ResearchDb, lockHead = true): Promise<ValidatedResearchBinding> {
    return this.transaction(async db => {
      await this.assertAuthority(input, db);
      await this.assertRecoveryAdmission(input,db);
      const binding = await this.getBinding(input.proposalId, db);
      researchAssert(binding && binding.clientOrderHash === input.clientOrderHash && binding.configHash === input.configHash && binding.manifestHash === input.manifestHash && binding.instrumentId === input.instrumentId, "RESEARCH_BINDING_MISMATCH");
      const activeManifest = await this.readManifest(input, db);
      if (isTwoSourceResearch(activeManifest)) await db.query("LOCK TABLE research_marketaux_attempts IN SHARE MODE");
      const stored = await this.latestSnapshot(input, db, lockHead);
      researchAssert(stored && stored.id === binding.snapshotId && stored.hash === binding.snapshotHash && stored.sequence === binding.sequence, "RESEARCH_SNAPSHOT_SUPERSEDED");
      await this.assertWshRefreshAdmission(input,db);
      if (isTwoSourceResearch(stored.snapshot)) {
        await this.assertMarketauxSnapshotProvenance(stored.snapshot,db);
        researchAssert(!(await this.marketauxAdmissionReasons(input,db)).length, "RESEARCH_MARKETAUX_ATTEMPT_UNRESOLVED");
      }
      const manifest = await this.readManifest(input, db), eligibility = evaluateResearchEligibility(stored.snapshot, manifest, await this.now(db));
      researchAssert(eligibility.eligible, `RESEARCH_INELIGIBLE:${eligibility.reasons.join(",")}`);
      return { binding, stored, manifest, eligibility };
    }, existing);
  }
  async reserveCall(input: ResearchCallReservation, existing?: ResearchDb, marketauxAttemptId?: string): Promise<{ callKey: string; reservedAt: string; budgetDay: string }> {
    for (const n of [input.reservedCostMicros, input.maxRequestsPerDay, input.maxCostMicrosPerDay]) researchAssert(Number.isSafeInteger(n) && n >= 0, "RESEARCH_BUDGET_INVALID");
    researchAssert(/^[A-Za-z0-9_-]{1,80}$/.test(input.accountId) && input.provider.length > 0 && input.provider.length <= 200 && input.callKey.length > 0 && input.callKey.length <= 1000 && isResearchHash(input.requestHash));
    return this.transaction(async db => {
      const authority = await this.assertAuthority(input, db);
      const manifest = await this.readManifest(input, db);
      if (isTwoSourceResearch(manifest) && input.kind === 'source' && input.provider === 'https://api.marketaux.com') researchAssert(existing && marketauxAttemptId && (await db.query("SELECT 1 FROM research_marketaux_attempts WHERE id=$1 AND state='STARTED' AND config_hash=$2 AND manifest_hash=$3 AND account_id=$4",[marketauxAttemptId,input.configHash,input.manifestHash,input.accountId])).rows.length, 'RESEARCH_MARKETAUX_TICKET_REQUIRED');
      const limits = input.kind === "model" ? manifest.model.provider === input.provider ? [{ requests: manifest.model.maxRequestsPerDay, cost: manifest.model.maxCostMicrosPerDay, perCall: manifest.model.maxCostMicrosPerCall }] : [] :
        manifest.refreshEnabled ? manifest.instruments.flatMap(i => i.sources).filter(s => s.provider === input.provider).map(s => ({ requests: s.maxRequestsPerDay, cost: s.maxCostMicrosPerDay, perCall: s.costMicrosPerCall })) : [];
      researchAssert(limits.length && input.maxRequestsPerDay <= Math.min(...limits.map(l => l.requests)) && input.maxCostMicrosPerDay <= Math.min(...limits.map(l => l.cost)) && input.reservedCostMicros >= Math.max(...limits.map(l => l.perCall)), "RESEARCH_BUDGET_MANIFEST_MISMATCH");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`research-budget:${input.accountId}:${input.provider}`]);
      const now = await this.now(db), day = new Date(now).toISOString().slice(0, 10), deadline = researchTime(input.deadlineAt);
      researchAssert(now < authority.validUntilMs, "RESEARCH_PEER_MISSING_OR_DRIFTED");
      researchAssert(deadline > now && deadline <= now + 10000, "RESEARCH_CALL_DEADLINE_INVALID");
      researchAssert(!(await db.query("SELECT 1 FROM research_call_reservations WHERE call_key=$1", [input.callKey])).rows.length, "RESEARCH_CALL_ALREADY_RESERVED");
      const usage = (await db.query("SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3", [input.accountId, input.provider, day])).rows[0];
      if (!(Number(usage.requests) < input.maxRequestsPerDay && Number(usage.cost) + input.reservedCostMicros <= input.maxCostMicrosPerDay)) throw new ResearchBudgetExhausted({ day, recordedAt: new Date(now).toISOString(), requests: Number(usage.requests), cost: Number(usage.cost), maxRequests: input.maxRequestsPerDay, maxCost: input.maxCostMicrosPerDay, nextCost: input.reservedCostMicros });
      await db.query("INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [input.callKey, input.accountId, input.provider, input.kind, input.configHash, input.manifestHash, input.requestHash, input.reservedCostMicros, new Date(now).toISOString(), input.deadlineAt, day]);
      return { callKey: input.callKey, reservedAt: new Date(now).toISOString(), budgetDay: day };
    }, existing);
  }
  // Lock order: caller proposal/review locks, authority/observations, WSH endpoint
  // row (WSH writers only), budget, snapshot head. Endpoint session lock is held
  // outside transactions. No acquisition takes proposal/review locks.
  async withWshEndpointLock(endpointId: string, run: (lease: WshEndpointLease) => Promise<void>): Promise<boolean> {
    researchAssert(endpointId.length > 0 && endpointId.length <= 500);
    const bounded=await connectWshBounded(this.pool),db=bounded.db,key = `research-wsh-endpoint:${endpointId}`;
    let locked = false;
    const lease: WshEndpointLease = { endpointId, assertHeld: async () => {
      researchAssert(this.wshLeases.get(lease) === db, "RESEARCH_WSH_LOCK_LOST");
      const found = (await db.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
        AND classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid
        AND objid=(hashtext($1)::bigint & 4294967295)::oid AND objsubid=1 AND granted`, [key])).rows;
      researchAssert(found.length === 1, "RESEARCH_WSH_LOCK_LOST");
    } };
    try {
      locked = (await db.query("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked", [key])).rows[0]?.locked === true;
      if (!locked) return false;
      this.wshLeases.set(lease, db);this.wshBounds.set(lease,bounded);bounded.endOperation(); await run(lease); return true;
    } finally {
      this.wshLeases.delete(lease);
      try { if (locked&&!bounded.closed) {bounded.beginOperation();await db.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]);} }
      catch { bounded.destroy(); }
      finally { bounded.destroy(); }
    }
  }
  private async wshTransaction<T>(lease: WshEndpointLease, fn: (db: ResearchDb) => Promise<T>): Promise<T> {
    const bounded=this.wshBounds.get(lease),db=this.wshLeases.get(lease);researchAssert(bounded&&db,'RESEARCH_WSH_LOCK_LOST');
    bounded.beginOperation();
    try {await lease.assertHeld();await db.query('BEGIN');await db.query('LOCK TABLE research_recovery_challenges IN SHARE MODE');const result=await fn(db);await lease.assertHeld();await db.query('COMMIT');return result;}
    catch(error){if(!bounded.closed){try{await db.query('ROLLBACK');}catch{bounded.destroy();}}throw error;}
    finally{bounded.endOperation();}
  }
  private async wshRead<T>(fn:(db:ResearchDb)=>Promise<T>,budget?:string|WshAttemptTicket):Promise<T>{
    const deadlineAt=typeof budget==='string'?budget:undefined;
    let monotonicDeadline:number|undefined;
    if(budget&&typeof budget!=='string'){
      monotonicDeadline=Math.min(this.wshTicketDeadlines.get(budget)??Infinity,performance.now()+researchTime(budget.deadlineAt)-Date.now());
      researchAssert(monotonicDeadline>performance.now(),'RESEARCH_WSH_BOOKKEEPING_TIMEOUT');
    }
    const bounded=await connectWshBounded(this.pool,deadlineAt,monotonicDeadline);
    try{return await fn(bounded.db);}finally{bounded.destroy();}
  }

  private wshTicket(row: Record<string, unknown>): WshAttemptTicket {
    return { id:String(row.id), cycleId:String(row.cycle_id), ordinal:Number(row.ordinal) as 0|1|2,
      accountId:String(row.account_id),configHash:String(row.config_hash),manifestHash:String(row.manifest_hash),
      instrumentId:String(row.instrument_id),sourceId:String(row.source_id),endpointId:String(row.endpoint_id),sessionId:String(row.session_id),
      startedAt:iso(row.started_at),deadlineAt:iso(row.deadline_at),nextRegularAt:iso(row.next_regular_at) };
  }
  private wshDiagnostic(row: Record<string, unknown>): WshAttemptDiagnostic {
    researchAssert(row.source_error == null || isResearchSourceError(row.source_error), 'RESEARCH_WSH_DIAGNOSTIC_INVALID');
    researchAssert(row.provider_error == null || isResearchProviderError(row.provider_error), 'RESEARCH_WSH_DIAGNOSTIC_INVALID');
    return {id:String(row.id),cycleId:String(row.cycle_id),ordinal:Number(row.ordinal) as 0|1|2,state:row.state as WshAttemptDiagnostic['state'],
      terminalResultHash:row.result_hash as string|null,startedAt:iso(row.started_at),finishedAt:row.finished_at ? iso(row.finished_at):null,cleanup:row.cleanup_state as WshAttemptDiagnostic['cleanup'],
      failureClass:row.failure_class as WshAttemptDiagnostic['failureClass'],failureReason:row.failure_reason as string|null,stage:row.failure_stage as WshAttemptDiagnostic['stage'],
      ...(row.source_error ? {sourceError:row.source_error as WshAttemptDiagnostic['sourceError']} : {}),
      ...(row.provider_error ? {providerError:row.provider_error as WshAttemptDiagnostic['providerError']} : {})};
  }
  private async wshAttemptRow(ticket:WshAttemptTicket,db:ResearchDb,lock=false):Promise<Record<string,unknown>> {
    const row=(await db.query(`SELECT a.*,c.account_id,c.config_hash,c.manifest_hash,c.instrument_id,c.source_id,c.ledger_key,c.next_regular_at
      FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE a.id=$1${lock?' FOR UPDATE OF a':''}`,[ticket.id])).rows[0];
    researchAssert(row && canonicalJson(this.wshTicket(row))===canonicalJson(ticket),'RESEARCH_WSH_ATTEMPT_IDENTITY');
    researchAssert(!(await db.query("SELECT 1 FROM research_wsh_read_recovery_predecessors WHERE kind='WSH_ATTEMPT' AND predecessor_id=$1",[ticket.id])).rows.length,'RESEARCH_WSH_GENERATION_RETIRED');return row;
  }
  async readWshAttempt(ticket:WshAttemptTicket):Promise<WshAttemptDiagnostic|null> {
    return this.wshRead(async db=>this.wshDiagnostic(await this.wshAttemptRow(ticket,db)),ticket);
  }
  async claimWshAttempt(lease:WshEndpointLease,input:WshAttemptIdentity & {sessionId:string},kind:WshAttemptKind):Promise<WshAttemptClaim> {
    return this.wshTransaction(lease,async db=>{
      await this.assertAuthority(input,db);const {source,config}=await this.wshSource(input,db,false);await this.assertRecoveryAdmission(input,db);
      researchAssert(config.endpointId===lease.endpointId && input.sessionId.length>0 && input.sessionId.length<=500,'RESEARCH_WSH_ATTEMPT_IDENTITY');
      const ledger=wshLedgerKey(config.isin);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`research-wsh-issuer:${ledger}`]);
      const observedAt=performance.now(),now=await this.now(db);
      const cleanupFence=await this.wshCleanupFence(lease.endpointId,ledger,kind,db);
      if(cleanupFence){
        const baseline=cleanupFence!==true && kind==='regular'?await this.wshRegularNotBefore(ledger,config.refreshIntervalMs,db):null;
        return {state:'DEFERRED',reason:'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED',nextCheckAt:cleanupFence===true?null:new Date(Math.max(researchTime(cleanupFence),baseline??0)).toISOString()};
      }
      const defer=(reason:string,at:number|null):WshAttemptClaim=>({state:'DEFERRED',reason,nextCheckAt:at===null?null:new Date(at).toISOString()});
      const active=(await db.query(`SELECT a.* FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
        WHERE (c.ledger_key=$1 OR a.endpoint_id=$2) AND a.state='STARTED' ORDER BY a.started_at`,[ledger,lease.endpointId])).rows;
      for(const a of active){
        if(researchTime(iso(a.deadline_at))>now)return defer('RESEARCH_WSH_ATTEMPT_ACTIVE',researchTime(iso(a.deadline_at)));
        const pending=a.acquisition_id ? (await db.query("SELECT state FROM research_wsh_acquisitions WHERE id=$1",[a.acquisition_id])).rows[0] : undefined;
        if(pending?.state==='PENDING')return defer('RESEARCH_WSH_RECOVERY_REQUIRED',null);
        await db.query(`UPDATE research_wsh_refresh_attempts SET state='UNKNOWN',finished_at=clock_timestamp(),failure_class='UNCERTAIN',
          failure_reason='RESEARCH_WSH_ABANDONED_ATTEMPT',failure_stage='cleanup',cleanup_state='UNKNOWN' WHERE id=$1 AND state='STARTED'`,[a.id]);
      }
      if(active.length){const retiredFence=await this.wshCleanupFence(lease.endpointId,ledger,kind,db);if(retiredFence)return defer('RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED',retiredFence===true?null:researchTime(retiredFence));}
      const pending=(await db.query("SELECT 1 FROM research_wsh_acquisitions WHERE ledger_key=$1 AND state='PENDING' AND retired_at IS NULL",[ledger])).rows;
      if(pending.length)return defer('RESEARCH_WSH_RECOVERY_REQUIRED',null);
      let cycle=(await db.query('SELECT * FROM research_wsh_refresh_cycles WHERE ledger_key=$1 ORDER BY started_at DESC,id DESC LIMIT 1',[ledger])).rows[0];
      let ordinal=0,predecessor:unknown=null;
      if(kind==='retry'){
        if(!cycle||cycle.config_hash!==input.configHash||cycle.manifest_hash!==input.manifestHash||cycle.instrument_id!==input.instrumentId||cycle.source_id!==input.sourceId||cycle.account_id!==input.accountId)
          return defer('RESEARCH_WSH_RETRY_UNAVAILABLE',null);
        const last=(await db.query('SELECT * FROM research_wsh_refresh_attempts WHERE cycle_id=$1 ORDER BY ordinal DESC LIMIT 1',[cycle.id])).rows[0];
        if(!last?.retry_due_at || Number(last.ordinal)>=2 || now>=researchTime(iso(cycle.next_regular_at)))return defer('RESEARCH_WSH_RETRY_EXHAUSTED',researchTime(iso(cycle.next_regular_at)));
        if(now<researchTime(iso(last.retry_due_at)))return defer('RESEARCH_WSH_RETRY_NOT_DUE',researchTime(iso(last.retry_due_at)));
        ordinal=Number(last.ordinal)+1;predecessor=last.id;
      }else{
        const baseline=await this.wshRegularNotBefore(ledger,config.refreshIntervalMs,db);
        if(baseline!==null && now<baseline)return defer('RESEARCH_WSH_SLOT_TOO_EARLY',baseline);
        cycle={id:randomUUID(),next_regular_at:new Date(now+config.refreshIntervalMs)};
        await db.query(`INSERT INTO research_wsh_refresh_cycles(id,ledger_key,config_hash,manifest_hash,instrument_id,source_id,account_id,source_policy_hash,started_at,next_regular_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[cycle.id,ledger,input.configHash,input.manifestHash,input.instrumentId,input.sourceId,input.accountId,researchHash(source),new Date(now),cycle.next_regular_at]);
      }
      const id=randomUUID(),deadline=new Date(now+WSH_ATTEMPT_MS);
      this.wshBounds.get(lease)!.startAttempt(WSH_ATTEMPT_MS-(performance.now()-observedAt));
      await db.query(`INSERT INTO research_wsh_refresh_attempts(id,cycle_id,ordinal,predecessor_id,endpoint_id,session_id,started_at,deadline_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'STARTED')`,[id,cycle.id,ordinal,predecessor,lease.endpointId,input.sessionId,new Date(now),deadline]);
      if(ordinal===0)await db.query(`INSERT INTO research_wsh_recovery_successors(receipt_id,attempt_id)
        SELECT r.id,$1 FROM research_wsh_recovery_receipts r WHERE r.endpoint_id=$2 AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_successors s WHERE s.receipt_id=r.id)
        ON CONFLICT DO NOTHING`,[id,lease.endpointId]);
      const ticket:WshAttemptTicket={...input,id,cycleId:String(cycle.id),ordinal:ordinal as 0|1|2,endpointId:lease.endpointId,
        startedAt:new Date(now).toISOString(),deadlineAt:deadline.toISOString(),nextRegularAt:iso(cycle.next_regular_at)};
      this.wshTicketDeadlines.set(ticket,observedAt+WSH_ATTEMPT_MS);return {state:'CLAIMED',ticket};
    });
  }
  private async wshRegularNotBefore(ledger:string,interval:900000|3600000,db:ResearchDb):Promise<number|null> {
    const row=(await db.query(`SELECT greatest(research_wsh_regular_not_before($1,$2,clock_timestamp()),(SELECT max((i->>'nextRegularAt')::timestamptz) FROM research_wsh_read_recoveries r CROSS JOIN LATERAL jsonb_array_elements(r.canonical_json::jsonb->'issuers') i WHERE i->>'ledgerKey'=$1)) AS due`,[ledger,interval])).rows[0];
    return row?.due==null?null:researchTime(iso(row.due));
  }
  private async wshCleanupFence(endpointId:string,ledger:string,kind:WshAttemptKind,db:ResearchDb):Promise<true|string|null> {
    const rows=(await db.query(`SELECT a.verified_local_closure,c.next_regular_at,clock_timestamp() AS now
      FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
      WHERE (a.endpoint_id=$1 OR c.ledger_key=$2) AND a.state<>'STARTED' AND a.cleanup_state='UNKNOWN'
      AND NOT EXISTS(SELECT 1 FROM research_wsh_recovery_predecessors p WHERE p.attempt_id=a.id AND (
        ($3='regular' AND c.next_regular_at<=clock_timestamp()) OR EXISTS(
          SELECT 1 FROM research_wsh_recovery_successors s JOIN research_wsh_refresh_attempts first_attempt ON first_attempt.id=s.attempt_id
          WHERE s.receipt_id=p.receipt_id AND first_attempt.started_at<=clock_timestamp())))
      AND NOT EXISTS(SELECT 1 FROM research_wsh_read_recovery_predecessors d WHERE d.kind='WSH_ATTEMPT' AND d.predecessor_id=a.id)`,[endpointId,ledger,kind])).rows;
    if(rows.some(r=>r.verified_local_closure!==true))return true;
    if(rows.length&&kind==='retry')return true;
    const waits=rows.filter(r=>researchTime(iso(r.next_regular_at))>researchTime(iso(r.now)));
    return waits.length?new Date(Math.max(...waits.map(r=>researchTime(iso(r.next_regular_at))))).toISOString():null;
  }
  async confirmWshPreflight(lease:WshEndpointLease,ticket:WshAttemptTicket):Promise<void> {
    await this.wshTransaction(lease,async db=>{
      await this.assertAuthority(ticket,db);await this.wshSource(ticket,db);
      const row=await this.wshAttemptRow(ticket,db,true);
      researchAssert(row.state==='STARTED'&&row.acquisition_id===null,'RESEARCH_WSH_ATTEMPT_IDENTITY');
      const updated=await db.query("UPDATE research_wsh_refresh_attempts SET preflight_complete=true WHERE id=$1 AND state='STARTED' AND deadline_at>clock_timestamp() RETURNING id",[ticket.id]);
      researchAssert(updated.rows.length===1,'RESEARCH_WSH_ATTEMPT_EXPIRED');
    });
  }
  async finishWshAttempt(lease:WshEndpointLease,ticket:WshAttemptTicket,result:WshAttemptResult):Promise<void> {
    await this.wshTransaction(lease,async db=>{
      const remaining=researchTime(ticket.deadlineAt)-await this.now(db);
      researchAssert(remaining>0,'RESEARCH_WSH_ATTEMPT_EXPIRED');
      await this.assertAuthority(ticket,db);
      researchAssert(lease.endpointId===ticket.endpointId,'RESEARCH_WSH_ATTEMPT_IDENTITY');
      const manifest=await this.readManifest(ticket,db),policy=manifest.instruments.find(p=>p.instrumentId===ticket.instrumentId),source=policy?.sources.find(s=>s.id===ticket.sourceId);
      researchAssert(policy&&source,'RESEARCH_WSH_SOURCE_INVALID');const config=parseWshConfig(source,policy);
      await db.query('SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1 FOR UPDATE',[lease.endpointId]);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`research-wsh-issuer:${wshLedgerKey(config.isin)}`]);
      const row=await this.wshAttemptRow(ticket,db,true);
      researchAssert(result.cleanup.sessionId===ticket.sessionId,'RESEARCH_WSH_CLEANUP_SESSION_INVALID');
      const resultHash=researchHash(result);
      if(row.state!=='STARTED'){researchAssert(row.result_hash===resultHash,'RESEARCH_WSH_ATTEMPT_IMMUTABLE');return;}
      const now=await this.now(db),cleanup=result.cleanup;
      researchAssert(typeof cleanup.verifiedLocalClosure==='boolean' && (!cleanup.verifiedLocalClosure||cleanup.localClosedAt!==null) && (cleanup.state!=='CONFIRMED'||cleanup.verifiedLocalClosure) && (cleanup.state!=='NOT_NEEDED'||!cleanup.verifiedLocalClosure) && ['CONFIRMED','UNKNOWN','NOT_NEEDED'].includes(cleanup.state),'RESEARCH_WSH_CLEANUP_INVALID');
      for(const stamp of [cleanup.completedAt,cleanup.cancellationAttemptedAt,cleanup.disconnectRequestedAt,cleanup.localClosedAt])
        researchAssert(stamp===null || Number.isFinite(researchTime(stamp)),'RESEARCH_WSH_CLEANUP_INVALID');
      researchAssert(cleanup.state!=='CONFIRMED'||cleanup.localClosedAt!==null,'RESEARCH_WSH_CLEANUP_INVALID');
      researchAssert(cleanup.state!=='NOT_NEEDED'||row.acquisition_id===null&&cleanup.localClosedAt===null&&cleanup.cancellationAttemptedAt===null&&cleanup.disconnectRequestedAt===null,'RESEARCH_WSH_CLEANUP_INVALID');
      for(const stamp of [cleanup.cancellationAttemptedAt,cleanup.disconnectRequestedAt,cleanup.localClosedAt])researchAssert(stamp===null||researchTime(stamp)<=researchTime(cleanup.completedAt),'RESEARCH_WSH_CLEANUP_INVALID');
      researchAssert(!cleanup.sourceError||isResearchSourceError(cleanup.sourceError),'RESEARCH_WSH_DIAGNOSTIC_INVALID');
      let snapshotId:unknown=null,retained=false,retryAt:Date|null=null;
      if(result.acquisition){
        researchAssert(result.acquisition.id===row.acquisition_id&&result.acquisition.sessionId===ticket.sessionId,'RESEARCH_WSH_ATTEMPT_IDENTITY');
      }else researchAssert(row.acquisition_id===null,'RESEARCH_WSH_ATTEMPT_IDENTITY');
      if(result.outcome==='SUCCEEDED'){
        researchAssert(result.acquisition,'RESEARCH_WSH_PUBLICATION_INVALID');
        const acquisition=(await db.query('SELECT * FROM research_wsh_acquisitions WHERE id=$1',[result.acquisition.id])).rows[0];
        researchAssert(acquisition?.state==='PUBLISHED'&&acquisition.snapshot_id,'RESEARCH_WSH_PUBLICATION_INVALID');
        snapshotId=acquisition.snapshot_id;
      }else{
        researchAssert(result.outcome!=='UNKNOWN'||result.failureClass==='UNCERTAIN','RESEARCH_WSH_OUTCOME_INVALID');
        researchAssert(/^RESEARCH_[A-Z0-9_]{1,100}$/.test(result.failureReason),'RESEARCH_WSH_DIAGNOSTIC_INVALID');
        researchAssert(!result.sourceError||isResearchSourceError(result.sourceError),'RESEARCH_WSH_DIAGNOSTIC_INVALID');
        researchAssert(!result.providerError||isResearchProviderError(result.providerError),'RESEARCH_WSH_DIAGNOSTIC_INVALID');
        const negative=parseResearchSnapshot(result.snapshot,(await this.readManifest(ticket,db)));
        researchAssert(negative.instrumentId===ticket.instrumentId&&negative.configHash===ticket.configHash&&negative.manifestHash===ticket.manifestHash,'RESEARCH_WSH_PUBLICATION_IDENTITY_INVALID');
        const failure=negative.coverage.find(c=>c.sourceId===ticket.sourceId);
        researchAssert(failure&&!failure.complete&&!['AVAILABLE','EMPTY'].includes(failure.status),'RESEARCH_WSH_NEGATIVE_INVALID');
        const head=await this.latestSnapshot(ticket,db,true);
        const good=head?.snapshot.coverage.find(c=>c.sourceId===ticket.sourceId&&'wshAcquisition' in c);
        const state=await this.readWshRefreshState(ticket,db);
        const soft=['TRANSIENT','BUSY','ABORTED','BUDGET'].includes(result.failureClass);
        if(soft&&good&&!state.blocksCachedEvidence){
          await this.assertWshSnapshotProvenance(head!.snapshot,db);
          retained=true;snapshotId=head!.id;
        }else{
          const merged=head?structuredClone(head.snapshot):negative;
          const refs=new Set(merged.evidence.filter(e=>e.sourceId===ticket.sourceId).map(e=>e.ref));
          merged.evidence=merged.evidence.filter(e=>!refs.has(e.ref));merged.events=merged.events.filter(e=>!refs.has(e.evidenceRef));
          merged.coverage=merged.coverage.filter(c=>c.sourceId!==ticket.sourceId);merged.coverage.push(failure);
          merged.createdAt=new Date(now).toISOString();
          snapshotId=(await this.persistSnapshot(merged,result.slotKey,undefined,db)).id;
        }
        if(result.acquisition){
          await this.retireWshAcquisition(lease,result.acquisition,result.acquisitionOutcome??result.outcome,db);
          await db.query('UPDATE research_wsh_acquisitions SET snapshot_id=$2 WHERE id=$1',[result.acquisition.id,retained?null:snapshotId]);
        }
        if(result.outcome==='FAILED'&&result.failureClass==='TRANSIENT'&&cleanup.state!=='UNKNOWN'&&ticket.ordinal<2){
          const due=(await this.now(db))+WSH_RETRY_DELAYS_MS[ticket.ordinal as 0|1];
          if(due<researchTime(ticket.nextRegularAt))retryAt=new Date(due);
        }
      }
      const failure=result.outcome==='SUCCEEDED'?null:result;
      const updated=await db.query(`UPDATE research_wsh_refresh_attempts SET state=$2,finished_at=clock_timestamp(),failure_class=$3,failure_reason=$4,
        failure_stage=$5,source_error=$6,provider_error=$7,cleanup_state=$8,cleanup_completed_at=$9,cancellation_attempted_at=$10,
        disconnect_requested_at=$11,local_closed_at=$12,cleanup_error=$13,retry_due_at=$14,retained=$15,result_snapshot_id=$16,result_hash=$17,verified_local_closure=$18
        WHERE id=$1 AND state='STARTED' AND deadline_at>clock_timestamp() RETURNING id`,[ticket.id,result.outcome,failure?.failureClass??null,
        failure?.failureReason??null,failure?.stage??null,failure?.sourceError??null,failure?.providerError??null,cleanup.state,cleanup.completedAt,
        cleanup.cancellationAttemptedAt,cleanup.disconnectRequestedAt,cleanup.localClosedAt,cleanup.sourceError??null,retryAt,retained,snapshotId,resultHash,cleanup.verifiedLocalClosure]);
      researchAssert(updated.rows.length===1,'RESEARCH_WSH_ATTEMPT_EXPIRED');
    });
  }
  private async wshRecoveryBlocks(identity:ResearchIdentity & {instrumentId:string},db:ResearchDb):Promise<boolean>{
    const manifest=await this.readManifest(identity,db),policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId);
    if(!policy)return true;
    for(const source of policy.sources.filter(s=>s.adapter==='ibkr-wsh')){
      const config=parseWshConfig(source,policy);
      const rows=(await db.query(`SELECT 1 FROM research_wsh_recovery_receipts r JOIN research_wsh_recovery_predecessors p ON p.receipt_id=r.id
        LEFT JOIN research_wsh_refresh_attempts a ON a.id=p.attempt_id LEFT JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
        LEFT JOIN research_wsh_acquisitions ac ON ac.id=p.acquisition_id
        WHERE coalesce(c.ledger_key,ac.ledger_key)=$1 AND NOT EXISTS(SELECT 1 FROM research_wsh_acquisitions good
         WHERE good.state='PUBLISHED' AND good.config_hash=$2 AND good.manifest_hash=$3 AND good.instrument_id=$4 AND good.source_id=$5 AND good.started_at>r.recorded_at) LIMIT 1`,
        [wshLedgerKey(config.isin),identity.configHash,identity.manifestHash,identity.instrumentId,source.id])).rows;
      if(rows.length)return true;
      const automatic=(await db.query(`SELECT 1 FROM research_wsh_read_recoveries r CROSS JOIN LATERAL jsonb_array_elements(r.canonical_json::jsonb->'issuers') i WHERE i->>'ledgerKey'=$1 AND NOT EXISTS(SELECT 1 FROM research_wsh_acquisitions good WHERE good.state='PUBLISHED' AND good.config_hash=$2 AND good.manifest_hash=$3 AND good.instrument_id=$4 AND good.source_id=$5 AND good.started_at>r.recorded_at) LIMIT 1`,[wshLedgerKey(config.isin),identity.configHash,identity.manifestHash,identity.instrumentId,source.id])).rows;
      if(automatic.length)return true;
    }return false;
  }
  private async assertWshRefreshAdmission(identity:ResearchIdentity & {instrumentId:string},db:ResearchDb):Promise<void> {
    const blocked=await db.query(`SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
      LEFT JOIN research_wsh_acquisitions ac ON ac.id=a.acquisition_id
      WHERE c.config_hash=$1 AND c.manifest_hash=$2 AND c.instrument_id=$3
      AND ((a.state='STARTED' AND (NOT a.preflight_complete OR a.deadline_at<=clock_timestamp() AND ac.state IS DISTINCT FROM 'PUBLISHED')) OR a.failure_class IN ('HARD','UNCERTAIN'))
      AND NOT EXISTS(SELECT 1 FROM research_wsh_refresh_attempts good JOIN research_wsh_refresh_cycles gc ON gc.id=good.cycle_id
        LEFT JOIN research_wsh_acquisitions ga ON ga.id=good.acquisition_id
        WHERE gc.config_hash=c.config_hash AND gc.manifest_hash=c.manifest_hash AND gc.instrument_id=c.instrument_id AND gc.source_id=c.source_id AND gc.account_id=c.account_id
        AND good.started_at>a.started_at AND (good.state='SUCCEEDED' OR ga.state='PUBLISHED')) LIMIT 1`,[identity.configHash,identity.manifestHash,identity.instrumentId]);
    researchAssert(!blocked.rows.length&&!await this.wshRecoveryBlocks(identity,db),'RESEARCH_WSH_ATTEMPT_UNRESOLVED');
  }
  async readWshRefreshState(identity:WshAttemptIdentity,existing?:ResearchDb):Promise<WshRefreshState> {
    const db=existing??this.pool,manifest=await this.readManifest(identity,db),policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId);
    const source=policy?.sources.find(s=>s.id===identity.sourceId);researchAssert(source&&policy,'RESEARCH_WSH_SOURCE_INVALID');
    const config=parseWshConfig(source,policy),now=await this.now(db),stored=await this.latestSnapshot(identity,db);
    if(stored)await this.assertWshSnapshotProvenance(stored.snapshot,db);
    const c=stored?.snapshot.coverage.find(c=>c.sourceId===identity.sourceId && 'wshAcquisition' in c);
    const success=c ? researchTime(c.checkedAt):null;
    const policyExpiry=earliestSourceValidityExpiry(config.qualification,config.entitlement);
    const expiry=success===null?null:policyExpiry===null?success+config.maxAgeMs:Math.min(success+config.maxAgeMs,policyExpiry);
    const params=[identity.configHash,identity.manifestHash,identity.instrumentId,identity.sourceId,identity.accountId];
    const base=`FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id
      LEFT JOIN research_wsh_acquisitions ac ON ac.id=a.acquisition_id
      WHERE c.config_hash=$1 AND c.manifest_hash=$2 AND c.instrument_id=$3 AND c.source_id=$4 AND c.account_id=$5`;
    const rows=(await db.query(`SELECT a.*,c.next_regular_at,ac.state AS acquisition_state ${base} ORDER BY a.started_at DESC,a.ordinal DESC LIMIT 1`,params)).rows;
    const last=rows[0];
    const good=(await db.query(`SELECT max(a.started_at) AS at ${base} AND (a.state='SUCCEEDED' OR ac.state='PUBLISHED')`,params)).rows[0]?.at;
    const since=good?iso(good):'1970-01-01T00:00:00.000Z';
    const failures=(await db.query(`SELECT a.* ${base} AND a.started_at>$6 AND a.state IN ('FAILED','UNKNOWN') ORDER BY a.started_at DESC,a.ordinal DESC LIMIT 1`,[...params,since])).rows;
    const blocked=await this.wshRecoveryBlocks(identity,db)||(await db.query(`SELECT 1 ${base} AND a.started_at>$6 AND
      ((a.state='STARTED' AND (NOT a.preflight_complete OR a.deadline_at<=clock_timestamp() AND ac.state IS DISTINCT FROM 'PUBLISHED')) OR a.failure_class IN ('HARD','UNCERTAIN')) LIMIT 1`,[...params,since])).rows.length>0;
    const baseline=await this.wshRegularNotBefore(wshLedgerKey(config.isin),config.refreshIntervalMs,db);
    const cleanupFence=await this.wshCleanupFence(config.endpointId,wshLedgerKey(config.isin),'regular',db);
    const effective=cleanupFence===true?null:Math.max(baseline??0,cleanupFence?researchTime(cleanupFence):0);
    const nextRegular=effective?new Date(effective).toISOString():null;
    const retired=last&&(await db.query("SELECT 1 FROM research_wsh_read_recovery_predecessors WHERE kind='WSH_ATTEMPT' AND predecessor_id=$1",[last.id])).rows.length>0;
    const retry=!retired && last?.retry_due_at && last.state!=='STARTED' && now<researchTime(iso(last.next_regular_at))?iso(last.retry_due_at):null;
    return {recovery:await this.recoveryDiagnostic(identity,wshLedgerKey(config.isin),config.endpointId,db),sourceId:identity.sourceId,lastSuccessfulAt:success===null?null:new Date(success).toISOString(),expiresAt:expiry===null?null:new Date(expiry).toISOString(),
      retained:!!failures.length && success!==null && expiry!==null && now<expiry && !blocked,
      ...(cleanupFence?{acquisitionBlockedReason:'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED' as const}:{}),
      latestAttempt:last?this.wshDiagnostic(last):null,latestFailure:failures[0]?this.wshDiagnostic(failures[0]):null,nextRetryAt:retry,nextRegularAt:nextRegular,blocksCachedEvidence:blocked};
  }
  async dueWshAttempts(identity:ResearchIdentity & {accountId:string}):Promise<WshDueAttempt[]> {
    const manifest=await this.readManifest(identity,this.pool),due:WshDueAttempt[]=[],now=await this.now(this.pool);
    if(!manifest.refreshEnabled)return due;
    for(const p of manifest.instruments)for(const s of p.sources.filter(s=>s.adapter==='ibkr-wsh')){
      const key={...identity,instrumentId:p.instrumentId,sourceId:s.id};
      const recovery=await this.recoverExpiredWshReads(key);
      if(recovery.state==='WAITING'||recovery.state==='BUSY')continue;
      const state=await this.readWshRefreshState(key,this.pool);
      if(state.acquisitionBlockedReason&&!state.nextRegularAt)continue;
      if(state.nextRetryAt && researchTime(state.nextRetryAt)<=now)due.push({identity:key,kind:'retry',dueAt:state.nextRetryAt});
      else if(!state.nextRegularAt||researchTime(state.nextRegularAt)<=now)due.push({identity:key,kind:'regular',dueAt:state.nextRegularAt??new Date(now).toISOString()});
    }
    due.sort((a,b)=>a.dueAt.localeCompare(b.dueAt)||a.identity.instrumentId.localeCompare(b.identity.instrumentId));
    if(!due.length)return [];
    const start=this.wshDueCursor%due.length,selected=[...due.slice(start),...due.slice(0,start)].slice(0,2);
    this.wshDueCursor=(start+selected.length)%due.length;return selected;
  }
  private async wshSource(identity: ResearchIdentity & { sourceId: string; instrumentId: string }, db: ResearchDb, requireRights=true) {
    const manifest = await this.readManifest(identity, db); researchAssert(manifest.schemaVersion === 2, "RESEARCH_WSH_VERSION_INVALID");
    const policy = manifest.instruments.find(p => p.instrumentId === identity.instrumentId), source = policy?.sources.find(s => s.id === identity.sourceId);
    researchAssert(policy && source, "RESEARCH_WSH_SOURCE_INVALID"); const config = parseWshConfig(source, policy);
    if(requireRights)researchAssert(source.automation === "PERMITTED" && !["UNVERIFIED","DENIED"].includes(source.retention), "RESEARCH_PERMISSION_UNVERIFIED");
    if(requireRights)wshQualificationDeadline(config, await this.now(db)); return { manifest, policy, source, config };
  }
  private async assertWshFence(lease: WshEndpointLease, acquisition: WshAcquisition, db: ResearchDb): Promise<void> {
    researchAssert(acquisition.endpointId === lease.endpointId, "RESEARCH_WSH_FENCE_MISMATCH");
    await this.assertRecoveryAdmission(acquisition,db);
    const endpoint = (await db.query("SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1 FOR UPDATE", [lease.endpointId])).rows[0];
    const row = (await db.query("SELECT * FROM research_wsh_acquisitions WHERE id=$1 FOR UPDATE", [acquisition.id])).rows[0];
    researchAssert(endpoint && Number(endpoint.generation) === acquisition.generation && row && Number(row.generation) === acquisition.generation && row.endpoint_id === acquisition.endpointId && row.session_id === acquisition.sessionId && row.source_id === acquisition.sourceId && row.instrument_id === acquisition.instrumentId && row.config_hash === acquisition.configHash && row.manifest_hash === acquisition.manifestHash && row.state === "PENDING" && row.retired_at === null, "RESEARCH_WSH_GENERATION_RETIRED");
  }
  async beginWshAcquisition(lease: WshEndpointLease, input: ResearchIdentity & { instrumentId: string; sourceId: string; sessionId: string; reservation: ResearchCallReservation }, ticket?: WshAttemptTicket): Promise<WshAcquisition> {
    researchAssert(input.sessionId.length > 0 && input.sessionId.length <= 500);
    return this.wshTransaction(lease, async db => {
      await this.assertAuthority(input, db); await this.assertRecoveryAdmission(input,db); const { config } = await this.wshSource(input, db);
      researchAssert(config.endpointId === lease.endpointId && input.reservation.kind === "source" && input.reservation.provider === "ibkr-wsh" && input.reservation.configHash === input.configHash && input.reservation.manifestHash === input.manifestHash, "RESEARCH_WSH_RESERVATION_INVALID");
      await db.query("INSERT INTO research_wsh_endpoints(endpoint_id) VALUES($1) ON CONFLICT DO NOTHING", [lease.endpointId]);
      await db.query("SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1 FOR UPDATE", [lease.endpointId]);
      researchAssert(!(await db.query("SELECT 1 FROM research_wsh_acquisitions WHERE endpoint_id=$1 AND state='PENDING' AND retired_at IS NULL", [lease.endpointId])).rows.length, "RESEARCH_WSH_RECOVERY_REQUIRED");
      researchAssert(researchTime(input.reservation.deadlineAt) <= await this.now(db) + config.timeoutMs, "RESEARCH_WSH_CALL_DEADLINE_INVALID");
      const ledgerKey = wshLedgerKey(config.isin);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[`research-wsh-issuer:${ledgerKey}`]);
      researchAssert(!await this.wshCleanupFence(lease.endpointId,ledgerKey,ticket&&ticket.ordinal>0?'retry':'regular',db),'RESEARCH_WSH_CLEANUP_RECOVERY_REQUIRED');
      if(!ticket)researchAssert(!(await db.query(`SELECT 1 FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE c.ledger_key=$1 AND a.state='STARTED'`,[ledgerKey])).rows.length,'RESEARCH_WSH_ATTEMPT_ACTIVE');
      if(ticket){
        const attempt=await this.wshAttemptRow(ticket,db,true);
        researchAssert(attempt.state==='STARTED' && attempt.preflight_complete===true && ticket.accountId===input.reservation.accountId && attempt.acquisition_id===null && ticket.sessionId===input.sessionId && ticket.endpointId===lease.endpointId && ticket.configHash===input.configHash && ticket.manifestHash===input.manifestHash && ticket.instrumentId===input.instrumentId && ticket.sourceId===input.sourceId && await this.now(db)<researchTime(ticket.deadlineAt),'RESEARCH_WSH_ATTEMPT_IDENTITY');
      }else {
        const baseline=await this.wshRegularNotBefore(ledgerKey,config.refreshIntervalMs,db);
        researchAssert(baseline===null || await this.now(db)>=baseline,"RESEARCH_WSH_SLOT_TOO_EARLY");
      }
      const generation = Number((await db.query("UPDATE research_wsh_endpoints SET generation=generation+1 WHERE endpoint_id=$1 RETURNING generation", [lease.endpointId])).rows[0].generation);
      researchAssert(Number.isSafeInteger(generation)); const id = randomUUID();
      const row = (await db.query(`INSERT INTO research_wsh_acquisitions(id,endpoint_id,generation,session_id,source_id,instrument_id,ledger_key,config_hash,manifest_hash,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING') RETURNING started_at`, [id,lease.endpointId,generation,input.sessionId,input.sourceId,input.instrumentId,ledgerKey,input.configHash,input.manifestHash])).rows[0];
      if(ticket)await db.query("UPDATE research_wsh_refresh_attempts SET acquisition_id=$2 WHERE id=$1 AND state='STARTED'",[ticket.id,id]);
      await this.reserveCall(input.reservation, db);
      await db.query("INSERT INTO research_wsh_acquisition_calls(acquisition_id,call_key) VALUES($1,$2)", [id,input.reservation.callKey]);
      return { id,endpointId:lease.endpointId,generation,sessionId:input.sessionId,sourceId:input.sourceId,instrumentId:input.instrumentId,configHash:input.configHash,manifestHash:input.manifestHash,startedAt:iso(row.started_at) };
    });
  }
  async reserveWshCall(lease: WshEndpointLease, acquisition: WshAcquisition, reservation: ResearchCallReservation): Promise<void> {
    await this.wshTransaction(lease, async db => {
      await this.assertAuthority(acquisition, db); await this.assertRecoveryAdmission(acquisition,db); const { config } = await this.wshSource(acquisition, db); await this.assertWshFence(lease, acquisition, db);
      researchAssert(researchTime(reservation.deadlineAt) <= await this.now(db) + config.timeoutMs, "RESEARCH_WSH_CALL_DEADLINE_INVALID");
      researchAssert(reservation.kind === "source" && reservation.provider === "ibkr-wsh" && reservation.configHash === acquisition.configHash && reservation.manifestHash === acquisition.manifestHash, "RESEARCH_WSH_RESERVATION_INVALID");
      const metadata = (await db.query(`SELECT o.outcome,o.recorded_at,r.deadline_at,r.account_id FROM research_wsh_acquisition_calls c
        JOIN research_call_reservations r USING(call_key) LEFT JOIN research_call_outcomes o USING(call_key) WHERE c.acquisition_id=$1`, [acquisition.id])).rows;
      researchAssert(metadata.length === 1 && metadata[0].outcome === "SUCCEEDED" && researchTime(iso(metadata[0].recorded_at)) < researchTime(iso(metadata[0].deadline_at)), "RESEARCH_WSH_METADATA_NOT_COMPLETED");
      researchAssert(metadata[0].account_id===reservation.accountId,'RESEARCH_WSH_RESERVATION_INVALID');
      const account=(await db.query(`SELECT c.account_id FROM research_wsh_refresh_attempts a JOIN research_wsh_refresh_cycles c ON c.id=a.cycle_id WHERE a.acquisition_id=$1`,[acquisition.id])).rows[0];
      researchAssert(!account||account.account_id===reservation.accountId,'RESEARCH_WSH_RESERVATION_INVALID');
      await this.reserveCall(reservation, db);
      await db.query("INSERT INTO research_wsh_acquisition_calls(acquisition_id,call_key) VALUES($1,$2)", [acquisition.id,reservation.callKey]);
    });
  }
  async assertWshAcquisition(lease: WshEndpointLease, acquisition: WshAcquisition): Promise<void> {
    await this.wshTransaction(lease, async db => { await this.assertAuthority(acquisition, db); await this.wshSource(acquisition, db); await this.assertWshFence(lease, acquisition, db); });
  }
  async readWshAcquisition(id: string,deadlineAt?:string|WshAttemptTicket): Promise<WshAcquisitionRecord | null> {
    if(deadlineAt===undefined)return this.wshRead(db=>this.readWshAcquisitionFrom(id,db));
    return this.wshRead(db=>this.readWshAcquisitionFrom(id,db),deadlineAt);
  }
  private async readWshAcquisitionFrom(id:string,db:ResearchDb):Promise<WshAcquisitionRecord|null>{
    const row = (await db.query("SELECT * FROM research_wsh_acquisitions WHERE id=$1", [id])).rows[0];
    return row ? { ...row, generation: Number(row.generation) } as WshAcquisitionRecord : null;
  }
  async pendingWshAcquisition(lease: WshEndpointLease): Promise<WshAcquisition | null> {
    return this.wshTransaction(lease,async db=>{
      const row=(await db.query("SELECT * FROM research_wsh_acquisitions WHERE endpoint_id=$1 AND state='PENDING' AND retired_at IS NULL",[lease.endpointId])).rows[0];
      return row ? { id:String(row.id),endpointId:String(row.endpoint_id),generation:Number(row.generation),sessionId:String(row.session_id),sourceId:String(row.source_id),instrumentId:String(row.instrument_id),configHash:String(row.config_hash),manifestHash:String(row.manifest_hash),startedAt:iso(row.started_at) } : null;
    });
  }

  private async assertWshSnapshotProvenance(snapshot: ResearchSnapshot, db: ResearchDb, publishingId?: string): Promise<void> {
    if (snapshot.schemaVersion !== 2) return;
    for (const coverage of snapshot.coverage) {
      if (!("wshAcquisition" in coverage)) continue;
      const a = coverage.wshAcquisition;
      const row = (await db.query("SELECT * FROM research_wsh_acquisitions WHERE id=$1", [a.acquisitionId])).rows[0];
      researchAssert(row && row.config_hash === snapshot.configHash && row.manifest_hash === snapshot.manifestHash && row.instrument_id === snapshot.instrumentId && row.source_id === coverage.sourceId && Number(row.generation) === a.generation && row.session_id === a.sessionId && (row.state === "PUBLISHED" || row.state === "PENDING" && row.id === publishingId), "RESEARCH_WSH_ACQUISITION_INVALID");
      if (row.state === "PUBLISHED") {
        const original = (await db.query("SELECT canonical_json FROM research_snapshots WHERE id=$1", [row.snapshot_id])).rows[0];
        researchAssert(original && typeof original.canonical_json === "string", "RESEARCH_WSH_ACQUISITION_INVALID");
        const published = JSON.parse(original.canonical_json) as ResearchSnapshotV2;
        const projection = (value: ResearchSnapshot) => { const evidence = value.evidence.filter(e => e.sourceId === coverage.sourceId), refs = new Set(evidence.map(e => e.ref)); return { coverage: value.coverage.filter(c => c.sourceId === coverage.sourceId), evidence, events: value.events.filter(e => refs.has(e.evidenceRef)) }; };
        researchAssert(canonicalJson(projection(snapshot)) === canonicalJson(projection(published)), "RESEARCH_WSH_PUBLISHED_CONTEXT_IMMUTABLE");
      }
    }
    for (const e of snapshot.evidence) {
      if (e.published !== null) continue;
      const row = (await db.query("SELECT first_observed_at FROM research_wsh_first_observations WHERE ledger_key=$1 AND event_key=$2 AND version_hash=$3", [wshLedgerKey(e.issuerIdentifier.value),e.documentId,e.versionHash])).rows[0];
      researchAssert(row && iso(row.first_observed_at) === e.firstObservedAt, "RESEARCH_WSH_FIRST_OBSERVATION_INVALID");
    }
  }
  async publishWshSnapshot(lease: WshEndpointLease, acquisition: WshAcquisition, input: ResearchSnapshotV2, refreshSlot?: string, admissionDeadlineAt?: string): Promise<StoredResearchSnapshot> {
    return this.wshTransaction(lease, async db => {
      await this.assertAuthority(acquisition, db); await this.wshSource(acquisition, db); await this.assertWshFence(lease, acquisition, db);
      researchAssert(input.configHash === acquisition.configHash && input.manifestHash === acquisition.manifestHash && input.instrumentId === acquisition.instrumentId, "RESEARCH_WSH_PUBLICATION_IDENTITY_INVALID");
      const coverage = input.coverage.find(c => c.sourceId === acquisition.sourceId);
      researchAssert(coverage && "wshAcquisition" in coverage && coverage.wshAcquisition.acquisitionId === acquisition.id && coverage.complete, "RESEARCH_WSH_PUBLICATION_INVALID");
      const calls = (await db.query(`SELECT r.* FROM research_call_reservations r JOIN research_wsh_acquisition_calls c USING(call_key)
        WHERE c.acquisition_id=$1 ORDER BY r.reserved_at`, [acquisition.id])).rows;
      researchAssert(calls.length === 2 && calls[1].request_hash === coverage.wshAcquisition.requestHash && await this.now(db) < researchTime(iso(calls[1].deadline_at)), "RESEARCH_WSH_CALL_EXPIRED_OR_MISMATCHED");
      const manifest=await this.readManifest(acquisition,db),incoming=parseResearchSnapshot(input,manifest);
      researchAssert(incoming.schemaVersion===2,'RESEARCH_WSH_VERSION_INVALID');
      const headKey=[acquisition.configHash,acquisition.manifestHash,acquisition.instrumentId];
      await db.query('INSERT INTO research_snapshot_heads(config_hash,manifest_hash,instrument_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',headKey);
      const current=await this.latestSnapshot(acquisition,db,true);
      researchAssert(!current||current.snapshot.schemaVersion===2,'RESEARCH_WSH_VERSION_INVALID');
      const snapshot=structuredClone(current?.snapshot??incoming) as ResearchSnapshotV2;
      const oldRefs=new Set(snapshot.evidence.filter(e=>e.sourceId===acquisition.sourceId).map(e=>e.ref));
      const evidence=incoming.evidence.filter(e=>e.sourceId===acquisition.sourceId),newRefs=new Set(evidence.map(e=>e.ref));
      snapshot.coverage=[...snapshot.coverage.filter(c=>c.sourceId!==acquisition.sourceId),...incoming.coverage.filter(c=>c.sourceId===acquisition.sourceId)];
      snapshot.evidence=[...snapshot.evidence.filter(e=>e.sourceId!==acquisition.sourceId),...structuredClone(evidence)];
      snapshot.events=[...snapshot.events.filter(e=>!oldRefs.has(e.evidenceRef)),...structuredClone(incoming.events.filter(e=>newRefs.has(e.evidenceRef)))];
      for (const e of snapshot.evidence) {
        if (e.published !== null || e.sourceId !== acquisition.sourceId) continue;
        await db.query("INSERT INTO research_wsh_first_observations(ledger_key,event_key,version_hash,acquisition_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [wshLedgerKey(e.issuerIdentifier.value),e.documentId,e.versionHash,acquisition.id]);
        const row = (await db.query("SELECT first_observed_at FROM research_wsh_first_observations WHERE ledger_key=$1 AND event_key=$2 AND version_hash=$3", [wshLedgerKey(e.issuerIdentifier.value),e.documentId,e.versionHash])).rows[0];
        e.firstObservedAt = iso(row.first_observed_at);
      }
      snapshot.createdAt = new Date(await this.now(db)).toISOString();
      const deadline = new Date(Math.min(researchTime(iso(calls[1].deadline_at)), admissionDeadlineAt ? researchTime(admissionDeadlineAt) : Infinity)).toISOString();
      const stored = await this.persistSnapshot(snapshot, refreshSlot, deadline, db, acquisition.id);
      for (const call of calls) await this.recordCallOutcome(String(call.call_key), "SUCCEEDED", db);
      await db.query("UPDATE research_wsh_acquisitions SET state='PUBLISHED',snapshot_id=$2,retired_at=clock_timestamp() WHERE id=$1", [acquisition.id,stored.id]);
      return stored;
    });
  }
  async retireWshAcquisition(lease: WshEndpointLease, acquisition: WshAcquisition, outcome: "FAILED" | "UNKNOWN", existing?: ResearchDb): Promise<void> {
    const retire = async (db: ResearchDb) => {
      await this.assertWshFence(lease, acquisition, db);
      const calls = (await db.query("SELECT call_key FROM research_wsh_acquisition_calls WHERE acquisition_id=$1", [acquisition.id])).rows;
      for (const call of calls) {
        const previous = (await db.query("SELECT 1 FROM research_call_outcomes WHERE call_key=$1", [call.call_key])).rows;
        if (!previous.length) await this.recordCallOutcome(String(call.call_key), outcome, db);
      }
      await db.query("UPDATE research_wsh_acquisitions SET state=$2,retired_at=clock_timestamp() WHERE id=$1", [acquisition.id,outcome]);
      await db.query("UPDATE research_wsh_endpoints SET generation=generation+1 WHERE endpoint_id=$1", [lease.endpointId]);
    };
    if (existing) await retire(existing); else await this.wshTransaction(lease, retire);
  }
  async finishWshFailure(lease: WshEndpointLease, acquisition: WshAcquisition, snapshot: ResearchSnapshotV2, outcome: "FAILED" | "UNKNOWN", refreshSlot?: string): Promise<StoredResearchSnapshot> {
    return this.wshTransaction(lease, async db => {
      await this.assertAuthority(acquisition, db); await this.assertWshFence(lease, acquisition, db);
      researchAssert(snapshot.configHash === acquisition.configHash && snapshot.manifestHash === acquisition.manifestHash && snapshot.instrumentId === acquisition.instrumentId && snapshot.coverage.some(c => c.sourceId === acquisition.sourceId && !c.complete && c.status !== "AVAILABLE" && c.status !== "EMPTY"), "RESEARCH_WSH_NEGATIVE_INVALID");
      researchAssert(!snapshot.evidence.some(e => e.sourceId === acquisition.sourceId) && !snapshot.events.some(e => snapshot.evidence.find(v => v.ref === e.evidenceRef)?.sourceId === acquisition.sourceId), "RESEARCH_WSH_NEGATIVE_INVALID");
      const stored = await this.persistSnapshot(snapshot, refreshSlot, undefined, db);
      await this.retireWshAcquisition(lease, acquisition, outcome, db);
      await db.query("UPDATE research_wsh_acquisitions SET snapshot_id=$2 WHERE id=$1", [acquisition.id,stored.id]); return stored;
    });
  }
  async recordCallOutcome(callKey: string, outcome: "SUCCESS" | "SUCCEEDED" | "FAILED" | "UNKNOWN", existing?: ResearchDb,deadlineAt?:string|WshAttemptTicket): Promise<void> {
    if(deadlineAt!==undefined&&!existing)return this.wshRead(db=>this.recordCallOutcome(callKey,outcome,db),deadlineAt);
    const normalized = outcome === "SUCCESS" ? "SUCCEEDED" : outcome, db = existing ?? this.pool;
    await db.query("INSERT INTO research_call_outcomes(call_key,outcome) VALUES($1,$2) ON CONFLICT DO NOTHING", [callKey, normalized]);
    researchAssert((await db.query("SELECT outcome FROM research_call_outcomes WHERE call_key=$1", [callKey])).rows[0]?.outcome === normalized, "RESEARCH_CALL_OUTCOME_IMMUTABLE");
  }
}
