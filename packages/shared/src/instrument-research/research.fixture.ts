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
    model: { provider: "openai", model: "fixture-model", promptVersion: "pp4-research-v1", outputSchemaVersion: "pp4-decision-v1", maxInputChars: 100000, maxOutputTokens: 1000, maxCostMicrosPerCall: 100, maxRequestsPerDay: 1, maxCostMicrosPerDay: 100 },
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
