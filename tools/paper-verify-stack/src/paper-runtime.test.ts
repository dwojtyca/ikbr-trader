import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, PaperHttpError, PaperRuntime, PaperRuntimeError, validateRenderedCompose, type ReleaseProof, type RuntimeControl, type RuntimeAdapters } from './paper-runtime.js';

const readyHealth = () => ({ connected: true, bootstrapped: true, bootstrapping: false, automaticBootstrap: { initialized: true, manuallyStopped: false, inFlight: false, recoveryNeeded: false, shuttingDown: false, error: null } });

const imageId = `sha256:${'a'.repeat(64)}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const bundleHash = 'b'.repeat(64), researchHash = 'c'.repeat(64);

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'paper-runtime-'));
  const local = resolve(root, '.local/paper-runtime'); const account = resolve(local, 'accounting');
  await mkdir(account, { recursive: true });
  await writeFile(resolve(root, 'docker-compose.yml'), 'services: {}\n');
  await writeFile(resolve(local, 'redis-internal.override.yml'), 'services:\n  redis:\n    ports: !reset []\n');
  await writeFile(resolve(local, 'compose.override.json'), '{}\n');
  await writeFile(resolve(local, 'strategy.json'), '{}\n'); await writeFile(resolve(local, 'research.json'), '{}\n');
  await writeFile(resolve(account, 'record.txt'), 'private accounting fixture');
  const files = ['docker-compose.yml', '.local/paper-runtime/redis-internal.override.yml', '.local/paper-runtime/compose.override.json',
    '.local/paper-runtime/strategy.json', '.local/paper-runtime/research.json', '.local/paper-runtime/accounting/record.txt'];
  const entries = await Promise.all(files.map(async path => ({ path, sha256: sha(await readFile(resolve(root, path), 'utf8')) })));
  const source = (p: string) => resolve(local, p);
  const appServices: Record<string, unknown> = {};
  for (const name of ['ingestion', 'signal-engine', 'execution-engine', 'llm-agent']) {
    const env: Record<string, string> = { IBKR_ENVIRONMENT: 'paper', IBKR_ACCOUNT_ID: 'DU123456', ALLOWED_PAPER_ACCOUNTS: 'DU123456', ALLOWED_LIVE_ACCOUNTS: '',
      TRADING_CONFIG_MODE: 'bundle', TRADING_CONFIG_PATH: '/app/private-config/continuous-strategy.json', TRADING_CONFIG_EXPECTED_HASH: bundleHash,
      TRADING_ENABLED: name === 'ingestion' ? 'false' : 'true', INGESTION_AUTO_BOOTSTRAP_ENABLED: 'true', EXECUTION_ENTRIES_PAUSED: 'false',
      EXECUTION_LIFECYCLE_AUTOMATION_ENABLED: 'true', TRADING_LOOP_ENABLED: 'true', TRADING_LOOP_INSTRUMENT_IDS: 'pko_wse,aapl_nasdaq', LLM_AGENT_ENABLED: 'true',
      EXECUTION_ACCOUNTING_SOURCE_PATH: '/app/private-accounting/record.txt', EXECUTION_ACCOUNTING_SOURCE_SHA256: sha('private accounting fixture'),
      RESEARCH_CONFIG_PATH: '/app/private-config/continuous-research.json', RESEARCH_CONFIG_EXPECTED_HASH: researchHash, RESEARCH_BUDGET_ACCOUNT_ID: 'DU123456', RESEARCH_MARKETAUX_ON_DEMAND: 'true' };
    const volumes: Array<Record<string, unknown>> = [{ type: 'bind', source: source('strategy.json'), target: '/app/private-config/continuous-strategy.json', read_only: true }];
    if (name === 'execution-engine' || name === 'llm-agent') volumes.push({ type: 'bind', source: source('research.json'), target: '/app/private-config/continuous-research.json', read_only: true });
    if (name === 'execution-engine') volumes.push({ type: 'bind', source: account, target: '/app/private-accounting', read_only: true });
    appServices[name] = { image: imageId, command: ['pnpm', '--filter', `@ikbr/${name}`, 'start'], environment: env, volumes };
  }
  const rendered = { services: appServices };
  const proof: ReleaseProof = { version: 1, imageId, effectiveComposeSha256: sha(canonicalJson(rendered)), files: entries };
  await writeFile(resolve(local, 'release.json'), JSON.stringify(proof));
  await writeFile(resolve(root, '.env'), 'EXECUTION_API_TOKEN=testing-token-only\n');
  return { root, rendered, proof, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function runScenario(options: { pause?: 'lost' | 'unchanged'; resume?: 'lost' | 'unchanged' | 'transient' | 'server' | 'abort'; waitThenPause?: boolean; abort?: AbortController } = {}) {
  const f = await fixture(); const calls: string[] = []; let control: RuntimeControl['control'] = { account_id: 'DU123456', paused: true, revision: 1 };
  let events: RuntimeControl['events'] = [{ revision: 1, paused: true, reason: 'before' }]; let pauseCalls = 0, resumeCalls = 0, preparedCalls = 0, healthRetries = 0;
  const mutate = (paused: boolean, reason: string, expectedRevision: number) => { control = { ...control!, paused, revision: expectedRevision + 1 }; events = [...events, { revision: control.revision, paused, reason }]; };
  const compose = async (args: string[]) => { calls.push(`compose:${args.slice(-5).join(' ')}`); return args.includes('config') ? JSON.stringify(f.rendered) : args.includes('ps') ? '[]' : ''; };
  const http = async (path: string, body?: unknown) => {
    calls.push(`${body === undefined ? 'get' : 'post'}:${path}`);
    if (path === '/health') return { ok: true };
    if (path === 'http://ingestion/health') { if (healthRetries++ < 2) throw new Error('starting'); return readyHealth(); }
    if (path === 'http://ingestion/backfill-progress') return { progress: { phase: 'completed', failedTimeframes: [] } };
    if (path === '/execution/entry-control') return { startupProtocolVersion: 1, control, events };
    if (path === '/execution/entry-control/pause') {
      pauseCalls++; const v = body as { reason: string; expectedRevision: number };
      if (options.pause === 'unchanged') throw new Error('lost pause response');
      mutate(true, v.reason, v.expectedRevision ?? Number(control!.revision)); if (options.pause === 'lost' && pauseCalls === 1) throw new Error('lost pause response'); return {};
    }
    if (path === 'http://ingestion/bootstrap') return { accepted: true };
    if (path === '/execution/entry-control/start/prepare') {
      preparedCalls++; if (options.waitThenPause && preparedCalls === 1) {
        return { revision: (body as { expectedRevision: number }).expectedRevision,
          instruments: ['pko_wse', 'aapl_nasdaq'].map(instrumentId => ({ instrumentId, state: 'WAITING', reasons: ['RESEARCH_WAITING'] })) };
      }
      if (options.waitThenPause && preparedCalls === 2) mutate(true, 'owner-pause', Number(control!.revision));
      return { revision: (body as { expectedRevision: number }).expectedRevision,
        instruments: ['pko_wse', 'aapl_nasdaq'].map(instrumentId => ({ instrumentId, state: 'READY', reasons: [] })) };
    }
    if (path === '/execution/entry-control/resume') {
      resumeCalls++; const v = body as { reason: string; expectedRevision: number };
      if (options.resume === 'transient' && resumeCalls === 1) throw new PaperHttpError('LIFECYCLE_RECONCILIATION_UNAVAILABLE', 423);
      if (options.resume === 'server') throw new PaperHttpError('PAPER_HTTP_REJECTED', 503);
      if (options.resume === 'unchanged') throw new Error('lost resume response');
      mutate(false, v.reason, v.expectedRevision);
      if (options.resume === 'abort') options.abort?.abort();
      if (options.resume === 'lost' || options.resume === 'abort') throw new Error('lost resume response');
      return {};
    }
    throw new Error('unexpected fixture request');
  };
  const adapters: RuntimeAdapters = { compose, inspectImage: async id => id, http, sleep: async () => undefined, signal: options.abort?.signal };
  const runtime = new PaperRuntime({ root: f.root, token: 'fixture', adapters });
  return { f, runtime, calls, adapters, get control() { return control; }, get events() { return events; }, get pauseCalls() { return pauseCalls; }, get resumeCalls() { return resumeCalls; } };
}

test('rendered Paper profile validates fixed command, image, account and private readonly mounts', async () => {
  const f = await fixture();
  try { assert.equal((await validateRenderedCompose(f.rendered, f.proof, f.root)).accountId, 'DU123456'); }
  finally { await f.cleanup(); }
});

test('profile drift in a producer command or Paper environment fails closed', async () => {
  const f = await fixture();
  try {
    const badCommand = structuredClone(f.rendered) as { services: Record<string, { command: string[]; environment: Record<string, string> }> };
    badCommand.services['signal-engine'].command = ['pnpm', '--filter', '@ikbr/ui', 'start'];
    await assert.rejects(validateRenderedCompose(badCommand, f.proof, f.root), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_CONFIG_CHANGED');
    const live = structuredClone(f.rendered) as { services: Record<string, { command: string[]; environment: Record<string, string> }> };
    live.services['execution-engine'].environment.IBKR_ENVIRONMENT = 'live';
    await assert.rejects(validateRenderedCompose(live, f.proof, f.root), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_CONFIG_CHANGED');
  } finally { await f.cleanup(); }
});

test('start pauses before producer startup, waits for completed bootstrap and all research before resume', async () => {
  const f = await fixture(); const calls: string[] = []; let state: RuntimeControl['control'] = { account_id: 'DU123456', paused: true, revision: 1 };
  let events: RuntimeControl['events'] = [{ revision: 1, paused: true, reason: 'prior' }];
  const compose = async (args: string[]) => { calls.push(`compose:${args.slice(-5).join(' ')}`); return args.includes('config') ? JSON.stringify(f.rendered) : args.includes('ps') ? '[]' : ''; };
  const http = async (path: string, body?: unknown) => {
    calls.push(`http:${path}`);
    if (path === '/health') return { ok: true };
    if (path.endsWith('/health')) return readyHealth();
    if (path.endsWith('/backfill-progress')) return { progress: { phase: 'completed', failedTimeframes: [] } };
    if (path === '/execution/entry-control') return { startupProtocolVersion: 1, control: state, events };
    if (path === '/execution/entry-control/pause') { const v = body as { reason: string; expectedRevision: number }; state = { ...state!, paused: true, revision: v.expectedRevision + 1 }; events = [...events, { revision: state.revision, paused: true, reason: v.reason }]; return {}; }
    if (path === 'http://ingestion/bootstrap') return { accepted: true };
    if (path === '/execution/entry-control/start/prepare') return { revision: (body as { expectedRevision: number }).expectedRevision,
      instruments: ['pko_wse', 'aapl_nasdaq'].map(instrumentId => ({ instrumentId, state: 'READY', reasons: [] })) };
    if (path === '/execution/entry-control/resume') { const v = body as { reason: string; expectedRevision: number }; state = { ...state!, paused: false, revision: v.expectedRevision + 1 }; events = [...events, { revision: state.revision, paused: false, reason: v.reason }]; return {}; }
    throw new Error('unexpected fixture request');
  };
  try {
    const runtime = new PaperRuntime({ root: f.root, token: 'fixture', adapters: { compose, inspectImage: async id => id, http, sleep: async () => undefined } });
    const result = await runtime.start(); assert.match(result, /Paper działa w Dockerze/);
    const pause = calls.findIndex(x => x.startsWith('http:/execution/entry-control/pause'));
    const up = calls.findIndex(x => x.startsWith('compose:') && x.includes('signal-engine'));
    const prepare = calls.findIndex(x => x === 'http:/execution/entry-control/start/prepare');
    const resume = calls.findIndex(x => x === 'http:/execution/entry-control/resume');
    assert.ok(pause >= 0 && up > pause && prepare > up && resume > prepare);
    assert.equal(state?.paused, false);
  } finally { await f.cleanup(); }
});

test('start rejects a changed effective compose proof before any service mutation', async () => {
  const f = await fixture(); const calls: string[] = [];
  try {
    const changed = structuredClone(f.rendered) as { services: Record<string, { command: string[] }> };
    changed.services['llm-agent'].command = ['pnpm', '--filter', '@ikbr/ui', 'start'];
    const runtime = new PaperRuntime({ root: f.root, token: 'fixture', adapters: { compose: async args => { calls.push(args.at(-1) ?? ''); return JSON.stringify(changed); }, inspectImage: async id => id, http: async () => { throw new Error('must not call'); } } });
    await assert.rejects(runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_CONFIG_CHANGED');
    assert.deepEqual(calls, ['json']);
  } finally { await f.cleanup(); }
});

test('stop pauses entries and stops only producer services without requiring release proof', async () => {
  const f = await fixture(); const commands: string[][] = []; let rev = 3; let paused = false;
  let events: RuntimeControl['events'] = [];
  const http = async (path: string, body?: unknown) => {
    if (path === '/execution/entry-control') return { startupProtocolVersion: 1, control: { account_id: 'DU123456', paused, revision: rev }, events };
    if (path === '/execution/entry-control/pause') { const value = body as { reason: string }; rev++; paused = true; events = [...events, { revision: rev, paused: true, reason: value.reason }]; return body; }
    throw new Error('unexpected request');
  };
  try {
    const runtime = new PaperRuntime({ root: f.root, token: 'fixture', adapters: { compose: async args => { commands.push(args); return args.includes('config') ? JSON.stringify(f.rendered) : args.includes('ps') ? '[]' : ''; }, inspectImage: async id => id, http } });
    const text = await runtime.stop(); assert.equal(paused, true); assert.match(text, /Execution i ingestion pozostają dostępne/);
    assert.ok(commands.some(c => c.slice(-3).join(' ') === 'stop signal-engine llm-agent'));
    assert.ok(commands.every(c => !c.includes('up') && !c.includes('build') && !c.includes('pull')));
  } finally { await f.cleanup(); }
});

test('a lost pause response is reconciled by exact revision and reason without repeating the mutation', async () => {
  const h = await runScenario({ pause: 'lost' });
  try { await h.runtime.start(); assert.equal(h.pauseCalls, 1); assert.equal(h.control?.paused, false); }
  finally { await h.f.cleanup(); }
});

test('an unchanged readback after an unknown pause response leaves producers stopped and does not retry', async () => {
  const h = await runScenario({ pause: 'unchanged' });
  try {
    await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_CONTROL_UNKNOWN');
    assert.equal(h.pauseCalls, 1); assert.equal(h.calls.some(c => c.startsWith('compose:') && c.includes('signal-engine')), false);
  } finally { await h.f.cleanup(); }
});

test('a lost resume response is reconciled exactly without a second resume', async () => {
  const h = await runScenario({ resume: 'lost' });
  try { await h.runtime.start(); assert.equal(h.resumeCalls, 1); assert.equal(h.control?.paused, false); }
  finally { await h.f.cleanup(); }
});

test('an unchanged readback after an unknown resume response is an unknown hold with no retry', async () => {
  const h = await runScenario({ resume: 'unchanged' });
  try {
    await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_RESUME_UNKNOWN');
    assert.equal(h.resumeCalls, 1); assert.equal(h.control?.paused, true);
  } finally { await h.f.cleanup(); }
});

test('a definitive current 423 gate denial polls again with the same CAS revision; a 5xx stays unknown', async () => {
  const retry = await runScenario({ resume: 'transient' });
  try { await retry.runtime.start(); assert.equal(retry.resumeCalls, 2); assert.equal(retry.control?.paused, false); }
  finally { await retry.f.cleanup(); }
  const unknown = await runScenario({ resume: 'server' });
  try {
    await assert.rejects(unknown.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_RESUME_UNKNOWN');
    assert.equal(unknown.resumeCalls, 1); assert.equal(unknown.control?.paused, true);
  } finally { await unknown.f.cleanup(); }
});

test('a newer pause while research waits permanently supersedes this start', async () => {
  const h = await runScenario({ waitThenPause: true });
  try {
    await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_START_SUPERSEDED');
    assert.equal(h.resumeCalls, 0); assert.equal(h.control?.paused, true);
  } finally { await h.f.cleanup(); }
});

test('SIGINT after a completed resume persists a new explicit pause before returning', async () => {
  const abort = new AbortController(); const h = await runScenario({ resume: 'abort', abort });
  try {
    await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_START_INTERRUPTED');
    assert.equal(h.control?.paused, true); assert.match(h.events.at(-1)?.reason ?? '', /^paper-stop:/); assert.equal(h.resumeCalls, 1);
  } finally { await h.f.cleanup(); }
});

test('bootstrap waits for ingestion health, reads completed progress, and submits one manual bootstrap request', async () => {
  const h = await runScenario();
  try {
    await h.runtime.start();
    assert.equal(h.calls.filter(c => c === 'post:http://ingestion/bootstrap').length, 1);
    assert.ok(h.calls.indexOf('get:http://ingestion/health') < h.calls.indexOf('post:http://ingestion/bootstrap'));
    assert.ok(h.calls.includes('get:http://ingestion/backfill-progress'));
  } finally { await h.f.cleanup(); }
});

test('cold startup waits for the actual broker account after health is available', async () => {
  const h = await runScenario(); const original = h.adapters.http; let accountReads = 0;
  h.adapters.http = async (path, ...rest) => {
    if (path === '/execution/entry-control' && accountReads++ < 2) throw new PaperHttpError('no_active_account_for_exempt_route', 423);
    return original(path, ...rest);
  };
  try { await h.runtime.start(); assert.ok(accountReads >= 3); assert.equal(h.resumeCalls, 1); }
  finally { await h.f.cleanup(); }
});

test('a separate stop cancels a cold start before the account API becomes available', async () => {
  const h = await runScenario(); const original = h.adapters.http; let stopping = false, attemptedAccount = false;
  const stop = new PaperRuntime({ root: h.f.root, token: 'fixture', adapters: h.adapters });
  h.adapters.http = async (path, ...rest) => {
    if (path === '/health') throw Error('execution not listening yet');
    if (path === '/execution/entry-control') {
      if (!attemptedAccount) {
        attemptedAccount = true; stopping = true;
        await assert.rejects(stop.stop(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_PAUSE_UNKNOWN');
        stopping = false;
      }
      if (stopping || attemptedAccount) throw new PaperHttpError('no_active_account_for_exempt_route', 423);
    }
    return original(path, ...rest);
  };
  try {
    await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_PAUSE_UNKNOWN');
    assert.equal(h.resumeCalls, 0); assert.equal(h.pauseCalls, 0);
    assert.ok(h.calls.some(c => c.includes('stop signal-engine llm-agent')));
    assert.equal(h.calls.some(c => c.includes('up') && c.endsWith('ingestion llm-agent signal-engine')), false);
  } finally { await h.f.cleanup(); }
});

test('stop persists an unconditional pause when a resume commits after its account read', async () => {
  const h = await runScenario(); const original = h.adapters.http; let raced = false;
  h.adapters.http = async (path, body, ...rest) => {
    if (path === '/execution/entry-control/pause' && String((body as {reason?: string})?.reason).startsWith('paper-stop:')) {
      assert.equal(Object.hasOwn(body as object, 'expectedRevision'), false);
      if (!raced) { raced = true; await original('/execution/entry-control/resume', { reason: 'competing-start', expectedRevision: Number(h.control!.revision) }); }
    }
    return original(path, body, ...rest);
  };
  try { await h.runtime.stop(); assert.equal(h.control?.paused, true); assert.equal(Number(h.control?.revision), 3); assert.match(h.events.at(-1)?.reason ?? '', /^paper-stop:/); }
  finally { await h.f.cleanup(); }
});

test('interrupted unknown resume gets a new pause even though a read before its delayed commit says paused', async () => {
  const abort = new AbortController(), h = await runScenario({ abort }); const original = h.adapters.http;
  let delayed: (() => Promise<unknown>) | undefined, sawPausedRead = false;
  h.adapters.http = async (path, body, ...rest) => {
    if (path === '/execution/entry-control/resume') {
      delayed = () => original(path, body, ...rest); abort.abort(); throw Error('resume still in flight');
    }
    if (path === '/execution/entry-control' && delayed) sawPausedRead ||= h.control?.paused === true;
    if (path === '/execution/entry-control/pause' && delayed && String((body as {reason?: string})?.reason).startsWith('paper-stop:')) {
      await delayed(); delayed = undefined;
    }
    return original(path, body, ...rest);
  };
  try {
    await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_START_INTERRUPTED');
    assert.equal(sawPausedRead, true); assert.equal(h.control?.paused, true); assert.match(h.events.at(-1)?.reason ?? '', /^paper-stop:/);
  } finally { await h.f.cleanup(); }
});

test('SIGINT during readback after a successful resume also forces a new pause', async () => {
  const abort = new AbortController(), h = await runScenario({ abort }); const original = h.adapters.http; let unread = true;
  h.adapters.http = async (path, ...rest) => {
    if (path === '/execution/entry-control' && h.resumeCalls && unread) { unread = false; abort.abort(); throw Error('lost readback'); }
    return original(path, ...rest);
  };
  try {
    await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_START_INTERRUPTED');
    assert.equal(h.control?.paused, true); assert.match(h.events.at(-1)?.reason ?? '', /^paper-stop:/);
  } finally { await h.f.cleanup(); }
});

test('unknown stop pause is not repeated and never reported as a confirmed stop', async () => {
  const h = await runScenario({ pause: 'unchanged' });
  try {
    await assert.rejects(h.runtime.stop(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_PAUSE_UNKNOWN');
    assert.equal(h.pauseCalls, 1); assert.ok(h.calls.some(c => c.includes('stop signal-engine llm-agent')));
  } finally { await h.f.cleanup(); }
});

test('unknown bootstrap response resolves only after complete actual ingestion health, with a single POST', async () => {
  const h = await runScenario(); const original = h.adapters.http; let requested = false, partial = 0, posts = 0;
  const logs: string[] = []; h.adapters.log = message => logs.push(message);
  h.adapters.http = async (path, body, ...rest) => {
    if (path === 'http://ingestion/bootstrap') { requested = true; posts++; throw Error('lost bootstrap response'); }
    if (path === 'http://ingestion/health' && requested && partial++ < 2) return { connected: true, bootstrapped: true, bootstrapping: false };
    return original(path, body, ...rest);
  };
  try { await h.runtime.start(); assert.equal(posts, 1); assert.ok(partial >= 3); assert.ok(logs.some(s => s.includes('historia cen'))); assert.equal(h.resumeCalls, 1); }
  finally { await h.f.cleanup(); }
});

test('bootstrap is observed while POST is still pending and cancellation stops the start', async () => {
  const abort = new AbortController(), h = await runScenario({ abort }); const original = h.adapters.http; let posted = false, polled = false;
  h.adapters.http = async (path, body, timeout, signal) => {
    if (path === 'http://ingestion/bootstrap') {
      posted = true;
      return new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(Error('cancelled transport')), { once: true }); });
    }
    if (path === 'http://ingestion/health' && posted) { polled = true; abort.abort(); return readyHealth(); }
    return original(path, body, timeout, signal);
  };
  try { await assert.rejects(h.runtime.start()); assert.equal(polled, true); assert.equal(h.resumeCalls, 0); assert.equal(h.control?.paused, true); }
  finally { await h.f.cleanup(); }
});

test('malformed or non-stopped producer state never permits cold execution startup', async () => {
  for (const state of ['not JSON', '[{"Service":"signal-engine","State":"restarting"}]', '[{"Service":"llm-agent","State":"paused"}]']) {
    const h = await runScenario(); const http = h.adapters.http, compose = h.adapters.compose; let up = false;
    h.adapters.http = (path, ...args) => path === '/health' ? Promise.reject(Error('cold')) : http(path, ...args);
    h.adapters.compose = (args, signal) => { if (args.includes('up')) up = true; return args.includes('ps') ? Promise.resolve(state) : compose(args, signal); };
    try { await assert.rejects(h.runtime.start(), (e: unknown) => e instanceof PaperRuntimeError && e.code === 'PAPER_PRODUCERS_NOT_STOPPED'); assert.equal(up, false); }
    finally { await h.f.cleanup(); }
  }
});

test('invalid cancellation marker and symlinked marker fail before service/HTTP mutations', async () => {
  for (const kind of ['invalid', 'symlink']) {
    const h = await runScenario(); const path = resolve(h.f.root, '.local/paper-runtime/stop-generation');
    if (kind === 'invalid') await writeFile(path, 'corrupt'); else await symlink(resolve(h.f.root, '.env'), path);
    try { await assert.rejects(h.runtime.start()); assert.equal(h.calls.length, 0); await assert.rejects(h.runtime.stop()); assert.equal(h.calls.length, 0); }
    finally { await h.f.cleanup(); }
  }
});

test('private file changes, symlinks, mismatched research hash and outside accounting path reject before startup', async () => {
  for (const kind of ['file', 'symlink', 'research', 'accounting', 'mount']) {
    const h = await runScenario();
    if (kind === 'file') await writeFile(resolve(h.f.root, '.local/paper-runtime/research.json'), 'changed');
    else if (kind === 'symlink') { const p = resolve(h.f.root, '.local/paper-runtime/research.json'); await rm(p); await symlink(resolve(h.f.root, '.env'), p); }
    else {
      const services = h.f.rendered.services as Record<string, { environment: Record<string, string>; volumes: Array<{read_only: boolean}> }>;
      if (kind === 'research') services['llm-agent'].environment.RESEARCH_CONFIG_EXPECTED_HASH = 'd'.repeat(64);
      if (kind === 'accounting') services['execution-engine'].environment.EXECUTION_ACCOUNTING_SOURCE_PATH = '/tmp/source.json';
      if (kind === 'mount') services['execution-engine'].volumes[0].read_only = false;
      h.f.proof.effectiveComposeSha256 = sha(canonicalJson(h.f.rendered));
      await writeFile(resolve(h.f.root, '.local/paper-runtime/release.json'), JSON.stringify(h.f.proof));
    }
    try { await assert.rejects(h.runtime.start()); assert.equal(h.calls.some(c => c.startsWith('post:') || c.includes('up') || c.includes('stop')), false); }
    finally { await h.f.cleanup(); }
  }
});

test('status uses existing operator diagnostics and labels container-only fallback as unconfirmed', async () => {
  const h = await runScenario();
  try {
    h.adapters.statusReport = async () => 'Pauza: true; powód danych: HOLD';
    assert.match(await h.runtime.status(), /HOLD/);
    h.adapters.statusReport = async () => { throw Error('offline'); };
    assert.match(await h.runtime.status(), /niepotwierdzone/);
  } finally { await h.f.cleanup(); }
});

test('real HTTP transport maps bootstrap to authenticated ingestion port and rejects execution bootstrap', async () => {
  const { httpClient } = await import('./paper-runtime-cli.js');
  const seen: Array<{url: string; init?: RequestInit}> = [];
  const transport = httpClient('fixture-secret', (async (url, init) => { seen.push({ url: String(url), init }); return new Response('{}'); }) as typeof fetch);
  await transport('http://ingestion/bootstrap', {}, 1000);
  await transport('/execution/entry-control');
  assert.equal(seen[0].url, 'http://127.0.0.1:3101/bootstrap');
  assert.equal(seen[0].init?.method, 'POST'); assert.equal(seen[0].init?.body, '{}');
  assert.equal((seen[0].init?.headers as Record<string, string>).Authorization, 'Bearer fixture-secret');
  assert.equal(seen[1].url, 'http://127.0.0.1:3103/execution/entry-control');
  await assert.rejects(transport('/bootstrap', {}));
  await assert.rejects(transport('http://attacker/bootstrap', {})); assert.equal(seen.length, 2);
});

test('HTTP errors are size bounded and malformed error JSON cannot become a retryable gate denial', async () => {
  const { httpClient } = await import('./paper-runtime-cli.js');
  for (const content of ['not json', '{}', JSON.stringify({ error: 'x'.repeat(2_000_001) })]) {
    const transport = httpClient('secret', (async () => new Response(content, { status: 423 })) as typeof fetch);
    await assert.rejects(transport('/execution/entry-control/resume', {}), (e: unknown) => e instanceof PaperRuntimeError && !(e instanceof PaperHttpError));
  }
  const valid = httpClient('secret', (async () => new Response(JSON.stringify({ message: 'LIFECYCLE_RECONCILIATION_UNAVAILABLE' }), { status: 423 })) as typeof fetch);
  await assert.rejects(valid('/execution/entry-control/resume', {}), (e: unknown) => e instanceof PaperHttpError && e.status === 423);
});

test('Docker transport enforces finite deadlines, abort and bounded output without exposing stderr', async () => {
  const { runDocker } = await import('./paper-runtime-cli.js');
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  for (const mode of ['deadline', 'abort', 'output']) {
    const child = new EventEmitter() as import('node:child_process').ChildProcess;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); const kills: string[] = [];
    child.kill = signal => { kills.push(String(signal)); setImmediate(() => child.emit('close', 143)); return true; };
    const fakeSpawn = (() => child) as typeof import('node:child_process').spawn;
    const abort = new AbortController();
    const result = runDocker(['compose', 'config'], { timeoutMs: mode === 'deadline' ? 5 : 1000, signal: abort.signal, maxBytes: 10 }, fakeSpawn);
    child.stderr.emit('data', Buffer.from('secret must never appear'));
    if (mode === 'abort') abort.abort();
    if (mode === 'output') child.stdout.emit('data', Buffer.from('too much output'));
    await assert.rejects(result, (e: unknown) => e instanceof PaperRuntimeError && !e.message.includes('secret'));
    assert.deepEqual(kills, ['SIGTERM']);
  }
});

test('cold start rejects old protocol and auth denial without retrying mutations', async () => {
  for (const failure of ['protocol', 'auth', 'malformed']) {
    const h = await runScenario(), original = h.adapters.http;
    h.adapters.http = async (path, ...rest) => {
      if (path === '/execution/entry-control') {
        if (failure === 'auth') throw new PaperHttpError('unauthorized', 401);
        return failure === 'malformed' ? { startupProtocolVersion: 1, control: h.control, events: [{}] } : { control: h.control, events: h.events };
      }
      return original(path, ...rest);
    };
    try { await assert.rejects(h.runtime.start()); assert.equal(h.pauseCalls, 0); assert.equal(h.resumeCalls, 0); }
    finally { await h.f.cleanup(); }
  }
});

test('definitive startup peer readiness waits and stale research during resume returns to preparation under the same pause', async () => {
  const h = await runScenario(); const original = h.adapters.http; let preparations = 0, resumes = 0;
  const revisions = new Set<number>();
  h.adapters.http = async (path, body, ...rest) => {
    if (path === '/execution/entry-control/start/prepare') {
      revisions.add((body as {expectedRevision: number}).expectedRevision);
      if (++preparations === 1) throw new PaperHttpError('ENTRY_START_CONFIGURATION_UNAVAILABLE', 423);
    }
    if (path === '/execution/entry-control/resume' && ++resumes === 1) throw new PaperHttpError('RESEARCH_REQUIRED_COVERAGE_UNAVAILABLE', 423);
    return original(path, body, ...rest);
  };
  try { await h.runtime.start(); assert.equal(preparations, 3); assert.equal(resumes, 2); assert.equal(revisions.size, 1); assert.equal(h.control?.paused, false); }
  finally { await h.f.cleanup(); }
});


test('pending bootstrap tolerates the prior durable stop and old failure until its single request completes', async () => {
  const h = await runScenario(); const original = h.adapters.http; let requested = false, polls = 0, requests = 0;
  let complete!: (value: unknown) => void;
  h.adapters.http = async (path, body, ...rest) => {
    if (path === 'http://ingestion/bootstrap') {
      requested = true; requests++; return new Promise(resolve => { complete = resolve; });
    }
    if (path === 'http://ingestion/health' && requested) {
      polls++;
      if (polls === 1) return { ...readyHealth(), automaticBootstrap: { ...readyHealth().automaticBootstrap, manuallyStopped: true, recoveryNeeded: true, error: 'previous failure' } };
      if (polls === 2) return { ...readyHealth(), bootstrapping: true, automaticBootstrap: { ...readyHealth().automaticBootstrap, inFlight: true, recoveryNeeded: true, error: 'previous failure' } };
      complete({ subscribed: [] }); return readyHealth();
    }
    return original(path, body, ...rest);
  };
  try { await h.runtime.start(); assert.ok(polls >= 3); assert.equal(requests, 1); assert.equal(h.resumeCalls, 1); }
  finally { await h.f.cleanup(); }
});
