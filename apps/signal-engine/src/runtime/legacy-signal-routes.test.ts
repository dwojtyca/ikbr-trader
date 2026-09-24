import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { unavailableLegacySignalRoutes } from './legacy-signal-routes.js';
for (const path of ['/signals/run-once','/signals/on-candle']) test(`${path} rejects caller supplied calendar flags without any producer dependency`, async () => {
  const app = Fastify();
  try {
    await app.register(unavailableLegacySignalRoutes);
    const response = await app.inject({ method: 'POST', url: path, payload: { symbol: 'ARBITRARY', verifiedSession: true, calendarVerified: true } });
    assert.equal(response.statusCode,503);
    assert.equal(response.json().error,'verified_bound_runtime_required');
  } finally { await app.close(); }
});
