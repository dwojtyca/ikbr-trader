import type { TradingInstrumentV1 } from "../trading-configuration/types.js";

export type ResearchCoverage = "AVAILABLE" | "EMPTY" | "MISSING" | "STALE" | "UNVERIFIED" | "ERROR" | "NOT_APPLICABLE";
export type ResearchPublication = { precision: "instant"; at: string } | { precision: "date"; date: string; timeZone: string };
export type ResearchMetric = "net_interest_income" | "net_profit" | "loans" | "deposits" | "cet1_ratio" | "tier1_ratio" | "revenue" | "net_income" | "operating_cash_flow" | "total_debt";
export interface ResearchSource {
  id: string;
  provider: string;
  adapter: "sec-json" | "issuer-document";
  parserConfig: Record<string, unknown>;
  roles: ("reports" | "news" | "calendar")[];
  urls: string[];
  issuerIdentifier: { scheme: "CIK" | "LEI" | "ISIN"; value: string };
  automation: "PERMITTED" | "UNVERIFIED" | "DENIED";
  retention: "FACTS_AND_REFERENCES" | "FULL_DOCUMENT" | "UNVERIFIED" | "DENIED";
  permissionEvidenceUrl: string;
  maxRequestsPerDay: number;
  maxCostMicrosPerDay: number;
  costMicrosPerCall: number;
}
export interface ResearchReportRequirement {
  periodStart: string;
  periodEnd: string;
  nextPublicationDeadline: string;
  scope: "consolidated" | "separate";
}
export interface ResearchInstrumentPolicy {
  instrumentId: string;
  assetClass: "stock" | "etf";
  listing: TradingInstrumentV1["contract"];
  issuerId: string;
  legalName: string;
  country: string;
  sector: string;
  business: string;
  identifiers: { scheme: "CIK" | "LEI" | "ISIN"; value: string }[];
  verification: { url: string; verifiedAt: string; outcome: "VERIFIED" | "UNVERIFIED" };
  profile: "bank" | "industrial" | "etf";
  reportingCurrency: string;
  annual: ResearchReportRequirement;
  periodic: ResearchReportRequirement;
  bankCapitalMetric: "cet1_ratio" | "tier1_ratio" | null;
  sources: ResearchSource[];
}
export interface ResearchManifestV1 {
  schemaVersion: 1;
  configHash: string;
  instruments: ResearchInstrumentPolicy[];
  refreshEnabled: boolean;
  model: { provider: string; model: string; promptVersion: string; outputSchemaVersion: string; maxInputChars: number; maxOutputTokens: number; maxCostMicrosPerCall: number; maxRequestsPerDay: number; maxCostMicrosPerDay: number };
}
export interface ResearchEvidence {
  ref: string;
  sourceId: string;
  documentId: string;
  url: string;
  contentHash: string;
  issuerId: string;
  issuerIdentifier: { scheme: "CIK" | "LEI" | "ISIN"; value: string };
  published: ResearchPublication;
  fetchedAt: string;
  observedAt: string;
  automation: ResearchSource["automation"];
  retention: ResearchSource["retention"];
}
export interface ResearchSourceResult {
  sourceId: string;
  role: "reports" | "news" | "calendar";
  status: ResearchCoverage;
  checkedAt: string;
  windowStart: string;
  windowEnd: string;
  occurrenceWindowStart?: string;
  occurrenceWindowEnd?: string;
  complete: boolean;
  evidenceRefs: string[];
  reason: string;
}
export interface ResearchReport {
  id: string;
  kind: "annual" | "periodic";
  periodStart: string;
  periodEnd: string;
  scope: "consolidated" | "separate";
  evidenceRef: string;
  supersedes: string | null;
}
export interface ResearchFact {
  id: string;
  reportId: string;
  metric: ResearchMetric;
  value: number;
  unit: "currency" | "percent" | "decimal";
  currency: string | null;
  scale: number;
  periodStart: string | null;
  periodEnd: string;
  periodType: "instant" | "duration";
  scope: "consolidated" | "separate";
  evidenceRef: string;
  sourcePointer: string;
  supersedes: string | null;
}
export interface ResearchEvent { id: string; kind: "earnings" | "material" | "other"; occurs: ResearchPublication; evidenceRef: string; title: string }
export interface InstrumentResearchSnapshotV1 {
  schemaVersion: 1;
  configHash: string;
  manifestHash: string;
  instrumentId: string;
  mappingHash: string;
  createdAt: string;
  evidence: ResearchEvidence[];
  coverage: ResearchSourceResult[];
  reports: ResearchReport[];
  facts: ResearchFact[];
  news: { id: string; evidenceRef: string; title: string }[];
  events: ResearchEvent[];
}
export interface StoredResearchSnapshot { id: string; hash: string; sequence: number; snapshot: InstrumentResearchSnapshotV1 }
export interface ResearchIdentity { configHash: string; manifestHash: string }
export interface ResearchBindingIdentity extends ResearchIdentity { proposalId: number; clientOrderHash: string; instrumentId: string }
export interface ResearchBinding extends ResearchBindingIdentity { snapshotId: string; snapshotHash: string; sequence: number }
export interface ResearchEligibility { eligible: boolean; reasons: string[]; expiresAt: string | null; requiredEvidenceRefs: string[] }
export interface ValidatedResearchBinding { binding: ResearchBinding; stored: StoredResearchSnapshot; manifest: ResearchManifestV1; eligibility: ResearchEligibility }
export interface ResearchDb { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface ResearchConnection extends ResearchDb { release(): void }
export interface ResearchPool extends ResearchDb { connect(): Promise<ResearchConnection> }
export interface ResearchCallReservation extends ResearchIdentity {
  accountId: string;
  provider: string;
  kind: "source" | "model";
  callKey: string;
  requestHash: string;
  reservedCostMicros: number;
  maxRequestsPerDay: number;
  maxCostMicrosPerDay: number;
  deadlineAt: string;
}
export interface ResearchEtfDescriptor {
  fundId: string; shareClass: string; prospectusRef: string; benchmark: string; replication: string;
  holdingsRefs: string[]; concentration: number; feePercent: number; leveraged: boolean; inverse: boolean;
  distributionPolicy: string; domicile: string; currency: string; hedged: boolean; entrySupport: "NOT_SUPPORTED";
}
