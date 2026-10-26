import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseOwnerRecoveryRequest, parseOwnerRecoveryResponse, parseOwnerRecoveryOperatorEvidence,
  ownerRecoveryHash, OWNER_RECOVERY_LIMITS, type OwnerRecoveryRequest, type OwnerRecoveryResponse,
  type OwnerRecoveryProfile, type OwnerRecoveryInventory, type OwnerRecoveryOperatorEvidence,
  type OwnerRecoveryHostEvidence, type OwnerRecoveryOperation, type OwnerRecoveryStatus } from '@ikbr/shared/accounting-owner-recovery';
import { canonicalJson, verifyProof, validateRenderedCompose } from './paper-runtime.js';
import { runDocker } from './paper-runtime-cli.js';
import { createAccountingRecoveryHost, runRecoveryHostCommand, startAccountingDockerWatcher, ACCOUNTING_APP_SERVICES, AccountingRecoveryHostError, ACCOUNTING_NATIVE_DIAGNOSTICS,
  type AccountingRecoveryException, type AccountingEventWatcher } from './accounting-owner-recovery-host.js';

const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function check(v: unknown, code = 'ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN'): asserts v { if (!v) throw new Error(code); }
const obj = (v: unknown): Record<string, unknown> => { check(v && typeof v === 'object' && !Array.isArray(v), 'ACCOUNTING_OWNER_RECOVERY_DEPLOYMENT_CHANGED'); return v as Record<string, unknown>; };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export type AccountingRecoveryLocalProfile = { wire: OwnerRecoveryProfile; compose: string[]; root: string };
export type AccountingRecoveryCommand = { action: 'prepare' | 'observe' | 'status' | 'supersede'; operationId?: string; evidencePath?: string };
export type AccountingRecoveryChannel = { request(value: OwnerRecoveryRequest): Promise<OwnerRecoveryResponse>; finish(): Promise<void>; cancel(): void };
export type AccountingRecoverySaved = { version: 1; operationId: string; requestId: string; action: OwnerRecoveryRequest['action']; digest: string; commitRequestId?: string; observedRequestId?: string };
type Host = ReturnType<typeof createAccountingRecoveryHost>;
export type AccountingRecoveryDependencies = {
  actor: string; token: string; profile(): Promise<AccountingRecoveryLocalProfile>;
  host(profile: AccountingRecoveryLocalProfile): Host;
  start(profile: AccountingRecoveryLocalProfile, requestId: string, host: Host, readOnly?: boolean): Promise<{ channel: AccountingRecoveryChannel; watcher: AccountingEventWatcher; startedAt: string }>;
  evidence(path: string): Promise<OwnerRecoveryOperatorEvidence>;
  save(record: AccountingRecoverySaved): Promise<void>;
  load(operationId: string): Promise<AccountingRecoverySaved[]>;
  now(): number; monotonicNow(): number; sleep(ms: number): Promise<void>; log(text: string): void; signal?: AbortSignal;
};

export async function readAccountingPrivateFile(path: string, limit: number): Promise<Buffer> {
  check(isAbsolute(path), 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
  const st = await lstat(path), parent = await lstat(dirname(path));
  check(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600 && st.size <= limit && parent.isDirectory() &&
    !parent.isSymbolicLink() && (parent.mode & 0o777) === 0o700 && await realpath(path) === resolve(path), 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const actual = await fd.stat(); check(actual.ino === st.ino && actual.dev === st.dev && actual.size === st.size, 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID'); return await fd.readFile(); }
  finally { await fd.close(); }
}
export async function readAccountingOperatorEvidence(path: string): Promise<OwnerRecoveryOperatorEvidence> {
  const value = parseOwnerRecoveryOperatorEvidence(JSON.parse((await readAccountingPrivateFile(path, 65536)).toString('utf8')));
  let size = 0;
  for (const artifact of value.artifacts) {
    const file = resolve(dirname(path), artifact.relativePath), rel = relative(dirname(path), file);
    check(!isAbsolute(artifact.relativePath) && rel === artifact.relativePath && !rel.startsWith('..') && /\.(png|jpe?g|txt)$/i.test(file), 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
    const bytes = await readAccountingPrivateFile(file, 5 * 1024 * 1024); size += bytes.length;
    check(size <= 20 * 1024 * 1024 && sha(bytes) === artifact.sha256, 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
    if (/\.png$/i.test(file)) check(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
    if (/\.jpe?g$/i.test(file)) check(bytes[0] === 255 && bytes[1] === 216, 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
    if (/\.txt$/i.test(file)) new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  return value;
}

export async function readAccountingRecoveryProfile(root: string, token: string, statusOnly = false): Promise<AccountingRecoveryLocalProfile> {
  root = await realpath(root);
  check(process.platform === 'darwin', 'ACCOUNTING_OWNER_RECOVERY_UNSUPPORTED_HOST');
  const proofPath = resolve(root, '.local/paper-runtime/release.json');
  await readAccountingPrivateFile(proofPath, 100000);
  const proof = await verifyProof(root, proofPath);
  const compose = ['--project-directory', root, '--env-file', resolve(root, '.env'), '-f', resolve(root, 'docker-compose.yml'),
    '-f', resolve(root, '.local/paper-runtime/redis-internal.override.yml'), '-f', resolve(root, '.local/paper-runtime/compose.override.json')];
  const context = await runRecoveryHostCommand('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']);
  check(context.exitCode === 0 && context.stderr === '', 'ACCOUNTING_OWNER_RECOVERY_UNSUPPORTED_HOST');
  const dockerHost: unknown = JSON.parse(context.stdout);
  check(typeof dockerHost === 'string' && /^unix:\/\/(?:\/Users\/[^\s]+\/\.docker\/run\/docker\.sock|\/var\/run\/docker\.sock)$/.test(dockerHost), 'ACCOUNTING_OWNER_RECOVERY_UNSUPPORTED_HOST');
  const raw = JSON.parse(await runDocker(['--host', dockerHost, 'compose', ...compose, 'config', '--format', 'json']));
  check(sha(canonicalJson(raw)) === proof.effectiveComposeSha256, 'ACCOUNTING_OWNER_RECOVERY_DEPLOYMENT_CHANGED');
  const validated = await validateRenderedCompose(raw, proof, root, true);
  check((await runDocker(['--host', dockerHost, 'image', 'inspect', '--format', '{{.Id}}', proof.imageId])).trim() === proof.imageId, 'ACCOUNTING_OWNER_RECOVERY_DEPLOYMENT_CHANGED');
  const config = obj(raw), services = obj(config.services), execution = obj(services['execution-engine']), env = obj(execution.environment);
  for (const name of ACCOUNTING_APP_SERVICES) {
    if (!services[name]) { check(['ui', 'backtest-engine'].includes(name), 'ACCOUNTING_OWNER_RECOVERY_DEPLOYMENT_CHANGED'); continue; }
    const service = obj(services[name]), environment = obj(service.environment);
    check(service.image === proof.imageId && service.entrypoint == null, 'ACCOUNTING_OWNER_RECOVERY_DEPLOYMENT_CHANGED');
    if (!statusOnly && ('TRADING_ENABLED' in environment || !['ui', 'backtest-engine'].includes(name))) check(environment.TRADING_ENABLED === 'false', 'ACCOUNTING_OWNER_RECOVERY_DISABLED_PAPER_REQUIRED');
  }
  const expected = String(env.EXECUTION_API_TOKEN ?? '');
  check(token.length >= 32 && expected.length >= 32 && Buffer.byteLength(token) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(token), Buffer.from(expected)), 'ACCOUNTING_OWNER_RECOVERY_AUTH_REQUIRED');
  const path = String(env.EXECUTION_ACCOUNTING_SOURCE_PATH ?? '');
  check(path.startsWith('/app/private-accounting/') && !path.split('/').includes('..'), 'ACCOUNTING_OWNER_RECOVERY_SETTINGS_MISMATCH');
  const bytes = await readAccountingPrivateFile(resolve(root, '.local/paper-runtime/accounting', path.slice('/app/private-accounting/'.length)), 16384);
  const settings = obj(JSON.parse(bytes.toString('utf8'))), endpoint = obj(settings.endpoint), settingsHash = sha(bytes);
  check(settingsHash === env.EXECUTION_ACCOUNTING_SOURCE_SHA256 && settings.environment === 'paper' && settings.sourceClientId === 0 && settings.accountId === validated.accountId &&
    env.IBKR_ACCOUNT_ID === validated.accountId && endpoint.host === env.IB_SOCKET_HOST && endpoint.port === Number(env.IB_SOCKET_PORT) &&
    ['127.0.0.1', 'localhost', 'host.docker.internal'].includes(String(endpoint.host)), 'ACCOUNTING_OWNER_RECOVERY_SETTINGS_MISMATCH');
  const host = createAccountingRecoveryHost({ project: String(config.name), imageId: proof.imageId, dockerHost, root, host: String(endpoint.host), port: Number(endpoint.port) });
  return { root, compose, wire: { project: String(config.name), imageId: proof.imageId, deploymentHash: proof.effectiveComposeSha256, dockerHost,
    hostIdHash: await host.hostIdentityHash(), settingsHash, accountId: validated.accountId, endpoint: { host: String(endpoint.host), port: Number(endpoint.port), clientId: 0 } } };
}

export async function executeAccountingRecovery(command: AccountingRecoveryCommand, deps: AccountingRecoveryDependencies): Promise<string> {
  const profile = await deps.profile(), wire = profile.wire;
  check(deps.token.length >= 32 && typeof deps.actor === 'string' && deps.actor.length > 0 && deps.actor.length <= 200 && !/[\x00-\x1f\x7f]/.test(deps.actor), 'ACCOUNTING_OWNER_RECOVERY_AUTH_REQUIRED');
  const active = () => check(!deps.signal?.aborted, 'ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN');
  const unchanged = async () => { active(); check(canonicalJson((await deps.profile()).wire) === canonicalJson(wire), 'ACCOUNTING_OWNER_RECOVERY_DEPLOYMENT_CHANGED'); };
  const authenticated = (requestId: string) => ({ version: 1 as const, requestId, actor: deps.actor, token: deps.token, profile: wire });
  const durable = async (request: OwnerRecoveryRequest, operationId: string) => {
    const { token: _token, ...safe } = request as OwnerRecoveryRequest & { token?: string };
    await deps.save({ version: 1, operationId, requestId: request.requestId, action: request.action, digest: ownerRecoveryHash(safe),
      ...(request.action === 'finalize-observation' ? { observedRequestId: request.observedRequestId, commitRequestId: request.commitRequestId } : {}) });
  };
  const response = async (channel: AccountingRecoveryChannel, request: OwnerRecoveryRequest) => {
    active(); const parsed = parseOwnerRecoveryResponse(await channel.request(parseOwnerRecoveryRequest(request)));
    check(parsed.requestId === request.requestId, 'ACCOUNTING_OWNER_RECOVERY_RECEIPT_MISMATCH');
    if (!parsed.ok) throw new Error(parsed.error.code, { cause: parsed.error.cause });
    return parsed;
  };
  const openSession = async (requestId: string) => {
    const host = deps.host(profile), session = await deps.start(profile, requestId, host);
    try {
      const inventory = await host.captureProducerInventory(); await session.watcher.flush();
      return { host, inventory, ...session };
    } catch (error) { session.channel.cancel(); session.watcher.close(); throw error; }
  };
  const exactStatus = async (operationId: string, lookupRequestId?: string, allowUnknownRequest = false): Promise<OwnerRecoveryStatus> => {
    const id = randomUUID(), session = await deps.start(profile, id, deps.host(profile), true);
    try {
      const result = await response(session.channel, { ...authenticated(id), action: 'status', operationId, ...(lookupRequestId ? { lookupRequestId } : {}) });
      check(result.action === 'status'); await session.channel.finish(); session.watcher.check();
      if (lookupRequestId) check(result.result.lookup?.requestId === lookupRequestId || allowUnknownRequest && result.result.lookup === null, 'ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN');
      return result.result;
    } finally { session.channel.cancel(); session.watcher.close(); }
  };
  if (command.action === 'status') {
    check(uuid(command.operationId));
    const saved = await deps.load(command.operationId);
    const last = saved.find(r => r.commitRequestId) ?? saved.find(r => r.action === 'reset-proof') ?? saved.filter(r => r.action !== 'begin-observe').at(-1), lookup = last?.commitRequestId ?? last?.requestId;
    const status = await exactStatus(command.operationId, lookup, true);
    const operation = status.operation;
    const lines = [`Operacja ${command.operationId}: ${operation?.state ?? 'brak potwierdzenia'}; blokada konserwacyjna: ${status.maintenancePending ? 'aktywna' : 'nieaktywna'}; operacja blokująca: ${status.pendingOperationId ?? 'brak'}.`];
    if (lookup && status.lookup === null) lines.push(`Żądanie ${lookup}: UNKNOWN — brak trwałego potwierdzenia. Brak zdarzenia nie potwierdza wycofania zapisu; nie ponawiaj operacji.`);
    if (operation) lines.push(`Powiązanie: ${operation.bindingDigest}; endpoint: ${operation.owner.endpointKey}; właściciel: ${operation.owner.ownerId}; generacja: ${operation.owner.generation}; rewizja pauzy: ${operation.pauseRevision}.`,
      `Przygotowano: ${operation.preparedAt}; termin: ${operation.expiresAt}; następca: ${operation.successorOperationId ?? 'brak'}; dowód: ${operation.evidenceDigest ?? 'brak'}.`,
      `Wdrożenie: ${operation.profile.deploymentHash}; obraz: ${operation.profile.imageId}; ustawienia: ${operation.profile.settingsHash}; host: ${operation.profile.hostIdHash}.`);
    for (const event of status.events) lines.push(`Zdarzenie ${event.eventId}: ${event.kind}; żądanie ${event.requestId}; czas ${event.recordedAt}; operator ${event.actor}; powiązanie ${event.bindingDigest}; dowód ${event.evidenceDigest ?? 'brak'}.`);
    if (status.receipt) lines.push(`Potwierdzenie ${status.receipt.receiptId}; żądanie zapisu ${status.receipt.commitRequestId}; zapisano ${status.receipt.committedAt}; dowód ${status.receipt.evidenceDigest}.`);
    return lines.join('\n');
  }
  if (command.action === 'prepare' || command.action === 'supersede') {
    check(command.evidencePath && (command.action === 'prepare' || uuid(command.operationId)));
    const id = randomUUID(), operationId = command.action === 'prepare' ? randomUUID() : command.operationId!;
    const replacementOperationId = command.action === 'supersede' ? randomUUID() : undefined;
    const session = await openSession(id);
    let dispatched = false;
    try {
      const operatorEvidence = await deps.evidence(command.evidencePath); await unchanged();
      const inventory = await session.host.verifyProducerInventory(session.inventory); await session.watcher.flush();
      const request: OwnerRecoveryRequest = command.action === 'prepare'
        ? { ...authenticated(id), action: 'prepare', operationId, operatorEvidence, inventory }
        : { ...authenticated(id), action: 'supersede', operationId, replacementOperationId: replacementOperationId!, operatorEvidence, inventory };
      await durable(request, operationId); deps.log(`Operacja ${operationId}; żądanie ${id}. Nie powtarzaj zapisu przy nieznanym wyniku.`);
      dispatched = true;
      const result = await response(session.channel, request);
      check(result.action === (command.action === 'prepare' ? 'prepared' : 'superseded'));
      const prepared = result.result as OwnerRecoveryOperation;
      check(prepared.operationId === (replacementOperationId ?? operationId) && prepared.state === 'PREPARED', 'ACCOUNTING_OWNER_RECOVERY_RECEIPT_MISMATCH');
      await session.channel.finish(); session.watcher.check();
      return `Przygotowano operację ${prepared.operationId}; termin ${prepared.expiresAt}. Obserwacja i zapis odbywają się razem w poleceniu observe. Blokada pozostaje aktywna.`;
    } catch (error) {
      session.channel.cancel(); session.watcher.close();
      if (!dispatched) throw error;
      const status = await exactStatus(operationId, id);
      check(status.lookup?.operationId === operationId && ['PREPARED', 'SUPERSEDED'].includes(status.lookup.kind));
      return `Potwierdzono zapis żądania ${id}; operacja ${status.operation?.successorOperationId ?? operationId}. Blokada pozostaje aktywna.`;
    } finally { session.channel.cancel(); session.watcher.close(); }
  }
  check(command.action === 'observe' && uuid(command.operationId) && command.evidencePath);
  const operationId = command.operationId;
  const status = await exactStatus(operationId);
  check(status.operation?.state === 'PREPARED' && canonicalJson(status.operation.profile) === canonicalJson(wire), 'ACCOUNTING_OWNER_RECOVERY_OWNER_CHANGED');
  // Local dispatch history forbids a restarted collector from continuing observation.
  check(!(await deps.load(operationId)).some(r => r.action === 'begin-observe' || r.action === 'reset-proof' || r.action === 'finalize-observation'), 'ACCOUNTING_OWNER_RECOVERY_RESET_UNPROVEN');
  const wallStart = deps.now(), monoStart = deps.monotonicNow(), collectorStartedAt = new Date(wallStart).toISOString();
  const id = randomUUID(), session = await openSession(id);
  let remaining = 0, dbSampleAt = '', dbRoundTripMs = 0, commitRequestId: string | undefined, evidenceDigest: string | undefined;
  let committed = false, lastWall = wallStart, lastMono = monoStart;
  const bounded = () => {
    active(); session.watcher.check();
    const currentWall = deps.now(), currentMono = deps.monotonicNow();
    check(currentWall >= lastWall && currentMono >= lastMono, 'ACCOUNTING_OWNER_RECOVERY_CLOCK_UNCERTAIN');
    lastWall = currentWall; lastMono = currentMono;
    const wall = currentWall - wallStart, mono = currentMono - monoStart;
    check(wall >= 0 && mono >= 0 && Math.abs(wall - mono) <= 1000, 'ACCOUNTING_OWNER_RECOVERY_CLOCK_UNCERTAIN');
    check(mono < remaining, 'ACCOUNTING_OWNER_RECOVERY_OBSERVATION_EXPIRED');
  };
  try {
    await unchanged();
    const begin: OwnerRecoveryRequest = { ...authenticated(id), action: 'begin-observe', operationId, bindingDigest: status.operation.bindingDigest };
    await durable(begin, operationId);
    const dbStart = deps.monotonicNow();
    const ready = await response(session.channel, begin);
    dbRoundTripMs = Math.ceil(deps.monotonicNow() - dbStart);
    check(ready.action === 'observer-ready' && dbRoundTripMs <= 2000, 'ACCOUNTING_OWNER_RECOVERY_CLOCK_UNCERTAIN');
    remaining = ready.result.remainingMs + (dbStart - monoStart); dbSampleAt = ready.result.dbNow;
    check(Math.abs(Date.parse(dbSampleAt) - deps.now()) <= 1000 + dbRoundTripMs && ready.result.remainingMs <= Date.parse(ready.result.operation.expiresAt) - Date.parse(dbSampleAt), 'ACCOUNTING_OWNER_RECOVERY_CLOCK_UNCERTAIN');
    const operation = ready.result.operation, observerSessionId = ready.result.observerSessionId;
    bounded();
    const before = await session.host.captureGatewayProcess();
    const poll = async <T>(work: () => Promise<T>, pending: string): Promise<T> => {
      for (;;) { bounded(); await session.host.verifyProducerInventory(session.inventory); try { return await work(); } catch (error) { if (!(error instanceof Error) || error.message !== pending) throw error; } await deps.sleep(500); }
    };
    deps.log('Obserwacja aktywna. Zamknij ręcznie cały TWS. Poczekaj na potwierdzenie zniknięcia procesu i nasłuchu.');
    const stopped = await poll(() => session.host.assertGatewayStopped(before), 'ACCOUNTING_OWNER_RECOVERY_GATEWAY_STILL_RUNNING');
    await session.host.verifyProducerInventory(session.inventory); bounded();
    deps.log('Potwierdzono pełne zatrzymanie TWS. Uruchom ręcznie TWS i przygotuj nowy prywatny dowód stanu konta.');
    const after = await poll(() => session.host.verifyGatewayReplacement(before), 'ACCOUNTING_OWNER_RECOVERY_GATEWAY_NOT_STARTED');
    deps.log(`Powiązanie afterReset do nowego dowodu operatora: ${JSON.stringify({ operationId, nonce: operation.nonce, process: after.process })}`);
    deps.log(`Nowe obserwacje i artefakty muszą pochodzić z chwili ${after.observedAt} lub późniejszej. Zapisz prywatny plik: ${command.evidencePath}.`);
    const operatorEvidence = await poll(async () => {
      try { return await deps.evidence(command.evidencePath!); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('EVIDENCE_PENDING'); throw error; }
    }, 'EVIDENCE_PENDING');
    const witness = async (): Promise<OwnerRecoveryHostEvidence> => {
      bounded(); await unchanged();
      const current = await session.host.verifyGatewayReplacement(before);
      check(canonicalJson(current.process) === canonicalJson(after.process), 'ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
      check(canonicalJson(await deps.evidence(command.evidencePath!)) === canonicalJson(operatorEvidence), 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
      const finalInventory = await session.host.verifyProducerInventory(session.inventory); await session.watcher.flush(); bounded();
      return { version: 1, operationId, nonce: operation.nonce, bindingDigest: operation.bindingDigest, profile: wire,
        collectorStartedAt, before, stopped, after, current, initialInventory: session.inventory, finalInventory,
        dockerEvents: { startedAt: session.startedAt, checkedAt: new Date(deps.now()).toISOString(), continuous: true, noProducerStarts: true },
        clock: { wallStartedAt: collectorStartedAt, wallCheckedAt: new Date(deps.now()).toISOString(), monotonicElapsedMs: Math.floor(deps.monotonicNow() - monoStart), dbSampleAt, dbRoundTripMs }, operatorEvidence };
    };
    const reset: OwnerRecoveryRequest = { version: 1, action: 'reset-proof', requestId: randomUUID(), observerSessionId, evidence: await witness() };
    await durable(reset, operationId); bounded();
    const closed = await response(session.channel, reset);
    check(closed.action === 'handshake-closed' && closed.result.handshake.sessionId === observerSessionId, 'ACCOUNTING_OWNER_RECOVERY_CLOSURE_UNKNOWN');
    const evidence = await witness(); evidenceDigest = ownerRecoveryHash({ evidence, handshake: closed.result.handshake });
    commitRequestId = randomUUID();
    const finalize: OwnerRecoveryRequest = { version: 1, action: 'finalize-observation', requestId: randomUUID(), observerSessionId,
      observedRequestId: randomUUID(), commitRequestId, handshakeDigest: closed.result.handshakeDigest, evidence };
    await durable(finalize, operationId); bounded();
    const result = await response(session.channel, finalize);
    check(result.action === 'committed' && result.result.receipt.operationId === operationId && result.result.receipt.commitRequestId === commitRequestId &&
      result.result.receipt.bindingDigest === operation.bindingDigest && result.result.receipt.evidenceDigest === evidenceDigest && result.result.unlockAcknowledged === true, 'ACCOUNTING_OWNER_RECOVERY_RECEIPT_MISMATCH');
    await session.channel.finish();
    session.host.clearOneShot(); await witness(); committed = true;
  } finally {
    session.channel.cancel(); session.watcher.close();
    if (commitRequestId) {
      const readback = await exactStatus(operationId, commitRequestId);
      check(readback.receipt?.operationId === operationId && readback.receipt.commitRequestId === commitRequestId && readback.receipt.evidenceDigest === evidenceDigest &&
        readback.receipt.bindingDigest === status.operation.bindingDigest && readback.operation?.state === 'COMMITTED', 'ACCOUNTING_OWNER_RECOVERY_RECEIPT_MISMATCH');
      if (!committed) deps.log(`Potwierdzono zakończenie starego właściciela połączenia: ${readback.receipt.receiptId}. Ciągłość obserwacji lub zwolnienie blokady niepotwierdzone; wynik operacyjny pozostaje nieudany.`);
    }
  }
  return `Potwierdzono zakończenie starego właściciela połączenia w operacji ${operationId}. Pozostałe blokady i kwalifikacja źródła pozostają bez zmian.`;
}

export async function startAccountingRecoveryBackend(profile: AccountingRecoveryLocalProfile, requestId: string, host: Host,
  signal?: AbortSignal, readOnly = false): Promise<{ channel: AccountingRecoveryChannel; watcher: AccountingEventWatcher; startedAt: string }> {
  const name = `accounting-owner-recovery-${requestId}`;
  let startedAt = new Date().toISOString();
  let child: ReturnType<typeof spawn> | undefined, cancelled = false;
  const stop = () => { cancelled = true; child?.kill('SIGTERM'); };
  const options = { project: profile.wire.project, imageId: profile.wire.imageId, dockerHost: profile.wire.dockerHost,
    host: profile.wire.endpoint.host, port: profile.wire.endpoint.port, root: profile.root };
  let watcher: AccountingEventWatcher = { check: () => undefined, flush: async () => undefined, allow: () => undefined, close: () => undefined };
  const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C' };
  try {
    check(!signal?.aborted);
    if (!readOnly) {
      const initialized = await startAccountingDockerWatcher(options, stop, name);
      watcher = initialized; startedAt = initialized.startedAt;
      check(!signal?.aborted);
      await createAccountingRecoveryHost(options).captureProducerInventory();
    }
    watcher.check();
    const selectedDocker = await runRecoveryHostCommand('/usr/bin/which', ['docker']);
    check(selectedDocker.exitCode === 0 && !selectedDocker.stderr && /^\/[^\r\n]+\n?$/.test(selectedDocker.stdout), 'ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    const dockerExecutable = await realpath(selectedDocker.stdout.trim());
    check(dockerExecutable.endsWith('/docker'), 'ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    const launchArgs = ['--host', profile.wire.dockerHost, 'compose', ...profile.compose, 'run', '--rm', '--no-deps', '-T', '--name', name,
      '--entrypoint', 'node', '-e', `ACCOUNTING_OWNER_RECOVERY_PROFILE_JSON=${JSON.stringify(profile.wire)}`, 'execution-engine', 'apps/execution-engine/dist/accounting/owner-recovery-cli.js'];
    const launchedAt = new Date().toISOString();
    child = spawn(dockerExecutable, launchArgs, { stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnv });
    const processChild = child;
    check(processChild.stdin && processChild.stdout && processChild.stderr);
    let exited = false, exitCode: number | null = null, output = '', received = 0, sent = 0, stderr = 0;
    let waiting: { id: string; resolve(value: OwnerRecoveryResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
    const fail = () => {
      stop();
      if (waiting) {
        let failure: Error = new Error('ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN');
        try { watcher.check(); } catch (error) { if (error instanceof Error) failure = error; }
        clearTimeout(waiting.timer); waiting.reject(failure); waiting = undefined;
      }
    };
    processChild.on('error', fail); processChild.stdin.on('error', fail);
    processChild.on('close', code => { exited = true; exitCode = code; if (waiting) fail(); });
    processChild.stderr.on('data', (part: Buffer) => { stderr += part.length; if (stderr > 65536) fail(); });
    processChild.stdout.on('data', (part: Buffer) => {
      received += part.length; output += part.toString('utf8');
      if (received + sent > OWNER_RECOVERY_LIMITS.sessionBytes || Buffer.byteLength(output) > OWNER_RECOVERY_LIMITS.messageBytes) { fail(); return; }
      const index = output.indexOf('\n'); if (index < 0) return;
      const line = output.slice(0, index); output = output.slice(index + 1);
      try {
        const response = parseOwnerRecoveryResponse(JSON.parse(line));
        if (!waiting || response.requestId !== waiting.id || output.length) { fail(); return; }
        clearTimeout(waiting.timer); const resolveResponse = waiting.resolve; waiting = undefined; resolveResponse(response);
      } catch { fail(); }
    });
    signal?.addEventListener('abort', fail, { once: true }); if (signal?.aborted) fail();
    const deadline = performance.now() + 15000;
    let exception: AccountingRecoveryException | undefined;
    while (!exception) {
      check(!cancelled && !exited && performance.now() < deadline);
      const inspected = await runRecoveryHostCommand('docker', ['--host', profile.wire.dockerHost, 'ps', '-a', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
      check(inspected.exitCode === 0 && inspected.stderr === '');
      const id = inspected.stdout.trim();
      if (id) { check(/^[a-f0-9]{64}$/.test(id)); exception = { containerId: id, imageId: profile.wire.imageId, name, requestId }; }
      else await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    const inspected = await runRecoveryHostCommand('docker', ['--host', profile.wire.dockerHost, 'inspect', '--type', 'container', '--format', '{{json .}}', exception.containerId]);
    check(inspected.exitCode === 0 && !inspected.stderr);
    const container = obj(JSON.parse(inspected.stdout)), config = obj(container.Config), labels = obj(config.Labels), state = obj(container.State);
    check(container.Id === exception.containerId && container.Image === profile.wire.imageId && container.Name === `/${name}` && labels['com.docker.compose.project'] === profile.wire.project && labels['com.docker.compose.service'] === 'execution-engine' &&
      String(labels['com.docker.compose.oneoff']).toLowerCase() === 'true' && canonicalJson(config.Entrypoint) === canonicalJson(['node']) && canonicalJson(config.Cmd) === canonicalJson(['apps/execution-engine/dist/accounting/owner-recovery-cli.js']) && state.Running === true, 'ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    check(Number.isSafeInteger(processChild.pid) && !cancelled && !exited, 'ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    host.allowOneShot(exception, { pid: processChild.pid!, executable: dockerExecutable, args: launchArgs, startedAt: launchedAt }); watcher.allow(exception);
    watcher.check();
    const absoluteTimer = setTimeout(fail, OWNER_RECOVERY_LIMITS.operationMs);
    const cleanup = () => { clearTimeout(absoluteTimer); signal?.removeEventListener('abort', fail); };
    return { watcher, startedAt, channel: {
      request: async request => {
        watcher.check(); check(!waiting && !cancelled && !exited); await watcher.flush(); check(!cancelled && !exited);
        const line = JSON.stringify(parseOwnerRecoveryRequest(request)) + '\n'; sent += Buffer.byteLength(line);
        check(Buffer.byteLength(line) <= OWNER_RECOVERY_LIMITS.messageBytes && sent + received <= OWNER_RECOVERY_LIMITS.sessionBytes);
        return new Promise<OwnerRecoveryResponse>((resolveResponse, reject) => {
          const timer = setTimeout(fail, request.action === 'reset-proof' ? 15000 : 10000);
          waiting = { id: request.requestId, resolve: resolveResponse, reject, timer };
          processChild.stdin!.write(line, error => { if (error) fail(); });
        });
      },
      finish: async () => {
        processChild.stdin!.end(); const end = performance.now() + 5000;
        while (!exited && performance.now() < end) await new Promise(resolveWait => setTimeout(resolveWait, 25));
        cleanup(); watcher.check(); check(exited && exitCode === 0 && !cancelled && !output, 'ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN');
      },
      cancel: () => { cleanup(); if (!exited) fail(); },
    } };
  } catch (error) {
    let failure = error;
    try { watcher.check(); } catch (watcherError) { failure = watcherError; }
    stop(); watcher.close(); throw failure;
  }
}

async function accountingStateStore(root: string) {
  const directory = resolve(root, '.local/paper-runtime/accounting-owner-recovery');
  await mkdir(directory, { mode: 0o700 });
  return directory;
}
export async function runAccountingOwnerRecoveryCli(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 1 && ['--help', 'help'].includes(argv[0])) {
    process.stdout.write('prepare --operator-evidence <prywatny plik>; observe --operation <uuid> --operator-evidence <nowy prywatny plik>; status --operation <uuid>; supersede --operation <uuid> --operator-evidence <prywatny plik>. Observe obserwuje pełny reset i zapisuje wynik w tym samym procesie; osobne commit nie istnieje. Token: OWNER_RECOVERY_API_TOKEN; operator: OWNER_RECOVERY_OPERATOR.\n'); return 0;
  }
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { operation: { type: 'string' }, 'operator-evidence': { type: 'string' } } });
  check(positionals.length === 1 && ['prepare', 'observe', 'status', 'supersede'].includes(positionals[0]), 'ACCOUNTING_OWNER_RECOVERY_USAGE');
  const action = positionals[0] as AccountingRecoveryCommand['action'];
  check(action === 'prepare' ? !values.operation && values['operator-evidence'] : uuid(values.operation) && (action === 'status' ? !values['operator-evidence'] : values['operator-evidence']), 'ACCOUNTING_OWNER_RECOVERY_USAGE');
  const root = await realpath(resolve(env.INIT_CWD ?? process.cwd())), token = env.OWNER_RECOVERY_API_TOKEN ?? '', actor = env.OWNER_RECOVERY_OPERATOR ?? '';
  check(token.length >= 32 && actor, 'ACCOUNTING_OWNER_RECOVERY_AUTH_REQUIRED');
  let directory: string;
  try { directory = await accountingStateStore(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; directory = resolve(root, '.local/paper-runtime/accounting-owner-recovery'); }
  const stat = await lstat(directory); check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && await realpath(directory) === directory, 'ACCOUNTING_OWNER_RECOVERY_OPERATOR_EVIDENCE_INVALID');
  const controller = new AbortController(), abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await executeAccountingRecovery({ action, operationId: values.operation, evidencePath: values['operator-evidence'] }, {
      actor, token, profile: () => readAccountingRecoveryProfile(root, token, action === 'status'),
      host: p => createAccountingRecoveryHost({ ...p.wire, root: p.root, host: p.wire.endpoint.host, port: p.wire.endpoint.port }),
      start: (p, id, host, readOnly) => startAccountingRecoveryBackend(p, id, host, controller.signal, readOnly), evidence: readAccountingOperatorEvidence,
      save: async record => {
        const file = resolve(directory, `${record.operationId}.${record.requestId}.json`), fd = await open(file, 'wx', 0o600);
        try { await fd.writeFile(JSON.stringify(record)); await fd.sync(); } finally { await fd.close(); }
        const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
      },
      load: async operationId => {
        check(uuid(operationId)); const { readdir } = await import('node:fs/promises'); const records: AccountingRecoverySaved[] = [];
        for (const file of (await readdir(directory)).sort()) if (file.startsWith(`${operationId}.`) && file.endsWith('.json')) {
          const saved = JSON.parse((await readAccountingPrivateFile(resolve(directory, file), 65536)).toString('utf8')) as AccountingRecoverySaved;
          check(saved.version === 1 && saved.operationId === operationId && uuid(saved.requestId) && file === `${operationId}.${saved.requestId}.json` && /^[a-f0-9]{64}$/.test(saved.digest), 'ACCOUNTING_OWNER_RECOVERY_RECEIPT_MISMATCH'); records.push(saved);
        }
        return records;
      },
      now: Date.now, monotonicNow: () => performance.now(), sleep: ms => new Promise(resolveWait => setTimeout(resolveWait, ms)),
      log: text => process.stdout.write(text + '\n'), signal: controller.signal,
    });
    process.stdout.write(result + '\n'); return 0;
  } catch (error) {
    const code = error instanceof Error && /^ACCOUNTING_OWNER_RECOVERY_[A-Z_]+$/.test(error.message) ? error.message : 'ACCOUNTING_OWNER_RECOVERY_MUTATION_UNKNOWN';
    process.stderr.write(`${code}: Nie potwierdzono poprawnego zakończenia procedury. Sprawdź status dokładnego żądania; nie ponawiaj niepewnego zapisu.\n`);
    const diagnostic = accountingWatcherDiagnostic(error);
    if (diagnostic) process.stderr.write(`Diagnostyka lokalna: ${diagnostic}.\n`);
    return 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
export function accountingWatcherDiagnostic(error: unknown): string | null {
  if (!(error instanceof AccountingRecoveryHostError) || !error.cause || typeof error.cause !== 'object') return null;
  const cause = error.cause as { name?: unknown; code?: unknown };
  for (const [phase, reasons] of Object.entries(ACCOUNTING_NATIVE_DIAGNOSTICS)) {
    if (cause.name === `AccountingNativeInventory:${phase}` && typeof cause.code === 'string' && (reasons as readonly string[]).includes(cause.code)) return `${cause.name}/${cause.code}`;
  }
  return typeof cause.name === 'string' && /^AccountingDockerEventWatcher:(bootstrap|replay|stream|guard|lifecycle)$/.test(cause.name) &&
    typeof cause.code === 'string' && /^[A-Z_]{1,64}$/.test(cause.code) ? `${cause.name}/${cause.code}` : null;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void runAccountingOwnerRecoveryCli().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('Nieprawidłowe argumenty lub prywatna konfiguracja. Użyj --help.\n'); process.exitCode = 2; });
