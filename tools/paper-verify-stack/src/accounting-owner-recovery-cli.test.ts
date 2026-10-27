import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { executeAccountingRecovery, readAccountingOperatorEvidence, readAccountingEnvironmentEvidence, readAccountingCoordination, readAccountingPrivateFile, runAccountingOwnerRecoveryCli,
  type AccountingRecoveryDependencies, type AccountingRecoverySaved } from './accounting-owner-recovery-cli.js';
import { ownerRecoveryHash, OWNER_RECOVERY_SERVICES, type OwnerRecoveryProfile, type OwnerRecoveryInventory,
  type OwnerRecoveryOperation, type OwnerRecoveryRequest, type OwnerRecoveryReceipt, type OwnerRecoveryOperatorEvidence, type OwnerRecoveryCoordination, type OwnerRecoveryEnvironmentEvidence, type OwnerRecoveryAccountProbe } from '@ikbr/shared/accounting-owner-recovery';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, hash = 'a'.repeat(64);
const start = Date.parse('2026-10-19T12:00:00.000Z'), iso = (n = 0) => new Date(start + n).toISOString();
const profile: OwnerRecoveryProfile = { project: 'fixture', imageId: `sha256:${hash}`, deploymentHash: hash, dockerHost: 'unix:///var/run/docker.sock', hostIdHash: hash, settingsHash: hash, accountId: 'DU_TEST', endpoint: { host: 'host.docker.internal', port: 7497, clientId: 0 } };
const operator = (): OwnerRecoveryOperatorEvidence => ({ version: 1, inspectionId: id(1), accountId: profile.accountId, endpoint: profile.endpoint, settingsHash: hash, deploymentHash: hash, operator: 'tester', observedAt: iso(), product: 'TWS', confirmations: { paperAccount: true, accountPositionsFlat: true, accountOpenOrdersAbsent: true, noPendingManualActions: true, otherClientsStopped: true, noChangesUntilRecoveryEnds: true, noOtherNativeOrExternalClients: true, noNativeClientLaunchUntilRecoveryEnds: true }, artifacts: ['account-environment', 'positions', 'open-orders'].map(kind => ({ kind: kind as 'positions', relativePath: `${kind}.txt`, sha256: hash, observedAt: iso() })) });
const oldProcess = { pid: 101, startIdentity: iso(-10000), executableHash: hash };
const environment = (): OwnerRecoveryEnvironmentEvidence => ({ version: 2, inspectionId: id(30), accountId: profile.accountId, endpoint: profile.endpoint,
  settingsHash: hash, deploymentHash: hash, actor: 'agent', provenance: 'agent-ui-observation', observedAt: iso(-1000), product: 'TWS', environment: 'paper', process: { ...oldProcess },
  artifact: { relativePath: 'environment.txt', sha256: hash, observedAt: iso(-1000) } });
const coordination = (): OwnerRecoveryCoordination => {
  const declaration = { confirmed: true as const, source: 'carried-owner-authorization' as const, actor: 'tester', sourceReference: 'session:test', observedAt: iso(-1000) };
  return { version: 2, coordinationId: id(31), actor: 'tester', accountId: profile.accountId, endpoint: profile.endpoint, settingsHash: hash, deploymentHash: hash,
    recordedAt: iso(-1000), authorizationReference: 'session:test', declarations: { noPendingManualActionsOrDrafts: declaration,
      noOtherNativeOrExternalClients: declaration, noChangesOrClientLaunchesUntilRecoveryEnds: declaration }, environmentEvidence: environment() };
};
function fixture(v2 = false) {
  let handshakeResult: unknown;
  let now = start, receipt: OwnerRecoveryReceipt | null = null, lostFinalize = false, drift = false, changed = false;
  const records: AccountingRecoverySaved[] = [], requests: OwnerRecoveryRequest[] = [];
  const operation: OwnerRecoveryOperation = { version: 1, operationId: id(2), nonce: id(3), state: 'PREPARED', owner: { endpointKey: 'key', ownerId: id(4), generation: 1, retirementState: 'UNKNOWN', acquiredAt: iso(-10000), updatedAt: iso(-10000) }, profile, pauseRevision: 1, actor: 'tester', preparedAt: iso(-1000), expiresAt: iso(899000), bindingDigest: hash, evidenceDigest: null, successorOperationId: null, receiptId: null };
  if (v2) { operation.version = 2; operation.coordination = coordination(); }
  const inventory = (): OwnerRecoveryInventory => ({ observedAt: new Date(now).toISOString(), producers: [], absentServices: [...OWNER_RECOVERY_SERVICES], nativeProcesses: [], unexpectedNativeCandidates: [], unexpectedSocketPids: [] });
  const newer = { pid: 202, startIdentity: iso(2000), executableHash: hash };
  const evidence = () => ({ ...operator(), observedAt: iso(4000), artifacts: operator().artifacts.map(a => ({ ...a, observedAt: iso(4000) })), afterReset: { operationId: id(2), nonce: id(3), process: newer } });
  const host = { captureProducerInventory: async () => inventory(), verifyProducerInventory: async () => inventory(), clearOneShot: () => undefined,
    captureGatewayProcess: async () => { now = start + 100; return { observedAt: iso(100), process: { pid: 101, startIdentity: iso(-10000), executableHash: hash } }; },
    assertGatewayUnchanged: async () => ({ observedAt: new Date(now).toISOString(), process: oldProcess }),
    assertGatewayStopped: async () => { now = start + 1000; return { observedAt: iso(1000), processAbsent: true, listenerAbsent: true }; },
    verifyGatewayReplacement: async () => { now = Math.max(now + 10, start + 3000); return { observedAt: new Date(now).toISOString(), process: newer }; },
  } as unknown as ReturnType<AccountingRecoveryDependencies['host']>;
  const deps: AccountingRecoveryDependencies = { actor: 'tester', token: 'x'.repeat(32), profile: async () => ({ wire: { ...profile, deploymentHash: changed ? 'b'.repeat(64) : hash }, root: '/repo', compose: [] }), host: () => host,
    coordination: async () => operation.coordination!, environment: async () => { now = Math.max(now, start + 4000); return { ...environment(), observedAt: iso(4000), artifact: { ...environment().artifact, observedAt: iso(4000) }, process: newer, afterReset: { operationId: id(2), nonce: id(3) } }; },
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
        if (request.action === 'pre-reset-probe' || request.action === 'reset-proof' && v2) {
          const time = new Date(now).toISOString();
          const probe: OwnerRecoveryAccountProbe = { version: 2, probeId: id(32), operationId: operation.operationId, nonce: operation.nonce, sessionId: id(6), dispatchEventId: id(7),
            phase: request.action === 'pre-reset-probe' ? 'pre-reset' : 'post-reset', endpoint: profile.endpoint,
            result: { accountId: profile.accountId, clientId: 0, protocolVersion: 180, sdkVersion: '@stoqey/ib@1.6.10', connectedAt: time, readyAt: time,
              positionsRequestedAt: time, openOrdersRequestedAt: time, positionsEndAt: time, openOrdersEndAt: time, completedAt: time, closedAt: time,
              transportClosed: true, positionRows: 0, openOrderRows: 0, eventCount: 5, rowsDigest: hash, outcome: 'FLAT', error: null } };
          if (request.action === 'pre-reset-probe') return { ...base, action: 'pre-reset-probe-closed', result: { probe, probeDigest: ownerRecoveryHash(probe) } };
          handshakeResult = probe;
          return { ...base, action: 'handshake-closed', result: { handshake: probe, handshakeDigest: ownerRecoveryHash(probe) } };
        }
        if (request.action === 'reset-proof') {
          const handshake = { sessionId: id(6), dispatchEventId: id(7), accountId: 'DU_TEST', clientId: 0 as const, serverVersion: 180, connectedAt: new Date(now).toISOString(), readyAt: new Date(now).toISOString(), closedAt: new Date(now).toISOString(), socketCloseObserved: true as const };
          handshakeResult = handshake;
          return { ...base, action: 'handshake-closed', result: { handshake, handshakeDigest: ownerRecoveryHash(handshake) } };
        }
        if (request.action === 'finalize-observation') {
          receipt = { version: v2 ? 2 : 1, receiptId: id(8), operationId: id(2), commitRequestId: request.commitRequestId, owner: operation.owner, bindingDigest: hash, evidenceDigest: ownerRecoveryHash({ evidence: request.evidence, handshake: handshakeResult }), actor: 'tester', committedAt: new Date(now).toISOString(), retiredAt: new Date(now).toISOString(), retirementState: 'RETIRED', method: v2 ? 'API_OBSERVED_LOCAL_TWS_RESET_V2' : 'OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1' };
          operation.state = 'COMMITTED'; operation.receiptId = receipt.receiptId; operation.evidenceDigest = receipt.evidenceDigest;
          if (lostFinalize) throw new Error('EOF');
          return { ...base, action: 'committed', result: { operation, receipt, unlockAcknowledged: true } };
        }
        throw new Error('unexpected');
      },
    } }),
  };
  return { deps, requests, records, operation, lose: () => { lostFinalize = true; }, drift: () => { drift = true; }, changed: () => { changed = true; } };
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

test('replacement wait inventory refusal preserves its diagnostic and cancels before afterReset or handshake without retry', async () => {
  const { AccountingRecoveryHostError } = await import('./accounting-owner-recovery-host.js');
  const { accountingWatcherDiagnostic } = await import('./accounting-owner-recovery-cli.js');
  const f = fixture(), originalStart = f.deps.start, originalHost = f.deps.host;
  let waiting = false, cancelled = 0, closed = 0, failedInventories = 0, replacementChecks = 0;
  const logs: string[] = [], failure = new AccountingRecoveryHostError('ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT', {
    name: 'AccountingNativeInventory:socket', code: 'UNEXPECTED_ENDPOINT_OWNER', message: 'fixed local cause',
  });
  f.deps.log = line => { logs.push(line); if (line.startsWith('Potwierdzono pełne zatrzymanie')) waiting = true; };
  f.deps.host = profile => {
    const host = originalHost(profile), verify = host.verifyProducerInventory, replacement = host.verifyGatewayReplacement;
    host.verifyProducerInventory = async previous => { if (waiting) { failedInventories++; throw failure; } return verify(previous); };
    host.verifyGatewayReplacement = async (...args) => { replacementChecks++; return replacement(...args); };
    return host;
  };
  f.deps.start = async (...args) => {
    const session = await originalStart(...args);
    if (!args[3]) { session.channel.cancel = () => { cancelled++; }; session.watcher.close = () => { closed++; }; }
    return session;
  };
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), error => {
    assert.equal(error, failure); assert.equal(accountingWatcherDiagnostic(error), 'AccountingNativeInventory:socket/UNEXPECTED_ENDPOINT_OWNER'); return true;
  });
  assert.equal(waiting, true); assert.equal(cancelled, 1); assert.equal(closed, 1); assert.equal(failedInventories, 1); assert.equal(replacementChecks, 0);
  assert.equal(logs.some(line => line.includes('afterReset')), false);
  assert.deepEqual(f.requests.map(request => request.action), ['status', 'begin-observe']);
  assert.deepEqual(f.records.map(record => record.action), ['begin-observe']);
  const status = await executeAccountingRecovery({ action: 'status', operationId: id(2) }, f.deps);
  assert.match(status, /PREPARED/); assert.match(status, /blokada konserwacyjna: aktywna/);
  await assert.rejects(executeAccountingRecovery({ action: 'observe', operationId: id(2), evidencePath: '/private/proof.json' }, f.deps), /RESET_UNPROVEN/);
});

const observeV2 = { action: 'observe' as const, operationId: id(2), apiEvidence: true, coordinationPath: '/private/coordination.json', environmentEvidencePath: '/private/after.json' };
test('V2 performs exactly two backend probes in the same live observer and binds both private observations', async () => {
  const f = fixture(true), logs: string[] = []; f.deps.log = line => logs.push(line);
  const result = await executeAccountingRecovery(observeV2, f.deps);
  assert.match(result, /Potwierdzono/);
  assert.deepEqual(f.requests.map(r => r.action), ['status', 'begin-observe', 'pre-reset-probe', 'reset-proof', 'finalize-observation', 'status']);
  const pre = f.requests.find(r => r.action === 'pre-reset-probe')!, reset = f.requests.find(r => r.action === 'reset-proof')!, finalize = f.requests.find(r => r.action === 'finalize-observation')!;
  assert.ok(pre.action === 'pre-reset-probe' && reset.action === 'reset-proof' && finalize.action === 'finalize-observation');
  assert.equal(reset.version, 2); assert.equal(finalize.version, 2);
  assert.deepEqual(pre.evidence.before, reset.evidence.before);
  assert.equal('operatorEvidence' in reset.evidence, false);
  assert.equal('environmentEvidence' in reset.evidence, true);
  assert.equal('preResetProbeDigest' in reset.evidence && reset.evidence.preResetProbeDigest.length, 64);
  assert.equal(pre.evidence.coordinationDigest, ownerRecoveryHash(coordination()));
  assert.equal(logs.filter(line => line.startsWith('Obserwacja aktywna.')).length, 1);
});

test('V2 prepare and supersede send coordination instead of V1 account attestation', async () => {
  for (const action of ['prepare', 'supersede'] as const) {
    const f = fixture(true), original = f.deps.start;
    f.deps.start = async (...args) => {
      const session = await original(...args), send = session.channel.request;
      session.channel.request = async request => {
        if (request.action !== action) return send(request);
        assert.equal(request.version, 2); assert.ok('coordination' in request); assert.equal('operatorEvidence' in request, false);
        assert.ok(f.records.some(record => record.requestId === request.requestId));
        return { version: 1, ok: true, requestId: request.requestId, action: action === 'prepare' ? 'prepared' : 'superseded',
          result: { ...f.operation, operationId: request.action === 'prepare' ? request.operationId : request.replacementOperationId } };
      };
      return session;
    };
    assert.match(await executeAccountingRecovery({ action, ...(action === 'supersede' ? { operationId: id(2) } : {}), apiEvidence: true, coordinationPath: '/private/coordination.json' }, f.deps), /Przygotowano/);
  }
});

test('V2 nonflat, incomplete, malformed, foreign or stale pre-probe never authorizes a TWS reset', async () => {
  for (const failure of ['nonflat', 'incomplete', 'malformed', 'session', 'operation', 'nonce', 'endpoint', 'account', 'stale', 'digest', 'lost']) {
    const f = fixture(true), original = f.deps.start, logs: string[] = []; f.deps.log = line => logs.push(line);
    f.deps.start = async (...args) => {
      const session = await original(...args), send = session.channel.request;
      session.channel.request = async request => {
        const result = await send(request);
        if (result.ok && result.action === 'pre-reset-probe-closed') {
          if (failure === 'lost') throw new Error('EOF');
          const proof = result.result.probe;
          if (failure === 'nonflat' || failure === 'incomplete') { proof.result.outcome = failure === 'nonflat' ? 'NONFLAT' : 'INCOMPLETE'; proof.result.error = { code: 'ACCOUNTING_OWNER_RECOVERY_RESET_UNPROVEN' }; }
          if (failure === 'malformed') proof.result.openOrdersEndAt = null;
          if (failure === 'session') proof.sessionId = id(80);
          if (failure === 'operation') proof.operationId = id(80);
          if (failure === 'nonce') proof.nonce = id(80);
          if (failure === 'endpoint') proof.endpoint = { ...proof.endpoint, port: 4002 };
          if (failure === 'account') proof.result.accountId = 'DU_OTHER';
          if (failure === 'stale') for (const field of ['connectedAt', 'readyAt', 'positionsRequestedAt', 'openOrdersRequestedAt', 'positionsEndAt', 'openOrdersEndAt', 'completedAt', 'closedAt'] as const) proof.result[field] = iso(-301000);
          result.result.probeDigest = failure === 'digest' ? hash : ownerRecoveryHash(proof);
        }
        return result;
      }; return session;
    };
    await assert.rejects(executeAccountingRecovery(observeV2, f.deps), /./, failure);
    assert.equal(logs.some(line => line.startsWith('Obserwacja aktywna.')), false, failure);
    assert.equal(f.requests.some(request => request.action === 'reset-proof'), false, failure);
  }
});

test('V2 stale, changed or mismatched coordination and restarted pre-probe history fail closed', async () => {
  for (const failure of ['stale', 'changed', 'process', 'restarted', 'version']) {
    const f = fixture(true), logs: string[] = []; f.deps.log = line => logs.push(line);
    if (failure === 'stale') {
      f.operation.coordination!.environmentEvidence.observedAt = iso(-301000);
      f.operation.coordination!.environmentEvidence.artifact.observedAt = iso(-301000);
      f.operation.coordination!.environmentEvidence.process.startIdentity = iso(-400000);
    }
    if (failure === 'changed') f.deps.coordination = async () => ({ ...coordination(), coordinationId: id(80) });
    if (failure === 'process') f.operation.coordination!.environmentEvidence.process = { ...oldProcess, pid: 999 };
    if (failure === 'restarted') f.records.push({ version: 1, operationId: id(2), requestId: id(80), action: 'pre-reset-probe', digest: hash });
    if (failure === 'version') { f.operation.version = 1; delete f.operation.coordination; }
    await assert.rejects(executeAccountingRecovery(observeV2, f.deps), /./, failure);
    assert.equal(f.requests.some(request => request.action === 'pre-reset-probe'), false, failure);
    assert.equal(logs.some(line => line.startsWith('Obserwacja aktywna.')), false, failure);
  }
});

test('V2 repeatedly monitors exact TWS and Docker watcher while probes run, with full inventory only outside their sockets', async () => {
  const f = fixture(true), originalStart = f.deps.start, host = f.deps.host(await f.deps.profile());
  let inFlight = false, inventoryCount = 0, processCount = 0, watcherCount = 0;
  const inventory = host.verifyProducerInventory, before = host.assertGatewayUnchanged, after = host.verifyGatewayReplacement;
  host.verifyProducerInventory = async previous => { assert.equal(inFlight, false, 'full endpoint inventory during owned socket'); inventoryCount++; return inventory(previous); };
  host.assertGatewayUnchanged = async (...args) => { if (inFlight) processCount++; return before(...args); };
  host.verifyGatewayReplacement = async (...args) => { if (inFlight) processCount++; return after(...args); };
  f.deps.start = async (...args) => {
    const session = await originalStart(...args), send = session.channel.request;
    session.watcher.flush = async () => { if (inFlight) watcherCount++; };
    session.channel.request = async request => {
      if (request.action === 'pre-reset-probe' || request.action === 'reset-proof') {
        inFlight = true; await new Promise(resolveWait => setTimeout(resolveWait, 550)); inFlight = false;
      }
      return send(request);
    }; return session;
  };
  await executeAccountingRecovery(observeV2, f.deps);
  assert.ok(processCount >= 4); assert.ok(watcherCount >= 4); assert.ok(inventoryCount >= 4);
});

test('V2 process or watcher change during either probe cancels without continuing reset or finalization', async () => {
  for (const phase of ['pre-reset-probe', 'reset-proof'] as const) for (const failure of ['process', 'watcher']) {
    const f = fixture(true), original = f.deps.start, host = f.deps.host(await f.deps.profile()), logs: string[] = [];
    f.deps.log = line => logs.push(line);
    let inFlight = false, cancelled = 0;
    const before = host.assertGatewayUnchanged, after = host.verifyGatewayReplacement;
    host.assertGatewayUnchanged = async (...args) => { if (inFlight && failure === 'process') throw new Error('PROCESS_CHANGED'); return before(...args); };
    host.verifyGatewayReplacement = async (...args) => { if (inFlight && failure === 'process') throw new Error('PROCESS_CHANGED'); return after(...args); };
    f.deps.start = async (...args) => {
      const session = await original(...args), send = session.channel.request;
      session.channel.cancel = () => { cancelled++; };
      session.watcher.check = () => { if (inFlight && failure === 'watcher') throw new Error('WATCHER_FAILED'); };
      session.channel.request = async request => { if (request.action === phase) { inFlight = true; await new Promise(resolveWait => setTimeout(resolveWait, 550)); inFlight = false; } return send(request); };
      return session;
    };
    await assert.rejects(executeAccountingRecovery(observeV2, f.deps), /PROCESS_CHANGED|WATCHER_FAILED/);
    assert.ok(cancelled > 0); assert.equal(f.requests.some(request => request.action === 'finalize-observation'), false);
    if (phase === 'pre-reset-probe') assert.equal(logs.some(line => line.startsWith('Obserwacja aktywna.')), false);
    await new Promise(resolveWait => setTimeout(resolveWait, 350));
  }
});

test('V2 private environment and coordination files preserve artifact hash, mode, path and provenance validation', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'owner-env-'))); await chmod(dir, 0o700);
  try {
    const proof = environment(), bytes = Buffer.from('Actual Paper UI observation'); proof.artifact.sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifact = join(dir, proof.artifact.relativePath), path = join(dir, 'environment.json'), coordinationPath = join(dir, 'coordination.json');
    await writeFile(artifact, bytes, { mode: 0o600 }); await writeFile(path, JSON.stringify(proof), { mode: 0o600 });
    await writeFile(coordinationPath, JSON.stringify({ ...coordination(), environmentEvidence: proof }), { mode: 0o600 });
    assert.deepEqual(await readAccountingEnvironmentEvidence(path), proof); assert.equal((await readAccountingCoordination(coordinationPath)).environmentEvidence.inspectionId, proof.inspectionId);
    await chmod(artifact, 0o644); await assert.rejects(readAccountingEnvironmentEvidence(path)); await assert.rejects(readAccountingCoordination(coordinationPath)); await chmod(artifact, 0o600);
    await writeFile(artifact, 'changed'); await assert.rejects(readAccountingEnvironmentEvidence(path)); await assert.rejects(readAccountingCoordination(coordinationPath));
    await writeFile(artifact, bytes); await writeFile(path, JSON.stringify({ ...proof, provenance: 'invented' })); await assert.rejects(readAccountingEnvironmentEvidence(path));
    await writeFile(path, JSON.stringify({ ...proof, artifact: { ...proof.artifact, relativePath: '../environment.txt' } })); await assert.rejects(readAccountingEnvironmentEvidence(path));
    await symlink(coordinationPath, join(dir, 'linked.json')); await assert.rejects(readAccountingCoordination(join(dir, 'linked.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('V2 command parsing rejects missing coordination, mixed V1 proofs and unrelated evidence options', async () => {
  for (const args of [
    ['observe', '--operation', id(2), '--api-evidence', '--environment-evidence', '/after.json'],
    ['prepare', '--api-evidence', '--operator-evidence', '/manual.json'],
    ['supersede', '--operation', id(2), '--api-evidence', '--coordination', '/coord.json', '--environment-evidence', '/after.json'],
    ['status', '--operation', id(2), '--api-evidence'],
    ['observe', '--operation', id(2), '--operator-evidence', '/manual.json', '--coordination', '/coord.json'],
  ]) await assert.rejects(runAccountingOwnerRecoveryCli(args, {}), /USAGE/);
});

test('V2 post-reset proof failures cannot finalize, even when the pre-reset probe succeeded', async () => {
  for (const failure of ['nonflat', 'incomplete', 'phase', 'session', 'operation', 'nonce', 'stale', 'digest', 'v1']) {
    const f = fixture(true), original = f.deps.start;
    f.deps.start = async (...args) => {
      const session = await original(...args), send = session.channel.request;
      session.channel.request = async request => {
        const response = await send(request);
        if (request.action === 'reset-proof' && response.ok && response.action === 'handshake-closed' && 'version' in response.result.handshake) {
          const proof = response.result.handshake;
          if (failure === 'nonflat' || failure === 'incomplete') { proof.result.outcome = failure === 'nonflat' ? 'NONFLAT' : 'INCOMPLETE'; proof.result.error = { code: 'ACCOUNTING_OWNER_RECOVERY_RESET_UNPROVEN' }; }
          if (failure === 'phase') proof.phase = 'pre-reset';
          if (failure === 'session') proof.sessionId = id(90);
          if (failure === 'operation') proof.operationId = id(90);
          if (failure === 'nonce') proof.nonce = id(90);
          if (failure === 'stale') for (const field of ['connectedAt', 'readyAt', 'positionsRequestedAt', 'openOrdersRequestedAt', 'positionsEndAt', 'openOrdersEndAt', 'completedAt', 'closedAt'] as const) proof.result[field] = iso(-301000);
          if (failure === 'v1') response.result.handshake = { sessionId: id(6), dispatchEventId: id(7), accountId: profile.accountId, clientId: 0, serverVersion: 180, connectedAt: iso(), readyAt: iso(), closedAt: iso(), socketCloseObserved: true };
          response.result.handshakeDigest = failure === 'digest' ? hash : ownerRecoveryHash(response.result.handshake);
        }
        return response;
      }; return session;
    };
    await assert.rejects(executeAccountingRecovery(observeV2, f.deps), /./, failure);
    assert.equal(f.requests.filter(request => request.action === 'pre-reset-probe').length, 1);
    assert.equal(f.requests.some(request => request.action === 'finalize-observation'), false, failure);
  }
});

test('V2 requires a fresh replacement-bound environment file and rechecks both private files through finalization', async () => {
  for (const failure of ['missing-then-written', 'stale', 'process', 'nonce', 'environment-changed', 'coordination-changed']) {
    const f = fixture(true), readEnvironment = f.deps.environment, readCoordination = f.deps.coordination;
    let environmentReads = 0;
    f.deps.environment = async path => {
      environmentReads++;
      if (failure === 'missing-then-written' && environmentReads === 1) throw Object.assign(new Error('not yet written'), { code: 'ENOENT' });
      const proof = await readEnvironment(path);
      if (failure === 'stale') { proof.observedAt = iso(-1000); proof.artifact.observedAt = iso(-1000); }
      if (failure === 'process') proof.process = { ...oldProcess };
      if (failure === 'nonce') proof.afterReset!.nonce = id(90);
      if (failure === 'environment-changed' && environmentReads > 1) proof.inspectionId = id(90);
      return proof;
    };
    f.deps.coordination = async path => {
      const proof = await readCoordination(path);
      return failure === 'coordination-changed' && environmentReads > 0 ? { ...proof, authorizationReference: 'changed' } : proof;
    };
    if (failure === 'missing-then-written') {
      assert.match(await executeAccountingRecovery(observeV2, f.deps), /Potwierdzono/);
      assert.ok(environmentReads > 2);
    } else {
      await assert.rejects(executeAccountingRecovery(observeV2, f.deps), /./, failure);
      assert.equal(f.requests.some(request => request.action === 'reset-proof'), false, failure);
    }
  }
});

test('V2 pre-probe dispatch requires the entire remaining budget and rejects late process replacement before reset permission', async () => {
  for (const failure of ['budget', 'late-process']) {
    const f = fixture(true), logs: string[] = []; f.deps.log = line => logs.push(line);
    if (failure === 'budget') {
      const host = f.deps.host(await f.deps.profile()), inventory = host.verifyProducerInventory;
      host.verifyProducerInventory = async previous => { await f.deps.sleep(880000); return inventory(previous); };
    }
    else {
      const host = f.deps.host(await f.deps.profile()), original = host.assertGatewayUnchanged;
      host.assertGatewayUnchanged = async (...args) => {
        if (f.requests.some(request => request.action === 'pre-reset-probe')) throw new Error('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
        return original(...args);
      };
    }
    await assert.rejects(executeAccountingRecovery(observeV2, f.deps), /OBSERVATION_EXPIRED|PROCESS_CHANGED/);
    assert.equal(logs.some(line => line.startsWith('Obserwacja aktywna.')), false);
    assert.equal(f.requests.some(request => request.action === 'reset-proof'), false);
    if (failure === 'budget') assert.equal(f.requests.some(request => request.action === 'pre-reset-probe'), false);
  }
});
