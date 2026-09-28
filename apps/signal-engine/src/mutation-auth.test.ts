import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createMutationAuth, SIGNAL_MUTATING_READS, operatorSafeLogger, logSafeResponse } from '@ikbr/shared/http-auth';
import { unavailableLegacySignalRoutes } from './runtime/legacy-signal-routes.js';

test('root auth covers encoded mutation reads, implicit HEAD, queries and nested mutation plugins', async t => {
  const app = Fastify(); t.after(() => app.close());
  let effects = 0;
  app.addHook('onRequest', createMutationAuth('fixture-token', SIGNAL_MUTATING_READS));
  for (const route of SIGNAL_MUTATING_READS) app.get(route, async () => { effects++; return { ok: true }; });
  app.get('/health', async () => ({ ok: true }));
  const mutations = ['/bootstrap', '/stop', '/signals/strategies/test', '/runtime/dry-run', '/runtime/execute', '/runtime/trading-loop/run-once', '/backtest/history', '/backtest/history/symbols', '/backtest/history/resume', '/backtest/run', '/backtest/research/es-compatibility', '/backtest/research/es-compatibility-v2', '/backtest/research/es-compatibility-v3'];
  await app.register(async child => {
    for (const route of mutations) {
      child.post(route, async () => { effects++; return { ok: true }; });
    }
  });
  await app.register(unavailableLegacySignalRoutes);
  for (const url of mutations) for (const authorization of [undefined, 'Bearer wrong']) {
    assert.equal((await app.inject({ method: 'POST', url, headers: authorization ? { authorization } : {} })).statusCode, 401, url);
  }
  for (const route of SIGNAL_MUTATING_READS) {
    for (const url of [route, route + '?token=untrusted', route.slice(0, -1) + '%' + route.at(-1)!.charCodeAt(0).toString(16)]) {
      for (const method of ['GET', 'HEAD'] as const) assert.equal((await app.inject({ method, url })).statusCode, 401, url);
    }
  }
  assert.equal(effects, 0);
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject({ url: '/signals/repor%74?limit=2', headers: { authorization: 'Bearer fixture-token' } })).statusCode, 200);
  assert.equal(effects, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/signals/run-once', headers: { authorization: 'Bearer fixture-token' } })).statusCode, 503);
});

test('empty backend token fails closed while trading disabled', async t => {
  const app = Fastify(); t.after(() => app.close());
  app.addHook('onRequest', createMutationAuth(''));
  app.post('/stop', async () => assert.fail('unauthorized handler effect'));
  assert.equal((await app.inject({ method: 'POST', url: '/stop', headers: { authorization: 'Bearer anything' } })).statusCode, 401);
});

test('request logs exclude unknown URLs, query credentials and parser error input', async t => {
  let output = '';
  const app = Fastify({ disableRequestLogging: true, logger: { ...operatorSafeLogger('info'), stream: { write: (line: string) => { output += line; } } } });
  t.after(() => app.close());
  app.addHook('onResponse', logSafeResponse);
  app.addHook('onRequest', createMutationAuth('fixture-token'));
  app.post('/parse', async () => ({ ok: true }));
  const sentinel = 'synthetic-secret-sentinel';
  for (const url of ['/missing?credential=' + sentinel, '/missing/' + sentinel, 'http://user:' + sentinel + '@example.test/missing', '/bad%XX?token=' + sentinel]) await app.inject({ url });
  await app.inject({ method: 'POST', url: '/parse?token=' + sentinel, headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, payload: '{"bad":' + sentinel });
  assert.ok(!output.includes(sentinel), output);
  assert.ok(!output.includes('fixture-token'), output);
  assert.ok(output.includes('statusCode'));
  assert.ok(output.includes('400'));
});

test('root authentication preserves the actual protected research rejection', async t => {
  const moduleUrl = new URL('../../backtest-engine/src/research-route-guard.ts', import.meta.url).href;
  const { installProtectedResearchRouteGuard } = await import(moduleUrl);
  const app = Fastify(); t.after(() => app.close());
  app.addHook('onRequest', createMutationAuth('fixture-token'));
  installProtectedResearchRouteGuard(app, 'postgresql://fixture:fixture@localhost/ikbr_trader_backtest_pr15_5a');
  app.post('/backtest/history', async () => assert.fail('immutable research handler executed'));
  assert.equal((await app.inject({ method: 'POST', url: '/backtest/history' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/backtest/history', headers: { authorization: 'Bearer fixture-token' } })).statusCode, 423);
});
