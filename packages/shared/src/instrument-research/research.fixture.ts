import { marketauxSourceUrl, marketauxWindow, marketauxCallIdentity, parseMarketauxNewsConfig } from "./marketaux.js";
import { wshReceiptPolicy, parseWshConfig, wshRequestDates, wshEventVersionProjection } from "./wsh.js";
import { readFileSync } from "node:fs";
import { parseTradingConfiguration } from "../trading-configuration/parser.js";
import { computeTradingConfigurationHash } from "../trading-configuration/identity.js";
import { researchHash } from "./validation.js";
import type { InstrumentResearchSnapshotV1, LegacyResearchInstrumentPolicy, ResearchManifestV1, ResearchMetric } from "./types.js";

export function researchFixture(now = Date.now(), instrumentId = "aapl_smart") {
  const raw = JSON.parse(readFileSync(new URL("../../src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8"));
  const parsed = parseTradingConfiguration(raw); if (!parsed.ok) throw new Error("invalid PP1 fixture");
  const config = parsed.configuration, configHash = computeTradingConfigurationHash(config), year = new Date(now).getUTCFullYear();
  const stamp = new Date(now - 1000).toISOString(), published = new Date(now - 3600000).toISOString(), deadline = new Date(now + 30 * 86400000).toISOString();
  const manifest: ResearchManifestV1 = {
    schemaVersion: 1, configHash, refreshEnabled: false,
    model: { provider: "openai", model: "fixture-model", promptVersion: "pp7-research-context-v2", outputSchemaVersion: "pp4-decision-v1", maxInputChars: 100000, maxOutputTokens: 1000, maxCostMicrosPerCall: 100, maxRequestsPerDay: 1, maxCostMicrosPerDay: 100 },
    instruments: config.instruments.filter(i => i.entryEnabled).map((i, index): LegacyResearchInstrumentPolicy => ({
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
  f.snapshot.coverage[f.snapshot.coverage.length-1] = { sourceId: f.source.id, role: "calendar", status: "AVAILABLE", checkedAt: stamp, windowStart: stamp, windowEnd: stamp, complete: true, evidenceRefs: [ref], reason: "Provider-reported query, fixture only", wshAcquisition: { ...wshReceiptPolicy(config), coverageBasis: "PROVIDER_REPORTED_QUERY", acquisitionId: "00000000-0000-4000-8000-000000000001", generation: 1, sessionId: "fixture-session", requestId: 2, requestAsOf: stamp, requestStartDate: requestDates.startDate, requestEndDate: requestDates.endDate, totalLimit: 100, rowCount: 1, duplicateCount: 0, requestHash, receiptHash: "e".repeat(64), metadataHash: config.qualification.metadataHash } };
  return { ...f, wshConfig: config };
}

export function twoSourceResearchFixture(now = Date.now(), instrumentId = "aapl_smart") {
  const f = wshSnapshotFixture(now, instrumentId, new Date(now).toISOString().slice(0, 10));
  const manifest: import("./types.js").TwoSourceResearchManifest = {
    ...f.manifest, researchPolicy: "TWO_SOURCE_HOURLY_V1",
    model: { ...f.manifest.model, promptVersion: "pp7-two-source-context-v1" },
    instruments: f.manifest.instruments.map((old, index) => {
      const { annual: _annual, periodic: _periodic, bankCapitalMetric: _metric, ...policy } = old;
      const wsh = policy.sources.find(s => s.adapter === "ibkr-wsh")!;
      Object.assign(wsh.parserConfig, { refreshIntervalMs: 3600000, maxAgeMs: 86400000 });
      const newsConfig: import("./marketaux.js").MarketauxNewsConfigV2 = {
        kind: "marketaux-news-v2", refreshIntervalMs: 3600000, maxAgeMs: 86400000, queryLookbackMs: 86400000,
        entity: { symbol: `FIXTURE${index}`, name: "Synthetic issuer", type: "equity", country: "us", exchange: null },
        qualification: { outcome: "VERIFIED", verifiedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + 2 * 86400000).toISOString(), evidenceUrl: `https://api.marketaux.com/v1/entity/search?symbols=FIXTURE${index}`, receiptHash: "a".repeat(64), issuerIdentifier: policy.identifiers[0], conId: policy.listing.conId },
        entitlement: { outcome: "VERIFIED", verifiedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + 2 * 86400000).toISOString(), evidenceUrl: "https://www.marketaux.com/pricing", receiptHash: "b".repeat(64), maxArticlesPerRequest: 100, maxRequestsPerDay: 2400, maxCostMicrosPerDay: 2400 },
        pageSize: 2, maxPagesPerPass: 10, maxArticles: 20,
      };
      const news: import("./types.js").ResearchSource = { id: "marketaux-fixture", provider: "https://api.marketaux.com", adapter: "marketaux-news", parserConfig: newsConfig as unknown as Record<string, unknown>, roles: ["news"], urls: [marketauxSourceUrl(newsConfig)], issuerIdentifier: policy.identifiers[0], automation: "PERMITTED", retention: "FACTS_AND_REFERENCES", permissionEvidenceUrl: "https://www.marketaux.com/documentation", maxRequestsPerDay: 2400, maxCostMicrosPerDay: 2400, costMicrosPerCall: 1 };
      return { ...policy, sources: [news, wsh] };
    }),
  };
  const policy = manifest.instruments.find(p => p.instrumentId === instrumentId)!;
  const source = policy.sources.find(s => s.adapter === "marketaux-news")!, wshSource = policy.sources.find(s => s.adapter === "ibkr-wsh")!;
  const newsConfig = parseMarketauxNewsConfig(source, policy) as import("./marketaux.js").MarketauxNewsConfigV2;
  const manifestHash = researchHash(manifest);
  const snapshot: import("./types.js").TwoSourceResearchSnapshot = {
    schemaVersion: 2, researchPolicy: "TWO_SOURCE_HOURLY_V1", configHash: f.configHash, manifestHash,
    instrumentId, mappingHash: researchHash(policy), createdAt: new Date(now).toISOString(),
    evidence: f.snapshot.evidence.filter(e => e.sourceId === wshSource.id),
    coverage: f.snapshot.coverage.filter(c => c.sourceId === wshSource.id), news: [], events: f.snapshot.events,
  };
  const startedAt = new Date(now - 500).toISOString(), completedAt = new Date(now).toISOString();
  const slot = Math.floor(Date.parse(startedAt) / 3600000), window = marketauxWindow(slot, newsConfig);
  const attemptId = "00000000-0000-4000-8000-000000000002";
  const acquisition: import("./marketaux.js").MarketauxAcquisitionV2 = {
    kind: "marketaux-news-v2", attemptId, slot, sourceHash: researchHash(source), startedAt, completedAt,
    queryStart: new Date(Date.parse(window.windowStart) - 1000).toISOString(), queryEnd: new Date(Date.parse(window.asOf) + 1000).toISOString(), asOf: window.asOf,
    entityQualificationHash: researchHash(newsConfig.qualification), entitlementHash: researchHash(newsConfig.entitlement), found: 0, emitted: 0, recordSetHash: researchHash([]),
    pages: ([1, 2] as const).map(pass => ({ pass, page: 1,
      ...marketauxCallIdentity(manifestHash, instrumentId, source, { kind: "marketaux-news-v2", attemptId, slot, sourceUrl: source.urls[0], ...window, pass, page: 1 }),
      fetchedAt: new Date(now - (pass === 1 ? 250 : 100)).toISOString(), contentHash: "c".repeat(64), found: 0, returned: 0, limit: newsConfig.pageSize })),
  };
  snapshot.coverage.push({ sourceId: source.id, role: "news", status: "EMPTY", checkedAt: completedAt, windowStart: window.windowStart, windowEnd: window.asOf, complete: true, evidenceRefs: [], reason: "Synthetic complete empty acquisition", acquisition });
  return { ...f, manifest, manifestHash, snapshot, policy, source, newsConfig, wshSource, now, slot, window, acquisition };
}

export async function seedTwoSourceResearchStore(pool: import("./types.js").ResearchPool, options: { accountId?: string; instrumentId?: string; publishWsh?: boolean; publishNews?: boolean; configureManifest?: (manifest: import("./types.js").TwoSourceResearchManifest) => void } = {}) {
  const { ResearchStore } = await import('./store.js');
  const { TradingConfigurationStore } = await import('../trading-configuration/store.js');
  const { loadTradingConfiguration } = await import('../trading-configuration/loader.js');
  const { randomUUID } = await import('node:crypto');
  const now = Date.parse(String((await pool.query('SELECT clock_timestamp() AS now')).rows[0].now));
  const f = twoSourceResearchFixture(now, options.instrumentId), store = new ResearchStore(pool), accountId = options.accountId ?? 'DU_TEST';
  options.configureManifest?.(f.manifest);
  f.manifestHash = researchHash(f.manifest);
  const loaded = loadTradingConfiguration({ TRADING_CONFIG_MODE: 'bundle', TRADING_CONFIG_PATH: '/fixture.json', TRADING_CONFIG_EXPECTED_HASH: f.configHash }, { readFile: () => readFileSync(new URL('../../src/trading-configuration/fixtures/valid-generic.json',import.meta.url),'utf8') });
  await new TradingConfigurationStore(pool).register({ service: 'execution-engine', processId: randomUUID(), loaded, tradingEnabled: false });
  await store.registerManifest({ manifest:f.manifest, configuration:f.config, tradingEnabled:false, adopt:true });
  const identity = { accountId, configHash:f.configHash, manifestHash:f.manifestHash, instrumentId:f.policy.instrumentId, sourceId:f.source.id };
  const observe = async () => { for (const service of ['execution-engine','llm-agent'] as const) await store.observe({ ...identity,service,processId:service,tradingEnabled:false }); };
  await observe();
  const empty = (at: string): import('./types.js').TwoSourceResearchSnapshot => ({ schemaVersion:2,researchPolicy:'TWO_SOURCE_HOURLY_V1',configHash:f.configHash,manifestHash:f.manifestHash,instrumentId:f.policy.instrumentId,mappingHash:researchHash(f.policy),createdAt:at,coverage:[],evidence:[],news:[],events:[] });
  const clock = async () => { const value = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now; return value instanceof Date ? value.getTime() : Date.parse(String(value)); };
  const publishWsh = async () => {
    const config = parseWshConfig(f.wshSource,f.policy);
    await store.withWshEndpointLock(config.endpointId, async lease => {
      const sessionId=randomUUID(), id={...identity,sourceId:f.wshSource.id}, base={...identity,provider:'ibkr-wsh',kind:'source' as const,reservedCostMicros:0,maxRequestsPerDay:f.wshSource.maxRequestsPerDay,maxCostMicrosPerDay:0};
      const metadata={...base,callKey:'fixture_meta_'+randomUUID(),requestHash:'a'.repeat(64),deadlineAt:new Date(await clock()+9000).toISOString()};
      const acquisition=await store.beginWshAcquisition(lease,{...id,sessionId,reservation:metadata});
      await store.recordCallOutcome(metadata.callKey,'SUCCEEDED');
      const stamp=new Date(await clock()).toISOString(),dates=wshRequestDates(config,stamp);
      const requestHash=researchHash({endpointId:config.endpointId,sessionId,requestId:2,method:'reqWshEventData',request:{conId:config.conId,filter:'',fillWatchlist:false,fillPortfolio:false,fillCompetitors:false,...dates,totalLimit:config.totalLimit}});
      await store.reserveWshCall(lease,acquisition,{...base,callKey:'fixture_events_'+randomUUID(),requestHash,deadlineAt:new Date(await clock()+9000).toISOString()});
      const snapshot=empty(stamp);
      snapshot.coverage.push({sourceId:f.wshSource.id,role:'calendar',status:'EMPTY',complete:true,checkedAt:stamp,windowStart:stamp,windowEnd:stamp,evidenceRefs:[],reason:'Synthetic provider-reported empty query',wshAcquisition:{...wshReceiptPolicy(config),coverageBasis:'PROVIDER_REPORTED_QUERY',acquisitionId:acquisition.id,generation:acquisition.generation,sessionId,requestId:2,requestAsOf:stamp,requestStartDate:dates.startDate,requestEndDate:dates.endDate,totalLimit:config.totalLimit,rowCount:0,duplicateCount:0,requestHash,receiptHash:'e'.repeat(64),metadataHash:config.qualification.metadataHash}});
      await store.publishWshSnapshot(lease,acquisition,snapshot);
    });
  };
  const publishNews = async (supplied?: import('./marketaux-refresh.js').MarketauxAttemptTicket) => {
    const claimed = supplied ? {claimed:true as const,ticket:supplied} : await store.claimMarketauxAttempt(identity);
    if (!claimed.claimed) throw new Error(claimed.reason);
    const ticket=claimed.ticket, pages: import('./marketaux.js').MarketauxPageReceipt[]=[];
    for (const pass of [1,2] as const) {
      const request: import('./marketaux.js').MarketauxRequestV2={kind:'marketaux-news-v2',attemptId:ticket.attemptId,slot:ticket.slot,sourceUrl:f.source.urls[0],windowStart:ticket.windowStart,asOf:ticket.asOf,pass,page:1};
      const call=marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,request);
      await store.reserveMarketauxCall(ticket,request,{...identity,provider:f.source.provider,kind:'source',callKey:call.callKey,requestHash:call.requestHash,reservedCostMicros:f.source.costMicrosPerCall,maxRequestsPerDay:f.source.maxRequestsPerDay,maxCostMicrosPerDay:f.source.maxCostMicrosPerDay});
      const stamp=await store.recordMarketauxCallOutcome(ticket,call.callKey,{outcome:'SUCCEEDED',contentHash:'c'.repeat(64)});
      pages.push({...call,pass,page:1,fetchedAt:stamp.recordedAt,contentHash:'c'.repeat(64),found:0,returned:0,limit:f.newsConfig.pageSize});
    }
    return store.finalizeMarketauxSuccess(ticket,completedAt=>{
      const snapshot=empty(completedAt);
      snapshot.coverage.push({sourceId:f.source.id,role:'news',status:'EMPTY',complete:true,checkedAt:completedAt,windowStart:ticket.windowStart,windowEnd:ticket.asOf,evidenceRefs:[],reason:'Synthetic complete empty acquisition',acquisition:{kind:'marketaux-news-v2',attemptId:ticket.attemptId,slot:ticket.slot,sourceHash:ticket.sourceHash,startedAt:ticket.startedAt,completedAt,queryStart:new Date(Date.parse(ticket.windowStart)-1000).toISOString(),queryEnd:new Date(Date.parse(ticket.asOf)+1000).toISOString(),asOf:ticket.asOf,entityQualificationHash:researchHash(f.newsConfig.qualification),entitlementHash:researchHash(f.newsConfig.entitlement),found:0,emitted:0,recordSetHash:researchHash([]),pages}});
      return snapshot;
    });
  };
  if (options.publishWsh !== false) await publishWsh();
  if (options.publishNews !== false) await publishNews();
  return {...f,store,identity,accountId,observe,publishWsh,publishNews,empty,clock,stored:await store.latestSnapshot(identity)};
}
