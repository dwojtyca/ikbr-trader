import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  OWNER_RECOVERY_SERVICES, ownerRecoveryHash, parseOwnerRecoveryResponse,
  type OwnerRecoveryProfile, type OwnerRecoveryOperation, type OwnerRecoveryOperatorEvidence, type OwnerRecoveryInventory,
  type OwnerRecoveryHostEvidence, type OwnerRecoveryRequest, type OwnerRecoveryResponse, type OwnerRecoveryCoordination, type OwnerRecoveryPreProbeEvidence,
} from '@ikbr/shared/accounting-owner-recovery';
import { runOwnerRecoveryCli, validateOwnerRecoveryRuntime, type OwnerRecoveryCliDependencies } from './owner-recovery-cli.js';

const hash = 'a'.repeat(64), token = 'test-private-authorization-token-32-characters';
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'owner-recovery-cli-')); chmodSync(dir, 0o700);
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const settings = { schemaVersion: 1, sourceKind: 'ibkr-tws-seven-day-v1', environment: 'paper', accountId: 'DU_TEST',
    endpoint: { host: '127.0.0.1', port: 7497 }, sourceClientId: 0, executionTimeZone: 'UTC' };
  const path = join(dir, 'settings.json'), bytes = JSON.stringify(settings); writeFileSync(path, bytes, { mode: 0o600 });
  const settingsHash = createHash('sha256').update(bytes).digest('hex');
  const profile: OwnerRecoveryProfile = { project: 'test', imageId: `sha256:${hash}`, deploymentHash: hash,
    dockerHost: 'unix:///var/run/docker.sock', hostIdHash: hash, settingsHash, accountId: settings.accountId,
    endpoint: { ...settings.endpoint, clientId: 0 } };
  const env: NodeJS.ProcessEnv = { IBKR_ENVIRONMENT: 'paper', TRADING_ENABLED: 'false', ALLOWED_PAPER_ACCOUNTS: settings.accountId,
    IBKR_ACCOUNT_ID: settings.accountId, EXECUTION_API_TOKEN: token, IB_SOCKET_HOST: settings.endpoint.host,
    IB_SOCKET_PORT: String(settings.endpoint.port), EXECUTION_BROKER_TIME_ZONE: 'UTC', EXECUTION_ACCOUNTING_SOURCE_PATH: path,
    EXECUTION_ACCOUNTING_SOURCE_SHA256: settingsHash, ACCOUNTING_OWNER_RECOVERY_PROFILE_JSON: JSON.stringify(profile) };
  const base = Date.now() - 10_000, time = (seconds: number) => new Date(base + seconds * 1000).toISOString();
  const operation: OwnerRecoveryOperation = { version: 1, operationId: randomUUID(), nonce: randomUUID(), state: 'PREPARED',
    owner: { endpointKey: JSON.stringify({ address: 'loopback', port: 7497, clientId: 0 }), ownerId: randomUUID(), generation: 1,
      retirementState: 'UNKNOWN', acquiredAt: time(-30), updatedAt: time(-20) }, profile, pauseRevision: 1, actor: 'test',
    preparedAt: time(-15), expiresAt: time(885), bindingDigest: hash, evidenceDigest: null, successorOperationId: null, receiptId: null };
  const operator: OwnerRecoveryOperatorEvidence = { version: 1, inspectionId: randomUUID(), accountId: profile.accountId,
    endpoint: profile.endpoint, settingsHash, deploymentHash: hash, operator: 'test', observedAt: time(5), product: 'TWS',
    confirmations: { paperAccount: true, accountPositionsFlat: true, accountOpenOrdersAbsent: true, noPendingManualActions: true,
      otherClientsStopped: true, noChangesUntilRecoveryEnds: true, noOtherNativeOrExternalClients: true, noNativeClientLaunchUntilRecoveryEnds: true },
    artifacts: ['account-environment', 'positions', 'open-orders'].map(kind => ({ kind: kind as 'positions', relativePath: `${kind}.txt`, sha256: hash, observedAt: time(5) })) };
  const inventory = (n: number): OwnerRecoveryInventory => ({ observedAt: time(n), producers: [], absentServices: [...OWNER_RECOVERY_SERVICES], nativeProcesses: [], unexpectedNativeCandidates: [], unexpectedSocketPids: [] });
  const replacement = { pid: 12, startIdentity: time(3), executableHash: hash };
  const evidence: OwnerRecoveryHostEvidence = { version: 1, operationId: operation.operationId, nonce: operation.nonce, bindingDigest: hash, profile,
    collectorStartedAt: time(0), before: { observedAt: time(1), process: { pid: 11, startIdentity: time(-10), executableHash: hash } },
    stopped: { observedAt: time(2), processAbsent: true, listenerAbsent: true }, after: { observedAt: time(4), process: replacement },
    current: { observedAt: time(6), process: replacement }, initialInventory: inventory(0), finalInventory: inventory(7),
    dockerEvents: { startedAt: time(0), checkedAt: time(8), continuous: true, noProducerStarts: true },
    clock: { wallStartedAt: time(0), wallCheckedAt: time(9), monotonicElapsedMs: 9000, dbSampleAt: time(8), dbRoundTripMs: 1 },
    operatorEvidence: { ...operator, afterReset: { operationId: operation.operationId, nonce: operation.nonce, process: replacement } } };
  const auth = { version: 1 as const, requestId: randomUUID(), operationId: operation.operationId, actor: 'test', token, profile };
  const begin: Extract<OwnerRecoveryRequest, { action: 'begin-observe' }> = { ...auth, action: 'begin-observe', bindingDigest: hash };
  const prepare: Extract<OwnerRecoveryRequest, { action: 'prepare' }> = { ...auth, action: 'prepare', operatorEvidence: operator, inventory: inventory(6) };
  const sessionId = randomUUID(), calls: string[] = [];
  const dbNow = new Date().toISOString();
  let cancelled = false;
  const observer = {
    operation, observerSessionId: sessionId, dbNow, remainingMs: Date.parse(operation.expiresAt) - Date.parse(dbNow),
    assertActive() { if (cancelled) throw new Error('ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN'); },
    async preDispatch() { calls.push('pre-dispatch'); return randomUUID(); },
    async preProbeClosed() { calls.push('pre-closed'); },
    async dispatch() { calls.push('dispatch'); return randomUUID(); },
    async handshakeClosed() { calls.push('closed'); },
    async finalize(request: Extract<OwnerRecoveryRequest, { action: 'finalize-observation' }>, runtimeGuard?: () => Promise<void>) {
      await runtimeGuard?.();
      calls.push('finalize'); this.assertActive();
      const receiptId = randomUUID(), evidenceDigest = ownerRecoveryHash(request.evidence), at = new Date().toISOString();
      return { operation: { ...operation, state: 'COMMITTED' as const, receiptId, evidenceDigest },
        receipt: { version: operation.version, receiptId, operationId: operation.operationId, commitRequestId: request.commitRequestId,
          owner: operation.owner, bindingDigest: operation.bindingDigest, evidenceDigest, actor: operation.actor, committedAt: at, retiredAt: at,
          retirementState: 'RETIRED' as const, method: operation.version === 2 ? 'API_OBSERVED_LOCAL_TWS_RESET_V2' as const : 'OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1' as const } };
    },
    cancel() { cancelled = true; calls.push('cancel'); }, async release() { calls.push('release'); },
  };
  const input = new PassThrough(), output = new PassThrough(), responses: OwnerRecoveryResponse[] = [];
  output.on('data', chunk => { responses.push(JSON.parse(String(chunk)) as OwnerRecoveryResponse); });
  const deps: OwnerRecoveryCliDependencies = { env, input, output,
    open: async () => { calls.push('open'); return { store: {
      prepare: async () => { calls.push('prepare'); return operation; }, supersede: async () => { calls.push('supersede'); return operation; },
      status: async request => { calls.push(`status:${request.lookupRequestId ?? ''}`); return { operation, receipt: null, maintenancePending: true, pendingOperationId: operation.operationId, events: [], lookup: null }; },
      beginObserve: async () => { calls.push('begin'); return observer; },
    }, close: async () => { calls.push('close'); } }; },
    handshake: async request => { calls.push('handshake'); assert.equal(request.endpoint.host, '127.0.0.1');
      return { accountId: profile.accountId, clientId: 0, protocolVersion: 178, nextValidId: 1,
        connectedAt: time(9), readyAt: time(9), closedAt: time(9), transportClosed: true }; },
  };
  const reset = (): Extract<OwnerRecoveryRequest, { action: 'reset-proof' }> => ({ version: 1, action: 'reset-proof', requestId: randomUUID(), observerSessionId: sessionId, evidence });
  const finalize = (): Extract<OwnerRecoveryRequest, { action: 'finalize-observation' }> => {
    const response = responses.find(r => r.ok && r.action === 'handshake-closed');
    assert.ok(response?.ok && response.action === 'handshake-closed');
    return { version: 1, action: 'finalize-observation', requestId: randomUUID(), observerSessionId: sessionId,
      observedRequestId: randomUUID(), commitRequestId: randomUUID(), handshakeDigest: response.result.handshakeDigest, evidence };
  };
  const start = () => {
    const done = runOwnerRecoveryCli(deps);
    t.after(async () => { input.destroy(); await done; });
    return done;
  };
  const send = async (value: unknown) => { input.write(JSON.stringify(value) + '\n'); await immediate(); };
  return { deps, env, profile, path, operation, begin, prepare, observer, calls, input, output, responses, reset, finalize, start, send };
}

test('authenticated offline prepare validates current settings without starting any handshake', async t => {
  const f = fixture(t), done = f.start(); await f.send(f.prepare);
  assert.equal(await done, 0, JSON.stringify({ calls: f.calls, responses: f.responses })); assert.deepEqual(f.calls, ['open', 'prepare', 'close']); assert.equal(f.responses[0].ok, true);
});

test('wrong token, live, enabled master, multiple/wrong accounts and mismatched settings deny before DB open', async t => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.prepare.token = 'wrong'.repeat(8); }, f => { f.env.EXECUTION_API_TOKEN = 'short'; },
    f => { f.env.IBKR_ENVIRONMENT = 'live'; }, f => { delete f.env.TRADING_ENABLED; }, f => { f.env.TRADING_ENABLED = 'true'; },
    f => { f.env.ALLOWED_PAPER_ACCOUNTS += ',OTHER'; }, f => { f.env.IBKR_ACCOUNT_ID = 'OTHER'; },
    f => { f.env.EXECUTION_ACCOUNTING_SOURCE_SHA256 = hash; }, f => { f.env.EXECUTION_CLIENT_ID = '0'; },
    f => { f.env.ACCOUNTING_OWNER_RECOVERY_PROFILE_JSON = JSON.stringify({ ...f.profile, deploymentHash: 'b'.repeat(64) }); },
    f => { chmodSync(f.path, 0o644); },
  ];
  for (const change of changes) {
    const f = fixture(t); change(f); const done = f.start(); await f.send(f.prepare);
    assert.equal(await done, 1); assert.deepEqual(f.calls, []); assert.equal(f.responses[0]?.ok, false);
    assert.equal(JSON.stringify(f.responses).includes(token), false);
  }
});

test('complete live child keeps observer lock through one handshake and exact finalize before unlock', async t => {
  const f = fixture(t), done = f.start(); await f.send(f.begin); await f.send(f.reset()); await f.send(f.finalize());
  assert.equal(await done, 0);
  assert.deepEqual(f.calls, ['open', 'begin', 'dispatch', 'handshake', 'closed', 'finalize', 'release', 'close']);
  assert.deepEqual(f.responses.map(response => response.ok ? response.action : 'error'), ['observer-ready', 'handshake-closed', 'committed']);
});

test('backend observer-ready preserves the shared deadline contract after nonzero begin-observe elapsed time', async t => {
  const f = fixture(t), open = f.deps.open, ready = deferred<OwnerRecoveryResponse>();
  let elapsed = 0;
  f.deps.open = async action => {
    const backend = await open(action);
    backend.store.beginObserve = async () => {
      f.calls.push('begin');
      const started = performance.now();
      await new Promise(resolve => setTimeout(resolve, 25));
      elapsed = performance.now() - started;
      return f.observer;
    };
    return backend;
  };
  f.output.once('data', data => { ready.resolve(parseOwnerRecoveryResponse(JSON.parse(String(data)))); });
  const done = f.start(); await f.send(f.begin);
  const response = await ready.promise;
  assert.ok(elapsed >= 1);
  assert.ok(response.ok && response.action === 'observer-ready', JSON.stringify(response));
  assert.equal(response.result.dbNow, f.observer.dbNow);
  assert.equal(response.result.remainingMs, Date.parse(f.operation.expiresAt) - Date.parse(response.result.dbNow));
  assert.equal(response.result.operation.expiresAt, f.operation.expiresAt);
  await immediate(); await f.send(f.reset()); await f.send(f.finalize());
  assert.equal(await done, 0);
});

test('begin-observe latency exhausts the original backend budget before any ready response or handshake', async t => {
  const f = fixture(t), open = f.deps.open;
  f.operation.expiresAt = new Date(Date.parse(f.observer.dbNow) + 10).toISOString();
  f.operation.preparedAt = new Date(Date.parse(f.operation.expiresAt) - 900_000).toISOString();
  f.observer.remainingMs = 10;
  f.deps.open = async action => {
    const backend = await open(action);
    backend.store.beginObserve = async () => {
      f.calls.push('begin');
      await new Promise(resolve => setTimeout(resolve, 25));
      return f.observer;
    };
    return backend;
  };
  const done = f.start(); await f.send(f.begin);
  assert.equal(await done, 1);
  assert.equal(f.responses.some(response => response.ok), false);
  assert.equal(f.responses[0]?.ok === false && f.responses[0].error.code, 'ACCOUNTING_OWNER_RECOVERY_OBSERVATION_EXPIRED');
  assert.equal(f.calls.includes('handshake'), false);
  assert.ok(f.calls.includes('cancel')); assert.ok(f.calls.includes('release'));
});

test('malformed frames, extra fields, unsupported commit, oversized messages and pipelining revoke without DB access', async t => {
  for (const value of ['{bad}\n', '{"action":"commit"}\n', `${'x'.repeat(65536)}\n`, '\ufffd\n']) {
    const f = fixture(t), done = f.start(); f.input.write(value); assert.equal(await done, 1); assert.deepEqual(f.calls, []);
  }
  for (const mode of ['extra', 'pipeline']) {
    const f = fixture(t), done = f.start();
    f.input.write(mode === 'extra' ? JSON.stringify({ ...f.prepare, extra: true }) + '\n' : (JSON.stringify(f.prepare) + '\n').repeat(2));
    assert.equal(await done, 1); assert.deepEqual(f.calls, []);
  }
});

test('EOF during asynchronous initial validation cannot authorize prepare afterward', async t => {
  const f = fixture(t), gate = deferred<{ key: string; endpoint: { host: string; port: number } }>(); f.deps.resolveEndpoint = () => gate.promise;
  const done = f.start(); f.input.write(JSON.stringify(f.prepare) + '\n'); f.input.end(); await immediate();
  gate.resolve({ key: f.operation.owner.endpointKey, endpoint: f.profile.endpoint }); assert.equal(await done, 1); assert.deepEqual(f.calls, []);
});

test('EOF while begin-observe resolves late synchronously revokes the returned observer', async t => {
  const f = fixture(t), gate = deferred<void>(), open = f.deps.open;
  f.deps.open = async action => { const backend = await open(action); backend.store.beginObserve = async () => { f.calls.push('begin'); await gate.promise; return f.observer; }; return backend; };
  const done = f.start(); await f.send(f.begin); f.input.end(); await immediate(); gate.resolve();
  assert.equal(await done, 1); assert.ok(f.calls.includes('cancel')); assert.equal(f.calls.includes('handshake'), false); assert.equal(f.responses.length, 0);
});

test('EOF aborts owned handshake and its late success cannot persist closure or finalize', async t => {
  const f = fixture(t), gate = deferred<void>(); let signal: AbortSignal | undefined;
  const handshake = f.deps.handshake!;
  f.deps.handshake = async request => { signal = request.signal; await gate.promise; return handshake(request); };
  const done = f.start(); await f.send(f.begin); await f.send(f.reset()); f.input.end(); await immediate();
  assert.equal(signal?.aborted, true); assert.ok(f.calls.includes('cancel')); gate.resolve();
  assert.equal(await done, 1); assert.equal(f.calls.includes('closed'), false); assert.equal(f.calls.includes('finalize'), false);
});

test('duplicate/out-of-order frames and wrong observer capability never perform a second handshake', async t => {
  for (const mode of ['duplicate', 'out-of-order', 'session', 'second-handshake']) {
    const f = fixture(t), done = f.start(); await f.send(f.begin);
    if (mode === 'duplicate') await f.send({ ...f.reset(), requestId: f.begin.requestId });
    if (mode === 'out-of-order') await f.send(f.prepare);
    if (mode === 'session') await f.send({ ...f.reset(), observerSessionId: randomUUID() });
    if (mode === 'second-handshake') { await f.send(f.reset()); await f.send(f.reset()); }
    assert.equal(await done, 1); assert.ok(f.calls.filter(call => call === 'handshake').length <= 1); assert.equal(f.calls.includes('finalize'), false);
  }
});

test('current settings, authorization and DNS are revalidated before dispatch and finalization', async t => {
  for (const stage of ['settings', 'token', 'dns', 'finalize']) {
    const f = fixture(t), done = f.start(); await f.send(f.begin);
    if (stage === 'finalize') await f.send(f.reset());
    if (stage === 'settings' || stage === 'finalize') writeFileSync(f.path, '{}', { mode: 0o600 });
    if (stage === 'token') f.env.EXECUTION_API_TOKEN = 'different'.repeat(8);
    if (stage === 'dns') f.deps.resolveEndpoint = async () => ({ key: JSON.stringify({ address: '192.0.2.1', port: 7497, clientId: 0 }), endpoint: { host: '192.0.2.1', port: 7497 } });
    await f.send(stage === 'finalize' ? f.finalize() : f.reset()); assert.equal(await done, 1);
    assert.equal(f.calls.includes('finalize'), false); if (stage !== 'finalize') assert.equal(f.calls.includes('dispatch'), false);
  }
});

test('late EOF during finalize revokes the in-flight mutation and never claims success', async t => {
  const f = fixture(t), gate = deferred<void>(), finalize = f.observer.finalize.bind(f.observer);
  f.observer.finalize = async request => { await gate.promise; return finalize(request); };
  const done = f.start(); await f.send(f.begin); await f.send(f.reset()); await f.send(f.finalize());
  f.input.end(); await immediate(); assert.ok(f.calls.includes('cancel')); gate.resolve();
  assert.equal(await done, 1); assert.equal(f.responses.some(r => r.ok && r.action === 'committed'), false);
});

test('unknown commit and unacknowledged unlock do not claim retirement success or retry', async t => {
  for (const failureStage of ['commit', 'unlock']) {
    const f = fixture(t);
    if (failureStage === 'commit') f.observer.finalize = async () => { f.calls.push('unknown-commit'); throw new Error('transport lost'); };
    else f.observer.release = async () => { f.calls.push('unlock-unknown'); throw new Error('unlock lost'); };
    const done = f.start(); await f.send(f.begin); await f.send(f.reset()); await f.send(f.finalize());
    assert.equal(await done, 1); assert.equal(f.responses.some(r => r.ok && r.action === 'committed'), false);
    assert.equal(f.calls.filter(call => call === 'handshake').length, 1);
  }
});

test('status permits historical deployment evidence and passes exact unknown request identity to readback', async t => {
  const f = fixture(t), lookupRequestId = randomUUID();
  const open = f.deps.open;
  f.deps.open = action => { assert.equal(action, 'status'); return open(action); };
  f.env.TRADING_ENABLED = 'true';
  delete f.env.EXECUTION_ACCOUNTING_SOURCE_PATH; f.env.ACCOUNTING_OWNER_RECOVERY_PROFILE_JSON = '{}';
  const status: Extract<OwnerRecoveryRequest, { action: 'status' }> = { ...f.prepare, action: 'status', lookupRequestId };
  delete (status as unknown as Record<string, unknown>).operatorEvidence; delete (status as unknown as Record<string, unknown>).inventory;
  const done = f.start(); await f.send(status); assert.equal(await done, 0);
  assert.deepEqual(f.calls, ['open', `status:${lookupRequestId}`, 'close']);
});

test('output backpressure and external signal synchronously revoke and close the observer', async t => {
  for (const mode of ['backpressure', 'signal']) {
    const f = fixture(t), controller = new AbortController(); f.deps.signal = controller.signal;
    if (mode === 'backpressure') f.deps.output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { setImmediate(callback); } });
    const done = f.start(); await f.send(f.begin); if (mode === 'signal') controller.abort();
    assert.equal(await done, 1); assert.ok(f.calls.includes('cancel')); assert.ok(f.calls.includes('release')); assert.equal(f.calls.includes('handshake'), false);
  }
});

test('mapped diagnostics preserve sanitized original cause without token or account', async t => {
  const f = fixture(t); f.deps.open = async () => { throw Object.assign(new Error(`failed ${token} ${f.profile.accountId}`), { name: 'DatabaseError', code: 'ECONNRESET' }); };
  const done = f.start(); await f.send(f.prepare); assert.equal(await done, 1);
  const response = f.responses[0]; assert.equal(response.ok, false);
  if (!response.ok) { assert.equal(response.error.cause?.name, 'DatabaseError'); assert.equal(response.error.cause?.code, 'ECONNRESET'); assert.equal(response.error.cause?.message, 'failed [UKRYTO] [UKRYTO]'); }
});

test('runtime endpoint pinning uses canonical transport address and rejects unresolved aliases', async t => {
  const f = fixture(t);
  const result = await validateOwnerRecoveryRuntime(f.prepare, f.env, async () => ({ key: JSON.stringify({ address: '192.0.2.4', port: 7497, clientId: 0 }), endpoint: { host: '192.0.2.4', port: 7497 } }));
  assert.equal(result?.endpoint.host, '192.0.2.4');
  await assert.rejects(validateOwnerRecoveryRuntime(f.prepare, f.env, async () => { throw new Error('ambiguous DNS'); }), /SETTINGS_MISMATCH/);
});

test('normal peer EOF after confirmed response permits one-shot and observation success', async t => {
  for (const mode of ['prepare', 'observe']) {
    const f = fixture(t);
    f.output.on('data', data => {
      const result = JSON.parse(String(data)) as OwnerRecoveryResponse;
      if (result.ok && ['prepared', 'committed'].includes(result.action)) f.input.end();
    });
    const done = f.start();
    if (mode === 'prepare') await f.send(f.prepare);
    else { await f.send(f.begin); await f.send(f.reset()); await f.send(f.finalize()); }
    assert.equal(await done, 0); assert.equal(f.input.isPaused(), true);
  }
});

test('store callback revalidates runtime during finalization before subsequent mutation', async t => {
  const f = fixture(t), finalize = f.observer.finalize.bind(f.observer);
  f.observer.finalize = async (request, guard) => {
    assert.ok(guard); await guard(); f.env.TRADING_ENABLED = 'true';
    return finalize(request, guard);
  };
  const done = f.start(); await f.send(f.begin); await f.send(f.reset()); await f.send(f.finalize());
  assert.equal(await done, 1); assert.equal(f.calls.includes('finalize'), false);
  assert.equal(f.responses.some(response => !response.ok && response.error.code === 'ACCOUNTING_OWNER_RECOVERY_DISABLED_PAPER_REQUIRED'), true);
});

test('transport rejection and false closure cannot persist handshake evidence', async t => {
  for (const mode of ['reject', 'closure', 'account']) {
    const f = fixture(t), handshake = f.deps.handshake!;
    f.deps.handshake = async request => {
      if (mode === 'reject') throw new Error('ACCOUNTING_OWNER_RECOVERY_HANDSHAKE_UNKNOWN');
      const result = await handshake(request);
      if (mode === 'closure') return { ...result, transportClosed: false } as unknown as typeof result;
      return { ...result, accountId: 'OTHER' };
    };
    const done = f.start(); await f.send(f.begin); await f.send(f.reset());
    assert.equal(await done, 1); assert.equal(f.calls.includes('closed'), false); assert.equal(f.calls.includes('finalize'), false);
  }
});

test('actual offline entrypoint rejects unauthenticated stdin and exits with its input pipe still open', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./owner-recovery-cli.ts', import.meta.url))], {
    env: { ...f.env, POSTGRES_URL: 'postgres://invalid:invalid@127.0.0.1:1/never_connect' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += String(value); }); child.stderr.on('data', value => { stderr += String(value); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdin.write(JSON.stringify({ ...f.prepare, token: 'wrong'.repeat(8) }) + '\n');
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  clearTimeout(timeout);
  assert.equal(code, 1, stderr); assert.equal(JSON.parse(stdout).error.code, 'ACCOUNTING_OWNER_RECOVERY_AUTH_REQUIRED');
  assert.equal(JSON.parse(stdout).error.cause, undefined);
  assert.equal(stdout.includes(token), false); assert.equal(stderr, '');
});

function fixtureV2(t: { after: (fn: () => void | Promise<void>) => void }) {
  const f = fixture(t), old = f.reset().evidence;
  assert.equal(old.version, 1);
  const at = f.operation.preparedAt, process = { ...old.before.process, startIdentity: new Date(Date.parse(at) - 1000).toISOString() };
  const declaration = { confirmed: true as const, source: 'carried-owner-authorization' as const, actor: 'owner', sourceReference: 'session', observedAt: at };
  const coordination: OwnerRecoveryCoordination = { version: 2, coordinationId: randomUUID(), actor: f.operation.actor, accountId: f.profile.accountId,
    endpoint: f.profile.endpoint, settingsHash: f.profile.settingsHash, deploymentHash: f.profile.deploymentHash, recordedAt: at, authorizationReference: 'session',
    declarations: { noPendingManualActionsOrDrafts: declaration, noOtherNativeOrExternalClients: declaration, noChangesOrClientLaunchesUntilRecoveryEnds: declaration },
    environmentEvidence: { version: 2, inspectionId: randomUUID(), actor: 'observing-agent', provenance: 'agent-ui-observation', accountId: f.profile.accountId,
      endpoint: f.profile.endpoint, settingsHash: f.profile.settingsHash, deploymentHash: f.profile.deploymentHash, observedAt: at, process,
      product: 'TWS', environment: 'paper', artifact: { relativePath: 'paper.txt', sha256: hash, observedAt: at } } };
  f.operation.version = 2; f.operation.coordination = coordination;
  const before = { ...old.before, process }, environmentEvidence = { ...coordination.environmentEvidence, process: old.after.process, observedAt: old.after.observedAt,
    artifact: { ...coordination.environmentEvidence.artifact, observedAt: old.after.observedAt }, afterReset: { operationId: f.operation.operationId, nonce: f.operation.nonce } };
  const { operatorEvidence: _operator, ...base } = old as OwnerRecoveryHostEvidence;
  const proof = { ...base, version: 2 as const, before, coordinationDigest: ownerRecoveryHash(coordination), preResetProbeDigest: hash, environmentEvidence };
  const preEvidence: OwnerRecoveryPreProbeEvidence = { version: 2, operationId: f.operation.operationId, nonce: f.operation.nonce, bindingDigest: f.operation.bindingDigest,
    profile: f.profile, coordinationDigest: ownerRecoveryHash(coordination), before, inventory: old.initialInventory, environmentEvidence: coordination.environmentEvidence };
  const pre = () => ({ version: 2 as const, action: 'pre-reset-probe' as const, requestId: randomUUID(), observerSessionId: f.observer.observerSessionId, evidence: preEvidence });
  f.deps.probe = async () => {
    f.calls.push('probe'); const now = new Date().toISOString();
    return { accountId: f.profile.accountId, clientId: 0, protocolVersion: 180, sdkVersion: '@stoqey/ib@1.6.10', connectedAt: now, readyAt: now,
      positionsRequestedAt: now, openOrdersRequestedAt: now, positionsEndAt: now, openOrdersEndAt: now, completedAt: now, closedAt: now,
      transportClosed: true, positionRows: 0, openOrderRows: 0, eventCount: 4, rowsDigest: hash, outcome: 'FLAT', error: null };
  };
  const reset = () => {
    const closed = f.responses.find(r => r.ok && r.action === 'pre-reset-probe-closed');
    if (closed?.ok && closed.action === 'pre-reset-probe-closed') proof.preResetProbeDigest = closed.result.probeDigest;
    return { version: 2 as const, action: 'reset-proof' as const, requestId: randomUUID(), observerSessionId: f.observer.observerSessionId, evidence: proof };
  };
  const finalize = () => {
    const closed = f.responses.find(r => r.ok && r.action === 'handshake-closed');
    assert.ok(closed?.ok && closed.action === 'handshake-closed');
    return { version: 2 as const, action: 'finalize-observation' as const, requestId: randomUUID(), observerSessionId: f.observer.observerSessionId,
      observedRequestId: randomUUID(), commitRequestId: randomUUID(), handshakeDigest: closed.result.handshakeDigest, evidence: proof };
  };
  return { ...f, begin: { ...f.begin, version: 2 as const }, pre, reset, finalize };
}

test('V2 backend owns both closed probes and cannot finalize before its witnessed reset phase', async t => {
  const f = fixtureV2(t), done = f.start();
  await f.send(f.begin); await f.send(f.pre()); await f.send(f.reset()); await f.send(f.finalize());
  assert.equal(await done, 0, JSON.stringify(f.responses));
  assert.deepEqual(f.calls, ['open', 'begin', 'pre-dispatch', 'probe', 'pre-closed', 'dispatch', 'probe', 'closed', 'finalize', 'release', 'close']);
  assert.ok(!f.calls.includes('handshake'));
  const receipt = f.responses.at(-1); assert.ok(receipt?.ok && receipt.action === 'committed'); assert.equal(receipt.result.receipt.version, 2);
});

test('V2 positively closed failed probe is recorded but never authorizes reset', async t => {
  for (const outcome of ['NONFLAT', 'INCOMPLETE'] as const) {
    const f = fixtureV2(t), probe = f.deps.probe!;
    f.deps.probe = async (...args) => ({ ...await probe(...args), outcome, error: { code: 'ACCOUNTING_OWNER_RECOVERY_PROBE_FAILED', cause: { name: 'ProviderError', code: '326', message: 'safe detail' } } });
    const done = f.start(); await f.send(f.begin); await f.send(f.pre());
    assert.equal(await done, 1); assert.ok(f.calls.includes('pre-closed')); assert.ok(!f.calls.includes('dispatch'));
    assert.equal(f.calls.filter(c => c === 'probe').length, 1);
    assert.ok(!f.responses.some(r => r.ok && r.action === 'pre-reset-probe-closed'));
  }
});

test('V2 unknown closure and EOF cannot persist a late successful probe or repeat it', async t => {
  for (const scenario of ['unknown', 'eof'] as const) {
    const f = fixtureV2(t), probe = f.deps.probe!, pending = deferred<Awaited<ReturnType<typeof probe>>>();
    if (scenario === 'unknown') f.deps.probe = async () => { f.calls.push('probe'); throw new Error('ACCOUNTING_OWNER_RECOVERY_CLOSURE_UNKNOWN'); };
    else f.deps.probe = async () => { f.calls.push('pending-probe'); return pending.promise; };
    const done = f.start(); await f.send(f.begin); await f.send(f.pre());
    if (scenario === 'eof') { f.input.end(); await immediate(); pending.resolve(await probe({ endpoint: f.profile.endpoint, accountId: f.profile.accountId })); }
    assert.equal(await done, 1); assert.ok(!f.calls.includes('pre-closed')); assert.ok(!f.calls.includes('dispatch'));
  }
});

test('V2 rejects reset before preprobe, wrong-version reset and duplicate preprobe without another socket', async t => {
  for (const scenario of ['early-reset', 'v1-reset', 'duplicate-pre'] as const) {
    const f = fixtureV2(t), done = f.start(); await f.send(f.begin);
    if (scenario !== 'early-reset') await f.send(f.pre());
    await f.send(scenario === 'duplicate-pre' ? f.pre() : scenario === 'v1-reset' ? { ...f.reset(), version: 1 } : f.reset());
    assert.equal(await done, 1); assert.ok(!f.calls.includes('dispatch')); assert.ok(f.calls.filter(c => c === 'probe').length <= 1);
  }
});

test('V2 lost response after durable closed proof does not retry and preserves failure status', async t => {
  const f = fixtureV2(t), closed = f.observer.preProbeClosed.bind(f.observer);
  f.observer.preProbeClosed = async () => { await closed(); f.output.destroy(); };
  const done = f.start(); await f.send(f.begin); await f.send(f.pre());
  assert.equal(await done, 1); assert.ok(f.calls.includes('pre-closed')); assert.equal(f.calls.filter(c => c === 'probe').length, 1);
  assert.ok(!f.responses.some(r => r.ok && r.action === 'pre-reset-probe-closed'));
});

test('V2 rechecks remaining full probe budget after durable dispatch work', async t => {
  const f = fixtureV2(t), remaining = 20015, now = new Date().toISOString();
  f.operation.expiresAt = new Date(Date.parse(now) + remaining).toISOString();
  f.operation.preparedAt = new Date(Date.parse(f.operation.expiresAt) - 900000).toISOString();
  // Preserve the original coordination chronology when moving the synthetic deadline.
  f.operation.coordination!.recordedAt = f.operation.preparedAt;
  for (const d of Object.values(f.operation.coordination!.declarations)) d.observedAt = f.operation.preparedAt;
  const env = f.operation.coordination!.environmentEvidence; env.observedAt = f.operation.preparedAt; env.artifact.observedAt = f.operation.preparedAt;
  env.process.startIdentity = new Date(Date.parse(f.operation.preparedAt) - 1000).toISOString();
  f.observer.dbNow = now; f.observer.remainingMs = remaining;
  f.observer.preDispatch = async () => { f.calls.push('pre-dispatch'); await new Promise(resolve => setTimeout(resolve, 25)); return randomUUID(); };
  const done = f.start(); await f.send(f.begin); await f.send(f.pre());
  assert.equal(await done, 1); assert.ok(f.calls.includes('pre-dispatch')); assert.ok(!f.calls.includes('probe'));
});
