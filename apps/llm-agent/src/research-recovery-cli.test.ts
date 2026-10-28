import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { twoSourceResearchFixture } from '@ikbr/shared/instrument-research-testfixture';
import { type RecoveryChallenge, type RecoveryIdentity, recoveryFailureOutput } from '@ikbr/shared/instrument-research';
import { executeResearchRecovery, recoveryAuthenticatedRead } from './research-recovery-cli.js';

async function fixture() {
  const f = twoSourceResearchFixture(), directory = await mkdtemp(join(tmpdir(), 'research-recovery-'));
  const researchPath = join(directory, 'research.json'); await writeFile(researchPath, JSON.stringify(f.manifest));
  const token = 'recovery-fixture-secret';
  const env: NodeJS.ProcessEnv = { IBKR_ENVIRONMENT: 'paper', ALLOWED_PAPER_ACCOUNTS: 'DU_SYNTHETIC', ALLOWED_LIVE_ACCOUNTS: '',
    IBKR_ACCOUNT_ID: 'DU_SYNTHETIC', RESEARCH_BUDGET_ACCOUNT_ID: 'DU_SYNTHETIC', TRADING_ENABLED: 'false', EXECUTION_API_TOKEN: token,
    TRADING_CONFIG_MODE: 'bundle', TRADING_CONFIG_PATH: '/fixture.json', TRADING_CONFIG_EXPECTED_HASH: f.configHash,
    RESEARCH_CONFIG_PATH: researchPath, RESEARCH_CONFIG_EXPECTED_HASH: f.manifestHash,
    RESEARCH_WSH_ENABLED: 'true', RESEARCH_WSH_ENDPOINT_ID: 'fixture-endpoint', RESEARCH_WSH_HOST: 'host.docker.internal', RESEARCH_WSH_PORT: '7497', RESEARCH_WSH_CLIENT_ID: '156' };
  let paused = true, processId = 'execution-fixture', revision = 3, storeCalls = 0;
  let prepared: RecoveryChallenge | null = null;
  const store = {
    prepareResearchRecovery: async (identity: RecoveryIdentity) => { storeCalls++; prepared = { ...identity, id: randomUUID(), nonce: randomUUID(), challengeHash: 'c'.repeat(64), executionProcessId: processId,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), state: 'PREPARED', endpointId: 'fixture-endpoint', endpointGeneration: 3, predecessors: [], predecessorHash: 'd'.repeat(64), receiptId: null }; return prepared; },
    readResearchRecovery: async () => prepared,
    readResearchRecoveryReplacement: async () => prepared,
    readResearchRecoveryReceipt: async () => null,
    commitResearchRecovery: async () => { throw new Error('not expected'); },
    supersedeResearchRecovery: async () => { throw new Error('not expected'); },
  };
  const read = async (path: string) => path === '/execution/configuration'
    ? { initialized: true, mode: 'bundle', effectiveHash: f.configHash, processId, admission: { allowed: false } }
    : { startupProtocolVersion: 1, control: { account_id: 'DU_SYNTHETIC', paused, revision } };
  const deps = { store, read, readFile: () => readFileSync(new URL('../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json', import.meta.url), 'utf8') };
  const request = { action: 'prepare', kind: 'WSH_ENDPOINT_RESET', instrumentId: f.policy.instrumentId, operationId: randomUUID() };
  return { f, env, deps, request, get calls() { return storeCalls; }, get challenge() { return prepared!; }, setPaused: (v: boolean) => { paused = v; },
    restart: () => { processId = 'restarted'; }, repause: () => { revision++; }, close: () => rm(directory, { recursive: true, force: true }),
    actor: `operator:${createHash('sha256').update(token).digest('hex')}` };
}
test('maintenance one-shot permits disabled writes and stopped-peer admission while binding identity and actor', async () => {
  const f = await fixture(); try {
    const result = await executeResearchRecovery(f.request, f.env, f.deps) as RecoveryChallenge;
    assert.equal(f.calls, 1); assert.equal(result.actor, f.actor); assert.equal(result.accountId, 'DU_SYNTHETIC'); assert.equal(result.pauseRevision, 3);
  } finally { await f.close(); }
});
test('live, wrong account, unpaused or unauthenticated preflight never invokes recovery mutation', async () => {
  const f = await fixture(); try {
    for (const patch of [{ IBKR_ENVIRONMENT: 'live' }, { RESEARCH_BUDGET_ACCOUNT_ID: 'DU_OTHER' }, { EXECUTION_API_TOKEN: '' }])
      await assert.rejects(executeResearchRecovery(f.request, { ...f.env, ...patch }, f.deps));
    f.setPaused(false); await assert.rejects(executeResearchRecovery(f.request, f.env, f.deps)); f.setPaused(true);
    await assert.rejects(executeResearchRecovery(f.request, f.env, { ...f.deps, read: async () => { throw new Error('401'); } }));
    assert.equal(f.calls, 0);
  } finally { await f.close(); }
});
test('one-shot rejects unknown request keys and source selection outside the parsed manifest', async () => {
  const f = await fixture(); try {
    await assert.rejects(executeResearchRecovery({ ...f.request, confirmed: true }, f.env, f.deps));
    await assert.rejects(executeResearchRecovery({ ...f.request, instrumentId: 'unbound' }, f.env, f.deps));
    assert.equal(f.calls, 0);
  } finally { await f.close(); }
});
test('read requires the exact configuration process and rejects a legacy owner namespace', async () => {
  const f = await fixture(); try {
    await executeResearchRecovery(f.request, f.env, f.deps);
    const request = { action: 'read', challengeId: f.challenge.id };
    assert.equal((await executeResearchRecovery(request, f.env, f.deps) as RecoveryChallenge).id, f.challenge.id);
    const current = f.challenge;
    for (const change of [
      { executionProcessId: 'execution-engine:fixture-host:12345678' },
      { executionProcessId: randomUUID() },
      { accountId: 'DU_OTHER' },
      { configHash: 'e'.repeat(64) },
      { manifestHash: 'f'.repeat(64) },
      { pauseRevision: current.pauseRevision + 1 },
    ]) {
      await assert.rejects(executeResearchRecovery(request, f.env, {
        ...f.deps, store: { ...f.deps.store, readResearchRecovery: async () => ({ ...current, ...change }) },
      }), /RESEARCH_RECOVERY_PREFLIGHT_DENIED/);
    }
    f.restart();
    await assert.rejects(executeResearchRecovery(request, f.env, f.deps), /RESEARCH_RECOVERY_PREFLIGHT_DENIED/);
  } finally { await f.close(); }
});
test('reconnect performs only connect and close, then revalidates exact paused execution identity', async () => {
  const f = await fixture(); try {
    await executeResearchRecovery(f.request, f.env, f.deps); const id = randomUUID(); let now = Date.now(); const calls: string[] = [];
    const result = await executeResearchRecovery({ action: 'reconnect', challengeId: f.challenge.id, challengeHash: f.challenge.challengeHash }, f.env,
      { ...f.deps, now: () => now, transport: () => ({ sessionId: id, serverVersion: 180, sdkVersion: '1.6.10',
        connect: async () => { calls.push('connect'); now += 10; }, close: async () => { calls.push('close'); return { sessionId: id, state: 'CONFIRMED', verifiedLocalClosure: true,
          completedAt: new Date(now).toISOString(), cancellationAttemptedAt: null, disconnectRequestedAt: new Date(now).toISOString(), localClosedAt: new Date(now).toISOString() }; } }) });
    assert.deepEqual(calls, ['connect', 'close']); assert.equal((result as { sessionId: string }).sessionId, id);
  } finally { await f.close(); }
});
test('reconnect unknown cleanup or execution restart rejects without repeating handshake', async () => {
  for (const restart of [false, true]) {
    const f = await fixture(); try {
      await executeResearchRecovery(f.request, f.env, f.deps); const id = randomUUID(); let connects = 0, closes = 0;
      await assert.rejects(executeResearchRecovery({ action: 'reconnect', challengeId: f.challenge.id, challengeHash: f.challenge.challengeHash }, f.env,
        { ...f.deps, transport: () => ({ sessionId: id, serverVersion: 180, sdkVersion: '1.6.10', connect: async () => { connects++; if (restart) f.restart(); },
          close: async () => { closes++; return { sessionId: id, state: restart ? 'CONFIRMED' : 'UNKNOWN', verifiedLocalClosure: restart,
            completedAt: new Date().toISOString(), cancellationAttemptedAt: null, disconnectRequestedAt: restart ? new Date().toISOString() : null, localClosedAt: restart ? new Date().toISOString() : null }; } }) }));
      assert.equal(connects, 1); assert.equal(closes, 1);
    } finally { await f.close(); }
  }
});
test('authenticated reader rejects redirects, unknown destinations and oversized responses', async () => {
  const env = { EXECUTION_API_TOKEN: 'fixture', LLM_AGENT_EXECUTION_BASE_URL: 'http://execution-engine:3103' };
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response('x'.repeat(131073)); };
  await assert.rejects(recoveryAuthenticatedRead({ ...env, LLM_AGENT_EXECUTION_BASE_URL: 'https://outside.example' }, '/execution/configuration', fetcher));
  assert.equal(calls, 0);
  await assert.rejects(recoveryAuthenticatedRead(env, '/execution/configuration', fetcher)); assert.equal(calls, 1);
  await assert.rejects(recoveryAuthenticatedRead(env, '/execution/configuration', async (_url, init) => { assert.equal(init?.redirect, 'error'); return new Response('', { status: 302 }); }));
});

test('backend errors retain actual phase and originals with caller privacy at serialization', async () => {
  const f = await fixture();
  try {
    const original = Object.assign(new Error(`read failed ${f.env.EXECUTION_API_TOKEN} DU_SYNTHETIC`), { name: 'NativeReadError', code: 'ECONNRESET' });
    await assert.rejects(executeResearchRecovery(f.request, f.env, { ...f.deps, read: async () => { throw original; } }), error => {
      const output = recoveryFailureOutput(error, 'request');
      assert.equal(output.diagnostic.stage, 'preflight'); assert.equal(output.diagnostic.original.name, 'NativeReadError');
      assert.equal(output.diagnostic.original.code, 'ECONNRESET');
      assert.ok(!JSON.stringify(output).includes(f.env.EXECUTION_API_TOKEN!)); assert.ok(!JSON.stringify(output).includes('DU_SYNTHETIC'));
      return true;
    });
    for (const action of ['prepare', 'read', 'receipt'] as const) {
      await executeResearchRecovery(f.request, f.env, f.deps);
      const method = { prepare: 'prepareResearchRecovery', read: 'readResearchRecovery', receipt: 'readResearchRecoveryReceipt' }[action];
      const request = action === 'prepare' ? f.request : { action, challengeId: f.challenge.id, ...(action === 'receipt' ? { operationId: randomUUID() } : {}) };
      await assert.rejects(executeResearchRecovery(request, f.env, { ...f.deps, store: { ...f.deps.store, [method]: async () => { throw original; } } }), error => {
        assert.equal(recoveryFailureOutput(error, 'request').diagnostic.stage, action); return true;
      });
    }
  } finally { await f.close(); }
});

test('connect and cleanup diagnostics preserve primary cause without another handshake', async () => {
  for (const failure of ['connect', 'both', 'close', 'validate', 'postflight'] as const) {
    const f = await fixture();
    try {
      await executeResearchRecovery(f.request, f.env, f.deps); const id = randomUUID(); let connects = 0, closes = 0;
      const connectError = Object.assign(new Error('connection refused'), { name: 'ConnectError', code: 'ECONNREFUSED' });
      const closeError = Object.assign(new Error('close failed'), { name: 'CloseError', code: 'EIO' });
      await assert.rejects(executeResearchRecovery({ action: 'reconnect', challengeId: f.challenge.id, challengeHash: f.challenge.challengeHash }, f.env, {
        ...f.deps, transport: () => ({ sessionId: id, serverVersion: 180, sdkVersion: '1.6.10',
          connect: async () => { connects++; if (failure === 'connect' || failure === 'both') throw connectError; if (failure === 'postflight') f.restart(); },
          close: async () => { closes++; if (failure === 'both' || failure === 'close') throw closeError;
            return { sessionId: id, state: failure === 'validate' ? 'UNKNOWN' : 'CONFIRMED', verifiedLocalClosure: failure !== 'validate',
              completedAt: new Date().toISOString(), cancellationAttemptedAt: null, disconnectRequestedAt: new Date().toISOString(), localClosedAt: new Date().toISOString() }; },
        }),
      }), error => {
        const d = recoveryFailureOutput(error, 'request').diagnostic;
        assert.equal(d.stage, failure === 'connect' || failure === 'both' ? 'reconnect-connect' : `reconnect-${failure}`);
        if (failure === 'connect' || failure === 'both') assert.equal(d.original.code, 'ECONNREFUSED');
        if (failure === 'close') assert.equal(d.original.code, 'EIO');
        return true;
      });
      assert.equal(connects, 1); assert.equal(closes, 1);
    } finally { await f.close(); }
  }
});

test('invalid request never serializes validator raw inputs', async () => {
  const f = await fixture();
  try {
    await assert.rejects(executeResearchRecovery({ action: 'secret-provider-payload', payload: 'do-not-print' }, f.env, f.deps), error => {
      const output = recoveryFailureOutput(error, 'request');
      assert.equal(output.diagnostic.stage, 'request'); assert.equal(output.diagnostic.reason, 'RESEARCH_RECOVERY_REQUEST_INVALID');
      assert.ok(!JSON.stringify(output).includes('secret-provider-payload')); assert.ok(!JSON.stringify(output).includes('do-not-print')); return true;
    });
    assert.equal(f.calls, 0);
  } finally { await f.close(); }
});

test('malformed authenticated response retains SyntaxError identity without exposing its body excerpt', async () => {
  const f = await fixture();
  try {
    await assert.rejects(executeResearchRecovery(f.request, f.env, {
      ...f.deps, read: path => recoveryAuthenticatedRead(f.env, path, async () => new Response('RAW_PROVIDER_SENTINEL')),
    }), error => {
      const d = recoveryFailureOutput(error, 'request').diagnostic;
      assert.equal(d.stage, 'preflight'); assert.equal(d.original.name, 'SyntaxError'); assert.equal(d.original.message, null);
      assert.ok(!JSON.stringify(d).includes('RAW_PROVID')); return true;
    });
    assert.equal(f.calls, 0);
  } finally { await f.close(); }
});

test('returned unknown cleanup cause survives validation without masking a prior connect failure', async () => {
  for (const connectFails of [false, true]) {
    const f = await fixture();
    try {
      await executeResearchRecovery(f.request, f.env, f.deps); const id = randomUUID(); let connects = 0, closes = 0;
      await assert.rejects(executeResearchRecovery({ action: 'reconnect', challengeId: f.challenge.id, challengeHash: f.challenge.challengeHash }, f.env, {
        ...f.deps, transport: () => ({ sessionId: id, serverVersion: 180, sdkVersion: '1.6.10',
          connect: async () => { connects++; if (connectFails) throw Object.assign(new Error('connect failed'), { code: 'ECONNRESET' }); },
          close: async () => { closes++; return { sessionId: id, state: 'UNKNOWN', verifiedLocalClosure: false,
            completedAt: new Date().toISOString(), cancellationAttemptedAt: null, disconnectRequestedAt: new Date().toISOString(), localClosedAt: null,
            sourceError: { name: 'SocketCloseError', code: 'ECLOSE', message: `close failed ${f.env.EXECUTION_API_TOKEN}` } }; },
        }),
      }), error => {
        const d = recoveryFailureOutput(error, 'request').diagnostic;
        assert.equal(d.stage, connectFails ? 'reconnect-connect' : 'reconnect-validate');
        assert.equal(d.original.code, connectFails ? 'ECONNRESET' : 'ECLOSE');
        assert.ok(!JSON.stringify(d).includes(f.env.EXECUTION_API_TOKEN!)); return true;
      });
      assert.equal(connects, 1); assert.equal(closes, 1);
    } finally { await f.close(); }
  }
});
