import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendLiveSupervision } from './operator-cli.js';
import type { DiagnosticReport } from '@ikbr/shared/diagnostics';

const report = (): DiagnosticReport => ({ schemaVersion: 1, mode: 'status', generatedAt: '2026-10-18T00:00:00.000Z',
  interval: { from: '2026-10-18T00:00:00.000Z', to: '2026-10-18T00:00:00.000Z' }, coverage: [], events: [], sections: [], counters: [], truncated: false, omissions: [] });
const projection = (state: string) => ({ enabled: true, episodeId: 'episode-1', state, attemptCount: 1, attemptLimit: 3,
  nextAttemptAt: null, firstErrorAt: '2026-10-18T00:00:00Z', lastError: 'ACCOUNTING_CLOCK_INVALID', receiptId: null,
  captureId: null, entryBlocked: true });
const fields = (input: unknown) => appendLiveSupervision(report(), input).sections[0].fields;
const field = (input: unknown, key: string) => fields(input).find(item => item.key === key)?.value;

test('missing clock recovery projection stays unavailable', () => {
  assert.equal(field({ observer: { healthy: true } }, 'clockRecoveryEnabled'), null);
  assert.equal(field({ accounting: { automaticClockRecovery: { ...projection('WAITING'), state: 'BROKEN' } } }, 'clockRecoveryState'), null);
});

test('waiting and recovered are presented as diagnostic states, never readiness', () => {
  const waiting = { accounting: { automaticClockRecovery: projection('WAITING') } };
  assert.equal(field(waiting, 'clockRecoveryState'), 'oczekuje na próbę');
  assert.equal(field(waiting, 'clockRecoveryAttempt'), '1/3');
  const recovered = { accounting: { automaticClockRecovery: { ...projection('RECOVERED'), entryBlocked: false, captureId: 'capture-1' } } };
  assert.equal(field(recovered, 'clockRecoveryState'), 'odzyskano rozliczenia; gotowość niepotwierdzona');
  assert.equal(field(recovered, 'clockRecoveryEntryBlocked'), false);
  assert.equal(field(recovered, 'clockRecoveryCaptureId'), 'capture-1');
});

test('terminal states render and untrusted values are bounded and sanitized', () => {
  const terminal = { accounting: { automaticClockRecovery: { ...projection('OPERATOR_REQUIRED'), episodeId: 'DU123456\nsecret', lastError: 'x'.repeat(1000) } } };
  assert.equal(field(terminal, 'clockRecoveryState'), 'wymaga operatora');
  assert.equal(field(terminal, 'clockRecoveryEpisodeId'), '[KONTO]\\u000asecret');
  assert.equal(String(field(terminal, 'clockRecoveryLastError')).length, 160);
  const hostile = { accounting: { automaticClockRecovery: { ...projection('WAITING'), state: 'RECOVERED\nready', attemptCount: 99 } } };
  assert.equal(field(hostile, 'clockRecoveryState'), null);
  assert.equal(field(hostile, 'clockRecoveryAttempt'), null);
});

test('continuous clock recovery presents cumulative attempts without an operator retry quota', () => {
  const wrap = (attemptCount: unknown, attemptLimit: unknown) => ({ accounting: { automaticClockRecovery: {
    ...projection('BACKOFF'), attemptCount, attemptLimit,
  } } });
  assert.equal(field(wrap(14, null), 'clockRecoveryAttempt'), '14 (ponawianie automatyczne)');
  assert.equal(field(wrap(14, null), 'clockRecoveryEntryBlocked'), true);
  for (const count of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '14']) {
    assert.equal(field(wrap(count, null), 'clockRecoveryAttempt'), null);
  }
  assert.equal(field(wrap(14, 3), 'clockRecoveryAttempt'), null);
  assert.equal(field(wrap(14, undefined), 'clockRecoveryAttempt'), null);
});


test('clock evidence and original cause are bounded; absent values remain unavailable', () => {
  const input={accounting:{automaticClockRecovery:{...projection('BACKOFF'),originalCause:{name:'Error',code:'503',message:'x'.repeat(1000)},
    rejectedClock:{requestedAt:'2026-10-18T00:00:00Z',receivedAt:'2026-10-18T00:00:01Z',reportedSeconds:'100',skewMs:3000}}}};
  assert.equal(field(input,'clockRecoveryCauseCode'),'503');
  assert.equal(String(field(input,'clockRecoveryCauseMessage')).length,160);
  assert.equal(field(input,'clockRecoveryClockSkewMs'),3000);
  assert.equal(field({accounting:{automaticClockRecovery:projection('WAITING')}},'clockRecoveryCauseMessage'),null);
});
