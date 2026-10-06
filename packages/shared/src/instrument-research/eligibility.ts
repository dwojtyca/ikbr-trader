import type { InstrumentResearchSnapshotV1, ResearchEligibility, ResearchManifestV1, ResearchMetric } from "./types.js";
import { parseResearchSnapshot, publicationRange, researchTime } from "./validation.js";

const DAY = 86400000;
export function evaluateResearchEligibility(input: InstrumentResearchSnapshotV1, manifest: ResearchManifestV1, nowMs: number): ResearchEligibility {
  const reasons = new Set<string>(), required = new Set<string>(), deadlines: number[] = [];
  const deny = (reason: string) => { reasons.add(reason); };
  if (!Number.isFinite(nowMs)) return { eligible: false, reasons: ["RESEARCH_TIME_INVALID"], expiresAt: null, requiredEvidenceRefs: [] };
  let s: InstrumentResearchSnapshotV1;
  try { s = parseResearchSnapshot(input, manifest); } catch (e) { return { eligible: false, reasons: [e instanceof Error ? e.message : "RESEARCH_SCHEMA_INVALID"], expiresAt: null, requiredEvidenceRefs: [] }; }
  const policy = manifest.instruments.find(p => p.instrumentId === s.instrumentId)!;
  if (policy.assetClass !== "stock" || policy.profile === "etf") deny("RESEARCH_NOT_SUPPORTED");
  if (policy.verification.outcome !== "VERIFIED" || researchTime(policy.verification.verifiedAt) > nowMs) deny("RESEARCH_ISSUER_UNVERIFIED");
  if (researchTime(s.createdAt) > nowMs) deny("RESEARCH_FUTURE_SNAPSHOT");
  const evidence = new Map(s.evidence.map(e => [e.ref, e]));
  const published = (ref: string) => publicationRange(evidence.get(ref)!.published).end;
  for (const e of s.evidence) {
    const source = policy.sources.find(x => x.id === e.sourceId)!;
    if (e.automation !== "PERMITTED" || source.automation !== "PERMITTED" || ["UNVERIFIED", "DENIED"].includes(e.retention) || ["UNVERIFIED", "DENIED"].includes(source.retention)) deny("RESEARCH_PERMISSION_UNVERIFIED");
    if (published(e.ref) > nowMs || publicationRange(e.published).start > researchTime(e.fetchedAt) || researchTime(e.fetchedAt) > nowMs || researchTime(e.observedAt) > nowMs || researchTime(e.fetchedAt) > researchTime(s.createdAt) || researchTime(e.observedAt) > researchTime(e.fetchedAt)) deny("RESEARCH_FUTURE_EVIDENCE");
  }
  for (const role of ["reports", "news", "calendar"] as const) {
    const sources = policy.sources.filter(x => x.roles.includes(role));
    if (!sources.length) deny(`RESEARCH_${role.toUpperCase()}_MISSING`);
    for (const source of sources) {
      if (source.automation !== "PERMITTED" || ["UNVERIFIED", "DENIED"].includes(source.retention)) deny("RESEARCH_PERMISSION_UNVERIFIED");
      const c = s.coverage.find(x => x.sourceId === source.id && x.role === role);
      if (!c) { deny(`RESEARCH_${role.toUpperCase()}_MISSING`); continue; }
      const maxAge = role === "news" ? 1800000 : DAY;
      const checked = researchTime(c.checkedAt), start = researchTime(c.windowStart), end = researchTime(c.windowEnd);
      deadlines.push(checked + maxAge);
      if (checked > nowMs || checked > researchTime(s.createdAt) || end > checked || nowMs - checked >= maxAge) deny("RESEARCH_SOURCE_STALE_OR_FUTURE");
      if (!c.complete || !(c.status === "AVAILABLE" || role !== "reports" && c.status === "EMPTY")) deny(`RESEARCH_${role.toUpperCase()}_${c.status}`);
      if (role === "news" && (end < checked || start > checked - DAY)) deny("RESEARCH_NEWS_WINDOW_INCOMPLETE");
      if (role === "calendar") {
        if (c.occurrenceWindowStart === undefined || c.occurrenceWindowEnd === undefined) deny("RESEARCH_CALENDAR_WINDOW_INCOMPLETE");
        else {
          const occurrenceStart = researchTime(c.occurrenceWindowStart), occurrenceEnd = researchTime(c.occurrenceWindowEnd);
          deadlines.push(occurrenceEnd - DAY);
          if (occurrenceStart > nowMs - DAY || occurrenceEnd <= nowMs + DAY) deny("RESEARCH_CALENDAR_WINDOW_INCOMPLETE");
        }
      }
      if (c.status === "AVAILABLE" && !c.evidenceRefs.length) deny("RESEARCH_COVERAGE_EVIDENCE_MISSING");
      if (c.status === "EMPTY" && (c.evidenceRefs.length || (role === "news" ? s.news : s.events).some(x => evidence.get(x.evidenceRef)?.sourceId === source.id))) deny("RESEARCH_FALSE_EMPTY");
      for (const ref of c.evidenceRefs) required.add(ref);
    }
  }
  const covered = (ref: string, role: "reports" | "news" | "calendar") => s.coverage.some(c => c.role === role && c.status === "AVAILABLE" && c.evidenceRefs.includes(ref));
  const reportById = new Map(s.reports.map(r => [r.id, r]));
  const factById = new Map(s.facts.map(f => [f.id, f]));
  for (const r of s.reports) {
    if (!covered(r.evidenceRef, "reports")) deny("RESEARCH_REPORT_UNCOVERED");
    if (Date.parse(r.periodEnd) > published(r.evidenceRef)) deny("RESEARCH_REPORT_PERIOD_IN_FUTURE");
    if (r.supersedes !== null) {
      const old = reportById.get(r.supersedes);
      if (!old || old.kind !== r.kind || old.periodStart !== r.periodStart || old.periodEnd !== r.periodEnd || old.scope !== r.scope || published(old.evidenceRef) >= published(r.evidenceRef)) deny("RESEARCH_RESTATEMENT_INVALID");
    }
  }
  for (const f of s.facts) {
    const report = reportById.get(f.reportId)!;
    if (f.scope !== report.scope || f.periodEnd !== report.periodEnd || f.periodType === "duration" && f.periodStart !== report.periodStart || !covered(f.evidenceRef, "reports") || published(f.evidenceRef) < published(report.evidenceRef)) deny("RESEARCH_FACT_PERIOD_OR_SCOPE_INVALID");
    const ratio = f.metric === "cet1_ratio" || f.metric === "tier1_ratio";
    const instant = ratio || ["loans", "deposits", "total_debt"].includes(f.metric);
    if (f.periodType !== (instant ? "instant" : "duration")) deny("RESEARCH_FACT_PERIOD_TYPE_INVALID");
    if (ratio ? !["percent", "decimal"].includes(f.unit) || f.currency !== null || f.scale !== 1 || f.value < 0 || f.value > (f.unit === "percent" ? 100 : 1) : f.unit !== "currency" || f.currency !== policy.reportingCurrency) deny("RESEARCH_FACT_UNIT_INVALID");
    if (!Number.isFinite(f.value * f.scale)) deny("RESEARCH_FACT_VALUE_INVALID");
    if (f.supersedes !== null) {
      const old = factById.get(f.supersedes);
      if (!old || old.metric !== f.metric || old.periodStart !== f.periodStart || old.periodEnd !== f.periodEnd || old.scope !== f.scope || old.unit !== f.unit || old.currency !== f.currency || published(old.evidenceRef) >= published(f.evidenceRef)) deny("RESEARCH_RESTATEMENT_INVALID");
    }
  }
  const metrics: ResearchMetric[] = policy.profile === "bank" ? ["net_interest_income", "net_profit", "loans", "deposits", policy.bankCapitalMetric!] : ["revenue", "net_income", "operating_cash_flow", "total_debt"];
  for (const kind of ["annual", "periodic"] as const) {
    const expected = policy[kind]; deadlines.push(researchTime(expected.nextPublicationDeadline));
    if (researchTime(expected.nextPublicationDeadline) <= nowMs) deny("RESEARCH_EXPECTED_REPORT_OVERDUE");
    const candidates = s.reports.filter(r => r.kind === kind && r.periodStart === expected.periodStart && r.periodEnd === expected.periodEnd && r.scope === expected.scope && published(r.evidenceRef) <= nowMs);
    const current = candidates.filter(r => !candidates.some(n => n.supersedes === r.id));
    if (current.length !== 1) { deny(`RESEARCH_${kind.toUpperCase()}_REPORT_MISSING_OR_CONFLICTING`); continue; }
    const report = current[0]; required.add(report.evidenceRef);
    for (const metric of metrics) {
      const candidates = s.facts.filter(f => f.reportId === report.id && f.metric === metric && published(f.evidenceRef) <= nowMs);
      const latest = candidates.filter(f => !s.facts.some(n => n.supersedes === f.id && published(n.evidenceRef) <= nowMs));
      if (latest.length !== 1) deny(`RESEARCH_${kind.toUpperCase()}_${metric.toUpperCase()}_MISSING_OR_CONFLICTING`);
      else required.add(latest[0].evidenceRef);
    }
  }
  for (const n of s.news) {
    if (!covered(n.evidenceRef, "news")) deny("RESEARCH_NEWS_UNCOVERED");
    const c = s.coverage.find(c => c.role === "news" && c.evidenceRefs.includes(n.evidenceRef));
    if (!c || published(n.evidenceRef) < researchTime(c.windowStart) || published(n.evidenceRef) > researchTime(c.windowEnd)) deny("RESEARCH_NEWS_OUTSIDE_WINDOW");
    required.add(n.evidenceRef);
  }
  for (const event of s.events) {
    if (!covered(event.evidenceRef, "calendar")) deny("RESEARCH_EVENT_UNCOVERED");
    const range = publicationRange(event.occurs);
    const coverage = s.coverage.find(c => c.role === "calendar" && c.evidenceRefs.includes(event.evidenceRef));
    if (!coverage?.occurrenceWindowStart || !coverage.occurrenceWindowEnd ||
        range.start < researchTime(coverage.occurrenceWindowStart) || range.end > researchTime(coverage.occurrenceWindowEnd)) deny("RESEARCH_EVENT_OUTSIDE_WINDOW");
    required.add(event.evidenceRef);
    if (event.kind === "earnings" || event.kind === "material") {
      const start = range.start - DAY, end = range.end + DAY;
      if (nowMs >= start && nowMs <= end) deny("RESEARCH_EVENT_BLACKOUT");
      if (start > nowMs) deadlines.push(start);
    }
  }
  return { eligible: reasons.size === 0, reasons: [...reasons].sort(), expiresAt: deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null, requiredEvidenceRefs: [...required].sort() };
}
