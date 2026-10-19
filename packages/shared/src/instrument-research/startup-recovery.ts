import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ResearchIdentity } from './types.js';
import type { WshCleanupResult } from './wsh-refresh.js';
import { isResearchHash, researchAssert, researchHash, researchTime } from './validation.js';

export type RecoveryKind = 'MARKETAUX_PRODUCER_QUIESCENCE' | 'WSH_ENDPOINT_RESET';
export interface RecoveryIdentity extends ResearchIdentity {
  kind: RecoveryKind; accountId: string; instrumentId: string; sourceId: string;
  pauseRevision: number; actor: string; operationId: string;
}
export interface RecoveryPredecessor {
  kind: 'MARKETAUX_ATTEMPT' | 'WSH_ATTEMPT' | 'WSH_ACQUISITION'; id: string; identityHash: string; state: string;
  endpointId: string | null; ledgerKey: string; sessionId: string | null; generation: number | null;
}
export interface RecoveryChallenge extends RecoveryIdentity {
  id: string; nonce: string; challengeHash: string; executionProcessId: string; createdAt: string; expiresAt: string;
  state: 'PREPARED' | 'COMMITTED' | 'CANCELLED'; endpointId: string | null; endpointGeneration: number | null;
  predecessors: RecoveryPredecessor[]; predecessorHash: string; receiptId: string | null;
}
export interface RecoveryProducer { containerId: string; imageId: string; project: string; service: 'llm-agent'; startedAt: string; finishedAt: string; state: 'exited' | 'dead' }
export interface RecoveryProcess { pid: number; startIdentity: string; executableHash: string }
export interface RecoveryEvidenceBase {
  version: 'local-research-recovery-v1'; kind: RecoveryKind; challengeId: string; challengeHash: string; nonce: string;
  hostIdHash: string; platform: 'darwin'; collectorStartedAt: string; producerCheckedAt: string; producerRecheckedAt: string;
  deploymentHash: string; producers: RecoveryProducer[]; runningProducerIds: [];
}
export interface MarketauxRecoveryEvidence extends RecoveryEvidenceBase { kind: 'MARKETAUX_PRODUCER_QUIESCENCE' }
export interface WshRecoveryEvidence extends RecoveryEvidenceBase {
  kind: 'WSH_ENDPOINT_RESET'; endpointId: string; endpointSettingsHash: string; host: string; port: number; clientId: number;
  before: { observedAt: string; process: RecoveryProcess }; stopped: { observedAt: string; processAbsent: true; listenerAbsent: true };
  after: { observedAt: string; process: RecoveryProcess };
  reconnect: { startedAt: string; completedAt: string; sessionId: string; accountId: string; serverVersion: number; sdkVersion: '1.6.10'; cleanup: WshCleanupResult };
}
export type RecoveryEvidence = MarketauxRecoveryEvidence | WshRecoveryEvidence;
export interface RecoveryQuiescenceEvidence extends Omit<RecoveryEvidenceBase, 'kind'> { kind: 'PRODUCER_QUIESCENCE' }
export interface RecoveryCommit { challengeId: string; challengeHash: string; operationId: string; actor: string; pauseRevision: number; evidence: RecoveryEvidence }
export interface RecoverySupersede { challengeId: string; challengeHash: string; replacement: RecoveryIdentity; evidence: RecoveryQuiescenceEvidence }
export interface RecoveryReceipt { id: string; challengeId: string; kind: RecoveryKind; recordedAt: string; evidenceHash: string; predecessorHash: string; nextCheckAt: string | null }
export interface MarketauxRecoveryResult { state: 'NOT_REQUIRED' | 'RECOVERED' | 'WAITING' | 'OPERATOR_REQUIRED'; reason: string | null; nextCheckAt: string | null; recoveryIds: string[] }
export interface ResearchRecoveryClock { wallNow(): number; monotonicNow(): number; domainId(): string | null }
export const MARKETAUX_RECOVERY_PROTOCOL = 'DEADLINE_FENCED_HTTP_V1';
export const RECOVERY_CLOCK_TOLERANCE_MS = 1000;
export const RECOVERY_EXPIRY_MARGIN_MS = 5000;
export const systemResearchRecoveryClock: ResearchRecoveryClock = {
  wallNow: () => Date.now(), monotonicNow: () => performance.now(), domainId: () => {
    try { const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); return /^[a-f0-9-]{36}$/.test(boot) ? createHash('sha256').update(boot).digest('hex') : null; } catch { return null; }
  },
};
const invalid = 'RESEARCH_RECOVERY_EVIDENCE_INVALID';
export const isRecoveryUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function object(value: unknown, keys: string): Record<string, unknown> {
  researchAssert(value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, invalid);
  const row = value as Record<string, unknown>;
  researchAssert(Reflect.ownKeys(row).length === Object.keys(row).length && Object.keys(row).sort().join(',') === keys.split(' ').sort().join(',') && Object.keys(row).every(k => 'value' in Object.getOwnPropertyDescriptor(row, k)!), invalid);
  return row;
}
function array(value: unknown, min: number, max: number): unknown[] {
  researchAssert(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= min && value.length <= max, invalid);
  researchAssert(Reflect.ownKeys(value).length === value.length + 1 && Array.from({length:value.length},(_,i)=>Object.getOwnPropertyDescriptor(value,String(i))).every(d=>d && 'value' in d),invalid);
  return value;
}
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x20-\x7e]+$/.test(v);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= max;
function date(value: unknown): number { try { return researchTime(value); } catch { throw new Error(invalid); } }
export function parseRecoveryIdentity(value: unknown): RecoveryIdentity {
  const r = object(value, 'kind accountId instrumentId sourceId configHash manifestHash pauseRevision actor operationId');
  researchAssert(['MARKETAUX_PRODUCER_QUIESCENCE','WSH_ENDPOINT_RESET'].includes(String(r.kind)) && isResearchHash(r.configHash) && isResearchHash(r.manifestHash) && isRecoveryUuid(r.operationId)
    && integer(r.pauseRevision) && typeof r.actor === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(r.actor)
    && typeof r.accountId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(r.accountId) && text(r.instrumentId) && text(r.sourceId), invalid);
  return structuredClone(r) as unknown as RecoveryIdentity;
}
const baseKeys = 'version kind challengeId challengeHash nonce hostIdHash platform collectorStartedAt producerCheckedAt producerRecheckedAt deploymentHash producers runningProducerIds';
export function parseRecoveryEvidence(value: unknown): RecoveryEvidence;
export function parseRecoveryEvidence(value: unknown, allowQuiescence: true): RecoveryEvidence | RecoveryQuiescenceEvidence;
export function parseRecoveryEvidence(value: unknown, allowQuiescence = false): RecoveryEvidence | RecoveryQuiescenceEvidence {
  researchAssert(value !== null && typeof value === 'object' && !Array.isArray(value), invalid);
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  researchAssert(kind === 'MARKETAUX_PRODUCER_QUIESCENCE' || kind === 'WSH_ENDPOINT_RESET' || allowQuiescence && kind === 'PRODUCER_QUIESCENCE', invalid);
  const r = object(value, baseKeys + (kind === 'WSH_ENDPOINT_RESET' ? ' endpointId endpointSettingsHash host port clientId before stopped after reconnect' : ''));
  researchAssert(r.version === 'local-research-recovery-v1' && r.platform === 'darwin' && isRecoveryUuid(r.challengeId) && isRecoveryUuid(r.nonce)
    && isResearchHash(r.challengeHash) && isResearchHash(r.hostIdHash) && isResearchHash(r.deploymentHash), invalid);
  const start = date(r.collectorStartedAt), checked = date(r.producerCheckedAt), end = date(r.producerRecheckedAt);
  researchAssert(start <= checked && checked <= end && end - start <= 900000, invalid);
  array(r.runningProducerIds,0,0);const producers=array(r.producers,1,16);
  const ids = new Set<string>();
  for (const item of producers) {
    const p = object(item, 'containerId imageId project service startedAt finishedAt state');
    researchAssert(isResearchHash(p.containerId) && !ids.has(p.containerId) && typeof p.imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(p.imageId)
      && typeof p.project === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(p.project) && p.service === 'llm-agent' && ['exited','dead'].includes(String(p.state))
      && date(p.startedAt) <= date(p.finishedAt) && date(p.finishedAt) <= checked, invalid); ids.add(p.containerId);
  }
  if (kind === 'WSH_ENDPOINT_RESET') {
    researchAssert(text(r.endpointId) && typeof r.host === 'string' && ['localhost','127.0.0.1','::1','host.docker.internal'].includes(r.host) && integer(r.port,65535) && integer(r.clientId,2147483647)
      && r.endpointSettingsHash === researchHash({endpointId:r.endpointId,host:r.host,port:r.port,clientId:r.clientId}), invalid);
    const before = object(r.before,'observedAt process'), after = object(r.after,'observedAt process'), stopped = object(r.stopped,'observedAt processAbsent listenerAbsent');
    const old = object(before.process,'pid startIdentity executableHash'), next = object(after.process,'pid startIdentity executableHash');
    for (const p of [old,next]) researchAssert(integer(p.pid) && text(p.startIdentity,128) && isResearchHash(p.executableHash), invalid);
    researchAssert(old.startIdentity !== next.startIdentity && stopped.processAbsent === true && stopped.listenerAbsent === true, invalid);
    const reconnect = object(r.reconnect,'startedAt completedAt sessionId accountId serverVersion sdkVersion cleanup');
    researchAssert(isRecoveryUuid(reconnect.sessionId) && text(reconnect.accountId,80) && integer(reconnect.serverVersion) && reconnect.sdkVersion === '1.6.10', invalid);
    const c = object(reconnect.cleanup,'sessionId state verifiedLocalClosure completedAt cancellationAttemptedAt disconnectRequestedAt localClosedAt');
    researchAssert(c.sessionId === reconnect.sessionId && c.state === 'CONFIRMED' && c.verifiedLocalClosure === true && c.localClosedAt !== null && c.disconnectRequestedAt !== null, invalid);
    const complete = date(c.completedAt), reconnectStart=date(reconnect.startedAt);
    researchAssert(reconnectStart<=date(c.disconnectRequestedAt) && date(c.disconnectRequestedAt)<=date(c.localClosedAt) && date(c.localClosedAt)<=complete
      && (c.cancellationAttemptedAt===null || reconnectStart<=date(c.cancellationAttemptedAt) && date(c.cancellationAttemptedAt)<=date(c.localClosedAt)),invalid);
    for (const stamp of [c.cancellationAttemptedAt,c.disconnectRequestedAt,c.localClosedAt]) if (stamp !== null) researchAssert(date(stamp) <= complete, invalid);
    researchAssert(start <= date(before.observedAt) && date(before.observedAt) < date(stopped.observedAt) && date(stopped.observedAt) < date(after.observedAt)
      && date(after.observedAt) <= date(reconnect.startedAt) && date(reconnect.startedAt) <= date(reconnect.completedAt) && date(reconnect.completedAt) <= complete && complete <= end, invalid);
  }
  researchAssert(Buffer.byteLength(JSON.stringify(r),'utf8') <= 32768, invalid);
  return structuredClone(r) as unknown as RecoveryEvidence | RecoveryQuiescenceEvidence;
}

export interface ResearchRecoveryDiagnostic {
  state: 'NOT_REQUIRED' | 'WAITING' | 'OPERATOR_REQUIRED' | 'PREPARED' | 'RECOVERED';
  reason: string | null; nextCheckAt: string | null;
  operatorAction: 'STOP_PRODUCERS' | 'OBSERVE_LOCAL_GATEWAY_RESTART' | 'COMPLETE_RECONNECT_PROOF' | 'UNSUPPORTED_ENDPOINT' | null;
  challengeId: string | null; lastRecoveryId: string | null;
}
