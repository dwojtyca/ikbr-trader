import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { executeAccountingRecovery, readAccountingOperatorEvidence, readAccountingPrivateFile, runAccountingOwnerRecoveryCli,
  type AccountingRecoveryDependencies, type AccountingRecoverySaved } from './accounting-owner-recovery-cli.js';
import { ownerRecoveryHash, OWNER_RECOVERY_SERVICES, type OwnerRecoveryProfile, type OwnerRecoveryInventory,
  type OwnerRecoveryOperation, type OwnerRecoveryRequest, type OwnerRecoveryReceipt, type OwnerRecoveryOperatorEvidence } from '@ikbr/shared/accounting-owner-recovery';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, hash = 'a'.repeat(64);
const start = Date.parse('2026-10-19T12:00:00.000Z'), iso = (n = 0) => new Date(start + n).toISOString();
const profile: OwnerRecoveryProfile = { project: 'fixture', imageId: `sha256:${hash}`, deploymentHash: hash, dockerHost: 'unix:///var/run/docker.sock', hostIdHash: hash, settingsHash: hash, accountId: 'DU_TEST', endpoint: { host: 'host.docker.internal', port: 7497, clientId: 0 } };
const operator = (): OwnerRecoveryOperatorEvidence => ({ version: 1, inspectionId: id(1), accountId: profile.accountId, endpoint: profile.endpoint, settingsHash: hash, deploymentHash: hash, operator: 'tester', observedAt: iso(), product: 'TWS', confirmations: { paperAccount: true, accountPositionsFlat: true, accountOpenOrdersAbsent: true, noPendingManualActions: true, otherClientsStopped: true, noChangesUntilRecoveryEnds: true, noOtherNativeOrExternalClients: true, noNativeClientLaunchUntilRecoveryEnds: true }, artifacts: ['account-environment', 'positions', 'open-orders'].map(kind => ({ kind: kind as 'positions', relativePath: `${kind}.txt`, sha256: hash, observedAt: iso() })) });
function fixture() {
  let handshakeResult: unknown;
  let now = start, receipt: OwnerRecoveryReceipt | null = null, lostFinalize = false, drift = false, changed = false;
  const records: AccountingRecoverySaved[] = [], requests: OwnerRecoveryRequest[] = [];
  const operation: OwnerRecoveryOperation = { version: 1, operationId: id(2), nonce: id(3), state: 'PREPARED', owner: { endpointKey: 'key', ownerId: id(4), generation: 1, retirementState: 'UNKNOWN', acquiredAt: iso(-10000), updatedAt: iso(-10000) }, profile, pauseRevision: 1, actor: 'tester', preparedAt: iso(-1000), expiresAt: iso(899000), bindingDigest: hash, evidenceDigest: null, successorOperationId: null, receiptId: null };
  const inventory = (): OwnerRecoveryInventory => ({ observedAt: new Date(now).toISOString(), producers: [], absentServices: [...OWNER_RECOVERY_SERVICES], nativeProcesses: [], unexpectedNativeCandidates: [], unexpectedSocketPids: [] });
  const newer = { pid: 202, startIdentity: iso(2000), executableHash: hash };
  const evidence = () => ({ ...operator(), observedAt: iso(4000), artifacts: operator().artifacts.map(a => ({ ...a, observedAt: iso(4000) })), afterReset: { operationId: id(2), nonce: id(3), process: newer } });
  const host = { captureProducerInventory: async () => inventory(), verifyProducerInventory: async () => inventory(), clearOneShot: () => undefined,
    captureGatewayProcess: async () => { now = start + 100; return { observedAt: iso(100), process: { pid: 101, startIdentity: iso(-10000), executableHash: hash } }; },
    assertGatewayStopped: async () => { now = start + 1000; return { observedAt: iso(1000), processAbsent: true, listenerAbsent: true }; },
    verifyGatewayReplacement: async () => { now = Math.max(now + 10, start + 3000); return { observedAt: new Date(now).toISOString(), process: newer }; },
  } as unknown as ReturnType<AccountingRecoveryDependencies['host']>;
  const deps: AccountingRecoveryDependencies = { actor: 'tester', token: 'x'.repeat(32), profile: async () => ({ wire: { ...profile, deploymentHash: changed ? 'b'.repeat(64) : hash }, root: '/repo', compose: [] }), host: () => host,
    evidence: async () => { now = Math.max(now, start + 4000); return evidence(); }, save: async r => { records.push(structuredClone(r)); }, load: async () => records,
    now: () => now, monotonicNow: () => now - start + 0.123 + (drift ? 2000 : 0), sleep: async ms => { now += ms; }, log: () => undefined,
    start: async (_profile, _id, _host, readOnly) => ({ startedAt: new Date(now).toISOString(), watcher: { check: () => undefined, flush: async () => undefined, allow: () => undefined, close: () => undefined }, channel: {
      cancel: () => undefined, finish: async () => undefined,
      request: async request => {
        requests.push(request);
        const base = { version: 1 as const, requestId: request.requestId, ok: true as const };
        if (request.action === 'status') {
          assert.equal(readOnly, true);
          const lookup = request.lookupRequestId && receipt?.commitRequestId === request.lookupRequestId
            ? { requestId: request.lookupRequestId, operationId: operation.operationId, kind: 'COMMITTED' as const, evidenceDigest: receipt.evidenceDigest } : null;
          return { ...base, action: 'status', result: { operation, maintenancePending: !receipt, pendingOperationId: receipt ? null : operation.operationId,
            events: lookup ? [{ eventId: id(10), requestId: lookup.requestId, kind: lookup.kind, actor: operation.actor, recordedAt: receipt!.committedAt,
              bindingDigest: operation.bindingDigest, evidenceDigest: lookup.evidenceDigest }] : [], receipt, lookup } };
        }
        assert.ok(records.some(r => r.requestId === request.requestId), 'mutation identity must be durable before send');
        assert.ok(!JSON.stringify(records).includes('x'.repeat(32)));
        if (request.action === 'begin-observe') return { ...base, action: 'observer-ready', result: { operation, observerSessionId: id(6), dbNow: new Date(now).toISOString(), remainingMs: Date.parse(operation.expiresAt) - now } };
        if (request.action === 'reset-proof') {
          const handshake = { sessionId: id(6), dispatchEventId: id(7), accountId: 'DU_TEST', clientId: 0 as const, serverVersion: 180, connectedAt: new Date(now).toISOString(), readyAt: new Date(now).toISOString(), closedAt: new Date(now).toISOString(), socketCloseObserved: true as const };
          handshakeResult = handshake;
          return { ...base, action: 'handshake-closed', result: { handshake, handshakeDigest: ownerRecoveryHash(handshake) } };
        }
        if (request.action === 'finalize-observation') {
          receipt = { version: 1, receiptId: id(8), operationId: id(2), commitRequestId: request.commitRequestId, owner: operation.owner, bindingDigest: hash, evidenceDigest: ownerRecoveryHash({ evidence: request.evidence, handshake: handshakeResult }), actor: 'tester', committedAt: new Date(now).toISOString(), retiredAt: new Date(now).toISOString(), retirementState: 'RETIRED', method: 'OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1' };
          operation.state = 'COMMITTED'; operation.receiptId = receipt.receiptId; operation.evidenceDigest = receipt.evidenceDigest;
          if (lostFinalize) throw new Error('EOF');
          return { ...base, action: 'committed', result: { operation, receipt, unlockAcknowledged: true } };
        }
        throw new Error('unexpected');
      },
    } }),
  };
  return { deps, requests, records, lose: () => { lostFinalize = true; }, drift: () => { drift = true; }, changed: () => { changed = true; } };
}
test('one live observer performs reset and finalizes once, with durable IDs, fractional monotonic clock and exact receipt readback', async () => {
  const f = fixture();
  const logs: string[] = []; f.deps.log = line => logs.push(line);
  const result = await executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps);
  assert.match(result, /Potwierdzono/); assert.deepEqual(f.requests.map(r => r.action), ['status', 'begin-observe', 'reset-proof', 'finalize-observation', 'status']);
  assert.equal(f.records.filter(r => r.action === 'finalize-observation').length, 1);
  const binding = logs.find(line => line.startsWith('Powiązanie afterReset'))!;
  assert.deepEqual(JSON.parse(binding.slice(binding.indexOf('{'))), { operationId: id(2), nonce: id(3),
    process: { pid: 202, startIdentity: iso(2000), executableHash: hash } });
  assert.ok(!logs.join('\n').includes(f.deps.token));
});
test('lost final acknowledgement does exact commit lookup, never repeats handshake or finalize, and keeps operational outcome failed', async () => {
  const f = fixture(); f.lose();
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /EOF/);
  assert.equal(f.requests.filter(r => r.action === 'reset-proof').length, 1); assert.equal(f.requests.filter(r => r.action === 'finalize-observation').length, 1);
  assert.equal(f.requests.at(-1)?.action, 'status');
  const last = f.requests.at(-1)!; assert.ok(last.action === 'status' && last.lookupRequestId === f.records.at(-1)?.commitRequestId);
});
test('a restarted observer cannot reuse persisted begin/reset/finalize capability', async () => {
  const f = fixture(); f.records.push({ version: 1, operationId: id(2), requestId: id(9), action: 'begin-observe', digest: hash });
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /RESET_UNPROVEN/);
  assert.deepEqual(f.requests.map(r => r.action), ['status']);
});
test('status has no producer inventory or handshake requirement and never looks up nonexistent begin event', async () => {
  const f = fixture(); f.deps.host = () => ({ captureProducerInventory: async () => { throw new Error('running'); } }) as unknown as ReturnType<AccountingRecoveryDependencies['host']>;
  f.records.push({ version: 1, operationId: id(2), requestId: id(9), action: 'begin-observe', digest: hash });
  assert.match(await executeAccountingRecovery({ action: 'status', operationId: id(2) }, f.deps), /PREPARED/);
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0].action === 'status' && !f.requests[0].lookupRequestId);
});
test('status preserves operation and maintenance evidence when saved reset was never dispatched or rejected', async () => {
  for (const mode of ['before-dispatch', 'rejected-reset']) {
    const f = fixture();
    if (mode === 'before-dispatch') f.records.push({ version: 1, operationId: id(2), requestId: id(20), action: 'reset-proof', digest: hash });
    else {
      const original = f.deps.start;
      f.deps.start = async (...args) => {
        const session = await original(...args), request = session.channel.request;
        session.channel.request = value => value.action === 'reset-proof'
          ? Promise.resolve({ version: 1, requestId: value.requestId, ok: false, error: { code: 'ACCOUNTING_OWNER_RECOVERY_RESET_UNPROVEN' } }) : request(value);
        return session;
      };
      await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /RESET_UNPROVEN/);
    }
    const saved = f.records.at(-1)!;
    const output = await executeAccountingRecovery({ action: 'status', operationId: id(2) }, f.deps);
    for (const value of ['PREPARED', 'blokada konserwacyjna: aktywna', 'UNKNOWN', saved.requestId, hash, 'nie potwierdza wycofania zapisu']) assert.ok(output.includes(value), value);
  }
});
test('missing commit event remains strict for resolution but public status reports UNKNOWN with retained maintenance', async () => {
  const f = fixture(), original = f.deps.start;
  f.deps.start = async (...args) => {
    const session = await original(...args), request = session.channel.request;
    session.channel.request = value => value.action === 'finalize-observation' ? Promise.reject(new Error('EOF before commit')) : request(value);
    return session;
  };
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /MUTATION_UNKNOWN/);
  const output = await executeAccountingRecovery({ action: 'status', operationId: id(2) }, f.deps);
  for (const value of ['PREPARED', 'UNKNOWN', 'blokada konserwacyjna: aktywna', f.records.at(-1)!.commitRequestId!]) assert.ok(output.includes(value), value);
  assert.equal(output.includes('Potwierdzono'), false);
});
test('private artifact checks enforce permissions, canonical paths, hash and file signatures', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'owner-proof-'))); await chmod(dir, 0o700);
  try {
    const proof = operator(); const bytes = Buffer.from('operator inspected fixture');
    for (const artifact of proof.artifacts) { artifact.sha256 = createHash('sha256').update(bytes).digest('hex'); await writeFile(join(dir, artifact.relativePath), bytes, { mode: 0o600 }); }
    const path = join(dir, 'proof.json'); await writeFile(path, JSON.stringify(proof), { mode: 0o600 });
    assert.equal((await readAccountingOperatorEvidence(path)).inspectionId, id(1));
    await chmod(path, 0o644); await assert.rejects(readAccountingOperatorEvidence(path)); await chmod(path, 0o600);
    await symlink(path, join(dir, 'link')); await assert.rejects(readAccountingPrivateFile(join(dir, 'link'), 65536));
    await writeFile(join(dir, proof.artifacts[0].relativePath), 'changed'); await assert.rejects(readAccountingOperatorEvidence(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('public parser excludes detached commit, arbitrary endpoint and token arguments', async () => {
  for (const args of [['commit'], ['status', '--operation', id(2), '--endpoint', 'remote'], ['prepare', '--token', 'secret']]) await assert.rejects(runAccountingOwnerRecoveryCli(args, {}));
});
test('clock drift, abort and changed deployment after closure cannot dispatch finalize', async () => {
  for (const kind of ['clock', 'abort', 'deployment']) {
    const f = fixture(), original = f.deps.start, controller = new AbortController(); f.deps.signal = controller.signal;
    f.deps.start = async (...args) => {
      const session = await original(...args), request = session.channel.request;
      session.channel.request = async value => {
        const result = await request(value);
        if (value.action === 'reset-proof') {
          if (kind === 'clock') f.drift(); else if (kind === 'abort') controller.abort(); else f.changed();
        }
        return result;
      };
      return session;
    };
    await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps));
    assert.equal(f.requests.filter(r => r.action === 'finalize-observation').length, 0, kind);
  }
});
test('a different exact readback receipt cannot resolve a lost finalize response', async () => {
  const f = fixture(); f.lose(); const original = f.deps.start;
  f.deps.start = async (...args) => {
    const session = await original(...args), request = session.channel.request;
    session.channel.request = async value => {
      const result = await request(value);
      if (result.ok && result.action === 'status' && result.result.receipt) result.result.receipt.commitRequestId = id(99);
      return result;
    }; return session;
  };
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /RECEIPT_MISMATCH/);
});

test('inventory or watcher failure immediately after backend start cancels child and closes watcher', async () => {
  for (const failAt of ['inventory', 'flush']) {
    const f = fixture(), originalStart = f.deps.start;
    let cancelled = 0, closed = 0;
    const originalHost = f.deps.host;
    f.deps.host = profile => {
      const host = originalHost(profile);
      if (failAt === 'inventory') host.captureProducerInventory = async () => { throw new Error('capture failed'); };
      return host;
    };
    f.deps.start = async (...args) => {
      const session = await originalStart(...args);
      session.channel.cancel = () => { cancelled++; }; session.watcher.close = () => { closed++; };
      if (failAt === 'flush') session.watcher.flush = async () => { throw new Error('flush failed'); };
      return session;
    };
    await assert.rejects(executeAccountingRecovery({ action: 'prepare', evidencePath: '/private/proof.json' }, f.deps));
    assert.equal(cancelled, 1, failAt); assert.equal(closed, 1, failAt); assert.equal(f.requests.length, 0, failAt);
  }
});

test('inventory loss in the first active observer poll cancels observation before reset or handshake and retains maintenance', async () => {
  const f = fixture(), originalStart = f.deps.start, originalHost = f.deps.host;
  let active = false, cancelled = 0, closed = 0, stopChecks = 0;
  f.deps.log = line => { if (line.startsWith('Obserwacja aktywna.')) active = true; };
  f.deps.host = profile => {
    const host = originalHost(profile), verify = host.verifyProducerInventory, stopped = host.assertGatewayStopped;
    host.verifyProducerInventory = async previous => {
      if (active) throw new Error('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
      return verify(previous);
    };
    host.assertGatewayStopped = async (...args) => { stopChecks++; return stopped(...args); };
    return host;
  };
  f.deps.start = async (...args) => {
    const session = await originalStart(...args);
    if (!args[3]) { session.channel.cancel = () => { cancelled++; }; session.watcher.close = () => { closed++; }; }
    return session;
  };
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /INVENTORY_UNAVAILABLE/);
  assert.equal(active, true); assert.equal(cancelled, 1); assert.equal(closed, 1); assert.equal(stopChecks, 0);
  assert.deepEqual(f.requests.map(request => request.action), ['status', 'begin-observe']);
  assert.deepEqual(f.records.map(record => record.action), ['begin-observe']);
  const status = await executeAccountingRecovery({ action: 'status', operationId: id(2) }, f.deps);
  assert.match(status, /PREPARED/); assert.match(status, /blokada konserwacyjna: aktywna/);
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /RESET_UNPROVEN/);
  assert.equal(f.requests.filter(request => request.action === 'begin-observe').length, 1);
});

test('status displays exact operation, maintenance, bindings, deadline and sanitized event history', async () => {
  const f = fixture(), originalStart = f.deps.start;
  f.deps.start = async (...args) => {
    const session = await originalStart(...args), request = session.channel.request;
    session.channel.request = async value => {
      const response = await request(value);
      if (response.ok && response.action === 'status') response.result.events = [{ eventId: id(11), requestId: id(12), kind: 'PREPARED', actor: 'tester', recordedAt: iso(-1000), bindingDigest: hash, evidenceDigest: null }];
      return response;
    }; return session;
  };
  const text = await executeAccountingRecovery({ action: 'status', operationId: id(2) }, f.deps);
  for (const fragment of [id(2), id(4), id(11), id(12), iso(899000), hash, 'PREPARED', 'rewizja pauzy: 1']) assert.ok(text.includes(fragment), fragment);
  assert.ok(!text.includes('x'.repeat(32)));
});
