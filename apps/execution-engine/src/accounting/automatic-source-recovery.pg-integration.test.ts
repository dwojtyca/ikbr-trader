import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { ownerRecoveryHash, parseOwnerRecoveryOperation } from '@ikbr/shared/accounting-owner-recovery';
import { runMigrations } from '../migrations.js';
import { AccountingSourceOwner, accountingOwnerLockKey, resolveAccountingEndpoint } from './source-owner.js';
import { AccountingSourceStore } from './source-store.js';
import { accountingHash, type SourceSettingsV1 } from './types.js';

const url = process.env.TEST_POSTGRES_URL;
const settings: SourceSettingsV1 = { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: 'DU_AUTO_TEST',
  endpoint: { host: '127.0.0.1', port: 45671 }, sourceClientId: 0, executionTimeZone: 'UTC' };
test('automatic source takeover preserves immutable history and fences old generations', { skip: !url }, async t => {
  const base = new URL(url!);
  assert.ok(['localhost','127.0.0.1'].includes(base.hostname) && (base.pathname === '/ikbr_owner_recovery_test' || process.env.CI === 'true'));
  const database = `auto_source_${randomUUID().replaceAll('-','')}`;
  const admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE ${database}`);
  base.pathname = `/${database}`;
  const pool = new Pool({ connectionString: base.href, max: 8, connectionTimeoutMillis: 2000 });
  const endpointKey = (await resolveAccountingEndpoint(settings.endpoint)).key;
  const lockKey = BigInt.asUintN(64, BigInt(accountingOwnerLockKey(endpointKey)));
  async function releaseOwner(owner: AccountingSourceOwner): Promise<void> {
    await owner.release();
    const deadline = performance.now() + 3000;
    let held = true;
    while (held && performance.now() < deadline) {
      held = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=$1::oid AND objid=$2::oid AND objsubid=1) AS held", [(lockKey >> 32n).toString(), (lockKey & 0xffffffffn).toString()])).rows[0].held;
    }
    assert.equal(held, false, 'predecessor advisory lock must disappear before the next acquisition');
  }
  const owners: AccountingSourceOwner[] = [];
  const hash = 'a'.repeat(64), sourceId = accountingHash({ account: settings.accountId, kind: 'tws-accounting' });
  function create(session = randomUUID()) {
    const owner = new AccountingSourceOwner(pool,settings,undefined,{processSessionId:session,settingsHash:hash,sourceId}); owners.push(owner);
    return owner;
  }
  try {
    await runMigrations(pool);
    await t.test('hard loss replaces ACTIVE without claiming physical retirement and rejects predecessor writes', async () => {
      const first = create(); await first.acquire(); const old = first.fence();
      const store = new AccountingSourceStore(pool,sourceId,old.ownerId); store.owner=first; await store.begin(settings.accountId,hash);
      await store.gap(1,'ACCOUNTING_CLOCK_INVALID');
      await releaseOwner(first);
      const second = create(); await second.acquire(); assert.equal(second.fence().generation,2);
      await assert.rejects(first.retire(true), /OWNER_LOST/);
      await assert.rejects(store.gap(1), /OWNER_LOST/);
      const receipts = (await pool.query('SELECT * FROM accounting_source_handovers ORDER BY generation')).rows;
      assert.equal(receipts.length,2); assert.equal(receipts[1].predecessor.retirementState,'ACTIVE');
      assert.equal(receipts[1].reason,'READ_SOURCE_FENCED');
      await assert.rejects(pool.query('DELETE FROM accounting_source_handovers'), /IMMUTABLE/);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM broker_accounting_observations')).rows[0].n,1);
      await releaseOwner(second);
    });
    await t.test('resolved acquisition identity does not increment its committed generation twice', async () => {
      const identity = randomUUID(), first = create(identity); await first.acquire(); const fence=first.fence(); await releaseOwner(first);
      const retry=create(identity); await retry.acquire(); assert.deepEqual(retry.fence(),fence); await releaseOwner(retry);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM accounting_source_handovers WHERE owner_id=$1',[identity])).rows[0].n,1);
    });
    await t.test('a lost COMMIT response resolves the exact receipt without a duplicate handover', async () => {
      let lost=false;
      const uncertain=new Proxy(pool,{get(target,property){
        if(property==='connect') return async()=>{const client=await pool.connect(),query=client.query.bind(client);
          client.query=(async (...args: unknown[])=>{const result=await (query as (...args: unknown[])=>Promise<unknown>)(...args);
            if(args[0]==='COMMIT'&&!lost){lost=true;throw Error('fixture commit acknowledgement lost');}return result;}) as PoolClient['query'];return client;};
        return Reflect.get(target,property);
      }});
      const identity=randomUUID(), first=new AccountingSourceOwner(uncertain,settings,undefined,{processSessionId:identity,settingsHash:hash,sourceId}); owners.push(first);
      await assert.rejects(first.acquire(), /acknowledgement lost/); assert.equal(lost,true); await releaseOwner(first);
      const retry=create(identity); await retry.acquire();
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM accounting_source_handovers WHERE owner_id=$1',[identity])).rows[0].n,1);
      await releaseOwner(retry);
    });
    await t.test('historical unknown COMMIT followed by another successor is definitively inactive', async () => {
      let lost = false;
      const uncertain = new Proxy(pool, { get(target, property) {
        if (property === 'connect') return async () => {
          const client = await pool.connect(), query = client.query.bind(client);
          client.query = (async (...args: unknown[]) => {
            const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
            if (args[0] === 'COMMIT' && !lost) { lost = true; throw Error('fixture unknown COMMIT'); }
            return result;
          }) as PoolClient['query']; return client;
        }; return Reflect.get(target, property);
      } });
      const identity = randomUUID(), first = new AccountingSourceOwner(uncertain, settings, undefined, { processSessionId: identity, settingsHash: hash, sourceId });
      owners.push(first); await assert.rejects(first.acquire(), /unknown COMMIT/); await releaseOwner(first);
      const intervening = create(); await intervening.acquire(); await releaseOwner(intervening);
      const inactive = create(identity); await assert.rejects(inactive.acquire(), /ACQUISITION_RESOLVED_INACTIVE/); await releaseOwner(inactive);
      const successor = create(); await successor.acquire(); await releaseOwner(successor);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM accounting_source_handovers WHERE owner_id=$1', [identity])).rows[0].n, 1);
    });
    await t.test('retired and unknown committed acquisitions require a fresh identity', async () => {
      for (const clean of [true, false]) {
        const identity = randomUUID(), first = create(identity); await first.acquire();
        if (clean) await first.retire(true); else await assert.rejects(first.retire(false), /RETIREMENT_UNKNOWN/); await releaseOwner(first);
        const inactive = create(identity); await assert.rejects(inactive.acquire(), /ACQUISITION_RESOLVED_INACTIVE/); await releaseOwner(inactive);
        const next = create(); await next.acquire(); await releaseOwner(next);
      }
    });
    await t.test('continuous clock recovery preserves old unknown attempts and has no three-attempt ceremony', async () => {
      const owner=create(); await owner.acquire(); const store=new AccountingSourceStore(pool,sourceId,owner.fence().ownerId);store.owner=owner;
      await store.begin(settings.accountId,hash);
      await pool.query("UPDATE broker_accounting_clock_episodes SET state='OUTCOME_UNKNOWN',attempt_count=7,next_attempt_at=NULL");
      const old=(await pool.query('SELECT * FROM broker_accounting_clock_episodes')).rows[0];
      await store.recovery.initialize(true);
      const active=await store.recovery.active(); assert.equal(active?.state,'BACKOFF');assert.equal(active?.attempt_count,7);
      assert.equal((await pool.query('SELECT predecessor FROM accounting_clock_read_dispositions')).rows[0].predecessor.state,'OUTCOME_UNKNOWN');
      assert.equal((await pool.query('SELECT predecessor FROM accounting_clock_read_dispositions')).rows[0].predecessor.owner_session_id,old.owner_session_id);
      await pool.query("UPDATE broker_accounting_clock_episodes SET next_attempt_at=clock_timestamp()-interval '1 second'");
      const reservation=await store.recovery.claim(settings.accountId,hash,true); assert.ok(reservation);
      await store.recovery.fail(reservation,'ACCOUNTING_CLOCK_INVALID',true);
      assert.equal((await store.recovery.active())?.state,'BACKOFF');assert.equal((await store.recovery.active())?.attempt_count,8);
      await releaseOwner(owner);
    });
    await t.test('generation replacement preserves long backoff, lease and six-per-hour pacing', async () => {
      for (const seconds of [120, 300, 3600]) {
        const priorState = seconds === 300 ? 'VERIFYING' : 'BACKOFF';
        await pool.query("UPDATE broker_accounting_clock_episodes SET state=$2,next_attempt_at=clock_timestamp()+($1::int * interval '1 second')", [seconds, priorState]);
        const before = (await pool.query('SELECT next_attempt_at FROM broker_accounting_clock_episodes')).rows[0].next_attempt_at;
        const owner = create(); await owner.acquire(); const store = new AccountingSourceStore(pool, sourceId, owner.fence().ownerId); store.owner = owner;
        await store.begin(settings.accountId, hash); await store.recovery.initialize(true);
        assert.ok((await store.recovery.active())!.next_attempt_at!.getTime() >= before.getTime());
        const disposition = (await pool.query('SELECT predecessor FROM accounting_clock_read_dispositions WHERE successor_session_id=$1', [owner.fence().ownerId])).rows[0].predecessor;
        assert.equal(disposition.state, priorState); assert.equal(disposition.next_attempt_at, before.toISOString());
        assert.equal(await store.recovery.claim(settings.accountId, hash, true), null);
        assert.equal((await store.recovery.active())!.attempt_count, 8); await releaseOwner(owner);
      }
      await pool.query("UPDATE broker_accounting_clock_episodes SET state='RECOVERING',next_attempt_at=NULL,lease_expires_at=clock_timestamp()+interval '2 minutes'");
      const lease = (await pool.query('SELECT lease_expires_at FROM broker_accounting_clock_episodes')).rows[0].lease_expires_at;
      const owner = create(); await owner.acquire(); const store = new AccountingSourceStore(pool, sourceId, owner.fence().ownerId); store.owner = owner;
      await store.begin(settings.accountId, hash); await store.recovery.initialize(true);
      assert.ok((await store.recovery.active())!.next_attempt_at!.getTime() >= lease.getTime());
      for (let i = 0; i < 5; i++) {
        await pool.query("UPDATE broker_accounting_clock_episodes SET next_attempt_at=clock_timestamp()-interval '1 second'");
        const r = await store.recovery.claim(settings.accountId, hash, true); assert.ok(r); await store.recovery.fail(r, 'ACCOUNTING_CLOCK_INVALID', true);
      }
      await pool.query("UPDATE broker_accounting_clock_episodes SET next_attempt_at=clock_timestamp()-interval '1 second'");
      assert.equal(await store.recovery.claim(settings.accountId, hash, true), null);
      const capped = (await store.recovery.active())!; assert.equal(capped.last_error, 'ACCOUNTING_CLOCK_RECOVERY_RATE_LIMIT');
      assert.equal(capped.attempt_count, 13); assert.ok(capped.next_attempt_at!.getTime() > Date.now()+3500000);
      await releaseOwner(owner);
      const replacement = create(); await replacement.acquire(); const next = new AccountingSourceStore(pool, sourceId, replacement.fence().ownerId); next.owner = replacement;
      await next.begin(settings.accountId, hash); await next.recovery.initialize(true);
      assert.ok((await next.recovery.active())!.next_attempt_at!.getTime() >= capped.next_attempt_at!.getTime());
      assert.equal(await next.recovery.claim(settings.accountId, hash, true), null); await releaseOwner(replacement);
    });
    await t.test('source transactions finish before generation replacement', async () => {
      const first=create(); await first.acquire(); const db=await pool.connect();
      await db.query('BEGIN'); await first.assertInTransaction(db); await releaseOwner(first);
      const second=create(); const acquiring=second.acquire(); let done=false; void acquiring.then(()=>{done=true;});
      await new Promise(resolve=>setTimeout(resolve,50)); assert.equal(done,false);
      await db.query('COMMIT'); db.release(); await acquiring; assert.equal(done,true); await releaseOwner(second);
    });
    await t.test('legacy expired maintenance is superseded with its old hash while installed settings change', async () => {
      await pool.query("UPDATE accounting_source_owners SET process_session_id=NULL,settings_hash=NULL,account_id=NULL");
      const previous=(await pool.query(`SELECT *,to_char(acquired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS acquired,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated FROM accounting_source_owners`)).rows[0];
      const operationId=randomUUID(), preparedAt=new Date(Date.now()-3600000).toISOString();
      const profile={project:'fixture',imageId:`sha256:${hash}`,deploymentHash:hash,dockerHost:'unix:///var/run/docker.sock',hostIdHash:hash,
        settingsHash:hash,accountId:settings.accountId,endpoint:{...settings.endpoint,clientId:0}};
      const binding={version:1 as const,operationId,nonce:randomUUID(),owner:{endpointKey:previous.endpoint_key,ownerId:previous.owner_id,generation:Number(previous.generation),
        retirementState:'ACTIVE' as const,acquiredAt:previous.acquired,updatedAt:previous.updated},profile,pauseRevision:1,actor:'fixture',preparedAt,
        expiresAt:new Date(Date.parse(preparedAt)+900000).toISOString()};
      const record={...binding,bindingDigest:ownerRecoveryHash(binding),state:'PREPARED',evidenceDigest:null,successorOperationId:null,receiptId:null};
      parseOwnerRecoveryOperation(record);
      const db=await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query(`INSERT INTO accounting_owner_recovery_operations(operation_id,endpoint_key,owner_id,generation,nonce,state,binding_digest,prepared_at,expires_at,record)
          VALUES($1,$2,$3,$4,$5,'PREPARED',$6,$7,$8,$9::jsonb)`,[operationId,previous.endpoint_key,previous.owner_id,previous.generation,binding.nonce,record.bindingDigest,preparedAt,binding.expiresAt,JSON.stringify(record)]);
        await db.query(`INSERT INTO accounting_owner_recovery_events(event_id,request_id,operation_id,kind,actor,binding_digest,evidence)
          VALUES($1,$1,$2,'PREPARED','fixture',$3,'{}')`,[randomUUID(),operationId,record.bindingDigest]);
        await db.query('UPDATE accounting_owner_recovery_maintenance SET pending_operation_id=$1 WHERE singleton',[operationId]);
        await db.query('COMMIT');
      } finally {db.release();}
      const session=randomUUID(), successor=new AccountingSourceOwner(pool,settings,undefined,{processSessionId:session,settingsHash:'b'.repeat(64),sourceId}); owners.push(successor);
      await successor.acquire();
      const disposition=(await pool.query('SELECT * FROM accounting_read_recovery_dispositions WHERE operation_id=$1',[operationId])).rows[0];
      assert.deepEqual(disposition.predecessor_record,record);
      const after=(await pool.query('SELECT record FROM accounting_owner_recovery_operations WHERE operation_id=$1',[operationId])).rows[0].record;
      assert.deepEqual(after,{...record,state:'AUTO_SUPERSEDED'}); parseOwnerRecoveryOperation(after);
      assert.equal((await pool.query('SELECT pending_operation_id FROM accounting_owner_recovery_maintenance')).rows[0].pending_operation_id,null);
      const source=(await pool.query('SELECT * FROM broker_accounting_sources WHERE source_id=$1',[sourceId])).rows[0];
      assert.equal(source.settings_hash,'b'.repeat(64)); assert.equal(source.qualification_id,null); assert.equal(source.gap,true);
      assert.equal(source.process_session_id,session);
      await assert.rejects(pool.query("UPDATE accounting_owner_recovery_operations SET state='OBSERVED' WHERE operation_id=$1",[operationId]), /TRANSITION_INVALID/);
      await releaseOwner(successor);
    });
    await t.test('foreign settings cannot be relabelled by a new owner', async () => {
      const foreign=new AccountingSourceOwner(pool,{...settings,accountId:'DU_FOREIGN'},undefined,{processSessionId:randomUUID(),settingsHash:hash,sourceId}); owners.push(foreign);
      await assert.rejects(foreign.acquire(), /SETTINGS_MISMATCH/);
    });
  } finally {
    for (const owner of owners) await owner.release().catch(()=>undefined);
    await pool.end(); await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end();
  }
});
