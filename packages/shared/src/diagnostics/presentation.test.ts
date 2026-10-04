import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDiagnosticEvents, describeDiagnosticReason, formatDiagnosticEvent, formatDiagnosticReport } from './presentation.js';
import { EMPTY_DIAGNOSTIC_IDENTITY, type DiagnosticEvent, type DiagnosticReport } from './types.js';

function event(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return { schemaVersion: 1, id: 'event-1', code: 'EVAL_RESULT', severity: 'INFO', service: 'signal-engine',
    occurredAt: '2026-03-29T00:30:00.000Z', recordedAt: '2026-03-29T00:30:01.000Z', reason: 'NO_SIGNAL',
    message: 'Brak sygnału.', impact: 'Nie powstała propozycja.', action: 'Sprawdź kolejną ocenę.', auditRef: null,
    ...EMPTY_DIAGNOSTIC_IDENTITY, fields: [], ...overrides };
}
function report(overrides: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return { schemaVersion: 1, mode: 'session', generatedAt: '2026-03-29T00:30:00.000Z',
    interval: { from: '2026-03-28T00:00:00.000Z', to: '2026-03-29T00:00:00.000Z' }, coverage: [], events: [],
    sections: [], counters: [], truncated: false, omissions: [], ...overrides };
}

test('reason mapping distinguishes no signal, rejection, pause, closed market, stale and unknown', () => {
  assert.match(describeDiagnosticReason('NO_SIGNAL').message, /nie wygenerowała sygnału/);
  assert.match(describeDiagnosticReason('REJECTED').message, /odrzucona/);
  assert.match(describeDiagnosticReason('ENTRY_PAUSED').message, /wstrzymane/);
  assert.match(describeDiagnosticReason('MARKET_CLOSED').message, /zamknięty/);
  assert.match(describeDiagnosticReason('STALE_DATA').message, /nieaktualne/);
  const unknown = describeDiagnosticReason('FUTURE_REASON');
  assert.match(unknown.message, /FUTURE_REASON/);
  assert.match(unknown.action, /Sprawdź kod/);
});

test('event formatter keeps source code, identifiers and status distinctions, with terminal escaping and explicit DST offset', () => {
  const text = formatDiagnosticEvent(event({ symbol: 'PKO\u001b[31m\nX', listing: 'WSE', code: 'ORDER_SUBMITTED', reason: 'SUBMITTED',
    message: 'Wysłano\u202e zlecenie', proposalId: '77', configHash: 'hash-a', fields: [{ key: 'quoteAge', label: 'Wiek\nnotowania', value: null }] }));
  assert.match(text, /PKO X\/WSE/);
  assert.match(text, /UTC\+01:00/);
  assert.match(text, /ORDER_SUBMITTED/);
  assert.match(text, /wysłano zlecenie|Wysłano zlecenie/);
  assert.match(text, /wpływ: Nie powstała propozycja\./);
  assert.match(text, /działanie: Sprawdź kolejną ocenę\./);
  assert.doesNotMatch(text, /Wysłanie nie potwierdza realizacji/);
  assert.match(text, /propozycja=77/);
  assert.match(text, /brak danych/);
  assert.doesNotMatch(text, /\u001b|\u202e|\nX/);
  const winter = formatDiagnosticEvent(event({ occurredAt: '2026-10-25T01:30:00Z' }));
  assert.match(winter, /UTC\+01:00/);
});

test('report makes coverage gaps and absent financial facts visible without inferring zero or P&L', () => {
  const text = formatDiagnosticReport(report({ coverage: [{ source: 'market-data', status: 'PARTIAL', observedAt: null,
    earliestAvailableAt: null, reasons: ['brak heartbeat'] }], counters: [{ key: 'fills', label: 'Realizacje', value: null },
      { key: 'pnl', label: 'P&L', value: null }], sections: [{ id: 'PKO', title: 'Stan instrumentu', instrumentId: 'pko_wse',
      fields: [{ key: 'fees', label: 'Opłaty', value: null }, { key: 'currency', label: 'Waluta P&L', value: null }] }],
    events: [event({ symbol: 'PKO', listing: 'WSE', implementationId: 'momentum_breakout_long_v1', instanceId: 'pko-momo',
      researchSnapshotId: 'research-1' })], truncated: true, omissions: ['część zakresu'] }));
  assert.match(text, /PARTIAL/);
  assert.match(text, /częściowe \(PARTIAL\)/);
  assert.match(text, /brak danych/);
  assert.match(text, /P&L: brak danych/);
  assert.match(text, /research-1/);
  assert.match(text, /ucięty/);
  assert.match(text, /Pominięto: część zakresu/);
});

test('formats PKO, AAPL and an independent third fixture using the same generic contract', () => {
  for (const [symbol, listing] of [['PKO', 'WSE'], ['AAPL', 'NASDAQ'], ['FIXTURE', 'XTEST']]) {
    const text = formatDiagnosticEvent(event({ symbol, listing, instrumentId: `fixture_${symbol.toLowerCase()}` }));
    assert.match(text, new RegExp(`${symbol}\\/${listing}`));
    assert.match(text, /NO_SIGNAL/);
  }
});

test('compacts adjacent equivalent states, de-duplicates identical IDs and preserves conflicting versions and critical events', () => {
  const a = event({ id: 'same', occurredAt: '2026-03-29T00:00:00Z' });
  const duplicate = { ...a };
  const b = event({ id: 'next', occurredAt: '2026-03-29T00:01:00Z' });
  const critical = event({ id: 'fault', severity: 'CRITICAL', reason: 'ERROR', occurredAt: '2026-03-29T00:02:00Z' });
  const conflict = event({ id: 'same', message: 'Inna wersja', occurredAt: '2026-03-29T00:03:00Z' });
  const result = compactDiagnosticEvents([b, critical, duplicate, conflict, a]);
  assert.deepEqual(result.duplicateConflicts, ['same']);
  assert.equal(result.events.length, 4);
  assert.equal(result.events[0]?.count, 1);
  assert.equal(result.events[1]?.id, 'next');
  assert.equal(result.events[2]?.severity, 'CRITICAL');
  assert.match(result.events[3]?.id ?? '', /wersja 2\/2/);
  const compacted = compactDiagnosticEvents([a, b]);
  assert.equal(compacted.events[0]?.count, 2);
  assert.equal(compacted.events[0]?.firstOccurredAt, '2026-03-29T00:00:00Z');
  assert.equal(compacted.events[0]?.lastOccurredAt, '2026-03-29T00:01:00Z');
});

test('compaction groups distinct no-signal evaluations but retains every source reference and detail boundary', () => {
  const first = event({ id: 'event-a', evaluationId: 'eval-a', traceId: 'trace-a', auditRef: '/execution/audit/a',
    occurredAt: '2026-03-29T00:00:00Z' });
  const second = event({ id: 'event-b', evaluationId: 'eval-b', traceId: 'trace-b', auditRef: '/execution/audit/b',
    occurredAt: '2026-03-29T00:01:00Z' });
  const changed = event({ id: 'event-c', evaluationId: 'eval-c', auditRef: '/execution/audit/c',
    occurredAt: '2026-03-29T00:02:00Z', fields: [{ key: 'why', label: 'Powód szczegółowy', value: 'inna przesłanka' }] });
  const resolution = event({ id: 'event-d', code: 'FEED_RECOVERED', reason: 'FEED_RECOVERED',
    occurredAt: '2026-03-29T00:03:00Z' });
  const resolvedAgain = event({ ...resolution, id: 'event-e', occurredAt: '2026-03-29T00:04:00Z' });
  const result = compactDiagnosticEvents([resolvedAgain, changed, second, first, resolution]);
  assert.equal(result.events.length, 4);
  assert.deepEqual(result.events[0]?.sourceEventIds, ['event-a', 'event-b']);
  assert.deepEqual(result.events[0]?.evaluationIds, ['eval-a', 'eval-b']);
  assert.deepEqual(result.events[0]?.auditRefs, ['/execution/audit/a', '/execution/audit/b']);
  assert.equal(result.events[0]?.count, 2);
  assert.equal(result.events[0]?.firstOccurredAt, '2026-03-29T00:00:00Z');
  assert.equal(result.events[0]?.lastOccurredAt, '2026-03-29T00:01:00Z');
  assert.match(formatDiagnosticEvent(result.events[0]!), /Zdarzenia źródłowe: event-a, event-b/);
  assert.equal(result.events[1]?.count, 1);
  assert.equal(result.events[2]?.count, 1);
  assert.equal(result.events[3]?.count, 1);
});

test('error severity is never compacted away', () => {
  const first = event({ id: 'e1', severity: 'ERROR' });
  const second = event({ id: 'e2', severity: 'ERROR', occurredAt: '2026-03-29T00:31:00Z' });
  assert.equal(compactDiagnosticEvents([first, second]).events.length, 2);
});
