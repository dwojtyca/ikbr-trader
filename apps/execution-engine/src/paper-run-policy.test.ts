import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePaperRunPolicy, paperLocalDate, validatePaperPolicyTransition } from './paper-run-policy.js';
import { paperPolicyFixture } from './paper-run-policy.fixture.js';
test('strict generic manifest resolves three stocks, freezes caps/windows, and has stable canonical identity', () => {
  const f = paperPolicyFixture();
  assert.equal(parsePaperRunPolicy({}, f.loaded), undefined);
  assert.equal(f.policy.windows.length, 3);
  assert.ok(Object.isFrozen(f.policy)); assert.ok(Object.isFrozen(f.policy.windows)); assert.ok(Object.isFrozen(f.policy.currencyCaps.USD));
  const reversed = { ...f.manifest, windows: [...f.manifest.windows].reverse() };
  assert.equal(parsePaperRunPolicy({ ...f.env, PAPER_RUN_POLICY_JSON: reversed }, f.loaded)?.manifestHash, f.policy.manifestHash);
});
for (const [name, change] of Object.entries({
  unknown: (m: Record<string, unknown>) => { m.extra = true; },
  coercion: (m: Record<string, unknown>) => { m.maxAttemptsPerAccountDay = '1'; },
  timezone: (m: Record<string, unknown>) => { m.accountDayTimeZone = 'America/New_York'; },
  hash: (m: Record<string, unknown>) => { m.effectiveConfigHash = '0'.repeat(64); },
  version: (m: Record<string, unknown>) => { m.version = 2; },
  cap: (m: Record<string, unknown>) => { m.currencyCaps = { USD: { maxNotional: 1, maxStopRisk: 1, feeReserve: 1, maxDailyLoss: NaN } }; },
  unconfigured: (m: Record<string, unknown>) => { m.windows = [{ instrumentId: 'unknown', conId: 1, startsAt: '2026-09-28T14:00:00Z', endsAt: '2026-09-28T14:30:00Z' }]; },
})) test(`manifest rejects ${name}`, () => {
  const f = paperPolicyFixture(); change(f.manifest); assert.throws(() => parsePaperRunPolicy({ ...f.env, PAPER_RUN_POLICY_JSON: f.manifest }, f.loaded));
});
test('manifest rejects live, legacy authority, duplicate conIds and scheduled production', () => {
  const f = paperPolicyFixture();
  assert.throws(() => parsePaperRunPolicy({ ...f.env, IBKR_ENVIRONMENT: 'live' }, f.loaded), /PAPER_REQUIRED/);
  assert.throws(() => parsePaperRunPolicy({ ...f.env, GPW_RUN_ID: 'other' }, f.loaded), /AUTHORITY_CONFLICT/);
  assert.throws(() => parsePaperRunPolicy({ ...f.env, PAPER_RUN_POLICY_JSON: { ...f.manifest, windows: [f.manifest.windows[0], f.manifest.windows[0]] } }, f.loaded), /DUPLICATE/);
  assert.throws(() => parsePaperRunPolicy({ ...f.env, PAPER_RUN_POLICY_JSON: { ...f.manifest, kind: 'bounded_scheduled' } }, f.loaded), /PP5_LIFECYCLE_REQUIRED/);
});
test('ISO offset validation, maximum duration and distinct Warsaw/New York dates survive DST', () => {
  for (const [start, end] of [['2026-02-30T14:00:00Z','2026-02-30T14:30:00Z'],['2026-09-28T14:00:00','2026-09-28T14:30:00Z'],['2026-09-28T14:00:00Z','2026-09-28T15:00:00.001Z'],['2026-09-28T21:59:00Z','2026-09-28T22:01:00Z']]) assert.throws(() => paperPolicyFixture(start,end));
  for (const [stamp, warsaw, ny] of [['2026-03-20T23:30:00Z','2026-03-21','2026-03-20'],['2026-10-28T23:30:00Z','2026-10-29','2026-10-28'],['2026-03-29T01:30:00Z','2026-03-29','2026-03-28']]) {
    assert.equal(paperLocalDate(Date.parse(stamp), 'Europe/Warsaw'), warsaw); assert.equal(paperLocalDate(Date.parse(stamp), 'America/New_York'), ny);
  }
});
test('future schedule transition cannot relax a used supervised day and rollback retains every attempt', () => {
  const state = { priorKind: 'supervised_one_attempt' as const, nextKind: 'bounded_scheduled' as const, accountDayTimeZone: 'Europe/Warsaw', currentAccountDate: '2026-09-28', effectiveAccountDate: '2026-09-28', consumedAttempts: 1, reconciledFlat: true, unresolvedReservations: false };
  assert.deepEqual(validatePaperPolicyTransition(state), { ok: false, reason: 'PAPER_RUN_TRANSITION_REQUIRES_SUBSEQUENT_DAY', retainedAttempts: 1 });
  assert.deepEqual(validatePaperPolicyTransition({ ...state, effectiveAccountDate: '2026-09-29' }), { ok: false, reason: 'PP5_LIFECYCLE_REQUIRED', retainedAttempts: 1 });
  assert.deepEqual(validatePaperPolicyTransition({ ...state, priorKind: 'bounded_scheduled', nextKind: 'supervised_one_attempt', consumedAttempts: 2 }), { ok: true, retainedAttempts: 2 });
});
