import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer, preview } from 'vite';
import { createOperatorMiddleware, operatorProxyPlugin, validateOperatorConfig, type OperatorConfig } from './operator-proxy.js';
import { createMutationAuth } from '@ikbr/shared/http-auth';

const password = 'operator-fixture-'.repeat(3);
const token = 'backend-fixture-'.repeat(3);
const origin = 'http://127.0.0.1:5173';
const auth = 'Basic ' + Buffer.from('operator:' + password).toString('base64');
function config(target: string): OperatorConfig {
  return { origin, password, backendToken: token, targets: { ingestion: target, signal: target, execution: target, backtest: target }, timeoutMs: 5_000 };
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string | string[]>; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: '127.0.0.1:5173', ...options.headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(options.body);
  });
}
const headers = { authorization: auth, origin, 'x-operator-request': '1', 'sec-fetch-site': 'same-origin' };

test('configuration rejects missing/shared secrets, plaintext remote origin and credential targets', () => {
  const base = config('http://127.0.0.1:3101');
  for (const patch of [{ password: '' }, { backendToken: '' }, { backendToken: token + ',' }, { password: token }, { origin: 'http://lan.example:5173' }, { origin: origin + '/' }, { targets: { ...base.targets, signal: 'http://user:secret@example.test' } }]) {
    assert.throws(() => validateOperatorConfig({ ...base, ...patch }));
  }
});

test('proxy denies unauthorized, CSRF, path and host confusion before any upstream effects', async t => {
  let calls = 0;
  const upstream = httpServer((_req, res) => { calls++; res.setHeader('content-type', 'application/json'); res.end('{}'); });
  const upstreamPort = await listen(upstream); t.after(() => close(upstream));
  const middleware = createOperatorMiddleware(config(`http://127.0.0.1:${upstreamPort}`));
  const server = httpServer((req, res) => middleware(req, res, () => res.end('asset')));
  const port = await listen(server); t.after(() => close(server));
  for (const path of ['/', '/asset.js', '/api/ingestion/bootstrap']) assert.equal((await call(port, path, { method: path.startsWith('/api') ? 'POST' : 'GET' })).status, 401);
  const endpoint = '/api/ingestion/bootstrap';
  for (const bad of [
    { ...headers, authorization: 'Basic ' + Buffer.from('operator:wrong').toString('base64') },
    { ...headers, authorization: [auth, auth] },
    { ...headers, origin: 'https://evil.example' }, { ...headers, origin: 'null' },
    { ...headers, origin: '' }, { ...headers, 'x-operator-request': '' },
    { ...headers, 'sec-fetch-site': 'cross-site' }, { ...headers, host: 'evil.example' },
    { ...headers, host: 'evil.example', 'x-forwarded-host': '127.0.0.1:5173' },
  ]) assert.ok((await call(port, endpoint, { method: 'POST', headers: bad })).status >= 400);
  assert.equal((await call(port, endpoint, { method: 'POST', headers: { authorization: auth, 'x-operator-request': '1' } })).status, 403);
  for (const path of ['/api/ingestionx/bootstrap', '//api/ingestion/bootstrap', '/api/ingestion/../ingestion/bootstrap', '/api/ingestion/%62ootstrap', '/api/ingestion/%252fbootstrap', '/api/ingestion\\bootstrap', '/api/ingestion/bootstrap#fragment', 'http://127.0.0.1:5173/api/ingestion/bootstrap', '/api/ingestion//bootstrap', '/api/signal/signals/run-once']) {
    assert.ok((await call(port, path, { method: 'POST', headers })).status >= 400, path);
  }
  for (const method of ['PUT', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal((await call(port, endpoint, { method, headers })).status, 404);
  assert.equal((await call(port, '/api/signal/signals/report', { headers: { authorization: auth } })).status, 403);
  for (const path of ['/__open-in-editor?file=private', '/__open-in-editor/']) for (const method of ['GET', 'HEAD']) assert.equal((await call(port, path, { method, headers: { authorization: auth } })).status, 404);
  assert.equal(calls, 0);
});

test('credential echoes cannot escape through UUID headers or escaped nested JSON strings/keys', async t => {
  for (const credential of ['12345678-1234-4123-8123-123456789abc', 'escaped-credential-'.repeat(3) + '"\\']) {
    for (const field of ['backendToken', 'password'] as const) {
      const upstream = httpServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (credential.startsWith('1234')) res.setHeader('x-correlation-id', credential);
        if (req.url?.includes('header')) res.end('{}');
        else if (req.url?.includes('key')) res.end(JSON.stringify({ nested: { [credential]: true } }));
        else res.end(JSON.stringify({ nested: ['Bearer ' + credential] }).replace(/e/g, '\\u0065'));
      });
      const up = await listen(upstream); t.after(() => close(upstream));
      const settings = { ...config(`http://127.0.0.1:${up}`), [field]: credential };
      const middleware = createOperatorMiddleware(settings);
      const server = httpServer((req, res) => middleware(req, res, () => res.end('asset')));
      const port = await listen(server); t.after(() => close(server));
      const credentials = { ...headers, authorization: 'Basic ' + Buffer.from('operator:' + settings.password).toString('base64') };
      const safe = await call(port, '/api/ingestion/health?header', { headers: credentials });
      assert.equal(safe.status, 200); assert.equal(safe.headers['x-correlation-id'], undefined);
      for (const query of ['key', 'body']) {
        const result = await call(port, '/api/ingestion/health?' + query, { headers: credentials });
        assert.equal(result.status, 502); assert.ok(!result.body.includes(credential));
      }
    }
  }
});

test('approved forwarding strips authority/cookies, blocks redirects/secret echo/size and never retries timeout', async t => {
  let calls = 0;
  let seen: IncomingHttpHeaders = {};
  let seenBody = '';
  const upstream = httpServer(async (req, res) => {
    calls++; seen = req.headers; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); seenBody = Buffer.concat(chunks).toString();
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', 'secret=server'); res.setHeader('www-authenticate', 'Basic realm="evil"');
    if (req.url?.includes('redirect')) { res.writeHead(302, { location: 'http://127.0.0.1:1/' + token }); res.end(); return; }
    if (req.url?.includes('echo')) { res.end(JSON.stringify({ token })); return; }
    if (req.url?.includes('large')) { res.end('x'.repeat(11 * 1024 * 1024)); return; }
    if (req.url?.includes('timeout')) return;
    res.end('{"ok":true}');
  });
  const up = await listen(upstream); t.after(() => close(upstream));
  const middleware = createOperatorMiddleware(config(`http://127.0.0.1:${up}`));
  const server = httpServer((req, res) => middleware(req, res, () => res.end('asset')));
  const port = await listen(server); t.after(() => close(server));
  const good = await call(port, '/api/ingestion/bootstrap', { method: 'POST', headers: { ...headers, cookie: 'operator-cookie', 'proxy-authorization': 'sensitive', 'x-forwarded-host': 'evil', 'x-reconciliation-resolve-token': 'sensitive', 'content-type': 'application/json' }, body: '{"scope":"fixture"}' });
  assert.equal(good.status, 200); assert.equal(seen.authorization, 'Bearer ' + token);
  for (const name of ['cookie', 'proxy-authorization', 'x-forwarded-host', 'x-reconciliation-resolve-token', 'origin']) assert.equal(seen[name], undefined);
  assert.equal(seenBody, '{"scope":"fixture"}'); assert.equal(good.headers['set-cookie'], undefined); assert.equal(good.headers['www-authenticate'], undefined);
  for (const query of ['redirect', 'echo', 'large', 'timeout']) {
    const before = calls; const denied = await call(port, '/api/ingestion/bootstrap?' + query, { method: 'POST', headers });
    assert.equal(denied.status, 502, query); assert.equal(calls, before + 1); assert.equal(denied.headers.location, undefined);
    assert.ok(!denied.body.includes(token)); assert.ok(!denied.body.includes(password));
  }
  const before = calls;
  assert.equal((await call(port, '/api/ingestion/bootstrap', { method: 'POST', headers: { ...headers, 'content-length': String(1024 * 1024 + 1) } })).status, 413);
  assert.equal(calls, before);
  const incomplete = await new Promise<string>(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/api/ingestion/bootstrap', method: 'POST', headers: { host: '127.0.0.1:5173', ...headers, 'content-length': '100' } });
    req.on('error', () => resolve('closed')); req.on('response', () => resolve('response')); req.write('{');
  });
  assert.equal(incomplete, 'closed'); assert.equal(calls, before);
});

for (const mode of ['dev', 'preview'] as const) test(`real Vite ${mode} protects assets and forwards empty UI POST to actual bound runtime route`, async t => {
  const require = createRequire(new URL('../../signal-engine/package.json', import.meta.url));
  const Fastify = require('fastify');
  const routesUrl = new URL('../../signal-engine/src/runtime/trading-loop/routes.ts', import.meta.url).href;
  const { tradingLoopRoutesPlugin } = await import(routesUrl);
  const upstream = Fastify(); let effects = 0; let body: unknown; let type: unknown; let guardAllowed = true;
  upstream.addHook('onRequest', createMutationAuth(token));
  upstream.addHook('onRequest', async (req: any) => { type = req.headers['content-type']; });
  upstream.addHook('preHandler', async (req: any) => { body = req.body; });
  const now = new Date();
  await upstream.register(tradingLoopRoutesPlugin, {
    bearerToken: token, paperGuard: { check: async () => ({ ok: guardAllowed, reason: 'fixture disabled writes' }) }, readinessDeps: {},
    service: { runOnce: async () => { effects++; return { cycleId: 'fixture-cycle', startedAt: now, finishedAt: now, durationMs: 0,
      reports: [{ instrumentId: 'fixture', startedAt: now, finishedAt: now, durationMs: 0, outcome: { kind: 'SKIPPED', reason: 'LOOP_DISABLED' } }] }; } },
  });
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 }); t.after(() => upstream.close());
  const root = await mkdtemp(join(tmpdir(), 'pp0-ui-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist')); await writeFile(join(root, 'index.html'), '<html>fixture</html>'); await writeFile(join(root, 'dist/index.html'), '<html>built fixture</html>');
  await writeFile(join(root, 'source.js'), 'export const fixture = true;');
  await writeFile(join(root, 'dist/asset.js'), 'const fixture = true;');
  const env = { UI_PUBLIC_ORIGIN: origin, UI_OPERATOR_PASSWORD: password, EXECUTION_API_TOKEN: token,
    UI_INGESTION_PROXY_TARGET: address, UI_SIGNAL_PROXY_TARGET: address, UI_EXECUTION_PROXY_TARGET: address, UI_BACKTEST_PROXY_TARGET: address };
  const options = { configFile: false as const, root, plugins: [operatorProxyPlugin(env)], logLevel: 'silent' as const,
    server: { host: '127.0.0.1', port: 0, hmr: false as const, cors: false }, preview: { host: '127.0.0.1', port: 0, cors: false } };
  const vite = mode === 'dev' ? await createServer(options) : await preview(options);
  if (mode === 'dev') await (vite as Awaited<ReturnType<typeof createServer>>).listen();
  t.after(() => vite.close());
  const bound = vite.httpServer!.address(); assert.ok(bound && typeof bound !== 'string'); const port = bound.port;
  assert.equal((await call(port, '/')).status, 401);
  const page = await call(port, '/', { headers: { authorization: auth } });
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  const asset = await call(port, mode === 'dev' ? '/source.js' : '/asset.js', { headers: { authorization: auth } });
  assert.equal(asset.status, 200); assert.equal(asset.headers['cache-control'], 'no-store');
  const nativeFetch = globalThis.fetch;
  const clientModuleUrl = new URL('../src/trading-loop.ts', import.meta.url).href;
  const { requestTradingLoopRunOnce } = await import(clientModuleUrl);
  globalThis.fetch = async (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const browserHeaders = new Headers(init?.headers);
      browserHeaders.set('authorization', auth); browserHeaders.set('origin', origin); browserHeaders.set('host', '127.0.0.1:5173');
      const result = await call(port, input, { method: init?.method, headers: Object.fromEntries(browserHeaders), body: init?.body as string | undefined });
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
    }
    return nativeFetch(input, init);
  };
  try {
    const result = await requestTradingLoopRunOnce();
    assert.equal(result.reports[0].outcome.reason, 'LOOP_DISABLED');
  } finally { globalThis.fetch = nativeFetch; }
  assert.equal(effects, 1); assert.equal(type, undefined); assert.equal(body, undefined);
  guardAllowed = false;
  const blocked = await call(port, '/api/signal/runtime/trading-loop/run-once', { method: 'POST', headers });
  assert.equal(blocked.status, 503); assert.equal(JSON.parse(blocked.body).outcome, 'PAPER_GUARD_FAILED'); assert.equal(effects, 1);
  const upgrade = await new Promise<string>(resolve => {
    const req = request({ host: '127.0.0.1', port, path: '/api/signal/runtime/trading-loop/run-once', headers: { connection: 'Upgrade', upgrade: 'websocket', host: '127.0.0.1:5173', ...headers } });
    req.on('error', () => resolve('closed')); req.on('upgrade', () => resolve('upgraded')); req.end();
  });
  assert.equal(upgrade, 'closed'); assert.equal(effects, 1);
});
