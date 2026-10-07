import { parseResearchSnapshot, researchHash, type ResearchSnapshot, type ResearchInstrumentPolicy, type ResearchManifest, type ResearchSource, type ResearchStore } from "@ikbr/shared/instrument-research";
import { refreshWsh, type WshRefreshStore, type WshRefreshRuntime } from "./research-wsh-refresh.js";
import { normalizeResearchSource } from "./research-providers.js";
import { assertResearchPdfResponse, fetchResearchSource, type ResearchFetchResult } from "./research-fetch.js";
import { extractResearchPdf } from "./research-pdf-extractor.js";
import { parseIssuerPdfMapping } from "./research-pdf-mapping.js";
import { createHash } from "node:crypto";
import { MARKETAUX_MAX_ACQUISITION_BYTES, MARKETAUX_MAX_ACQUISITION_MS, marketauxCallIdentity, marketauxQualificationDeadline, marketauxWindow, parseMarketauxNewsConfig, type MarketauxPageReceipt, type MarketauxRequest } from "@ikbr/shared/instrument-research";
import { createMarketauxFetch, sanitizeMarketauxError, type MarketauxFetch } from "./research-marketaux-fetch.js";
import { marketauxRecordSetHash, parseMarketauxPage, type MarketauxNewsRecord } from "./research-marketaux.js";

type Role = "reports" | "news" | "calendar";
type SourceStore = WshRefreshStore & Pick<ResearchStore, "latestSnapshot" | "storeSnapshot" | "reserveCall" | "recordCallOutcome" | "withRefreshLock" | "hasRefreshSlot">;
type Fetch = (source: ResearchSource, url: string, deadlineAt: string) => Promise<ResearchFetchResult>;
const REFRESH_INTERVAL_MS: Record<Role, number> = { reports: 86400000, news: 900000, calendar: 86400000 };
const RETRYABLE_HTTP = /^RESEARCH_SOURCE_HTTP_(429|500|502|503|504)$/;

export function researchBudgetAccountId(env: Readonly<Record<string, string | undefined>>, refreshEnabled: boolean): string | null {
  if (!refreshEnabled) return null;
  const accountId = env.RESEARCH_BUDGET_ACCOUNT_ID;
  const environment = env.IBKR_ENVIRONMENT;
  const allowlist = environment === "paper" ? env.ALLOWED_PAPER_ACCOUNTS : environment === "live" ? env.ALLOWED_LIVE_ACCOUNTS : null;
  if (!accountId || !/^[A-Za-z0-9_-]{1,80}$/.test(accountId) || !allowlist?.split(",").map(value => value.trim()).includes(accountId)) throw new Error("RESEARCH_BUDGET_ACCOUNT_NOT_ALLOWED");
  return accountId;
}

export function researchSourceSlot(nowMs: number, role: Role): number {
  return Math.floor(nowMs / REFRESH_INTERVAL_MS[role]);
}

export function researchCallKey(manifestHash: string, policy: ResearchInstrumentPolicy, source: ResearchSource, role: Role, slot: number, url: string, attempt: 1 | 2): string {
  return "research_source_" + researchHash({ manifestHash, instrumentId: policy.instrumentId, sourceId: source.id, role, slot, url, attempt });
}

function compatible(source: ResearchSource, role: Role): boolean {
  const kind = source.parserConfig.kind;
  return role === "reports" ? kind === "sec-json" || kind === "issuer-xhtml" || kind === "issuer-pdf-table" : kind === "declared-evidence";
}

function parsePayload(result: ResearchFetchResult): unknown {
  return JSON.parse(result.payload.toString("utf8")) as unknown;
}

async function parsePdfPayload(source: ResearchSource, result: ResearchFetchResult): Promise<unknown> {
  assertResearchPdfResponse(result.payload, result.contentType);
  const mapping = parseIssuerPdfMapping(source.parserConfig);
  return extractResearchPdf(result.payload, mapping.documentSha256, mapping.pages.map(page => page.pageNumber));
}

function removePriorSourceRole(snapshot: ResearchSnapshot, sourceId: string, role: Role): void {
  const old = snapshot.coverage.find(row => row.sourceId === sourceId && row.role === role);
  const refs = new Set(old?.evidenceRefs ?? []);
  const reportIds = new Set(snapshot.reports.filter(row => refs.has(row.evidenceRef)).map(row => row.id));
  snapshot.coverage = snapshot.coverage.filter(row => row !== old);
  snapshot.evidence = snapshot.evidence.filter(row => !refs.has(row.ref));
  snapshot.reports = snapshot.reports.filter(row => !refs.has(row.evidenceRef));
  snapshot.facts = snapshot.facts.filter(row => !refs.has(row.evidenceRef) && !reportIds.has(row.reportId));
  snapshot.news = snapshot.news.filter(row => !refs.has(row.evidenceRef));
  snapshot.events = snapshot.events.filter(row => !refs.has(row.evidenceRef));
}

export class ResearchRefreshScheduler {
  private inFlight = false;
  private readonly attemptedSlots = new Map<string, number>();
  constructor(private readonly options: { manifest: ResearchManifest; manifestHash: string; accountId: string; store: SourceStore; fetch?: Fetch; now?: () => number; marketauxApiKey?: string; marketauxFetch?: MarketauxFetch; wsh?: WshRefreshRuntime }) {}

  async tick(): Promise<void> {
    if (!this.options.manifest.refreshEnabled || this.inFlight) return;
    this.inFlight = true;
    try {
      for (const policy of this.options.manifest.instruments) {
        if (policy.assetClass === "etf") continue;
        await this.options.store.withRefreshLock({ configHash: this.options.manifest.configHash, manifestHash: this.options.manifestHash, instrumentId: policy.instrumentId }, async () => {
          for (const source of policy.sources) for (const role of source.roles) {
            const slot = researchSourceSlot((this.options.now ?? Date.now)(), source.adapter === "ibkr-wsh" ? "news" : role);
            const key = [this.options.manifestHash, policy.instrumentId, source.id, role].join(":");
            if (this.attemptedSlots.get(key) === slot) continue;
            const slotKey = "research_slot_" + researchHash({ manifestHash: this.options.manifestHash, instrumentId: policy.instrumentId, sourceId: source.id, role, slot });
            if (await this.options.store.hasRefreshSlot(slotKey)) { this.attemptedSlots.set(key, slot); continue; }
            this.attemptedSlots.set(key, slot);
            try { if (await this.refreshRole(policy, source, role, slot, slotKey) === false) this.attemptedSlots.delete(key); }
            catch (error) { this.attemptedSlots.delete(key); throw error; }
          }
        });
      }
    } finally { this.inFlight = false; }
  }

  private async refreshRole(policy: ResearchInstrumentPolicy, source: ResearchSource, role: Role, slot: number, slotKey: string): Promise<boolean | void> {
    if (source.adapter === "ibkr-wsh") return refreshWsh({ ...this.options, policy, source, slotKey });
    if (source.adapter === "marketaux-news") return this.refreshMarketaux(policy, source, slot, slotKey);
    const { manifest, manifestHash, store, accountId } = this.options;
    const startedAt = new Date((this.options.now ?? Date.now)()).toISOString();
    const previous = await store.latestSnapshot({ configHash: manifest.configHash, manifestHash, instrumentId: policy.instrumentId });
    const snapshot: ResearchSnapshot = previous ? structuredClone(previous.snapshot) : {
      schemaVersion: manifest.schemaVersion, configHash: manifest.configHash, manifestHash, instrumentId: policy.instrumentId,
      mappingHash: researchHash(policy), createdAt: startedAt, evidence: [], coverage: [], reports: [], facts: [], news: [], events: [],
    };
    removePriorSourceRole(snapshot, source.id, role);
    const baseline = structuredClone(snapshot);
    let status: "AVAILABLE" | "EMPTY" | "MISSING" | "UNVERIFIED" | "ERROR" = "UNVERIFIED";
    let reason = "source automation, retention or parser unsupported";
    let complete = false;
    let refs: string[] = [];
    let coveredWindow: { start: string; end: string } | null = null;
    let occurrenceWindow: { occurrenceWindowStart: string; occurrenceWindowEnd: string } | null = null;
    let sourceCheckedAt: string | null = null;
    if (source.automation === "PERMITTED" && source.retention === "FACTS_AND_REFERENCES" && source.maxRequestsPerDay > 0 && source.costMicrosPerCall <= source.maxCostMicrosPerDay && compatible(source, role)) {
      try {
        const fetched: { url: string; result: ResearchFetchResult }[] = [];
        for (const url of source.urls) fetched.push({ url, result: await this.fetchReserved(policy, source, role, slot, url) });
        const chosen = source.adapter === "sec-json" ? fetched.find(row => row.url.includes("/companyfacts/")) : fetched[0];
        if (!chosen) throw new Error("RESEARCH_SOURCE_MAPPING_INCOMPLETE");
        const fetchedAt = new Date((this.options.now ?? Date.now)()).toISOString();
        const payload = source.adapter === "sec-json" ? {
          submissions: parsePayload(fetched.find(row => row.url.includes("/submissions/"))?.result ?? (() => { throw new Error("RESEARCH_SOURCE_MAPPING_INCOMPLETE"); })()),
          companyfacts: parsePayload(chosen.result),
        } : source.parserConfig.kind === "issuer-xhtml" ? chosen.result.payload.toString("utf8")
          : source.parserConfig.kind === "issuer-pdf-table" ? await parsePdfPayload(source, chosen.result) : parsePayload(chosen.result);
        const result = normalizeResearchSource(policy, source, payload, fetchedAt, chosen.url, chosen.result.contentHash);
        const namespace = { sourceId: source.id, role };
        const evidenceIds = new Map(result.evidence.map(row => [row.ref, "ev_" + researchHash({ ...namespace, ref: row.ref })]));
        result.evidence = result.evidence.map(row => ({ ...row, ref: evidenceIds.get(row.ref)! }));
        if ("reports" in result) {
          const reportIds = new Map(result.reports.map(row => [row.id, "report_" + researchHash({ ...namespace, id: row.id })]));
          result.reports = result.reports.map(row => ({ ...row, id: reportIds.get(row.id)!, evidenceRef: evidenceIds.get(row.evidenceRef)!, supersedes: row.supersedes ? "report_" + researchHash({ ...namespace, id: row.supersedes }) : null }));
          result.facts = result.facts.map(row => ({ ...row, id: "fact_" + researchHash({ ...namespace, id: row.id }), reportId: reportIds.get(row.reportId)!, evidenceRef: evidenceIds.get(row.evidenceRef)!, supersedes: row.supersedes ? "fact_" + researchHash({ ...namespace, id: row.supersedes }) : null }));
          if (source.adapter === "sec-json") {
            const submissions = fetched.find(row => row.url.includes("/submissions/"));
            if (!submissions) throw new Error("RESEARCH_SOURCE_MAPPING_INCOMPLETE");
            const companions = result.evidence.map(row => ({ ...row, ref: row.ref + ":submissions", documentId: row.documentId + ":submissions", url: submissions.url, contentHash: submissions.result.contentHash }));
            snapshot.evidence.push(...result.evidence, ...companions); refs = [...result.evidence.map(row => row.ref), ...companions.map(row => row.ref)];
          } else { snapshot.evidence.push(...result.evidence); refs = result.evidence.map(row => row.ref); }
          snapshot.reports.push(...result.reports); snapshot.facts.push(...result.facts);
          status = result.reports.length > 0 ? "AVAILABLE" : "MISSING";
          reason = result.reports.length > 0 ? "verified mapped report data" : "no configured reports found";
          complete = result.reports.length > 0;
        } else {
          result.news = result.news.map(row => ({ ...row, id: "news_" + researchHash({ ...namespace, id: row.id }), evidenceRef: evidenceIds.get(row.evidenceRef)! }));
          result.events = result.events.map(row => ({ ...row, id: "event_" + researchHash({ ...namespace, id: row.id }), evidenceRef: evidenceIds.get(row.evidenceRef)! }));
          result.coverage.evidenceRefs = result.coverage.evidenceRefs.map(ref => evidenceIds.get(ref)!);
          if (result.coverage.role !== role) throw new Error("RESEARCH_SOURCE_ROLE_MISMATCH");
          snapshot.evidence.push(...result.evidence);
          if (snapshot.schemaVersion === 2) snapshot.news.push(...result.news.map(row => ({ ...row, description: null, snippet: null, providerSentiment: { status: "NOT_PROVIDED" as const } })));
          else snapshot.news.push(...result.news);
          snapshot.events.push(...result.events);
          refs = result.evidence.map(row => row.ref);
          coveredWindow = { start: result.coverage.windowStart, end: result.coverage.windowEnd };
          sourceCheckedAt = result.coverage.checkedAt;
          if (result.coverage.occurrenceWindowStart !== undefined && result.coverage.occurrenceWindowEnd !== undefined) occurrenceWindow = {
            occurrenceWindowStart: result.coverage.occurrenceWindowStart, occurrenceWindowEnd: result.coverage.occurrenceWindowEnd,
          };
          const windowComplete = role === "news"
            ? coveredWindow.end === sourceCheckedAt && Date.parse(coveredWindow.start) <= Date.parse(sourceCheckedAt) - 86400000
            : true;
          status = windowComplete && (result.coverage.status === "AVAILABLE" || result.coverage.status === "EMPTY") ? result.coverage.status : "UNVERIFIED";
          reason = windowComplete ? result.coverage.reason : "declared news window does not cover its as-of time";
          complete = windowComplete && result.coverage.complete;
        }
        parseResearchSnapshot(snapshot, manifest);
      } catch (error) {
        Object.assign(snapshot, baseline);
        refs = []; complete = false; coveredWindow = null; occurrenceWindow = null; sourceCheckedAt = null;
        status = "ERROR"; reason = error instanceof Error ? error.message.slice(0, 1000) : "source refresh failed";
      }
    }
    const completedAt = new Date((this.options.now ?? Date.now)()).toISOString();
    const checkedAt = sourceCheckedAt ?? completedAt;
    snapshot.createdAt = completedAt;
    snapshot.coverage.push({ sourceId: source.id, role, status, checkedAt,
      windowStart: coveredWindow?.start ?? new Date(Date.parse(checkedAt) - 86400000).toISOString(), windowEnd: coveredWindow?.end ?? checkedAt,
      ...occurrenceWindow,
      complete, evidenceRefs: refs, reason });
    await store.storeSnapshot(snapshot, slotKey);
  }

  private async refreshMarketaux(policy: ResearchInstrumentPolicy, source: ResearchSource, slot: number, slotKey: string): Promise<void> {
    const { manifest, manifestHash, store, accountId } = this.options;
    const now = this.options.now ?? Date.now, startedAt = now(), window = marketauxWindow(slot);
    const previous = await store.latestSnapshot({ configHash: manifest.configHash, manifestHash, instrumentId: policy.instrumentId });
    const snapshot: ResearchSnapshot = previous ? structuredClone(previous.snapshot) : {
      schemaVersion: manifest.schemaVersion, configHash: manifest.configHash, manifestHash, instrumentId: policy.instrumentId,
      mappingHash: researchHash(policy), createdAt: new Date(startedAt).toISOString(), evidence: [], coverage: [], reports: [], facts: [], news: [], events: [],
    };
    removePriorSourceRole(snapshot, source.id, "news");
    const baseline = structuredClone(snapshot);
    const failure = (status: "ERROR" | "UNVERIFIED", reason: string) => {
      Object.assign(snapshot, structuredClone(baseline));
      snapshot.createdAt = new Date(now()).toISOString();
      snapshot.coverage.push({ sourceId: source.id, role: "news", status, checkedAt: window.asOf, windowStart: window.windowStart, windowEnd: window.asOf,
        complete: false, evidenceRefs: [], reason });
      parseResearchSnapshot(snapshot, manifest);
    };
    const config = parseMarketauxNewsConfig(source, policy);
    let allowed = source.automation === "PERMITTED" && source.retention === "FACTS_AND_REFERENCES" && source.maxRequestsPerDay > 0 && source.costMicrosPerCall <= source.maxCostMicrosPerDay;
    try { marketauxQualificationDeadline(config, now()); } catch { allowed = false; }
    if (!allowed) {
      failure("UNVERIFIED", "RESEARCH_MARKETAUX_QUALIFICATION_UNAVAILABLE");
      await store.storeSnapshot(snapshot, slotKey); return;
    }
    let admissionDeadline = 0;
    try {
      if (!this.options.marketauxApiKey?.trim()) throw new Error("RESEARCH_MARKETAUX_KEY_MISSING");
      admissionDeadline = Math.min(startedAt + MARKETAUX_MAX_ACQUISITION_MS, marketauxQualificationDeadline(config, now()));
      const checkpoint = () => {
        marketauxQualificationDeadline(config, now());
        if (now() >= admissionDeadline) throw new Error("RESEARCH_MARKETAUX_DEADLINE_EXPIRED");
      };
      const fetch = this.options.marketauxFetch ?? createMarketauxFetch(this.options.marketauxApiKey);
      const providerSources = manifest.instruments.flatMap(instrument => instrument.sources).filter(candidate => candidate.provider === source.provider);
      const maxRequestsPerDay = Math.min(...providerSources.map(candidate => candidate.maxRequestsPerDay));
      const maxCostMicrosPerDay = Math.min(...providerSources.map(candidate => candidate.maxCostMicrosPerDay));
      const reservedCostMicros = Math.max(...providerSources.map(candidate => candidate.costMicrosPerCall));
      let bytes = 0, firstFound = -1;
      const passes: MarketauxNewsRecord[][] = [], receipts: MarketauxPageReceipt[] = [];
      const firstPages = new Map<string, MarketauxPageReceipt>();
      for (const pass of [1, 2] as const) {
        const records: MarketauxNewsRecord[] = [], ids = new Set<string>();
        let found = -1, pageCount = 1;
        for (let page = 1; page <= pageCount; page++) {
          checkpoint();
          const remainingBytes = MARKETAUX_MAX_ACQUISITION_BYTES - bytes;
          if (remainingBytes <= 0) throw new Error("RESEARCH_MARKETAUX_BYTES_EXCEEDED");
          const descriptor: MarketauxRequest = { sourceUrl: source.urls[0], ...window, pass, page };
          const identity = marketauxCallIdentity(manifestHash, policy.instrumentId, source, descriptor);
          const deadlineAt = new Date(Math.min(now() + 10000, admissionDeadline)).toISOString();
          await store.reserveCall({ accountId, provider: source.provider, kind: "source", configHash: manifest.configHash, manifestHash,
            callKey: identity.callKey, requestHash: identity.requestHash, reservedCostMicros, maxRequestsPerDay, maxCostMicrosPerDay, deadlineAt });
          let result: ResearchFetchResult;
          try {
            checkpoint();
            if (now() >= Date.parse(deadlineAt)) throw new Error("RESEARCH_MARKETAUX_DEADLINE_EXPIRED");
            result = await fetch(source, descriptor, deadlineAt, Math.min(10 * 1024 * 1024, remainingBytes));
          } catch (error) {
            await store.recordCallOutcome(identity.callKey, /^RESEARCH_SOURCE_HTTP_\d{3}$/.test(sanitizeMarketauxError(error)) ? "FAILED" : "UNKNOWN");
            throw error;
          }
          await store.recordCallOutcome(identity.callKey, "SUCCEEDED");
          checkpoint();
          if (now() >= Date.parse(deadlineAt)) throw new Error("RESEARCH_MARKETAUX_DEADLINE_EXPIRED");
          if (result.contentType.split(";")[0].trim().toLowerCase() !== "application/json") throw new Error("RESEARCH_MARKETAUX_CONTENT_TYPE_INVALID");
          bytes += result.payload.length;
          if (result.payload.length > 10 * 1024 * 1024 || bytes > MARKETAUX_MAX_ACQUISITION_BYTES) throw new Error("RESEARCH_MARKETAUX_BYTES_EXCEEDED");
          const parsed = parseMarketauxPage(JSON.parse(result.payload.toString("utf8")) as unknown, config, descriptor, manifest.schemaVersion);
          if ((found >= 0 && parsed.found !== found) || (pass === 2 && parsed.found !== firstFound)) throw new Error("RESEARCH_MARKETAUX_RESULT_CHANGED");
          found = parsed.found; pageCount = Math.max(1, Math.ceil(found / config.pageSize));
          const receipt: MarketauxPageReceipt = { ...identity, pass, page, fetchedAt: new Date(now()).toISOString(), contentHash: createHash("sha256").update(result.payload).digest("hex"), found, returned: parsed.returned, limit: parsed.limit };
          receipts.push(receipt);
          for (const record of parsed.records) {
            if (ids.has(record.uuid)) throw new Error("RESEARCH_MARKETAUX_DUPLICATE_UUID");
            ids.add(record.uuid); records.push(record);
            if (pass === 1) firstPages.set(record.uuid, receipt);
          }
        }
        if (records.length !== found) throw new Error("RESEARCH_MARKETAUX_RESULT_CHANGED");
        if (pass === 1) firstFound = found;
        passes.push(records);
      }
      const recordSetHash = marketauxRecordSetHash(passes[0]);
      if (recordSetHash !== marketauxRecordSetHash(passes[1])) throw new Error("RESEARCH_MARKETAUX_RESULT_CHANGED");
      const refs: string[] = [];
      for (const record of passes[0].filter(record => record.inWindow)) {
        const page = firstPages.get(record.uuid)!;
        const ref = "ev_" + researchHash({ sourceId: source.id, role: "news", ref: record.uuid });
        refs.push(ref);
        snapshot.evidence.push({ ref, sourceId: source.id, documentId: "marketaux:" + record.uuid, url: source.urls[0], contentHash: page.contentHash,
          issuerId: policy.issuerId, issuerIdentifier: source.issuerIdentifier, published: { precision: "instant", at: record.publishedAt },
          fetchedAt: page.fetchedAt, observedAt: page.fetchedAt, automation: source.automation, retention: source.retention });
        const news = { id: "news_" + researchHash({ sourceId: source.id, role: "news", id: record.uuid }), evidenceRef: ref, title: record.title };
        if (snapshot.schemaVersion === 2) {
          if (!record.enrichment) throw new Error("RESEARCH_MARKETAUX_PAYLOAD_INVALID");
          snapshot.news.push({ ...news, ...record.enrichment });
        } else snapshot.news.push(news);
      }
      checkpoint();
      snapshot.createdAt = new Date(now()).toISOString();
      snapshot.coverage.push({ sourceId: source.id, role: "news", status: refs.length ? "AVAILABLE" : "EMPTY", checkedAt: window.asOf,
        windowStart: window.windowStart, windowEnd: window.asOf, complete: true, evidenceRefs: refs, reason: "RESEARCH_MARKETAUX_TWO_PASSES_COMPLETE",
        acquisition: { kind: "marketaux-news-v1", queryStart: new Date(Date.parse(window.windowStart) - 1000).toISOString(), queryEnd: new Date(Date.parse(window.asOf) + 1000).toISOString(),
          asOf: window.asOf, entityQualificationHash: researchHash(config.qualification), entitlementHash: researchHash(config.entitlement),
          found: firstFound, emitted: refs.length, recordSetHash, pages: receipts } });
      parseResearchSnapshot(snapshot, manifest);
      checkpoint();
    } catch (error) { failure("ERROR", sanitizeMarketauxError(error)); }
    const complete = snapshot.coverage.find(row => row.sourceId === source.id && row.role === "news")!.complete;
    try { await store.storeSnapshot(snapshot, slotKey, complete ? new Date(admissionDeadline).toISOString() : undefined); }
    catch (error) {
      if (!complete || !(error instanceof Error) || error.message !== "RESEARCH_SNAPSHOT_ADMISSION_EXPIRED") throw error;
      failure("ERROR", "RESEARCH_SNAPSHOT_ADMISSION_EXPIRED");
      await store.storeSnapshot(snapshot, slotKey);
    }
  }

  private async fetchReserved(policy: ResearchInstrumentPolicy, source: ResearchSource, role: Role, slot: number, url: string): Promise<ResearchFetchResult> {
    const { manifest, manifestHash, accountId, store } = this.options;
    const providerSources = manifest.instruments.flatMap(instrument => instrument.sources).filter(candidate => candidate.provider === source.provider);
    const maxRequestsPerDay = Math.min(...providerSources.map(candidate => candidate.maxRequestsPerDay));
    const maxCostMicrosPerDay = Math.min(...providerSources.map(candidate => candidate.maxCostMicrosPerDay));
    const reservedCostMicros = Math.max(...providerSources.map(candidate => candidate.costMicrosPerCall));
    for (const attempt of [1, 2] as const) {
      const callKey = researchCallKey(manifestHash, policy, source, role, slot, url, attempt);
      const requestHash = researchHash({ method: "GET", url, callKey });
      const deadlineAt = new Date(Date.now() + 10000).toISOString();
      await store.reserveCall({ accountId, provider: source.provider, kind: "source", configHash: manifest.configHash, manifestHash,
        callKey, requestHash, reservedCostMicros,
        maxRequestsPerDay, maxCostMicrosPerDay, deadlineAt });
      try {
        const result = await (this.options.fetch ?? fetchResearchSource)(source, url, deadlineAt);
        await store.recordCallOutcome(callKey, "SUCCEEDED");
        return result;
      } catch (error) {
        const code = error instanceof Error ? error.message : "UNKNOWN";
        const retryable = RETRYABLE_HTTP.test(code);
        await store.recordCallOutcome(callKey, retryable ? "FAILED" : "UNKNOWN");
        if (!retryable || attempt === 2) throw error;
      }
    }
    throw new Error("RESEARCH_SOURCE_ATTEMPTS_EXHAUSTED");
  }
}
