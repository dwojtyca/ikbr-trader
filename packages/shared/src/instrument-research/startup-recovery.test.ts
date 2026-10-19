import assert from 'node:assert/strict';
import test from 'node:test';
import { researchHash } from './validation.js';
import { parseRecoveryEvidence, parseRecoveryIdentity } from './startup-recovery.js';

const h = 'a'.repeat(64);
const uuid = '123e4567-e89b-42d3-a456-426614174000';
const otherUuid = '223e4567-e89b-42d3-a456-426614174000';
const t = (seconds: number) => new Date(Date.parse('2026-10-19T10:00:00.000Z') + seconds * 1000).toISOString();

function marketauxEvidence() {
  return {
    version: 'local-research-recovery-v1', kind: 'MARKETAUX_PRODUCER_QUIESCENCE',
    challengeId: uuid, challengeHash: h, nonce: otherUuid, hostIdHash: h, platform: 'darwin',
    collectorStartedAt: t(0), producerCheckedAt: t(10), producerRecheckedAt: t(20), deploymentHash: h,
    producers: [{ containerId: h, imageId: `sha256:${'b'.repeat(64)}`, project: 'ikbr-trader', service: 'llm-agent', startedAt: t(-30), finishedAt: t(5), state: 'exited' }],
    runningProducerIds: [],
  };
}

function wshEvidence() {
  const endpointId = 'gateway-paper';
  const host = '127.0.0.1'; const port = 4002; const clientId = 19;
  const sessionId = '323e4567-e89b-42d3-a456-426614174000';
  return {
    ...marketauxEvidence(), kind: 'WSH_ENDPOINT_RESET', endpointId,
    endpointSettingsHash: researchHash({ endpointId, host, port, clientId }), host, port, clientId,
    before: { observedAt: t(1), process: { pid: 100, startIdentity: 'old-process-start', executableHash: h } },
    stopped: { observedAt: t(2), processAbsent: true, listenerAbsent: true },
    after: { observedAt: t(3), process: { pid: 101, startIdentity: 'new-process-start', executableHash: h } },
    reconnect: { startedAt: t(4), completedAt: t(5), sessionId, accountId: 'DU123456', serverVersion: 180, sdkVersion: '1.6.10',
      cleanup: { sessionId, state: 'CONFIRMED', verifiedLocalClosure: true, completedAt: t(6), cancellationAttemptedAt: t(5), disconnectRequestedAt: t(5), localClosedAt: t(5) } },
  };
}

function rejectsEvidence(value: unknown, allowQuiescence = false) {
  assert.throws(() => parseRecoveryEvidence(value, ...(allowQuiescence ? [true] as const : [])), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
}

test('parses valid Marketaux producer quiescence and WSH endpoint reset evidence', () => {
  assert.equal(parseRecoveryEvidence(marketauxEvidence()).kind, 'MARKETAUX_PRODUCER_QUIESCENCE');
  assert.equal(parseRecoveryEvidence({ ...marketauxEvidence(), kind: 'PRODUCER_QUIESCENCE' }, true).kind, 'PRODUCER_QUIESCENCE');
  rejectsEvidence({ ...marketauxEvidence(), kind: 'PRODUCER_QUIESCENCE' });
  assert.equal(parseRecoveryEvidence(wshEvidence()).kind, 'WSH_ENDPOINT_RESET');
});

test('requires exact keys, plain data objects, and bounded evidence fields', () => {
  rejectsEvidence({ ...marketauxEvidence(), extra: 'secret' });
  const withSymbol = marketauxEvidence() as Record<PropertyKey, unknown>;
  withSymbol[Symbol('hidden')] = 'x';
  rejectsEvidence(withSymbol);
  rejectsEvidence({ ...marketauxEvidence(), producers: [{ ...marketauxEvidence().producers[0], project: 'x'.repeat(101) }] });
  rejectsEvidence({ ...marketauxEvidence(), producers: [{ ...marketauxEvidence().producers[0], project: 'p'.repeat(100), imageId: `sha256:${'c'.repeat(64)}` }], runningProducerIds: [], padding: 'x'.repeat(33000) });
  rejectsEvidence({ ...marketauxEvidence(), producers: [{ ...marketauxEvidence().producers[0], rawPayload: 'hidden' }] });
  rejectsEvidence({ ...wshEvidence(), before: { ...wshEvidence().before, rawSocket: 'hidden' } });
});

test('rejects malformed UUIDs, hashes, and canonical UTC dates', () => {
  rejectsEvidence({ ...marketauxEvidence(), challengeId: 'not-a-uuid' });
  rejectsEvidence({ ...marketauxEvidence(), nonce: '023e4567-e89b-62d3-a456-426614174000' });
  rejectsEvidence({ ...marketauxEvidence(), challengeHash: 'A'.repeat(64) });
  rejectsEvidence({ ...marketauxEvidence(), deploymentHash: 'bad' });
  rejectsEvidence({ ...marketauxEvidence(), collectorStartedAt: '2026-02-30T10:00:00Z' });
  rejectsEvidence({ ...marketauxEvidence(), producerRecheckedAt: '2026-10-19T10:00:20+00:00' });
  rejectsEvidence({ ...marketauxEvidence(), producerCheckedAt: t(-1) });
  rejectsEvidence({ ...marketauxEvidence(), producerRecheckedAt: t(901) });
  assert.equal(parseRecoveryEvidence({ ...marketauxEvidence(), producerRecheckedAt: t(900) }).kind, 'MARKETAUX_PRODUCER_QUIESCENCE');
});

test('requires a bounded unique stopped-producer inventory', () => {
  const base = marketauxEvidence();
  rejectsEvidence({ ...base, producers: [] });
  rejectsEvidence({ ...base, producers: Array.from({ length: 17 }, (_, i) => ({ ...base.producers[0], containerId: i.toString(16).padStart(64, '0') })) });
  assert.equal(parseRecoveryEvidence({ ...base, producers: Array.from({ length: 16 }, (_, i) => ({ ...base.producers[0], containerId: i.toString(16).padStart(64, '0') })) }).producers.length, 16);
  rejectsEvidence({ ...base, producers: [base.producers[0], base.producers[0]] });
  rejectsEvidence({ ...base, runningProducerIds: ['still-running'] });
  rejectsEvidence({ ...base, producers: [{ ...base.producers[0], state: 'running' }] });
  rejectsEvidence({ ...base, producers: [{ ...base.producers[0], finishedAt: t(11) }] });
  rejectsEvidence({ ...base, producers: [{ ...base.producers[0], startedAt: t(6) }] });
});

test('rejects WSH evidence with invalid chronology, process continuity, or cleanup proof', () => {
  const base = wshEvidence();
  rejectsEvidence({ ...base, stopped: { ...base.stopped, observedAt: base.before.observedAt } });
  rejectsEvidence({ ...base, before: { ...base.before, observedAt: t(-1) } });
  rejectsEvidence({ ...base, after: { ...base.after, observedAt: base.stopped.observedAt } });
  rejectsEvidence({ ...base, after: { ...base.after, observedAt: t(7) } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, startedAt: t(2) } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, completedAt: t(3) } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, cleanup: { ...base.reconnect.cleanup, completedAt: t(4) } } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, cleanup: { ...base.reconnect.cleanup, completedAt: t(21) } } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, cleanup: { ...base.reconnect.cleanup, localClosedAt: t(7) } } });
  rejectsEvidence({ ...base, after: { ...base.after, process: { ...base.after.process, startIdentity: base.before.process.startIdentity } } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, cleanup: { ...base.reconnect.cleanup, sessionId: otherUuid } } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, cleanup: { ...base.reconnect.cleanup, state: 'UNKNOWN' } } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, cleanup: { ...base.reconnect.cleanup, verifiedLocalClosure: false, localClosedAt: null } } });
  rejectsEvidence({ ...base, reconnect: { ...base.reconnect, cleanup: { ...base.reconnect.cleanup, disconnectRequestedAt: null } } });
  rejectsEvidence({ ...base, endpointSettingsHash: h });
  rejectsEvidence({ ...base, port: 4001 });
  rejectsEvidence({ ...base, host: 'broker.example.com' });
});

test('rejects unrecognized raw fields and secret payload fields', () => {
  rejectsEvidence({ ...marketauxEvidence(), providerPayload: { apiKey: 'do-not-accept' } });
  rejectsEvidence({ ...wshEvidence(), reconnect: { ...wshEvidence().reconnect, rawAccountLog: 'account secret' } });
});

test('parses valid recovery identity and rejects malformed or unsafe identity fields', () => {
  const identity = { kind: 'MARKETAUX_PRODUCER_QUIESCENCE', accountId: 'DU123456', instrumentId: 'pko_wse', sourceId: 'news-marketaux', configHash: h, manifestHash: h, pauseRevision: 3, actor: 'operator:local', operationId: uuid };
  assert.deepEqual(parseRecoveryIdentity(identity), identity);
  for (const field of ['operationId', 'configHash', 'manifestHash'] as const) {
    const bad = { ...identity, [field]: 'invalid' };
    assert.throws(() => parseRecoveryIdentity(bad), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  }
  assert.throws(() => parseRecoveryIdentity({ ...identity, sourceId: '' }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  assert.throws(() => parseRecoveryIdentity({ ...identity, sourceId: 'contains\ncontrol' }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  assert.throws(() => parseRecoveryIdentity({ ...identity, actor: 'bad actor' }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  assert.throws(() => parseRecoveryIdentity({ ...identity, accountId: 'DU/123' }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  assert.throws(() => parseRecoveryIdentity({ ...identity, pauseRevision: 0 }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  assert.throws(() => parseRecoveryIdentity({ ...identity, pauseRevision: 1.5 }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  assert.throws(() => parseRecoveryIdentity({ ...identity, kind: 'OTHER' }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
  assert.throws(() => parseRecoveryIdentity({ ...identity, extra: 'x' }), /RESEARCH_RECOVERY_EVIDENCE_INVALID/);
});
