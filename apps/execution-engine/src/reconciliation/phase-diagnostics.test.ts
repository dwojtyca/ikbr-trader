import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brokerDiagnosticPrivacy, brokerPhase, emitBrokerPhase, type BrokerPhaseEvent } from './phase-diagnostics.js';

test('phase errors retain original scalar cause with configured privacy and no raw payload', async () => {
  const events: BrokerPhaseEvent[] = [];
  const diagnostics = { emit: (event: BrokerPhaseEvent) => events.push(event), privacy: () => ({ secrets: ['private-value'], accountIds: ['PAPER-ACCOUNT'] }) };
  const error = Object.assign(new Error('PAPER-ACCOUNT private-value DU123456 https://host/path?token=value\nraw'), {
    name: 'SocketFailure', code: 1100, payload: { secret: 'DO-NOT-SERIALIZE' },
  });
  await assert.rejects(brokerPhase(diagnostics, 'clock', { runId: 1, generation: 2 }, async () => { throw error; }), candidate => candidate === error);
  assert.equal(events[0].cause?.name, 'SocketFailure'); assert.equal(events[0].cause?.code, '1100');
  assert.match(events[0].cause!.message!, /\\u000a/);
  assert.doesNotMatch(JSON.stringify(events), /PAPER-ACCOUNT|private-value|DU123456|token=value|DO-NOT-SERIALIZE/);
  emitBrokerPhase(diagnostics, 'clock', 'error', {}, undefined, { payload: error });
  assert.deepEqual(events[1].cause, { name: null, code: null, message: null });
});
test('diagnostic failure cannot alter successful or rejected acquisition', async () => {
  const diagnostics = { emit: () => { throw new Error('sink failed'); } };
  assert.equal(await brokerPhase(diagnostics, 'test', {}, async () => 42), 42);
  const original = new Error('source failed');
  await assert.rejects(brokerPhase(diagnostics, 'test', {}, async () => { throw original; }), candidate => candidate === original);
});
test('production privacy collects configured alert secrets and all account scopes before sanitizing standalone values and URL paths', () => {
  const environment: NodeJS.ProcessEnv = { ALERT_TELEGRAM_BOT_TOKEN: '123456:telegram-private-value', ALERT_TELEGRAM_CHAT_ID: 'chat-private-value',
    MARKETaux_API_KEY: 'marketaux-private-value', EXECUTION_API_TOKEN: 'execution-private-value', POSTGRES_PASSWORD: 'database-private-value',
    OTHER_SECRET: 'other-private-value', PUBLIC_SETTING: 'visible-value', EMPTY_TOKEN: undefined };
  const config = { allowedPaperAccounts: ['PAPER-PRIVATE'], allowedLiveAccounts: ['LIVE-PRIVATE'] };
  const events: BrokerPhaseEvent[] = [];
  const diagnostics = { emit: (event: BrokerPhaseEvent) => events.push(event),
    privacy: () => brokerDiagnosticPrivacy(environment, config, 'ACTIVE-PRIVATE') };
  const secrets = Object.values(environment).filter((value): value is string => !!value && value !== 'visible-value');
  const error = Object.assign(new Error(`${secrets.join(' ')} PAPER-PRIVATE LIVE-PRIVATE ACTIVE-PRIVATE visible-value `
    + `https://api.telegram.org/bot${environment.ALERT_TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${environment.ALERT_TELEGRAM_CHAT_ID}\n`),
  { name: `Failure ${environment.ALERT_TELEGRAM_BOT_TOKEN}`, code: `ERR_${environment.MARKETaux_API_KEY}` });
  emitBrokerPhase(diagnostics, 'capture.total', 'error', { reason: environment.ALERT_TELEGRAM_BOT_TOKEN }, 1, error);
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events);
  for (const privateValue of [...secrets, 'PAPER-PRIVATE', 'LIVE-PRIVATE', 'ACTIVE-PRIVATE']) assert.equal(serialized.includes(privateValue), false, privateValue);
  assert.match(events[0].cause!.message!, /visible-value/);
  assert.match(events[0].cause!.message!, /\\u000a/);
  assert.doesNotMatch(events[0].cause!.message!, /chat_id=/);
  assert.deepEqual(brokerDiagnosticPrivacy({}, config, null).accountIds, ['PAPER-PRIVATE', 'LIVE-PRIVATE']);
});
test('diagnostics emit canonical PostgreSQL run IDs as safe numbers and omit invalid IDs without changing other counters', () => {
  const events: BrokerPhaseEvent[] = [], diagnostics = { emit: (event: BrokerPhaseEvent) => events.push(event) };
  for (const value of [42, '42', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)]) {
    emitBrokerPhase(diagnostics, 'scheduler.capture', 'ok', { runId: value, requestId: 0, generation: 0 });
    assert.equal(events.at(-1)?.runId, Number(value));
    assert.equal(events.at(-1)?.requestId, 0); assert.equal(events.at(-1)?.generation, 0);
  }
  for (const value of [0, -0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '0', '-1', '+42', '042', ' 42', '42 ', '42\n', '4.2e1', '42.0', '', 'no-id', '9007199254740992', '9223372036854775807',
    true, false, null, undefined, {}, ['42'], 42n]) {
    emitBrokerPhase(diagnostics, 'scheduler.capture', 'ok', { runId: value as number, requestId: 0, generation: 0 });
    assert.equal(Object.hasOwn(events.at(-1)!, 'runId'), false);
    assert.equal(events.at(-1)?.requestId, 0); assert.equal(events.at(-1)?.generation, 0);
  }
});
