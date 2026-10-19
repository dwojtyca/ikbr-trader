import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { safeDiagnosticText } from '@ikbr/shared/diagnostics';
import type { RecoveryProcess, RecoveryProducer } from '@ikbr/shared/instrument-research';

const MAX_OUTPUT = 32 * 1024;
const TIMEOUT_MS = 5_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export type RecoveryHostCommandResult = { stdout: string; stderr: string; exitCode: number };
export type RecoveryHostCommandRunner = (file: string, args: readonly string[]) => Promise<RecoveryHostCommandResult>;
export type RecoveryProducerInventory = { observedAt: string; producers: RecoveryProducer[] };
export type RecoveryGatewayObservation = { observedAt: string; process: RecoveryProcess };
export type RecoveryGatewayStopped = { observedAt: string; processAbsent: true; listenerAbsent: true };
export type ResearchRecoveryHostOptions = { project: string; imageId: string; host: string; port: number; dockerHost?: string };
export type ResearchRecoveryHostAdapters = {
  run?: RecoveryHostCommandRunner;
  platform?: NodeJS.Platform;
  now?: () => Date;
  knownExternalProducers?: boolean;
};
export class ResearchRecoveryHostError extends Error {
  constructor(readonly code: string, cause?: { name: string | null; code: string | number | null; message: string | null }) { super(code, cause ? { cause } : undefined); }
}
const deny = (code = 'RESEARCH_RECOVERY_UNSUPPORTED_HOST'): never => { throw new ResearchRecoveryHostError(code); };

// Native inspection only. The environment cannot redirect Docker to a remote daemon.
export const runRecoveryHostCommand: RecoveryHostCommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',
    HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C', LANG: 'C', TZ: 'UTC',
  } }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== 'number')) {
      reject(new ResearchRecoveryHostError('RESEARCH_RECOVERY_INSPECTION_UNAVAILABLE', {
        name: safeDiagnosticText(error.name), code: typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null,
        message: safeDiagnosticText(error.message),
      }));
      return;
    }
    resolve({ stdout, stderr, exitCode: error ? Number(error.code) : 0 });
  });
});

const INSPECT_FORMAT = '{{json .Id}}\t{{json .Image}}\t{{json .Config.Labels}}\t{{json .State}}\t{{json .Config.Entrypoint}}\t{{json .Config.Cmd}}';
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

export function createResearchRecoveryHost(options: ResearchRecoveryHostOptions, adapters: ResearchRecoveryHostAdapters = {}) {
  options = { ...options };
  if ((adapters.platform ?? process.platform) !== 'darwin' || adapters.knownExternalProducers ||
      !['127.0.0.1', 'localhost', 'host.docker.internal'].includes(options.host) ||
      !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.project) || !/^sha256:[a-f0-9]{64}$/.test(options.imageId) ||
      !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) deny();
  const run = adapters.run ?? runRecoveryHostCommand;
  const now = adapters.now ?? (() => new Date());
  const started = now().getTime();
  if (!Number.isFinite(started)) deny('RESEARCH_RECOVERY_OBSERVATION_EXPIRED');
  let last = started;
  let before: RecoveryGatewayObservation | undefined;
  let stopped: RecoveryGatewayStopped | undefined;
  let inventory: RecoveryProducerInventory | undefined;
  let dockerHost = options.dockerHost;
  function timestamp(): string {
    const value = now().getTime();
    if (!Number.isFinite(value) || value < last || value - started > 15 * 60_000) return deny('RESEARCH_RECOVERY_OBSERVATION_EXPIRED');
    last = value;
    return new Date(value).toISOString();
  }
  async function command(file: string, args: readonly string[], allowAbsent = false): Promise<string | null> {
    timestamp();
    const result = await run(file, args);
    timestamp();
    if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT || result.stderr.trim()) throw new ResearchRecoveryHostError('RESEARCH_RECOVERY_INSPECTION_UNAVAILABLE', { name: null, code: result.exitCode, message: typeof result.stderr === 'string' && result.stderr ? safeDiagnosticText(result.stderr) : null });
    if (allowAbsent && result.exitCode === 1 && result.stdout === '' && result.stderr === '') return null;
    if (result.exitCode !== 0 || /\0/.test(result.stdout)) throw new ResearchRecoveryHostError('RESEARCH_RECOVERY_INSPECTION_UNAVAILABLE', { name: null, code: result.exitCode, message: null });
    return result.stdout;
  }
  const portCheck = (port: number) => { if (port !== options.port) deny('RESEARCH_RECOVERY_ENDPOINT_CHANGED'); };
  async function hostIdentityHash(): Promise<string> {
    const output = await command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const matches = [...output!.matchAll(/"IOPlatformUUID"\s*=\s*"([^"]+)"/g)];
    if (matches.length !== 1 || !uuid.test(matches[0][1])) return deny();
    return sha(`darwin:${matches[0][1].toLowerCase()}`);
  }
  async function inspectProducers(): Promise<RecoveryProducerInventory> {
    const context = parseJson((await command('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']))!.trim());
    if (typeof context !== 'string' || !/^unix:\/\/(?:\/Users\/[^\s]+\/\.docker\/run\/docker\.sock|\/var\/run\/docker\.sock)$/.test(context)) deny();
    if (dockerHost !== undefined && context !== dockerHost) deny('RESEARCH_RECOVERY_DOCKER_HOST_CHANGED');
    dockerHost = context as string;
    const imageEntrypoint = parseJson((await command('docker', ['--host', context as string, 'inspect', '--type', 'image', '--format', '{{json .Config.Entrypoint}}', options.imageId]))!.trim());
    if (JSON.stringify(imageEntrypoint) !== JSON.stringify(['docker-entrypoint.sh'])) deny('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED');
    const outputs = [];
    for (const filter of ['label=com.docker.compose.service=llm-agent', `ancestor=${options.imageId}`]) {
      outputs.push(await command('docker', ['--host', context as string, 'ps', '-a', '--no-trunc', '--filter', filter, '--format', '{{.ID}}']));
    }
    const ids = [...new Set(outputs.flatMap(output => output!.trim() ? output!.trim().split('\n') : []))].sort();
    if (ids.length < 1 || ids.length > 64 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) deny('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED');
    const producers: RecoveryProducer[] = [];
    for (const id of ids) {
      const parts = (await command('docker', ['--host', context as string, 'inspect', '--type', 'container', '--format', INSPECT_FORMAT, id]))!.trim().split('\t');
      if (parts.length !== 6) deny();
      const [containerId, imageId, rawLabels, rawState, entrypoint, cmd] = parts.map(parseJson);
      const labels = record(rawLabels), state = record(rawState);
      const service = labels['com.docker.compose.service'];
      if (containerId !== id || imageId !== options.imageId || labels['com.docker.compose.project'] !== options.project ||
          typeof service !== 'string' || !['llm-agent', 'ingestion', 'execution-engine', 'signal-engine', 'backtest-engine', 'ui'].includes(service) ||
          labels['com.docker.compose.oneoff'] !== 'False' || JSON.stringify(entrypoint) !== JSON.stringify(imageEntrypoint) ||
          JSON.stringify(cmd) !== JSON.stringify(['pnpm', '--filter', `@ikbr/${service}`, service === 'ui' ? 'dev' : 'start'])) {
        deny('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED');
      }
      if (service !== 'llm-agent') continue;
      if (
          !['exited', 'dead'].includes(String(state.Status)) || state.Running !== false || state.Paused !== false || state.Restarting !== false || state.Pid !== 0) {
        deny('RESEARCH_RECOVERY_PRODUCERS_NOT_QUIESCENT');
      }
      const startedAt = dockerInstant(state.StartedAt), finishedAt = dockerInstant(state.FinishedAt);
      if (startedAt > finishedAt || finishedAt > timestamp()) deny('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED');
      producers.push({ containerId: id, imageId: options.imageId, project: options.project, service: 'llm-agent', startedAt, finishedAt, state: state.Status as 'exited' | 'dead' });
    }
    if (producers.length < 1 || producers.length > 16) deny('RESEARCH_RECOVERY_PRODUCER_INVENTORY_UNSUPPORTED');
    return { observedAt: timestamp(), producers };
  }
  async function captureProducerInventory(): Promise<RecoveryProducerInventory> {
    if (inventory) deny('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE');
    inventory = await inspectProducers();
    return structuredClone(inventory);
  }
  async function verifyProducerInventory(previous: RecoveryProducerInventory): Promise<RecoveryProducerInventory> {
    const captured = inventory;
    if (!captured || JSON.stringify(previous) !== JSON.stringify(captured)) return deny('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE');
    const next = await inspectProducers();
    if (JSON.stringify(next.producers) !== JSON.stringify(captured.producers)) deny('RESEARCH_RECOVERY_PRODUCER_REPLACED');
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
      else deny('RESEARCH_RECOVERY_LISTENER_AMBIGUOUS');
    }
    if (pids.size !== 1 || count < 1 || !Number.isSafeInteger([...pids][0])) return deny('RESEARCH_RECOVERY_LISTENER_AMBIGUOUS');
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
    if (startIdentity > timestamp()) return deny('RESEARCH_RECOVERY_PROCESS_CHANGED');
    return { startIdentity, executable };
  }
  async function observeProcess(): Promise<RecoveryGatewayObservation> {
    const pid = await listener();
    if (pid === null) return deny('RESEARCH_RECOVERY_GATEWAY_UNAVAILABLE');
    const detail = await processDetails(pid);
    if (!detail || !/^\/(?:Applications|Users\/[^/]+\/Applications)\/(?:(?:IB Gateway[^/]*|Trader Workstation[^/]*|TWS[^/]*)\/)?(?:IB Gateway[^/]*|Trader Workstation[^/]*|TWS[^/]*)\.app\/Contents\/[^\r\n]+\/(?:java|JavaApplicationStub|IB Gateway|Trader Workstation)$/.test(detail.executable) || detail.executable.split('/').some(part => part === '..' || part === '.')) return deny('RESEARCH_RECOVERY_LISTENER_NOT_GATEWAY');
    const checksum = (await command('/usr/bin/shasum', ['-a', '256', '--', detail.executable]))!;
    const match = checksum.match(/^([a-f0-9]{64}) {2}(.+)\n?$/);
    if (!match || match[2] !== detail.executable) return deny();
    const second = await processDetails(pid);
    if (!second || JSON.stringify(second) !== JSON.stringify(detail) || await listener() !== pid) return deny('RESEARCH_RECOVERY_PROCESS_CHANGED');
    return { observedAt: timestamp(), process: { pid, startIdentity: detail.startIdentity, executableHash: match[1] } };
  }
  async function captureGatewayProcess(port = options.port): Promise<RecoveryGatewayObservation> {
    portCheck(port);
    if (before) deny('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE');
    before = await observeProcess();
    return structuredClone(before);
  }
  function previousCheck(previous: RecoveryGatewayObservation, port: number): void {
    portCheck(port);
    if (!before || previous.observedAt !== before.observedAt || !processEqual(previous.process, before.process)) deny('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE');
  }
  async function assertGatewayStopped(previous: RecoveryGatewayObservation, port = options.port): Promise<RecoveryGatewayStopped> {
    previousCheck(previous, port);
    if (stopped) return structuredClone(stopped);
    const old = await processDetails(previous.process.pid);
    if (old !== null) {
      if (old.startIdentity !== previous.process.startIdentity) return deny('RESEARCH_RECOVERY_PID_REUSED');
      return deny('RESEARCH_RECOVERY_GATEWAY_STILL_RUNNING');
    }
    if (await listener() !== null || await processDetails(previous.process.pid) !== null) return deny('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE');
    const observedAt = timestamp();
    if (observedAt <= previous.observedAt) return deny('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE');
    stopped = { observedAt, processAbsent: true, listenerAbsent: true };
    return structuredClone(stopped);
  }
  async function verifyGatewayReplacement(previous: RecoveryGatewayObservation, port = options.port): Promise<RecoveryGatewayObservation> {
    previousCheck(previous, port);
    if (!stopped) return deny('RESEARCH_RECOVERY_OBSERVATION_SEQUENCE');
    if (await processDetails(previous.process.pid) !== null) return deny('RESEARCH_RECOVERY_OLD_PROCESS_SURVIVED');
    if (await listener() === null) return deny('RESEARCH_RECOVERY_GATEWAY_NOT_STARTED');
    const next = await observeProcess();
    if (next.process.pid === previous.process.pid || next.process.startIdentity <= previous.process.startIdentity ||
        Date.parse(next.process.startIdentity) < Math.floor(Date.parse(stopped.observedAt) / 1000) * 1000 ||
        next.observedAt <= stopped.observedAt) deny('RESEARCH_RECOVERY_PROCESS_NOT_REPLACED');
    return next;
  }
  return { hostIdentityHash, captureProducerInventory, verifyProducerInventory, captureGatewayProcess, assertGatewayStopped, verifyGatewayReplacement };
}
