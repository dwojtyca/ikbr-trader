import { isTwoSourceResearch, researchRequiredRoles } from "./policy.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { marketauxQualificationDeadline, marketauxInterval, marketauxMaxAge, parseMarketauxNewsConfig } from "./marketaux.js";
import { parseWshConfig, wshQualificationDeadline, wshRefreshIntervalMs } from "./wsh.js";
import type { ResearchIdentity, ResearchManifest, ResearchSource, StoredResearchSnapshot, ResearchProviderError, ResearchSourceError, ResearchSourceResult } from "./types.js";
import { researchHash } from "./validation.js";

export type ResearchRole = "reports" | "news" | "calendar";
export type ResearchPreparationState = "READY" | "WAITING" | "HOLD";
export interface ResearchRepairIdentity extends ResearchIdentity { accountId: string; instrumentId: string }
export interface ResearchRepairSource {
  marketauxRefresh?: import("./marketaux-refresh.js").MarketauxRefreshState;
  wshRefresh?: import("./wsh-refresh.js").WshRefreshState;
  sourceId: string; role: ResearchRole; state: ResearchPreparationState; reasons: string[]; nextCheckAt: string | null;
  providerError?: ResearchProviderError;
  sourceError?: ResearchSourceError;
  failureReason?: string;
  localBudget?: ResearchLocalBudgetDiagnostic;
}
export interface ResearchPreparation {
  state: ResearchPreparationState; reasons: string[]; snapshotId: string | null;
  sources: ResearchRepairSource[]; nextCheckAt: string | null;
}
export class ResearchPreparationNeededError extends Error {
  constructor() { super("RESEARCH_PREPARATION_WAITING"); }
}
export const researchRefreshInterval = (source: ResearchSource, role: ResearchRole): number => source.adapter === "ibkr-wsh" ? wshRefreshIntervalMs(source) : source.adapter === "marketaux-news" ? marketauxInterval(parseMarketauxNewsConfig(source)) : role === "news" ? 900_000 : 86_400_000;
export const researchRefreshSlot = (source: ResearchSource, role: ResearchRole, nowMs: number): number => Math.floor(nowMs / researchRefreshInterval(source, role));
export const researchRefreshSlotKey = (manifestHash: string, instrumentId: string, sourceId: string, role: ResearchRole, slot: number): string =>
  "research_slot_" + researchHash({ manifestHash, instrumentId, sourceId, role, slot });

export interface ResearchLocalBudgetDiagnostic {
  kind: "LOCAL_RESEARCH_BUDGET";
  failedBudgetDay: string | null; failureRecordedAt: string | null;
  currentBudgetDay: string; requestsUsed: number; maxRequestsPerDay: number;
  costUsedMicros: number; maxCostMicrosPerDay: number; nextCallCostMicros: number;
  nextBudgetResetAt: string; recoveryProof: "VERIFIED" | "UNAVAILABLE";
}
export interface MarketauxBudgetRecoveryAssessment {
  snapshotId: string; sourceId: string; coverageHash: string; slot: number;
  failedBudgetDay: string; failureRecordedAt: string; nextCheckAt: string;
}
export function marketauxLocalBudgetFailure(coverage: ResearchSourceResult): boolean {
  return coverage.status === "ERROR" && !coverage.complete && coverage.evidenceRefs.length === 0
    && coverage.reason === "RESEARCH_BUDGET_EXHAUSTED" && coverage.sourceError?.httpStatus === undefined;
}
export interface MarketauxLegacyRecoveryAssessment { snapshotId: string; sourceId: string; coverageHash: string; slot: number; nextCheckAt: string }
export function marketauxTransientFailure(coverage: ResearchSourceResult): boolean {
  if (coverage.status !== "ERROR" || coverage.complete || coverage.evidenceRefs.length) return false;
  const http = coverage.sourceError?.httpStatus;
  if (http !== undefined && ![429,500,502,503,504].includes(http)) return false;
  return ["RESEARCH_SOURCE_TIMEOUT","RESEARCH_SOURCE_TRANSPORT_TRANSIENT",... [429,500,502,503,504].map(status=>`RESEARCH_SOURCE_HTTP_${status}`)].includes(coverage.reason);
}

/** Classification grants no entry permission and never changes source evidence. */
export function inspectResearch(manifest: ResearchManifest, instrumentId: string, stored: StoredResearchSnapshot | null, nowMs: number, legacyRecoveries: readonly MarketauxLegacyRecoveryAssessment[] = [], budgetRecoveries: readonly MarketauxBudgetRecoveryAssessment[] = [], wshStates: readonly import("./wsh-refresh.js").WshRefreshState[] = [], marketauxStates: readonly import("./marketaux-refresh.js").MarketauxRefreshState[] = []): ResearchPreparation {
  const policy = manifest.instruments.find(p => p.instrumentId === instrumentId);
  const sources: ResearchRepairSource[] = [], reasons = new Set<string>();
  const hold = (reason: string) => { reasons.add(reason); };
  if (!policy || policy.assetClass !== "stock") hold("RESEARCH_INSTRUMENT_UNSUPPORTED");
  if (!Number.isFinite(nowMs)) hold("RESEARCH_TIME_INVALID");
  if (!policy || reasons.size) return { state: "HOLD", reasons: [...reasons], snapshotId: stored?.id ?? null, sources, nextCheckAt: null };
  if (policy.verification.outcome !== "VERIFIED" || Date.parse(policy.verification.verifiedAt) > nowMs) hold("RESEARCH_ISSUER_UNVERIFIED");
  if (!isTwoSourceResearch(manifest) && [policy.annual, policy.periodic].some(report => report && Date.parse(report.nextPublicationDeadline) <= nowMs)) hold("RESEARCH_EXPECTED_REPORT_OVERDUE");
  for (const role of researchRequiredRoles(manifest)) {
    const providers = policy.sources.filter(source => source.roles.includes(role));
    if (!providers.length) hold(`RESEARCH_${role.toUpperCase()}_SOURCE_UNCONFIGURED`);
    for (const source of providers) {
      const wshState=wshStates.find(s=>s.sourceId===source.id);
      const row: ResearchRepairSource = { sourceId: source.id, role, state: "READY", reasons: [], nextCheckAt: null };
      if(wshState)row.wshRefresh=wshState;
      const marketauxState = marketauxStates.find(s => s.sourceId === source.id);
      if (marketauxState) row.marketauxRefresh = marketauxState;
      const deny = (reason: string) => { row.state = "HOLD"; row.reasons.push(reason); hold(reason); };
      for(const recovery of [marketauxState?.recovery,wshState?.recovery])if(recovery?.state==='PREPARED')deny(recovery.reason??'RESEARCH_RECOVERY_MAINTENANCE_HOLD');
      if (source.automation !== "PERMITTED" || source.retention !== "FACTS_AND_REFERENCES") deny("RESEARCH_PERMISSION_UNVERIFIED");
      const kind = source.parserConfig.kind;
      const supported = role === "reports" ? (source.adapter === "sec-json" && kind === "sec-json") || (source.adapter === "issuer-document" && ["issuer-xhtml", "issuer-pdf-table"].includes(String(kind)))
        : role === "news" ? source.adapter === "marketaux-news" && (kind === "marketaux-news-v1" || kind === "marketaux-news-v2") : source.adapter === "ibkr-wsh" && kind === "ibkr-wsh-v1";
      // Declared evidence remains readable, but is never a demand-fetchable provider.
      const coverage = stored?.snapshot.coverage.find(c => c.sourceId === source.id && c.role === role);
      if (source.adapter === "ibkr-wsh" && role === "calendar" && coverage?.status === "ERROR" && coverage.providerError)
        row.providerError = { ...coverage.providerError };
      if (coverage?.status === "ERROR" && coverage.sourceError) { row.sourceError = { ...coverage.sourceError }; row.failureReason = coverage.reason; }
      if (source.adapter === "marketaux-news" && coverage && marketauxLocalBudgetFailure(coverage)) row.failureReason = coverage.reason;
      if(wshState?.latestFailure){
        if(wshState.latestFailure.sourceError)row.sourceError={...wshState.latestFailure.sourceError};
        if(wshState.latestFailure.providerError)row.providerError={...wshState.latestFailure.providerError};
        if(wshState.latestFailure.failureReason)row.failureReason=wshState.latestFailure.failureReason;
      }
      if (marketauxState) {
        for (const reason of marketauxState.holdReasons) deny(reason);
        if (marketauxState.latestFailure) { row.failureReason = marketauxState.latestFailure.reason; if (marketauxState.latestFailure.sourceError) row.sourceError = marketauxState.latestFailure.sourceError; }
      }
      if (source.adapter === "marketaux-news") {
        try { marketauxQualificationDeadline(parseMarketauxNewsConfig(source, policy), nowMs); }
        catch { deny("RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE"); }
      }
      if (source.adapter === "ibkr-wsh") {
        try { wshQualificationDeadline(parseWshConfig(source, policy), nowMs); }
        catch { deny("RESEARCH_WSH_QUALIFICATION_UNAVAILABLE"); }
      }
      const maxAge = source.adapter === "ibkr-wsh" ? parseWshConfig(source, policy).maxAgeMs : source.adapter === "marketaux-news" ? marketauxMaxAge(parseMarketauxNewsConfig(source, policy)) : role === "news" ? 1_800_000 : 86_400_000;
      if (coverage && (Date.parse(coverage.checkedAt) > nowMs || Date.parse(coverage.checkedAt) > Date.parse(stored!.snapshot.createdAt) || Date.parse(coverage.windowEnd) > Date.parse(coverage.checkedAt))) deny("RESEARCH_SOURCE_FUTURE");
      const legacy = coverage && legacyRecoveries.find(item => item.snapshotId === stored?.id && item.sourceId === source.id
        && item.coverageHash === researchHash(coverage) && item.slot === researchRefreshSlot(source,role,Date.parse(coverage.checkedAt)+1000));
      const budget = coverage && marketauxLocalBudgetFailure(coverage) && budgetRecoveries.find(item => item.snapshotId === stored?.id && item.sourceId === source.id
        && item.coverageHash === researchHash(coverage) && item.slot === researchRefreshSlot(source, role, Date.parse(coverage.checkedAt) + 1000)
        && item.failedBudgetDay === new Date(item.slot * researchRefreshInterval(source, role)).toISOString().slice(0, 10)
        && item.failedBudgetDay < new Date(nowMs).toISOString().slice(0, 10)
        && Date.parse(item.failureRecordedAt) >= item.slot * researchRefreshInterval(source, role)
        && Date.parse(item.failureRecordedAt) < (item.slot + 1) * researchRefreshInterval(source, role)
        && Number.isFinite(Date.parse(item.nextCheckAt)) && Date.parse(item.nextCheckAt) >= (item.slot + 1) * researchRefreshInterval(source, role));
      const wshRecoverable=source.adapter==='ibkr-wsh' && !!wshState?.latestFailure && !wshState.retained && !wshState.blocksCachedEvidence && (wshState.nextRetryAt!==null || wshState.latestAttempt?.state==='STARTED') && wshState.latestFailure.failureClass==='TRANSIENT';
      if(wshState?.acquisitionBlockedReason){row.failureReason??=wshState.acquisitionBlockedReason;
        if(!coverage||!coverage.complete||!['AVAILABLE','EMPTY'].includes(coverage.status)||nowMs-Date.parse(coverage.checkedAt)>=maxAge||wshState.expiresAt!==null&&nowMs>=Date.parse(wshState.expiresAt))deny(wshState.acquisitionBlockedReason);
      }
      if(wshState?.blocksCachedEvidence)deny("RESEARCH_WSH_ATTEMPT_UNRESOLVED");
      if(wshState?.latestFailure?.failureClass==='TRANSIENT' && !wshState.retained && !wshRecoverable && wshState.latestAttempt?.state!=='STARTED')deny("RESEARCH_WSH_RETRY_EXHAUSTED");
      const recoverable = wshRecoverable || source.adapter === "marketaux-news" && role === "news" && coverage?.status === "ERROR"
        && (isTwoSourceResearch(manifest) ? Boolean(marketauxState?.latestFailure && !marketauxState.holdReasons.length) : marketauxTransientFailure(coverage) || legacy !== undefined || Boolean(budget));
      if (coverage && (!coverage.complete || !["AVAILABLE", ...(role === "reports" ? [] : ["EMPTY"])].includes(coverage.status)) && !recoverable) {
        deny(`RESEARCH_${role.toUpperCase()}_${coverage.status}`);
        if (/^RESEARCH_[A-Z0-9_]{1,100}$/.test(coverage.reason)) deny(coverage.reason);
      }
      if (row.state !== "HOLD" && (!coverage || nowMs - Date.parse(coverage.checkedAt) >= maxAge || recoverable)) {
        if (!supported) deny("RESEARCH_SOURCE_MAPPING_UNSUPPORTED");
        else if (!manifest.refreshEnabled) deny("RESEARCH_REFRESH_DISABLED");
        else if (source.maxRequestsPerDay <= 0 || source.costMicrosPerCall > source.maxCostMicrosPerDay) deny("RESEARCH_BUDGET_EXHAUSTED");
        else {
          row.state = "WAITING";
          row.reasons.push(recoverable ? budget ? "RESEARCH_MARKETAUX_BUDGET_RENEWED" : legacy ? "RESEARCH_MARKETAUX_LEGACY_FRESH_VERIFICATION" : "RESEARCH_SOURCE_TRANSIENT_FAILURE" : coverage ? "RESEARCH_SOURCE_STALE" : "RESEARCH_SOURCE_MISSING");
          if (recoverable) { row.failureReason = wshRecoverable ? wshState!.latestFailure!.failureReason ?? "RESEARCH_WSH_REFRESH_FAILED" : coverage!.reason; row.reasons.push(row.failureReason); }
          row.nextCheckAt = new Date(wshRecoverable ? Math.max(nowMs,Date.parse(wshState!.nextRetryAt??new Date(nowMs+2000).toISOString())) : recoverable ? Math.max(nowMs, budget ? Date.parse(budget.nextCheckAt) : legacy ? Date.parse(legacy.nextCheckAt) : (researchRefreshSlot(source,role,Date.parse(coverage!.checkedAt)+1000)+1)*researchRefreshInterval(source,role)) : nowMs).toISOString();
        }
      }
      sources.push(row);
    }
  }
  if (stored) {
    const eligibility = evaluateResearchEligibility(stored.snapshot, manifest, nowMs);
    const missingReports = sources.some(s => s.role === "reports" && s.state === "WAITING" && !stored.snapshot.coverage.some(c => c.sourceId === s.sourceId && c.role === s.role));
    for (const reason of eligibility.reasons) {
      if(reason==='RESEARCH_CALENDAR_ERROR' && sources.filter(s=>s.role==='calendar').every(s=>s.state==='WAITING'&&s.wshRefresh?.latestFailure?.failureClass==='TRANSIENT'))continue;
      if (reason === "RESEARCH_NEWS_ERROR" && sources.filter(s=>s.role==="news" && stored.snapshot.coverage.some(c=>c.sourceId===s.sourceId&&c.role==='news'&&c.status==='ERROR')).every(s=>s.state==='WAITING'&&s.reasons.some(r=>['RESEARCH_SOURCE_TRANSIENT_FAILURE','RESEARCH_MARKETAUX_LEGACY_FRESH_VERIFICATION','RESEARCH_MARKETAUX_BUDGET_RENEWED'].includes(r)))) continue;
      if (reason === "RESEARCH_SOURCE_STALE_OR_FUTURE" && !reasons.has("RESEARCH_SOURCE_FUTURE")) continue;
      if (/^RESEARCH_(REPORTS|NEWS|CALENDAR)_MISSING$/.test(reason) && sources.some(s => s.state === "WAITING" && `RESEARCH_${s.role.toUpperCase()}_MISSING` === reason)) continue;
      // Only absent financial content is repairable; conflicting existing values remain a hold.
      if (missingReports && !isTwoSourceResearch(stored.snapshot) && /^RESEARCH_(ANNUAL|PERIODIC)_.+_MISSING_OR_CONFLICTING$/.test(reason)) {
        const kind = reason.includes("_ANNUAL_") ? "annual" : "periodic";
        const reports = stored.snapshot.reports.filter(r => r.kind === kind && r.periodStart === policy[kind]!.periodStart && r.periodEnd === policy[kind]!.periodEnd && r.scope === policy[kind]!.scope);
        if (!reports.length) continue;
      }
      hold(reason);
    }
  }
  const state = reasons.size ? "HOLD" : sources.some(s => s.state === "WAITING") ? "WAITING" : "READY";
  return { state, reasons: state === "WAITING" ? [...new Set(sources.flatMap(s => s.reasons))].sort() : [...reasons].sort(), snapshotId: stored?.id ?? null, sources,
    nextCheckAt: state === "WAITING" ? new Date(Math.min(...sources.filter(s=>s.state==="WAITING").map(s=>Date.parse(s.nextCheckAt!)))).toISOString() : null };
}
