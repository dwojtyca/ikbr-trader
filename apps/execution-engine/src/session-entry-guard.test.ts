import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { buildInstrumentSessionIdentity, parseBrokerContractSessionHours, type SessionSchedule } from '@ikbr/shared';
import { buildTradingConfigurationProjection, parseTradingConfiguration } from '@ikbr/shared/trading-config';
import { createSessionEntryGuard } from './session-entry-guard.js';

test('entry guard still requires current historical coverage despite verified closed or open contract hours', async () => {
  const raw = JSON.parse(readFileSync(new URL('../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json', import.meta.url), 'utf8'));
  const parsed = parseTradingConfiguration(raw); assert.ok(parsed.ok); if (!parsed.ok) return;
  const bound = buildTradingConfigurationProjection(parsed.configuration).authority.getBoundInstrument('pko_wse')!;
  const identity = buildInstrumentSessionIdentity(bound.instrument, bound);
  const stamp = '2026-11-04T07:50:00.000Z';
  const schedule: SessionSchedule = { source: 'ibkr_session_schedule_v1', identity, requestedAt: stamp, receivedAt: stamp,
    coverageStart: '2026-10-01T00:00:00.000Z', coverageEnd: '2026-11-03T16:05:00.000Z',
    sessions: [{ date: '2026-11-03', start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T16:05:00.000Z' }],
    currentHours: parseBrokerContractSessionHours({ timeZoneId: identity.timeZone, liquidHours: '20261104:0900-1705' }, identity, stamp, stamp) };
  let now = stamp;
  const db = { query: async (sql: string) => ({ rows: sql.includes('clock_timestamp') ? [{ now }]
    : [{ generation: 1, status: 'READY', evidence: schedule, updated_at: stamp }] }) } as unknown as Pick<Pool, 'query'>;
  const guard = createSessionEntryGuard(() => bound);
  const order = { instrumentId: bound.instrumentId, instrument: bound.brokerSymbol, conid: String(bound.conId) };
  for (const at of [stamp, '2026-11-04T08:01:00.000Z']) {
    now = at;
    assert.deepEqual(await guard(db, order), { ok: false, reason: 'session_schedule_coverage_missing' });
  }
  schedule.coverageEnd = '2026-11-04T16:05:00.000Z';
  schedule.sessions.push({ date: '2026-11-04', start: '2026-11-04T08:00:00.000Z', end: schedule.coverageEnd });
  assert.equal((await guard(db, order)).ok, true);
});
