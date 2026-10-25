import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import { OWNER_RECOVERY_LIMITS, ownerRecoveryHash, parseOwnerRecoveryHandshake, parseOwnerRecoveryHostEvidence,
  parseOwnerRecoveryOperation, parseOwnerRecoveryReceipt, parseOwnerRecoveryRequest, type OwnerRecoveryOperation,
  type OwnerRecoveryOwner, type OwnerRecoveryProfile, type OwnerRecoveryOperatorEvidence, type OwnerRecoveryRequest,
  type OwnerRecoveryStatus, type OwnerRecoveryHostEvidence, type OwnerRecoveryHandshake, type OwnerRecoveryReceipt,
} from '@ikbr/shared/accounting-owner-recovery';
import { findAccountReservation } from '../ai-proposal-review.js';
import { accountingOwnerLockKey } from './source-owner.js';

type Prepare = Extract<OwnerRecoveryRequest, { action: 'prepare' }>;
type Supersede = Extract<OwnerRecoveryRequest, { action: 'supersede' }>;
type Begin = Extract<OwnerRecoveryRequest, { action: 'begin-observe' }>;
type Finalize = Extract<OwnerRecoveryRequest, { action: 'finalize-observation' }>;
const deny = (reason: string): never => { throw new Error(`ACCOUNTING_OWNER_RECOVERY_${reason}`); };
function requireValue(value: unknown, reason: string): asserts value { if (!value) deny(reason); }
const same = (a: unknown, b: unknown) => ownerRecoveryHash(a) === ownerRecoveryHash(b);
const timestamp = (value: Date | string) => value instanceof Date ? value.toISOString() : value;
async function databaseTime(client: PoolClient): Promise<string> {
  const before = performance.now(), wall = Date.now();
  const result = await client.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
  const elapsed = performance.now() - before, now = timestamp(result.rows[0].now);
  requireValue(elapsed <= OWNER_RECOVERY_LIMITS.databaseRoundTripMs && Math.abs(Date.parse(now) - wall - elapsed / 2) <= OWNER_RECOVERY_LIMITS.clockDriftMs, 'CLOCK_UNCERTAIN');
  return now;
}
async function lockSession(pool: Pool, endpointKey: string): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout='2000ms'"); await client.query("SET lock_timeout='2000ms'");
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [accountingOwnerLockKey(endpointKey)]);
    requireValue(result.rows[0]?.locked === true, 'OWNER_CONFLICT'); return client;
  } catch (error) { client.release(true); throw error; }
}
async function unlockSession(client: PoolClient, endpointKey: string): Promise<void> {
  try {
    const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [accountingOwnerLockKey(endpointKey)]);
    requireValue(result.rows[0]?.unlocked === true, 'MUTATION_UNKNOWN');
    const key = BigInt.asUintN(64, BigInt(accountingOwnerLockKey(endpointKey)));
    const absence = await client.query(`SELECT NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
      AND granted AND classid=$1::oid AND objid=$2::oid AND objsubid=1) AS absent`, [(key >> 32n).toString(), (key & 0xffffffffn).toString()]);
    requireValue(absence.rows[0]?.absent === true, 'MUTATION_UNKNOWN');
  } finally { client.release(true); }
}
async function transaction<T>(client: PoolClient, work: () => Promise<T>, active: () => void = () => undefined): Promise<T> {
  await client.query('BEGIN');
  try { active(); const result = await work(); active(); await client.query('COMMIT'); active(); return result; }
  catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}
async function maintenance(client: PoolClient, expected: string | null): Promise<void> {
  const row = await client.query('SELECT pending_operation_id FROM accounting_owner_recovery_maintenance WHERE singleton FOR UPDATE');
  requireValue(row.rowCount === 1 && row.rows[0].pending_operation_id === expected, 'MAINTENANCE_PENDING');
}
async function exactOwner(client: PoolClient, endpointKey: string): Promise<OwnerRecoveryOwner> {
  const rows = await client.query(`SELECT endpoint_key,owner_id,generation,retirement_state,
    to_char(acquired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acquired_at,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
    FROM accounting_source_owners WHERE retirement_state IN ('ACTIVE','UNKNOWN') ORDER BY endpoint_key FOR UPDATE`);
  requireValue(rows.rowCount === 1 && rows.rows[0].endpoint_key === endpointKey, 'OWNER_CHANGED');
  const row = rows.rows[0];
  const owner: OwnerRecoveryOwner = { endpointKey, ownerId: row.owner_id, generation: Number(row.generation), retirementState: row.retirement_state,
    acquiredAt: row.acquired_at, updatedAt: row.updated_at };
  requireValue(Number.isSafeInteger(owner.generation) && owner.generation > 0, 'OWNER_CHANGED'); return owner;
}
async function offlineEligibility(client: PoolClient, accountId: string, expectedRevision?: number): Promise<number> {
  const pause = await client.query('SELECT paused,revision FROM execution_entry_controls WHERE account_id=$1 FOR SHARE', [accountId]);
  const revision = Number(pause.rows[0]?.revision);
  requireValue(pause.rowCount === 1 && pause.rows[0].paused === true && Number.isSafeInteger(revision) && revision > 0
    && (expectedRevision === undefined || expectedRevision === revision), 'PAUSE_CHANGED');
  const history = await client.query(`SELECT 1 FROM proposed_orders p LEFT JOIN proposal_ai_reviews r ON r.proposed_order_id=p.id
    WHERE p.execution_attempted_at IS NOT NULL AND (p.execution_account_id=$1 OR r.account_id=$1
      OR (p.execution_account_id IS NULL AND r.account_id IS NULL)) LIMIT 1`, [accountId]);
  requireValue(history.rowCount === 0, 'BOT_HISTORY_UNSUPPORTED');
  requireValue(!await findAccountReservation(client, accountId), 'UNRESOLVED_LOCAL_OPERATION');
  const pending = await client.query(`SELECT 1 FROM paper_entry_attempts a LEFT JOIN lifecycle_supervision s ON s.original_proposal_id=a.proposed_order_id
    WHERE a.account_id=$1 AND (s.original_proposal_id IS NULL OR s.status NOT IN ('FLAT','TERMINAL_UNFILLED') OR s.terminal_proof IS NULL) LIMIT 1`, [accountId]);
  requireValue(pending.rowCount === 0, 'UNRESOLVED_LOCAL_OPERATION'); return revision;
}
function freshOperator(evidence: OwnerRecoveryOperatorEvidence, profile: OwnerRecoveryProfile, now: string): void {
  requireValue(evidence.accountId === profile.accountId && evidence.settingsHash === profile.settingsHash && evidence.deploymentHash === profile.deploymentHash
    && same(evidence.endpoint, profile.endpoint), 'OPERATOR_EVIDENCE_INVALID');
  for (const observed of [evidence.observedAt, ...evidence.artifacts.map(a => a.observedAt)]) {
    const age = Date.parse(now) - Date.parse(observed);
    requireValue(age >= 0 && age <= OWNER_RECOVERY_LIMITS.operatorEvidenceMs, 'OPERATOR_EVIDENCE_INVALID');
  }
}
async function event(client: PoolClient, op: OwnerRecoveryOperation, requestId: string, kind: string, evidence: unknown, evidenceDigest: string | null = null, actor = op.actor): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO accounting_owner_recovery_events(event_id,request_id,operation_id,kind,actor,binding_digest,evidence_digest,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [id, requestId, op.operationId, kind, actor, op.bindingDigest, evidenceDigest, JSON.stringify(evidence)]);
  return id;
}
function createOperation(operationId: string, actor: string, profile: OwnerRecoveryProfile, owner: OwnerRecoveryOwner, revision: number, preparedAt: string): OwnerRecoveryOperation {
  const binding = { version: 1 as const, operationId, nonce: randomUUID(), owner, profile, pauseRevision: revision, actor,
    preparedAt, expiresAt: new Date(Date.parse(preparedAt) + OWNER_RECOVERY_LIMITS.operationMs).toISOString() };
  return parseOwnerRecoveryOperation({ ...binding, bindingDigest: ownerRecoveryHash(binding), state: 'PREPARED', evidenceDigest: null, successorOperationId: null, receiptId: null });
}
async function insertOperation(client: PoolClient, op: OwnerRecoveryOperation): Promise<void> {
  await client.query(`INSERT INTO accounting_owner_recovery_operations(operation_id,endpoint_key,owner_id,generation,nonce,state,binding_digest,prepared_at,expires_at,record)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [op.operationId, op.owner.endpointKey, op.owner.ownerId, op.owner.generation, op.nonce, op.state,
    op.bindingDigest, op.preparedAt, op.expiresAt, JSON.stringify(op)]);
}
async function updateOperation(client: PoolClient, op: OwnerRecoveryOperation): Promise<void> {
  const changed = await client.query('UPDATE accounting_owner_recovery_operations SET state=$2,record=$3::jsonb WHERE operation_id=$1', [op.operationId, op.state, JSON.stringify(op)]);
  requireValue(changed.rowCount === 1, 'OWNER_CHANGED');
}
async function readOperation(client: Pick<PoolClient, 'query'>, operationId: string, lock = false): Promise<OwnerRecoveryOperation | null> {
  const found = await client.query(`SELECT record FROM accounting_owner_recovery_operations WHERE operation_id=$1${lock ? ' FOR UPDATE' : ''}`, [operationId]);
  return found.rowCount ? parseOwnerRecoveryOperation(found.rows[0].record) : null;
}

export class AccountingOwnerRecoveryStore {
  constructor(private readonly pool: Pool) {}
  async prepare(input: Prepare, endpointKey: string): Promise<OwnerRecoveryOperation> {
    const request = parseOwnerRecoveryRequest(input) as Prepare, client = await lockSession(this.pool, endpointKey);
    try {
      return await transaction(client, async () => {
        await maintenance(client, null);
        const owner = await exactOwner(client, endpointKey), revision = await offlineEligibility(client, request.profile.accountId), now = await databaseTime(client);
        freshOperator(request.operatorEvidence, request.profile, now);
        requireValue(request.actor === request.operatorEvidence.operator, 'OPERATOR_EVIDENCE_INVALID');
        requireValue(Date.parse(now) >= Date.parse(request.inventory.observedAt) && Date.parse(now) - Date.parse(request.inventory.observedAt) <= 10_000, 'INVENTORY_UNAVAILABLE');
        const op = createOperation(request.operationId, request.actor, request.profile, owner, revision, now);
        await insertOperation(client, op);
        await event(client, op, request.requestId, 'PREPARED', { operatorEvidence: request.operatorEvidence, inventory: request.inventory });
        await client.query('UPDATE accounting_owner_recovery_maintenance SET pending_operation_id=$1 WHERE singleton', [op.operationId]); return op;
      });
    } finally { await unlockSession(client, endpointKey); }
  }
  async supersede(input: Supersede, endpointKey: string): Promise<OwnerRecoveryOperation> {
    const request = parseOwnerRecoveryRequest(input) as Supersede, client = await lockSession(this.pool, endpointKey);
    try {
      return await transaction(client, async () => {
        await maintenance(client, request.operationId);
        const previous = await readOperation(client, request.operationId, true);
        requireValue(previous && ['PREPARED', 'OBSERVED'].includes(previous.state) && previous.owner.endpointKey === endpointKey && previous.profile.accountId === request.profile.accountId, 'OWNER_CHANGED');
        const owner = await exactOwner(client, endpointKey); requireValue(same(owner, previous.owner), 'OWNER_CHANGED');
        const revision = await offlineEligibility(client, request.profile.accountId), now = await databaseTime(client);
        freshOperator(request.operatorEvidence, request.profile, now);
        requireValue(request.actor === request.operatorEvidence.operator, 'OPERATOR_EVIDENCE_INVALID');
        requireValue(Date.parse(now) >= Date.parse(request.inventory.observedAt) && Date.parse(now) - Date.parse(request.inventory.observedAt) <= 10_000, 'INVENTORY_UNAVAILABLE');
        const op = createOperation(request.replacementOperationId, request.actor, request.profile, owner, revision, now);
        await event(client, previous, request.requestId, 'SUPERSEDED', { successorOperationId: op.operationId, operatorEvidence: request.operatorEvidence, inventory: request.inventory }, null, request.actor);
        await updateOperation(client, { ...previous, state: 'SUPERSEDED', successorOperationId: op.operationId });
        await insertOperation(client, op); await event(client, op, randomUUID(), 'PREPARED', { predecessorOperationId: previous.operationId });
        await client.query('UPDATE accounting_owner_recovery_maintenance SET pending_operation_id=$1 WHERE singleton', [op.operationId]); return op;
      });
    } finally { await unlockSession(client, endpointKey); }
  }
  async status(input: Extract<OwnerRecoveryRequest, { action: 'status' }>): Promise<OwnerRecoveryStatus> {
    const request = parseOwnerRecoveryRequest(input) as Extract<OwnerRecoveryRequest, { action: 'status' }>;
    const client = await this.pool.connect();
    try {
      await client.query("SET statement_timeout='2000ms'"); await client.query("SET lock_timeout='2000ms'");
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const operation = await readOperation(client, request.operationId);
      requireValue(!operation || operation.profile.accountId === request.profile.accountId, 'ACCOUNT_MISMATCH');
      const pending = await client.query('SELECT pending_operation_id FROM accounting_owner_recovery_maintenance WHERE singleton');
      requireValue(pending.rowCount === 1, 'MAINTENANCE_PENDING');
      const receiptRows = await client.query('SELECT record FROM accounting_owner_recovery_receipts WHERE operation_id=$1', [request.operationId]);
      const found = request.lookupRequestId ? await client.query('SELECT request_id,operation_id,kind,evidence_digest FROM accounting_owner_recovery_events WHERE request_id=$1 AND operation_id=$2', [request.lookupRequestId, request.operationId]) : undefined;
      const row = found?.rows[0];
      const eventRows = await client.query('SELECT event_id,request_id,kind,actor,recorded_at,binding_digest,evidence_digest FROM accounting_owner_recovery_events WHERE operation_id=$1 ORDER BY recorded_at,event_id LIMIT 7', [request.operationId]);
      requireValue(eventRows.rowCount !== null && eventRows.rowCount <= 6, 'RECEIPT_MISMATCH');
      const result: OwnerRecoveryStatus = { pendingOperationId: pending.rows[0].pending_operation_id,
        events: eventRows.rows.map(e => ({ eventId: e.event_id, requestId: e.request_id, kind: e.kind, actor: e.actor, recordedAt: timestamp(e.recorded_at), bindingDigest: e.binding_digest, evidenceDigest: e.evidence_digest })),
        operation, maintenancePending: pending.rows[0].pending_operation_id !== null,
        receipt: receiptRows.rowCount ? parseOwnerRecoveryReceipt(receiptRows.rows[0].record) : null,
        lookup: row ? { requestId: row.request_id, operationId: row.operation_id, kind: row.kind, evidenceDigest: row.evidence_digest } : null };
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async beginObserve(input: Begin, endpointKey: string): Promise<AccountingOwnerRecoveryObserver> {
    const request = parseOwnerRecoveryRequest(input) as Begin, client = await lockSession(this.pool, endpointKey);
    try {
      const result = await transaction(client, async () => {
        await maintenance(client, request.operationId);
        const op = await readOperation(client, request.operationId, true);
        requireValue(op && op.state === 'PREPARED' && op.actor === request.actor && op.bindingDigest === request.bindingDigest && same(op.profile, request.profile) && op.owner.endpointKey === endpointKey, 'OWNER_CHANGED');
        requireValue(same(await exactOwner(client, endpointKey), op.owner), 'OWNER_CHANGED');
        await offlineEligibility(client, op.profile.accountId, op.pauseRevision);
        const now = await databaseTime(client); requireValue(Date.parse(now) >= Date.parse(op.preparedAt) && Date.parse(now) < Date.parse(op.expiresAt), 'OBSERVATION_EXPIRED');
        const dispatched = await client.query("SELECT 1 FROM accounting_owner_recovery_events WHERE operation_id=$1 AND kind='HANDSHAKE_DISPATCH'", [op.operationId]);
        requireValue(dispatched.rowCount === 0, 'HANDSHAKE_UNKNOWN'); return { op, now };
      });
      return new AccountingOwnerRecoveryObserver(client, result.op, result.now);
    } catch (error) { await unlockSession(client, endpointKey); throw error; }
  }
}

export class AccountingOwnerRecoveryObserver {
  readonly observerSessionId = randomUUID();
  readonly remainingMs: number;
  private readonly started = performance.now();
  private readonly wallStarted = Date.now();
  private revoked = false;
  private released = false;
  private releasing?: Promise<void>;
  private dispatchId?: string;
  private reset?: OwnerRecoveryHostEvidence;
  private handshake?: OwnerRecoveryHandshake;
  private lastDatabase: number;
  private busy = false;
  constructor(private readonly client: PoolClient, public operation: OwnerRecoveryOperation, readonly dbNow: string) {
    this.remainingMs = Date.parse(operation.expiresAt) - Date.parse(dbNow); this.lastDatabase = Date.parse(dbNow);
    client.on('error', this.cancel); client.on('end', this.cancel);
  }
  cancel = (): void => { this.revoked = true; };
  assertActive(): void {
    const elapsed = performance.now() - this.started, wallElapsed = Date.now() - this.wallStarted;
    requireValue(!this.revoked && !this.released && elapsed >= 0 && elapsed < this.remainingMs
      && wallElapsed >= 0 && Math.abs(elapsed - wallElapsed) <= OWNER_RECOVERY_LIMITS.clockDriftMs, 'OBSERVATION_EXPIRED');
  }
  private async fresh(evidence: OwnerRecoveryHostEvidence): Promise<string> {
    this.assertActive();
    requireValue(evidence.operationId === this.operation.operationId && evidence.nonce === this.operation.nonce
      && evidence.bindingDigest === this.operation.bindingDigest && same(evidence.profile, this.operation.profile), 'SETTINGS_MISMATCH');
    requireValue(Date.parse(evidence.collectorStartedAt) >= Date.parse(this.operation.preparedAt), 'RESET_UNPROVEN');
    await maintenance(this.client, this.operation.operationId); this.assertActive();
    const current = await readOperation(this.client, this.operation.operationId, true);
    requireValue(current && same(current, this.operation), 'OWNER_CHANGED');
    requireValue(same(await exactOwner(this.client, this.operation.owner.endpointKey), this.operation.owner), 'OWNER_CHANGED');
    await offlineEligibility(this.client, this.operation.profile.accountId, this.operation.pauseRevision); this.assertActive();
    const now = await databaseTime(this.client), databaseMs = Date.parse(now), elapsed = performance.now() - this.started;
    requireValue(databaseMs >= this.lastDatabase && databaseMs < Date.parse(this.operation.expiresAt)
      && Math.abs(databaseMs - Date.parse(this.dbNow) - elapsed) <= OWNER_RECOVERY_LIMITS.clockDriftMs, 'CLOCK_UNCERTAIN');
    this.lastDatabase = databaseMs;
    freshOperator(evidence.operatorEvidence, this.operation.profile, now);
    requireValue(evidence.operatorEvidence.operator === this.operation.actor, 'OPERATOR_EVIDENCE_INVALID');
    requireValue(databaseMs >= Date.parse(evidence.finalInventory.observedAt) && databaseMs - Date.parse(evidence.finalInventory.observedAt) <= 10_000
      && databaseMs >= Date.parse(evidence.clock.wallCheckedAt) && databaseMs - Date.parse(evidence.clock.wallCheckedAt) <= OWNER_RECOVERY_LIMITS.databaseRoundTripMs,
    'INVENTORY_UNAVAILABLE'); this.assertActive(); return now;
  }
  async dispatch(requestId: string, input: OwnerRecoveryHostEvidence): Promise<string> {
    const evidence = parseOwnerRecoveryHostEvidence(input); this.assertActive();
    requireValue(!this.busy && !this.dispatchId && !this.handshake, 'HANDSHAKE_UNKNOWN'); this.busy = true;
    try {
      const id = await transaction(this.client, async () => {
        await this.fresh(evidence);
        return event(this.client, this.operation, requestId, 'HANDSHAKE_DISPATCH', evidence, ownerRecoveryHash(evidence));
      }, () => this.assertActive());
      this.dispatchId = id; this.reset = evidence; return id;
    } catch (error) { this.cancel(); throw error; } finally { this.busy = false; }
  }
  async handshakeClosed(input: OwnerRecoveryHandshake): Promise<void> {
    const handshake = parseOwnerRecoveryHandshake(input); this.assertActive();
    requireValue(!this.busy && this.dispatchId && !this.handshake && handshake.dispatchEventId === this.dispatchId
      && handshake.accountId === this.operation.profile.accountId && handshake.sessionId === this.observerSessionId, 'CLOSURE_UNKNOWN');
    this.busy = true;
    try {
      await transaction(this.client, async () => {
        await maintenance(this.client, this.operation.operationId);
        await event(this.client, this.operation, randomUUID(), 'HANDSHAKE_CLOSED', handshake, ownerRecoveryHash(handshake));
      }, () => this.assertActive()); this.handshake = handshake;
    } catch (error) { this.cancel(); throw error; } finally { this.busy = false; }
  }
  async finalize(input: Finalize, runtimeGuard: () => Promise<void> = async () => undefined): Promise<{ operation: OwnerRecoveryOperation; receipt: OwnerRecoveryReceipt }> {
    const request = parseOwnerRecoveryRequest(input) as Finalize; this.assertActive();
    requireValue(!this.busy && request.observerSessionId === this.observerSessionId && this.handshake && this.reset
      && request.handshakeDigest === ownerRecoveryHash(this.handshake), 'CLOSURE_UNKNOWN');
    requireValue(same(request.evidence.before, this.reset.before) && same(request.evidence.stopped, this.reset.stopped)
      && same(request.evidence.after, this.reset.after) && same(request.evidence.initialInventory, this.reset.initialInventory)
      && request.evidence.collectorStartedAt === this.reset.collectorStartedAt, 'RESET_UNPROVEN');
    requireValue(Date.parse(request.evidence.current.observedAt) >= Date.parse(this.handshake.closedAt), 'CLOSURE_UNKNOWN');
    this.busy = true;
    try {
      const evidenceDigest = ownerRecoveryHash({ evidence: request.evidence, handshake: this.handshake });
      await runtimeGuard(); this.assertActive();
      await transaction(this.client, async () => {
        await this.fresh(request.evidence);
        await event(this.client, this.operation, request.observedRequestId, 'OBSERVED', { evidence: request.evidence, handshake: this.handshake }, evidenceDigest);
        const observed: OwnerRecoveryOperation = { ...this.operation, state: 'OBSERVED', evidenceDigest };
        await updateOperation(this.client, observed); return observed;
      }, () => this.assertActive()).then(op => { this.operation = op; });
      await runtimeGuard(); this.assertActive();
      return await transaction(this.client, async () => {
        const now = await this.fresh(request.evidence);
        const receipt: OwnerRecoveryReceipt = { version: 1, receiptId: randomUUID(), operationId: this.operation.operationId,
          commitRequestId: request.commitRequestId, owner: this.operation.owner, bindingDigest: this.operation.bindingDigest,
          evidenceDigest, actor: this.operation.actor, committedAt: now, retiredAt: now, retirementState: 'RETIRED', method: 'OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1' };
        const committed: OwnerRecoveryOperation = { ...this.operation, state: 'COMMITTED', receiptId: receipt.receiptId };
        await event(this.client, this.operation, request.commitRequestId, 'COMMITTED', receipt, evidenceDigest);
        await this.client.query(`INSERT INTO accounting_owner_recovery_receipts(receipt_id,operation_id,commit_request_id,endpoint_key,owner_id,generation,committed_at,record)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [receipt.receiptId, receipt.operationId, receipt.commitRequestId, receipt.owner.endpointKey,
          receipt.owner.ownerId, receipt.owner.generation, now, JSON.stringify(receipt)]);
        await updateOperation(this.client, committed);
        const old = this.operation.owner;
        const retired = await this.client.query(`UPDATE accounting_source_owners SET retirement_state='RETIRED',retired_at=$7,updated_at=$7
          WHERE endpoint_key=$1 AND owner_id=$2 AND generation=$3 AND retirement_state=$4 AND acquired_at=$5 AND updated_at=$6`,
        [old.endpointKey, old.ownerId, old.generation, old.retirementState, old.acquiredAt, old.updatedAt, now]);
        requireValue(retired.rowCount === 1, 'OWNER_CHANGED');
        await this.client.query('UPDATE accounting_owner_recovery_maintenance SET pending_operation_id=NULL WHERE singleton');
        await runtimeGuard(); this.assertActive();
        const deadline = await databaseTime(this.client); requireValue(Date.parse(deadline) < Date.parse(this.operation.expiresAt), 'OBSERVATION_EXPIRED');
        this.assertActive(); return { operation: committed, receipt };
      }, () => this.assertActive()).then(result => { this.operation = result.operation; return result; });
    } catch (error) { this.cancel(); throw error; } finally { this.busy = false; }
  }
  release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.cancel(); this.released = true; this.client.removeListener('error', this.cancel); this.client.removeListener('end', this.cancel);
    this.releasing = unlockSession(this.client, this.operation.owner.endpointKey);
    return this.releasing;
  }
}
