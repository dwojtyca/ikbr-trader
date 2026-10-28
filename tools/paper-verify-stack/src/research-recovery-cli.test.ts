import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { researchHash, type RecoveryChallenge, type RecoveryProducer, recoveryFailureOutput, recoveryDiagnosticFailure,
  formatRecoveryFailure } from '@ikbr/shared/instrument-research';
import { executeRecoveryCommand, decodeRecoveryOneShot, runRecoveryOneShot, type RecoveryCliDependencies, type RecoveryProfile } from './research-recovery-cli.js';

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

test('host phases retain original inspection failure and never proceed to handshake or successful evidence', async () => {
  const cases = [
    ['captureProducerInventory', 'producer-inventory'], ['captureGatewayProcess', 'gateway-before'],
    ['assertGatewayStopped', 'gateway-stop'], ['verifyGatewayReplacement', 'gateway-replacement'],
    ['verifyProducerInventory', 'producer-recheck'], ['hostIdentityHash', 'host-identity'],
  ] as const;
  for (const [method, stage] of cases) {
    const f = fixture('WSH_ENDPOINT_RESET');
    f.profile.diagnosticPrivacy = { secrets: ['private-fixture'], accountIds: ['DUO_FIXTURE'] };
    const native = { name: 'NativeInspectionError', code: 'EINSPECT', message: 'unavailable private-fixture DUO_FIXTURE' };
    f.host[method] = async () => { throw new Error('RESEARCH_RECOVERY_INSPECTION_UNAVAILABLE', { cause: native }); };
    await assert.rejects(executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps), error => {
      const d = recoveryFailureOutput(error, 'arguments').diagnostic;
      assert.equal(d.stage, stage); assert.equal(d.original.code, 'EINSPECT');
      assert.ok(!JSON.stringify(d).includes('private-fixture')); assert.ok(!JSON.stringify(d).includes('DUO_FIXTURE')); return true;
    });
    assert.equal(f.state.get(f.challenge.id)?.evidence, undefined);
    assert.equal(f.calls.filter(c => c.action === 'reconnect').length, ['producer-recheck', 'host-identity'].includes(stage) ? 1 : 0);
    assert.equal(f.calls.some(c => c.action === 'commit'), false);
  }
});

test('failed one-shot handshake preserves child stage without retrying or saving evidence', async () => {
  const f = fixture('WSH_ENDPOINT_RESET'), before = f.deps.oneShot;
  const wire = JSON.stringify(recoveryFailureOutput(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }), 'reconnect-connect'));
  f.deps.oneShot = async (p, input) => {
    if ((input as { action: string }).action === 'reconnect') { f.calls.push(input as Record<string, unknown>); return decodeRecoveryOneShot(wire, 1, false); }
    return before(p, input);
  };
  await assert.rejects(executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps), error => {
    assert.match(formatRecoveryFailure(error, 'arguments'), /reconnect-connect.*ECONNRESET/); return true;
  });
  assert.equal(f.calls.filter(c => c.action === 'reconnect').length, 1); assert.equal(f.state.get(f.challenge.id)?.evidence, undefined);
});

test('malformed local state never exposes JSON parser body excerpts', async () => {
  const f = fixture(); f.deps.load = async () => JSON.parse('RAW_STATE_SENTINEL');
  await assert.rejects(executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps), error => {
    const d = recoveryFailureOutput(error, 'arguments').diagnostic;
    assert.equal(d.stage, 'state-load'); assert.equal(d.original.name, 'SyntaxError'); assert.equal(d.original.message, null);
    assert.ok(!JSON.stringify(d).includes('RAW_STATE')); return true;
  });
  assert.equal(f.calls.length, 0);
});

test('production-style wrapped profile failure identifies recheck and preserves its original cause', async () => {
  const f = fixture('WSH_ENDPOINT_RESET'); let reads = 0;
  f.deps.profile = async () => {
    if (++reads > 1) throw recoveryDiagnosticFailure(Object.assign(new Error('profile inspection failed'), { code: 'EIO' }), 'profile');
    return f.profile;
  };
  await assert.rejects(executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps), error => {
    const d = recoveryFailureOutput(error, 'arguments').diagnostic;
    assert.equal(d.stage, 'profile-recheck'); assert.equal(d.original.code, 'EIO'); assert.equal(d.original.message, 'profile inspection failed'); return true;
  });
  assert.equal(reads, 2); assert.equal(f.calls.filter(c => c.action === 'reconnect').length, 0);
  assert.equal(f.state.get(f.challenge.id)?.evidence, undefined);
});

test('first mutation diagnostic survives failed exact readback without another mutation', async () => {
  for (const action of ['prepare', 'supersede', 'commit'] as const) for (const readback of ['throws', 'null', 'mismatch'] as const) {
    const f = fixture();
    if (action === 'commit') await executeRecoveryCommand({ action: 'observe', challengeId: f.challenge.id }, f.deps);
    const base = f.deps.oneShot; let submitted = 0;
    f.deps.oneShot = async (p, input) => {
      const operation = input as { action: string };
      if (operation.action === action) { submitted++; throw recoveryDiagnosticFailure(Object.assign(new Error('first native failure'), { code: 'EFIRST' }), action); }
      if (submitted) {
        if (readback === 'throws') throw new Error('second readback failure');
        return readback === 'null' ? null : { invalid: true };
      }
      return base(p, input);
    };
    const command = action === 'prepare' ? { action, kind: f.challenge.kind, instrumentId: f.challenge.instrumentId }
      : { action, challengeId: f.challenge.id, ...(action === 'supersede' ? { instrumentId: f.challenge.instrumentId } : {}) };
    await assert.rejects(executeRecoveryCommand(command, f.deps), error => {
      const output = recoveryFailureOutput(error, 'arguments');
      assert.equal(output.reason, 'RESEARCH_RECOVERY_FAILED_OR_UNKNOWN'); assert.equal(output.diagnostic.stage, action);
      assert.equal(output.diagnostic.original.code, 'EFIRST'); assert.equal(output.diagnostic.original.message, 'first native failure'); return true;
    });
    assert.equal(submitted, 1);
  }
});

test('child failure decoder never prints raw output and preserves success compatibility', () => {
  const failure = recoveryFailureOutput(Object.assign(new Error('native detail'), { code: 'EIO' }), 'reconnect-close');
  for (const output of ['raw-provider-payload', '{bad json', JSON.stringify({ ok: false, reason: 'RESEARCH_RECOVERY_FAILED_OR_UNKNOWN' }),
    JSON.stringify({ ...failure, rawPayload: 'private' }), JSON.stringify({ ...failure, diagnostic: { ...failure.diagnostic, stage: 'invented' } }),
    JSON.stringify({ ...failure, diagnostic: { ...failure.diagnostic, original: { ...failure.diagnostic.original, message: 'x'.repeat(1001) } } }),
    'x'.repeat(131073)]) {
    assert.throws(() => decodeRecoveryOneShot(output, 1, false), error => {
      const d = recoveryFailureOutput(error, 'arguments').diagnostic;
      assert.equal(d.stage, 'subprocess'); assert.equal(d.original.message, null);
      assert.ok(!JSON.stringify(d).includes('raw-provider-payload')); return true;
    });
  }
  assert.deepEqual(decodeRecoveryOneShot(JSON.stringify({ ok: true, result: { unchanged: true } }), 0, false), { unchanged: true });
  for (const [code, failed] of [[0, true], [1, false], [null, true]] as const)
    assert.throws(() => decodeRecoveryOneShot(JSON.stringify({ ok: true, result: {} }), code, failed));
  assert.throws(() => decodeRecoveryOneShot(JSON.stringify(failure), 1, false), error => {
    assert.equal(recoveryFailureOutput(error, 'arguments').diagnostic.stage, 'reconnect-close'); return true;
  });
});

test('actual backend failure crosses subprocess boundary and host formatter without raw output', async () => {
  const f = fixture();
  const script = `
    import { mkdtemp, writeFile, rm } from 'node:fs/promises';
    import { readFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { randomUUID } from 'node:crypto';
    import { twoSourceResearchFixture } from '@ikbr/shared/instrument-research-testfixture';
    import { recoveryFailureOutput } from '@ikbr/shared/instrument-research';
    import { executeResearchRecovery } from './src/research-recovery-cli.ts';
    const f = twoSourceResearchFixture(), directory = await mkdtemp(join(tmpdir(), 'recovery-wire-'));
    try {
      const path = join(directory, 'research.json'); await writeFile(path, JSON.stringify(f.manifest));
      const env = { IBKR_ENVIRONMENT: 'paper', ALLOWED_PAPER_ACCOUNTS: 'DUO_WIRE_FIXTURE', ALLOWED_LIVE_ACCOUNTS: '',
        IBKR_ACCOUNT_ID: 'DUO_WIRE_FIXTURE', RESEARCH_BUDGET_ACCOUNT_ID: 'DUO_WIRE_FIXTURE', TRADING_ENABLED: 'false',
        EXECUTION_API_TOKEN: 'wire-token/secret', TRADING_CONFIG_MODE: 'bundle', TRADING_CONFIG_PATH: '/fixture.json',
        TRADING_CONFIG_EXPECTED_HASH: f.configHash, RESEARCH_CONFIG_PATH: path, RESEARCH_CONFIG_EXPECTED_HASH: f.manifestHash };
      try {
        await executeResearchRecovery({ action: 'prepare', kind: 'WSH_ENDPOINT_RESET', instrumentId: f.policy.instrumentId, operationId: randomUUID() }, env,
          { store: {}, readFile: () => readFileSync('../../packages/shared/src/trading-configuration/fixtures/valid-generic.json', 'utf8'),
            read: async () => { throw Object.assign(new Error('read failed DUO_WIRE_FIXTURE wire-token/secret'), { name: 'WireReadError', code: 'ECONNRESET' }); } });
      } catch (error) { process.stdout.write(JSON.stringify(recoveryFailureOutput(error, 'request'))); process.exitCode = 1; }
      process.stderr.write('RAW_PROVIDER_SENTINEL');
    } finally { await rm(directory, { recursive: true, force: true }); }
  `;
  const launcher = (() => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../apps/llm-agent', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'],
  }));
  await assert.rejects(runRecoveryOneShot(f.profile, {}, undefined, launcher), error => {
    const output = formatRecoveryFailure(error, 'arguments');
    assert.match(output, /preflight.*WireReadError.*ECONNRESET/);
    for (const forbidden of ['DUO_WIRE_FIXTURE', 'wire-token/secret', 'RAW_PROVIDER_SENTINEL']) assert.ok(!output.includes(forbidden));
    return true;
  });
});

test('subprocess spawn failure is diagnosed without touching Docker or forwarding stdout', async () => {
  const f = fixture();
  const launcher = (() => spawn('/nonexistent/recovery-fixture-command', [], { stdio: ['pipe', 'pipe', 'pipe'] }));
  await assert.rejects(runRecoveryOneShot(f.profile, {}, undefined, launcher), error => {
    const d = recoveryFailureOutput(error, 'arguments').diagnostic;
    assert.equal(d.stage, 'subprocess'); assert.equal(d.original.code, 'ENOENT'); return true;
  });
});

test('existing subprocess timeout is identified without extending it or spawning again', async t => {
  const f = fixture(); let launches = 0;
  const launcher = (() => { launches++; return spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(() => {}, 10000)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = runRecoveryOneShot(f.profile, {}, undefined, launcher);
    t.mock.timers.tick(30000);
    await assert.rejects(pending, error => {
      const d = recoveryFailureOutput(error, 'arguments').diagnostic;
      assert.equal(d.stage, 'subprocess'); assert.equal(d.reason, 'RESEARCH_RECOVERY_SUBPROCESS_TIMEOUT'); return true;
    });
    assert.equal(launches, 1);
  } finally { t.mock.timers.reset(); }
});
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
