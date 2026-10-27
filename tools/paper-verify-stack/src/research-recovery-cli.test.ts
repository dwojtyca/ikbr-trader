import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { researchHash, type RecoveryChallenge, type RecoveryProducer } from '@ikbr/shared/instrument-research';
import { executeRecoveryCommand, type RecoveryCliDependencies, type RecoveryProfile } from './research-recovery-cli.js';

function fixture(kind: RecoveryChallenge['kind'] = 'MARKETAUX_PRODUCER_QUIESCENCE', producerState: 'exited' | 'created' = 'exited') {
  let clock = Date.parse('2026-10-19T12:00:00Z'); const anchor = clock;
  const profile: RecoveryProfile = { project: 'ikbr-trader', imageId: `sha256:${'a'.repeat(64)}`, deploymentHash: 'b'.repeat(64), compose: [],
    dockerHost: 'unix:///var/run/docker.sock', endpointId: 'local', host: 'host.docker.internal', port: 7497, clientId: 156 };
  const challenge: RecoveryChallenge = { id: randomUUID(), nonce: randomUUID(), challengeHash: 'c'.repeat(64), configHash: 'd'.repeat(64), manifestHash: 'e'.repeat(64), kind,
    accountId: 'DU_SYNTHETIC', instrumentId: 'pko_wse', sourceId: 'news', pauseRevision: 2, actor: 'operator:fixture', operationId: randomUUID(), executionProcessId: 'execution',
    state: 'PREPARED', createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 900000).toISOString(), endpointId: 'local', endpointGeneration: 2, predecessors: [], predecessorHash: 'f'.repeat(64), receiptId: null };
  let producer: RecoveryProducer = { containerId: '1'.repeat(64), imageId: profile.imageId, project: profile.project, service: 'llm-agent', state: 'exited',
    startedAt: '2026-10-19T10:00:00.000Z', finishedAt: '2026-10-19T11:00:00.000Z' };
  if (producerState === 'created') producer = { ...producer, state: 'created', createdAt: '2026-10-19T09:00:00.123Z', startedAt: null, finishedAt: null };
  const state = new Map<string, Parameters<RecoveryCliDependencies['save']>[1]>([[challenge.id, { version: 1, challenge: structuredClone(challenge), deploymentHash: profile.deploymentHash }]]);
  const calls: Array<Record<string, unknown>> = [], logs: string[] = []; let receipt: unknown = null; let commitOperation: unknown;
  const stamp = () => new Date(clock += 10).toISOString(); let stopped = false;
  const host = {
    hostIdentityHash: async () => '2'.repeat(64), captureProducerInventory: async () => ({ observedAt: stamp(), producers: [producer] }),
    verifyProducerInventory: async () => ({ observedAt: stamp(), producers: [producer] }),
    captureGatewayProcess: async () => ({ observedAt: stamp(), process: { pid: 100, startIdentity: 'old', executableHash: '3'.repeat(64) } }),
    assertGatewayStopped: async () => { stopped = true; return { observedAt: stamp(), processAbsent: true as const, listenerAbsent: true as const }; },
    verifyGatewayReplacement: async () => { assert.equal(stopped, true); return { observedAt: stamp(), process: { pid: 200, startIdentity: 'new', executableHash: '3'.repeat(64) } }; },
  };
  const deps: RecoveryCliDependencies = { profile: async () => profile, host: () => host, now: () => clock, monotonicNow: () => clock - anchor,
    log: text => logs.push(text), sleep: async ms => { clock += ms; }, load: async id => structuredClone(state.get(id)!), save: async (id, value) => { state.set(id, structuredClone(value)); },
    oneShot: async (_profile, request) => {
      const r = request as Record<string, unknown>; calls.push(r);
      if (r.action === 'commit') { challenge.state = 'COMMITTED'; challenge.receiptId = randomUUID(); commitOperation = r.operationId; receipt = { id: challenge.receiptId, challengeId: challenge.id, kind: challenge.kind, evidenceHash: researchHash(r.evidence) }; return receipt; }
      if (r.action === 'receipt') return r.operationId === commitOperation ? receipt : null;
      if (r.action === 'reconnect') { const id = randomUUID(); return { startedAt: stamp(), completedAt: stamp(), sessionId: id, accountId: challenge.accountId, serverVersion: 180, sdkVersion: '1.6.10', cleanup: {
        sessionId: id, state: 'CONFIRMED', verifiedLocalClosure: true, cancellationAttemptedAt: null, disconnectRequestedAt: stamp(), localClosedAt: stamp(), completedAt: stamp(),
      } }; }
      return structuredClone(challenge);
    } };
  return { deps, calls, logs, state, challenge, profile, host, advance: (ms: number) => { clock += ms; } };
}
test('Marketaux observe and commit record evidence without starting producers or broker actions', async () => {
  const f = fixture();
  await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
  assert.ok(f.state.get(f.challenge.id)?.evidence);
  const result = await executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps);
  assert.match(result, /Wejścia pozostają wstrzymane/);
  assert.deepEqual(f.calls.map(x => x.action), ['read', 'read', 'commit', 'read', 'receipt']);
});
test('WSH observation requires ordered disappearance/replacement and only bounded reconnect', async () => {
  const f = fixture('WSH_ENDPOINT_RESET');
  await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
  const evidence = f.state.get(f.challenge.id)?.evidence;
  assert.equal(evidence?.kind, 'WSH_ENDPOINT_RESET'); assert.deepEqual(f.calls.map(x => x.action), ['read', 'reconnect']);
  await assert.rejects(executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps), /ALREADY_RECORDED/);
});
test('lost committed response is read back exactly and never resubmitted', async () => {
  const f = fixture(); await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
  const call = f.deps.oneShot; f.deps.oneShot = async (p, input) => { const out = await call(p, input); if ((input as { action: string }).action === 'commit') throw new Error('lost ACK'); return out; };
  await executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps);
  await executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps);
  assert.equal(f.calls.filter(x => x.action === 'commit').length, 1);
});
test('lost commit ACK does not confirm mismatched evidence, receipt or absent operation readback', async () => {
  for (const mismatch of ['hash', 'receipt', 'operation']) {
    const f = fixture(); await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
    const call = f.deps.oneShot;
    f.deps.oneShot = async (p, input) => {
      const out = await call(p, input);
      if ((input as { action: string }).action === 'commit') throw new Error('lost ACK');
      if ((input as { action: string }).action === 'receipt') return mismatch === 'operation' ? null : {
        ...(out as object), ...(mismatch === 'hash' ? { evidenceHash: '0'.repeat(64) } : { id: randomUUID() }),
      };
      return out;
    };
    await assert.rejects(executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps), /COMMIT_UNKNOWN/);
    await assert.rejects(executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps), /COMMIT_UNKNOWN/);
    assert.equal(f.calls.filter(x => x.action === 'commit').length, 1);
  }
});
test('ambiguous uncommitted response leaves durable local mutation marker and forbids repeat', async () => {
  const f = fixture(); await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
  const call = f.deps.oneShot; let writes = 0;
  f.deps.oneShot = async (p, input) => { if ((input as { action: string }).action === 'commit') { writes++; throw new Error('unknown'); } return call(p, input); };
  await assert.rejects(executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps), /COMMIT_UNKNOWN/);
  const before = structuredClone(f.state.get(f.challenge.id));
  await executeRecoveryCommand({ action: 'status', kind: f.challenge.kind, instrumentId: f.challenge.instrumentId, challengeId: f.challenge.operationId }, f.deps);
  assert.deepEqual(f.state.get(f.challenge.id)?.evidence, before?.evidence);
  assert.equal(f.state.get(f.challenge.id)?.operationId, before?.operationId);
  await assert.rejects(executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps), /ALREADY_RECORDED/);
  await assert.rejects(executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps), /COMMIT_UNKNOWN/);
  assert.equal(writes, 1);
});
test('producer replacement, changed profile and expired observation reject before commit', async () => {
  for (const change of ['producer', 'profile', 'expired']) {
    const f = fixture(); await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
    if (change === 'profile') f.profile.deploymentHash = '4'.repeat(64);
    if (change === 'expired') f.advance(900001);
    if (change === 'producer') f.host.captureProducerInventory = async () => ({ observedAt: '2026-10-19T12:00:01.000Z', producers: [] });
    await assert.rejects(executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps));
    assert.equal(f.calls.some(x => x.action === 'commit'), false);
  }
});
test('unknown prepare performs only exact operation lookup, with operation persisted before mutation', async () => {
  const f = fixture(); let operationId = '';
  f.deps.oneShot = async (_p, input) => {
    const r = input as Record<string, unknown>; f.calls.push(r);
    if (r.action === 'prepare') { operationId = String(r.operationId); assert.ok(f.state.has(operationId)); throw new Error('lost ACK'); }
    assert.equal(r.action, 'replacement'); assert.equal(r.operationId, operationId); return f.challenge;
  };
  await executeRecoveryCommand({ action: 'prepare', kind: f.challenge.kind, instrumentId: f.challenge.instrumentId }, f.deps);
  assert.deepEqual(f.calls.map(x => x.action), ['prepare', 'replacement']);
});
test('supersession records one mutation and subsequent invocation only resolves its operation', async () => {
  const f = fixture(); const replacement = structuredClone(f.challenge); replacement.id = randomUUID();
  f.deps.oneShot = async (_p, input) => { f.calls.push(input as Record<string, unknown>); return replacement; };
  await executeRecoveryCommand({ action: 'supersede', challengeId: f.challenge.id, instrumentId: f.challenge.instrumentId }, f.deps);
  await executeRecoveryCommand({ action: 'supersede', challengeId: f.challenge.id, instrumentId: f.challenge.instrumentId }, f.deps);
  assert.deepEqual(f.calls.map(x => x.action), ['supersede', 'replacement']);
});
test('supersession can use newly pinned profile while ordinary observe cannot reuse old deployment evidence', async () => {
  const f = fixture(); f.profile.deploymentHash = '9'.repeat(64);
  await assert.rejects(executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps), /DEPLOYMENT_CHANGED/);
  const replacement = structuredClone(f.challenge); replacement.id = randomUUID();
  f.deps.oneShot = async (_p, input) => { f.calls.push(input as Record<string, unknown>); return replacement; };
  await executeRecoveryCommand({ action: 'supersede', challengeId: f.challenge.id, instrumentId: f.challenge.instrumentId }, f.deps);
  assert.equal(f.state.get(replacement.id)?.deploymentHash, f.profile.deploymentHash);
});

for (const kind of ['MARKETAUX_PRODUCER_QUIESCENCE', 'WSH_ENDPOINT_RESET'] as const) {
  test(`${kind} observes and commits created producers with unchanged reset flow`, async () => {
    const f = fixture(kind, 'created');
    await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
    const proof = f.state.get(f.challenge.id)?.evidence;
    assert.equal(proof?.producers[0].state, 'created');
    assert.equal(proof?.producers[0].startedAt, null); assert.equal(proof?.producers[0].finishedAt, null);
    assert.equal(proof?.producers[0].state === 'created' && proof.producers[0].createdAt, '2026-10-19T09:00:00.123Z');
    await executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps);
    assert.deepEqual(f.calls.map(x => x.action), kind === 'WSH_ENDPOINT_RESET' ? ['read', 'reconnect', 'read', 'commit', 'read', 'receipt'] : ['read', 'read', 'commit', 'read', 'receipt']);
    assert.deepEqual((f.calls.find(x => x.action === 'commit')!.evidence as { producers: unknown[] }).producers, proof?.producers);
  });
}
test('created-to-exited transition after observation prevents CLI commit', async () => {
  const f = fixture('MARKETAUX_PRODUCER_QUIESCENCE', 'created');
  await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
  const previous = f.host.captureProducerInventory;
  f.host.captureProducerInventory = async () => {
    const inventory = await previous();
    return { ...inventory, producers: inventory.producers.map(({ containerId, imageId, project, service }) => ({ containerId, imageId, project, service,
      state: 'exited' as const, startedAt: '2026-10-19T11:00:00.000Z', finishedAt: '2026-10-19T11:30:00.000Z' })) };
  };
  await assert.rejects(executeRecoveryCommand({ action: 'commit', challengeId: f.challenge.id }, f.deps), /PRODUCER/);
  assert.equal(f.calls.some(x => x.action === 'commit'), false);
});
