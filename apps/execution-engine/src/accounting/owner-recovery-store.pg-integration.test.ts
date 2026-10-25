import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { OWNER_RECOVERY_SERVICES, ownerRecoveryHash, type OwnerRecoveryProfile, type OwnerRecoveryOperatorEvidence,
  type OwnerRecoveryInventory, type OwnerRecoveryHostEvidence, type OwnerRecoveryOperation } from '@ikbr/shared/accounting-owner-recovery';
import { AccountingOwnerRecoveryStore } from './owner-recovery-store.js';
import { AccountingSourceOwner, canonicalAccountingEndpoint, accountingOwnerLockKey } from './source-owner.js';

const url = process.env.TEST_POSTGRES_URL, hash = 'a'.repeat(64), iso = (ms = Date.now()) => new Date(ms).toISOString();
async function fixture(run: (f: { pool: Pool; store: AccountingOwnerRecoveryStore; profile: OwnerRecoveryProfile; endpointKey: string; ownerId: string }) => Promise<void>) {
  const parsed = new URL(url!);
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && (parsed.port === '55438' && parsed.pathname === '/ikbr_owner_recovery_test' || process.env.CI === 'true' && parsed.pathname === '/ikbr_trader_ci'));
  const schema = `owner_recovery_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8, connectionTimeoutMillis: 2000 });
  try {
    await pool.query(`CREATE TABLE accounting_source_owners(endpoint_key text PRIMARY KEY,owner_id uuid NOT NULL,generation bigint NOT NULL,retirement_state text NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),retired_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE TABLE execution_entry_controls(account_id text PRIMARY KEY,paused boolean,revision bigint);
      CREATE TABLE proposed_orders(id bigint,status text,client_order_id text,conid text,execution_account_id text,execution_attempted_at timestamptz);
      CREATE TABLE proposal_ai_reviews(proposed_order_id bigint,account_id text);
      CREATE TABLE lifecycle_supervision(original_proposal_id bigint,status text,terminal_proof jsonb,observed_at timestamptz);
      CREATE TABLE lifecycle_close_operations(original_proposal_id bigint,account_id text,state text);
      CREATE TABLE paper_entry_attempts(account_id text,proposed_order_id bigint);
      CREATE TABLE unrelated_safety_state(record jsonb); INSERT INTO unrelated_safety_state VALUES('{"budget":7,"hold":"CLOCK","qualification":"expired"}');`);
    await pool.query(await readFile(new URL('../../../../infra/sql/migrations/000038_accounting_owner_recovery.sql', import.meta.url), 'utf8'));
    const profile: OwnerRecoveryProfile = { project: 'test', imageId: `sha256:${hash}`, deploymentHash: hash, dockerHost: 'unix:///var/run/docker.sock',
      hostIdHash: hash, settingsHash: hash, accountId: 'DU_TEST', endpoint: { host: '127.0.0.1', port: 50000 + Math.floor(Math.random() * 10000), clientId: 0 } };
    const endpointKey = await canonicalAccountingEndpoint(profile.endpoint), ownerId = randomUUID();
    await pool.query("INSERT INTO accounting_source_owners(endpoint_key,owner_id,generation,retirement_state) VALUES($1,$2,7,'ACTIVE')", [endpointKey, ownerId]);
    await pool.query("INSERT INTO execution_entry_controls VALUES('DU_TEST',true,3)");
    await run({ pool, store: new AccountingOwnerRecoveryStore(pool), profile, endpointKey, ownerId });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}
function inventory(at = iso()): OwnerRecoveryInventory { return { observedAt: at, producers: [], absentServices: [...OWNER_RECOVERY_SERVICES], nativeProcesses: [], unexpectedNativeCandidates: [], unexpectedSocketPids: [] }; }
function operator(profile: OwnerRecoveryProfile, at = iso()): OwnerRecoveryOperatorEvidence { return { version: 1, inspectionId: randomUUID(), accountId: profile.accountId,
  endpoint: profile.endpoint, settingsHash: profile.settingsHash, deploymentHash: profile.deploymentHash, operator: 'tester', observedAt: at, product: 'TWS',
  confirmations: { paperAccount: true, accountPositionsFlat: true, accountOpenOrdersAbsent: true, noPendingManualActions: true, otherClientsStopped: true,
    noChangesUntilRecoveryEnds: true, noOtherNativeOrExternalClients: true, noNativeClientLaunchUntilRecoveryEnds: true },
  artifacts: ['account-environment', 'positions', 'open-orders'].map(kind => ({ kind: kind as 'positions', relativePath: `${kind}.png`, sha256: hash, observedAt: at })) }; }
function prepare(profile: OwnerRecoveryProfile) { return { version: 1 as const, action: 'prepare' as const, requestId: randomUUID(), operationId: randomUUID(),
  actor: 'tester', token: 'x'.repeat(32), profile, operatorEvidence: operator(profile), inventory: inventory() }; }
function evidence(op: OwnerRecoveryOperation, start: number): OwnerRecoveryHostEvidence {
  const t = (n: number) => iso(start + n), current = { pid: 2, startIdentity: t(3), executableHash: hash };
  return { version: 1, operationId: op.operationId, nonce: op.nonce, bindingDigest: op.bindingDigest, profile: op.profile, collectorStartedAt: t(0),
    before: { observedAt: t(1), process: { pid: 1, startIdentity: iso(start - 1000), executableHash: hash } },
    stopped: { observedAt: t(2), processAbsent: true, listenerAbsent: true }, after: { observedAt: t(4), process: current }, current: { observedAt: t(6), process: current },
    initialInventory: inventory(t(0)), finalInventory: inventory(t(7)), dockerEvents: { startedAt: t(0), checkedAt: t(8), continuous: true, noProducerStarts: true },
    clock: { wallStartedAt: t(0), wallCheckedAt: t(9), monotonicElapsedMs: 9, dbSampleAt: t(8), dbRoundTripMs: 0 },
    operatorEvidence: { ...operator(op.profile, t(5)), afterReset: { operationId: op.operationId, nonce: op.nonce, process: current } } };
}

test('exact microsecond owner recovery commits immutable receipt and fences alias/late owner writes', { skip: !url }, () => fixture(async f => {
  const request = prepare(f.profile), op = await f.store.prepare(request, f.endpointKey);
  assert.match(op.owner.updatedAt, /\.\d{6}Z$/);
  await assert.rejects(f.pool.query("UPDATE accounting_source_owners SET retirement_state='UNKNOWN',updated_at=clock_timestamp()"), /MAINTENANCE_PENDING/);
  await assert.rejects(f.pool.query("INSERT INTO accounting_source_owners VALUES('alternate-network-alias',$1,1,'ACTIVE',clock_timestamp(),NULL,clock_timestamp())", [randomUUID()]), /MAINTENANCE_PENDING/);
  const begin = { ...request, action: 'begin-observe' as const, bindingDigest: op.bindingDigest };
  const { operatorEvidence: _proof, inventory: _inventory, ...beginRequest } = begin;
  const observer = await f.store.beginObserve(beginRequest, f.endpointKey);
  try {
    const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 20));
    const proof = evidence(op, start), dispatchEventId = await observer.dispatch(randomUUID(), proof);
    const h = { sessionId: observer.observerSessionId, dispatchEventId, accountId: f.profile.accountId, clientId: 0 as const, serverVersion: 180,
      connectedAt: iso(), readyAt: iso(), closedAt: iso(), socketCloseObserved: true as const };
    await observer.handshakeClosed(h);
    const now = Date.now(); proof.current.observedAt = iso(now); proof.finalInventory.observedAt = iso(now); proof.dockerEvents.checkedAt = iso(now);
    proof.clock.wallCheckedAt = iso(now); proof.clock.monotonicElapsedMs = now - start; proof.clock.dbSampleAt = iso(now);
    const result = await observer.finalize({ version: 1, action: 'finalize-observation', requestId: randomUUID(), observerSessionId: observer.observerSessionId,
      observedRequestId: randomUUID(), commitRequestId: randomUUID(), handshakeDigest: ownerRecoveryHash(h), evidence: proof });
    assert.equal(result.operation.state, 'COMMITTED'); assert.equal(result.receipt.owner.ownerId, f.ownerId);
    await observer.release();
    const state = await f.store.status({ version: 1, action: 'status', requestId: randomUUID(), operationId: op.operationId, actor: 'tester', token: request.token, profile: f.profile,
      lookupRequestId: result.receipt.commitRequestId });
    assert.equal(state.events.length, 5); assert.equal(state.pendingOperationId, null);
    assert.equal(state.receipt?.receiptId, result.receipt.receiptId); assert.equal(state.lookup?.kind, 'COMMITTED'); assert.equal(state.maintenancePending, false);
    await assert.rejects(f.pool.query("UPDATE accounting_source_owners SET retirement_state='UNKNOWN',updated_at=clock_timestamp()"), /RETIRED_OWNER_IMMUTABLE/);
    await assert.rejects(f.pool.query('DELETE FROM accounting_owner_recovery_receipts'), /IMMUTABLE/);
    assert.deepEqual((await f.pool.query('SELECT record FROM unrelated_safety_state')).rows[0].record, { budget: 7, hold: 'CLOCK', qualification: 'expired' });
    const next = new AccountingSourceOwner(f.pool, { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: f.profile.accountId,
      endpoint: f.profile.endpoint, sourceClientId: 0, executionTimeZone: 'UTC' });
    await next.acquire(); assert.equal(next.fence().generation, 8); await next.retire(true); await next.release();
  } finally { await observer.release(); }
}));

test('never-started inventory still requires reset, operator proof and closed handshake before immutable retirement', { skip: !url }, () => fixture(async f => {
  const request = prepare(f.profile);
  request.inventory.producers = OWNER_RECOVERY_SERVICES.map((service, index) => ({ containerId: String(index + 1).repeat(64), imageId: f.profile.imageId,
    project: f.profile.project, service, state: 'created', createdAt: iso(Date.parse(request.inventory.observedAt) - 1000), startedAt: null, finishedAt: null }));
  request.inventory.absentServices = [];
  const op = await f.store.prepare(request, f.endpointKey);
  const observer = await f.store.beginObserve({ version: 1, action: 'begin-observe', requestId: randomUUID(), operationId: op.operationId,
    actor: request.actor, token: request.token, profile: request.profile, bindingDigest: op.bindingDigest }, f.endpointKey);
  try {
    const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 20));
    const proof = evidence(op, start);
    proof.initialInventory.producers = structuredClone(request.inventory.producers); proof.initialInventory.absentServices = [];
    proof.finalInventory.producers = structuredClone(request.inventory.producers); proof.finalInventory.absentServices = [];
    const missingReset = structuredClone(proof); missingReset.stopped.observedAt = missingReset.before.observedAt;
    await assert.rejects(observer.dispatch(randomUUID(), missingReset));
    const missingOperator = structuredClone(proof); delete missingOperator.operatorEvidence.afterReset;
    await assert.rejects(observer.dispatch(randomUUID(), missingOperator));
    const commit = { version: 1 as const, action: 'finalize-observation' as const, requestId: randomUUID(), observerSessionId: observer.observerSessionId,
      observedRequestId: randomUUID(), commitRequestId: randomUUID(), handshakeDigest: hash, evidence: proof };
    await assert.rejects(observer.finalize(commit), /CLOSURE_UNKNOWN/);
    assert.equal((await f.pool.query('SELECT retirement_state FROM accounting_source_owners')).rows[0].retirement_state, 'ACTIVE');
    assert.equal((await f.pool.query('SELECT count(*) AS n FROM accounting_owner_recovery_receipts')).rows[0].n, '0');
    const dispatchEventId = await observer.dispatch(randomUUID(), proof), now = iso();
    await assert.rejects(observer.finalize(commit), /CLOSURE_UNKNOWN/);
    const handshake = { sessionId: observer.observerSessionId, dispatchEventId, accountId: f.profile.accountId, clientId: 0 as const,
      serverVersion: 180, connectedAt: now, readyAt: now, closedAt: now, socketCloseObserved: true as const };
    await observer.handshakeClosed(handshake);
    const end = Date.now(); proof.current.observedAt = iso(end); proof.finalInventory.observedAt = iso(end); proof.dockerEvents.checkedAt = iso(end);
    proof.clock.wallCheckedAt = iso(end); proof.clock.monotonicElapsedMs = end - start; proof.clock.dbSampleAt = iso(end);
    const result = await observer.finalize({ ...commit, handshakeDigest: ownerRecoveryHash(handshake) });
    assert.equal(result.operation.state, 'COMMITTED'); assert.equal(result.receipt.owner.ownerId, f.ownerId);
    await observer.release();
    const status = await f.store.status({ version: 1, action: 'status', requestId: randomUUID(), operationId: op.operationId,
      actor: request.actor, token: request.token, profile: request.profile, lookupRequestId: commit.commitRequestId });
    assert.deepEqual(status.events.map(event => event.kind), ['PREPARED', 'HANDSHAKE_DISPATCH', 'HANDSHAKE_CLOSED', 'OBSERVED', 'COMMITTED']);
    assert.equal(status.lookup?.kind, 'COMMITTED'); assert.equal(status.receipt?.receiptId, result.receipt.receiptId);
    assert.deepEqual((await f.pool.query('SELECT record FROM unrelated_safety_state')).rows[0].record, { budget: 7, hold: 'CLOCK', qualification: 'expired' });
    assert.deepEqual((await f.pool.query('SELECT paused, revision FROM execution_entry_controls')).rows[0], { paused: true, revision: '3' });
  } finally { await observer.release(); }
}));

test('supersession preserves hold, binds replacement and does not reset owner', { skip: !url }, () => fixture(async f => {
  const first = await f.store.prepare(prepare(f.profile), f.endpointKey), request = { ...prepare(f.profile), action: 'supersede' as const,
    operationId: first.operationId, replacementOperationId: randomUUID() };
  const next = await f.store.supersede(request, f.endpointKey);
  assert.equal(next.owner.ownerId, first.owner.ownerId);
  assert.equal((await f.pool.query('SELECT pending_operation_id FROM accounting_owner_recovery_maintenance')).rows[0].pending_operation_id, next.operationId);
  assert.equal((await f.pool.query('SELECT retirement_state FROM accounting_source_owners')).rows[0].retirement_state, 'ACTIVE');
  await assert.rejects(f.store.supersede(request, f.endpointKey), /MAINTENANCE_PENDING/);
  await assert.rejects(f.pool.query("UPDATE accounting_owner_recovery_maintenance SET pending_operation_id=NULL"), /MAINTENANCE_INVALID/);
}));

test('prepare rejects bot history, reservations and second durable owner', { skip: !url }, () => fixture(async f => {
  await f.pool.query("INSERT INTO proposed_orders(id,status,execution_attempted_at) VALUES(1,'EXECUTED',clock_timestamp())");
  await assert.rejects(f.store.prepare(prepare(f.profile), f.endpointKey), /BOT_HISTORY_UNSUPPORTED/);
  await f.pool.query('DELETE FROM proposed_orders');
  await f.pool.query("INSERT INTO lifecycle_close_operations VALUES(1,'DU_TEST','BLOCKED')");
  await assert.rejects(f.store.prepare(prepare(f.profile), f.endpointKey), /UNRESOLVED_LOCAL_OPERATION/);
  await f.pool.query('DELETE FROM lifecycle_close_operations');
  await f.pool.query("INSERT INTO accounting_source_owners VALUES('alias',$1,1,'UNKNOWN',clock_timestamp(),NULL,clock_timestamp())", [randomUUID()]);
  await assert.rejects(f.store.prepare(prepare(f.profile), f.endpointKey), /OWNER_CHANGED/);
}));

test('raw SQL cannot fabricate malformed operation or mismatched events', { skip: !url }, () => fixture(async f => {
  await assert.rejects(f.pool.query(`INSERT INTO accounting_owner_recovery_operations VALUES($1,$2,$3,7,$4,'PREPARED',$5,now(),now()+interval '15 minutes','{}')`,
    [randomUUID(), f.endpointKey, f.ownerId, randomUUID(), hash]), /check constraint/);
  const op = await f.store.prepare(prepare(f.profile), f.endpointKey);
  await assert.rejects(f.pool.query(`INSERT INTO accounting_owner_recovery_events VALUES($1,$2,$3,'HANDSHAKE_DISPATCH',clock_timestamp(),'impostor',$4,NULL,'{}')`,
    [randomUUID(), randomUUID(), op.operationId, hash]), /EVENT_MISMATCH/);
  await assert.rejects(f.pool.query('TRUNCATE accounting_owner_recovery_maintenance'), /IMMUTABLE/);
}));

test('two prepares have at most one winner and ordinary alias acquisition sees global maintenance', { skip: !url }, () => fixture(async f => {
  const results = await Promise.allSettled([f.store.prepare(prepare(f.profile), f.endpointKey), f.store.prepare(prepare(f.profile), f.endpointKey)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.pool.query('SELECT count(*) AS n FROM accounting_owner_recovery_operations')).rows[0].n, '1');
  const alias = new AccountingSourceOwner(f.pool, { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: f.profile.accountId,
    endpoint: { host: '127.0.0.1', port: f.profile.endpoint.port + 1 }, sourceClientId: 0, executionTimeZone: 'UTC' });
  await assert.rejects(alias.acquire(), /MAINTENANCE_PENDING/); await alias.release();
}));

test('cancel before commit preserves durable OBSERVED and blocks observation replay', { skip: !url }, () => fixture(async f => {
  const request = prepare(f.profile), op = await f.store.prepare(request, f.endpointKey);
  const observer = await f.store.beginObserve({ version: 1, action: 'begin-observe', requestId: randomUUID(), operationId: op.operationId,
    actor: request.actor, token: request.token, profile: request.profile, bindingDigest: op.bindingDigest }, f.endpointKey);
  try {
    const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 20));
    const proof = evidence(op, start), dispatchEventId = await observer.dispatch(randomUUID(), proof), now = iso();
    const h = { sessionId: observer.observerSessionId, dispatchEventId, accountId: f.profile.accountId, clientId: 0 as const,
      serverVersion: 180, connectedAt: now, readyAt: now, closedAt: now, socketCloseObserved: true as const };
    await observer.handshakeClosed(h);
    const end = Date.now(); proof.current.observedAt = iso(end); proof.finalInventory.observedAt = iso(end); proof.dockerEvents.checkedAt = iso(end);
    proof.clock.wallCheckedAt = iso(end); proof.clock.monotonicElapsedMs = end - start; proof.clock.dbSampleAt = iso(end);
    let guards = 0;
    await assert.rejects(observer.finalize({ version: 1, action: 'finalize-observation', requestId: randomUUID(), observerSessionId: observer.observerSessionId,
      observedRequestId: randomUUID(), commitRequestId: randomUUID(), handshakeDigest: ownerRecoveryHash(h), evidence: proof }, async () => { if (++guards === 2) observer.cancel(); }), /OBSERVATION_EXPIRED/);
    assert.equal((await f.pool.query('SELECT state FROM accounting_owner_recovery_operations')).rows[0].state, 'OBSERVED');
    assert.equal((await f.pool.query('SELECT retirement_state FROM accounting_source_owners')).rows[0].retirement_state, 'ACTIVE');
    assert.equal((await f.pool.query('SELECT count(*) AS n FROM accounting_owner_recovery_receipts')).rows[0].n, '0');
    await observer.release();
    await assert.rejects(f.store.beginObserve({ version: 1, action: 'begin-observe', requestId: randomUUID(), operationId: op.operationId,
      actor: request.actor, token: request.token, profile: request.profile, bindingDigest: op.bindingDigest }, f.endpointKey), /OWNER_CHANGED/);
  } finally { await observer.release(); }
}));

test('competing advisory transport and an earlier alias owner both block prepare', { skip: !url }, () => fixture(async f => {
  const competing = await f.pool.connect();
  try {
    await competing.query('SELECT pg_advisory_lock($1::bigint)', [accountingOwnerLockKey(f.endpointKey)]);
    await assert.rejects(f.store.prepare(prepare(f.profile), f.endpointKey), /OWNER_CONFLICT/);
  } finally { await competing.query('SELECT pg_advisory_unlock($1::bigint)', [accountingOwnerLockKey(f.endpointKey)]); competing.release(); }
  const alias = new AccountingSourceOwner(f.pool, { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: f.profile.accountId,
    endpoint: { host: '127.0.0.1', port: f.profile.endpoint.port + 1 }, sourceClientId: 0, executionTimeZone: 'UTC' });
  try { await alias.acquire(); await assert.rejects(f.store.prepare(prepare(f.profile), f.endpointKey), /OWNER_CHANGED/); await alias.retire(true); }
  finally { await alias.release(); }
  assert.equal((await f.pool.query('SELECT count(*) AS n FROM accounting_owner_recovery_operations')).rows[0].n, '0');
}));

test('changed pause revision denies observe and immutable owner guard denies CAS drift', { skip: !url }, () => fixture(async f => {
  const request = prepare(f.profile), op = await f.store.prepare(request, f.endpointKey);
  await f.pool.query('UPDATE execution_entry_controls SET revision=revision+1');
  await assert.rejects(f.store.beginObserve({ version: 1, action: 'begin-observe', requestId: randomUUID(), operationId: op.operationId,
    actor: request.actor, token: request.token, profile: f.profile, bindingDigest: op.bindingDigest }, f.endpointKey), /PAUSE_CHANGED/);
  await assert.rejects(f.pool.query('UPDATE accounting_source_owners SET generation=generation+1'), /MAINTENANCE_PENDING/);
  await assert.rejects(f.pool.query('DELETE FROM accounting_source_owners'), /IMMUTABLE/);
  assert.equal((await f.pool.query('SELECT pending_operation_id FROM accounting_owner_recovery_maintenance')).rows[0].pending_operation_id, op.operationId);
}));

test('expired prepared operation still holds maintenance until explicit supersession', { skip: !url }, () => fixture(async f => {
  const ownerRow = (await f.pool.query(`SELECT to_char(acquired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acquired,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated FROM accounting_source_owners`)).rows[0];
  const op: OwnerRecoveryOperation = { version: 1, operationId: randomUUID(), nonce: randomUUID(), state: 'PREPARED',
    owner: { endpointKey: f.endpointKey, ownerId: f.ownerId, generation: 7, retirementState: 'ACTIVE', acquiredAt: ownerRow.acquired, updatedAt: ownerRow.updated },
    profile: f.profile, pauseRevision: 3, actor: 'tester', preparedAt: iso(Date.now() - 901000), expiresAt: iso(Date.now() - 1000),
    bindingDigest: hash, evidenceDigest: null, successorOperationId: null, receiptId: null };
  op.expiresAt = iso(Date.parse(op.preparedAt) + 900000);
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO accounting_owner_recovery_operations VALUES($1,$2,$3,7,$4,'PREPARED',$5,$6,$7,$8::jsonb)`,
      [op.operationId, f.endpointKey, f.ownerId, op.nonce, hash, op.preparedAt, op.expiresAt, JSON.stringify(op)]);
    await client.query(`INSERT INTO accounting_owner_recovery_events VALUES($1,$2,$3,'PREPARED',clock_timestamp(),'tester',$4,NULL,'{}')`, [randomUUID(), randomUUID(), op.operationId, hash]);
    await client.query('UPDATE accounting_owner_recovery_maintenance SET pending_operation_id=$1', [op.operationId]); await client.query('COMMIT');
  } finally { client.release(); }
  await assert.rejects(f.store.beginObserve({ version: 1, action: 'begin-observe', requestId: randomUUID(), operationId: op.operationId,
    actor: 'tester', token: 'x'.repeat(32), profile: f.profile, bindingDigest: hash }, f.endpointKey), /OBSERVATION_EXPIRED/);
  const status = await f.store.status({ version: 1, action: 'status', requestId: randomUUID(), operationId: op.operationId, actor: 'tester', token: 'x'.repeat(32), profile: f.profile });
  assert.equal(status.maintenancePending, true); assert.equal(status.pendingOperationId, op.operationId); assert.equal(status.events[0].kind, 'PREPARED');
  const successor = await f.store.supersede({ ...prepare(f.profile), action: 'supersede', operationId: op.operationId, replacementOperationId: randomUUID() }, f.endpointKey);
  assert.notEqual(successor.operationId, op.operationId);
}));

test('lost commit acknowledgement is resolved by exact receipt and event readback without retry', { skip: !url }, () => fixture(async f => {
  const request = prepare(f.profile), op = await f.store.prepare(request, f.endpointKey);
  const observer = await f.store.beginObserve({ version: 1, action: 'begin-observe', requestId: randomUUID(), operationId: op.operationId,
    actor: request.actor, token: request.token, profile: request.profile, bindingDigest: op.bindingDigest }, f.endpointKey);
  try {
    const start = Date.now(); await new Promise(resolve => setTimeout(resolve, 20));
    const proof = evidence(op, start), dispatchEventId = await observer.dispatch(randomUUID(), proof), now = iso();
    const h = { sessionId: observer.observerSessionId, dispatchEventId, accountId: f.profile.accountId, clientId: 0 as const,
      serverVersion: 180, connectedAt: now, readyAt: now, closedAt: now, socketCloseObserved: true as const };
    await observer.handshakeClosed(h);
    const end = Date.now(); proof.current.observedAt = iso(end); proof.finalInventory.observedAt = iso(end); proof.dockerEvents.checkedAt = iso(end);
    proof.clock.wallCheckedAt = iso(end); proof.clock.monotonicElapsedMs = end - start; proof.clock.dbSampleAt = iso(end);
    const finalRequest = { version: 1 as const, action: 'finalize-observation' as const, requestId: randomUUID(), observerSessionId: observer.observerSessionId,
      observedRequestId: randomUUID(), commitRequestId: randomUUID(), handshakeDigest: ownerRecoveryHash(h), evidence: proof };
    const client = (observer as unknown as { client: PoolClient }).client, query = client.query.bind(client);
    let commits = 0;
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      const result = (query as (...a: unknown[]) => Promise<unknown>)(...args);
      if (args[0] === 'COMMIT' && ++commits === 2) return result.then(() => { throw new Error('synthetic lost commit acknowledgement'); });
      return result;
    }) as PoolClient['query'];
    await assert.rejects(observer.finalize(finalRequest), /lost commit acknowledgement/);
    await observer.release();
    const status = await f.store.status({ version: 1, action: 'status', requestId: randomUUID(), operationId: op.operationId,
      actor: request.actor, token: request.token, profile: f.profile, lookupRequestId: finalRequest.commitRequestId });
    assert.equal(status.operation?.state, 'COMMITTED'); assert.equal(status.lookup?.kind, 'COMMITTED'); assert.equal(status.receipt?.commitRequestId, finalRequest.commitRequestId);
    await assert.rejects(observer.finalize(finalRequest), /OBSERVATION_EXPIRED/);
    assert.equal((await f.pool.query('SELECT count(*) AS n FROM accounting_owner_recovery_receipts')).rows[0].n, '1');
    await assert.rejects(f.pool.query('UPDATE accounting_owner_recovery_receipts SET record=record || \'{"actor":"tampered"}\''), /IMMUTABLE/);
  } finally { await observer.release(); }
}));
