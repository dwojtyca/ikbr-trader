import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { formatDiagnosticReport, redactDiagnosticExport, type DiagnosticReport } from '@ikbr/shared/diagnostics';
import { researchFixture } from '@ikbr/shared/instrument-research-testfixture';
import { researchHash } from '@ikbr/shared/instrument-research';
import { runMigrations } from '../migrations.js';
import { createDiagnosticReadModel } from './read-model.js';
import { registerDiagnosticRoutes } from './routes.js';
import { fixture as lifecycleFixture } from '../lifecycle/close-test-fixture.js';
import { evaluateLifecycleOwnership } from '../lifecycle/ownership.js';
import { evaluateRoundTrip } from '../lifecycle/round-trip-evidence.js';

const isolatedUrl = process.env.TEST_POSTGRES_URL;
const accountId = 'DU1234567';

async function withDatabase(run: (pool: Pool) => Promise<void>): Promise<void> {
  const adminUrl = new URL(isolatedUrl!);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const database = `pp6_acceptance_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const testUrl = new URL(isolatedUrl!);
  testUrl.pathname = `/${database}`;
  const pool = new Pool({ connectionString: testUrl.toString() });
  try { await runMigrations(pool); await run(pool); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); }
}

test('UI-off operator walkthrough reads five operations from stored evidence without treating gaps as ready', { skip: !isolatedUrl }, async () => {
  await withDatabase(async pool => {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const from = new Date(nowMs - 3_600_000).toISOString();
    const occurred = new Date(nowMs - 600_000).toISOString();
    const fixture = researchFixture(nowMs, 'pko_wse');
    const instruments = fixture.config.instruments.filter(item => item.entryEnabled);
    assert.deepEqual(instruments.map(item => item.id), ['pko_wse', 'aapl_smart', 'xyz_nyse']);
    await pool.query(`INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json)
      VALUES($1,1,1,$2)`, [fixture.configHash, JSON.stringify(fixture.config)]);
    await pool.query(`INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,$3)`,
      [fixture.manifestHash, fixture.configHash, JSON.stringify(fixture.manifest)]);
    await pool.query(`INSERT INTO research_authority(config_hash,manifest_hash) VALUES($1,$2)`, [fixture.configHash, fixture.manifestHash]);
    const snapshotId = randomUUID();
    await pool.query(`INSERT INTO research_snapshots(id,snapshot_hash,config_hash,manifest_hash,instrument_id,sequence,canonical_json,stored_at)
      VALUES($1,$2,$3,$4,'pko_wse',1,$5,$6)`,
      [snapshotId, researchHash(fixture.snapshot), fixture.configHash, fixture.manifestHash, JSON.stringify(fixture.snapshot), occurred]);
    await pool.query(`INSERT INTO research_snapshot_heads(config_hash,manifest_hash,instrument_id,snapshot_id,sequence)
      VALUES($1,$2,'pko_wse',$3,1)`, [fixture.configHash, fixture.manifestHash, snapshotId]);
    await pool.query(`INSERT INTO diagnostic_process_heartbeats(process_id,account_id,started_at,last_seen_at,expected_interval_ms,enabled)
      VALUES('fixture-process',$1,$2,$3,300000,true)`, [accountId, from, occurred]);
    const reasons = [
      ['pko_wse', 'NO_SIGNAL', 'CONFIGURED_EVALUATION'],
      ['pko_wse', 'ENTRY_PAUSED', 'SKIPPED'],
      ['aapl_smart', 'AI_REJECT', 'SKIPPED'],
      ['aapl_smart', 'MARKET_CLOSED', 'SKIPPED'],
      ['xyz_nyse', 'STALE_DATA', 'SKIPPED'],
      ['xyz_nyse', 'SUBMISSION_UNKNOWN', 'UNKNOWN'],
    ] as const;
    const evaluationIds: string[] = [];
    for (const [instrumentId, reason, outcome] of reasons) {
      const instrument = instruments.find(item => item.id === instrumentId)!;
      const cycleId = randomUUID();
      evaluationIds.push(cycleId);
      await pool.query(`INSERT INTO diagnostic_evaluations(account_id,process_id,cycle_id,instrument_id,occurred_at,outcome,reason,
        reasons,entry_blockers,assigned_instances,config_hash,conid,symbol,listing,evaluation_id)
        VALUES($1,'fixture-process',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [accountId, cycleId, instrumentId, occurred, outcome, reason,
          JSON.stringify(reason === 'NO_SIGNAL' ? [reason, 'token=provider-fixture-secret'] : [reason]),
          JSON.stringify(reason === 'NO_SIGNAL' ? [reason, 'Bearer provider-fixture-secret'] : [reason]),
          JSON.stringify([{ implementationId: 'momentum_breakout_long_v1', instanceId: `${instrumentId}-one`, revision: 1 }]),
          fixture.configHash, String(instrument.contract.conId), instrument.contract.symbol, instrument.contract.exchange, cycleId]);
    }
    const recon = await pool.query(`INSERT INTO reconciliation_runs(account_id,session_id,status,completed_at,snapshot_complete)
      VALUES($1,'fixture-session','MISMATCH',$2,false) RETURNING id`, [accountId, occurred]);
    await pool.query(`INSERT INTO reconciliation_holds(account_id,instrument,conid,identity_key,reason,severity,reconciliation_run_id,created_at)
      VALUES($1,'PKO',$2,$3,'unknown_submission','critical',$4,$5),
        ($1,'OTHER','999',$6,'other_exposure','warning',$4,$5)`,
      [accountId, String(instruments[0].contract.conId), `conid:${accountId}|${instruments[0].contract.conId}`,
        recon.rows[0].id, occurred, `conid:${accountId}|999`]);
    await pool.query(`INSERT INTO lifecycle_faults(account_id,code,first_observed_at,last_observed_at,active,resolved_at)
      VALUES($1,'SUBMISSION_UNKNOWN',$2,$2,true,null),($1,'BROKER_DISCONNECTED',$2,$2,false,$3)`,
      [accountId, occurred, new Date(nowMs - 300_000).toISOString()]);
    await pool.query(`INSERT INTO execution_entry_controls(account_id,paused) VALUES($1,true)`, [accountId]);
    await pool.query(`INSERT INTO lifecycle_observer_health(account_id,session_id,observed_at,healthy,reason)
      VALUES($1,'fixture-session',$2,false,'fixture_unhealthy')`, [accountId, occurred]);

    const model = createDiagnosticReadModel({ pool, currentAccountId: () => accountId,
      currentSessionId: () => 'fixture-session',
      configuration: () => ({ configHash: fixture.configHash, instruments: instruments.map(item => ({
        id: item.id, symbol: item.contract.symbol, listing: item.contract.exchange, conId: String(item.contract.conId),
        implementationId: null, instanceId: null, revision: null, entryEnabled: item.entryEnabled,
        monitoringEnabled: item.monitoringEnabled })) }),
      runtimeControls: () => ({ tradingEnabled: false, entriesPaused: true, automationEnabled: false }),
      readWatchlist: async () => ({ connected: false, watchlist: [] }),
    });
    const app = Fastify();
    registerDiagnosticRoutes(app, { token: 'fixture-only-token', read: model.read, privacy: () => ({ accountIds: [accountId] }), now: () => nowMs });
    const get = async (mode: string, extra = ''): Promise<DiagnosticReport> => {
      const response = await app.inject({ url: `/execution/diagnostics?mode=${mode}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(now)}${extra}`,
        headers: { authorization: 'Bearer fixture-only-token' } });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json() as DiagnosticReport;
      const sources = mode === 'timeline' ? ['diagnostic_evaluations', 'proposed_orders', 'proposal_ai_reviews'] :
        ['diagnostic_evaluations', 'proposed_orders', 'proposal_ai_reviews', 'reconciliation_holds', 'lifecycle_faults'];
      for (const source of sources)
        assert.ok(result.coverage.some(item => item.source === source && item.status !== 'UNAVAILABLE'), `${mode}: ${source} read failed`);
      return result;
    };
    try {
      const events = await get('events');
      for (const reason of reasons.map(row => row[1])) assert.ok(events.events.some(event => event.reason === reason), reason);
      assert.ok(events.events.some(event => event.code === 'FAULT_RESOLVED'));
      assert.ok(events.events.some(event => event.code === 'SUBMISSION_UNKNOWN' && event.severity === 'CRITICAL'));
      assert.ok(events.events.some(event => event.code === 'RECONCILIATION_HOLD' && event.instrumentId === 'pko_wse'));
      const eventText = formatDiagnosticReport(events);
      assert.match(eventText, /nie wygenerowała sygnału|Brak sygnału/);
      assert.match(eventText, /Wynik wysłania zlecenia jest nieznany/);
      assert.doesNotMatch(eventText, /DU1234567|\{"/);
      assert.doesNotMatch(JSON.stringify(events), /provider-fixture-secret/);

      const status = await get('status');
      for (const source of ['execution_entry_controls', 'lifecycle_observer_health', 'reconciliation_runs',
        'instrument_session_schedules', 'research_current', 'candles_1m', 'candles_5m', 'candles_1h',
        'candles_4h', 'candles_1d', 'candles_1w'])
        assert.ok(status.coverage.some(item => item.source === source && item.status !== 'UNAVAILABLE'), `status: ${source} read failed`);
      for (const instrument of instruments) assert.ok(status.sections.some(section => section.instrumentId === instrument.id));
      const pko = status.sections.find(section => section.id === 'instrument:pko_wse')!;
      assert.equal(pko.fields.find(field => field.key === 'tradingEnabled')?.value, false);
      assert.equal(pko.fields.find(field => field.key === 'entryPaused')?.value, true);
      assert.equal(pko.fields.find(field => field.key === 'activeHoldCount')?.value, 1);
      assert.equal(pko.fields.find(field => field.key === 'accountActiveHoldCount')?.value, 2);
      assert.equal(pko.fields.find(field => field.key === 'brokerStatus')?.value, null);
      assert.equal(pko.fields.find(field => field.key === 'accountingCompleteness')?.value, null);
      assert.equal(pko.fields.find(field => field.key === 'researchSnapshotId')?.value, snapshotId);
      assert.match(String(pko.fields.find(field => field.key === 'researchRequiredEvidenceRefs')?.value), /reports/);
      assert.equal(pko.fields.find(field => field.key === 'research:official:reports:status')?.value, 'AVAILABLE');
      assert.equal(pko.fields.find(field => field.key === 'research:official:news:status')?.value, 'EMPTY');
      assert.match(formatDiagnosticReport(status), /Kompletność P&L: brak danych/);

      const timeline = await get('timeline', `&evaluationId=${evaluationIds[0]}`);
      assert.ok(timeline.events.some(event => event.evaluationId === evaluationIds[0]));
      assert.ok(timeline.events.every(event => event.evaluationId === evaluationIds[0] || event.proposalId !== null));
      assert.ok(timeline.events.some(event => event.fields.some(field => field.key === 'entryBlockers' && String(field.value).includes('NO_SIGNAL'))));
      assert.ok(timeline.events.some(event => event.auditRef?.includes(`evaluationId=${evaluationIds[0]}`)));
      const session = await get('session');
      assert.equal(session.counters.find(counter => counter.key === 'evaluations')?.value, reasons.length);
      assert.equal(session.counters.find(counter => counter.key === 'noSignals')?.value, 1);
      assert.equal(session.counters.find(counter => counter.key === 'attempts')?.value, 0);
      assert.equal(session.counters.find(counter => counter.key === 'fills')?.value, 0);
      assert.match(formatDiagnosticReport(session), /Oceny zapisane: 6/);
      const exported = redactDiagnosticExport(events, { accountIds: [accountId] });
      assert.equal(exported.events.length, events.events.length);
      assert.ok(exported.events.every(event => event.auditRef === null));
      assert.doesNotMatch(JSON.stringify(exported), /DU1234567|\/execution\/reconciliation\/holds/);
      assert.match(formatDiagnosticReport(exported), /Pominięto: EXPORT_REDACTED/);
    } finally { await app.close(); }
  });
});

test('manual quantity, orphan protection, and unknown close remain blocked in readable reports', () => {
  for (const scenario of ['changed_quantity', 'orphan_protection', 'unknown_close'] as const) {
    const source = lifecycleFixture();
    if (scenario === 'changed_quantity') source.snapshot.positions[0].position = 2;
    if (scenario === 'orphan_protection') {
      source.snapshot.positions = [];
      source.snapshot.executions.push({ ...source.snapshot.executions[0], brokerOrderId: '101', permId: '1001',
        orderRef: 'test-TP', execId: 'fill-2', side: 'SLD' });
      source.coverage.positions.count = 0;
      source.coverage.executions.count = 2;
    }
    const ownership = evaluateLifecycleOwnership(source.evidence, source.context);
    const close = scenario === 'unknown_close' ? { state: 'SUBMISSION_UNKNOWN', accountId: 'DU_TEST', conid: '123',
      originalHash: source.evidence.clientOrderHash!, closeProposalId: null, links: [] } : null;
    const roundTrip = evaluateRoundTrip({ lifecycle: source.evidence, window: null, close, fills: [] }, source.context);
    assert.equal(roundTrip.status, 'NOT_PROVEN');
    if (scenario !== 'unknown_close') assert.equal(ownership.status, 'BLOCKED');
    const diagnostic: DiagnosticReport = { schemaVersion: 1, mode: 'timeline', generatedAt: new Date(source.context.nowMs).toISOString(),
      interval: { from: new Date(source.context.nowMs - 60_000).toISOString(), to: new Date(source.context.nowMs).toISOString() },
      coverage: [{ source: 'broker_snapshot_fixture', status: 'PARTIAL', observedAt: null, earliestAvailableAt: null,
        reasons: ['MANUAL_INTERVENTION_REQUIRES_RECONCILIATION'] }], events: [], counters: [], truncated: false, omissions: [],
      sections: [{ id: scenario, title: 'Ocena zapisanego cyklu', instrumentId: 'test', fields: [
        { key: 'ownership', label: 'Własność pozycji', value: ownership.status },
        { key: 'roundTrip', label: 'Zamknięcie cyklu', value: roundTrip.status },
        { key: 'reason', label: 'Powód odmowy', value: roundTrip.reasons.join(', '), sensitivity: 'untrusted' },
      ] }] };
    const text = formatDiagnosticReport(diagnostic);
    assert.match(text, /NOT_PROVEN/);
    assert.doesNotMatch(text, /Zamknięcie cyklu: COMPLETED/);
    if (scenario === 'unknown_close') assert.match(text, /close_not_proven/);
  }
});
