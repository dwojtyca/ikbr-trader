import { createHash, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  OWNER_RECOVERY_LIMITS, ownerRecoveryHash, parseOwnerRecoveryHandshake, parseOwnerRecoveryProfile,
  parseOwnerRecoveryRequest, parseOwnerRecoveryResponse,
  type OwnerRecoveryHandshake, type OwnerRecoveryProfile, type OwnerRecoveryRequest, type OwnerRecoveryResponse,
} from '@ikbr/shared/accounting-owner-recovery';
import { safeDiagnosticText } from '@ikbr/shared/diagnostics';
import { loadAccountingSettings } from './config.js';
import { resolveAccountingEndpoint } from './source-owner.js';
import { runMigrations } from '../migrations.js';
import { AccountingOwnerRecoveryStore, type AccountingOwnerRecoveryObserver } from './owner-recovery-store.js';
import { runOwnerRecoveryHandshake } from './owner-recovery-transport.js';

type AuthenticatedRequest = Extract<OwnerRecoveryRequest, { token: string }>;
type RecoveryObserver = Pick<AccountingOwnerRecoveryObserver, 'operation' | 'observerSessionId' | 'dbNow' | 'remainingMs'
  | 'assertActive' | 'dispatch' | 'handshakeClosed' | 'finalize' | 'cancel' | 'release'>;
type RecoveryStore = Pick<AccountingOwnerRecoveryStore, 'prepare' | 'supersede' | 'status'> & {
  beginObserve: (request: Extract<OwnerRecoveryRequest, { action: 'begin-observe' }>, endpointKey: string) => Promise<RecoveryObserver>;
};
const failure = (reason: string, cause?: unknown): Error => new Error(`ACCOUNTING_OWNER_RECOVERY_${reason}`, cause === undefined ? undefined : { cause });

export interface OwnerRecoveryCliDependencies {
  env: NodeJS.ProcessEnv;
  input: Readable;
  output: Writable;
  signal?: AbortSignal;
  open: (action: AuthenticatedRequest['action']) => Promise<{ store: RecoveryStore; close: () => Promise<void> }>;
  resolveEndpoint?: typeof resolveAccountingEndpoint;
  handshake?: typeof runOwnerRecoveryHandshake;
}

/** The launch profile is host-verified evidence; runtime settings and authorization are checked here independently. */
export async function validateOwnerRecoveryRuntime(request: AuthenticatedRequest, env: NodeJS.ProcessEnv,
  resolveEndpoint = resolveAccountingEndpoint): Promise<{ endpointKey: string; endpoint: { host: string; port: number } } | null> {
  const expected = env.EXECUTION_API_TOKEN;
  if (!expected || expected.length < 32 || request.token.length < 32
    || !timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(request.token).digest())) throw failure('AUTH_REQUIRED');
  const allowed = (env.ALLOWED_PAPER_ACCOUNTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (env.IBKR_ENVIRONMENT !== 'paper') throw failure('DISABLED_PAPER_REQUIRED');
  if (allowed.length !== 1 || !env.IBKR_ACCOUNT_ID || allowed[0] !== env.IBKR_ACCOUNT_ID || request.profile.accountId !== allowed[0]) throw failure('ACCOUNT_MISMATCH');
  // Historical status is authenticated account-bound readback, never permission to reuse old deployment evidence.
  if (request.action === 'status') return null;
  if (env.TRADING_ENABLED !== 'false') throw failure('DISABLED_PAPER_REQUIRED');
  let baseline: OwnerRecoveryProfile;
  try { baseline = parseOwnerRecoveryProfile(JSON.parse(env.ACCOUNTING_OWNER_RECOVERY_PROFILE_JSON ?? 'null')); }
  catch (error) { throw failure('DEPLOYMENT_CHANGED', error); }
  if (ownerRecoveryHash(baseline) !== ownerRecoveryHash(request.profile)) throw failure('DEPLOYMENT_CHANGED');
  const port = Number(env.IB_SOCKET_PORT);
  if (!env.IB_SOCKET_HOST || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw failure('SETTINGS_MISMATCH');
  let loaded;
  try {
    loaded = loadAccountingSettings({ path: env.EXECUTION_ACCOUNTING_SOURCE_PATH, sha256: env.EXECUTION_ACCOUNTING_SOURCE_SHA256,
      environment: env.IBKR_ENVIRONMENT, host: env.IB_SOCKET_HOST, port, accountId: env.IBKR_ACCOUNT_ID,
      allowedAccounts: allowed, timeZone: env.EXECUTION_BROKER_TIME_ZONE,
      clientIds: ['EXECUTION_CLIENT_ID', 'INGESTION_CLIENT_ID', 'BACKTEST_INGESTION_CLIENT_ID', 'IBKR_ES_ACQUISITION_CLIENT_ID',
        'IB_METADATA_CLIENT_ID', 'IB_COMPLETED_ORDERS_CLIENT_ID', 'IB_CONFIG_METADATA_CLIENT_ID', 'SESSION_SCHEDULE_CLIENT_ID']
        .map(key => env[key] === undefined ? undefined : Number(env[key])) });
  } catch (error) { throw failure('SETTINGS_MISMATCH', error); }
  if (!loaded || loaded.sha256 !== baseline.settingsHash || loaded.settings.accountId !== baseline.accountId
    || loaded.settings.sourceClientId !== 0 || loaded.settings.endpoint.host !== baseline.endpoint.host
    || loaded.settings.endpoint.port !== baseline.endpoint.port) throw failure('SETTINGS_MISMATCH');
  let resolved: Awaited<ReturnType<typeof resolveAccountingEndpoint>>;
  try { resolved = await resolveEndpoint(loaded.settings.endpoint); }
  catch (error) { throw failure('SETTINGS_MISMATCH', error); }
  return { endpointKey: resolved.key, endpoint: resolved.endpoint };
}

function safeFailure(error: unknown, env: NodeJS.ProcessEnv): Extract<OwnerRecoveryResponse, { ok: false }>['error'] {
  const outer = error instanceof Error ? error : undefined;
  const domainError = outer && /^ACCOUNTING_OWNER_RECOVERY_[A-Z_]+$/.test(outer.message);
  const original = outer?.cause ?? (domainError ? undefined : error);
  const record = original && typeof original === 'object' ? original as Record<string, unknown> : undefined;
  const privacy = { secrets: Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|KEY|POSTGRES_URL/i.test(key)).map(([, value]) => value ?? ''),
    accountIds: [env.IBKR_ACCOUNT_ID ?? ''] };
  const clean = (value: unknown, max: number): string | null => typeof value === 'string' && value.length ? safeDiagnosticText(value, privacy).trim().slice(0, max) || null : null;
  return { code: domainError ? outer.message : 'ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN',
    ...(record ? { cause: { name: clean(record.name, 200), code: typeof record.code === 'number' && Number.isSafeInteger(record.code)
      && record.code >= -2147483648 && record.code <= 2147483647 ? record.code : clean(record.code, 200), message: clean(record.message, 1000) } } : {}) };
}

export async function runOwnerRecoveryCli(deps: OwnerRecoveryCliDependencies): Promise<number> {
  let backend: Awaited<ReturnType<OwnerRecoveryCliDependencies['open']>> | undefined;
  let observer: RecoveryObserver | undefined;
  let authenticated: AuthenticatedRequest | undefined;
  let pinned: Awaited<ReturnType<typeof validateOwnerRecoveryRuntime>>;
  let handshake: OwnerRecoveryHandshake | undefined;
  let phase: 'initial' | 'reset' | 'finalize' | 'done' = 'initial';
  let revoked = false, busy = false, finished = false, exitCode = 1, bytes = 0;
  let pending = Buffer.alloc(0), active: Promise<void> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let budget: { wall: number; monotonic: number; remaining: number } | undefined;
  const seen = new Set<string>(), abort = new AbortController();
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const revoke = (): void => {
    revoked = true; observer?.cancel(); abort.abort();
    if (!busy) finish();
  };
  const assertLive = (): void => {
    if (revoked || deps.signal?.aborted || deps.input.readableEnded || deps.input.destroyed) throw failure('MUTATION_UNKNOWN');
    if (budget) {
      const elapsed = performance.now() - budget.monotonic;
      if (elapsed >= budget.remaining) throw failure('OBSERVATION_EXPIRED');
      if (Date.now() < budget.wall || Math.abs(Date.now() - budget.wall - elapsed) > OWNER_RECOVERY_LIMITS.clockDriftMs) throw failure('CLOCK_UNCERTAIN');
    }
    observer?.assertActive();
  };
  const write = async (response: OwnerRecoveryResponse): Promise<void> => {
    const line = JSON.stringify(parseOwnerRecoveryResponse(response)) + '\n';
    bytes += Buffer.byteLength(line);
    if (Buffer.byteLength(line) > OWNER_RECOVERY_LIMITS.messageBytes || bytes > OWNER_RECOVERY_LIMITS.sessionBytes) throw failure('MUTATION_UNKNOWN');
    await new Promise<void>((resolve, reject) => {
      const accepted = deps.output.write(line, error => error ? reject(error) : resolve());
      if (!accepted) { revoke(); reject(failure('MUTATION_UNKNOWN')); }
    });
  };
  const validateCurrent = async (): Promise<void> => {
    assertLive();
    const current = await validateOwnerRecoveryRuntime(authenticated!, deps.env, deps.resolveEndpoint);
    assertLive();
    if (ownerRecoveryHash(current) !== ownerRecoveryHash(pinned)) throw failure('SETTINGS_MISMATCH');
  };
  const handle = async (request: OwnerRecoveryRequest): Promise<void> => {
    assertLive();
    const ids = request.action === 'finalize-observation' ? [request.requestId, request.observedRequestId, request.commitRequestId] : [request.requestId];
    if (ids.some(id => seen.has(id))) throw failure('MUTATION_UNKNOWN');
    ids.forEach(id => seen.add(id));
    if (phase === 'initial') {
      if (!('token' in request)) throw failure('MUTATION_UNKNOWN');
      authenticated = request;
      pinned = await validateOwnerRecoveryRuntime(request, deps.env, deps.resolveEndpoint); assertLive();
      backend = await deps.open(request.action); assertLive();
      await validateCurrent();
      if (request.action === 'status') {
        const result = await backend.store.status(request); assertLive();
        phase = 'done'; await write({ version: 1, requestId: request.requestId, ok: true, action: 'status', result });
      } else if (request.action === 'prepare' || request.action === 'supersede') {
        const result = request.action === 'prepare' ? await backend.store.prepare(request, pinned!.endpointKey)
          : await backend.store.supersede(request, pinned!.endpointKey);
        assertLive(); phase = 'done';
        await write({ version: 1, requestId: request.requestId, ok: true, action: request.action === 'prepare' ? 'prepared' : 'superseded', result });
      } else {
        const started = performance.now();
        observer = await backend.store.beginObserve(request, pinned!.endpointKey);
        if (revoked) observer.cancel();
        assertLive();
        const remaining = observer.remainingMs - (performance.now() - started);
        if (remaining <= 0) throw failure('OBSERVATION_EXPIRED');
        budget = { wall: Date.now(), monotonic: performance.now(), remaining };
        clearTimeout(deadlineTimer); deadlineTimer = setTimeout(revoke, remaining);
        phase = 'reset';
        await write({ version: 1, requestId: request.requestId, ok: true, action: 'observer-ready', result: {
          // Keep the database sample coherent; both peers deduct their own elapsed begin-observe time.
          operation: observer.operation, observerSessionId: observer.observerSessionId, dbNow: observer.dbNow, remainingMs: observer.remainingMs,
        } });
      }
    } else if (phase === 'reset' && request.action === 'reset-proof' && request.observerSessionId === observer!.observerSessionId) {
      await validateCurrent();
      const dispatchEventId = await observer!.dispatch(request.requestId, request.evidence); assertLive();
      await validateCurrent();
      if (budget!.remaining - (performance.now() - budget!.monotonic) < OWNER_RECOVERY_LIMITS.handshakeMs) throw failure('OBSERVATION_EXPIRED');
      const result = await (deps.handshake ?? runOwnerRecoveryHandshake)({ endpoint: pinned!.endpoint, accountId: authenticated!.profile.accountId,
        signal: abort.signal, privacy: { secrets: [deps.env.EXECUTION_API_TOKEN ?? ''], accountIds: [authenticated!.profile.accountId] } });
      assertLive();
      if (result.accountId !== authenticated!.profile.accountId || result.clientId !== 0) throw failure('ACCOUNT_MISMATCH');
      handshake = parseOwnerRecoveryHandshake({ sessionId: observer!.observerSessionId, dispatchEventId, accountId: result.accountId, clientId: result.clientId,
        serverVersion: result.protocolVersion, connectedAt: result.connectedAt, readyAt: result.readyAt, closedAt: result.closedAt, socketCloseObserved: result.transportClosed });
      await validateCurrent(); await observer!.handshakeClosed(handshake); assertLive();
      phase = 'finalize';
      await write({ version: 1, requestId: request.requestId, ok: true, action: 'handshake-closed', result: { handshake, handshakeDigest: ownerRecoveryHash(handshake) } });
    } else if (phase === 'finalize' && request.action === 'finalize-observation' && request.observerSessionId === observer!.observerSessionId) {
      if (request.handshakeDigest !== ownerRecoveryHash(handshake)) throw failure('HANDSHAKE_UNKNOWN');
      await validateCurrent();
      const result = await observer!.finalize(request, validateCurrent);
      // A durable commit may win a transport race. Only exact status readback may resolve that outcome.
      if (revoked) throw failure('MUTATION_UNKNOWN');
      await observer!.release();
      if (revoked) throw failure('MUTATION_UNKNOWN');
      observer = undefined; phase = 'done';
      await write({ version: 1, requestId: request.requestId, ok: true, action: 'committed', result: { ...result, unlockAcknowledged: true } });
    } else throw failure('MUTATION_UNKNOWN');
    if (phase === 'done') { exitCode = 0; finished = true; finish(); }
  };
  const onData = (chunk: Buffer | string): void => {
    if (finished || revoked) { revoke(); return; }
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += input.length;
    if (busy || bytes > OWNER_RECOVERY_LIMITS.sessionBytes || pending.length + input.length > OWNER_RECOVERY_LIMITS.messageBytes) { revoke(); return; }
    pending = Buffer.concat([pending, input]);
    const newline = pending.indexOf(10);
    if (newline < 0) return;
    if (newline !== pending.length - 1) { revoke(); return; }
    let request: OwnerRecoveryRequest;
    try { request = parseOwnerRecoveryRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, newline)))); }
    catch { revoke(); return; }
    pending = Buffer.alloc(0); busy = true;
    active = handle(request).catch(async error => {
      const wasRevoked = revoked; revoke();
      if (!wasRevoked && !deps.output.destroyed) {
        try { await write({ version: 1, requestId: request.requestId, ok: false, error: safeFailure(error, deps.env) }); } catch { /* Output loss leaves exact request readback as the only resolution. */ }
      }
    }).finally(() => { busy = false; if (revoked || finished) finish(); });
  };
  deps.input.on('data', onData); deps.input.on('end', revoke); deps.input.on('close', revoke); deps.input.on('error', revoke);
  deps.output.on('error', revoke); deps.output.on('close', revoke); deps.signal?.addEventListener('abort', revoke, { once: true });
  deadlineTimer = setTimeout(revoke, OWNER_RECOVERY_LIMITS.operationMs);
  if (deps.signal?.aborted || deps.input.readableEnded || deps.input.destroyed) revoke();
  try { await completed; await active; }
  finally {
    clearTimeout(deadlineTimer); observer?.cancel(); abort.abort();
    try { await observer?.release(); } catch { exitCode = 1; }
    try { await backend?.close(); } catch { exitCode = 1; }
    deps.input.off('data', onData); deps.input.off('end', revoke); deps.input.off('close', revoke); deps.input.off('error', revoke);
    deps.input.pause();
    deps.output.off('error', revoke); deps.output.off('close', revoke); deps.signal?.removeEventListener('abort', revoke);
  }
  return exitCode;
}

export async function accountingOwnerRecoveryMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const controller = new AbortController(), stop = (): void => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop);
  try {
    if (process.argv.length !== 2) throw failure('MUTATION_UNKNOWN');
    return await runOwnerRecoveryCli({ env, input: process.stdin, output: process.stdout, signal: controller.signal,
      open: async action => {
        if (!env.POSTGRES_URL) throw failure('MUTATION_UNKNOWN');
        const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 2, connectionTimeoutMillis: 2000, query_timeout: 2000,
          statement_timeout: 2000, idleTimeoutMillis: 2000 });
        pool.on('error', stop);
        try {
          if (action !== 'status') await runMigrations(pool);
          return { store: new AccountingOwnerRecoveryStore(pool), close: () => pool.end() };
        }
        catch (error) { await pool.end(); throw failure('MUTATION_UNKNOWN', error); }
      } });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('SIGHUP', stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  accountingOwnerRecoveryMain().then(code => { process.exitCode = code; }).catch(() => {
    process.stderr.write('Odzyskanie właściciela księgowania niepotwierdzone. ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN\n'); process.exitCode = 1;
  });
}
