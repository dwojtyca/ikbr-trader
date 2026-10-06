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
  assert.throws(() => parsePaperRunPolicy({ ...f.env, PAPER_RUN_POLICY_JSON: { ...f.manifest, kind: 'bounded_scheduled' } }, f.loaded), /UNSUPPORTED_POLICY/);
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
  assert.deepEqual(validatePaperPolicyTransition({ ...state, effectiveAccountDate: '2026-09-29' }), { ok: true, retainedAttempts: 1 });
  assert.deepEqual(validatePaperPolicyTransition({ ...state, priorKind: 'bounded_scheduled', nextKind: 'supervised_one_attempt', consumedAttempts: 2 }), { ok: true, retainedAttempts: 2 });
});

function scheduled(startsAt = '2026-10-05T14:00:00Z', endsAt = '2026-10-05T14:30:00Z') {
  const f = paperPolicyFixture(startsAt, endsAt, true);
  const manifest = { ...f.manifest, version: 2, kind: 'bounded_scheduled', maxAttemptsPerAccountDay: 2,
    effectiveAccountDate: '2026-10-05', expiresAfterAccountDate: '2026-10-09' };
  return { ...f, manifest, parse: (value: unknown = manifest) => parsePaperRunPolicy({ ...f.env, PAPER_RUN_POLICY_JSON: value }, f.loaded)! };
}
test('v2 explicit multi-session authority canonicalizes independently of window order and retains supervised cap', () => {
  const f = scheduled();
  const next = f.manifest.windows.map(w => ({ ...w, startsAt: '2026-10-06T14:00:00Z', endsAt: '2026-10-06T14:30:00Z' }));
  const first = f.parse({ ...f.manifest, windows: [...f.manifest.windows, ...next] });
  assert.equal(first.version, 2); assert.equal(first.maxAttemptsPerAccountDay, 2); assert.equal(first.windows.length, 6);
  assert.equal(first.manifestHash, f.parse({ ...f.manifest, windows: [...next, ...f.manifest.windows].reverse() }).manifestHash);
  assert.equal(f.policy.kind, 'supervised_one_attempt'); assert.equal(f.policy.maxAttemptsPerAccountDay, 1);
});
test('v2 rejects incompatible bundle, duplicate contract days, unbounded/invalid dates and implicit wider windows', () => {
  const f = scheduled();
  for (const patch of [
    { effectiveAccountDate: '2026-02-30' }, { expiresAfterAccountDate: '2026-10-04' }, { effectiveAccountDate: '2026-10-06' },
    { maxAttemptsPerAccountDay: 3 }, { maxAttemptsPerInstrumentDay: 2 }, { windows: [...f.manifest.windows, f.manifest.windows[0]] },
    { windows: f.manifest.windows.map(w => ({ ...w, endsAt: '2026-10-05T15:00:00.001Z' })) },
    { windows: f.manifest.windows.map(w => ({ ...w, startsAt: '2026-10-05T21:59:00Z', endsAt: '2026-10-05T22:01:00Z' })) },
  ]) assert.throws(() => f.parse({ ...f.manifest, ...patch }));
  const old = paperPolicyFixture();
  assert.throws(() => parsePaperRunPolicy({ ...old.env, PAPER_RUN_POLICY_JSON: { ...f.manifest, effectiveConfigHash: old.loaded.effectiveHash } }, old.loaded), /CONFIGURATION_POLICY_INCOMPATIBLE/);
});
test('v2 requires different Warsaw and instrument dates across DST boundaries', () => {
  const f = scheduled('2026-10-28T23:00:00Z', '2026-10-28T23:30:00Z');
  const us = f.manifest.windows.find(w => w.instrumentId === 'aapl_smart')!;
  const base = { ...f.manifest, effectiveAccountDate: '2026-10-28', expiresAfterAccountDate: '2026-10-30', currencyCaps: { USD: f.manifest.currencyCaps.USD }, windows: [us] };
  const result = f.parse(base);
  assert.equal(result.windows[0].accountDate, '2026-10-29'); assert.equal(result.windows[0].sessionDate, '2026-10-28');
  assert.throws(() => f.parse({ ...base, windows: [us, { ...us, startsAt: '2026-10-29T01:00:00Z', endsAt: '2026-10-29T01:30:00Z' }] }), /DUPLICATE/);
});
