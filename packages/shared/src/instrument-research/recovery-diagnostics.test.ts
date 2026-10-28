import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryDiagnostic, recoveryDiagnosticFailure, recoveryDiagnosticPrivacy, recoveryFailureOutput,
  formatRecoveryFailure, parseRecoveryDiagnostic } from './recovery-diagnostics.js';

test('recovery diagnostics preserve native, captured plain cause and sourceError originals', () => {
  const original = { name: 'SocketError', code: 'ECONNRESET', message: 'connection reset' };
  for (const error of [Object.assign(new Error(original.message), original), new Error('RESEARCH_RECOVERY_INSPECTION_UNAVAILABLE', { cause: original }),
    Object.assign(new Error('RESEARCH_WSH_FAILED'), { sourceError: original })]) {
    const d = recoveryDiagnostic(error, 'reconnect-connect');
    assert.deepEqual(d.original, original); assert.equal(d.stage, 'reconnect-connect');
    assert.deepEqual(parseRecoveryDiagnostic(JSON.parse(JSON.stringify(d))), d);
  }
  assert.equal(recoveryDiagnostic(new TypeError('bad argument'), 'request').original.name, 'TypeError');
});

test('internal codes and unavailable originals remain separate without inventing native facts', () => {
  const d = recoveryDiagnostic(new Error('RESEARCH_RECOVERY_PROCESS_CHANGED'), 'gateway-replacement');
  assert.equal(d.reason, 'RESEARCH_RECOVERY_PROCESS_CHANGED');
  assert.deepEqual(d.original, { name: null, code: null, message: null });
  assert.match(formatRecoveryFailure(undefined, 'subprocess'), /niedostępny/);
});

test('redaction covers every original field, configured nonnumeric accounts and encoded secrets', () => {
  const secret = 'token/A?b=secret', account = 'DUO_TEST_ACCOUNT';
  const privacy = recoveryDiagnosticPrivacy({ EXECUTION_API_TOKEN: secret, ALLOWED_PAPER_ACCOUNTS: account,
    POSTGRES_URL: 'postgres://user:password@fixture/db', OPENAI_API_KEY: 'fixture-private-key' });
  const originals = [secret, account, encodeURIComponent(secret).replace(/%[A-F\d]{2}/g, x => x.toLowerCase()),
    'Bearer anything-private', 'https://user:pass@fixture.test/path?api_token=private', 'postgres://user:password@fixture/db'];
  for (const value of originals) {
    const d = recoveryDiagnostic(Object.assign(new Error(value), { name: value, code: value }), 'reconnect-connect', privacy);
    const wire = JSON.stringify(recoveryFailureOutput(recoveryDiagnosticFailure(new Error('RESEARCH_RECOVERY_FAILED_OR_UNKNOWN'), 'commit', privacy,
      Object.assign(new Error(value), { name: value, code: value })), 'commit', privacy));
    assert.ok(!wire.includes(value)); assert.ok(!JSON.stringify(d).includes(value));
    assert.ok(parseRecoveryDiagnostic(d));
  }
});

test('unknown objects, getters, cyclic causes and oversized/control fields remain bounded', () => {
  let invoked = 0;
  const malicious = { get message() { invoked++; throw new Error('must not execute'); }, toString() { invoked++; throw new Error('must not execute'); } };
  const cycle = new Error('RESEARCH_RECOVERY_FAILED_OR_UNKNOWN'); cycle.cause = cycle;
  for (const value of [malicious, cycle, Object.assign(new Error('\u0000\u202e' + '😀'.repeat(3000)), { name: 'n'.repeat(200), code: 'c'.repeat(200) })]) {
    const d = recoveryDiagnostic(value, 'subprocess');
    assert.ok(parseRecoveryDiagnostic(d)); assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 4096);
  }
  assert.equal(invoked, 0);
});

test('driver-normalized credential URLs and embedded payload fragments are omitted', () => {
  const privacy = recoveryDiagnosticPrivacy({ POSTGRES_URL: 'postgres://original:secret@fixture/db',
    PROVIDER_URL: 'https://fixture.test/api?api_token=private%2Fprovider-token' });
  for (const message of ['connection to postgresql://original:s%65cret@fixture/db failed',
    'provider rejected {"privatePayload":"do-not-print"}', 'provider rejected ["do-not-print"]']) {
    const d = recoveryDiagnostic(new Error(message), 'subprocess', privacy);
    const output = JSON.stringify(d);
    assert.ok(!output.includes('original:')); assert.ok(!output.includes('s%65cret')); assert.ok(!output.includes('do-not-print'));
    assert.ok(parseRecoveryDiagnostic(d));
  }
  const d = recoveryDiagnostic(Object.assign(new Error('😀'.repeat(500)), { name: '😀'.repeat(50), code: '😀'.repeat(50) }), 'subprocess');
  assert.ok(parseRecoveryDiagnostic(d)); assert.ok(Buffer.byteLength(JSON.stringify(d)) <= 4096);
  for (const exposed of ['original', 'secret', 'private/provider-token', 'private%2Fprovider-token']) {
    const detail = recoveryDiagnostic(new Error(`connection failed with ${exposed}`), 'subprocess', privacy);
    assert.ok(!JSON.stringify(detail.original).includes(exposed));
  }
});

test('diagnostic codec rejects malformed or extra fields instead of forwarding payloads', () => {
  const valid = recoveryDiagnostic(new Error('RESEARCH_WSH_ACCOUNT_MISMATCH'), 'reconnect-connect');
  for (const change of [{ version: 2 }, { stage: 'invented' }, { reason: 'wrong' }, { rawPayload: 'private' },
    { original: { ...valid.original, message: 'x'.repeat(1001) } }, { original: { ...valid.original, code: Infinity } },
    { original: { ...valid.original, message: '\nsecret' } }, { original: { ...valid.original, stack: 'private' } }])
    assert.equal(parseRecoveryDiagnostic({ ...valid, ...change }), null);
  const getter = Object.defineProperty({ ...valid }, 'stage', { enumerable: true, get: () => { throw new Error('getter'); } });
  assert.equal(parseRecoveryDiagnostic(getter), null);
});

test('later formatting preserves primary stage and original while outcome remains unknown', () => {
  const first = recoveryDiagnosticFailure(Object.assign(new Error('original failure'), { code: 'ECONNRESET' }), 'commit');
  const final = recoveryDiagnosticFailure(new Error('RESEARCH_RECOVERY_COMMIT_UNKNOWN'), 'commit-readback', {}, first);
  const wire = recoveryFailureOutput(final, 'arguments');
  assert.equal(wire.reason, 'RESEARCH_RECOVERY_FAILED_OR_UNKNOWN');
  assert.equal(wire.diagnostic.stage, 'commit'); assert.equal(wire.diagnostic.original.code, 'ECONNRESET');
  assert.equal(final.message, 'RESEARCH_RECOVERY_COMMIT_UNKNOWN');
});
