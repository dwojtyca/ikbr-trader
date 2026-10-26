import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { safeDiagnosticText } from '@ikbr/shared/diagnostics';
import type { OwnerRecoveryProcess as RecoveryProcess, OwnerRecoveryProducer as RecoveryProducer, OwnerRecoveryInventory } from '@ikbr/shared/accounting-owner-recovery';

const MAX_OUTPUT = 2 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export type RecoveryHostCommandResult = { stdout: string; stderr: string; exitCode: number; pid?: number };
export type RecoveryHostCommandRunner = (file: string, args: readonly string[]) => Promise<RecoveryHostCommandResult>;
export type RecoveryProducerInventory = OwnerRecoveryInventory;
export type RecoveryGatewayObservation = { observedAt: string; process: RecoveryProcess };
export type RecoveryGatewayStopped = { observedAt: string; processAbsent: true; listenerAbsent: true };
export type AccountingRecoveryHostOptions = { project: string; imageId: string; host: string; port: number; dockerHost: string; root: string };
export type AccountingRecoveryHostAdapters = {
  run?: RecoveryHostCommandRunner;
  platform?: NodeJS.Platform;
  now?: () => Date;
  knownExternalProducers?: boolean;
};
export class AccountingRecoveryHostError extends Error {
  constructor(readonly code: string, cause?: { name: string | null; code: string | number | null; message: string | null }) { super(code, cause ? { cause } : undefined); }
}
function deny(code = 'ACCOUNTING_OWNER_RECOVERY_UNSUPPORTED_HOST'): never { throw new AccountingRecoveryHostError(code); }

// Native inspection only. The environment cannot redirect Docker to a remote daemon.
export const runRecoveryHostCommand: RecoveryHostCommandRunner = (file, args) => new Promise((resolve, reject) => {
  const child = execFile(file, [...args], { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
    HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C', LANG: 'C', TZ: 'UTC',
  } }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== 'number')) {
      reject(new AccountingRecoveryHostError('ACCOUNTING_OWNER_RECOVERY_INSPECTION_UNAVAILABLE', {
        name: safeDiagnosticText(error.name), code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null,
        message: safeDiagnosticText(error.message),
      }));
      return;
    }
    resolve({ stdout, stderr, exitCode: error ? Number(error.code) : 0, pid: child.pid });
  });
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function dockerInstant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)) return deny();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000) return deny();
  return date.toISOString();
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return deny();
  return value as Record<string, unknown>;
}
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return deny(); } }
function processEqual(a: RecoveryProcess, b: RecoveryProcess): boolean {
  return a.pid === b.pid && a.startIdentity === b.startIdentity && a.executableHash === b.executableHash;
}

export function createAccountingRecoveryHost(options: AccountingRecoveryHostOptions, adapters: AccountingRecoveryHostAdapters = {}) {
  options = { ...options };
  if ((adapters.platform ?? process.platform) !== 'darwin' || adapters.knownExternalProducers ||
      !['127.0.0.1', 'localhost', 'host.docker.internal'].includes(options.host) ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project) || !/^sha256:[a-f0-9]{64}$/.test(options.imageId) ||
      !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) deny();
  const run = adapters.run ?? runRecoveryHostCommand;
  const now = adapters.now ?? (() => new Date());
  const started = now().getTime();
  if (!Number.isFinite(started)) deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_EXPIRED');
  let last = started;
  let before: RecoveryGatewayObservation | undefined;
  let stopped: RecoveryGatewayStopped | undefined;
  let inventory: RecoveryProducerInventory | undefined;
  const dockerHost = options.dockerHost;
  function timestamp(): string {
    const value = now().getTime();
    if (!Number.isFinite(value) || value < last || value - started > 15 * 60_000) return deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_EXPIRED');
    last = value;
    return new Date(value).toISOString();
  }
  const command: InspectCommand = async (file, args, allowAbsent = false) => {
    timestamp();
    const result = await run(file, args);
    command.lastPid = result.pid;
    timestamp();
    if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT || result.stderr.trim()) throw new AccountingRecoveryHostError('ACCOUNTING_OWNER_RECOVERY_INSPECTION_UNAVAILABLE', { name: null, code: result.exitCode, message: typeof result.stderr === 'string' && result.stderr ? safeDiagnosticText(result.stderr) : null });
    if (allowAbsent && result.exitCode === 1 && result.stdout === '' && result.stderr === '') return null;
    if (result.exitCode !== 0 || /\0/.test(result.stdout)) throw new AccountingRecoveryHostError('ACCOUNTING_OWNER_RECOVERY_INSPECTION_UNAVAILABLE', { name: null, code: result.exitCode, message: null });
    return result.stdout;
  };
  const portCheck = (port: number) => { if (port !== options.port) deny('ACCOUNTING_OWNER_RECOVERY_ENDPOINT_CHANGED'); };
  async function hostIdentityHash(): Promise<string> {
    const output = await command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const matches = [...output!.matchAll(/"IOPlatformUUID"\s*=\s*"([^"]+)"/g)];
    if (matches.length !== 1 || !uuid.test(matches[0][1])) return deny();
    return sha(`darwin:${matches[0][1].toLowerCase()}`);
  }
  async function inspectProducers(): Promise<RecoveryProducerInventory> {
    const result = await inspectAccountingProducers(options, command, timestamp, exception);
    result.nativeProcesses = await inspectAccountingNative(options, command, process.pid, await listener(), nativeLaunch);
    return result;
  }
  let exception: AccountingRecoveryException | undefined;
  let nativeLaunch: AccountingRecoveryNativeLaunch | undefined;
  function allowOneShot(value: AccountingRecoveryException, launch?: Omit<AccountingRecoveryNativeLaunch, 'identities'>): void {
    if (exception) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    exception = structuredClone(value);
    nativeLaunch = launch && structuredClone(launch);
  }
  function clearOneShot(): void { exception = undefined; nativeLaunch = undefined; }
  async function inspectNative() {
    return inspectAccountingNative(options, command, process.pid, await listener(), nativeLaunch);
  }
  async function captureProducerInventory(): Promise<RecoveryProducerInventory> {
    if (inventory) deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_SEQUENCE');
    inventory = await inspectProducers();
    return structuredClone(inventory);
  }
  async function verifyProducerInventory(previous: RecoveryProducerInventory): Promise<RecoveryProducerInventory> {
    const captured = inventory;
    if (!captured || JSON.stringify(previous) !== JSON.stringify(captured)) return deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_SEQUENCE');
    const next = await inspectProducers();
    if (JSON.stringify(next.producers) !== JSON.stringify(captured.producers)) deny('ACCOUNTING_OWNER_RECOVERY_PRODUCER_REPLACED');
    return next;
  }
  async function listener(): Promise<number | null> {
    const output = await command('/usr/sbin/lsof', ['-nP', '-a', `-iTCP:${options.port}`, '-sTCP:LISTEN', '-Fpfn'], true);
    if (output === null) return null;
    const pids = new Set<number>();
    let pid: number | undefined, hasFile = false, count = 0;
    for (const line of output!.trim().split('\n')) {
      if (/^p[1-9]\d*$/.test(line)) { pid = Number(line.slice(1)); pids.add(pid); hasFile = false; }
      else if (/^f\d+$/.test(line) && pid) hasFile = true;
      else if (line.startsWith('n') && hasFile && pid && [`*:${options.port}`, `127.0.0.1:${options.port}`, `[::1]:${options.port}`].includes(line.slice(1))) { count++; hasFile = false; }
      else deny('ACCOUNTING_OWNER_RECOVERY_LISTENER_AMBIGUOUS');
    }
    if (pids.size !== 1 || count !== 1 || !Number.isSafeInteger([...pids][0])) return deny('ACCOUNTING_OWNER_RECOVERY_LISTENER_AMBIGUOUS');
    return [...pids][0];
  }
  async function processDetails(pid: number): Promise<{ startIdentity: string; executable: string } | null> {
    const output = await command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart='], true);
    if (output === null) return null;
    const start = output!.trim();
    if (!/^[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(start) || !Number.isFinite(Date.parse(`${start} UTC`))) return deny();
    const executable = (await command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'comm=']))!.trim();
    if (!/^\/[^\r\n]+$/.test(executable)) return deny();
    const startIdentity = new Date(`${start} UTC`).toISOString();
    if (startIdentity > timestamp()) return deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    return { startIdentity, executable };
  }
  async function observeProcess(): Promise<RecoveryGatewayObservation> {
    const pid = await listener();
    if (pid === null) return deny('ACCOUNTING_OWNER_RECOVERY_GATEWAY_UNAVAILABLE');
    const detail = await processDetails(pid);
    if (!detail || !/^\/(?:Applications|Users\/[^/]+\/Applications)\/(?:(?:Trader Workstation[^/]*|TWS[^/]*)\/)?(?:Trader Workstation[^/]*|TWS[^/]*)\.app\/Contents\/[^\r\n]+\/(?:java|JavaApplicationStub|Trader Workstation)$/.test(detail.executable) || detail.executable.split('/').some(part => part === '..' || part === '.')) return deny('ACCOUNTING_OWNER_RECOVERY_RESET_UNPROVEN');
    const checksum = (await command('/usr/bin/shasum', ['-a', '256', '--', detail.executable]))!;
    const match = checksum.match(/^([a-f0-9]{64}) {2}(.+)\n?$/);
    if (!match || match[2] !== detail.executable) return deny();
    const second = await processDetails(pid);
    if (!second || JSON.stringify(second) !== JSON.stringify(detail) || await listener() !== pid) return deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    return { observedAt: timestamp(), process: { pid, startIdentity: detail.startIdentity, executableHash: match[1] } };
  }
  async function captureGatewayProcess(port = options.port): Promise<RecoveryGatewayObservation> {
    portCheck(port);
    if (before) deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_SEQUENCE');
    before = await observeProcess();
    return structuredClone(before);
  }
  function previousCheck(previous: RecoveryGatewayObservation, port: number): void {
    portCheck(port);
    if (!before || previous.observedAt !== before.observedAt || !processEqual(previous.process, before.process)) deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_SEQUENCE');
  }
  async function assertGatewayStopped(previous: RecoveryGatewayObservation, port = options.port): Promise<RecoveryGatewayStopped> {
    previousCheck(previous, port);
    if (stopped) return structuredClone(stopped);
    const old = await processDetails(previous.process.pid);
    if (old !== null) {
      if (old.startIdentity !== previous.process.startIdentity) return deny('ACCOUNTING_OWNER_RECOVERY_PID_REUSED');
      return deny('ACCOUNTING_OWNER_RECOVERY_GATEWAY_STILL_RUNNING');
    }
    if (await listener() !== null || await processDetails(previous.process.pid) !== null) return deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_SEQUENCE');
    const observedAt = timestamp();
    if (observedAt <= previous.observedAt) return deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_SEQUENCE');
    stopped = { observedAt, processAbsent: true, listenerAbsent: true };
    return structuredClone(stopped);
  }
  async function verifyGatewayReplacement(previous: RecoveryGatewayObservation, port = options.port): Promise<RecoveryGatewayObservation> {
    previousCheck(previous, port);
    if (!stopped) return deny('ACCOUNTING_OWNER_RECOVERY_OBSERVATION_SEQUENCE');
    if (await processDetails(previous.process.pid) !== null) return deny('ACCOUNTING_OWNER_RECOVERY_OLD_PROCESS_SURVIVED');
    if (await listener() === null) return deny('ACCOUNTING_OWNER_RECOVERY_GATEWAY_NOT_STARTED');
    const next = await observeProcess();
    if (next.process.pid === previous.process.pid || next.process.startIdentity <= previous.process.startIdentity ||
        Date.parse(next.process.startIdentity) <= Date.parse(stopped.observedAt) ||
        next.observedAt <= stopped.observedAt) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_NOT_REPLACED');
    return next;
  }
  return { allowOneShot, clearOneShot, inspectNative, hostIdentityHash, captureProducerInventory, verifyProducerInventory, captureGatewayProcess, assertGatewayStopped, verifyGatewayReplacement };
}

export const ACCOUNTING_APP_SERVICES = ['execution-engine', 'ingestion', 'llm-agent', 'signal-engine', 'backtest-engine', 'ui'] as const;
export const ACCOUNTING_RECOVERY_ENTRYPOINT = ['node', 'apps/execution-engine/dist/accounting/owner-recovery-cli.js'];
export type AccountingRecoveryException = { containerId: string; imageId: string; name: string; requestId: string };
export type InspectCommand = ((file: string, args: readonly string[], allowAbsent?: boolean) => Promise<string | null>) & { lastPid?: number };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function inspectAccountingProducers(options: AccountingRecoveryHostOptions, command: InspectCommand,
  timestamp: () => string, exception?: AccountingRecoveryException): Promise<RecoveryProducerInventory> {
  const context = parseJson((await command('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']))!.trim());
  if (context !== options.dockerHost || typeof context !== 'string' || !/^unix:\/\/(?:\/Users\/[^\s]+\/\.docker\/run\/docker\.sock|\/var\/run\/docker\.sock)$/.test(context)) deny();
  const server = record(parseJson((await command('docker', ['--host', context, 'info', '--format', '{{json .}}']))!));
  if (server.OperatingSystem !== 'Docker Desktop' || server.OSType !== 'linux') deny();
  const output = (await command('docker', ['--host', context, 'ps', '-a', '--no-trunc', '--format', '{{.ID}}']))!.trim();
  const ids = output ? output.split('\n') : [];
  if (ids.length > 256 || ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
  const producers: RecoveryProducer[] = [];
  let seenException = false;
  for (const id of ids.sort()) {
    const c = record(parseJson((await command('docker', ['--host', context, 'inspect', '--type', 'container', '--format', '{{json .}}', id]))!));
    const config = record(c.Config), labels = record(config.Labels ?? {}), state = record(c.State);
    const service = String(labels['com.docker.compose.service'] ?? ''), project = labels['com.docker.compose.project'];
    if (id === exception?.containerId) {
      if (c.Id !== id || c.Image !== options.imageId || exception.imageId !== options.imageId || c.Name !== `/${exception.name}` ||
          exception.name !== `accounting-owner-recovery-${exception.requestId}` || project !== options.project || service !== 'execution-engine' ||
          String(labels['com.docker.compose.oneoff']).toLowerCase() !== 'true' || !equal(config.Entrypoint, ['node']) ||
          !equal(config.Cmd, [ACCOUNTING_RECOVERY_ENTRYPOINT[1]]) || state.Running !== true || state.Paused !== false || state.Restarting !== false) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
      seenException = true; continue;
    }
    const relevant = ACCOUNTING_APP_SERVICES.includes(service as typeof ACCOUNTING_APP_SERVICES[number]) || c.Image === options.imageId || project === options.project && !['postgres', 'redis'].includes(service);
    if (!relevant) {
      // Non-project containers may be infrastructure only. Unknown running applications
      // cannot establish the supported local-only producer topology.
      if (state.Running === true && !(project === options.project && ['postgres', 'redis'].includes(service))) deny('ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT');
      continue;
    }
    if (c.Id !== id || c.Image !== options.imageId || project !== options.project || !ACCOUNTING_APP_SERVICES.includes(service as typeof ACCOUNTING_APP_SERVICES[number]) ||
        String(labels['com.docker.compose.oneoff']).toLowerCase() !== 'false' || !equal(config.Entrypoint, ['docker-entrypoint.sh']) ||
        !equal(config.Cmd, ['pnpm', '--filter', `@ikbr/${service}`, service === 'ui' ? 'dev' : 'start'])) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    if (state.Running !== false || state.Paused !== false || state.Restarting !== false || state.Pid !== 0) deny('ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT');
    if (state.Status === 'created') {
      if (state.StartedAt !== '0001-01-01T00:00:00Z' || state.FinishedAt !== '0001-01-01T00:00:00Z') deny('ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT');
      const createdAt = dockerInstant(c.Created);
      if (typeof c.Created !== 'string' || createdAt.slice(0, 19) !== c.Created.slice(0, 19) || createdAt > timestamp()) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
      producers.push({ containerId: id, imageId: options.imageId, project: options.project, service: service as RecoveryProducer['service'],
        createdAt, startedAt: null, finishedAt: null, state: 'created' });
      continue;
    }
    if (!['exited', 'dead'].includes(String(state.Status))) deny('ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT');
    const startedAt = dockerInstant(state.StartedAt), finishedAt = dockerInstant(state.FinishedAt);
    if (startedAt > finishedAt || finishedAt > timestamp()) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    producers.push({ containerId: id, imageId: options.imageId, project: options.project, service: service as RecoveryProducer['service'], startedAt, finishedAt, state: state.Status as 'exited' | 'dead' });
  }
  if (exception && !seenException) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
  for (const service of ACCOUNTING_APP_SERVICES.slice(0, 4)) if (!producers.some(p => p.service === service)) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
  return { observedAt: timestamp(), producers, absentServices: ACCOUNTING_APP_SERVICES.filter(service => !producers.some(p => p.service === service)), nativeProcesses: [], unexpectedNativeCandidates: [], unexpectedSocketPids: [] };
}

export type AccountingRecoveryNativeLaunch = { pid: number; executable: string; args: string[]; startedAt: string; identities?: string };
export async function inspectAccountingNative(options: AccountingRecoveryHostOptions, command: InspectCommand, ownPid: number, twsPid: number | null,
  launch?: AccountingRecoveryNativeLaunch): Promise<OwnerRecoveryInventory['nativeProcesses']> {
  // A wide named comm field frames paths containing spaces; only final argv is unlimited.
  const commandHeader = 'C'.repeat(1024);
  const output = await command('/bin/ps', ['-ww', '-axo', `pid=PID,ppid=PPID,lstart=START,comm=${commandHeader},args=ARGS`]);
  if (!output || Buffer.byteLength(output) > MAX_OUTPUT || /[^\x20-\x7e\n]/.test(output) || !output.endsWith('\n')) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
  const [header, ...rows] = output.slice(0, -1).split('\n');
  if (header !== `  PID  PPID START${' '.repeat(24)}${commandHeader} ARGS` || !rows.length) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
  const commandOffset = header.indexOf(commandHeader), argvOffset = header.indexOf('ARGS');
  const argv = new Map<number, string>();
  const native = new Map<number, { ppid: number; command: string; startIdentity: string }>();
  for (const row of rows) {
    const m = row.slice(0, commandOffset).match(/^( {0,4}[1-9]\d{0,4}) ( {0,4}\d{1,5}) ([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d\d) (\d\d:\d\d:\d\d) (\d{4}) {5}$/);
    const processCommand = row.slice(commandOffset, argvOffset - 1).trimEnd(), args = row.slice(argvOffset);
    if (!m || m[1].length !== 5 || m[2].length !== 5 || row[argvOffset - 1] !== ' ' || !processCommand ||
        processCommand.startsWith(' ') || processCommand.length >= 1024 || !args.trim() || native.has(Number(m[1]))) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    const date = new Date(`${m[3]} ${m[4]} ${m[5]} ${m[6]} ${m[7]} UTC`);
    if (!Number.isFinite(date.getTime()) || date.toUTCString() !== `${m[3]}, ${m[5].trim().padStart(2, '0')} ${m[4]} ${m[7]} ${m[6]} GMT`) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    const pid = Number(m[1]);
    argv.set(pid, args);
    native.set(pid, { ppid: Number(m[2]), command: processCommand, startIdentity: date.toISOString() });
  }
  if (!native.has(ownPid)) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
  const launchPids = new Set<number>();
  if (launch) {
    const parent = native.get(launch.pid), children = [...native].filter(([, item]) => item.ppid === launch.pid);
    if (!parent || parent.ppid !== ownPid || !launch.executable.startsWith('/') || !launch.executable.endsWith('/docker')
      || parent.command !== launch.executable || argv.get(launch.pid) !== [launch.executable, ...launch.args].join(' ')
      || !Number.isFinite(Date.parse(launch.startedAt)) || Date.parse(parent.startIdentity) < Math.floor(Date.parse(launch.startedAt) / 1000) * 1000
      || children.length !== 1) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    const [pluginPid, plugin] = children[0];
    if (!plugin.command.startsWith('/') || !plugin.command.endsWith('/docker-compose')
      || argv.get(pluginPid) !== [plugin.command, ...launch.args].join(' ')
      || Date.parse(plugin.startIdentity) < Date.parse(parent.startIdentity)
      || [...native.values()].some(item => item.ppid === pluginPid)) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    const identities = [];
    for (const [pid, item] of [[launch.pid, parent], [pluginPid, plugin]] as const) {
      const hash = (await command('/usr/bin/shasum', ['-a', '256', '--', item.command]))!.match(/^([a-f0-9]{64}) {2}(.+)\n?$/);
      if (!hash || hash[2] !== item.command) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
      identities.push({ pid, ...item, executableHash: hash[1], argvHash: sha(argv.get(pid)!) });
      launchPids.add(pid);
    }
    const identity = JSON.stringify(identities);
    if (launch.identities !== undefined && launch.identities !== identity) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED');
    launch.identities = identity;
  }
  // Exempt exact CLI ancestry, inspection helpers and the pinned Compose launch only.
  const ancestors = new Set<number>([ownPid]);
  let parent = native.get(ownPid)!.ppid;
  while (parent > 1 && native.has(parent)) { if (ancestors.has(parent)) deny(); ancestors.add(parent); parent = native.get(parent)!.ppid; }
  const recoveryArg = /(?:accounting-owner-recovery-cli\.(?:ts|js)|paper:accounting-owner-recovery|accounting:owner-recovery)/;
  for (const [pid, item] of native) {
    const args = argv.get(pid)!;
    const candidate = args.includes(options.root) || /@ikbr\/|(?:execution-engine|ingestion|llm-agent|backtest-engine)\/(?:src|dist)\/(?:index|main)|@stoqey\/ib|\bibapi\b/.test(args);
    if (!candidate || pid === twsPid || pid === ownPid || launchPids.has(pid)) continue;
    if (ancestors.has(pid) && recoveryArg.test(args)) continue;
    if (item.ppid === ownPid && /^\/(?:usr\/sbin\/lsof|bin\/ps|usr\/sbin\/ioreg|usr\/bin\/shasum)$/.test(item.command)) continue;
    deny('ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT');
  }
  const identities: OwnerRecoveryInventory['nativeProcesses'] = [];
  for (const pid of [ownPid, ...(twsPid === null ? [] : [twsPid])]) {
    const item = native.get(pid); if (!item || !item.command.startsWith('/')) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    const hash = (await command('/usr/bin/shasum', ['-a', '256', '--', item.command]))!.match(/^([a-f0-9]{64}) {2}(.+)\n?$/);
    if (!hash || hash[2] !== item.command) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    identities.push({ pid, startIdentity: item.startIdentity, executableHash: hash[1], argvHash: sha(argv.get(pid)!), role: pid === ownPid ? 'collector' : 'tws' });
  }
  const socket = await command('/usr/sbin/lsof', ['-nP', `-iTCP:${options.port}`, '-Fpfn'], true);
  if (socket !== null) {
    let pid = 0;
    for (const line of socket.trim().split('\n')) {
      if (/^p[1-9]\d*$/.test(line)) { pid = Number(line.slice(1)); if (pid !== twsPid) deny('ACCOUNTING_OWNER_RECOVERY_PRODUCERS_NOT_QUIESCENT'); }
      else if (!pid || !/^(?:f\d+|n[^\r\n]+)$/.test(line)) deny('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE');
    }
  }
  return identities;
}

export type AccountingEventWatcher = { check(): void; flush(): Promise<void>; allow(value: AccountingRecoveryException): void; close(): void };
type EventPhase = 'bootstrap' | 'replay' | 'stream' | 'guard' | 'lifecycle';
type EventFailure = 'MALFORMED_EVENT' | 'PRODUCER_ACTIVITY' | 'EXCEPTION_MISMATCH' | 'COMMAND_FAILED' | 'OUTPUT_LIMIT' |
  'REPLAY_OVERFLOW' | 'ANCHOR_UNAVAILABLE' | 'ANCHOR_AMBIGUOUS' | 'STREAM_STDERR' | 'STREAM_ERROR' | 'STREAM_CLOSED' | 'WATCHER_CLOSED' | 'DEADLINE';
function eventFailure(phase: EventPhase, reason: EventFailure, original?: unknown): AccountingRecoveryHostError {
  const failure = new AccountingRecoveryHostError('ACCOUNTING_OWNER_RECOVERY_INVENTORY_UNAVAILABLE', {
    name: `AccountingDockerEventWatcher:${phase}`, code: reason, message: `phase=${phase}; reason=${reason}`,
  });
  const source = original instanceof Error ? original.cause ?? original : original;
  if (source && typeof source === 'object') {
    const detail = source as { name?: unknown; code?: unknown; message?: unknown };
    Object.assign(failure.cause as object, { original: { name: typeof detail.name === 'string' ? safeDiagnosticText(detail.name) : null,
      code: typeof detail.code === 'string' ? safeDiagnosticText(detail.code) : typeof detail.code === 'number' ? detail.code : null,
      message: typeof detail.message === 'string' ? safeDiagnosticText(detail.message) : null } });
  }
  return failure;
}
export function createAccountingEventGuard(reservedName: string | undefined, onFailure: () => void = () => undefined) {
  let failure: AccountingRecoveryHostError | undefined, closed = false, exception: AccountingRecoveryException | undefined;
  const pendingEvents: Array<{ id: string; name: string }> = [];
  const fail = (error = eventFailure('guard', 'MALFORMED_EVENT')) => { if (!closed && !failure) { failure = error; onFailure(); } };
  const consume = (line: string) => {
    if (closed || failure) return;
    try {
      const event = record(JSON.parse(line)), actor = record(event.Actor), attrs = record(actor.Attributes), action = String(event.Action ?? event.status ?? '');
      if (event.Type !== 'container' || typeof actor.ID !== 'string' || !/^[a-f0-9]{64}$/.test(actor.ID)) { fail(); return; }
      if (['create', 'start', 'restart', 'unpause', 'rename', 'update', 'destroy', 'die', 'stop', 'kill', 'pause'].includes(action)) {
        const own = exception && actor.ID === exception.containerId && attrs.name === exception.name;
        if (!own) {
          if (!exception && attrs.name === reservedName && ['create', 'start'].includes(action)) pendingEvents.push({ id: actor.ID, name: String(attrs.name) });
          else fail(eventFailure('guard', 'PRODUCER_ACTIVITY'));
        }
      }
    } catch { fail(); }
  };
  return { consume, fail, check: () => { if (failure) throw failure; if (closed) throw eventFailure('lifecycle', 'WATCHER_CLOSED'); },
    allow: (value: AccountingRecoveryException) => { if (exception) deny('ACCOUNTING_OWNER_RECOVERY_PROCESS_CHANGED'); exception = structuredClone(value); if (pendingEvents.some(e => e.id !== value.containerId || e.name !== value.name)) fail(eventFailure('guard', 'EXCEPTION_MISMATCH')); },
    close: () => { closed = true; } };
}
export type AccountingDockerWatcherAdapters = {
  run?: RecoveryHostCommandRunner;
  spawnEvents?: (args: string[]) => ReturnType<typeof spawn>;
  now?: () => number;
  schedule?: typeof setTimeout;
  unschedule?: typeof clearTimeout;
};
export async function startAccountingDockerWatcher(options: AccountingRecoveryHostOptions, onFailure: () => void = () => undefined,
  reservedName?: string, adapters: AccountingDockerWatcherAdapters = {}): Promise<AccountingEventWatcher & { startedAt: string }> {
  const run = adapters.run ?? runRecoveryHostCommand, now = adapters.now ?? Date.now;
  const schedule = adapters.schedule ?? setTimeout, unschedule = adapters.unschedule ?? clearTimeout;
  let buffer = '', bytes = 0, closed = false, timer: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof spawn> | undefined, anchor: { hash: string; time: number } | undefined;
  let inFlight: Promise<void> | undefined, flushing: Promise<void> | undefined;
  const halt = () => { if (timer) unschedule(timer); if (deadline) unschedule(deadline); timer = deadline = undefined; child?.kill('SIGTERM'); };
  const guard = createAccountingEventGuard(reservedName, () => { halt(); onFailure(); });
  const fail = (phase: EventPhase, reason: EventFailure): never => { guard.fail(eventFailure(phase, reason)); guard.check(); throw eventFailure(phase, reason); };
  const parseEvent = (line: string, phase: EventPhase) => {
    let event: Record<string, unknown>;
    try { event = record(JSON.parse(line)); } catch { return fail(phase, 'MALFORMED_EVENT'); }
    if (typeof event.Type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(event.Type) || !Number.isSafeInteger(event.time) || Number(event.time) <= 0 || Number(event.time) >= 253402300800 || Buffer.byteLength(line) > 65536) return fail(phase, 'MALFORMED_EVENT');
    return { line, hash: sha(line), time: Number(event.time), type: event.Type };
  };
  const consume = (event: ReturnType<typeof parseEvent>) => { if (event.type === 'container') guard.consume(event.line); guard.check(); };
  const replay = async (phase: 'bootstrap' | 'replay') => {
    guard.check();
    const since = anchor ? new Date((anchor.time - 1) * 1000).toISOString() : '1970-01-01T00:00:00.000Z';
    let result: RecoveryHostCommandResult;
    try { result = await run('docker', ['--host', options.dockerHost, 'events', '--since', since, '--until', new Date(now()).toISOString(), '--format', '{{json .}}']); }
    catch (error) {
      // Command errors already carry sanitized original diagnostics; never include event payloads.
      guard.fail(eventFailure(phase, 'COMMAND_FAILED', error)); guard.check(); return [];
    }
    guard.check();
    if (result.exitCode !== 0 || result.stderr) {
      guard.fail(eventFailure(phase, 'COMMAND_FAILED', { name: null, code: result.exitCode, message: result.stderr || null })); guard.check();
    }
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT) return fail(phase, 'OUTPUT_LIMIT');
    if (result.stdout && !result.stdout.endsWith('\n')) return fail(phase, 'MALFORMED_EVENT');
    const lines = result.stdout ? result.stdout.slice(0, -1).split('\n') : [];
    if (lines.length > 256 || phase === 'replay' && lines.length >= 256) return fail(phase, 'REPLAY_OVERFLOW');
    const events = lines.map(line => parseEvent(line, phase));
    if (events.some((event, index) => index > 0 && event.time < events[index - 1].time)) return fail(phase, 'MALFORMED_EVENT');
    const last = events.at(-1);
    if (last && events.filter(event => event.hash === last.hash).length !== 1) return fail(phase, 'ANCHOR_AMBIGUOUS');
    if (!anchor) {
      if (!last) return fail(phase, 'ANCHOR_UNAVAILABLE');
      anchor = { hash: last.hash, time: last.time };
    } else {
      const matches = events.flatMap((event, index) => event.hash === anchor!.hash ? [index] : []);
      if (!matches.length) return fail(phase, 'ANCHOR_UNAVAILABLE');
      if (matches.length !== 1) return fail(phase, 'ANCHOR_AMBIGUOUS');
      for (const event of events.slice(matches[0] + 1)) consume(event);
      anchor = { hash: last!.hash, time: last!.time };
    }
    return events;
  };
  const checkpoint = (): Promise<void> => {
    if (inFlight) return inFlight;
    const current = (async () => { await replay('replay'); guard.check(); })().catch(error => {
      guard.fail(error instanceof AccountingRecoveryHostError ? error : eventFailure('replay', 'MALFORMED_EVENT')); guard.check();
    }).finally(() => { if (inFlight === current) inFlight = undefined; });
    inFlight = current; return current;
  };
  const tick = () => {
    guard.check();
    timer = schedule(() => {
      timer = undefined;
      void checkpoint().then(() => { if (!closed) tick(); }).catch(() => undefined);
    }, 1000);
  };
  const close = () => { closed = true; guard.close(); halt(); };
  try {
    const streamStartedAt = new Date(now()).toISOString();
    const args = ['--host', options.dockerHost, 'events', '--since', streamStartedAt, '--filter', 'type=container', '--format', '{{json .}}'];
    child = adapters.spawnEvents ? adapters.spawnEvents(args) : spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'C' },
    });
    if (!child.stdout || !child.stderr) fail('stream', 'STREAM_ERROR');
    child.stdout!.on('data', (part: Buffer) => {
      if (closed) return;
      try {
        guard.check(); bytes += part.length; if (bytes > 4 * 1024 * 1024) fail('stream', 'OUTPUT_LIMIT');
        buffer += part.toString('utf8'); if (Buffer.byteLength(buffer) > 65536) fail('stream', 'OUTPUT_LIMIT');
        for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); consume(parseEvent(line, 'stream')); }
      } catch { /* The first failure is latched and cancels the backend. */ }
    });
    child.stderr!.on('data', () => guard.fail(eventFailure('stream', 'STREAM_STDERR')));
    child.on('error', error => guard.fail(eventFailure('stream', 'STREAM_ERROR', error)));
    child.on('close', () => { if (!closed) guard.fail(eventFailure('stream', 'STREAM_CLOSED')); });
    await replay('bootstrap'); guard.check();
    const startedAt = new Date(now()).toISOString();
    // The initial replay fences any gap while the mandatory stream was connecting.
    await checkpoint(); guard.check(); tick();
    deadline = schedule(() => guard.fail(eventFailure('lifecycle', 'DEADLINE')), 15 * 60_000);
    return { startedAt, check: guard.check, allow: guard.allow, close,
      flush: () => {
        if (flushing) return flushing;
        const previous = inFlight;
        const current = (async () => { if (previous) await previous; guard.check(); await checkpoint(); })().finally(() => { if (flushing === current) flushing = undefined; });
        flushing = current; return current;
      },
    };
  } catch (error) { close(); throw error; }
}
