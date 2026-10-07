import { parseWshConfig, wshRequestDates, wshEventVersionProjection } from "./wsh.js";
import { readFileSync } from "node:fs";
import { parseTradingConfiguration } from "../trading-configuration/parser.js";
import { computeTradingConfigurationHash } from "../trading-configuration/identity.js";
import { researchHash } from "./validation.js";
import type { InstrumentResearchSnapshotV1, ResearchInstrumentPolicy, ResearchManifestV1, ResearchMetric } from "./types.js";

export function researchFixture(now = Date.now(), instrumentId = "aapl_smart") {
  const raw = JSON.parse(readFileSync(new URL("../../src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8"));
  const parsed = parseTradingConfiguration(raw); if (!parsed.ok) throw new Error("invalid PP1 fixture");
  const config = parsed.configuration, configHash = computeTradingConfigurationHash(config), year = new Date(now).getUTCFullYear();
  const stamp = new Date(now - 1000).toISOString(), published = new Date(now - 3600000).toISOString(), deadline = new Date(now + 30 * 86400000).toISOString();
  const manifest: ResearchManifestV1 = {
    schemaVersion: 1, configHash, refreshEnabled: false,
    model: { provider: "openai", model: "fixture-model", promptVersion: "pp7-research-context-v2", outputSchemaVersion: "pp4-decision-v1", maxInputChars: 100000, maxOutputTokens: 1000, maxCostMicrosPerCall: 100, maxRequestsPerDay: 1, maxCostMicrosPerDay: 100 },
    instruments: config.instruments.filter(i => i.entryEnabled).map((i, index): ResearchInstrumentPolicy => ({
      instrumentId: i.id, assetClass: "stock", listing: structuredClone(i.contract), issuerId: config.issuerMappings.find(m => m.id === i.issuerMappingId)!.issuerId,
      legalName: `Fixture Issuer ${index}`, country: "US", sector: "Fixture", business: "Synthetic research fixture; not live provider evidence",
      identifiers: [{ scheme: "CIK", value: String(index + 100).padStart(10, "0") }], verification: { url: "https://www.sec.gov/fixture", verifiedAt: published, outcome: "VERIFIED" },
      profile: index === 0 ? "bank" : "industrial", reportingCurrency: i.contract.currency,
      annual: { periodStart: `${year - 1}-01-01`, periodEnd: `${year - 1}-12-31`, nextPublicationDeadline: deadline, scope: "consolidated" },
      periodic: { periodStart: `${year}-01-01`, periodEnd: `${year}-06-30`, nextPublicationDeadline: deadline, scope: "consolidated" },
      bankCapitalMetric: index === 0 ? "tier1_ratio" : null,
      sources: [{ id: "official", provider: "https://www.sec.gov", adapter: "sec-json", parserConfig: {}, roles: ["reports", "news", "calendar"], urls: ["https://www.sec.gov/fixture"], issuerIdentifier: { scheme: "CIK", value: String(index + 100).padStart(10, "0") }, automation: "PERMITTED", retention: "FACTS_AND_REFERENCES", permissionEvidenceUrl: "https://www.sec.gov/fixture", maxRequestsPerDay: 10, maxCostMicrosPerDay: 0, costMicrosPerCall: 0 }],
    })),
  };
  const policy = manifest.instruments.find(i => i.instrumentId === instrumentId)!;
  const metrics: ResearchMetric[] = policy.profile === "bank" ? ["net_interest_income", "net_profit", "loans", "deposits", "tier1_ratio"] : ["revenue", "net_income", "operating_cash_flow", "total_debt"];
  const snapshot: InstrumentResearchSnapshotV1 = {
    schemaVersion: 1, configHash, manifestHash: researchHash(manifest), instrumentId, mappingHash: researchHash(policy), createdAt: stamp,
    evidence: [{ ref: "reports", sourceId: "official", documentId: "fixture-reports", url: "https://www.sec.gov/fixture", contentHash: "a".repeat(64), issuerId: policy.issuerId, issuerIdentifier: policy.identifiers[0], published: { precision: "instant", at: published }, fetchedAt: stamp, observedAt: stamp, automation: "PERMITTED", retention: "FACTS_AND_REFERENCES" }],
    coverage: ["reports", "news", "calendar"].map(role => ({ sourceId: "official", role: role as "reports" | "news" | "calendar", status: role === "reports" ? "AVAILABLE" : "EMPTY", checkedAt: stamp, windowStart: new Date(now - 1000 - 86400000).toISOString(), windowEnd: stamp,
      ...(role === "calendar" ? { occurrenceWindowStart: new Date(now - 2 * 86400000).toISOString(), occurrenceWindowEnd: new Date(now + 3 * 86400000).toISOString() } : {}),
      complete: true, evidenceRefs: role === "reports" ? ["reports"] : [], reason: "fixture-only" })),
    reports: ["annual", "periodic"].map(kind => ({ id: kind, kind: kind as "annual" | "periodic", periodStart: policy[kind as "annual" | "periodic"].periodStart, periodEnd: policy[kind as "annual" | "periodic"].periodEnd, scope: "consolidated", evidenceRef: "reports", supersedes: null })),
    facts: ["annual", "periodic"].flatMap(kind => metrics.map(metric => {
      const instant = ["total_debt", "loans", "deposits", "tier1_ratio"].includes(metric), ratio = metric === "tier1_ratio";
      return { id: `${kind}:${metric}`, reportId: kind, metric, value: ratio ? 15 : 1000, unit: ratio ? "percent" as const : "currency" as const, currency: ratio ? null : policy.reportingCurrency, scale: 1, periodStart: instant ? null : policy[kind as "annual" | "periodic"].periodStart, periodEnd: policy[kind as "annual" | "periodic"].periodEnd, periodType: instant ? "instant" as const : "duration" as const, scope: "consolidated" as const, evidenceRef: "reports", sourcePointer: `fixture:${metric}`, supersedes: null };
    })), news: [], events: [],
  };
  return { config, configuration: config, configHash, manifest, manifestHash: snapshot.manifestHash, snapshot, policy };
}

export function wshResearchFixture(now = Date.now(), instrumentId = "aapl_smart") {
  const f = researchFixture(now, instrumentId);
  const manifest: import("./types.js").ResearchManifestV2 = { ...f.manifest, schemaVersion: 2, refreshEnabled: true };
  for (const [index, p] of manifest.instruments.entries()) {
    const isin = `US00000000${String(index).padStart(2, "0")}`;
    p.identifiers.push({ scheme: "ISIN", value: isin });
    p.sources[0].roles = ["reports", "news"];
    p.sources.push({ id: "wsh", provider: "ibkr-wsh", adapter: "ibkr-wsh", roles: ["calendar"], urls: [], issuerIdentifier: { scheme: "ISIN", value: isin }, automation: "PERMITTED", retention: "FACTS_AND_REFERENCES", permissionEvidenceUrl: "https://www.wallstreethorizon.com/interactive-brokers", maxRequestsPerDay: 100, maxCostMicrosPerDay: 0, costMicrosPerCall: 0,
      parserConfig: { kind: "ibkr-wsh-v1", endpointId: "fixture-endpoint", conId: p.listing.conId, isin, issuerTimeZone: "Europe/Warsaw", qualification: { id: "fixture-qualification", validFrom: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), endpointOwnershipRef: "fixture-only", metadataHash: "c".repeat(64) }, entitlement: { reference: "fixture-only", validFrom: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), termsReference: "fixture-only" }, lookbackDays: 7, lookaheadDays: 45, edgeDays: 2, totalLimit: 100, timeoutMs: 10000, maxEventBytes: 1048576, maxMetadataBytes: 524288, refreshIntervalMs: 900000, maxAgeMs: 900000 } });
  }
  const policy = manifest.instruments.find(p => p.instrumentId === instrumentId)!, source = policy.sources.find(s => s.adapter === "ibkr-wsh")!;
  const snapshot: import("./types.js").InstrumentResearchSnapshotV2 = { ...f.snapshot, schemaVersion: 2, manifestHash: researchHash(manifest), mappingHash: researchHash(policy), news: [], coverage: f.snapshot.coverage.filter(c => c.role !== "calendar") };
  snapshot.coverage.push({ sourceId: source.id, role: "calendar", status: "MISSING", checkedAt: snapshot.createdAt, windowStart: snapshot.createdAt, windowEnd: snapshot.createdAt, complete: false, evidenceRefs: [], reason: "fixture has not acquired WSH" });
  return { ...f, manifest, manifestHash: snapshot.manifestHash, policy, source, snapshot };
}

export function wshSnapshotFixture(now = Date.now(), instrumentId = "aapl_smart", eventDate = "2026-10-07") {
  const f = wshResearchFixture(now, instrumentId), config = parseWshConfig(f.source, f.policy);
  const stamp = f.snapshot.createdAt, requestDates = wshRequestDates(config, stamp);
  const requestHash = researchHash({ endpointId: config.endpointId, sessionId: "fixture-session", requestId: 2, method: "reqWshEventData", request: { conId: config.conId, filter: "", fillWatchlist: false, fillPortfolio: false, fillCompetitors: false, ...requestDates, totalLimit: 100 } });
  const raw = { kind: "wsh-calendar" as const, providerEventKey: "fixture-event", providerEventType: "wshe_ed", issuerIsin: config.isin, conIds: [config.conId], status: "Unconfirmed", interpretation: "EARNINGS" as const, metadataDescription: "AVAILABLE" as const, statusInterpretation: "RECOGNIZED" as const, context: { earningsDate: { precision: "date", date: eventDate }, forecast: "NOT_PROVIDED" }, sourceFields: { earnings_date: eventDate, earnings_date_status: "Unconfirmed" } };
  const versionHash = researchHash(wshEventVersionProjection(raw)), ref = `wsh:${versionHash}`;
  f.snapshot.events.push({ ...raw, id: ref, versionHash, evidenceRef: ref });
  f.snapshot.evidence.push({ kind: "wsh-calendar", ref, sourceId: f.source.id, documentId: raw.providerEventKey, issuerId: f.policy.issuerId, issuerIdentifier: { scheme: "ISIN", value: config.isin }, published: null, knowledgeBasis: "FIRST_OBSERVED", firstObservedAt: stamp, receiptAt: stamp, versionHash, locator: { transport: "IBKR_SOCKET", endpointId: config.endpointId, sessionId: "fixture-session", requestId: 2, requestHash, receiptHash: "e".repeat(64), metadataHash: config.qualification.metadataHash, serverVersion: 180, sdkVersion: "1.6.10" }, automation: "PERMITTED", retention: "FACTS_AND_REFERENCES" });
  f.snapshot.coverage[f.snapshot.coverage.length-1] = { sourceId: f.source.id, role: "calendar", status: "AVAILABLE", checkedAt: stamp, windowStart: stamp, windowEnd: stamp, complete: true, evidenceRefs: [ref], reason: "Provider-reported query, fixture only", wshAcquisition: { contractVersion: "ibkr-wsh-v1", coverageBasis: "PROVIDER_REPORTED_QUERY", acquisitionId: "00000000-0000-4000-8000-000000000001", generation: 1, sessionId: "fixture-session", requestId: 2, requestAsOf: stamp, requestStartDate: requestDates.startDate, requestEndDate: requestDates.endDate, totalLimit: 100, rowCount: 1, duplicateCount: 0, requestHash, receiptHash: "e".repeat(64), metadataHash: config.qualification.metadataHash, qualificationId: config.qualification.id, qualificationExpiresAt: config.qualification.expiresAt, entitlementReference: config.entitlement.reference, entitlementExpiresAt: config.entitlement.expiresAt } };
  return { ...f, wshConfig: config };
}
