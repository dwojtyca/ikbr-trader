import type { IncomingMessage, ServerResponse } from 'node:http';
import { secretsEqual } from '@ikbr/shared/http-auth';
import type { Plugin } from 'vite';

const MAX_BODY = 1024 * 1024;
const MAX_RESPONSE = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICES = ['ingestion', 'signal', 'execution', 'backtest'] as const;
type Service = typeof SERVICES[number];
export interface OperatorConfig {
  origin: string;
  password: string;
  backendToken: string;
  targets: Record<Service, string>;
  timeoutMs?: number;
}

function fixedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid operator proxy origin configuration'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) {
    throw new Error('Invalid operator proxy origin configuration');
  }
  return url.origin;
}

export function validateOperatorConfig(config: OperatorConfig): OperatorConfig {
  fixedOrigin(config.origin);
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('Remote operator origin requires HTTPS');
  if (!/^[\x21-\x39\x3b-\x7e]{32,}$/.test(config.password) || !/^[\x21-\x7e]{32,}$/.test(config.backendToken) || config.backendToken.includes(',') || secretsEqual(config.password, config.backendToken)) {
    throw new Error('Distinct operator and backend credentials of at least 32 characters are required');
  }
  for (const value of Object.values(config.targets)) fixedOrigin(value);
  return config;
}

export function operatorConfigFromEnv(env: Record<string, string | undefined>): OperatorConfig {
  return validateOperatorConfig({
    origin: env.UI_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5173',
    password: env.UI_OPERATOR_PASSWORD ?? '',
    backendToken: env.EXECUTION_API_TOKEN ?? '',
    targets: Object.fromEntries(SERVICES.map((service, index) => [service,
      env[`UI_${service.toUpperCase()}_PROXY_TARGET`] ?? `http://127.0.0.1:${3101 + index}`])) as Record<Service, string>,
  });
}

const GET_ROUTES: Record<Service, readonly string[]> = {
  ingestion: ['/health', '/backfill-progress', '/watchlist'],
  signal: ['/health', '/signals/report', '/signals/strategies', '/signals/outcomes/summary', '/signals/recent', '/runtime/trading-loop/status', '/runtime/trading-loop/ready'],
  execution: ['/health', '/execution/orders', '/execution/trades', '/execution/account/summary'],
  backtest: ['/backtest/dataset', '/backtest/runs', '/backtest/report'],
};
const POST_ROUTES: Record<Service, readonly string[]> = {
  ingestion: ['/bootstrap', '/stop'],
  signal: ['/runtime/trading-loop/run-once'],
  execution: ['/execution/bootstrap'],
  backtest: ['/backtest/history', '/backtest/history/resume', '/backtest/run'],
};

export function allowed(method: string, service: Service, path: string): boolean {
  if (method === 'GET') return GET_ROUTES[service].includes(path) || service === 'execution' && /^\/execution\/orders\/[1-9][0-9]*\/research$/.test(path);
  if (method !== 'POST') return false;
  if (POST_ROUTES[service].includes(path)) return true;
  if (service === 'signal') return /^\/signals\/strategies\/[A-Za-z0-9_-]+$/.test(path);
  return service === 'execution' && /^\/execution\/(execute|reject|cancel)-proposed\/[1-9][0-9]*$/.test(path);
}

function countHeader(req: IncomingMessage, name: string): number {
  return req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
}
function json(res: ServerResponse, status: number, error: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error }));
}
function safePath(raw: string): string | null {
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\#\x00-\x20\x7f]/.test(raw)) return null;
  const path = raw.split('?', 1)[0];
  if (path.includes('%') || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) return null;
  try { decodeURIComponent(raw); } catch { return null; }
  return path;
}
function operatorAuthorized(req: IncomingMessage, password: string): boolean {
  if (countHeader(req, 'authorization') !== 1) return false;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(req.headers.authorization ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.toString('base64') !== match[1]) return false;
  return secretsEqual(decoded.toString('utf8'), `operator:${password}`);
}
async function requestBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => req.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY) throw new Error('body_too_large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); }
}
async function responseBody(response: Response): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE) throw new Error('response_too_large');
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

function responseLeaksSecret(output: Buffer, config: OperatorConfig): boolean {
  const contains = (value: string) => value.includes(config.password) || value.includes(config.backendToken);
  if (contains(output.toString('utf8'))) return true;
  if (!output.length) return false;
  let decoded: unknown;
  try { decoded = JSON.parse(output.toString('utf8')); } catch { return true; }
  const pending: unknown[] = [decoded];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && contains(value)) return true;
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (contains(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

export function createOperatorMiddleware(input: OperatorConfig) {
  const config = validateOperatorConfig(input);
  const authority = new URL(config.origin).host.toLowerCase();
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const protectedHeaders: Record<string, string> = {
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    };
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (name, value) => setHeader(name, protectedHeaders[name.toLowerCase()] ?? value);
    for (const [name, value] of Object.entries(protectedHeaders)) res.setHeader(name, value);
    const path = safePath(req.url ?? '');
    if (!path || countHeader(req, 'host') !== 1 || req.headers.host?.toLowerCase() !== authority) return json(res, 400, 'invalid_request');
    if (!operatorAuthorized(req, config.password)) {
      res.setHeader('www-authenticate', 'Basic realm="IBKR operator", charset="UTF-8"');
      return json(res, 401, 'unauthorized');
    }
    if (countHeader(req, 'origin') > 1 || (req.headers.origin !== undefined && req.headers.origin !== config.origin)) return json(res, 403, 'origin_denied');
    if (!path.startsWith('/api')) {
      if (path.startsWith('/__open-in-editor')) return json(res, 404, 'route_denied');
      if (!['GET', 'HEAD'].includes(req.method ?? '')) return json(res, 405, 'method_denied');
      return next();
    }
    const match = /^\/api\/(ingestion|signal|execution|backtest)(\/.*)$/.exec(path);
    if (!match || !allowed(req.method ?? '', match[1] as Service, match[2])) return json(res, 404, 'route_denied');
    if (countHeader(req, 'x-operator-request') !== 1 || req.headers['x-operator-request'] !== '1' ||
      (req.method !== 'GET' && req.headers.origin !== config.origin) ||
      (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) return json(res, 403, 'origin_denied');
    if (req.headers['content-type'] !== undefined && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) return json(res, 415, 'content_type_denied');
    const size = Number(req.headers['content-length'] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BODY) return json(res, 413, 'body_too_large');
    void forward(req, res, config, match[1] as Service, match[2]).catch(() => {
      if (!res.writableEnded) json(res, 502, 'upstream_unavailable');
    });
  };
}
async function forward(req: IncomingMessage, res: ServerResponse, config: OperatorConfig, service: Service, path: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
  const abort = () => controller.abort();
  req.once('aborted', abort);
  try {
    const body = await requestBody(req, controller.signal);
    const queryIndex = req.url!.indexOf('?');
    const query = queryIndex < 0 ? '' : req.url!.slice(queryIndex);
    const headers: Record<string, string> = { authorization: `Bearer ${config.backendToken}` };
    if (body.length) headers['content-type'] = 'application/json';
    const correlation = req.headers['x-correlation-id'];
    if (typeof correlation === 'string' && UUID.test(correlation)) headers['x-correlation-id'] = correlation;
    const response = await fetch(`${config.targets[service]}${path}${query}`, {
      method: req.method, headers,
      body: req.method === 'POST' && body.length ? new Uint8Array(body) : undefined,
      redirect: 'manual', signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return json(res, 502, 'upstream_redirect_denied');
    }
    const output = await responseBody(response);
    if (responseLeaksSecret(output, config)) return json(res, 502, 'upstream_response_denied');
    const type = response.headers.get('content-type');
    if (type && !/^application\/json(?:;|$)/i.test(type)) return json(res, 502, 'upstream_response_denied');
    res.statusCode = response.status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    const upstreamCorrelation = response.headers.get('x-correlation-id');
    if (upstreamCorrelation && UUID.test(upstreamCorrelation) && !upstreamCorrelation.includes(config.password) && !upstreamCorrelation.includes(config.backendToken)) res.setHeader('x-correlation-id', upstreamCorrelation);
    res.end(output);
  } catch (error) {
    json(res, error instanceof Error && error.message === 'body_too_large' ? 413 : 502, 'upstream_unavailable');
  } finally { clearTimeout(timeout); req.off('aborted', abort); }
}

export function operatorProxyPlugin(env: Record<string, string | undefined>): Plugin {
  return {
    name: 'authenticated-operator-proxy',
    configureServer(server) {
      server.middlewares.use(createOperatorMiddleware(operatorConfigFromEnv(env)));
      server.httpServer?.on('upgrade', (_request, socket) => socket.destroy());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createOperatorMiddleware(operatorConfigFromEnv(env)));
      server.httpServer.on('upgrade', (_request, socket) => socket.destroy());
    },
  };
}
