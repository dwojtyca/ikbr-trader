import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagnosticQuery, DiagnosticReport } from '@ikbr/shared/diagnostics';
import { researchHash } from '@ikbr/shared/instrument-research';
import { researchFixture } from '@ikbr/shared/instrument-research-testfixture';
import { appendDiagnosticStatus } from './read-model-status.js';
import type { DiagnosticReadModelDeps } from './read-model.js';
import { roundTrip as roundTripFixture } from '../lifecycle/round-trip-test-fixture.js';
import { evaluateRoundTrip } from '../lifecycle/round-trip-evidence.js';

const now = '2026-10-04T12:00:00.000Z';
const query: DiagnosticQuery = { mode: 'status', from: '2026-10-04T11:00:00.000Z', to: now, limit: 200 };
function report(): DiagnosticReport {
  return { schemaVersion: 1, mode: 'status', generatedAt: now, interval: { from: query.from, to: query.to },
    coverage: [], events: [], sections: [{ id: 'instrument:pko_wse', title: 'PKO', instrumentId: 'pko_wse', fields: [] }],
    counters: [], truncated: false, omissions: [] };
}
function deps(overrides: Partial<DiagnosticReadModelDeps> = {}): DiagnosticReadModelDeps {
  return { pool: { query: async (sql: string) => {
    if (sql.includes('FROM execution_entry_controls')) return { rows: [{ paused: true, revision: 2, updated_at: now }] };
    if (sql.includes('FROM lifecycle_observer_health')) return { rows: [{ session_id: 'session-1', healthy: true, observed_at: now, reason: null }] };
    if (sql.includes('FROM reconciliation_runs')) return { rows: [{ status: 'CLEAN', completed_at: now, snapshot_complete: false }] };
    if (sql.includes('FROM reconciliation_holds')) return { rows: [
      { identity_key: 'conid:DU1234567|35146360', reason: 'UNKNOWN_SUBMISSION', severity: 'critical', created_at: now },
      { identity_key: 'conid:DU1234567|999', reason: 'OTHER_EXPOSURE', severity: 'warning', created_at: now }] };
    if (sql.includes('FROM lifecycle_supervision')) return { rows: [{ instrument_id: 'pko_wse', conid: '35146360', status: 'HOLD', observed_at: now,
      exit_deadline: now, terminal_proof_recorded: false }] };
    if (sql.includes('FROM lifecycle_alert_outbox')) return { rows: [{ status: 'UNKNOWN', created_at: now, delivered_at: null }] };
    if (sql.includes('FROM instrument_session_schedules')) return { rows: [] };
    if (sql.includes('FROM research_authority')) return { rows: [] };
    if (sql.includes('FROM candles_1m')) return { rows: [{ conid: '35146360', source: 'ibkr_session_rth_native_v1', candles: 17, last_at: now }] };
    return { rows: [] };
  } } as DiagnosticReadModelDeps['pool'],
    currentAccountId: () => 'DU1234567', currentSessionId: () => 'session-1',
    configuration: () => ({ configHash: 'hash', instruments: [{ id: 'pko_wse', symbol: 'PKO', listing: 'WSE', conId: '35146360',
      implementationId: 'momentum_breakout_long_v1', instanceId: 'pko-momo', revision: 1 }] }),
    readWatchlist: async () => ({ connected: true, watchlist: [{ instrumentId: 'pko_wse', symbol: 'PKO', conid: '35146360', subscribed: true,
      marketState: { conid: '35146360', marketDataType: 1, bidObservedAt: '2026-10-04T11:59:59.000Z', askObservedAt: '2026-10-04T11:59:58.000Z' } }] }),
    ...overrides };
}
function value(result: DiagnosticReport, key: string) { return result.sections[0]?.fields.find(field => field.key === key)?.value; }

test('status uses stored source fields and leaves unsupported broker/accounting claims unknown', async () => {
  const output = report();
  await appendDiagnosticStatus(deps(), query, output);
  assert.equal(value(output, 'quoteType'), 1);
  assert.equal(value(output, 'quoteAgeMs'), 2000);
  assert.equal(value(output, 'quoteCurrent'), null);
  assert.equal(value(output, 'candles1mRTH'), 17);
  assert.equal(value(output, 'candles5mRTH'), 0);
  assert.equal(value(output, 'entryPaused'), true);
  assert.equal(value(output, 'observerHealthy'), true);
  assert.equal(value(output, 'activeHoldCount'), 1);
  assert.equal(value(output, 'accountActiveHoldCount'), 2);
  assert.equal(value(output, 'otherOrAmbiguousHoldCount'), 1);
  assert.match(String(value(output, 'activeHoldReasons')), /UNKNOWN_SUBMISSION/);
  assert.equal(value(output, 'supervisionStatus'), 'HOLD');
  assert.equal(value(output, 'alertDeliveryStatus'), 'UNKNOWN');
  assert.equal(value(output, 'reconciliationSnapshotComplete'), false);
  assert.equal(value(output, 'sessionOpen'), null);
  assert.equal(value(output, 'brokerStatus'), null);
  assert.equal(value(output, 'accountingCompleteness'), null);
  assert.ok(output.sections[0]?.fields.every(field => field.value === null || typeof field.value !== 'object'));
  assert.ok(output.coverage.some(row => row.source === 'watchlist' && row.status === 'PARTIAL'));
});

test('source failure and stale observer do not become zero or healthy, and queries remain account scoped', async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const original = deps();
  const output = report();
  await appendDiagnosticStatus(deps({ pool: { query: async (sql: string, params: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes('FROM candles_1m') || sql.includes('FROM reconciliation_holds')) throw Error('secret db details');
    if (sql.includes('FROM lifecycle_observer_health')) return { rows: [{ session_id: 'session-1', healthy: true,
      observed_at: '2026-10-04T11:00:00.000Z', reason: 'ok' }] };
    return original.pool.query(sql, params);
  } } as DiagnosticReadModelDeps['pool'], readWatchlist: async () => ({ connected: false, watchlist: [] }) }), query, output);
  assert.equal(value(output, 'candles1mRTH'), null);
  assert.equal(value(output, 'activeHoldCount'), null);
  assert.equal(value(output, 'observerHealthy'), null);
  assert.equal(value(output, 'quoteType'), null);
  assert.ok(output.coverage.some(row => row.source === 'candles_1m' && row.status === 'UNAVAILABLE' && row.reasons.includes('SOURCE_READ_FAILED')));
  assert.doesNotMatch(JSON.stringify(output), /secret db details|DU1234567/);
  for (const { sql, params } of statements) {
    assert.doesNotMatch(sql, /DU1234567/);
    if (/execution_entry_controls|lifecycle_observer_health|reconciliation_runs|reconciliation_holds|lifecycle_supervision|lifecycle_alert_outbox/.test(sql))
      assert.equal(params[0], 'DU1234567');
  }
});

test('account change removes status sections and marks evidence unavailable', async () => {
  let reads = 0;
  const output = report();
  await appendDiagnosticStatus(deps({ currentAccountId: () => ++reads > 1 ? 'DU7654321' : 'DU1234567' }), query, output);
  assert.equal(output.sections.length, 0);
  assert.ok(output.coverage.some(row => row.source === 'account' && row.status === 'UNAVAILABLE' && row.reasons.includes('ACCOUNT_CONTEXT_CHANGED')));
});

test('full configured session identity is required before calling a stored schedule open', async () => {
  const identity = { instrumentId: 'pko_wse', conId: 35146360, symbol: 'PKO', secType: 'STK', exchange: 'WSE',
    currency: 'PLN', useRTH: true, timeZone: 'Europe/Warsaw' };
  const schedule = { source: 'ibkr_session_schedule_v1', identity,
    coverageStart: '2026-09-19T00:00:00.000Z', coverageEnd: '2026-10-10T00:00:00.000Z',
    requestedAt: '2026-10-04T11:00:00.000Z', receivedAt: '2026-10-04T11:00:01.000Z',
    sessions: [{ date: '2026-10-04', start: '2026-10-04T11:00:00.000Z', end: '2026-10-04T13:00:00.000Z' }] };
  const original = deps();
  const configured = deps({
    configuration: () => ({ ...original.configuration(), instruments: original.configuration().instruments.map(item => ({ ...item, sessionIdentity: identity })) }),
    pool: { query: async (sql: string, params: unknown[]) => sql.includes('FROM instrument_session_schedules')
      ? { rows: [{ instrument_id: 'pko_wse', conid: '35146360', use_rth: true, generation: '1', status: 'READY',
        evidence: schedule, updated_at: '2026-10-04T11:00:01.000Z' }] } : original.pool.query(sql, params) } as DiagnosticReadModelDeps['pool'],
  });
  const output = report();
  await appendDiagnosticStatus(configured, query, output);
  assert.equal(value(output, 'sessionOpen'), true);
  assert.equal(value(output, 'sessionRthVerified'), true);
  const wrong = deps({ ...configured, configuration: () => ({ ...configured.configuration(), instruments: configured.configuration().instruments.map(item => ({ ...item,
    sessionIdentity: { ...identity, currency: 'USD' } })) }) });
  const changed = report();
  await appendDiagnosticStatus(wrong, query, changed);
  assert.equal(value(changed, 'sessionOpen'), null);
  assert.equal(value(changed, 'sessionRthVerified'), null);
});

test('research eligibility comes from validated stored manifest and snapshot at report time', async () => {
  const fixture = researchFixture(Date.parse(now), 'pko_wse');
  const original = deps();
  const statusDeps = deps({ configuration: () => ({ configHash: fixture.configHash, instruments: original.configuration().instruments }),
    pool: { query: async (sql: string, params: unknown[]) => sql.includes('FROM research_authority')
      ? { rows: [{ manifest_hash: fixture.manifestHash, manifest_json: JSON.stringify(fixture.manifest),
        instrument_id: 'pko_wse', snapshot_id: 'fixture-snapshot', snapshot_hash: researchHash(fixture.snapshot),
        snapshot_json: JSON.stringify(fixture.snapshot), stored_at: now }] } : original.pool.query(sql, params) } as DiagnosticReadModelDeps['pool'] });
  const output = report();
  await appendDiagnosticStatus(statusDeps, query, output);
  assert.equal(value(output, 'researchCoverage'), 'ELIGIBLE_AT_REPORT_TIME');
  assert.equal(value(output, 'researchSnapshotId'), 'fixture-snapshot');
  assert.equal(value(output, 'research:official:news:status'), 'EMPTY');
  assert.equal(value(output, 'research:official:news:complete'), true);
  const stale = report();
  stale.generatedAt = '2026-10-04T13:00:00.000Z';
  await appendDiagnosticStatus(statusDeps, query, stale);
  assert.equal(value(stale, 'researchCoverage'), 'INELIGIBLE_AT_REPORT_TIME');
  assert.match(String(value(stale, 'researchBlockers')), /RESEARCH_SOURCE_STALE_OR_FUTURE/);
});

test('each supervised lifecycle gets its own evaluated result and financial fields retain source sensitivity', async () => {
  const original = deps();
  const source = roundTripFixture();
  const completed = evaluateRoundTrip(source.evidence, source.context);
  const pendingSource = roundTripFixture();
  pendingSource.evidence.fills[1].commission = null;
  const pending = evaluateRoundTrip(pendingSource.evidence, pendingSource.context);
  const calls: number[] = [];
  const configured = deps({ pool: { query: async (sql: string, params: unknown[]) => sql.includes('FROM lifecycle_supervision')
    ? { rows: [41, 42].map(id => ({ instrument_id: 'pko_wse', conid: '35146360', original_proposal_id: id,
      status: id === 41 ? 'CLOSED' : 'HOLD', observed_at: now, exit_deadline: now, terminal_proof_recorded: id === 41 })) }
    : original.pool.query(sql, params) } as DiagnosticReadModelDeps['pool'],
    roundTrip: async proposalId => {
      calls.push(proposalId);
      const result = proposalId === 41 ? completed : pending;
      return { ...result, proposalId, instrumentId: 'pko_wse', conid: '35146360', accountId: 'DU1234567' };
    } });
  const output = report();
  await appendDiagnosticStatus(configured, query, output);
  assert.deepEqual(calls, [41, 42]);
  const lifecycles = output.sections.filter(section => section.id.startsWith('lifecycle:'));
  assert.equal(lifecycles.length, 2);
  const read = (index: number, key: string) => lifecycles[index].fields.find(item => item.key === key);
  assert.equal(read(0, 'proposalId')?.value, '41');
  assert.equal(read(1, 'proposalId')?.value, '42');
  assert.equal(read(0, 'roundTripStatus')?.value, completed.status);
  assert.equal(read(1, 'roundTripStatus')?.value, pending.status);
  assert.equal(read(1, 'accounting')?.value, pending.accounting);
  assert.equal(read(0, 'grossPnl')?.sensitivity, 'financial');
  assert.equal(read(0, 'grossPnl')?.value, completed.grossPnl?.amount ?? null);
  assert.equal(read(1, 'netPnl')?.value, pending.netPnl?.amount ?? null);
  assert.equal(output.sections[0].fields.find(item => item.key === 'accountingCompleteness')?.value, null);
});

test('missing evaluator and lifecycle cap remain explicit with no inferred status or oversized field arrays', async () => {
  const original = deps();
  const many = Array.from({ length: 21 }, (_, index) => ({ instrument_id: 'pko_wse', conid: '35146360',
    original_proposal_id: index + 1, status: 'HOLD', observed_at: now, exit_deadline: now, terminal_proof_recorded: false }));
  const configured = deps({ pool: { query: async (sql: string, params: unknown[]) => sql.includes('FROM lifecycle_supervision')
    ? { rows: many } : original.pool.query(sql, params) } as DiagnosticReadModelDeps['pool'],
    configuration: () => ({ configHash: 'hash', instruments: [{ ...original.configuration().instruments[0],
      instances: Array.from({ length: 250 }, (_, index) => ({ implementationId: 'strategy', instanceId: `instance-${index}`,
        revision: 1, enabled: true })) }] }) });
  const output = report();
  await appendDiagnosticStatus(configured, query, output);
  assert.equal(output.sections.filter(section => section.id.startsWith('lifecycle:')).length, 20);
  assert.equal(output.truncated, true);
  assert.ok(output.omissions.includes('lifecycle_supervision:STATUS_LIFECYCLE_LIMIT'));
  assert.ok(output.omissions.includes('instrument:pko_wse:INSTANCE_FIELD_LIMIT'));
  assert.ok(output.sections.every(section => section.fields.length <= 200));
  assert.ok(output.sections.filter(section => section.id.startsWith('lifecycle:')).every(section =>
    section.fields.find(item => item.key === 'roundTripStatus')?.value === null));
  assert.ok(output.coverage.some(item => item.source === 'lifecycle_supervision' && item.status === 'PARTIAL'));
});

test('foreign evaluator result cannot populate an account lifecycle section', async () => {
  const original = deps();
  const source = roundTripFixture();
  const evaluated = evaluateRoundTrip(source.evidence, source.context);
  const configured = deps({ pool: { query: async (sql: string, params: unknown[]) => sql.includes('FROM lifecycle_supervision')
    ? { rows: [{ instrument_id: 'pko_wse', conid: '35146360', original_proposal_id: 41, status: 'HOLD', observed_at: now }] }
    : original.pool.query(sql, params) } as DiagnosticReadModelDeps['pool'],
    roundTrip: async () => ({ ...evaluated, accountId: 'OTHER', proposalId: 41, instrumentId: 'pko_wse', conid: '35146360' }) });
  const output = report();
  await appendDiagnosticStatus(configured, query, output);
  const section = output.sections.find(item => item.id === 'lifecycle:41')!;
  assert.equal(section.fields.find(item => item.key === 'roundTripStatus')?.value, null);
  assert.equal(section.fields.find(item => item.key === 'accounting')?.value, null);
  assert.ok(output.coverage.some(item => item.source === 'round_trip:41' && item.status === 'UNAVAILABLE' &&
    item.reasons.includes('ROUND_TRIP_IDENTITY_MISMATCH')));
});
