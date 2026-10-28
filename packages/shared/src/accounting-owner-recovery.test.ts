import assert from 'node:assert/strict';
import test from 'node:test';
import { OWNER_RECOVERY_SERVICES, ownerRecoveryHash, parseOwnerRecoveryRequest, parseOwnerRecoveryResponse,
  parseOwnerRecoveryHostEvidence, parseOwnerRecoveryOperation, parseOwnerRecoveryOperatorEvidence, parseOwnerRecoveryCoordination, parseOwnerRecoveryAccountProbe,
  type OwnerRecoveryProfile, type OwnerRecoveryOperatorEvidence, type OwnerRecoveryInventory, type OwnerRecoveryHostEvidence,
  type OwnerRecoveryOperation } from './accounting-owner-recovery.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64), time = (n: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, n)).toISOString();
const profile: OwnerRecoveryProfile = { project: 'test', imageId: `sha256:${hash}`, deploymentHash: hash, dockerHost: 'unix:///var/run/docker.sock',
  hostIdHash: hash, settingsHash: hash, accountId: 'DU_TEST', endpoint: { host: 'host.docker.internal', port: 7497, clientId: 0 } };
function operator(): OwnerRecoveryOperatorEvidence { return { version: 1, inspectionId: id(1), accountId: profile.accountId, endpoint: profile.endpoint,
  settingsHash: hash, deploymentHash: hash, operator: 'test operator', observedAt: time(5), product: 'TWS',
  confirmations: { paperAccount: true, accountPositionsFlat: true, accountOpenOrdersAbsent: true, noPendingManualActions: true,
    otherClientsStopped: true, noChangesUntilRecoveryEnds: true, noOtherNativeOrExternalClients: true, noNativeClientLaunchUntilRecoveryEnds: true },
  artifacts: ['account-environment', 'positions', 'open-orders'].map(kind => ({ kind: kind as 'positions', relativePath: `${kind}.png`, sha256: hash, observedAt: time(5) })) }; }
function inventory(n = 0): OwnerRecoveryInventory { return { observedAt: time(n), producers: [], absentServices: [...OWNER_RECOVERY_SERVICES], nativeProcesses: [], unexpectedNativeCandidates: [], unexpectedSocketPids: [] }; }
function evidence(): OwnerRecoveryHostEvidence {
  const newProcess = { pid: 12, startIdentity: time(3), executableHash: hash };
  return { version: 1, operationId: id(2), nonce: id(3), bindingDigest: hash, profile: structuredClone(profile), collectorStartedAt: time(0),
    before: { observedAt: time(1), process: { pid: 11, startIdentity: time(0), executableHash: hash } },
    stopped: { observedAt: time(2), processAbsent: true, listenerAbsent: true }, after: { observedAt: time(4), process: newProcess },
    current: { observedAt: time(6), process: newProcess }, initialInventory: inventory(), finalInventory: inventory(7),
    dockerEvents: { startedAt: time(0), checkedAt: time(8), continuous: true, noProducerStarts: true },
    clock: { wallStartedAt: time(0), wallCheckedAt: time(9), monotonicElapsedMs: 9000, dbSampleAt: time(8), dbRoundTripMs: 1 },
    operatorEvidence: { ...operator(), afterReset: { operationId: id(2), nonce: id(3), process: newProcess } } };
}
function operation(): OwnerRecoveryOperation { return { version: 1, operationId: id(2), nonce: id(3), state: 'PREPARED',
  owner: { endpointKey: 'canonical', ownerId: id(4), generation: 1, retirementState: 'ACTIVE', acquiredAt: time(0), updatedAt: time(0) },
  profile, pauseRevision: 1, actor: 'test', preparedAt: time(0), expiresAt: time(900), bindingDigest: hash,
  evidenceDigest: null, successorOperationId: null, receiptId: null }; }

test('prepare accepts pre-operation operator proof and detached copies only', () => {
  const request = { version: 1, action: 'prepare', requestId: id(5), operationId: id(2), actor: 'test', token: 'x'.repeat(32), profile, operatorEvidence: operator(), inventory: inventory(6) };
  const parsed = parseOwnerRecoveryRequest(request); assert.equal(parsed.action, 'prepare');
  assert.notEqual(parsed, request); assert.equal('afterReset' in request.operatorEvidence, false);
  assert.throws(() => parseOwnerRecoveryRequest({ ...request, force: true }));
  assert.throws(() => parseOwnerRecoveryRequest({ ...request, token: 'short' }));
});
test('created producer wire variant has explicit null process times and preserves exited/dead records', () => {
  const producer = { containerId: hash, imageId: profile.imageId, project: profile.project, service: 'execution-engine' as const };
  const request = { version: 1, action: 'prepare', requestId: id(5), operationId: id(2), actor: 'test', token: 'x'.repeat(32), profile,
    operatorEvidence: operator(), inventory: { ...inventory(6), absentServices: OWNER_RECOVERY_SERVICES.filter(s => s !== producer.service),
      producers: [{ ...producer, state: 'created', createdAt: time(0), startedAt: null, finishedAt: null }] } };
  assert.deepEqual(parseOwnerRecoveryRequest(request), request);
  for (const state of ['exited', 'dead']) {
    const old = { ...request, inventory: { ...request.inventory, producers: [{ ...producer, state, startedAt: time(0), finishedAt: time(1) }] } };
    assert.deepEqual(parseOwnerRecoveryRequest(old), old);
    assert.throws(() => parseOwnerRecoveryRequest({ ...old, inventory: { ...old.inventory, producers: [{ ...old.inventory.producers[0], createdAt: time(0) }] } }));
  }
  const mutations: Array<(p: Record<string, unknown>) => void> = [
    p => { p.startedAt = time(0); }, p => { p.finishedAt = time(1); }, p => { delete p.startedAt; }, p => { delete p.finishedAt; },
    p => { delete p.createdAt; }, p => { p.createdAt = null; }, p => { p.createdAt = time(7); }, p => { p.createdAt = '2026-02-30T00:00:00.000Z'; },
    p => { p.state = 'running'; }, p => { p.pid = 0; }, p => { p.state = 'exited'; },
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(request); mutate(bad.inventory.producers[0]);
    assert.throws(() => parseOwnerRecoveryRequest(bad));
  }
  assert.throws(() => parseOwnerRecoveryRequest({ ...request, inventory: { ...request.inventory, absentServices: [...OWNER_RECOVERY_SERVICES] } }));
});
test('created producer evidence still requires unchanged inventory, full reset, watcher and operator proofs', () => {
  const e = evidence();
  const producers: OwnerRecoveryInventory['producers'] = OWNER_RECOVERY_SERVICES.map((service, index) => ({ containerId: String(index + 1).repeat(64),
    imageId: profile.imageId, project: profile.project, service, state: 'created', createdAt: time(-1), startedAt: null, finishedAt: null }));
  e.initialInventory = { ...e.initialInventory, producers, absentServices: [] };
  e.finalInventory = { ...e.finalInventory, producers: structuredClone(producers), absentServices: [] };
  assert.deepEqual(parseOwnerRecoveryHostEvidence(e), e);
  const mutations: Array<(v: OwnerRecoveryHostEvidence) => void> = [
    v => { v.finalInventory.producers[0].containerId = 'b'.repeat(64); },
    v => { (v.finalInventory.producers[0] as Extract<typeof producers[number], { state: 'created' }>).createdAt = time(-2); },
    v => { v.stopped.observedAt = v.before.observedAt; },
    v => { (v.dockerEvents as unknown as Record<string, unknown>).continuous = false; },
    v => { delete v.operatorEvidence.afterReset; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(e); mutate(bad); assert.throws(() => parseOwnerRecoveryHostEvidence(bad)); }
});
test('operator proof rejects unknown fields, duplicate kinds, unsafe paths, false confirmations and impossible dates', () => {
  const mutations: Array<(v: OwnerRecoveryOperatorEvidence) => void> = [
    v => { v.artifacts[1].kind = v.artifacts[0].kind; }, v => { v.artifacts[0].relativePath = '../secret'; },
    v => { (v.confirmations as unknown as Record<string, boolean>).paperAccount = false; }, v => { v.observedAt = '2026-02-30T00:00:00Z'; },
    v => { (v as unknown as Record<string, unknown>).qualify = true; },
  ];
  for (const mutate of mutations) { const v = operator(); mutate(v); assert.throws(() => parseOwnerRecoveryOperatorEvidence(v)); }
});
test('reset evidence requires real sequence, exact process identity, bindings and monotonic continuity', () => {
  assert.equal(parseOwnerRecoveryHostEvidence(evidence()).operationId, id(2));
  const mutations: Array<(v: OwnerRecoveryHostEvidence) => void> = [
    v => { v.stopped.observedAt = v.before.observedAt; }, v => { v.after.process.pid = v.before.process.pid; },
    v => { v.current.process = { ...v.current.process, executableHash: 'b'.repeat(64) }; },
    v => { v.operatorEvidence.afterReset!.nonce = id(99); }, v => { v.clock.monotonicElapsedMs = 1; },
    v => { v.dockerEvents.checkedAt = time(1); }, v => { v.finalInventory.absentServices.pop(); },
    v => { v.operatorEvidence.artifacts[0].observedAt = time(1); }, v => { v.clock.dbRoundTripMs = 2001; },
  ];
  for (const mutate of mutations) { const v = evidence(); mutate(v); assert.throws(() => parseOwnerRecoveryHostEvidence(v)); }
});
test('operation parser rejects false terminal states and reset expiry', () => {
  assert.equal(parseOwnerRecoveryOperation(operation()).state, 'PREPARED');
  assert.throws(() => parseOwnerRecoveryOperation({ ...operation(), state: 'COMMITTED' }));
  assert.throws(() => parseOwnerRecoveryOperation({ ...operation(), expiresAt: time(901) }));
  assert.throws(() => parseOwnerRecoveryOperation({ ...operation(), successorOperationId: id(2) }));
});
test('automatic read supersession preserves evidence without claiming reset or successor operation', () => {
  for (const evidenceDigest of [null, hash]) {
    const retired = { ...operation(), state: 'AUTO_SUPERSEDED', evidenceDigest };
    assert.deepEqual(parseOwnerRecoveryOperation(retired), retired);
    assert.throws(() => parseOwnerRecoveryOperation({ ...retired, receiptId: id(30) }));
    assert.throws(() => parseOwnerRecoveryOperation({ ...retired, successorOperationId: id(31) }));
    assert.throws(() => parseOwnerRecoveryResponse({ version: 1, requestId: id(32), ok: true, action: 'prepared', result: retired }));
    assert.throws(() => parseOwnerRecoveryResponse({ version: 1, requestId: id(32), ok: true, action: 'observer-ready',
      result: { operation: retired, observerSessionId: id(33), dbNow: time(1), remainingMs: 899000 } }));
  }
});
test('automatic supersession status requires its event and cannot remain its own maintenance hold', () => {
  const retired = { ...operation(), state: 'AUTO_SUPERSEDED' };
  const event = { eventId: id(30), requestId: id(31), kind: 'AUTO_SUPERSEDED', actor: 'automatic-read-recovery',
    recordedAt: time(901), bindingDigest: hash, evidenceDigest: hash };
  const result = { operation: retired, events: [event], pendingOperationId: null, maintenancePending: false, receipt: null,
    lookup: { requestId: event.requestId, operationId: retired.operationId, kind: event.kind, evidenceDigest: hash } };
  const response = { version: 1, requestId: id(32), ok: true, action: 'status', result };
  assert.deepEqual(parseOwnerRecoveryResponse(response), response);
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...result, events: [], lookup: null } }));
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...result, pendingOperationId: retired.operationId, maintenancePending: true } }));
});
test('wire denies standalone commit, additional auth on observer frame, duplicate mutation IDs and unknown profiles', () => {
  assert.throws(() => parseOwnerRecoveryRequest({ version: 1, action: 'commit' }));
  const reset = { version: 1, action: 'reset-proof', requestId: id(5), observerSessionId: id(6), evidence: evidence() };
  assert.equal(parseOwnerRecoveryRequest(reset).action, 'reset-proof');
  assert.throws(() => parseOwnerRecoveryRequest({ ...reset, token: 'x'.repeat(32) }));
  assert.throws(() => parseOwnerRecoveryRequest({ ...reset, action: 'finalize-observation', observedRequestId: id(5), commitRequestId: id(7), handshakeDigest: hash }));
  const changed = evidence(); changed.profile.endpoint.host = 'remote.example';
  assert.throws(() => parseOwnerRecoveryHostEvidence(changed));
});
test('canonical hash is ordered and rejects credentials, undefined or oversized evidence', () => {
  assert.equal(ownerRecoveryHash({ a: 1, b: [2, 3] }), ownerRecoveryHash({ b: [2, 3], a: 1 }));
  assert.throws(() => ownerRecoveryHash({ token: 'private' }));
  assert.throws(() => ownerRecoveryHash({ value: undefined }));
  assert.throws(() => ownerRecoveryHash({ large: 'a'.repeat(65536) }));
});
test('response requires actual matching handshake digest and positive closure', () => {
  const handshake = { sessionId: id(1), dispatchEventId: id(2), accountId: 'DU_TEST', clientId: 0 as const, serverVersion: 180,
    connectedAt: time(1), readyAt: time(2), closedAt: time(3), socketCloseObserved: true as const };
  const response = { version: 1, requestId: id(3), ok: true, action: 'handshake-closed', result: { handshake, handshakeDigest: ownerRecoveryHash(handshake) } };
  assert.equal(parseOwnerRecoveryResponse(response).ok, true);
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...response.result, handshakeDigest: hash } }));
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...response.result, handshake: { ...handshake, socketCloseObserved: false } } }));
});

test('status binds pending maintenance and exact request lookup to its bounded event metadata', () => {
  const op = operation(), event = { eventId: id(8), requestId: id(9), kind: 'PREPARED', actor: op.actor,
    recordedAt: op.preparedAt, bindingDigest: hash, evidenceDigest: null };
  const result = { operation: op, pendingOperationId: op.operationId, maintenancePending: true, receipt: null, events: [event],
    lookup: { requestId: event.requestId, operationId: op.operationId, kind: event.kind, evidenceDigest: null } };
  const response = { version: 1, requestId: id(10), ok: true, action: 'status', result };
  assert.equal(parseOwnerRecoveryResponse(response).ok, true);
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...result, pendingOperationId: null } }));
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...result, events: [] } }));
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...result, events: [event, event] } }));
  assert.throws(() => parseOwnerRecoveryResponse({ ...response, result: { ...result, lookup: { ...result.lookup, requestId: id(99) } } }));
});

function coordinationV2() {
  const at = time(0), declaration = { confirmed: true, source: 'carried-owner-authorization', actor: 'owner', sourceReference: 'session-authority', observedAt: at };
  return { version: 2, coordinationId: id(21), actor: operation().actor, accountId: profile.accountId, endpoint: profile.endpoint, settingsHash: hash, deploymentHash: hash,
    recordedAt: at, authorizationReference: 'session-authority', declarations: { noPendingManualActionsOrDrafts: declaration,
      noOtherNativeOrExternalClients: declaration, noChangesOrClientLaunchesUntilRecoveryEnds: declaration }, environmentEvidence: {
      version: 2, inspectionId: id(22), accountId: profile.accountId, endpoint: profile.endpoint, settingsHash: hash, deploymentHash: hash,
      actor: 'observing-agent', provenance: 'agent-ui-observation', observedAt: at, product: 'TWS', environment: 'paper', process: evidence().before.process,
      artifact: { relativePath: 'paper.txt', sha256: hash, observedAt: at } } };
}
function probeV2() {
  return { version: 2, probeId: id(23), operationId: id(2), nonce: id(3), sessionId: id(24), dispatchEventId: id(25), phase: 'pre-reset', endpoint: profile.endpoint,
    result: { accountId: profile.accountId, clientId: 0, protocolVersion: 180, sdkVersion: '@stoqey/ib@1.6.10', connectedAt: time(0), readyAt: time(1),
      positionsRequestedAt: time(2), openOrdersRequestedAt: time(2), positionsEndAt: time(3), openOrdersEndAt: time(3), completedAt: time(4), closedAt: time(5),
      transportClosed: true, positionRows: 0, openOrderRows: 0, eventCount: 4, rowsDigest: hash, outcome: 'FLAT', error: null } };
}
test('V2 reserves explicit coordination provenance without inheriting V1 flat assertions', () => {
  const c = parseOwnerRecoveryCoordination(coordinationV2());
  assert.equal(c.environmentEvidence.actor, 'observing-agent');
  const request = { version: 2, action: 'prepare', requestId: id(26), operationId: id(2), actor: c.actor, token: 'x'.repeat(32), profile, coordination: c, inventory: inventory(0) };
  assert.deepEqual(parseOwnerRecoveryRequest(request), request);
  assert.throws(() => parseOwnerRecoveryRequest({ ...request, operatorEvidence: operator() }));
  assert.throws(() => parseOwnerRecoveryRequest({ ...request, version: 1 }));
  assert.deepEqual(parseOwnerRecoveryOperation({ ...operation(), version: 2, coordination: c }).coordination, c);
  assert.throws(() => parseOwnerRecoveryOperation({ ...operation(), version: 2 }));
  assert.throws(() => parseOwnerRecoveryOperation({ ...operation(), version: 1, coordination: c }));
  assert.throws(() => parseOwnerRecoveryOperation({ ...operation(), version: 2, coordination: { ...c, actor: 'different' } }));
  for (const mutate of [
    (v: ReturnType<typeof coordinationV2>) => { v.environmentEvidence.environment = 'live'; },
    (v: ReturnType<typeof coordinationV2>) => { v.environmentEvidence.artifact.relativePath = '../outside.txt'; },
    (v: ReturnType<typeof coordinationV2>) => { v.declarations.noOtherNativeOrExternalClients.confirmed = false; },
    (v: ReturnType<typeof coordinationV2>) => { v.environmentEvidence.accountId = 'OTHER'; },
  ]) { const v = coordinationV2(); mutate(v); assert.throws(() => parseOwnerRecoveryCoordination(v)); }
});
test('V2 account proof rejects false flat completeness, malformed closure and stale time ordering', () => {
  assert.deepEqual(parseOwnerRecoveryAccountProbe(probeV2()), probeV2());
  for (const mutate of [
    (v: ReturnType<typeof probeV2>) => { v.result.openOrderRows = 1; },
    (v: ReturnType<typeof probeV2>) => { v.result.transportClosed = false; },
    (v: ReturnType<typeof probeV2>) => { v.result.positionsEndAt = time(1); },
    (v: ReturnType<typeof probeV2>) => { v.result.closedAt = time(25); },
    (v: ReturnType<typeof probeV2>) => { v.result.clientId = 1; },
  ]) { const v = probeV2(); mutate(v); assert.throws(() => parseOwnerRecoveryAccountProbe(v)); }
  const failed = { ...probeV2(), result: { ...probeV2().result, closedAt: time(25), outcome: 'INCOMPLETE', error: { code: 'ACCOUNTING_OWNER_RECOVERY_CLOCK_UNCERTAIN' } } };
  assert.equal(parseOwnerRecoveryAccountProbe(failed).result.outcome, 'INCOMPLETE');
  assert.throws(() => parseOwnerRecoveryAccountProbe({ ...failed, result: { ...failed.result, error: null } }));
});
test('V2 host witness binds fresh environment to new process and cannot mix V1 and V2 frame versions', () => {
  const { operatorEvidence: _operator, ...old } = evidence(), c = coordinationV2();
  const after = { ...c.environmentEvidence, observedAt: time(5), artifact: { ...c.environmentEvidence.artifact, observedAt: time(5) }, process: old.after.process,
    afterReset: { operationId: old.operationId, nonce: old.nonce } };
  const witness = { ...old, version: 2, coordinationDigest: ownerRecoveryHash(c), preResetProbeDigest: hash, environmentEvidence: after };
  assert.deepEqual(parseOwnerRecoveryHostEvidence(witness), witness);
  const frame = { version: 2, action: 'reset-proof', requestId: id(27), observerSessionId: id(24), evidence: witness };
  assert.deepEqual(parseOwnerRecoveryRequest(frame), frame);
  assert.throws(() => parseOwnerRecoveryRequest({ ...frame, version: 1 }));
  assert.throws(() => parseOwnerRecoveryHostEvidence({ ...witness, environmentEvidence: { ...after, process: old.before.process } }));
  assert.throws(() => parseOwnerRecoveryHostEvidence({ ...witness, environmentEvidence: { ...after, afterReset: { ...after.afterReset, nonce: id(28) } } }));
});
