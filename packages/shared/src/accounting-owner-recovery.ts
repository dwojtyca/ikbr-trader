import { createHash } from 'node:crypto';

export const OWNER_RECOVERY_LIMITS = Object.freeze({
  messageBytes: 65_536, sessionBytes: 262_144, operationMs: 900_000,
  operatorEvidenceMs: 300_000, clockDriftMs: 1_000, databaseRoundTripMs: 2_000,
  handshakeMs: 10_000, closureReserveMs: 2_000, producers: 64, nativeProcesses: 128,
});
export const OWNER_RECOVERY_SERVICES = ['execution-engine', 'ingestion', 'llm-agent', 'signal-engine', 'backtest-engine', 'ui'] as const;
export type OwnerRecoveryService = typeof OWNER_RECOVERY_SERVICES[number];
export type OwnerRecoveryState = 'PREPARED' | 'OBSERVED' | 'COMMITTED' | 'SUPERSEDED';
export interface OwnerRecoveryEndpoint { host: string; port: number; clientId: 0 }
export interface OwnerRecoveryProfile {
  project: string; imageId: string; deploymentHash: string; dockerHost: string;
  hostIdHash: string; settingsHash: string; accountId: string; endpoint: OwnerRecoveryEndpoint;
}
export interface OwnerRecoveryOwner {
  endpointKey: string; ownerId: string; generation: number; retirementState: 'ACTIVE' | 'UNKNOWN';
  acquiredAt: string; updatedAt: string;
}
export interface OwnerRecoveryProcess { pid: number; startIdentity: string; executableHash: string }
export interface OwnerRecoveryProcessObservation { observedAt: string; process: OwnerRecoveryProcess }
export interface OwnerRecoveryArtifact {
  kind: 'account-environment' | 'positions' | 'open-orders'; relativePath: string; sha256: string; observedAt: string;
}
export interface OwnerRecoveryOperatorEvidence {
  version: 1; inspectionId: string; accountId: string; endpoint: OwnerRecoveryEndpoint;
  settingsHash: string; deploymentHash: string; operator: string; observedAt: string; product: 'TWS';
  confirmations: {
    paperAccount: true; accountPositionsFlat: true; accountOpenOrdersAbsent: true;
    noPendingManualActions: true; otherClientsStopped: true; noChangesUntilRecoveryEnds: true;
    noOtherNativeOrExternalClients: true; noNativeClientLaunchUntilRecoveryEnds: true;
  };
  artifacts: OwnerRecoveryArtifact[];
  afterReset?: { operationId: string; nonce: string; process: OwnerRecoveryProcess };
}
export interface OwnerRecoveryProducer {
  containerId: string; imageId: string; project: string; service: OwnerRecoveryService;
  startedAt: string; finishedAt: string; state: 'exited' | 'dead';
}
export interface OwnerRecoveryInventory {
  observedAt: string; producers: OwnerRecoveryProducer[]; absentServices: OwnerRecoveryService[];
  nativeProcesses: Array<OwnerRecoveryProcess & { argvHash: string; role: 'collector' | 'inspection' | 'tws' | 'recovery-child' }>;
  unexpectedNativeCandidates: never[]; unexpectedSocketPids: never[];
}
export interface OwnerRecoveryHostEvidence {
  version: 1; operationId: string; nonce: string; bindingDigest: string; profile: OwnerRecoveryProfile;
  collectorStartedAt: string; before: OwnerRecoveryProcessObservation;
  stopped: { observedAt: string; processAbsent: true; listenerAbsent: true };
  after: OwnerRecoveryProcessObservation; current: OwnerRecoveryProcessObservation;
  initialInventory: OwnerRecoveryInventory; finalInventory: OwnerRecoveryInventory;
  dockerEvents: { startedAt: string; checkedAt: string; continuous: true; noProducerStarts: true };
  clock: { wallStartedAt: string; wallCheckedAt: string; monotonicElapsedMs: number; dbSampleAt: string; dbRoundTripMs: number };
  operatorEvidence: OwnerRecoveryOperatorEvidence;
}
export interface OwnerRecoveryHandshake {
  sessionId: string; dispatchEventId: string; accountId: string; clientId: 0;
  serverVersion: number; connectedAt: string; readyAt: string; closedAt: string;
  socketCloseObserved: true;
}
export interface OwnerRecoveryOperation {
  version: 1; operationId: string; nonce: string; state: OwnerRecoveryState;
  owner: OwnerRecoveryOwner; profile: OwnerRecoveryProfile; pauseRevision: number;
  actor: string; preparedAt: string; expiresAt: string; bindingDigest: string;
  evidenceDigest: string | null; successorOperationId: string | null; receiptId: string | null;
}
export interface OwnerRecoveryReceipt {
  version: 1; receiptId: string; operationId: string; commitRequestId: string;
  owner: OwnerRecoveryOwner; bindingDigest: string; evidenceDigest: string; actor: string;
  committedAt: string; retiredAt: string; retirementState: 'RETIRED';
  method: 'OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1';
}
interface OwnerRecoveryAuthenticated {
  version: 1; requestId: string; actor: string; token: string; profile: OwnerRecoveryProfile;
}
export type OwnerRecoveryRequest =
  | (OwnerRecoveryAuthenticated & { action: 'prepare'; operationId: string; operatorEvidence: OwnerRecoveryOperatorEvidence; inventory: OwnerRecoveryInventory })
  | (OwnerRecoveryAuthenticated & { action: 'status'; operationId: string; lookupRequestId?: string })
  | (OwnerRecoveryAuthenticated & { action: 'supersede'; operationId: string; replacementOperationId: string; operatorEvidence: OwnerRecoveryOperatorEvidence; inventory: OwnerRecoveryInventory })
  | (OwnerRecoveryAuthenticated & { action: 'begin-observe'; operationId: string; bindingDigest: string })
  | { version: 1; action: 'reset-proof'; requestId: string; observerSessionId: string; evidence: OwnerRecoveryHostEvidence }
  | { version: 1; action: 'finalize-observation'; requestId: string; observerSessionId: string; observedRequestId: string; commitRequestId: string; handshakeDigest: string; evidence: OwnerRecoveryHostEvidence };
export interface OwnerRecoveryEventMetadata {
  eventId: string; requestId: string; kind: 'PREPARED' | 'HANDSHAKE_DISPATCH' | 'HANDSHAKE_CLOSED' | 'OBSERVED' | 'COMMITTED' | 'SUPERSEDED';
  actor: string; recordedAt: string; bindingDigest: string; evidenceDigest: string | null;
}
export interface OwnerRecoveryStatus {
  pendingOperationId: string | null; events: OwnerRecoveryEventMetadata[];
  operation: OwnerRecoveryOperation | null; maintenancePending: boolean;
  receipt: OwnerRecoveryReceipt | null;
  lookup: null | { requestId: string; operationId: string; kind: 'PREPARED' | 'HANDSHAKE_DISPATCH' | 'HANDSHAKE_CLOSED' | 'OBSERVED' | 'COMMITTED' | 'SUPERSEDED'; evidenceDigest: string | null };
}
export type OwnerRecoveryResponse =
  | { version: 1; requestId: string; ok: false; error: { code: string; cause?: { name: string | null; code: string | number | null; message: string | null } } }
  | { version: 1; requestId: string; ok: true; action: 'prepared' | 'superseded'; result: OwnerRecoveryOperation }
  | { version: 1; requestId: string; ok: true; action: 'status'; result: OwnerRecoveryStatus }
  | { version: 1; requestId: string; ok: true; action: 'observer-ready'; result: { operation: OwnerRecoveryOperation; observerSessionId: string; dbNow: string; remainingMs: number } }
  | { version: 1; requestId: string; ok: true; action: 'handshake-closed'; result: { handshake: OwnerRecoveryHandshake; handshakeDigest: string } }
  | { version: 1; requestId: string; ok: true; action: 'committed'; result: { operation: OwnerRecoveryOperation; receipt: OwnerRecoveryReceipt; unlockAcknowledged: true } };

type Validator = (value: unknown) => void;
const fail = (): never => { throw new Error('ACCOUNTING_OWNER_RECOVERY_INVALID'); };
function check(value: unknown): asserts value { if (!value) fail(); }
function text(value: unknown, max = 200): asserts value is string {
  check(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
}
const integer = (value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): void => { check(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max); };
const literal = (expected: unknown): Validator => value => check(value === expected);
const enumeration = (values: readonly string[]): Validator => value => check(typeof value === 'string' && values.includes(value));
const uuid: Validator = value => { text(value, 36); check(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)); };
const hash: Validator = value => { text(value, 64); check(/^[0-9a-f]{64}$/.test(value)); };
const imageId: Validator = value => { text(value, 71); check(/^sha256:[0-9a-f]{64}$/.test(value)); };
const instant: Validator = value => {
  text(value, 40); check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
  const prefix = value.slice(0, 10), parsed = new Date(`${prefix}T00:00:00Z`);
  check(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === prefix);
};
const nullable = (validator: Validator): Validator => value => { if (value !== null) validator(value); };
const array = (validator: Validator, min: number, max: number): Validator => value => {
  check(Array.isArray(value) && value.length >= min && value.length <= max); value.forEach(validator);
};
function object(value: unknown, required: Record<string, Validator>, optional: Record<string, Validator> = {}): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
  const record = value as Record<string, unknown>;
  check(Object.keys(record).every(key => Object.hasOwn(required, key) || Object.hasOwn(optional, key)));
  for (const [key, validate] of Object.entries(required)) { check(Object.hasOwn(record, key)); validate(record[key]); }
  for (const [key, validate] of Object.entries(optional)) if (Object.hasOwn(record, key)) validate(record[key]);
}
function bounded(value: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { fail(); }
  check(encoded !== undefined && Buffer.byteLength(encoded) <= OWNER_RECOVERY_LIMITS.messageBytes);
}
const endpoint: Validator = value => object(value, {
  host: enumeration(['localhost', '127.0.0.1', '::1', 'host.docker.internal']),
  port: v => integer(v, 1, 65535), clientId: literal(0),
});
const profile: Validator = value => object(value, {
  project: v => { text(v, 63); check(/^[a-z0-9][a-z0-9_-]*$/.test(v)); }, imageId,
  deploymentHash: hash, dockerHost: v => { text(v, 300); check(/^unix:\/\/(?:\/Users\/[^\s]+\/\.docker\/run\/docker\.sock|\/var\/run\/docker\.sock)$/.test(v)); },
  hostIdHash: hash, settingsHash: hash, accountId: v => { text(v, 80); check(/^[A-Za-z0-9_-]+$/.test(v)); }, endpoint,
});
const owner: Validator = value => {
  object(value, { endpointKey: v => text(v, 500), ownerId: uuid, generation: v => integer(v), retirementState: enumeration(['ACTIVE', 'UNKNOWN']), acquiredAt: instant, updatedAt: instant });
  check(Date.parse(value.updatedAt as string) >= Date.parse(value.acquiredAt as string));
};
const processIdentity: Validator = value => object(value, { pid: v => integer(v, 1, 2147483647), startIdentity: instant, executableHash: hash });
const processObservation: Validator = value => {
  object(value, { observedAt: instant, process: processIdentity });
  check(Date.parse((value.process as OwnerRecoveryProcess).startIdentity) <= Date.parse(value.observedAt as string));
};
const artifact: Validator = value => {
  object(value, { kind: enumeration(['account-environment', 'positions', 'open-orders']), relativePath: v => {
    text(v, 300); check(!v.startsWith('/') && !v.includes('\\') && v.split('/').every(part => part !== '' && part !== '.' && part !== '..') && /\.(png|jpe?g|txt)$/i.test(v));
  }, sha256: hash, observedAt: instant });
};
const confirmations: Validator = value => object(value, {
  paperAccount: literal(true), accountPositionsFlat: literal(true), accountOpenOrdersAbsent: literal(true),
  noPendingManualActions: literal(true), otherClientsStopped: literal(true), noChangesUntilRecoveryEnds: literal(true),
  noOtherNativeOrExternalClients: literal(true), noNativeClientLaunchUntilRecoveryEnds: literal(true),
});
const operatorEvidence: Validator = value => {
  object(value, { version: literal(1), inspectionId: uuid, accountId: v => text(v, 80), endpoint, settingsHash: hash,
    deploymentHash: hash, operator: v => text(v), observedAt: instant, product: literal('TWS'), confirmations,
    artifacts: array(artifact, 3, 3),
  }, { afterReset: v => object(v, { operationId: uuid, nonce: uuid, process: processIdentity }) });
  const artifacts = value.artifacts as OwnerRecoveryArtifact[];
  check(new Set(artifacts.map(a => a.kind)).size === 3 && new Set(artifacts.map(a => a.relativePath)).size === 3);
  check(artifacts.every(a => Date.parse(a.observedAt) <= Date.parse(value.observedAt as string)));
};
const producer: Validator = value => {
  object(value, { containerId: hash, imageId, project: v => text(v, 63), service: enumeration(OWNER_RECOVERY_SERVICES),
    startedAt: instant, finishedAt: instant, state: enumeration(['exited', 'dead']) });
  check(Date.parse(value.startedAt as string) <= Date.parse(value.finishedAt as string));
};
const inventory: Validator = value => {
  object(value, { observedAt: instant, producers: array(producer, 0, OWNER_RECOVERY_LIMITS.producers),
    absentServices: array(enumeration(OWNER_RECOVERY_SERVICES), 0, 6),
    nativeProcesses: array(v => object(v, { pid: n => integer(n, 1, 2147483647), startIdentity: instant, executableHash: hash, argvHash: hash,
      role: enumeration(['collector', 'inspection', 'tws', 'recovery-child']) }), 0, OWNER_RECOVERY_LIMITS.nativeProcesses),
    unexpectedNativeCandidates: array(() => fail(), 0, 0), unexpectedSocketPids: array(() => fail(), 0, 0),
  });
  const inv = value as unknown as OwnerRecoveryInventory;
  check(new Set(inv.producers.map(p => p.containerId)).size === inv.producers.length && new Set(inv.absentServices).size === inv.absentServices.length);
  check(new Set(inv.nativeProcesses.map(p => p.pid)).size === inv.nativeProcesses.length);
  check(inv.producers.every(p => Date.parse(p.finishedAt) <= Date.parse(inv.observedAt) && !inv.absentServices.includes(p.service)));
  check(inv.nativeProcesses.every(p => Date.parse(p.startIdentity) <= Date.parse(inv.observedAt)));
  check(OWNER_RECOVERY_SERVICES.every(service => inv.absentServices.includes(service) || inv.producers.some(p => p.service === service)));
};
function sameProcess(a: OwnerRecoveryProcess, b: OwnerRecoveryProcess): boolean {
  return a.pid === b.pid && a.startIdentity === b.startIdentity && a.executableHash === b.executableHash;
}
const hostEvidence: Validator = value => {
  object(value, { version: literal(1), operationId: uuid, nonce: uuid, bindingDigest: hash, profile, collectorStartedAt: instant,
    before: processObservation, stopped: v => object(v, { observedAt: instant, processAbsent: literal(true), listenerAbsent: literal(true) }),
    after: processObservation, current: processObservation, initialInventory: inventory, finalInventory: inventory,
    dockerEvents: v => object(v, { startedAt: instant, checkedAt: instant, continuous: literal(true), noProducerStarts: literal(true) }),
    clock: v => object(v, { wallStartedAt: instant, wallCheckedAt: instant, monotonicElapsedMs: n => integer(n, 0, OWNER_RECOVERY_LIMITS.operationMs - 1), dbSampleAt: instant,
      dbRoundTripMs: n => integer(n, 0, OWNER_RECOVERY_LIMITS.databaseRoundTripMs) }), operatorEvidence,
  });
  const e = value as unknown as OwnerRecoveryHostEvidence, time = (v: string) => Date.parse(v);
  check(time(e.collectorStartedAt) <= time(e.initialInventory.observedAt) && time(e.initialInventory.observedAt) <= time(e.before.observedAt));
  check(time(e.before.observedAt) < time(e.stopped.observedAt) && time(e.stopped.observedAt) < time(e.after.observedAt));
  check(e.before.process.pid !== e.after.process.pid && time(e.after.process.startIdentity) > time(e.before.process.startIdentity));
  check(time(e.after.process.startIdentity) >= Math.floor(time(e.stopped.observedAt) / 1000) * 1000 && sameProcess(e.after.process, e.current.process));
  check(time(e.after.observedAt) <= time(e.current.observedAt) && time(e.current.observedAt) <= time(e.finalInventory.observedAt));
  check(time(e.dockerEvents.startedAt) <= time(e.initialInventory.observedAt) && time(e.dockerEvents.checkedAt) >= time(e.finalInventory.observedAt));
  check(e.clock.wallStartedAt === e.collectorStartedAt && time(e.clock.wallCheckedAt) >= time(e.dockerEvents.checkedAt));
  const elapsed = time(e.clock.wallCheckedAt) - time(e.clock.wallStartedAt);
  check(elapsed >= 0 && elapsed < OWNER_RECOVERY_LIMITS.operationMs && Math.abs(elapsed - e.clock.monotonicElapsedMs) <= OWNER_RECOVERY_LIMITS.clockDriftMs);
  check(time(e.clock.dbSampleAt) >= time(e.clock.wallStartedAt) - OWNER_RECOVERY_LIMITS.clockDriftMs && time(e.clock.dbSampleAt) <= time(e.clock.wallCheckedAt) + OWNER_RECOVERY_LIMITS.clockDriftMs);
  const after = e.operatorEvidence.afterReset;
  check(after && after.operationId === e.operationId && after.nonce === e.nonce && sameProcess(after.process, e.after.process));
  check(e.operatorEvidence.accountId === e.profile.accountId && e.operatorEvidence.settingsHash === e.profile.settingsHash && e.operatorEvidence.deploymentHash === e.profile.deploymentHash);
  check(ownerRecoveryHash(e.operatorEvidence.endpoint) === ownerRecoveryHash(e.profile.endpoint));
  check(time(e.operatorEvidence.observedAt) >= time(e.after.observedAt) && time(e.operatorEvidence.observedAt) <= time(e.clock.wallCheckedAt));
  check(e.operatorEvidence.artifacts.every(a => time(a.observedAt) >= time(e.after.observedAt)));
  check(time(e.clock.wallCheckedAt) - time(e.operatorEvidence.observedAt) <= OWNER_RECOVERY_LIMITS.operatorEvidenceMs);
  check(ownerRecoveryHash(e.initialInventory.producers) === ownerRecoveryHash(e.finalInventory.producers));
  check(ownerRecoveryHash([...e.initialInventory.absentServices].sort()) === ownerRecoveryHash([...e.finalInventory.absentServices].sort()));
  check(e.initialInventory.producers.every(p => p.project === e.profile.project && p.imageId === e.profile.imageId));
};
const handshake: Validator = value => {
  object(value, { sessionId: uuid, dispatchEventId: uuid, accountId: v => text(v, 80), clientId: literal(0), serverVersion: v => integer(v),
    connectedAt: instant, readyAt: instant, closedAt: instant, socketCloseObserved: literal(true) });
  const h = value as unknown as OwnerRecoveryHandshake;
  check(Date.parse(h.connectedAt) <= Date.parse(h.readyAt) && Date.parse(h.readyAt) <= Date.parse(h.closedAt));
  check(Date.parse(h.closedAt) - Date.parse(h.connectedAt) <= OWNER_RECOVERY_LIMITS.handshakeMs);
};
const operation: Validator = value => {
  object(value, { version: literal(1), operationId: uuid, nonce: uuid, state: enumeration(['PREPARED', 'OBSERVED', 'COMMITTED', 'SUPERSEDED']),
    owner, profile, pauseRevision: v => integer(v), actor: v => text(v), preparedAt: instant, expiresAt: instant, bindingDigest: hash,
    evidenceDigest: nullable(hash), successorOperationId: nullable(uuid), receiptId: nullable(uuid),
  });
  const op = value as unknown as OwnerRecoveryOperation;
  check(Date.parse(op.expiresAt) - Date.parse(op.preparedAt) === OWNER_RECOVERY_LIMITS.operationMs);
  check((op.state === 'COMMITTED') === (op.receiptId !== null) && (op.state === 'SUPERSEDED') === (op.successorOperationId !== null));
  check(op.state !== 'PREPARED' || op.evidenceDigest === null);
  check(!['OBSERVED', 'COMMITTED'].includes(op.state) || op.evidenceDigest !== null);
  check(op.successorOperationId !== op.operationId);
};
const receipt: Validator = value => {
  object(value, { version: literal(1), receiptId: uuid, operationId: uuid, commitRequestId: uuid, owner,
    bindingDigest: hash, evidenceDigest: hash, actor: v => text(v), committedAt: instant, retiredAt: instant,
    retirementState: literal('RETIRED'), method: literal('OPERATOR_OBSERVED_LOCAL_TWS_RESET_V1'),
  });
  check(Date.parse(value.retiredAt as string) === Date.parse(value.committedAt as string));
};
function parse<T>(value: unknown, validate: Validator): T { bounded(value); validate(value); return structuredClone(value) as T; }
export function parseOwnerRecoveryProfile(value: unknown): OwnerRecoveryProfile { return parse(value, profile); }
export function parseOwnerRecoveryOwner(value: unknown): OwnerRecoveryOwner { return parse(value, owner); }
export function parseOwnerRecoveryInventory(value: unknown): OwnerRecoveryInventory { return parse(value, inventory); }
export function parseOwnerRecoveryOperatorEvidence(value: unknown): OwnerRecoveryOperatorEvidence { return parse(value, operatorEvidence); }
export function parseOwnerRecoveryHostEvidence(value: unknown): OwnerRecoveryHostEvidence { return parse(value, hostEvidence); }
export function parseOwnerRecoveryHandshake(value: unknown): OwnerRecoveryHandshake { return parse(value, handshake); }
export function parseOwnerRecoveryOperation(value: unknown): OwnerRecoveryOperation { return parse(value, operation); }
export function parseOwnerRecoveryReceipt(value: unknown): OwnerRecoveryReceipt { return parse(value, receipt); }
export function ownerRecoveryHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'number') { check(Number.isFinite(input)); return JSON.stringify(input); }
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    check(input !== null && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype);
    const record = input as Record<string, unknown>;
    check(!Object.hasOwn(record, 'token'));
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  };
  bounded(value); return createHash('sha256').update(canonical(value)).digest('hex');
}
const authenticated = { version: literal(1), requestId: uuid, actor: (v: unknown) => text(v), token: (v: unknown) => { text(v, 4096); check(v.length >= 32); }, profile };
export function parseOwnerRecoveryRequest(value: unknown): OwnerRecoveryRequest {
  return parse(value, v => {
    check(v !== null && typeof v === 'object');
    const action = (v as Record<string, unknown>).action;
    if (action === 'prepare') object(v, { ...authenticated, action: literal(action), operationId: uuid, operatorEvidence, inventory });
    else if (action === 'status') object(v, { ...authenticated, action: literal(action), operationId: uuid }, { lookupRequestId: uuid });
    else if (action === 'supersede') object(v, { ...authenticated, action: literal(action), operationId: uuid, replacementOperationId: uuid, operatorEvidence, inventory });
    else if (action === 'begin-observe') object(v, { ...authenticated, action: literal(action), operationId: uuid, bindingDigest: hash });
    else if (action === 'reset-proof') object(v, { version: literal(1), action: literal(action), requestId: uuid, observerSessionId: uuid, evidence: hostEvidence });
    else if (action === 'finalize-observation') object(v, { version: literal(1), action: literal(action), requestId: uuid, observerSessionId: uuid,
      observedRequestId: uuid, commitRequestId: uuid, handshakeDigest: hash, evidence: hostEvidence });
    else fail();
    const request = v as OwnerRecoveryRequest;
    if (request.action === 'prepare' || request.action === 'supersede') {
      check(!request.operatorEvidence.afterReset);
      check(request.operatorEvidence.accountId === request.profile.accountId && request.operatorEvidence.settingsHash === request.profile.settingsHash && request.operatorEvidence.deploymentHash === request.profile.deploymentHash);
      check(ownerRecoveryHash(request.operatorEvidence.endpoint) === ownerRecoveryHash(request.profile.endpoint));
      check(request.inventory.producers.every(p => p.project === request.profile.project && p.imageId === request.profile.imageId));
      if (request.action === 'supersede') check(request.operationId !== request.replacementOperationId);
    }
    if (request.action === 'finalize-observation') check(new Set([request.requestId, request.observedRequestId, request.commitRequestId]).size === 3);
  });
}
const status: Validator = value => {
  object(value, { pendingOperationId: nullable(uuid), events: array(v => object(v, { eventId: uuid, requestId: uuid, kind: enumeration(['PREPARED', 'HANDSHAKE_DISPATCH', 'HANDSHAKE_CLOSED', 'OBSERVED', 'COMMITTED', 'SUPERSEDED']), actor: a => text(a), recordedAt: instant, bindingDigest: hash, evidenceDigest: nullable(hash) }), 0, 6), operation: nullable(operation), maintenancePending: v => check(typeof v === 'boolean'), receipt: nullable(receipt), lookup: nullable(v => object(v, {
    requestId: uuid, operationId: uuid, kind: enumeration(['PREPARED', 'HANDSHAKE_DISPATCH', 'HANDSHAKE_CLOSED', 'OBSERVED', 'COMMITTED', 'SUPERSEDED']), evidenceDigest: nullable(hash),
  })) });
  const s = value as unknown as OwnerRecoveryStatus;
  check(s.maintenancePending === (s.pendingOperationId !== null));
  check(new Set(s.events.map(e => e.eventId)).size === s.events.length && new Set(s.events.map(e => e.requestId)).size === s.events.length);
  check(s.events.every(e => s.operation && e.bindingDigest === s.operation.bindingDigest));
  if (s.operation && ['PREPARED', 'OBSERVED'].includes(s.operation.state)) check(s.pendingOperationId === s.operation.operationId);
  if (s.lookup) check(s.lookup.operationId === s.operation?.operationId && s.events.some(e => e.requestId === s.lookup!.requestId && e.kind === s.lookup!.kind && e.evidenceDigest === s.lookup!.evidenceDigest));
  if (s.receipt) check(s.operation?.state === 'COMMITTED' && s.operation.operationId === s.receipt.operationId && s.operation.receiptId === s.receipt.receiptId && s.operation.bindingDigest === s.receipt.bindingDigest && s.operation.evidenceDigest === s.receipt.evidenceDigest && ownerRecoveryHash(s.operation.owner) === ownerRecoveryHash(s.receipt.owner));
};
export function parseOwnerRecoveryResponse(value: unknown): OwnerRecoveryResponse {
  return parse(value, v => {
    check(v !== null && typeof v === 'object');
    const r = v as Record<string, unknown>;
    if (r.ok === false) {
      object(v, { version: literal(1), requestId: uuid, ok: literal(false), error: e => object(e, {
        code: c => { text(c, 100); check(/^ACCOUNTING_OWNER_RECOVERY_[A-Z_]+$/.test(c)); },
      }, { cause: c => object(c, { name: nullable(n => text(n, 200)), code: nullable(causeCode => {
        if (typeof causeCode === 'number') integer(causeCode, -2147483648, 2147483647); else text(causeCode, 200);
      }), message: nullable(m => text(m, 1000)) }) }) });
      return;
    }
    const result = r.action === 'prepared' || r.action === 'superseded' ? (x: unknown) => { operation(x); check((x as OwnerRecoveryOperation).state === 'PREPARED'); } : r.action === 'status' ? status :
      r.action === 'observer-ready' ? (x: unknown) => { object(x, { operation, observerSessionId: uuid, dbNow: instant, remainingMs: ms => integer(ms, 1, OWNER_RECOVERY_LIMITS.operationMs) }); const op = x.operation as OwnerRecoveryOperation; check(op.state === 'PREPARED' && Date.parse(x.dbNow as string) >= Date.parse(op.preparedAt) && Date.parse(op.expiresAt) - Date.parse(x.dbNow as string) === x.remainingMs); } :
      r.action === 'handshake-closed' ? (x: unknown) => { object(x, { handshake, handshakeDigest: hash }); check(ownerRecoveryHash(x.handshake) === x.handshakeDigest); } :
      r.action === 'committed' ? (x: unknown) => {
        object(x, { operation, receipt, unlockAcknowledged: literal(true) });
        const op = x.operation as OwnerRecoveryOperation, rec = x.receipt as OwnerRecoveryReceipt;
        check(op.state === 'COMMITTED' && op.operationId === rec.operationId && op.receiptId === rec.receiptId && op.bindingDigest === rec.bindingDigest && op.evidenceDigest === rec.evidenceDigest && ownerRecoveryHash(op.owner) === ownerRecoveryHash(rec.owner));
      } : undefined;
    check(result); object(v, { version: literal(1), requestId: uuid, ok: literal(true), action: literal(r.action), result });
  });
}
