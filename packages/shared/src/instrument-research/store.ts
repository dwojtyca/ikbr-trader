import { parseWshConfig, wshQualificationDeadline, wshLedgerKey, type WshAcquisition, type WshAcquisitionRecord, type WshEndpointLease } from "./wsh.js";
import { randomUUID } from "node:crypto";
import { canonicalJson, decodeTradingConfigurationSnapshot } from "../trading-configuration/identity.js";
import type { TradingConfigurationV1 } from "../trading-configuration/types.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { inspectResearch, researchRefreshInterval, researchRefreshSlot, researchRefreshSlotKey, type ResearchPreparation, type ResearchRepairIdentity, type ResearchRole, type MarketauxLegacyRecoveryAssessment, type MarketauxBudgetRecoveryAssessment, type ResearchLocalBudgetDiagnostic, marketauxLocalBudgetFailure, marketauxTransientFailure } from "./repair.js";
import { marketauxCallIdentity, marketauxWindow, parseMarketauxNewsConfig } from "./marketaux.js";
import { isResearchHash, parseResearchManifest, parseResearchSnapshot, researchAssert, researchHash, researchTime } from "./validation.js";
import type { ResearchSnapshot, InstrumentResearchSnapshotV2, ResearchConnection, ResearchBinding, ResearchBindingIdentity, ResearchCallReservation, ResearchDb, ResearchIdentity, ResearchManifest, ResearchPool, StoredResearchSnapshot, ValidatedResearchBinding } from "./types.js";

const iso = (v: unknown): string => v instanceof Date ? v.toISOString() : String(v);
export class ResearchStore {
  private budgetDiscovery: { identity: string; nextScanAt: number; cursor: string } | undefined;
  private readonly wshLeases = new WeakMap<WshEndpointLease, ResearchConnection>();
  constructor(private readonly pool: ResearchPool) {}
  async withRefreshLock(identity: ResearchIdentity & { instrumentId: string }, run: () => Promise<void>): Promise<boolean> {
    const db = await this.pool.connect();
    const key = `research-refresh:${identity.configHash}:${identity.manifestHash}:${identity.instrumentId}`;
    let locked = false;
    try {
      locked = (await db.query("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked", [key])).rows[0].locked === true;
      if (!locked) return false;
      await run(); return true;
    } finally {
      try { if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]); }
      finally { db.release(); }
    }
  }
  async hasRefreshSlot(slotKey: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM research_refresh_slots WHERE slot_key=$1", [slotKey])).rows.length > 0;
  }
  async prepareRepair(identity: ResearchRepairIdentity, existing?: ResearchDb): Promise<ResearchPreparation> {
    return this.transaction(async db => {
      researchAssert(/^[A-Za-z0-9_-]{1,80}$/.test(identity.accountId), "RESEARCH_ACCOUNT_INVALID");
      await this.assertAuthority(identity, db);
      const manifest = await this.readManifest(identity, db), now = await this.now(db);
      const stored = await this.latestSnapshot(identity, db, true);
      const legacy = await this.legacyMarketauxRecoveries(identity, manifest, stored, now, db);
      const budget = await this.marketauxBudgetRecoveries(identity, manifest, stored, now, db);
      const result = inspectResearch(manifest, identity.instrumentId, stored, now, legacy, budget.assessments);
      for (const row of result.sources) {
        const diagnostic = budget.diagnostics.get(row.sourceId);
        if (row.role === "news" && diagnostic) row.localBudget = diagnostic;
      }
      const policy = manifest.instruments.find(p => p.instrumentId === identity.instrumentId);
      for (const row of result.sources) {
        if (row.state !== "WAITING" || result.state === "HOLD") continue;
        const source = policy!.sources.find(s => s.id === row.sourceId)!;
        const providers = manifest.instruments.flatMap(p => p.sources).filter(s => s.provider === source.provider);
        const usage = (await db.query(`SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost
          FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3`, [identity.accountId, source.provider, new Date(now).toISOString().slice(0, 10)])).rows[0];
        if (Number(usage.requests) >= Math.min(...providers.map(s => s.maxRequestsPerDay)) || Number(usage.cost) + Math.max(...providers.map(s => s.costMicrosPerCall)) > Math.min(...providers.map(s => s.maxCostMicrosPerDay))) {
          row.state = "HOLD"; row.reasons = ["RESEARCH_BUDGET_EXHAUSTED"]; row.nextCheckAt = null; continue;
        }
        if (source.adapter === "marketaux-news" && await this.hasUnresolvedMarketauxFailure(identity,manifest,source.id,now,db)) {
          row.state="HOLD";row.reasons=["RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE"];row.nextCheckAt=null;continue;
        }
        if (Date.parse(row.nextCheckAt!) > now) continue;
        const slot = researchRefreshSlot(source, row.role, now);
        if (source.adapter === "marketaux-news") {
          const config=parseMarketauxNewsConfig(source,policy!), previousWindow=marketauxWindow(slot-1), previousKeys:string[]=[];
          for (const pass of [1,2] as const) for (let page=1;page<=config.maxPagesPerPass;page++) previousKeys.push(marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...previousWindow,pass,page}).callKey);
          const pending=(await db.query(`SELECT r.deadline_at FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key)
            WHERE r.call_key=ANY($1::text[]) AND r.deadline_at>$2 AND (o.outcome IS NULL OR o.outcome='UNKNOWN')`,[previousKeys,new Date(now)])).rows;
          if (pending.length) {row.reasons=["RESEARCH_WAITING_EXISTING_ACQUISITION"];row.nextCheckAt=new Date(Math.max(...pending.map(call=>researchTime(iso(call.deadline_at))))).toISOString();continue;}
        }
        const slotKey = researchRefreshSlotKey(identity.manifestHash, identity.instrumentId, source.id, row.role, slot);
        if ((await db.query("SELECT 1 FROM research_refresh_slots WHERE slot_key=$1", [slotKey])).rows.length) {
          row.reasons = ["RESEARCH_WAITING_NEXT_SLOT"];
          row.nextCheckAt = new Date((slot + 1) * researchRefreshInterval(source, row.role)).toISOString(); continue;
        }
        const keys: string[] = [];
        if (source.adapter === "marketaux-news") {
          const config = parseMarketauxNewsConfig(source, policy!), window = marketauxWindow(slot);
          for (const pass of [1, 2] as const) for (let page = 1; page <= config.maxPagesPerPass; page++)
            keys.push(marketauxCallIdentity(identity.manifestHash, identity.instrumentId, source, { sourceUrl: source.urls[0], ...window, pass, page }).callKey);
        } else if (source.adapter !== "ibkr-wsh") {
          for (const url of source.urls) for (const attempt of [1, 2]) keys.push("research_source_" + researchHash({ manifestHash: identity.manifestHash, instrumentId: identity.instrumentId, sourceId: source.id, role: row.role, slot, url, attempt }));
        } else {
          const acquisitions = (await db.query(`SELECT a.*,clock_timestamp() AS now FROM research_wsh_acquisitions a
            WHERE ledger_key=$1 AND started_at>clock_timestamp()-interval '15 minutes' ORDER BY started_at DESC LIMIT 1`, [wshLedgerKey(parseWshConfig(source, policy!).isin)])).rows;
          if (acquisitions.length) {
            const acquisition = acquisitions[0];
            if (["UNKNOWN", "FAILED"].includes(String(acquisition.state))) { row.state = "HOLD"; row.reasons = ["RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE"]; row.nextCheckAt = null; }
            else { row.reasons = ["RESEARCH_WAITING_ACQUISITION_OR_PACING"]; row.nextCheckAt = new Date(acquisition.state === "PENDING" ? now + 5_000 : researchTime(iso(acquisition.started_at)) + 900_000).toISOString(); }
          }
        }
        if (keys.length) {
          const calls = (await db.query(`SELECT r.deadline_at,o.outcome FROM research_call_reservations r
            LEFT JOIN research_call_outcomes o USING(call_key) WHERE r.call_key=ANY($1::text[])`, [keys])).rows;
          if (calls.length) {
            const unknown = calls.some(c => c.outcome === "UNKNOWN" || c.outcome == null && researchTime(iso(c.deadline_at)) <= now) || calls.every(c => researchTime(iso(c.deadline_at)) <= now);
            if (source.adapter === "marketaux-news" && calls.some(c=>c.outcome === "FAILED")) {
              row.state = "HOLD"; row.reasons = ["RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE"]; row.nextCheckAt = null;
            }
            else if (source.adapter === "marketaux-news" && unknown) {
              row.reasons = ["RESEARCH_WAITING_NEXT_SLOT"];
              row.nextCheckAt = new Date(Math.max((slot+1)*researchRefreshInterval(source,row.role), ...calls.map(c=>researchTime(iso(c.deadline_at))))).toISOString();
            }
            else if (unknown) { row.state = "HOLD"; row.reasons = ["RESEARCH_PROVIDER_OUTCOME_UNKNOWN"]; row.nextCheckAt = null; }
            else if (calls.some(c => c.outcome === "FAILED")) { row.state = "HOLD"; row.reasons = ["RESEARCH_PROVIDER_OUTCOME_UNAVAILABLE"]; row.nextCheckAt = null; }
            else { row.reasons = ["RESEARCH_WAITING_EXISTING_ACQUISITION"]; row.nextCheckAt = new Date(now + 5_000).toISOString(); }
          }
        }
      }
      if (result.sources.some(row => row.state === "HOLD")) {
        result.state = "HOLD"; result.reasons = [...new Set([...result.reasons, ...result.sources.filter(s => s.state === "HOLD").flatMap(s => s.reasons)])].sort();
      }
      if (result.state === "WAITING") result.reasons = [...new Set(result.sources.filter(s => s.state === "WAITING").flatMap(s => s.reasons))].sort();
      result.nextCheckAt = result.state === "WAITING" ? new Date(Math.min(...result.sources.filter(s => s.state === "WAITING").map(s => Date.parse(s.nextCheckAt!)))).toISOString() : null;
      for (const row of result.sources) {
        const state = result.state === "HOLD" ? "HOLD" : row.state;
        const reasons = state === "HOLD" ? result.reasons : row.reasons;
        const next = state === "WAITING" ? row.nextCheckAt : null;
        const changed = await db.query(`INSERT INTO research_repair_requests(account_id,config_hash,manifest_hash,instrument_id,source_id,role,state,reasons,snapshot_id,next_check_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
          ON CONFLICT(account_id,config_hash,manifest_hash,instrument_id,source_id,role) DO UPDATE SET
            state=EXCLUDED.state,reasons=EXCLUDED.reasons,snapshot_id=EXCLUDED.snapshot_id,next_check_at=EXCLUDED.next_check_at,updated_at=clock_timestamp()
          WHERE ROW(research_repair_requests.state,research_repair_requests.reasons,research_repair_requests.snapshot_id,research_repair_requests.next_check_at)
            IS DISTINCT FROM ROW(EXCLUDED.state,EXCLUDED.reasons,EXCLUDED.snapshot_id,EXCLUDED.next_check_at) RETURNING id`,
        [identity.accountId, identity.configHash, identity.manifestHash, identity.instrumentId, row.sourceId, row.role, state, JSON.stringify(reasons), result.snapshotId, next]);
        if (changed.rows[0]) await db.query(`INSERT INTO research_repair_events(request_id,state,reasons,snapshot_id,next_check_at) VALUES($1,$2,$3::jsonb,$4,$5)`, [changed.rows[0].id, state, JSON.stringify(reasons), result.snapshotId, next]);
      }
      return result;
    }, existing);
  }
  async dueRepairs(identity: ResearchIdentity & { accountId: string }): Promise<(ResearchRepairIdentity & { sourceId: string; role: ResearchRole })[]> {
    await this.assertAuthority(identity);
    const rows = (await this.pool.query(`SELECT instrument_id,source_id,role,state,FALSE AS budget_candidate FROM research_repair_requests
      WHERE account_id=$1 AND config_hash=$2 AND manifest_hash=$3 AND
        ((state='WAITING' AND next_check_at<=clock_timestamp()) OR (state='HOLD' AND role='news' AND
          reasons ?| ARRAY['RESEARCH_MARKETAUX_ACQUISITION_FAILED','RESEARCH_SOURCE_TIMEOUT','RESEARCH_SOURCE_TRANSPORT_TRANSIENT',
          'RESEARCH_SOURCE_HTTP_429','RESEARCH_SOURCE_HTTP_500','RESEARCH_SOURCE_HTTP_502','RESEARCH_SOURCE_HTTP_503','RESEARCH_SOURCE_HTTP_504']))
      ORDER BY next_check_at NULLS LAST,id LIMIT 100`, [identity.accountId, identity.configHash, identity.manifestHash])).rows;
    const now = await this.now(this.pool), discoveryKey = researchHash(identity);
    const previous = this.budgetDiscovery?.identity === discoveryKey ? this.budgetDiscovery : undefined;
    const scanBudget = !previous || now >= previous.nextScanAt;
    let cursor = previous?.cursor ?? "0";
    if (scanBudget) {
      const query = `SELECT id,instrument_id,source_id,role,state,TRUE AS budget_candidate FROM research_repair_requests
        WHERE account_id=$1 AND config_hash=$2 AND manifest_hash=$3 AND state='HOLD' AND role='news'
          AND reasons ? 'RESEARCH_BUDGET_EXHAUSTED' AND id>$4::bigint ORDER BY id LIMIT 100`;
      let candidates = (await this.pool.query(query, [identity.accountId, identity.configHash, identity.manifestHash, cursor])).rows;
      if (!candidates.length && cursor !== "0") candidates = (await this.pool.query(query, [identity.accountId, identity.configHash, identity.manifestHash, "0"])).rows;
      cursor = candidates.length ? String(candidates[candidates.length - 1].id) : "0";
      rows.push(...candidates);
    }
    const manifest = rows.some(row=>row.state==='HOLD') ? await this.readManifest(identity,this.pool) : null;
    const result: (ResearchRepairIdentity & {sourceId:string;role:ResearchRole})[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const candidate = {...identity,instrumentId:String(row.instrument_id),sourceId:String(row.source_id),role:row.role as ResearchRole};
      if (row.state==='HOLD') {
        const source=manifest!.instruments.find(p=>p.instrumentId===candidate.instrumentId)?.sources.find(s=>s.id===candidate.sourceId);
        if (source?.adapter!=='marketaux-news') continue;
        const stored=await this.latestSnapshot(candidate);
        const coverage=stored?.snapshot.coverage.find(c=>c.sourceId===candidate.sourceId&&c.role==='news');
        if (coverage && marketauxLocalBudgetFailure(coverage) !== (row.budget_candidate === true)) continue;
        if (!coverage || !(marketauxTransientFailure(coverage) || marketauxLocalBudgetFailure(coverage) || coverage.status==='ERROR'&&!coverage.complete&&coverage.reason==='RESEARCH_MARKETAUX_ACQUISITION_FAILED'&&!Object.hasOwn(coverage,'sourceError'))) continue;
      }
      const key = JSON.stringify([candidate.instrumentId, candidate.sourceId, candidate.role]);
      if (!seen.has(key)) { result.push(candidate); seen.add(key); }
    }
    if (scanBudget) this.budgetDiscovery = { identity: discoveryKey, cursor, nextScanAt: Math.min(now + 60_000, Date.parse(new Date(now).toISOString().slice(0, 10)) + 86_400_000) };
    return result;
  }
  private async hasUnresolvedMarketauxFailure(identity: ResearchRepairIdentity, manifest: ResearchManifest, sourceId: string, now: number, db: ResearchDb): Promise<boolean> {
    const policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId)!,source=policy.sources.find(s=>s.id===sourceId)!,config=parseMarketauxNewsConfig(source,policy);
    const calls=(await db.query(`SELECT r.*,o.recorded_at FROM research_call_reservations r JOIN research_call_outcomes o USING(call_key)
      WHERE r.account_id=$1 AND r.provider=$2 AND r.kind='source' AND r.config_hash=$3 AND r.manifest_hash=$4 AND o.outcome='FAILED'`,[identity.accountId,source.provider,identity.configHash,identity.manifestHash])).rows;
    let latestSuccessfulStart:number|undefined;
    for (const call of calls) {
      const reserved=researchTime(iso(call.reserved_at)), actualSlot=researchRefreshSlot(source,'news',reserved);
      let matchedSlot:number|undefined;
      for (const slot of [actualSlot,actualSlot-1]) {
        const window=marketauxWindow(slot);
        for (const pass of [1,2] as const) for (let page=1;page<=config.maxPagesPerPass;page++) {
          const expected=marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...window,pass,page});
          if (expected.callKey===call.call_key) {if(expected.requestHash!==call.request_hash)return true;matchedSlot=slot;}
        }
      }
      if (matchedSlot===undefined) continue;
      if (latestSuccessfulStart===undefined) {
        latestSuccessfulStart=-Infinity;
        const success=(await db.query(`SELECT s.* FROM research_snapshots s CROSS JOIN LATERAL jsonb_array_elements(s.canonical_json::jsonb->'coverage') c
          WHERE s.config_hash=$1 AND s.manifest_hash=$2 AND s.instrument_id=$3 AND c->>'sourceId'=$4 AND c->>'role'='news' AND c->>'complete'='true'
          ORDER BY c->>'checkedAt' DESC,s.sequence DESC LIMIT 1`,[identity.configHash,identity.manifestHash,identity.instrumentId,sourceId])).rows[0];
        if (success) {
          const snapshot=this.decode(success,manifest).snapshot,coverage=snapshot.coverage.find(c=>c.sourceId===sourceId&&c.role==='news');
          if (coverage?.complete && ['AVAILABLE','EMPTY'].includes(coverage.status) && 'acquisition' in coverage && coverage.acquisition?.pages.length) {
            const times=coverage.acquisition.pages.map(page=>researchTime(page.fetchedAt));
            if (Math.max(...times)<=now) latestSuccessfulStart=Math.min(researchTime(coverage.acquisition.asOf),...times);
          }
        }
      }
      if (latestSuccessfulStart>researchTime(iso(call.recorded_at))) continue;
      const slotKey=researchRefreshSlotKey(identity.manifestHash,identity.instrumentId,sourceId,'news',matchedSlot);
      const published=(await db.query(`SELECT s.* FROM research_refresh_slots r JOIN research_snapshots s ON s.id=r.snapshot_id WHERE r.slot_key=$1`,[slotKey])).rows[0];
      if (!published) return true;
      const snapshot=this.decode(published,manifest).snapshot,coverage=snapshot.coverage.find(c=>c.sourceId===sourceId&&c.role==='news');
      if (snapshot.configHash!==identity.configHash || snapshot.manifestHash!==identity.manifestHash || snapshot.instrumentId!==identity.instrumentId || !coverage || !marketauxTransientFailure(coverage)
        || coverage.checkedAt!==marketauxWindow(matchedSlot).asOf || researchTime(snapshot.createdAt)<researchTime(iso(call.recorded_at))) return true;
    }
    return false;
  }
  private async marketauxBudgetRecoveries(identity: ResearchRepairIdentity, manifest: ResearchManifest, stored: StoredResearchSnapshot | null, now: number, db: ResearchDb): Promise<{ assessments: MarketauxBudgetRecoveryAssessment[]; diagnostics: Map<string, ResearchLocalBudgetDiagnostic> }> {
    const assessments: MarketauxBudgetRecoveryAssessment[] = [], diagnostics = new Map<string, ResearchLocalBudgetDiagnostic>();
    const policy = manifest.instruments.find(p => p.instrumentId === identity.instrumentId);
    if (!stored || !policy) return { assessments, diagnostics };
    const day = new Date(now).toISOString().slice(0, 10);
    for (const source of policy.sources.filter(s => s.adapter === "marketaux-news")) {
      const coverage = stored.snapshot.coverage.find(c => c.sourceId === source.id && c.role === "news");
      if (!coverage || !marketauxLocalBudgetFailure(coverage)) continue;
      const providers = manifest.instruments.flatMap(p => p.sources).filter(s => s.provider === source.provider);
      const maxRequestsPerDay = Math.min(...providers.map(s => s.maxRequestsPerDay)), maxCostMicrosPerDay = Math.min(...providers.map(s => s.maxCostMicrosPerDay));
      const nextCallCostMicros = Math.max(...providers.map(s => s.costMicrosPerCall));
      const usage = (await db.query(`SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost
        FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3`, [identity.accountId, source.provider, day])).rows[0];
      const requestsUsed = Number(usage.requests), costUsedMicros = Number(usage.cost);
      researchAssert([maxRequestsPerDay,maxCostMicrosPerDay,nextCallCostMicros,requestsUsed,costUsedMicros].every(n => Number.isSafeInteger(n) && n >= 0), "RESEARCH_BUDGET_INVALID");
      const diagnostic: ResearchLocalBudgetDiagnostic = { kind: "LOCAL_RESEARCH_BUDGET", failedBudgetDay: null, failureRecordedAt: null,
        currentBudgetDay: day, requestsUsed, maxRequestsPerDay, costUsedMicros, maxCostMicrosPerDay, nextCallCostMicros,
        nextBudgetResetAt: new Date(Date.parse(day) + 86_400_000).toISOString(), recoveryProof: "UNAVAILABLE" };
      diagnostics.set(source.id, diagnostic);
      if (maxRequestsPerDay === 0 || nextCallCostMicros > maxCostMicrosPerDay) continue;
      const interval = researchRefreshInterval(source, "news"), slot = researchRefreshSlot(source, "news", researchTime(coverage.checkedAt) + 1000), window = marketauxWindow(slot);
      if (window.asOf !== coverage.checkedAt || window.windowStart !== coverage.windowStart || window.asOf !== coverage.windowEnd) continue;
      const slotKey = researchRefreshSlotKey(identity.manifestHash, identity.instrumentId, source.id, "news", slot);
      const originalRow = (await db.query(`SELECT s.*,r.published_at AS slot_published_at FROM research_refresh_slots r
        JOIN research_snapshots s ON s.id=r.snapshot_id WHERE r.slot_key=$1`, [slotKey])).rows[0];
      if (!originalRow) continue;
      const original = this.decode(originalRow, manifest).snapshot;
      const originalCoverage = original.coverage.find(c => c.sourceId === source.id && c.role === "news");
      if (original.configHash !== identity.configHash || original.manifestHash !== identity.manifestHash || original.instrumentId !== identity.instrumentId
        || original.mappingHash !== stored.snapshot.mappingHash || !originalCoverage || canonicalJson(originalCoverage) !== canonicalJson(coverage)) continue;
      const recordedAt = researchTime(original.createdAt), publishedAt = researchTime(iso(originalRow.slot_published_at));
      if (recordedAt < slot * interval || publishedAt < recordedAt || publishedAt >= (slot + 1) * interval || publishedAt > now) continue;
      const failedDay = new Date(slot * interval).toISOString().slice(0, 10);
      if (new Date(recordedAt).toISOString().slice(0, 10) !== failedDay || new Date(publishedAt).toISOString().slice(0, 10) !== failedDay) continue;
      const config = parseMarketauxNewsConfig(source, policy), expected = new Map<string, { requestHash: string; pass: number; page: number }>();
      for (const pass of [1, 2] as const) for (let page = 1; page <= config.maxPagesPerPass; page++) {
        const call = marketauxCallIdentity(identity.manifestHash, identity.instrumentId, source, { sourceUrl: source.urls[0], ...window, pass, page });
        expected.set(call.callKey, { requestHash: call.requestHash, pass, page });
      }
      const calls = (await db.query(`SELECT r.*,r.budget_day::text AS budget_day,o.outcome,o.recorded_at FROM research_call_reservations r
        LEFT JOIN research_call_outcomes o USING(call_key) WHERE r.call_key=ANY($1::text[]) ORDER BY r.reserved_at,r.call_key`, [[...expected.keys()]])).rows;
      const firstKey = marketauxCallIdentity(identity.manifestHash, identity.instrumentId, source, { sourceUrl: source.urls[0], ...window, pass: 1, page: 1 }).callKey;
      if (calls.length && calls[0].call_key !== firstKey) continue;
      const acquisitionStart = calls.length ? researchTime(iso(calls[0].reserved_at)) : recordedAt;
      if (acquisitionStart < slot * interval || recordedAt - acquisitionStart > 120_000) continue;
      let invalid = false, previousPass = 1, previousPage = 0, previousOutcome = acquisitionStart;
      for (const call of calls) {
        const descriptor = expected.get(String(call.call_key))!;
        const reservedAt = researchTime(iso(call.reserved_at)), deadlineAt = researchTime(iso(call.deadline_at));
        const outcomeAt = call.recorded_at ? researchTime(iso(call.recorded_at)) : NaN;
        const callDay = String(call.budget_day);
        if (call.account_id !== identity.accountId || call.provider !== source.provider || call.kind !== "source" || call.config_hash !== identity.configHash || call.manifest_hash !== identity.manifestHash
          || call.request_hash !== descriptor.requestHash || callDay !== failedDay || new Date(reservedAt).toISOString().slice(0, 10) !== failedDay
          || Number(call.reserved_cost_micros) < nextCallCostMicros || reservedAt < previousOutcome || reservedAt >= deadlineAt || deadlineAt > reservedAt + 10_000 || deadlineAt > acquisitionStart + 120_000
          || call.outcome !== "SUCCEEDED" || !Number.isFinite(outcomeAt) || outcomeAt < reservedAt || outcomeAt >= deadlineAt || outcomeAt > recordedAt
          || descriptor.pass < previousPass || descriptor.page !== (descriptor.pass === previousPass ? previousPage + 1 : 1)) { invalid = true; break; }
        previousPass = descriptor.pass; previousPage = descriptor.page; previousOutcome = outcomeAt;
      }
      if (invalid) continue;
      const historical = (await db.query(`SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost
        FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3 AND reserved_at<=$4`, [identity.accountId, source.provider, failedDay, new Date(recordedAt)])).rows[0];
      if (Number(historical.requests) < maxRequestsPerDay && Number(historical.cost) + nextCallCostMicros <= maxCostMicrosPerDay) continue;
      diagnostic.failedBudgetDay = failedDay; diagnostic.failureRecordedAt = original.createdAt; diagnostic.recoveryProof = "VERIFIED";
      if (failedDay >= day || requestsUsed >= maxRequestsPerDay || costUsedMicros + nextCallCostMicros > maxCostMicrosPerDay) continue;
      assessments.push({ snapshotId: stored.id, sourceId: source.id, coverageHash: researchHash(coverage), slot, failedBudgetDay: failedDay,
        failureRecordedAt: original.createdAt, nextCheckAt: new Date(Math.max(now, (slot + 1) * interval)).toISOString() });
    }
    return { assessments, diagnostics };
  }
  private async legacyMarketauxRecoveries(identity: ResearchRepairIdentity, manifest: ResearchManifest, stored: StoredResearchSnapshot | null, now: number, db: ResearchDb): Promise<MarketauxLegacyRecoveryAssessment[]> {
    const policy=manifest.instruments.find(p=>p.instrumentId===identity.instrumentId), result:MarketauxLegacyRecoveryAssessment[]=[];
    if (!stored || !policy) return result;
    for (const source of policy.sources.filter(s=>s.adapter==='marketaux-news')) {
      const coverage=stored.snapshot.coverage.find(c=>c.sourceId===source.id&&c.role==='news');
      if (!coverage || coverage.status!=='ERROR' || coverage.complete || coverage.evidenceRefs.length || coverage.reason!=='RESEARCH_MARKETAUX_ACQUISITION_FAILED' || Object.hasOwn(coverage,'sourceError')) continue;
      const slot=researchRefreshSlot(source,'news',researchTime(coverage.checkedAt)+1000), window=marketauxWindow(slot);
      if (window.asOf!==coverage.checkedAt) continue;
      const slotKey=researchRefreshSlotKey(identity.manifestHash,identity.instrumentId,source.id,'news',slot);
      const originalRow=(await db.query(`SELECT s.*,r.published_at AS slot_published_at FROM research_refresh_slots r
        JOIN research_snapshots s ON s.id=r.snapshot_id WHERE r.slot_key=$1`,[slotKey])).rows[0];
      if (!originalRow) continue;
      const original=this.decode(originalRow,manifest);
      if (original.snapshot.configHash!==identity.configHash || original.snapshot.manifestHash!==identity.manifestHash || original.snapshot.instrumentId!==identity.instrumentId || original.snapshot.mappingHash!==stored.snapshot.mappingHash) continue;
      const originalCoverage=original.snapshot.coverage.find(c=>c.sourceId===source.id&&c.role==='news');
      if (!originalCoverage || canonicalJson(originalCoverage)!==canonicalJson(coverage)) continue;
      const config=parseMarketauxNewsConfig(source,policy), expected=new Map<string,string>();
      for (const pass of [1,2] as const) for (let page=1;page<=config.maxPagesPerPass;page++) {
        const call=marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...window,pass,page});expected.set(call.callKey,call.requestHash);
      }
      const calls=(await db.query(`SELECT r.*,o.outcome,o.recorded_at FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key) WHERE r.call_key=ANY($1::text[])`,[[...expected.keys()]])).rows;
      const firstKey=marketauxCallIdentity(identity.manifestHash,identity.instrumentId,source,{sourceUrl:source.urls[0],...window,pass:1,page:1}).callKey;
      const first=calls.find(call=>call.call_key===firstKey);
      if (!first) continue;
      const acquisitionStart=researchTime(iso(first.reserved_at));
      if (acquisitionStart<slot*researchRefreshInterval(source,'news') || acquisitionStart>=(slot+1)*researchRefreshInterval(source,'news')) continue;
      const publication=Math.min(researchTime(original.snapshot.createdAt),researchTime(iso(originalRow.slot_published_at)));
      if (!calls.length || publication>now || calls.some(call=>call.account_id!==identity.accountId || call.provider!==source.provider || call.kind!=='source' || call.config_hash!==identity.configHash || call.manifest_hash!==identity.manifestHash || call.request_hash!==expected.get(String(call.call_key))
        || researchTime(iso(call.reserved_at))<acquisitionStart || researchTime(iso(call.deadline_at))>acquisitionStart+120000 || researchTime(iso(call.reserved_at))>=researchTime(iso(call.deadline_at))
        || !['SUCCEEDED','UNKNOWN'].includes(String(call.outcome)) || !call.recorded_at || researchTime(iso(call.recorded_at))>publication || researchTime(iso(call.deadline_at))>now
        || call.outcome==='UNKNOWN'&&researchTime(iso(call.recorded_at))<researchTime(iso(call.deadline_at)))) continue;
      if (!calls.some(call=>call.outcome==='UNKNOWN')) continue;
      result.push({snapshotId:stored.id,sourceId:source.id,coverageHash:researchHash(coverage),slot,nextCheckAt:new Date(Math.max((slot+1)*researchRefreshInterval(source,'news'),...calls.map(call=>researchTime(iso(call.deadline_at))))).toISOString()});
    }
    return result;
  }
  private async transaction<T>(fn: (db: ResearchDb) => Promise<T>, existing?: ResearchDb): Promise<T> {
    if (existing) return fn(existing);
    const db = await this.pool.connect();
    try { await db.query("BEGIN"); const result = await fn(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  private async now(db: ResearchDb): Promise<number> { return researchTime(iso((await db.query("SELECT clock_timestamp() AS now")).rows[0].now)); }
  async registerManifest(input: { manifest: ResearchManifest; configuration: TradingConfigurationV1; tradingEnabled: boolean; adopt: boolean }): Promise<{ hash: string }> {
    const manifest = parseResearchManifest(input.manifest, input.configuration, input.manifest.configHash), hash = researchHash(manifest);
    return this.transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`research-authority:${manifest.configHash}`]);
      const config = (await db.query("SELECT canonical_json FROM trading_configuration_snapshots WHERE effective_hash=$1", [manifest.configHash])).rows[0];
      researchAssert(config && typeof config.canonical_json === "string", "RESEARCH_CONFIG_NOT_REGISTERED");
      parseResearchManifest(manifest, decodeTradingConfigurationSnapshot(config.canonical_json, manifest.configHash), manifest.configHash);
      const canonical = canonicalJson(manifest);
      await db.query("INSERT INTO research_manifests(manifest_hash,config_hash,canonical_json) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [hash, manifest.configHash, canonical]);
      researchAssert((await db.query("SELECT canonical_json FROM research_manifests WHERE manifest_hash=$1", [hash])).rows[0]?.canonical_json === canonical, "RESEARCH_MANIFEST_CONFLICT");
      const authority = (await db.query("SELECT manifest_hash FROM research_authority WHERE config_hash=$1 FOR UPDATE", [manifest.configHash])).rows[0];
      if (authority?.manifest_hash !== hash && input.adopt) {
        researchAssert(!input.tradingEnabled, "RESEARCH_ADOPTION_REQUIRES_DISABLED_WRITES");
        await db.query("LOCK TABLE research_observations IN SHARE MODE");
        const active = await db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM research_observations WHERE expires_at>clock_timestamp() AND trading_enabled)
          OR EXISTS(SELECT 1 FROM proposal_ai_reviews WHERE claim_until>clock_timestamp()
            OR (delivery_started_at IS NOT NULL AND (delivery_outcome IS NULL OR delivery_outcome ILIKE '%unknown%')))
          OR EXISTS(SELECT 1 FROM research_call_reservations r LEFT JOIN research_call_outcomes o USING(call_key)
            WHERE r.kind='model' AND (o.call_key IS NULL OR o.outcome='UNKNOWN'))
          OR EXISTS(SELECT 1 FROM research_wsh_acquisitions WHERE state='PENDING' AND retired_at IS NULL)`);
        researchAssert(!active.rows.length, "RESEARCH_ADOPTION_ACTIVE_OR_UNKNOWN_WORK");
        await db.query(`INSERT INTO research_authority(config_hash,manifest_hash) VALUES($1,$2) ON CONFLICT(config_hash)
          DO UPDATE SET manifest_hash=EXCLUDED.manifest_hash,adopted_at=clock_timestamp()`, [manifest.configHash, hash]);
        await db.query("INSERT INTO research_authority_history(config_hash,manifest_hash,previous_hash,entries_disabled) VALUES($1,$2,$3,TRUE)", [manifest.configHash, hash, authority?.manifest_hash ?? null]);
      }
      return { hash };
    });
  }
  async observe(input: ResearchIdentity & { service: "execution-engine" | "llm-agent"; processId: string; tradingEnabled: boolean }): Promise<void> {
    researchAssert(input.processId.length > 0 && input.processId.length <= 200 && typeof input.tradingEnabled === "boolean");
    const result = await this.pool.query(`WITH stamp AS (SELECT clock_timestamp() AS now)
      INSERT INTO research_observations(process_id,service,config_hash,manifest_hash,trading_enabled,observed_at,expires_at)
      SELECT $1,$2,$3,$4,$5,now,now+interval '30 seconds' FROM stamp
      ON CONFLICT(process_id) DO UPDATE SET observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,trading_enabled=EXCLUDED.trading_enabled
      WHERE research_observations.service=EXCLUDED.service AND research_observations.config_hash=EXCLUDED.config_hash AND research_observations.manifest_hash=EXCLUDED.manifest_hash RETURNING process_id`,
    [input.processId, input.service, input.configHash, input.manifestHash, input.tradingEnabled]);
    researchAssert(result.rows.length === 1, "RESEARCH_PROCESS_IDENTITY_CHANGED");
  }
  async assertAuthority(identity: ResearchIdentity, existing?: ResearchDb): Promise<{ validUntilMs: number }> {
    return this.transaction(async db => {
      researchAssert(isResearchHash(identity.configHash) && isResearchHash(identity.manifestHash));
      const row = (await db.query("SELECT manifest_hash FROM research_authority WHERE config_hash=$1 FOR SHARE", [identity.configHash])).rows[0];
      researchAssert(row?.manifest_hash === identity.manifestHash, "RESEARCH_AUTHORITY_MISMATCH");
      await db.query("LOCK TABLE research_observations IN SHARE MODE");
      const observations = (await db.query("SELECT * FROM research_observations WHERE expires_at>clock_timestamp() AND observed_at<=clock_timestamp()")).rows;
      for (const service of ["execution-engine", "llm-agent"]) {
        const peers = observations.filter(o => o.service === service);
        researchAssert(peers.length > 0 && peers.every(o => o.config_hash === identity.configHash && o.manifest_hash === identity.manifestHash), "RESEARCH_PEER_MISSING_OR_DRIFTED");
      }
      return { validUntilMs: Math.min(...observations.map(o => researchTime(iso(o.expires_at)))) };
    }, existing);
  }
  private async readManifest(identity: ResearchIdentity, db: ResearchDb): Promise<ResearchManifest> {
    const row = (await db.query(`SELECT r.canonical_json,c.canonical_json AS config_json FROM research_manifests r
      JOIN trading_configuration_snapshots c ON c.effective_hash=r.config_hash WHERE r.manifest_hash=$1 AND r.config_hash=$2`, [identity.manifestHash, identity.configHash])).rows[0];
    researchAssert(row && typeof row.canonical_json === "string" && typeof row.config_json === "string", "RESEARCH_MANIFEST_MISSING");
    const manifest = parseResearchManifest(JSON.parse(row.canonical_json), decodeTradingConfigurationSnapshot(row.config_json, identity.configHash), identity.configHash);
    researchAssert(researchHash(manifest) === identity.manifestHash && canonicalJson(manifest) === row.canonical_json, "RESEARCH_MANIFEST_CORRUPT"); return manifest;
  }
  private decode(row: Record<string, unknown>, manifest: ResearchManifest): StoredResearchSnapshot {
    researchAssert(typeof row.canonical_json === "string" && typeof row.id === "string");
    const snapshot = parseResearchSnapshot(JSON.parse(row.canonical_json), manifest), hash = researchHash(snapshot), sequence = Number(row.sequence);
    researchAssert(hash === row.snapshot_hash && canonicalJson(snapshot) === row.canonical_json && Number.isSafeInteger(sequence) && sequence > 0, "RESEARCH_SNAPSHOT_CORRUPT");
    return { id: row.id, hash, sequence, snapshot };
  }
  async storeSnapshot(input: ResearchSnapshot, refreshSlot?: string, admissionDeadlineAt?: string): Promise<StoredResearchSnapshot> {
    return this.persistSnapshot(input, refreshSlot, admissionDeadlineAt);
  }
  private async persistSnapshot(input: ResearchSnapshot, refreshSlot?: string, admissionDeadlineAt?: string, existing?: ResearchDb, publishingAcquisitionId?: string): Promise<StoredResearchSnapshot> {
    if (admissionDeadlineAt !== undefined) researchTime(admissionDeadlineAt);
    return this.transaction(async db => {
      await this.assertAuthority(input, db); const manifest = await this.readManifest(input, db), snapshot = parseResearchSnapshot(input, manifest);
      await this.assertWshSnapshotProvenance(snapshot, db, publishingAcquisitionId);
      researchAssert(researchTime(snapshot.createdAt) <= await this.now(db), "RESEARCH_FUTURE_SNAPSHOT");
      const key = [snapshot.configHash, snapshot.manifestHash, snapshot.instrumentId];
      await db.query("INSERT INTO research_snapshot_heads(config_hash,manifest_hash,instrument_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", key);
      const head = (await db.query("SELECT sequence,snapshot_id FROM research_snapshot_heads WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3 FOR UPDATE", key)).rows[0];
      if (head.snapshot_id) {
        const previous = await this.readSnapshot(String(head.snapshot_id), db); researchAssert(previous, "RESEARCH_HEAD_CORRUPT");
        researchAssert(researchTime(snapshot.createdAt) >= researchTime(previous.snapshot.createdAt), "RESEARCH_REFRESH_OUT_OF_ORDER");
        for (const result of snapshot.coverage) {
          const old = previous.snapshot.coverage.find(c => c.sourceId === result.sourceId && c.role === result.role);
          researchAssert(!old || researchTime(result.checkedAt) >= researchTime(old.checkedAt), "RESEARCH_REFRESH_OUT_OF_ORDER");
        }
      }
      const sequence = Number(head.sequence) + 1; researchAssert(Number.isSafeInteger(sequence));
      const id = randomUUID(), hash = researchHash(snapshot);
      if (admissionDeadlineAt !== undefined) researchAssert(await this.now(db) < researchTime(admissionDeadlineAt), "RESEARCH_SNAPSHOT_ADMISSION_EXPIRED");
      const inserted = await db.query(`INSERT INTO research_snapshots(id,snapshot_hash,config_hash,manifest_hash,instrument_id,sequence,canonical_json)
        SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $8::timestamptz IS NULL OR clock_timestamp() < $8::timestamptz RETURNING id`,
        [id, hash, ...key, sequence, canonicalJson(snapshot), admissionDeadlineAt ?? null]);
      researchAssert(inserted.rows.length === 1, "RESEARCH_SNAPSHOT_ADMISSION_EXPIRED");
      await db.query("UPDATE research_snapshot_heads SET snapshot_id=$4,sequence=$5 WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3", [...key, id, sequence]);
      if (refreshSlot !== undefined) {
        researchAssert(refreshSlot.length > 0 && refreshSlot.length <= 1000, "RESEARCH_REFRESH_SLOT_INVALID");
        await db.query("INSERT INTO research_refresh_slots(slot_key,snapshot_id) VALUES($1,$2)", [refreshSlot, id]);
      }
      return { id, hash, sequence, snapshot };
    }, existing);
  }
  async latestSnapshot(identity: ResearchIdentity & { instrumentId: string }, existing?: ResearchDb, lockHead = false): Promise<StoredResearchSnapshot | null> {
    return this.transaction(async db => {
      const manifest = await this.readManifest(identity, db);
      const head = (await db.query(`SELECT snapshot_id FROM research_snapshot_heads WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3${lockHead ? " FOR UPDATE" : ""}`, [identity.configHash, identity.manifestHash, identity.instrumentId])).rows[0];
      if (!head?.snapshot_id) return null;
      const row = (await db.query("SELECT * FROM research_snapshots WHERE id=$1", [head.snapshot_id])).rows[0];
      researchAssert(row, "RESEARCH_HEAD_CORRUPT"); return this.decode(row, manifest);
    }, existing);
  }
  async readSnapshot(id: string, existing?: ResearchDb): Promise<StoredResearchSnapshot | null> {
    return this.transaction(async db => {
      const row = (await db.query("SELECT * FROM research_snapshots WHERE id=$1", [id])).rows[0];
      if (!row) return null;
      const manifest = await this.readManifest({ configHash: String(row.config_hash), manifestHash: String(row.manifest_hash) }, db);
      return this.decode(row, manifest);
    }, existing);
  }
  async getBinding(proposalId: number, existing?: ResearchDb): Promise<ResearchBinding | null> {
    const row = (await (existing ?? this.pool).query("SELECT * FROM research_bindings WHERE proposed_order_id=$1", [proposalId])).rows[0];
    return row ? { proposalId: Number(row.proposed_order_id), clientOrderHash: String(row.client_order_hash), instrumentId: String(row.instrument_id), configHash: String(row.config_hash), manifestHash: String(row.manifest_hash), snapshotId: String(row.snapshot_id), snapshotHash: String(row.snapshot_hash), sequence: Number(row.sequence) } : null;
  }
  async bind(input: ResearchBindingIdentity, existing?: ResearchDb): Promise<ValidatedResearchBinding> {
    return this.transaction(async db => {
      const proposal = (await db.query("SELECT * FROM proposed_orders WHERE id=$1 FOR UPDATE", [input.proposalId])).rows[0];
      const review = (await db.query("SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1 FOR UPDATE", [input.proposalId])).rows[0];
      researchAssert(proposal && review && proposal.client_order_hash_version === 2 && review.client_order_hash_version === 2 &&
        canonicalJson(proposal.strategy_attribution) === canonicalJson(review.strategy_attribution) && canonicalJson(proposal.strategy_trigger) === canonicalJson(review.strategy_trigger) &&
        proposal.conid === review.conid && review.instrument_id === input.instrumentId && proposal.client_order_hash === input.clientOrderHash && proposal.instrument_id === input.instrumentId && proposal.strategy_configuration_hash === input.configHash && review.client_order_hash === input.clientOrderHash && review.status === "PENDING" && !review.decision_json && !review.decided_at && !review.delivery_started_at && !review.delivery_outcome && proposal.status === "PROPOSED" && !proposal.execution_attempted_at && !proposal.broker_order_id, "RESEARCH_PROPOSAL_BINDING_INVALID");
      await this.assertAuthority(input, db);
      if (!(await this.getBinding(input.proposalId, db))) {
        const manifest = await this.readManifest(input, db), stored = await this.latestSnapshot(input, db, true);
        researchAssert(stored, "RESEARCH_SNAPSHOT_MISSING"); const eligibility = evaluateResearchEligibility(stored.snapshot, manifest, await this.now(db));
        researchAssert(eligibility.eligible, `RESEARCH_INELIGIBLE:${eligibility.reasons.join(",")}`);
        await db.query("INSERT INTO research_bindings(proposed_order_id,client_order_hash,config_hash,manifest_hash,instrument_id,snapshot_id,snapshot_hash,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [input.proposalId, input.clientOrderHash, input.configHash, input.manifestHash, input.instrumentId, stored.id, stored.hash, stored.sequence]);
      }
      return this.validateBinding(input, db, true);
    }, existing);
  }
  async validateBinding(input: ResearchBindingIdentity, existing?: ResearchDb, lockHead = true): Promise<ValidatedResearchBinding> {
    return this.transaction(async db => {
      await this.assertAuthority(input, db);
      const binding = await this.getBinding(input.proposalId, db);
      researchAssert(binding && binding.clientOrderHash === input.clientOrderHash && binding.configHash === input.configHash && binding.manifestHash === input.manifestHash && binding.instrumentId === input.instrumentId, "RESEARCH_BINDING_MISMATCH");
      const stored = await this.latestSnapshot(input, db, lockHead);
      researchAssert(stored && stored.id === binding.snapshotId && stored.hash === binding.snapshotHash && stored.sequence === binding.sequence, "RESEARCH_SNAPSHOT_SUPERSEDED");
      const manifest = await this.readManifest(input, db), eligibility = evaluateResearchEligibility(stored.snapshot, manifest, await this.now(db));
      researchAssert(eligibility.eligible, `RESEARCH_INELIGIBLE:${eligibility.reasons.join(",")}`);
      return { binding, stored, manifest, eligibility };
    }, existing);
  }
  async reserveCall(input: ResearchCallReservation, existing?: ResearchDb): Promise<{ callKey: string; reservedAt: string; budgetDay: string }> {
    for (const n of [input.reservedCostMicros, input.maxRequestsPerDay, input.maxCostMicrosPerDay]) researchAssert(Number.isSafeInteger(n) && n >= 0, "RESEARCH_BUDGET_INVALID");
    researchAssert(/^[A-Za-z0-9_-]{1,80}$/.test(input.accountId) && input.provider.length > 0 && input.provider.length <= 200 && input.callKey.length > 0 && input.callKey.length <= 1000 && isResearchHash(input.requestHash));
    return this.transaction(async db => {
      const authority = await this.assertAuthority(input, db);
      const manifest = await this.readManifest(input, db);
      const limits = input.kind === "model" ? manifest.model.provider === input.provider ? [{ requests: manifest.model.maxRequestsPerDay, cost: manifest.model.maxCostMicrosPerDay, perCall: manifest.model.maxCostMicrosPerCall }] : [] :
        manifest.refreshEnabled ? manifest.instruments.flatMap(i => i.sources).filter(s => s.provider === input.provider).map(s => ({ requests: s.maxRequestsPerDay, cost: s.maxCostMicrosPerDay, perCall: s.costMicrosPerCall })) : [];
      researchAssert(limits.length && input.maxRequestsPerDay <= Math.min(...limits.map(l => l.requests)) && input.maxCostMicrosPerDay <= Math.min(...limits.map(l => l.cost)) && input.reservedCostMicros >= Math.max(...limits.map(l => l.perCall)), "RESEARCH_BUDGET_MANIFEST_MISMATCH");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`research-budget:${input.accountId}:${input.provider}`]);
      const now = await this.now(db), day = new Date(now).toISOString().slice(0, 10), deadline = researchTime(input.deadlineAt);
      researchAssert(now < authority.validUntilMs, "RESEARCH_PEER_MISSING_OR_DRIFTED");
      researchAssert(deadline > now && deadline <= now + 10000, "RESEARCH_CALL_DEADLINE_INVALID");
      researchAssert(!(await db.query("SELECT 1 FROM research_call_reservations WHERE call_key=$1", [input.callKey])).rows.length, "RESEARCH_CALL_ALREADY_RESERVED");
      const usage = (await db.query("SELECT count(*) AS requests,coalesce(sum(reserved_cost_micros),0) AS cost FROM research_call_reservations WHERE account_id=$1 AND provider=$2 AND budget_day=$3", [input.accountId, input.provider, day])).rows[0];
      researchAssert(Number(usage.requests) < input.maxRequestsPerDay && Number(usage.cost) + input.reservedCostMicros <= input.maxCostMicrosPerDay, "RESEARCH_BUDGET_EXHAUSTED");
      await db.query("INSERT INTO research_call_reservations(call_key,account_id,provider,kind,config_hash,manifest_hash,request_hash,reserved_cost_micros,reserved_at,deadline_at,budget_day) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [input.callKey, input.accountId, input.provider, input.kind, input.configHash, input.manifestHash, input.requestHash, input.reservedCostMicros, new Date(now).toISOString(), input.deadlineAt, day]);
      return { callKey: input.callKey, reservedAt: new Date(now).toISOString(), budgetDay: day };
    }, existing);
  }
  // Lock order: caller proposal/review locks, authority/observations, WSH endpoint
  // row (WSH writers only), budget, snapshot head. Endpoint session lock is held
  // outside transactions. No acquisition takes proposal/review locks.
  async withWshEndpointLock(endpointId: string, run: (lease: WshEndpointLease) => Promise<void>): Promise<boolean> {
    researchAssert(endpointId.length > 0 && endpointId.length <= 500);
    const db = await this.pool.connect(), key = `research-wsh-endpoint:${endpointId}`;
    let locked = false;
    const lease: WshEndpointLease = { endpointId, assertHeld: async () => {
      researchAssert(this.wshLeases.get(lease) === db, "RESEARCH_WSH_LOCK_LOST");
      const found = (await db.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
        AND classid=((hashtext($1)::bigint >> 32) & 4294967295)::oid
        AND objid=(hashtext($1)::bigint & 4294967295)::oid AND objsubid=1 AND granted`, [key])).rows;
      researchAssert(found.length === 1, "RESEARCH_WSH_LOCK_LOST");
    } };
    try {
      locked = (await db.query("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked", [key])).rows[0]?.locked === true;
      if (!locked) return false;
      this.wshLeases.set(lease, db); await run(lease); return true;
    } finally {
      this.wshLeases.delete(lease);
      try { if (locked) await db.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]); }
      finally { db.release(); }
    }
  }
  private async wshTransaction<T>(lease: WshEndpointLease, fn: (db: ResearchDb) => Promise<T>): Promise<T> {
    await lease.assertHeld(); const db = this.wshLeases.get(lease); researchAssert(db, "RESEARCH_WSH_LOCK_LOST");
    try { await db.query("BEGIN"); const result = await fn(db); await lease.assertHeld(); await db.query("COMMIT"); return result; }
    catch (error) { try { await db.query("ROLLBACK"); } catch { /* Preserve the original uncertain result. */ } throw error; }
  }
  private async wshSource(identity: ResearchIdentity & { sourceId: string; instrumentId: string }, db: ResearchDb) {
    const manifest = await this.readManifest(identity, db); researchAssert(manifest.schemaVersion === 2, "RESEARCH_WSH_VERSION_INVALID");
    const policy = manifest.instruments.find(p => p.instrumentId === identity.instrumentId), source = policy?.sources.find(s => s.id === identity.sourceId);
    researchAssert(policy && source, "RESEARCH_WSH_SOURCE_INVALID"); const config = parseWshConfig(source, policy);
    researchAssert(source.automation === "PERMITTED" && !["UNVERIFIED","DENIED"].includes(source.retention), "RESEARCH_PERMISSION_UNVERIFIED");
    wshQualificationDeadline(config, await this.now(db)); return { manifest, policy, source, config };
  }
  private async assertWshFence(lease: WshEndpointLease, acquisition: WshAcquisition, db: ResearchDb): Promise<void> {
    researchAssert(acquisition.endpointId === lease.endpointId, "RESEARCH_WSH_FENCE_MISMATCH");
    const endpoint = (await db.query("SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1 FOR UPDATE", [lease.endpointId])).rows[0];
    const row = (await db.query("SELECT * FROM research_wsh_acquisitions WHERE id=$1 FOR UPDATE", [acquisition.id])).rows[0];
    researchAssert(endpoint && Number(endpoint.generation) === acquisition.generation && row && Number(row.generation) === acquisition.generation && row.endpoint_id === acquisition.endpointId && row.session_id === acquisition.sessionId && row.source_id === acquisition.sourceId && row.instrument_id === acquisition.instrumentId && row.config_hash === acquisition.configHash && row.manifest_hash === acquisition.manifestHash && row.state === "PENDING" && row.retired_at === null, "RESEARCH_WSH_GENERATION_RETIRED");
  }
  async beginWshAcquisition(lease: WshEndpointLease, input: ResearchIdentity & { instrumentId: string; sourceId: string; sessionId: string; reservation: ResearchCallReservation }): Promise<WshAcquisition> {
    researchAssert(input.sessionId.length > 0 && input.sessionId.length <= 500);
    return this.wshTransaction(lease, async db => {
      await this.assertAuthority(input, db); const { config } = await this.wshSource(input, db);
      researchAssert(config.endpointId === lease.endpointId && input.reservation.kind === "source" && input.reservation.provider === "ibkr-wsh" && input.reservation.configHash === input.configHash && input.reservation.manifestHash === input.manifestHash, "RESEARCH_WSH_RESERVATION_INVALID");
      await db.query("INSERT INTO research_wsh_endpoints(endpoint_id) VALUES($1) ON CONFLICT DO NOTHING", [lease.endpointId]);
      await db.query("SELECT generation FROM research_wsh_endpoints WHERE endpoint_id=$1 FOR UPDATE", [lease.endpointId]);
      researchAssert(!(await db.query("SELECT 1 FROM research_wsh_acquisitions WHERE endpoint_id=$1 AND state='PENDING' AND retired_at IS NULL", [lease.endpointId])).rows.length, "RESEARCH_WSH_RECOVERY_REQUIRED");
      researchAssert(researchTime(input.reservation.deadlineAt) <= await this.now(db) + config.timeoutMs, "RESEARCH_WSH_CALL_DEADLINE_INVALID");
      const ledgerKey = wshLedgerKey(config.isin);
      researchAssert(!(await db.query("SELECT 1 FROM research_wsh_acquisitions WHERE ledger_key=$1 AND started_at>clock_timestamp()-interval '15 minutes'", [ledgerKey])).rows.length, "RESEARCH_WSH_SLOT_TOO_EARLY");
      const generation = Number((await db.query("UPDATE research_wsh_endpoints SET generation=generation+1 WHERE endpoint_id=$1 RETURNING generation", [lease.endpointId])).rows[0].generation);
      researchAssert(Number.isSafeInteger(generation)); const id = randomUUID();
      const row = (await db.query(`INSERT INTO research_wsh_acquisitions(id,endpoint_id,generation,session_id,source_id,instrument_id,ledger_key,config_hash,manifest_hash,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING') RETURNING started_at`, [id,lease.endpointId,generation,input.sessionId,input.sourceId,input.instrumentId,ledgerKey,input.configHash,input.manifestHash])).rows[0];
      await this.reserveCall(input.reservation, db);
      await db.query("INSERT INTO research_wsh_acquisition_calls(acquisition_id,call_key) VALUES($1,$2)", [id,input.reservation.callKey]);
      return { id,endpointId:lease.endpointId,generation,sessionId:input.sessionId,sourceId:input.sourceId,instrumentId:input.instrumentId,configHash:input.configHash,manifestHash:input.manifestHash,startedAt:iso(row.started_at) };
    });
  }
  async reserveWshCall(lease: WshEndpointLease, acquisition: WshAcquisition, reservation: ResearchCallReservation): Promise<void> {
    await this.wshTransaction(lease, async db => {
      await this.assertAuthority(acquisition, db); const { config } = await this.wshSource(acquisition, db); await this.assertWshFence(lease, acquisition, db);
      researchAssert(researchTime(reservation.deadlineAt) <= await this.now(db) + config.timeoutMs, "RESEARCH_WSH_CALL_DEADLINE_INVALID");
      researchAssert(reservation.kind === "source" && reservation.provider === "ibkr-wsh" && reservation.configHash === acquisition.configHash && reservation.manifestHash === acquisition.manifestHash, "RESEARCH_WSH_RESERVATION_INVALID");
      const metadata = (await db.query(`SELECT o.outcome,o.recorded_at,r.deadline_at FROM research_wsh_acquisition_calls c
        JOIN research_call_reservations r USING(call_key) LEFT JOIN research_call_outcomes o USING(call_key) WHERE c.acquisition_id=$1`, [acquisition.id])).rows;
      researchAssert(metadata.length === 1 && metadata[0].outcome === "SUCCEEDED" && researchTime(iso(metadata[0].recorded_at)) < researchTime(iso(metadata[0].deadline_at)), "RESEARCH_WSH_METADATA_NOT_COMPLETED");
      await this.reserveCall(reservation, db);
      await db.query("INSERT INTO research_wsh_acquisition_calls(acquisition_id,call_key) VALUES($1,$2)", [acquisition.id,reservation.callKey]);
    });
  }
  async assertWshAcquisition(lease: WshEndpointLease, acquisition: WshAcquisition): Promise<void> {
    await this.wshTransaction(lease, async db => { await this.assertAuthority(acquisition, db); await this.wshSource(acquisition, db); await this.assertWshFence(lease, acquisition, db); });
  }
  async readWshAcquisition(id: string): Promise<WshAcquisitionRecord | null> {
    const row = (await this.pool.query("SELECT * FROM research_wsh_acquisitions WHERE id=$1", [id])).rows[0];
    return row ? { ...row, generation: Number(row.generation) } as WshAcquisitionRecord : null;
  }
  async pendingWshAcquisition(lease: WshEndpointLease): Promise<WshAcquisition | null> {
    await lease.assertHeld();
    const row = (await this.pool.query("SELECT * FROM research_wsh_acquisitions WHERE endpoint_id=$1 AND state='PENDING' AND retired_at IS NULL", [lease.endpointId])).rows[0];
    return row ? { id:String(row.id),endpointId:String(row.endpoint_id),generation:Number(row.generation),sessionId:String(row.session_id),sourceId:String(row.source_id),instrumentId:String(row.instrument_id),configHash:String(row.config_hash),manifestHash:String(row.manifest_hash),startedAt:iso(row.started_at) } : null;
  }
  private async assertWshSnapshotProvenance(snapshot: ResearchSnapshot, db: ResearchDb, publishingId?: string): Promise<void> {
    if (snapshot.schemaVersion !== 2) return;
    for (const coverage of snapshot.coverage) {
      if (!("wshAcquisition" in coverage)) continue;
      const a = coverage.wshAcquisition;
      const row = (await db.query("SELECT * FROM research_wsh_acquisitions WHERE id=$1", [a.acquisitionId])).rows[0];
      researchAssert(row && row.config_hash === snapshot.configHash && row.manifest_hash === snapshot.manifestHash && row.instrument_id === snapshot.instrumentId && row.source_id === coverage.sourceId && Number(row.generation) === a.generation && row.session_id === a.sessionId && (row.state === "PUBLISHED" || row.state === "PENDING" && row.id === publishingId), "RESEARCH_WSH_ACQUISITION_INVALID");
      if (row.state === "PUBLISHED") {
        const original = (await db.query("SELECT canonical_json FROM research_snapshots WHERE id=$1", [row.snapshot_id])).rows[0];
        researchAssert(original && typeof original.canonical_json === "string", "RESEARCH_WSH_ACQUISITION_INVALID");
        const published = JSON.parse(original.canonical_json) as InstrumentResearchSnapshotV2;
        const projection = (value: ResearchSnapshot) => { const evidence = value.evidence.filter(e => e.sourceId === coverage.sourceId), refs = new Set(evidence.map(e => e.ref)); return { coverage: value.coverage.filter(c => c.sourceId === coverage.sourceId), evidence, events: value.events.filter(e => refs.has(e.evidenceRef)) }; };
        researchAssert(canonicalJson(projection(snapshot)) === canonicalJson(projection(published)), "RESEARCH_WSH_PUBLISHED_CONTEXT_IMMUTABLE");
      }
    }
    for (const e of snapshot.evidence) {
      if (e.published !== null) continue;
      const row = (await db.query("SELECT first_observed_at FROM research_wsh_first_observations WHERE ledger_key=$1 AND event_key=$2 AND version_hash=$3", [wshLedgerKey(e.issuerIdentifier.value),e.documentId,e.versionHash])).rows[0];
      researchAssert(row && iso(row.first_observed_at) === e.firstObservedAt, "RESEARCH_WSH_FIRST_OBSERVATION_INVALID");
    }
  }
  async publishWshSnapshot(lease: WshEndpointLease, acquisition: WshAcquisition, input: InstrumentResearchSnapshotV2, refreshSlot?: string, admissionDeadlineAt?: string): Promise<StoredResearchSnapshot> {
    return this.wshTransaction(lease, async db => {
      await this.assertAuthority(acquisition, db); await this.wshSource(acquisition, db); await this.assertWshFence(lease, acquisition, db);
      researchAssert(input.configHash === acquisition.configHash && input.manifestHash === acquisition.manifestHash && input.instrumentId === acquisition.instrumentId, "RESEARCH_WSH_PUBLICATION_IDENTITY_INVALID");
      const coverage = input.coverage.find(c => c.sourceId === acquisition.sourceId);
      researchAssert(coverage && "wshAcquisition" in coverage && coverage.wshAcquisition.acquisitionId === acquisition.id && coverage.complete, "RESEARCH_WSH_PUBLICATION_INVALID");
      const calls = (await db.query(`SELECT r.* FROM research_call_reservations r JOIN research_wsh_acquisition_calls c USING(call_key)
        WHERE c.acquisition_id=$1 ORDER BY r.reserved_at`, [acquisition.id])).rows;
      researchAssert(calls.length === 2 && calls[1].request_hash === coverage.wshAcquisition.requestHash && await this.now(db) < researchTime(iso(calls[1].deadline_at)), "RESEARCH_WSH_CALL_EXPIRED_OR_MISMATCHED");
      const snapshot = structuredClone(input);
      for (const e of snapshot.evidence) {
        if (e.published !== null || e.sourceId !== acquisition.sourceId) continue;
        await db.query("INSERT INTO research_wsh_first_observations(ledger_key,event_key,version_hash,acquisition_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [wshLedgerKey(e.issuerIdentifier.value),e.documentId,e.versionHash,acquisition.id]);
        const row = (await db.query("SELECT first_observed_at FROM research_wsh_first_observations WHERE ledger_key=$1 AND event_key=$2 AND version_hash=$3", [wshLedgerKey(e.issuerIdentifier.value),e.documentId,e.versionHash])).rows[0];
        e.firstObservedAt = iso(row.first_observed_at);
      }
      snapshot.createdAt = new Date(await this.now(db)).toISOString();
      const deadline = new Date(Math.min(researchTime(iso(calls[1].deadline_at)), admissionDeadlineAt ? researchTime(admissionDeadlineAt) : Infinity)).toISOString();
      const stored = await this.persistSnapshot(snapshot, refreshSlot, deadline, db, acquisition.id);
      for (const call of calls) await this.recordCallOutcome(String(call.call_key), "SUCCEEDED", db);
      await db.query("UPDATE research_wsh_acquisitions SET state='PUBLISHED',snapshot_id=$2,retired_at=clock_timestamp() WHERE id=$1", [acquisition.id,stored.id]);
      return stored;
    });
  }
  async retireWshAcquisition(lease: WshEndpointLease, acquisition: WshAcquisition, outcome: "FAILED" | "UNKNOWN", existing?: ResearchDb): Promise<void> {
    const retire = async (db: ResearchDb) => {
      await this.assertWshFence(lease, acquisition, db);
      const calls = (await db.query("SELECT call_key FROM research_wsh_acquisition_calls WHERE acquisition_id=$1", [acquisition.id])).rows;
      for (const call of calls) {
        const previous = (await db.query("SELECT 1 FROM research_call_outcomes WHERE call_key=$1", [call.call_key])).rows;
        if (!previous.length) await this.recordCallOutcome(String(call.call_key), outcome, db);
      }
      await db.query("UPDATE research_wsh_acquisitions SET state=$2,retired_at=clock_timestamp() WHERE id=$1", [acquisition.id,outcome]);
      await db.query("UPDATE research_wsh_endpoints SET generation=generation+1 WHERE endpoint_id=$1", [lease.endpointId]);
    };
    if (existing) await retire(existing); else await this.wshTransaction(lease, retire);
  }
  async finishWshFailure(lease: WshEndpointLease, acquisition: WshAcquisition, snapshot: InstrumentResearchSnapshotV2, outcome: "FAILED" | "UNKNOWN", refreshSlot?: string): Promise<StoredResearchSnapshot> {
    return this.wshTransaction(lease, async db => {
      await this.assertAuthority(acquisition, db); await this.assertWshFence(lease, acquisition, db);
      researchAssert(snapshot.configHash === acquisition.configHash && snapshot.manifestHash === acquisition.manifestHash && snapshot.instrumentId === acquisition.instrumentId && snapshot.coverage.some(c => c.sourceId === acquisition.sourceId && !c.complete && c.status !== "AVAILABLE" && c.status !== "EMPTY"), "RESEARCH_WSH_NEGATIVE_INVALID");
      researchAssert(!snapshot.evidence.some(e => e.sourceId === acquisition.sourceId) && !snapshot.events.some(e => snapshot.evidence.find(v => v.ref === e.evidenceRef)?.sourceId === acquisition.sourceId), "RESEARCH_WSH_NEGATIVE_INVALID");
      const stored = await this.persistSnapshot(snapshot, refreshSlot, undefined, db);
      await this.retireWshAcquisition(lease, acquisition, outcome, db);
      await db.query("UPDATE research_wsh_acquisitions SET snapshot_id=$2 WHERE id=$1", [acquisition.id,stored.id]); return stored;
    });
  }
  async recordCallOutcome(callKey: string, outcome: "SUCCESS" | "SUCCEEDED" | "FAILED" | "UNKNOWN", existing?: ResearchDb): Promise<void> {
    const normalized = outcome === "SUCCESS" ? "SUCCEEDED" : outcome, db = existing ?? this.pool;
    await db.query("INSERT INTO research_call_outcomes(call_key,outcome) VALUES($1,$2) ON CONFLICT DO NOTHING", [callKey, normalized]);
    researchAssert((await db.query("SELECT outcome FROM research_call_outcomes WHERE call_key=$1", [callKey])).rows[0]?.outcome === normalized, "RESEARCH_CALL_OUTCOME_IMMUTABLE");
  }
}
