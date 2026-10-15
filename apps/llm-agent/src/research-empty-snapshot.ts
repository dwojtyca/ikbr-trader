import { isTwoSourceResearch, researchHash, type ResearchInstrumentPolicy, type ResearchManifest, type ResearchSnapshot } from "@ikbr/shared/instrument-research";

export function emptyResearchSnapshot(manifest: ResearchManifest, manifestHash: string, policy: ResearchInstrumentPolicy, createdAt: string): ResearchSnapshot {
  const common = { configHash: manifest.configHash, manifestHash, instrumentId: policy.instrumentId,
    mappingHash: researchHash(policy), createdAt, evidence: [], coverage: [], news: [], events: [] };
  return isTwoSourceResearch(manifest)
    ? { ...common, schemaVersion: 2, researchPolicy: "TWO_SOURCE_HOURLY_V1" }
    : { ...common, schemaVersion: manifest.schemaVersion, reports: [], facts: [] };
}
