import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseRecoveryEvidence, researchHash, type RecoveryChallenge, type RecoveryEvidence, type RecoveryQuiescenceEvidence,
  type WshRecoveryEvidence, type RecoveryKind, recoveryDiagnosticFailure, recoveryDiagnosticPrivacy,
  parseRecoveryDiagnostic, RecoveryDiagnosticFailure, formatRecoveryFailure, type RecoveryDiagnosticStage } from '@ikbr/shared/instrument-research';
import type { DiagnosticPrivacy } from '@ikbr/shared/diagnostics';
import { canonicalJson, validateRenderedCompose, verifyProof } from './paper-runtime.js';
import { runDocker } from './paper-runtime-cli.js';
import { createResearchRecoveryHost, runRecoveryHostCommand } from './research-recovery-host.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
function check(value: unknown, code = 'RESEARCH_RECOVERY_INVALID'): asserts value { if (!value) throw new Error(code); }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
export interface RecoveryProfile {
  project: string; imageId: string; deploymentHash: string; compose: string[]; dockerHost: string;
  endpointId: string; host: string; port: number; clientId: number;
  diagnosticPrivacy?: DiagnosticPrivacy;
}
type Host = ReturnType<typeof createResearchRecoveryHost>;
type Saved = { version: 1; challenge: RecoveryChallenge; deploymentHash: string; evidence?: RecoveryEvidence; operationId?: string; replacementOperationId?: string };
type Command = { action: 'prepare' | 'observe' | 'commit' | 'supersede' | 'status'; kind?: RecoveryKind; instrumentId?: string; challengeId?: string };
export type RecoveryCliDependencies = {
  profile(): Promise<RecoveryProfile>; oneShot(profile: RecoveryProfile, request: unknown): Promise<unknown>;
  host(profile: RecoveryProfile): Host; load(id: string): Promise<Saved>; save(id: string, saved: Saved): Promise<void>;
  log(text: string): void; sleep(ms: number): Promise<void>; now(): number; monotonicNow(): number; signal?: AbortSignal;
};
function challenge(value: unknown): RecoveryChallenge {
  const c = object(value);
  check(c && uuid(c.id) && uuid(c.nonce) && typeof c.challengeHash === 'string' && /^[a-f0-9]{64}$/.test(c.challengeHash)
    && ['PREPARED', 'COMMITTED', 'CANCELLED'].includes(String(c.state)) && typeof c.instrumentId === 'string'
    && ['MARKETAUX_PRODUCER_QUIESCENCE', 'WSH_ENDPOINT_RESET'].includes(String(c.kind)), 'RESEARCH_RECOVERY_CHALLENGE_INVALID');
  return value as RecoveryChallenge;
}
export async function executeRecoveryCommand(command: Command, deps: RecoveryCliDependencies): Promise<string> {
  let stage: RecoveryDiagnosticStage = 'profile';
  let privacy: DiagnosticPrivacy = {};
  try {
  const profile = await deps.profile();
  privacy = profile.diagnosticPrivacy ?? {};
  const unchanged = async () => {
    stage = 'profile-recheck';
    try {
      const next = await deps.profile();
      check(next.deploymentHash === profile.deploymentHash && next.dockerHost === profile.dockerHost, 'RESEARCH_RECOVERY_DEPLOYMENT_CHANGED');
    } catch (error) {
      const failure = recoveryDiagnosticFailure(error, stage, privacy);
      if (failure.diagnostic.stage === 'profile') failure.diagnostic.stage = stage;
      throw failure;
    }
  };
  const active = () => check(!deps.signal?.aborted, 'RESEARCH_RECOVERY_INTERRUPTED');
  const remember = async (found: RecoveryChallenge) => {
    stage = 'state-load';
    let existing: Saved | undefined;
    try { existing = await deps.load(found.id); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; }
    if (existing) check(existing.version === 1 && existing.challenge.id === found.id && existing.challenge.challengeHash === found.challengeHash, 'RESEARCH_RECOVERY_STATE_INVALID');
    stage = 'state-save';
    await deps.save(found.id, existing ? { ...existing, challenge: found } : { version: 1, challenge: found, deploymentHash: profile.deploymentHash });
  };
  active();
  if (command.instrumentId !== undefined) check(/^[A-Za-z0-9_.:-]{1,200}$/.test(command.instrumentId));
  if (command.action === 'status') {
    stage = 'status';
    check(command.kind && command.instrumentId && uuid(command.challengeId));
    const found = await deps.oneShot(profile, { action: 'replacement', kind: command.kind, instrumentId: command.instrumentId, operationId: command.challengeId });
    check(found, 'RESEARCH_RECOVERY_PREPARE_UNKNOWN');
    const prepared = challenge(found);
    await remember(prepared);
    return `Potwierdzono recovery ${prepared.id}; stan ${prepared.state}.`;
  }
  if (command.action === 'prepare') {
    check(command.kind && command.instrumentId);
    const host = deps.host(profile);
    stage = 'producer-inventory'; await host.captureProducerInventory();
    const operationId = randomUUID();
    // Preserve the mutation ID before sending. An unknown result is never resent.
    const request = { action: 'prepare', kind: command.kind, instrumentId: command.instrumentId, operationId };
    stage = 'state-save'; await deps.save(operationId, { version: 1, challenge: { ...request, id: operationId } as unknown as RecoveryChallenge, deploymentHash: profile.deploymentHash, operationId });
    deps.log(`Identyfikator operacji: ${operationId}. Przy niepewnym wyniku użyj status --kind ${command.kind === 'WSH_ENDPOINT_RESET' ? 'wsh' : 'marketaux'} --instrument ${command.instrumentId} --challenge ${operationId}.`);
    let result: unknown;
    try { await unchanged(); stage = 'prepare'; result = await deps.oneShot(profile, request); }
    catch (error) {
      const first = recoveryDiagnosticFailure(error, stage, privacy);
      try {
        result = await deps.oneShot(profile, { action: 'replacement', kind: command.kind, instrumentId: command.instrumentId, operationId });
        check(result, 'RESEARCH_RECOVERY_PREPARE_UNKNOWN'); challenge(result);
      } catch { throw recoveryDiagnosticFailure(new Error('RESEARCH_RECOVERY_PREPARE_UNKNOWN'), 'prepare', privacy, first); }
    }
    const prepared = challenge(result);
    await remember(prepared);
    return `Przygotowano recovery ${prepared.id}. Wejścia pozostają wstrzymane. Następnie uruchom observe dla tego identyfikatora.`;
  }
  check(uuid(command.challengeId));
  stage = 'state-load';
  const saved = await deps.load(command.challengeId), old = challenge(saved.challenge);
  check(saved.version === 1 && old.id === command.challengeId && (command.action === 'supersede' || saved.deploymentHash === profile.deploymentHash), 'RESEARCH_RECOVERY_DEPLOYMENT_CHANGED');
  if (command.action === 'supersede') {
    check(command.instrumentId);
    const collectorStartedAt = new Date(deps.now()).toISOString(), host = deps.host(profile);
    stage = 'producer-inventory'; const producers = await host.captureProducerInventory();
    stage = 'producer-recheck'; const second = await host.verifyProducerInventory(producers);
    stage = 'host-identity'; const hostIdHash = await host.hostIdentityHash();
    stage = 'evidence-parse';
    const evidence = parseRecoveryEvidence({ version: 'local-research-recovery-v1', kind: 'PRODUCER_QUIESCENCE', challengeId: old.id,
      challengeHash: old.challengeHash, nonce: old.nonce, hostIdHash, platform: 'darwin', collectorStartedAt,
      producerCheckedAt: producers.observedAt, producerRecheckedAt: second.observedAt, deploymentHash: profile.deploymentHash,
      producers: producers.producers, runningProducerIds: [] }, true) as RecoveryQuiescenceEvidence;
    if (saved.replacementOperationId) {
      stage = 'supersede';
      const found = await deps.oneShot(profile, { action: 'replacement', kind: old.kind, instrumentId: command.instrumentId, operationId: saved.replacementOperationId });
      check(found, 'RESEARCH_RECOVERY_SUPERSESSION_UNKNOWN');
      const replacement = challenge(found);
      await remember(replacement);
      return `Potwierdzono zastępcze recovery ${replacement.id}; utrzymano wstrzymanie wejść.`;
    }
    const operationId = randomUUID(); saved.replacementOperationId = operationId; stage = 'state-save'; await deps.save(old.id, saved);
    await unchanged(); active();
    let result: unknown;
    stage = 'supersede';
    try { result = await deps.oneShot(profile, { action: 'supersede', challengeId: old.id, challengeHash: old.challengeHash,
      kind: old.kind, instrumentId: command.instrumentId, operationId, evidence }); }
    catch (error) {
      const first = recoveryDiagnosticFailure(error, stage, privacy);
      try {
        result = await deps.oneShot(profile, { action: 'replacement', kind: old.kind, instrumentId: command.instrumentId, operationId });
        check(result, 'RESEARCH_RECOVERY_SUPERSESSION_UNKNOWN'); challenge(result);
      } catch { throw recoveryDiagnosticFailure(new Error('RESEARCH_RECOVERY_SUPERSESSION_UNKNOWN'), 'supersede', privacy, first); }
    }
    check(result, 'RESEARCH_RECOVERY_SUPERSESSION_UNKNOWN');
    const replacement = challenge(result); await remember(replacement);
    return `Utworzono zastępcze recovery ${replacement.id}; utrzymano wstrzymanie wejść.`;
  }
  stage = 'challenge-read';
  const current = challenge(await deps.oneShot(profile, { action: 'read', challengeId: old.id }));
  check(current.challengeHash === old.challengeHash);
  if (command.action === 'commit') {
    const verifyReceipt = async (confirmed: RecoveryChallenge, submitted: RecoveryEvidence) => {
      stage = 'commit-readback';
      check(saved.operationId && confirmed.state === 'COMMITTED' && confirmed.receiptId && confirmed.challengeHash === old.challengeHash, 'RESEARCH_RECOVERY_COMMIT_UNKNOWN');
      const receipt = object(await deps.oneShot(profile, { action: 'receipt', challengeId: old.id, operationId: saved.operationId }));
      check(receipt && receipt.id === confirmed.receiptId && receipt.challengeId === old.id && receipt.kind === old.kind
        && receipt.evidenceHash === researchHash(submitted), 'RESEARCH_RECOVERY_COMMIT_UNKNOWN');
    };
    if (current.state === 'COMMITTED') {
      check(saved.evidence, 'RESEARCH_RECOVERY_COMMIT_UNKNOWN');
      await verifyReceipt(current, parseRecoveryEvidence(saved.evidence) as RecoveryEvidence);
      return `Recovery ${current.id} jest zapisane. Wymagane jest zwykłe pełne pobranie świeżych danych.`;
    }
    check(current.state === 'PREPARED' && saved.evidence, 'RESEARCH_RECOVERY_OBSERVATION_REQUIRED');
    check(!saved.operationId, 'RESEARCH_RECOVERY_COMMIT_UNKNOWN');
    stage = 'evidence-parse'; let evidence = parseRecoveryEvidence(saved.evidence) as RecoveryEvidence;
    stage = 'producer-inventory'; const host = deps.host(profile), inventory = await host.captureProducerInventory();
    check(canonicalJson(inventory.producers) === canonicalJson(evidence.producers), 'RESEARCH_RECOVERY_PRODUCERS_CHANGED');
    stage = 'producer-recheck'; const rechecked = await host.verifyProducerInventory(inventory);
    stage = 'evidence-parse';
    evidence = parseRecoveryEvidence({ ...evidence, producerRecheckedAt: rechecked.observedAt }) as RecoveryEvidence;
    stage = 'host-identity'; check(await host.hostIdentityHash() === evidence.hostIdHash && deps.now() >= Date.parse(evidence.producerRecheckedAt)
      && deps.now() - Date.parse(evidence.collectorStartedAt) <= 900000, 'RESEARCH_RECOVERY_EVIDENCE_EXPIRED');
    await unchanged(); active();
    saved.evidence = evidence; saved.operationId = randomUUID(); stage = 'state-save'; await deps.save(old.id, saved);
    let first: RecoveryDiagnosticFailure | undefined;
    stage = 'commit';
    try { await deps.oneShot(profile, { action: 'commit', challengeId: old.id, challengeHash: old.challengeHash, operationId: saved.operationId, evidence }); }
    catch (error) { first = recoveryDiagnosticFailure(error, stage, privacy); }
    stage = 'commit-readback';
    let after: RecoveryChallenge;
    try {
      after = challenge(await deps.oneShot(profile, { action: 'read', challengeId: old.id }));
      await verifyReceipt(after, evidence);
    } catch (error) { throw recoveryDiagnosticFailure(error, stage, privacy, first); }
    return `Zapisano recovery ${after.receiptId}. Wejścia pozostają wstrzymane do pełnego pobrania i normalnej kontroli gotowości.`;
  }
  check(current.state === 'PREPARED' && !saved.evidence, 'RESEARCH_RECOVERY_OBSERVATION_ALREADY_RECORDED');
  const start = deps.now(), monotonicStart = deps.monotonicNow(), host = deps.host(profile);
  const collectorStartedAt = new Date(start).toISOString();
  const bounded = () => {
    active(); const elapsed = deps.now() - start, monotonicElapsed = deps.monotonicNow() - monotonicStart;
    check(elapsed >= 0 && elapsed < 900000 && monotonicElapsed >= 0 && monotonicElapsed < 900000 && Math.abs(elapsed - monotonicElapsed) <= 1000, 'RESEARCH_RECOVERY_OBSERVATION_EXPIRED');
  };
  stage = 'producer-inventory'; const producers = await host.captureProducerInventory();
  let wsh: Pick<WshRecoveryEvidence, 'endpointId' | 'endpointSettingsHash' | 'host' | 'port' | 'clientId' | 'before' | 'stopped' | 'after' | 'reconnect'> | undefined;
  if (current.kind === 'WSH_ENDPOINT_RESET') {
    check(current.endpointId === profile.endpointId);
    stage = 'gateway-before'; const before = await host.captureGatewayProcess(profile.port);
    deps.log('Obserwacja aktywna. Zamknij ręcznie cały proces TWS/Gateway, odczekaj na potwierdzenie zatrzymania, a potem uruchom go ponownie. Polecenie nie steruje aplikacją brokera.');
    const poll = async <T>(work: () => Promise<T>, pending: string): Promise<T> => {
      for (;;) { bounded(); try { return await work(); } catch (error) { if (!(error instanceof Error) || error.message !== pending) throw error; } await deps.sleep(500); }
    };
    stage = 'gateway-stop'; const stopped = await poll(() => host.assertGatewayStopped(before, profile.port), 'RESEARCH_RECOVERY_GATEWAY_STILL_RUNNING');
    deps.log('Potwierdzono zakończenie poprzedniego procesu i zniknięcie nasłuchu. Możesz teraz uruchomić TWS/Gateway.');
    stage = 'gateway-replacement'; const after = await poll(() => host.verifyGatewayReplacement(before, profile.port), 'RESEARCH_RECOVERY_GATEWAY_NOT_STARTED');
    bounded(); await unchanged();
    stage = 'reconnect'; const reconnect = await deps.oneShot(profile, { action: 'reconnect', challengeId: old.id, challengeHash: old.challengeHash }) as WshRecoveryEvidence['reconnect'];
    wsh = { endpointId: profile.endpointId, endpointSettingsHash: researchHash({ endpointId: profile.endpointId, host: profile.host, port: profile.port, clientId: profile.clientId }),
      host: profile.host, port: profile.port, clientId: profile.clientId, before, stopped, after, reconnect };
  }
  bounded(); stage = 'producer-recheck'; const second = await host.verifyProducerInventory(producers); bounded();
  stage = 'host-identity'; const hostIdHash = await host.hostIdentityHash();
  stage = 'evidence-parse';
  const evidence = parseRecoveryEvidence({ version: 'local-research-recovery-v1', kind: current.kind, challengeId: old.id, challengeHash: old.challengeHash,
    nonce: old.nonce, hostIdHash, platform: 'darwin', collectorStartedAt,
    producerCheckedAt: producers.observedAt, producerRecheckedAt: second.observedAt, deploymentHash: profile.deploymentHash,
    producers: producers.producers, runningProducerIds: [], ...wsh }) as RecoveryEvidence;
  stage = 'state-save'; await deps.save(old.id, { ...saved, evidence });
  return `Zapisano obserwację dla ${old.id}. Polecenie commit zapisze zweryfikowany dowód w bazie; nie wznowi wejść.`;
  } catch (error) { throw recoveryDiagnosticFailure(error, stage, privacy); }
}

export function decodeRecoveryOneShot(output: string, code: number | null, failed: boolean, privacy: DiagnosticPrivacy = {}): unknown {
  let result: Record<string, unknown> | null = null;
  try { if (Buffer.byteLength(output) <= 131072) result = object(JSON.parse(output)); } catch { /* Never expose raw child output. */ }
  if (code === 0 && !failed && result?.ok === true) return result.result;
  const diagnostic = !failed && result?.ok === false && result.reason === 'RESEARCH_RECOVERY_FAILED_OR_UNKNOWN'
    && Object.keys(result).sort().join(',') === 'diagnostic,ok,reason' ? parseRecoveryDiagnostic(result.diagnostic) : null;
  if (diagnostic) throw recoveryDiagnosticFailure(new RecoveryDiagnosticFailure('RESEARCH_RECOVERY_FAILED_OR_UNKNOWN', diagnostic), 'subprocess', privacy);
  if (code !== null) throw new RecoveryDiagnosticFailure('RESEARCH_RECOVERY_FAILED_OR_UNKNOWN', {
    version: 1, stage: 'subprocess', reason: code === 0 ? 'RESEARCH_RECOVERY_SUBPROCESS_OUTPUT_INVALID' : 'RESEARCH_RECOVERY_SUBPROCESS_EXIT',
    original: { name: null, code, message: null },
  });
  throw recoveryDiagnosticFailure(new Error('RESEARCH_RECOVERY_FAILED_OR_UNKNOWN'), 'subprocess', privacy);
}

export async function runRecoveryOneShot(profile: RecoveryProfile, input: unknown, signal?: AbortSignal,
  spawnProcess: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams = spawn): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const child = spawnProcess('docker', ['--host', profile.dockerHost, 'compose', ...profile.compose, 'run', '--rm', '--no-deps', '-T', 'llm-agent',
      'node', 'apps/llm-agent/dist/research-recovery-cli.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', size = 0, failed = false, failure: unknown;
    const stop = () => { failed = true; child.kill('SIGTERM'); };
    const timeout = () => { failure ??= new Error('RESEARCH_RECOVERY_SUBPROCESS_TIMEOUT'); stop(); };
    const abort = () => { failure ??= new Error('RESEARCH_RECOVERY_INTERRUPTED'); stop(); };
    const timer = setTimeout(timeout, 30000), hard = setTimeout(() => { failure ??= new Error('RESEARCH_RECOVERY_SUBPROCESS_TIMEOUT'); failed = true; child.kill('SIGKILL'); }, 32000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', (part: Buffer) => { size += part.length; if (size > 131072) { failure ??= new Error('RESEARCH_RECOVERY_SUBPROCESS_OUTPUT_LIMIT'); stop(); } else output += part.toString('utf8'); });
    child.stderr.on('data', () => undefined); child.stdin.on('error', error => { failure ??= error; stop(); });
    child.once('error', error => { failure ??= error; failed = true; });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(hard); signal?.removeEventListener('abort', abort);
      try {
        if (failure) throw recoveryDiagnosticFailure(failure, 'subprocess', profile.diagnosticPrivacy);
        resolveResult(decodeRecoveryOneShot(output, code, failed, profile.diagnosticPrivacy));
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function readRecoveryProfile(root: string): Promise<RecoveryProfile> {
  let privacy: DiagnosticPrivacy | undefined;
  try {
  const compose = ['--project-directory', root, '--env-file', resolve(root, '.env'), '-f', resolve(root, 'docker-compose.yml'),
    '-f', resolve(root, '.local/paper-runtime/redis-internal.override.yml'), '-f', resolve(root, '.local/paper-runtime/compose.override.json')];
  const inspected = await runRecoveryHostCommand('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']);
  check(inspected.exitCode === 0 && !inspected.stderr.trim());
  const dockerHost: unknown = JSON.parse(inspected.stdout);
  check(typeof dockerHost === 'string' && /^unix:\/\/(?:\/Users\/[^\s]+\/\.docker\/run\/docker\.sock|\/var\/run\/docker\.sock)$/.test(dockerHost));
  const proof = await verifyProof(root, resolve(root, '.local/paper-runtime/release.json'));
  const raw = JSON.parse(await runDocker(['--host', dockerHost, 'compose', ...compose, 'config', '--format', 'json']));
  check(sha(canonicalJson(raw)) === proof.effectiveComposeSha256, 'RESEARCH_RECOVERY_DEPLOYMENT_CHANGED');
  await validateRenderedCompose(raw, proof, root, true);
  check((await runDocker(['--host', dockerHost, 'image', 'inspect', '--format', '{{.Id}}', proof.imageId], { maxBytes: 256 })).trim() === proof.imageId);
  const config = object(raw), services = object(config?.services), app = object(services?.['llm-agent']), e = object(app?.environment);
  if (e) privacy = recoveryDiagnosticPrivacy(e as NodeJS.ProcessEnv);
  check(e && typeof config?.name === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(config.name));
  const host = String(e.RESEARCH_WSH_HOST || e.IB_SOCKET_HOST), port = Number(e.RESEARCH_WSH_PORT || e.IB_SOCKET_PORT), clientId = Number(e.RESEARCH_WSH_CLIENT_ID), endpointId = String(e.RESEARCH_WSH_ENDPOINT_ID ?? '');
  check(e.RESEARCH_WSH_ENABLED === 'true' && /^[A-Za-z0-9_.:-]{1,200}$/.test(endpointId) && ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host)
    && Number.isSafeInteger(port) && port > 0 && port <= 65535 && Number.isSafeInteger(clientId) && clientId > 0 && clientId <= 2147483647);
  return { project: config.name, imageId: proof.imageId, deploymentHash: proof.effectiveComposeSha256, compose, dockerHost, endpointId, host, port, clientId,
    diagnosticPrivacy: privacy };
  } catch (error) {
    const failure = recoveryDiagnosticFailure(error, 'profile', privacy);
    if (!privacy) failure.diagnostic.original = { name: null, code: null, message: null };
    throw failure;
  }
}

async function stateDirectory(root: string): Promise<string> {
  let path = root;
  for (const segment of ['.local', 'paper-runtime', 'recovery']) {
    path = resolve(path, segment); await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(path); check(stat.isDirectory() && !stat.isSymbolicLink(), 'RESEARCH_RECOVERY_STATE_INVALID');
  }
  return path;
}
export async function runRecoveryHostCli(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { kind: { type: 'string' }, instrument: { type: 'string' }, challenge: { type: 'string' } } });
  check(positionals.length === 1 && ['prepare', 'observe', 'commit', 'supersede', 'status'].includes(positionals[0]), 'RESEARCH_RECOVERY_USAGE');
  const action = positionals[0] as Command['action'];
  check(action === 'prepare' || action === 'status' ? ['marketaux', 'wsh'].includes(values.kind ?? '') && values.instrument && (action === 'prepare' ? !values.challenge : uuid(values.challenge))
    : uuid(values.challenge) && !values.kind && (action === 'supersede' ? values.instrument : !values.instrument), 'RESEARCH_RECOVERY_USAGE');
  const root = resolve(env.INIT_CWD ?? process.cwd()), directory = await stateDirectory(root), controller = new AbortController();
  const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await executeRecoveryCommand({ action, kind: action === 'prepare' || action === 'status' ? values.kind === 'wsh' ? 'WSH_ENDPOINT_RESET' : 'MARKETAUX_PRODUCER_QUIESCENCE' : undefined,
      instrumentId: values.instrument, challengeId: values.challenge }, {
      profile: () => readRecoveryProfile(root), oneShot: (p, input) => runRecoveryOneShot(p, input, controller.signal),
      host: p => createResearchRecoveryHost(p), now: Date.now, monotonicNow: () => performance.now(), signal: controller.signal,
      log: text => process.stdout.write(text + '\n'), sleep: ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
      load: async id => { check(uuid(id)); const file = resolve(directory, `${id}.json`), stat = await lstat(file); check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536); return JSON.parse(await readFile(file, 'utf8')) as Saved; },
      save: async (id, value) => { check(uuid(id)); const temp = resolve(directory, `${id}.${randomUUID()}.tmp`); await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, resolve(directory, `${id}.json`)); },
    });
    process.stdout.write(result + '\n'); return 0;
  } catch (error) {
    process.stderr.write('Recovery nie zostało potwierdzone. Zachowano wstrzymanie; nie powtarzaj niepewnego restartu ani zapisu.\n'
      + formatRecoveryFailure(error, 'arguments', recoveryDiagnosticPrivacy(env)) + '\n'); return 1;
  }
  finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void runRecoveryHostCli().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('Użycie: pnpm paper:research-recovery prepare --kind marketaux|wsh --instrument <id>; observe|commit --challenge <uuid>; supersede --challenge <uuid> --instrument <id>\n'); process.exitCode = 2; });
