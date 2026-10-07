import type { ResearchSource, ResearchInstrumentPolicy, ResearchSourceResult } from "./types.js";
import { canonicalJson } from "../trading-configuration/identity.js";
import { researchAssert, researchTime, isResearchHash, researchHash } from "./validation.js";

export interface WshConfig {
  kind: "ibkr-wsh-v1";
  endpointId: string;
  conId: number;
  isin: string;
  issuerTimeZone: string;
  qualification: { id: string; validFrom: string; expiresAt: string; endpointOwnershipRef: string; metadataHash: string };
  entitlement: { reference: string; validFrom: string; expiresAt: string; termsReference: string };
  lookbackDays: 7;
  lookaheadDays: 45;
  edgeDays: 2;
  totalLimit: 100;
  timeoutMs: number;
  maxEventBytes: 1048576;
  maxMetadataBytes: 524288;
  refreshIntervalMs: 900000;
  maxAgeMs: 900000;
}
export interface WshLocator {
  transport: "IBKR_SOCKET"; endpointId: string; sessionId: string; requestId: number;
  requestHash: string; receiptHash: string; metadataHash: string; serverVersion: number; sdkVersion: string;
}
export interface WshEvidence {
  kind: "wsh-calendar"; ref: string; sourceId: string; documentId: string;
  issuerId: string; issuerIdentifier: { scheme: "ISIN"; value: string };
  published: null; knowledgeBasis: "FIRST_OBSERVED"; firstObservedAt: string; receiptAt: string;
  versionHash: string; locator: WshLocator;
  automation: ResearchSource["automation"]; retention: ResearchSource["retention"];
}
export type WshValue = null | boolean | number | string | WshValue[] | { [key: string]: WshValue };
export interface WshEvent {
  kind: "wsh-calendar"; id: string; providerEventKey: string; providerEventType: string;
  issuerIsin: string; conIds: number[]; status: string | null;
  interpretation: "EARNINGS" | "SHAREHOLDER_MEETING" | "EPS" | "GENERIC_PROVIDER_EVENT";
  metadataDescription: "AVAILABLE" | "METADATA_DESCRIPTION_UNAVAILABLE";
  statusInterpretation: "RECOGNIZED" | "UNKNOWN_INTERPRETATION";
  context: { [key: string]: WshValue }; sourceFields: { [key: string]: WshValue };
  versionHash: string; evidenceRef: string;
}
export interface WshAcquisitionReceipt {
  contractVersion: "ibkr-wsh-v1"; coverageBasis: "PROVIDER_REPORTED_QUERY";
  acquisitionId: string; generation: number; sessionId: string; requestId: number;
  requestAsOf: string; requestStartDate: string; requestEndDate: string; totalLimit: 100; rowCount: number; duplicateCount: number;
  requestHash: string; receiptHash: string; metadataHash: string;
  qualificationId: string; qualificationExpiresAt: string; entitlementReference: string; entitlementExpiresAt: string;
}
export interface WshSourceResult extends Omit<ResearchSourceResult, "acquisition"> { wshAcquisition: WshAcquisitionReceipt; role: "calendar" }
export interface WshAcquisition {
  id: string; endpointId: string; generation: number; sessionId: string; sourceId: string;
  instrumentId: string; configHash: string; manifestHash: string; startedAt: string;
}
export interface WshAcquisitionRecord extends Record<string, unknown> {
  id: string; endpoint_id: string; generation: number; session_id: string; source_id: string;
  instrument_id: string; config_hash: string; manifest_hash: string; state: "PENDING" | "PUBLISHED" | "FAILED" | "UNKNOWN";
  retired_at: unknown | null; snapshot_id: string | null;
}
export interface WshEndpointLease { endpointId: string; assertHeld(): Promise<void> }

function exact(value: unknown, keys: string): Record<string, unknown> {
  researchAssert(value !== null && typeof value === "object" && !Array.isArray(value));
  const obj = value as Record<string, unknown>;
  researchAssert(Object.keys(obj).sort().join(" ") === keys.split(" ").sort().join(" "), "RESEARCH_WSH_CONFIG_INVALID"); return obj;
}
function nonempty(value: unknown): void { researchAssert(typeof value === "string" && value.trim().length > 0 && value.length <= 500, "RESEARCH_WSH_CONFIG_INVALID"); }
export function validateWshValue(value: unknown, depth = 0): asserts value is WshValue {
  researchAssert(depth <= 6, "RESEARCH_WSH_CONTEXT_LIMIT");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { researchAssert(value.length <= 4000, "RESEARCH_WSH_CONTEXT_LIMIT"); return; }
  if (typeof value === "number") { researchAssert(Number.isFinite(value) && !Object.is(value, -0), "RESEARCH_WSH_VALUE_INVALID"); return; }
  researchAssert(value && typeof value === "object" && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype), "RESEARCH_WSH_VALUE_INVALID");
  researchAssert(Array.isArray(value) ? value.length <= 100 : Object.keys(value).length <= 128, "RESEARCH_WSH_CONTEXT_LIMIT");
  for (const [key, item] of Object.entries(value)) { researchAssert(key.length <= 4000, "RESEARCH_WSH_CONTEXT_LIMIT"); validateWshValue(item, depth + 1); }
}
export function parseWshConfig(source: ResearchSource, policy: ResearchInstrumentPolicy): WshConfig {
  researchAssert(source.adapter === "ibkr-wsh" && source.provider === "ibkr-wsh" && source.roles.length === 1 && source.roles[0] === "calendar" && source.urls.length === 0, "RESEARCH_WSH_SOURCE_INVALID");
  const c = exact(source.parserConfig, "kind endpointId conId isin issuerTimeZone qualification entitlement lookbackDays lookaheadDays edgeDays totalLimit timeoutMs maxEventBytes maxMetadataBytes refreshIntervalMs maxAgeMs");
  researchAssert(c.kind === "ibkr-wsh-v1" && c.conId === policy.listing.conId && source.issuerIdentifier.scheme === "ISIN" && c.isin === source.issuerIdentifier.value && policy.identifiers.some(i => i.scheme === "ISIN" && i.value === c.isin), "RESEARCH_WSH_IDENTITY_INVALID");
  nonempty(c.endpointId); nonempty(c.issuerTimeZone);
  researchAssert(typeof c.issuerTimeZone === "string" && (c.issuerTimeZone === "UTC" || c.issuerTimeZone.includes("/")), "RESEARCH_TIMEZONE_INVALID");
  try { new Intl.DateTimeFormat("en", { timeZone: String(c.issuerTimeZone) }).format(); } catch { throw new Error("RESEARCH_TIMEZONE_INVALID"); }
  const q = exact(c.qualification, "id validFrom expiresAt endpointOwnershipRef metadataHash"), e = exact(c.entitlement, "reference validFrom expiresAt termsReference");
  for (const field of [q.id, q.endpointOwnershipRef, e.reference, e.termsReference]) nonempty(field);
  researchAssert(isResearchHash(q.metadataHash) && researchTime(q.validFrom) < researchTime(q.expiresAt) && researchTime(e.validFrom) < researchTime(e.expiresAt), "RESEARCH_WSH_QUALIFICATION_INVALID");
  researchAssert(c.lookbackDays === 7 && c.lookaheadDays === 45 && c.edgeDays === 2 && c.totalLimit === 100 && c.maxEventBytes === 1048576 && c.maxMetadataBytes === 524288 && c.refreshIntervalMs === 900000 && c.maxAgeMs === 900000 && Number.isInteger(c.timeoutMs) && Number(c.timeoutMs) > 0 && Number(c.timeoutMs) <= 10000, "RESEARCH_WSH_BOUNDS_INVALID");
  return structuredClone(c) as unknown as WshConfig;
}
export function wshQualificationDeadline(config: WshConfig, nowMs: number): number {
  researchAssert(nowMs >= researchTime(config.qualification.validFrom) && nowMs >= researchTime(config.entitlement.validFrom), "RESEARCH_WSH_QUALIFICATION_UNAVAILABLE");
  const deadline = Math.min(researchTime(config.qualification.expiresAt), researchTime(config.entitlement.expiresAt));
  researchAssert(nowMs < deadline, "RESEARCH_WSH_QUALIFICATION_UNAVAILABLE"); return deadline;
}
export function wshLedgerKey(isin: string): string { return `ibkr-wsh:${isin}`; }
export function wshEventVersionProjection(event: Omit<WshEvent, "id" | "versionHash" | "evidenceRef">): unknown {
  return { providerEventKey: event.providerEventKey, providerEventType: event.providerEventType, issuerIsin: event.issuerIsin, conIds: [...event.conIds].sort((a,b) => a-b), status: event.status, interpretation: event.interpretation, metadataDescription: event.metadataDescription, statusInterpretation: event.statusInterpretation, context: event.context, sourceFields: event.sourceFields };
}
export function assertWshReceiptIdentity(receipt: WshAcquisitionReceipt, config: WshConfig): void {
  exact(receipt, "contractVersion coverageBasis acquisitionId generation sessionId requestId requestAsOf requestStartDate requestEndDate totalLimit rowCount duplicateCount requestHash receiptHash metadataHash qualificationId qualificationExpiresAt entitlementReference entitlementExpiresAt");
  researchAssert(receipt.contractVersion === "ibkr-wsh-v1" && receipt.coverageBasis === "PROVIDER_REPORTED_QUERY" && receipt.totalLimit === 100 && Number.isInteger(receipt.rowCount) && receipt.rowCount >= 0 && receipt.rowCount < 100 && Number.isInteger(receipt.duplicateCount) && receipt.duplicateCount >= 0 && receipt.duplicateCount <= receipt.rowCount, "RESEARCH_WSH_RECEIPT_INVALID");
  for (const h of [receipt.requestHash,receipt.receiptHash,receipt.metadataHash]) researchAssert(isResearchHash(h));
  for (const id of [receipt.acquisitionId,receipt.sessionId]) nonempty(id);
  for (const n of [receipt.generation,receipt.requestId]) researchAssert(Number.isSafeInteger(n) && n > 0);
  const dates = wshRequestDates(config, receipt.requestAsOf);
  researchAssert(receipt.requestStartDate === dates.startDate && receipt.requestEndDate === dates.endDate, "RESEARCH_WSH_REQUEST_INVALID");
  researchAssert(receipt.requestHash === researchHash({ endpointId: config.endpointId, sessionId: receipt.sessionId, requestId: receipt.requestId, method: "reqWshEventData", request: { conId: config.conId, filter: "", fillWatchlist: false, fillPortfolio: false, fillCompetitors: false, startDate: dates.startDate, endDate: dates.endDate, totalLimit: 100 } }), "RESEARCH_WSH_REQUEST_HASH_INVALID");
  researchAssert(/^\d{8}$/.test(receipt.requestStartDate) && /^\d{8}$/.test(receipt.requestEndDate) && receipt.requestStartDate < receipt.requestEndDate, "RESEARCH_WSH_REQUEST_INVALID");
  researchAssert(canonicalJson([receipt.qualificationId,receipt.qualificationExpiresAt,receipt.entitlementReference,receipt.entitlementExpiresAt,receipt.metadataHash]) === canonicalJson([config.qualification.id,config.qualification.expiresAt,config.entitlement.reference,config.entitlement.expiresAt,config.qualification.metadataHash]), "RESEARCH_WSH_QUALIFICATION_MISMATCH");
}
export function validateWshEvidence(raw: unknown, policy: ResearchInstrumentPolicy, createdAt: string): asserts raw is WshEvidence {
  const e = exact(raw, "kind ref sourceId documentId issuerId issuerIdentifier published knowledgeBasis firstObservedAt receiptAt versionHash locator automation retention");
  const source = policy.sources.find(s => s.id === e.sourceId); researchAssert(source?.adapter === "ibkr-wsh", "RESEARCH_WSH_SOURCE_INVALID");
  const config = parseWshConfig(source, policy);
  for (const value of [e.ref,e.documentId]) nonempty(value);
  researchAssert(e.kind === "wsh-calendar" && e.published === null && e.knowledgeBasis === "FIRST_OBSERVED" && e.issuerId === policy.issuerId && canonicalJson(e.issuerIdentifier) === canonicalJson(source.issuerIdentifier) && isResearchHash(e.versionHash), "RESEARCH_WSH_EVIDENCE_INVALID");
  researchAssert(researchTime(e.firstObservedAt) <= researchTime(createdAt) && researchTime(e.receiptAt) <= researchTime(createdAt), "RESEARCH_WSH_KNOWLEDGE_INVALID");
  researchAssert(e.automation === source.automation && e.retention === source.retention, "RESEARCH_WSH_PERMISSION_MISMATCH");
  const l = exact(e.locator, "transport endpointId sessionId requestId requestHash receiptHash metadataHash serverVersion sdkVersion");
  researchAssert(l.transport === "IBKR_SOCKET" && l.endpointId === config.endpointId && Number.isSafeInteger(l.requestId) && Number(l.requestId) > 0 && Number.isSafeInteger(l.serverVersion) && Number(l.serverVersion) >= 173 && l.sdkVersion === "1.6.10", "RESEARCH_WSH_LOCATOR_INVALID");
  nonempty(l.sessionId); for (const h of [l.requestHash,l.receiptHash,l.metadataHash]) researchAssert(isResearchHash(h));
  researchAssert(l.metadataHash === config.qualification.metadataHash, "RESEARCH_WSH_METADATA_MISMATCH");
}
export function validateWshEvent(raw: unknown, policy: ResearchInstrumentPolicy, evidence: unknown[]): asserts raw is WshEvent {
  const e = exact(raw, "kind id providerEventKey providerEventType issuerIsin conIds status interpretation metadataDescription statusInterpretation context sourceFields versionHash evidenceRef");
  for (const text of [e.id,e.providerEventKey,e.providerEventType,e.evidenceRef]) nonempty(text);
  researchAssert(e.kind === "wsh-calendar" && Array.isArray(e.conIds) && e.conIds.length > 0 && e.conIds.length <= 100 && e.conIds.every(n => Number.isSafeInteger(n) && n > 0) && e.conIds.includes(policy.listing.conId) && policy.identifiers.some(i => i.scheme === "ISIN" && i.value === e.issuerIsin), "RESEARCH_WSH_IDENTITY_INVALID");
  researchAssert(e.status === null || typeof e.status === "string" && e.status.length <= 4000);
  researchAssert(["EARNINGS","SHAREHOLDER_MEETING","EPS","GENERIC_PROVIDER_EVENT"].includes(String(e.interpretation)) && ["AVAILABLE","METADATA_DESCRIPTION_UNAVAILABLE"].includes(String(e.metadataDescription)) && ["RECOGNIZED","UNKNOWN_INTERPRETATION"].includes(String(e.statusInterpretation)));
  for (const value of [e.context,e.sourceFields]) { researchAssert(value && typeof value === "object" && !Array.isArray(value)); validateWshValue(value); }
  researchAssert(isResearchHash(e.versionHash) && researchHash(wshEventVersionProjection(e as unknown as WshEvent)) === e.versionHash, "RESEARCH_WSH_VERSION_HASH_INVALID");
  const ref = evidence.find(x => x && typeof x === "object" && (x as WshEvidence).ref === e.evidenceRef) as WshEvidence | undefined;
  researchAssert(ref?.kind === "wsh-calendar" && ref.versionHash === e.versionHash && ref.issuerIdentifier.value === e.issuerIsin && ref.documentId === e.providerEventKey, "RESEARCH_WSH_EVENT_EVIDENCE_INVALID");
}
export function validateWshCoverage(raw: unknown, policy: ResearchInstrumentPolicy, evidence: unknown[], createdAt: string): asserts raw is WshSourceResult {
  const c = exact(raw, "sourceId role status checkedAt windowStart windowEnd complete evidenceRefs reason wshAcquisition");
  const source = policy.sources.find(s => s.id === c.sourceId); researchAssert(source?.adapter === "ibkr-wsh");
  const config = parseWshConfig(source, policy), receipt = c.wshAcquisition as WshAcquisitionReceipt;
  assertWshReceiptIdentity(receipt, config);
  researchAssert(c.role === "calendar" && c.complete === true && (c.status === "AVAILABLE" || c.status === "EMPTY") && (c.status === "EMPTY") === (receipt.rowCount === 0), "RESEARCH_WSH_COVERAGE_INVALID");
  researchAssert(researchTime(receipt.requestAsOf) <= researchTime(c.checkedAt) && researchTime(c.checkedAt) - researchTime(receipt.requestAsOf) <= 30000 && researchTime(c.checkedAt) <= researchTime(createdAt) && researchTime(c.windowStart) <= researchTime(c.windowEnd) && researchTime(c.windowEnd) <= researchTime(c.checkedAt));
  researchAssert(typeof c.reason === "string" && c.reason.length <= 1000 && Array.isArray(c.evidenceRefs) && new Set(c.evidenceRefs).size === c.evidenceRefs.length);
  const own = (evidence as WshEvidence[]).filter(e => e.sourceId === source.id);
  researchAssert(own.length === receipt.rowCount - receipt.duplicateCount && own.length === c.evidenceRefs.length && own.every(e => (c.evidenceRefs as unknown[]).includes(e.ref)), "RESEARCH_WSH_ROW_COUNT_MISMATCH");
  for (const e of own) researchAssert(e.kind === "wsh-calendar" && e.receiptAt === c.checkedAt && e.locator.sessionId === receipt.sessionId && e.locator.requestId === receipt.requestId && e.locator.requestHash === receipt.requestHash && e.locator.receiptHash === receipt.receiptHash && e.locator.metadataHash === receipt.metadataHash, "RESEARCH_WSH_RECEIPT_MISMATCH");
}

export function wshRequestDates(config: WshConfig, asOf: string): { startDate: string; endDate: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: config.issuerTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(researchTime(asOf));
  const day = ["year","month","day"].map(k => parts.find(p => p.type === k)!.value).join("-");
  const shifted = (days: number) => new Date(Date.parse(day) + days * 86400000).toISOString().slice(0,10).replaceAll("-", "");
  return { startDate: shifted(-config.lookbackDays-config.edgeDays), endDate: shifted(config.lookaheadDays+config.edgeDays) };
}
