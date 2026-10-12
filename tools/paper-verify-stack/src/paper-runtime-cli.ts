import { formatDiagnosticReport, parseDiagnosticQuery } from '@ikbr/shared/diagnostics';
import { OperatorClient } from './operator-client.js';
import { appendLiveSupervision } from './operator-cli.js';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseEnv, parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PaperHttpError, PaperRuntime, PaperRuntimeError, type RuntimeHttp } from './paper-runtime.js';

const MAX_OUTPUT = 2_000_000;
export function runDocker(args: string[], options: { signal?: AbortSignal; stream?: boolean; timeoutMs?: number; maxBytes?: number } = {}, spawnProcess: typeof spawn = spawn): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) { reject(new PaperRuntimeError('PAPER_START_INTERRUPTED')); return; }
    const child = spawnProcess('docker', args, { stdio: options.stream ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let out = '', size = 0, failed = false, settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined, forced: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: PaperRuntimeError) => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(forced); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolvePromise(out);
    };
    const terminate = () => {
      if (failed) return; failed = true; child.kill('SIGTERM');
      forced = setTimeout(() => { child.kill('SIGKILL'); finish(new PaperRuntimeError('PAPER_COMPOSE_UNAVAILABLE')); }, 2000);
    };
    const abort = () => terminate();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) terminate();
    if (!options.stream) deadline = setTimeout(terminate, options.timeoutMs ?? 120000);
    child.stdout?.on('data', (b: Buffer) => { size += b.length; if (size > (options.maxBytes ?? MAX_OUTPUT)) { terminate(); return; } out += b.toString('utf8'); });
    child.stderr?.on('data', () => undefined);
    child.once('error', () => finish(new PaperRuntimeError('PAPER_COMPOSE_UNAVAILABLE')));
    child.once('close', code => finish(code === 0 && !failed ? undefined : new PaperRuntimeError(options.signal?.aborted ? 'PAPER_START_INTERRUPTED' : 'PAPER_COMPOSE_UNAVAILABLE')));
  });
}

export function httpClient(token: string, fetchImpl: typeof fetch = fetch): RuntimeHttp {
  return async (path, body, timeoutMs = 5000, parentSignal) => {
    const ingestion = path.startsWith('http://ingestion/');
    const localPath = ingestion ? path.slice('http://ingestion'.length) : path;
    if (ingestion ? !['/health', '/bootstrap', '/backfill-progress'].includes(localPath) : !/^\/(?:health|execution\/entry-control(?:\/(?:pause|resume|start\/prepare))?)$/.test(localPath)) throw new PaperRuntimeError('PAPER_HTTP_UNAVAILABLE');
    const url = `http://127.0.0.1:${ingestion ? 3101 : 3103}${localPath}`;
    const response = await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(parentSignal ? [parentSignal] : [])]),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.body) throw new PaperRuntimeError('PAPER_HTTP_UNAVAILABLE');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const x = await reader.read(); if (x.done) break; bytes += x.value.byteLength; if (bytes > MAX_OUTPUT) { await reader.cancel(); throw new PaperRuntimeError('PAPER_HTTP_UNAVAILABLE'); } chunks.push(x.value); } }
    finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new PaperRuntimeError('PAPER_HTTP_UNAVAILABLE'); }
    if (!response.ok) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PaperRuntimeError('PAPER_HTTP_UNAVAILABLE');
      const data = value as Record<string, unknown>;
      const code = [data.reason, data.message, data.error].find(v => typeof v === 'string' && /^(?:[A-Z][A-Z0-9_]{0,119}|[a-z][a-z0-9_]{0,119})$/.test(v));
      if (typeof code !== 'string') throw new PaperRuntimeError('PAPER_HTTP_UNAVAILABLE');
      throw new PaperHttpError(code, response.status);
    }
    return value;
  };
}

export async function runPaperRuntimeCli(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { 'env-file': { type: 'string' } } });
  const command = positionals[0];
  if (!['start', 'stop', 'logs', 'status', 'check'].includes(command ?? '') || positionals.length !== 1) {
    process.stderr.write('Użycie: pnpm start | pnpm stop | pnpm logs | pnpm status; pnpm paper:runtime check\n'); return 2;
  }
  const root = resolve(env.INIT_CWD ?? process.cwd());
  let fileEnv: Record<string, string> = {};
  try { fileEnv = Object.fromEntries(Object.entries(parseEnv(await readFile(resolve(root, values['env-file'] ?? '.env'), 'utf8'))).map(([k, v]) => [k, v ?? ''])); }
  catch { process.stderr.write('Nie można odczytać prywatnego pliku konfiguracji.\n'); return 2; }
  const token = env.EXECUTION_API_TOKEN ?? fileEnv.EXECUTION_API_TOKEN;
  if (!token) { process.stderr.write('Brak wymaganej konfiguracji operatora.\n'); return 2; }
  if (values['env-file'] && resolve(root, values['env-file']) !== resolve(root, '.env')) { process.stderr.write('Nie można zmienić pliku zatwierdzonego profilu.\n'); return 2; }
  const controller = new AbortController(); const interrupted = () => controller.abort();
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const runtime = new PaperRuntime({ root, token, adapters: {
    compose: async (args, signal) => runDocker(['compose', ...args], { signal, stream: args.includes('--follow'), timeoutMs: args.includes('up') ? 300000 : 120000 }),
    inspectImage: imageId => runDocker(['image', 'inspect', '--format', '{{.Id}}', imageId], { signal: controller.signal, maxBytes: 256 }),
    http: httpClient(token),
    statusReport: async () => {
      const client = new OperatorClient({ token });
      const report = await client.report(parseDiagnosticQuery({ mode: 'status' }));
      return formatDiagnosticReport(appendLiveSupervision(report, await client.control({ action: 'supervision' })), { timeZone: 'Europe/Warsaw' });
    },
    log: message => process.stdout.write(`${message}\n`),
    signal: controller.signal,
  } });
  try {
    const output = command === 'start' ? await runtime.start() : command === 'stop' ? await runtime.stop() : command === 'status' ? await runtime.status() : command === 'check' ? await runtime.check() : await runtime.logs();
    if (output) process.stdout.write(`${output}\n`); return 0;
  } catch (error) {
    const code = error instanceof PaperRuntimeError ? error.code : 'PAPER_RUNTIME_FAILED';
    process.stderr.write(`Nie wykonano polecenia: ${code}\n`); return 1;
  } finally { process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void runPaperRuntimeCli().then(code => { process.exitCode = code; }).catch(() => { process.stderr.write('Nie wykonano polecenia: PAPER_RUNTIME_FAILED\n'); process.exitCode = 1; });
