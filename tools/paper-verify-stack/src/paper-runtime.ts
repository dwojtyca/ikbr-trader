import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { loadTradingConfiguration } from '@ikbr/shared/trading-config';

export const PAPER_SERVICES = ['postgres', 'redis', 'execution-engine', 'ingestion', 'llm-agent', 'signal-engine'] as const;
const APP_SERVICES = ['ingestion', 'execution-engine', 'signal-engine', 'llm-agent'] as const;
const MAX_CONFIG_BYTES = 2_000_000;

export type ReleaseProof = { version: 1; imageId: string; effectiveComposeSha256: string; files: Array<{ path: string; sha256: string }> };
export type RuntimeControl = { control: { account_id: string; paused: boolean; revision: number | string } | null; events: Array<{ revision: number | string; paused: boolean; reason: string }> };
export type RuntimeHttp = (path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown>;
export type Compose = (args: string[], signal?: AbortSignal) => Promise<string>;
export type RuntimeAdapters = { compose: Compose; inspectImage: (imageId: string) => Promise<string>; http: RuntimeHttp; statusReport?: () => Promise<string>; log?: (message: string) => void; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal };
export type RuntimeOptions = { root: string; token: string; envFile?: string; releasePath?: string; overridePath?: string; adapters: RuntimeAdapters };

export class PaperRuntimeError extends Error { constructor(readonly code: string) { super(code); } }
export class PaperHttpError extends PaperRuntimeError { constructor(code: string, readonly status: number) { super(code); } }
const obj = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : obj(v) ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(value));
}

function proofSchema(value: unknown): ReleaseProof {
  const r = obj(value); if (!r || r.version !== 1 || typeof r.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(r.imageId) ||
      typeof r.effectiveComposeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(r.effectiveComposeSha256) || !Array.isArray(r.files)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const files = r.files.map((v) => { const f = obj(v); if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); return { path: f.path, sha256: f.sha256 }; });
  if (!files.length || new Set(files.map(f => f.path)).size !== files.length) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  return { version: 1, imageId: r.imageId, effectiveComposeSha256: r.effectiveComposeSha256, files };
}

async function resolveProofPath(root: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const absolute = resolve(root, path); const rel = relative(root, absolute);
  if (rel.startsWith(`..${sep}`) || rel === '..') throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  let current = root;
  for (const part of rel.split(sep)) { current = resolve(current, part); const stat = await lstat(current).catch(() => null); if (!stat || stat.isSymbolicLink()) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); }
  const real = await realpath(absolute); if (!real.startsWith(`${await realpath(root)}${sep}`)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  return absolute;
}

async function verifyProof(root: string, proofFile: string): Promise<ReleaseProof> {
  let raw: unknown;
  try { const rel = relative(root, proofFile).split(sep).join('/'); await resolveProofPath(root, rel); const b = await readFile(proofFile); if (b.byteLength > 100_000) throw new Error(); raw = JSON.parse(b.toString('utf8')); } catch { throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); }
  const proof = proofSchema(raw);
  const required = ['docker-compose.yml', '.local/paper-runtime/redis-internal.override.yml', '.local/paper-runtime/compose.override.json'];
  if (required.some(path => !proof.files.some(f => f.path === path))) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  for (const entry of proof.files) {
    const path = await resolveProofPath(root, entry.path);
    if (!(await lstat(path)).isFile()) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    const bytes = await readFile(path); if (sha(bytes) !== entry.sha256) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  }
  return proof;
}

function envMap(service: Record<string, unknown>): Record<string, string> {
  const e = obj(service.environment); if (!e) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v ?? '')]));
}
function mounts(service: Record<string, unknown>): Array<Record<string, unknown>> { return Array.isArray(service.volumes) ? service.volumes.map(obj).filter((v): v is Record<string, unknown> => !!v) : []; }
export async function validateRenderedCompose(value: unknown, proof: ReleaseProof, root: string): Promise<{ accountId: string; instrumentIds: string[] }> {
  const config = obj(value), services = obj(config?.services); if (!services) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const accountSet = new Set<string>(); let bundlePath = '', bundleHash = '';
  const appEnvironments: Record<string, Record<string, string>> = {};
  for (const name of APP_SERVICES) {
    const service = obj(services[name]); if (!service || service.image !== proof.imageId || service.entrypoint != null) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    const cmd = Array.isArray(service.command) ? service.command : typeof service.command === 'string' ? service.command.split(/\s+/) : [];
    if (canonicalJson(cmd) !== canonicalJson(['pnpm', '--filter', `@ikbr/${name}`, 'start'])) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    const e = envMap(service);
    appEnvironments[name] = e;
    if (e.IBKR_ENVIRONMENT !== 'paper' || e.ALLOWED_LIVE_ACCOUNTS !== '') throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    if (name === 'ingestion' || name === 'signal-engine' || name === 'execution-engine' || name === 'llm-agent') {
      const acct = e.IBKR_ACCOUNT_ID || e.RESEARCH_BUDGET_ACCOUNT_ID || '';
      const allowed = e.ALLOWED_PAPER_ACCOUNTS || '';
      const allowlist = allowed.split(',').map(x => x.trim()).filter(Boolean);
      if (allowlist.length !== 1 || (acct && allowlist[0] !== acct)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
      accountSet.add(allowed);
    }
    if (e.TRADING_CONFIG_MODE !== 'bundle' || e.TRADING_CONFIG_PATH !== '/app/private-config/continuous-strategy.json' || !/^[a-f0-9]{64}$/.test(e.TRADING_CONFIG_EXPECTED_HASH || '')) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    if (!bundlePath) { bundlePath = e.TRADING_CONFIG_PATH; bundleHash = e.TRADING_CONFIG_EXPECTED_HASH; }
    if (e.TRADING_CONFIG_PATH !== bundlePath || e.TRADING_CONFIG_EXPECTED_HASH !== bundleHash) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    const expected: Record<string, Record<string, string>> = {
      ingestion: { TRADING_ENABLED: 'false', INGESTION_AUTO_BOOTSTRAP_ENABLED: 'true' },
      'execution-engine': { TRADING_ENABLED: 'true', EXECUTION_ENTRIES_PAUSED: 'false', EXECUTION_LIFECYCLE_AUTOMATION_ENABLED: 'true', RESEARCH_CONFIG_PATH: '/app/private-config/continuous-research.json' },
      'signal-engine': { TRADING_ENABLED: 'true', TRADING_LOOP_ENABLED: 'true' },
      'llm-agent': { TRADING_ENABLED: 'true', LLM_AGENT_ENABLED: 'true', RESEARCH_CONFIG_PATH: '/app/private-config/continuous-research.json' },
    };
    for (const [k, v] of Object.entries(expected[name])) if (e[k] !== v) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    if (name === 'execution-engine' || name === 'llm-agent') {
      if (!/^[a-f0-9]{64}$/.test(e.RESEARCH_CONFIG_EXPECTED_HASH || '') || e.RESEARCH_BUDGET_ACCOUNT_ID !== e.IBKR_ACCOUNT_ID ||
          e.RESEARCH_CONFIG_PATH !== '/app/private-config/continuous-research.json') throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    }
    if (name === 'llm-agent' && e.RESEARCH_MARKETAUX_ON_DEMAND !== 'true') throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    const requiredTargets = name === 'execution-engine' || name === 'llm-agent'
      ? ['/app/private-config/continuous-strategy.json', '/app/private-config/continuous-research.json', ...(name === 'execution-engine' ? ['/app/private-accounting'] : [])]
      : ['/app/private-config/continuous-strategy.json'];
    const relevant = mounts(service).filter(m => requiredTargets.includes(String(m.target || '')));
    if (new Set(relevant.map(m => String(m.target))).size !== requiredTargets.length) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    for (const m of relevant) {
      if ((m.read_only !== true && m.readOnly !== true) || m.type !== 'bind' || typeof m.source !== 'string') throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
      const source = resolve(String(m.source)); const rel = relative(root, source).split(sep).join('/');
      if (!rel || rel.startsWith('../') || isAbsolute(rel)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
      const expectedSource = String(m.target) === '/app/private-config/continuous-strategy.json' ? resolve(root, '.local/paper-runtime/strategy.json')
        : String(m.target) === '/app/private-config/continuous-research.json' ? resolve(root, '.local/paper-runtime/research.json')
        : resolve(root, '.local/paper-runtime/accounting');
      if (source !== expectedSource) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
      const covered = proof.files.filter(f => f.path === rel || f.path.startsWith(`${rel}/`));
      if (String(m.target) === '/app/private-accounting') {
        if (!covered.length || covered.some(f => !f.path.startsWith(`${rel}/`))) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
        const walk = async (d: string): Promise<void> => { for (const e of await readdir(d, { withFileTypes: true })) { const p = resolve(d, e.name); if (e.isSymbolicLink()) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); if (e.isDirectory()) await walk(p); else { const item = relative(root, p).split(sep).join('/'); if (!proof.files.some(f => f.path === item)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); } } };
        const st = await lstat(source).catch(() => null); if (!st?.isDirectory() || st.isSymbolicLink()) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); await walk(source);
      } else if (covered.length !== 1 || covered[0].path !== rel) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    }
  }
  if (accountSet.size !== 1) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const allowed = [...accountSet][0];
  const execEnv = envMap(obj(services['execution-engine'])!);
  if (!execEnv.IBKR_ACCOUNT_ID || execEnv.IBKR_ACCOUNT_ID !== allowed.split(',').map(x => x.trim()).find(Boolean)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const llmEnv = envMap(obj(services['llm-agent'])!);
  if (execEnv.RESEARCH_CONFIG_EXPECTED_HASH !== llmEnv.RESEARCH_CONFIG_EXPECTED_HASH) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const accountingPath = execEnv.EXECUTION_ACCOUNTING_SOURCE_PATH;
  const accountingPrefix = '/app/private-accounting/';
  if (!accountingPath?.startsWith(accountingPrefix) || accountingPath.split('/').includes('..') || accountingPath.includes('\\')) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const accountingFile = `.local/paper-runtime/accounting/${accountingPath.slice(accountingPrefix.length)}`;
  if (!proof.files.some(f => f.path === accountingFile && f.sha256 === execEnv.EXECUTION_ACCOUNTING_SOURCE_SHA256)) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  const strategyPath = '.local/paper-runtime/strategy.json';
  const strategyProof = proof.files.find(f => f.path === strategyPath);
  if (!strategyProof) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  let strategyText: string;
  try {
    const source = await resolveProofPath(root, strategyPath);
    const bytes = await readFile(source);
    if (sha(bytes) !== strategyProof.sha256) throw new Error();
    strategyText = bytes.toString('utf8');
  } catch { throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); }
  let instrumentIds: string[] | undefined;
  for (const name of APP_SERVICES) {
    try {
      const loaded = loadTradingConfiguration(appEnvironments[name], { readFile: path => {
        if (path !== bundlePath) throw new Error();
        return strategyText;
      } });
      if (loaded.mode !== 'bundle' || loaded.effectiveHash !== bundleHash) throw new Error();
      instrumentIds ??= loaded.configuration.instruments.filter(row => row.entryEnabled).map(row => row.id);
    } catch { throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); }
  }
  instrumentIds ??= [];
  if (!instrumentIds.length || new Set(instrumentIds).size !== instrumentIds.length || instrumentIds.some(x => !/^[A-Za-z0-9_-]{1,100}$/.test(x))) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
  return { accountId: execEnv.IBKR_ACCOUNT_ID, instrumentIds };
}

function revision(control: RuntimeControl): number {
  const n = Number(control.control?.revision); if (!Number.isSafeInteger(n) || n <= 0) throw new PaperRuntimeError('PAPER_CONTROL_UNKNOWN'); return n;
}
function controlShape(value: unknown, requireProtocol = true): RuntimeControl {
  const c = obj(value), control = obj(c?.control), events = c?.events;
  if (requireProtocol && c?.startupProtocolVersion !== 1) throw new PaperRuntimeError('PAPER_PROTOCOL_UNSUPPORTED');
  if (!control || typeof control.account_id !== 'string' || typeof control.paused !== 'boolean' || !Array.isArray(events)) throw new PaperRuntimeError('PAPER_PROTOCOL_UNSUPPORTED');
  return { control: control as RuntimeControl['control'], events: events.map(x => { const e = obj(x); if (!e || typeof e.paused !== 'boolean' || typeof e.reason !== 'string') throw new PaperRuntimeError('PAPER_CONTROL_UNKNOWN'); return e as RuntimeControl['events'][number]; }) };
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new PaperRuntimeError('PAPER_START_INTERRUPTED'); }
const pauseReason = (id: string) => `paper-start:${id}`;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function stoppedProducerRecords(raw: string): void {
  let records: unknown[];
  try {
    const trimmed = raw.trim();
    if (!trimmed) records = [];
    else if (trimmed.startsWith('[')) { const parsed: unknown = JSON.parse(trimmed); if (!Array.isArray(parsed)) throw Error(); records = parsed; }
    else records = trimmed.split(/\r?\n/).map(line => JSON.parse(line) as unknown);
  } catch { throw new PaperRuntimeError('PAPER_PRODUCERS_NOT_STOPPED'); }
  for (const value of records) {
    const record = obj(value);
    if (!record || !['signal-engine', 'llm-agent'].includes(String(record.Service)) ||
        !['exited', 'created', 'dead'].includes(String(record.State))) throw new PaperRuntimeError('PAPER_PRODUCERS_NOT_STOPPED');
  }
}

export class PaperRuntime {
  private readonly root: string; private readonly proofPath: string; private readonly overridePath: string;
  constructor(private readonly options: RuntimeOptions) { this.root = resolve(options.root); this.proofPath = options.releasePath ?? '.local/paper-runtime/release.json'; this.overridePath = options.overridePath ?? '.local/paper-runtime/compose.override.json'; }
  private composeBase(): string[] { return ['--project-directory', this.root, '--env-file', resolve(this.root, '.env'), '-f', resolve(this.root, 'docker-compose.yml'), '-f', resolve(this.root, '.local/paper-runtime/redis-internal.override.yml'), '-f', resolve(this.root, this.overridePath)]; }
  private async compose(args: string[], useSignal = true): Promise<string> {
    try {
      const out = await this.options.adapters.compose([...this.composeBase(), ...args], useSignal ? this.options.adapters.signal : undefined);
      if (Buffer.byteLength(out) > MAX_CONFIG_BYTES) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); return out;
    } catch (e) { if (e instanceof PaperRuntimeError) throw e; throw new PaperRuntimeError('PAPER_COMPOSE_UNAVAILABLE'); }
  }
  private async validatedProof(): Promise<{ proof: ReleaseProof; accountId: string; instrumentIds: string[] }> {
    const proof = await verifyProof(this.root, resolve(this.root, this.proofPath));
    const raw = await this.compose(['config', '--format', 'json']); let cfg: unknown;
    try { cfg = JSON.parse(raw); } catch { throw new PaperRuntimeError('PAPER_CONFIG_CHANGED'); }
    if (sha(canonicalJson(cfg)) !== proof.effectiveComposeSha256) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    const { accountId, instrumentIds } = await validateRenderedCompose(cfg, proof, this.root);
    return { proof, accountId, instrumentIds };
  }
  private async configuredAccount(): Promise<string> {
    const raw = await this.compose(['config', '--format', 'json'], false); let cfg: unknown;
    try { cfg = JSON.parse(raw); } catch { throw new PaperRuntimeError('PAPER_ACCOUNT_UNKNOWN'); }
    const services = obj(obj(cfg)?.services), execution = obj(services?.['execution-engine']);
    const e = execution ? envMap(execution) : null; const allowed = e?.ALLOWED_PAPER_ACCOUNTS?.split(',').map(x => x.trim()).filter(Boolean) ?? [];
    if (!e?.IBKR_ACCOUNT_ID || allowed.length !== 1 || allowed[0] !== e.IBKR_ACCOUNT_ID || e.IBKR_ENVIRONMENT !== 'paper' || e.ALLOWED_LIVE_ACCOUNTS) throw new PaperRuntimeError('PAPER_ACCOUNT_UNKNOWN');
    return e.IBKR_ACCOUNT_ID;
  }
  private async stopGeneration(): Promise<string> {
    const directory = '.local/paper-runtime';
    await resolveProofPath(this.root, directory);
    const path = resolve(this.root, directory, 'stop-generation');
    let stat;
    try { stat = await lstat(path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw new PaperRuntimeError('PAPER_STOP_MARKER_UNAVAILABLE'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 36) throw new PaperRuntimeError('PAPER_STOP_MARKER_UNAVAILABLE');
    const value = await readFile(path, 'utf8');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PaperRuntimeError('PAPER_STOP_MARKER_UNAVAILABLE');
    return value;
  }
  private async cancelPendingStarts(): Promise<void> {
    const directory = resolve(this.root, '.local/paper-runtime');
    try {
      for (const path of ['.local', '.local/paper-runtime']) {
        try { await mkdir(resolve(this.root, path), { mode: 0o700 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
        await resolveProofPath(this.root, path);
      }
      await this.stopGeneration();
      const temporary = resolve(directory, `stop-generation.${randomUUID()}.tmp`);
      try { await writeFile(temporary, randomUUID(), { mode: 0o600, flag: 'wx' }); await rename(temporary, resolve(directory, 'stop-generation')); }
      finally { await unlink(temporary).catch(() => undefined); }
    } catch { throw new PaperRuntimeError('PAPER_STOP_MARKER_UNAVAILABLE'); }
  }
  private async assertStart(generation: string, accountId?: string, expectedRevision?: number): Promise<void> {
    checkAbort(this.options.adapters.signal);
    if (await this.stopGeneration() !== generation) throw new PaperRuntimeError('PAPER_START_CANCELLED');
    checkAbort(this.options.adapters.signal);
    if (expectedRevision !== undefined) {
      const current = await this.readControl(); this.assertAccount(current, accountId!);
      if (revision(current) !== expectedRevision || !current.control?.paused) throw new PaperRuntimeError('PAPER_START_SUPERSEDED');
      checkAbort(this.options.adapters.signal);
      if (await this.stopGeneration() !== generation) throw new PaperRuntimeError('PAPER_START_CANCELLED');
    }
  }
  private async sleep(ms: number): Promise<void> { await (this.options.adapters.sleep ?? delay)(ms); checkAbort(this.options.adapters.signal); }
  private async http(path: string, body?: unknown, timeoutMs?: number, useSignal = true, extraSignal?: AbortSignal): Promise<unknown> {
    const parent = useSignal ? this.options.adapters.signal : undefined;
    try { return await this.options.adapters.http(path, body, timeoutMs, extraSignal ? AbortSignal.any([extraSignal, ...(parent ? [parent] : [])]) : parent); }
    catch (e) { if (parent?.aborted) throw new PaperRuntimeError('PAPER_START_INTERRUPTED'); if (e instanceof PaperRuntimeError) throw e; throw new PaperRuntimeError('PAPER_HTTP_UNAVAILABLE'); }
  }
  private async readControl(useSignal = true, requireProtocol = true): Promise<RuntimeControl> { return controlShape(await this.http('/execution/entry-control', undefined, undefined, useSignal), requireProtocol); }
  private assertAccount(control: RuntimeControl, expected: string): void { if (control.control?.account_id !== expected) throw new PaperRuntimeError('PAPER_ACCOUNT_MISMATCH'); }
  private exactEvent(control: RuntimeControl, reason: string, paused: boolean, expectedRevision?: number): boolean {
    const n = revision(control);
    return control.control?.paused === paused && (expectedRevision === undefined || n === expectedRevision) &&
      control.events.some(event => Number(event.revision) === n && event.paused === paused && event.reason === reason);
  }
  private async startupPause(reason: string, expectedRevision: number, accountId: string): Promise<RuntimeControl> {
    let failure: unknown;
    try { await this.http('/execution/entry-control/pause', { reason, expectedRevision }); } catch (e) { failure = e; }
    const after = await this.readControl(false); this.assertAccount(after, accountId);
    if (this.exactEvent(after, reason, true, expectedRevision + 1)) return after;
    if (failure instanceof PaperHttpError && failure.status === 423 && failure.code === 'ENTRY_CONTROL_REVISION_CHANGED') throw new PaperRuntimeError('PAPER_START_SUPERSEDED');
    throw new PaperRuntimeError('PAPER_CONTROL_UNKNOWN');
  }
  private async explicitPause(accountId: string): Promise<RuntimeControl> {
    const current = await this.readControl(false, false); this.assertAccount(current, accountId);
    const reason = `paper-stop:${randomUUID()}`;
    try { await this.http('/execution/entry-control/pause', { reason }, undefined, false); } catch { /* Read back once; never repeat an ambiguous mutation. */ }
    const after = await this.readControl(false, false); this.assertAccount(after, accountId);
    if (!this.exactEvent(after, reason, true)) throw new PaperRuntimeError('PAPER_PAUSE_UNKNOWN');
    return after;
  }
  private async stopProducerServices(): Promise<void> {
    await this.compose(['stop', 'signal-engine', 'llm-agent'], false);
    stoppedProducerRecords(await this.compose(['ps', '--all', '--format', 'json', 'signal-engine', 'llm-agent'], false));
  }
  async stop(): Promise<string> {
    await this.cancelPendingStarts();
    let paused: RuntimeControl | undefined;
    try { paused = await this.explicitPause(await this.configuredAccount()); }
    catch { /* Cancellation still stops entry producers; durable pause remains unconfirmed. */ }
    await this.stopProducerServices();
    if (!paused) throw new PaperRuntimeError('PAPER_PAUSE_UNKNOWN');
    return `Wejścia zatrzymane i potwierdzone. Execution i ingestion pozostają dostępne, aby nadzorować i obsłużyć wyjścia. Rewizja pauzy: ${revision(paused)}.`;
  }
  async status(): Promise<string> {
    try { if (this.options.adapters.statusReport) return await this.options.adapters.statusReport(); } catch { /* Show explicit read-only fallback. */ }
    const out = await this.compose(['ps', '--all', '--services', '--filter', 'status=running']);
    const services = out.split(/\r?\n/).filter(Boolean).sort().join(', ') || 'brak';
    return `Uruchomione kontenery: ${services}. Stan pauzy, danych i gotowość wejść są niepotwierdzone — API diagnostyki niedostępne.`;
  }
  async logs(): Promise<string> { await this.options.adapters.compose([...this.composeBase(), 'logs', '--follow', '--tail', '100', ...PAPER_SERVICES], this.options.adapters.signal); return ''; }
  async check(): Promise<string> {
    const { proof } = await this.validatedProof();
    let inspected: string; try { inspected = await this.options.adapters.inspectImage(proof.imageId); } catch { throw new PaperRuntimeError('PAPER_IMAGE_UNAVAILABLE'); }
    if (inspected.trim() !== proof.imageId) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
    return 'Prywatny profil, konfiguracja Paper i przypięty obraz są zgodne.';
  }
  async start(): Promise<string> {
    const generation = await this.stopGeneration();
    let accountId: string | undefined;
    try {
      await this.assertStart(generation);
      const validated = await this.validatedProof(); accountId = validated.accountId;
      await this.assertStart(generation);
      let inspected: string; try { inspected = await this.options.adapters.inspectImage(validated.proof.imageId); } catch { throw new PaperRuntimeError('PAPER_IMAGE_UNAVAILABLE'); }
      if (inspected.trim() !== validated.proof.imageId) throw new PaperRuntimeError('PAPER_CONFIG_CHANGED');
      await this.assertStart(generation);
      const reason = pauseReason(randomUUID());
      let executionAvailable = false;
      try { await this.http('/health'); executionAvailable = true; } catch { /* Read-only probe; account readiness is checked below. */ }
      await this.assertStart(generation);
      if (!executionAvailable) {
        await this.stopProducerServices(); await this.assertStart(generation);
        await this.compose(['up', '-d', '--no-build', '--pull', 'never', 'postgres', 'redis', 'execution-engine']);
        await this.assertStart(generation);
      }
      const current = await this.waitControl(generation, accountId);
      await this.assertStart(generation);
      const paused = await this.startupPause(reason, revision(current), accountId), pausedRevision = revision(paused);
      await this.assertStart(generation, accountId, pausedRevision);
      await this.compose(['up', '-d', '--no-build', '--pull', 'never', ...PAPER_SERVICES]);
      await this.assertStart(generation, accountId, pausedRevision);
      await this.prepareBootstrap(generation, accountId, pausedRevision);
      await this.waitPreparation(generation, accountId, pausedRevision, validated.instrumentIds);
      await this.resume(reason, pausedRevision, accountId, generation, validated.instrumentIds);
      await this.assertStart(generation);
      return 'Paper działa w Dockerze. Użyj pnpm stop, aby zatrzymać nowe wejścia, oraz pnpm logs, aby obserwować pracę.';
    } catch (e) {
      const interrupted = this.options.adapters.signal?.aborted || e instanceof PaperRuntimeError && e.code === 'PAPER_START_CANCELLED';
      if (interrupted) {
        if (this.options.adapters.signal?.aborted) await this.cancelPendingStarts();
        let pauseUnknown = false;
        if (accountId) { try { await this.explicitPause(accountId); } catch { pauseUnknown = true; } }
        await this.stopProducerServices();
        if (pauseUnknown) throw new PaperRuntimeError('PAPER_PAUSE_UNKNOWN');
        throw new PaperRuntimeError(this.options.adapters.signal?.aborted ? 'PAPER_START_INTERRUPTED' : 'PAPER_START_CANCELLED');
      }
      if (e instanceof PaperRuntimeError) throw e;
      throw new PaperRuntimeError('PAPER_START_FAILED');
    }
  }
  private async waitControl(generation: string, accountId: string): Promise<RuntimeControl> {
    let reported = false;
    for (;;) {
      await this.assertStart(generation);
      let current: RuntimeControl;
      try { current = await this.readControl(); }
      catch (e) {
        await this.assertStart(generation);
        if (e instanceof PaperRuntimeError && ['PAPER_PROTOCOL_UNSUPPORTED', 'PAPER_CONTROL_UNKNOWN'].includes(e.code) || e instanceof PaperHttpError && e.status !== 423 && e.status < 500) throw e;
        if (e instanceof PaperHttpError && e.status === 423 && !['ENTRY_CONTROL_ACCOUNT_UNAVAILABLE', 'no_active_account_for_exempt_route', 'active_account_unknown', 'account_not_confirmed', 'account_unknown'].includes(e.code)) throw e;
        if (!reported) { this.options.adapters.log?.('WAITING: połączenie Paper i potwierdzenie rachunku w IBKR.'); reported = true; }
        await this.sleep(1000); continue;
      }
      await this.assertStart(generation); this.assertAccount(current, accountId); revision(current); return current;
    }
  }
  private async prepareBootstrap(generation: string, accountId: string, expectedRevision: number): Promise<void> {
    for (;;) {
      await this.assertStart(generation, accountId, expectedRevision);
      try { await this.http('http://ingestion/health'); break; }
      catch (e) { if (e instanceof PaperHttpError && e.status < 500) throw e; }
      this.options.adapters.log?.('WAITING: uruchomienie usługi danych.'); await this.sleep(1000);
    }
    await this.assertStart(generation, accountId, expectedRevision);
    const requestAbort = new AbortController();
    let outcome: { state: 'pending' | 'success' | 'unknown' | 'rejected'; error?: PaperHttpError } = { state: 'pending' };
    void this.http('http://ingestion/bootstrap', {}, 120 * 60_000, true, requestAbort.signal).then(
      value => { outcome = { state: obj(value) && !obj(value)?.error ? 'success' : 'unknown' }; },
      error => { outcome = error instanceof PaperHttpError && error.status < 500 ? { state: 'rejected', error } : { state: 'unknown' }; },
    );
    let lastStatus = '';
    try {
      for (;;) {
        await this.assertStart(generation, accountId, expectedRevision);
        if (outcome.state === 'rejected') throw outcome.error;
        let health: Record<string, unknown> | null = null, progress: Record<string, unknown> | null = null;
        try {
          health = obj(await this.http('http://ingestion/health'));
          await this.assertStart(generation, accountId, expectedRevision);
          progress = obj(obj(await this.http('http://ingestion/backfill-progress'))?.progress);
        } catch (e) {
          if (e instanceof PaperRuntimeError && ['PAPER_START_INTERRUPTED', 'PAPER_START_CANCELLED', 'PAPER_START_SUPERSEDED', 'PAPER_ACCOUNT_MISMATCH'].includes(e.code)) throw e;
          if (e instanceof PaperHttpError && e.status < 500) throw e;
        }
        await this.assertStart(generation, accountId, expectedRevision);
        const automatic = obj(health?.automaticBootstrap);
        if (outcome.state !== 'pending' && (automatic?.manuallyStopped === true || automatic?.shuttingDown === true || automatic?.error)) throw new PaperRuntimeError('PAPER_BOOTSTRAP_HOLD');
        if (outcome.state !== 'pending' && progress?.phase === 'completed' && Array.isArray(progress.failedTimeframes) && progress.failedTimeframes.length) throw new PaperRuntimeError('PAPER_BOOTSTRAP_HOLD');
        if (health?.connected === true && health.bootstrapped === true && health.bootstrapping === false &&
            automatic?.initialized === true && automatic.manuallyStopped === false && automatic.inFlight === false &&
            automatic.recoveryNeeded === false && automatic.shuttingDown === false && automatic.error === null &&
            progress?.phase === 'completed' && Array.isArray(progress.failedTimeframes) && progress.failedTimeframes.length === 0) return;
        const phase = ['connecting', 'one_minute', 'native_tf', 'completed'].includes(String(progress?.phase)) ? String(progress?.phase) : 'unavailable';
        const status = `${outcome.state}:${phase}`;
        if (status !== lastStatus) { this.options.adapters.log?.(`WAITING: automatyczne przygotowanie: historia cen i subskrypcje (${status.replace(/[^a-z_:]/gi, '')}).`); lastStatus = status; }
        await this.sleep(5000);
      }
    } finally { requestAbort.abort(); }
  }
  private async waitPreparation(generation: string, accountId: string, expectedRevision: number, expectedInstruments: string[]): Promise<void> {
    let lastStatus = '';
    for (;;) {
      await this.assertStart(generation, accountId, expectedRevision);
      let prepared: Record<string, unknown> | null;
      try { prepared = obj(await this.http('/execution/entry-control/start/prepare', { expectedRevision })); }
      catch (e) {
        await this.assertStart(generation, accountId, expectedRevision);
        if (e instanceof PaperHttpError && e.status === 423) {
          if (['ENTRY_START_CONFIGURATION_UNAVAILABLE', 'ENTRY_START_CONNECTION_CHANGED', 'close_management_context_unavailable', 'ENTRY_CONTROL_ACCOUNT_UNAVAILABLE', 'no_active_account_for_exempt_route'].includes(e.code)) {
            let reasons: string[] = [];
            if (e.code === 'ENTRY_START_CONFIGURATION_UNAVAILABLE') {
              try {
                const diagnostic = obj(await this.http('/execution/configuration'));
                const admission = obj(diagnostic?.admission);
                const allowed = ['CONFIG_DRIFT', 'CONFIG_SERVICE_UNAVAILABLE', 'CONFIG_STORE_UNAVAILABLE', 'CONFIG_NOT_INITIALIZED', 'CONFIG_MIGRATION_PREPARATION'];
                if (Array.isArray(admission?.reasons) && admission.reasons.length && admission.reasons.every(reason => typeof reason === 'string' && allowed.includes(reason)))
                  reasons = [...new Set(admission.reasons as string[])];
              } catch { /* Diagnostic availability cannot change the preparation gate. */ }
            }
            await this.assertStart(generation, accountId, expectedRevision);
            const status = `WAITING:${e.code}:${reasons.join(',')}`;
            if (status !== lastStatus) { this.options.adapters.log?.(`WAITING: automatyczne przygotowanie oczekuje na ${e.code}${reasons.length ? ` (${reasons.join(', ')})` : ''}.`); lastStatus = status; }
            await this.sleep(5000); continue;
          }
          throw new PaperRuntimeError(e.code);
        }
        throw new PaperRuntimeError('PAPER_PREPARATION_UNKNOWN');
      }
      await this.assertStart(generation, accountId, expectedRevision);
      const results = Array.isArray(prepared?.instruments) ? prepared.instruments : [];
      const returnedIds = results.map(v => obj(v)?.instrumentId);
      if (Number(prepared?.revision) !== expectedRevision || results.length !== expectedInstruments.length ||
          returnedIds.some(x => typeof x !== 'string') || new Set(returnedIds).size !== expectedInstruments.length ||
          [...expectedInstruments].sort().join(',') !== (returnedIds as string[]).sort().join(',') ||
          results.some(v => !['READY', 'WAITING', 'HOLD'].includes(String(obj(v)?.state)))) throw new PaperRuntimeError('PAPER_PREPARATION_UNKNOWN');
      const states = results.map(v => obj(v)?.state);
      if (states.every(s => s === 'READY')) return;
      const reasons = results.flatMap(v => Array.isArray(obj(v)?.reasons) ? obj(v)!.reasons as unknown[] : []).filter((x): x is string => typeof x === 'string' && /^[A-Z][A-Z0-9_]*$/.test(x));
      if (states.some(s => s === 'HOLD')) { if (reasons.length) this.options.adapters.log?.(`Wstrzymano przygotowanie: ${[...new Set(reasons)].join(', ')}`); throw new PaperRuntimeError(reasons[0] ?? 'PAPER_RESEARCH_HOLD'); }
      const description = `WAITING:${[...new Set(reasons)].join(',')}`;
      if (description !== lastStatus) { this.options.adapters.log?.(`WAITING: przygotowanie badań: ${reasons.length ? [...new Set(reasons)].join(', ') : 'dane w przygotowaniu'}. Po ukończeniu bot automatycznie sprawdzi gotowość do pracy.`); lastStatus = description; }
      await this.sleep(5000);
    }
  }
  private async resume(reason: string, expectedRevision: number, accountId: string, generation: string, instrumentIds: string[]): Promise<void> {
    for (;;) {
      await this.assertStart(generation, accountId, expectedRevision);
      let failure: unknown;
      try { await this.http('/execution/entry-control/resume', { reason, expectedRevision }); } catch (e) { failure = e; }
      await this.assertStart(generation);
      const current = await this.readControl(false); this.assertAccount(current, accountId);
      await this.assertStart(generation);
      if (this.exactEvent(current, reason, false, expectedRevision + 1)) return;
      if (failure instanceof PaperHttpError && failure.status === 423 && revision(current) === expectedRevision && current.control?.paused) {
        if (failure.code === 'ENTRY_CONTROL_REVISION_CHANGED') throw new PaperRuntimeError('PAPER_START_SUPERSEDED');
        this.options.adapters.log?.(`Wznowienie czeka na bramkę: ${failure.code}`);
        await this.sleep(5000);
        if (failure.code === 'RESEARCH_REQUIRED_COVERAGE_UNAVAILABLE') await this.waitPreparation(generation, accountId, expectedRevision, instrumentIds);
        continue;
      }
      if (revision(current) !== expectedRevision) throw new PaperRuntimeError('PAPER_START_SUPERSEDED');
      throw new PaperRuntimeError('PAPER_RESUME_UNKNOWN');
    }
  }
}
