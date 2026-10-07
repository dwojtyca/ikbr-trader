import { createHash } from "node:crypto";
import {
  parseResearchSnapshot, parseWshConfig, researchAssert, researchHash, validateWshValue,
  wshQualificationDeadline, wshRequestDates,
  type InstrumentResearchSnapshotV2, type ResearchCallReservation, type ResearchInstrumentPolicy,
  type ResearchManifest, type ResearchSource, type ResearchStore, type WshAcquisition, type WshEndpointLease,
} from "@ikbr/shared/instrument-research";
import { normalizeWshEvents } from "./research-wsh-normalization.js";
import { WshSocketTransport, type WshEventRequest, type WshRuntimeConfiguration, type WshTransport } from "./research-wsh-transport.js";

export type WshRefreshStore = Pick<ResearchStore, "latestSnapshot" | "readSnapshot" | "storeSnapshot" | "recordCallOutcome" |
  "withWshEndpointLock" | "pendingWshAcquisition" | "beginWshAcquisition" | "reserveWshCall" | "assertWshAcquisition" |
  "publishWshSnapshot" | "finishWshFailure" | "retireWshAcquisition" | "readWshAcquisition">;
export interface WshRefreshRuntime { runtime: WshRuntimeConfiguration; createTransport?: () => WshTransport }
interface Options {
  manifest: ResearchManifest; manifestHash: string; accountId: string; policy: ResearchInstrumentPolicy;
  source: ResearchSource; store: WshRefreshStore; slotKey: string; now?: () => number; wsh?: WshRefreshRuntime;
}
function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new Error("RESEARCH_WSH_PAYLOAD_INVALID"); }
}
const hashBytes = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function failureCode(error: unknown): string {
  return error instanceof Error && /^RESEARCH_[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : "RESEARCH_WSH_REFRESH_FAILED";
}
function uncertain(error: unknown): boolean {
  return !/^RESEARCH_WSH_(?:ERROR_\d+|ROW_|IDENTITY_|DATE_|STATUS_|CONTEXT_|METADATA_|PAYLOAD_|REQUEST_|BOUNDS_|QUALIFICATION_|PROTOCOL_|ACCOUNT_)/.test(failureCode(error));
}

export async function refreshWsh(options: Options): Promise<boolean> {
  const { manifest, manifestHash, policy, source, store, slotKey } = options;
  const now = options.now ?? Date.now;
  researchAssert(manifest.schemaVersion === 2, "RESEARCH_WSH_VERSION_INVALID");
  const identity = { configHash: manifest.configHash, manifestHash, instrumentId: policy.instrumentId };
  const previous = await store.latestSnapshot(identity);
  researchAssert(!previous || previous.snapshot.schemaVersion === 2, "RESEARCH_WSH_VERSION_INVALID");
  const snapshot: InstrumentResearchSnapshotV2 = previous ? structuredClone(previous.snapshot as InstrumentResearchSnapshotV2) : {
    schemaVersion: 2, ...identity, mappingHash: researchHash(policy), createdAt: new Date(now()).toISOString(),
    evidence: [], coverage: [], reports: [], facts: [], news: [], events: [],
  };
  const oldRefs = new Set(snapshot.evidence.filter(e => e.sourceId === source.id).map(e => e.ref));
  snapshot.evidence = snapshot.evidence.filter(e => !oldRefs.has(e.ref));
  snapshot.events = snapshot.events.filter(e => !oldRefs.has(e.evidenceRef));
  snapshot.coverage = snapshot.coverage.filter(c => c.sourceId !== source.id);
  const baseline = structuredClone(snapshot);
  const negative = (status: "UNVERIFIED" | "ERROR", reason: string): InstrumentResearchSnapshotV2 => {
    const result = structuredClone(baseline), checkedAt = new Date(now()).toISOString();
    result.createdAt = checkedAt;
    result.coverage.push({ sourceId: source.id, role: "calendar", status, checkedAt, windowStart: checkedAt, windowEnd: checkedAt,
      complete: false, evidenceRefs: [], reason });
    parseResearchSnapshot(result, manifest); return result;
  };
  let config: ReturnType<typeof parseWshConfig>;
  try {
    config = parseWshConfig(source, policy);
    researchAssert(options.wsh?.runtime.enabled, "RESEARCH_WSH_DISABLED");
    researchAssert(options.wsh.runtime.endpointId === config.endpointId, "RESEARCH_WSH_ENDPOINT_MISMATCH");
    researchAssert(source.automation === "PERMITTED" && source.retention === "FACTS_AND_REFERENCES" && source.maxRequestsPerDay > 0 && source.costMicrosPerCall <= source.maxCostMicrosPerDay, "RESEARCH_WSH_PERMISSION_UNVERIFIED");
    wshQualificationDeadline(config, now());
  } catch (error) { await store.storeSnapshot(negative("UNVERIFIED", failureCode(error)), slotKey); return true; }

  let attempted = true;
  const locked = await store.withWshEndpointLock(config.endpointId, async lease => {
    const pending = await store.pendingWshAcquisition(lease);
    if (pending) {
      // Recovery never replays either call from an abandoned transport session.
      if (pending.configHash === identity.configHash && pending.manifestHash === identity.manifestHash && pending.instrumentId === identity.instrumentId && pending.sourceId === source.id) {
        await finishFailure(lease, pending, negative("ERROR", "RESEARCH_WSH_ABANDONED_ACQUISITION"), "UNKNOWN");
        return;
      }
      try { await store.retireWshAcquisition(lease, pending, "UNKNOWN"); }
      catch (error) { if (!await retired(pending)) throw error; }
    }
    const transport = options.wsh!.createTransport?.() ?? new WshSocketTransport({ ...options.wsh!.runtime, accountId: options.accountId });
    let acquisition: WshAcquisition | null = null;
    let publicationAttempted = false;
    try {
      const requestAsOf = new Date(now()).toISOString();
      const admissionDeadline = Math.min(now() + 30000, wshQualificationDeadline(config, now()));
      const deadline = () => new Date(Math.min(now() + config.timeoutMs, admissionDeadline)).toISOString();
      const checkpoint = async (callDeadline?: string) => {
        wshQualificationDeadline(config, now());
        researchAssert(now() < admissionDeadline && (!callDeadline || now() < Date.parse(callDeadline)), "RESEARCH_WSH_TIMEOUT");
        if (acquisition) await store.assertWshAcquisition(lease, acquisition); else await lease.assertHeld();
      };
      const providers = manifest.instruments.flatMap(p => p.sources).filter(s => s.provider === source.provider);
      const reservation = (requestId: number, method: string, request: unknown, deadlineAt: string): ResearchCallReservation => {
        const requestHash = researchHash({ endpointId: config.endpointId, sessionId: transport.sessionId, requestId, method, request });
        return { accountId: options.accountId, provider: source.provider, kind: "source", configHash: manifest.configHash, manifestHash,
          callKey: "research_wsh_" + researchHash({ ...identity, sourceId: source.id, slotKey, requestHash }), requestHash,
          reservedCostMicros: Math.max(...providers.map(s => s.costMicrosPerCall)), maxRequestsPerDay: Math.min(...providers.map(s => s.maxRequestsPerDay)),
          maxCostMicrosPerDay: Math.min(...providers.map(s => s.maxCostMicrosPerDay)), deadlineAt };
      };
      await checkpoint();
      await transport.connect(deadline());
      researchAssert(transport.serverVersion >= 173 && transport.sdkVersion === "1.6.10", "RESEARCH_WSH_PROTOCOL_UNSUPPORTED");
      const metadataCall = reservation(1, "reqWshMetaData", null, deadline());
      acquisition = await store.beginWshAcquisition(lease, { ...identity, sourceId: source.id, sessionId: transport.sessionId, reservation: metadataCall });
      await checkpoint(metadataCall.deadlineAt);
      const rawMetadata = await transport.metadata(1, metadataCall.deadlineAt, config.maxMetadataBytes);
      await checkpoint(metadataCall.deadlineAt);
      researchAssert(Buffer.byteLength(rawMetadata) <= config.maxMetadataBytes, "RESEARCH_WSH_PAYLOAD_LIMIT");
      const metadataHash = hashBytes(rawMetadata);
      researchAssert(metadataHash === config.qualification.metadataHash, "RESEARCH_WSH_METADATA_MISMATCH");
      const metadata = parseJson(rawMetadata);
      validateWshValue(metadata);
      researchAssert(metadata && typeof metadata === "object" && !Array.isArray(metadata) && "meta_data" in metadata &&
        metadata.meta_data && typeof metadata.meta_data === "object" && !Array.isArray(metadata.meta_data) && "event_types" in metadata.meta_data && Array.isArray(metadata.meta_data.event_types), "RESEARCH_WSH_METADATA_INVALID");
      await store.recordCallOutcome(metadataCall.callKey, "SUCCEEDED");
      const dates = wshRequestDates(config, requestAsOf);
      const request: WshEventRequest = { conId: config.conId, filter: "", fillWatchlist: false, fillPortfolio: false, fillCompetitors: false, ...dates, totalLimit: 100 };
      const eventsCall = reservation(2, "reqWshEventData", request, deadline());
      await store.reserveWshCall(lease, acquisition, eventsCall);
      await checkpoint(eventsCall.deadlineAt);
      const rawEvents = await transport.events(2, request, eventsCall.deadlineAt, config.maxEventBytes);
      await checkpoint(eventsCall.deadlineAt);
      researchAssert(Buffer.byteLength(rawEvents) <= config.maxEventBytes, "RESEARCH_WSH_PAYLOAD_LIMIT");
      const normalized = normalizeWshEvents(parseJson(rawEvents), metadata, config);
      const receiptAt = new Date(now()).toISOString(), receiptHash = hashBytes(rawEvents);
      // Observation time is only a validation placeholder; the store replaces it with the durable DB observation.
      for (const event of normalized.events) {
        const ref = "wsh_ev_" + researchHash({ sourceId: source.id, key: event.providerEventKey, versionHash: event.versionHash });
        snapshot.events.push({ ...event, evidenceRef: ref });
        snapshot.evidence.push({ kind: "wsh-calendar", ref, sourceId: source.id, documentId: event.providerEventKey,
          issuerId: policy.issuerId, issuerIdentifier: { scheme: "ISIN", value: config.isin }, published: null,
          knowledgeBasis: "FIRST_OBSERVED", firstObservedAt: receiptAt, receiptAt, versionHash: event.versionHash,
          locator: { transport: "IBKR_SOCKET", endpointId: config.endpointId, sessionId: transport.sessionId, requestId: 2,
            requestHash: eventsCall.requestHash, receiptHash, metadataHash, serverVersion: transport.serverVersion, sdkVersion: transport.sdkVersion },
          automation: source.automation, retention: source.retention });
      }
      snapshot.createdAt = receiptAt;
      snapshot.coverage.push({ sourceId: source.id, role: "calendar", status: normalized.rowCount ? "AVAILABLE" : "EMPTY", checkedAt: receiptAt,
        windowStart: requestAsOf, windowEnd: receiptAt, complete: true, evidenceRefs: snapshot.evidence.filter(e => e.sourceId === source.id).map(e => e.ref),
        reason: "RESEARCH_WSH_PROVIDER_QUERY_COMPLETE", wshAcquisition: { contractVersion: "ibkr-wsh-v1", coverageBasis: "PROVIDER_REPORTED_QUERY",
          acquisitionId: acquisition.id, generation: acquisition.generation, sessionId: transport.sessionId, requestId: 2, requestAsOf,
          requestStartDate: dates.startDate, requestEndDate: dates.endDate, totalLimit: 100, rowCount: normalized.rowCount, duplicateCount: normalized.duplicateCount,
          requestHash: eventsCall.requestHash, receiptHash, metadataHash, qualificationId: config.qualification.id, qualificationExpiresAt: config.qualification.expiresAt,
          entitlementReference: config.entitlement.reference, entitlementExpiresAt: config.entitlement.expiresAt } });
      parseResearchSnapshot(snapshot, manifest);
      await checkpoint(eventsCall.deadlineAt);
      publicationAttempted = true;
      await store.publishWshSnapshot(lease, acquisition, snapshot, slotKey, new Date(admissionDeadline).toISOString());
    } catch (error) {
      transport.close();
      if (acquisition) {
        if (publicationAttempted && await published(acquisition)) return;
        await finishFailure(lease, acquisition, negative("ERROR", failureCode(error)), uncertain(error) ? "UNKNOWN" : "FAILED");
      } else {
        // begin COMMIT may be unknown: rediscover and retire, never send against an unconfirmed reservation.
        const abandoned = await store.pendingWshAcquisition(lease);
        if (abandoned?.sessionId === transport.sessionId) await finishFailure(lease, abandoned, negative("ERROR", failureCode(error)), "UNKNOWN");
        else if (failureCode(error) === "RESEARCH_WSH_SLOT_TOO_EARLY") attempted = false;
        else await store.storeSnapshot(negative("ERROR", failureCode(error)), slotKey);
      }
    } finally { transport.close(); }
  });
  return locked && attempted;

  function sameAcquisition(row: Record<string, unknown>, acquisition: WshAcquisition): boolean {
    return row.id === acquisition.id && row.session_id === acquisition.sessionId && Number(row.generation) === acquisition.generation &&
      row.endpoint_id === acquisition.endpointId && row.source_id === acquisition.sourceId && row.instrument_id === acquisition.instrumentId &&
      row.config_hash === acquisition.configHash && row.manifest_hash === acquisition.manifestHash;
  }
  async function retired(acquisition: WshAcquisition): Promise<boolean> {
    const row = await store.readWshAcquisition(acquisition.id);
    return !!row && sameAcquisition(row, acquisition) && row.retired_at != null && ["UNKNOWN", "FAILED", "PUBLISHED"].includes(String(row.state));
  }
  async function published(acquisition: WshAcquisition): Promise<boolean> {
    const row = await store.readWshAcquisition(acquisition.id);
    if (!row || row.state !== "PUBLISHED" || typeof row.snapshot_id !== "string") return false;
    researchAssert(sameAcquisition(row, acquisition), "RESEARCH_WSH_COMMIT_UNVERIFIED");
    const stored = await store.readSnapshot(row.snapshot_id);
    const receipt = stored?.snapshot.coverage.find(c => c.sourceId === acquisition.sourceId);
    researchAssert(stored && stored.snapshot.configHash === acquisition.configHash && stored.snapshot.manifestHash === acquisition.manifestHash && stored.snapshot.instrumentId === acquisition.instrumentId &&
      receipt && "wshAcquisition" in receipt && receipt.wshAcquisition.acquisitionId === acquisition.id && receipt.wshAcquisition.sessionId === acquisition.sessionId && receipt.wshAcquisition.generation === acquisition.generation, "RESEARCH_WSH_COMMIT_UNVERIFIED");
    return true;
  }
  async function finishFailure(lease: WshEndpointLease, acquisition: WshAcquisition, failure: InstrumentResearchSnapshotV2, outcome: "FAILED" | "UNKNOWN"): Promise<void> {
    try { await store.finishWshFailure(lease, acquisition, failure, outcome, slotKey); }
    catch (error) {
      const row = await store.readWshAcquisition(acquisition.id);
      if (row && sameAcquisition(row, acquisition) && row.retired_at != null && typeof row.snapshot_id === "string" && ["FAILED", "UNKNOWN"].includes(String(row.state))) {
        const stored = await store.readSnapshot(row.snapshot_id);
        if (stored && researchHash(stored.snapshot) === researchHash(failure)) return;
      }
      // A failed negative publication cannot refresh the prior head or release an unresolved generation.
      throw error;
    }
  }
}
