import { parseWshConfig, wshQualificationDeadline, wshLedgerKey, type WshAcquisition, type WshAcquisitionRecord, type WshEndpointLease } from "./wsh.js";
import { randomUUID } from "node:crypto";
import { canonicalJson, decodeTradingConfigurationSnapshot } from "../trading-configuration/identity.js";
import type { TradingConfigurationV1 } from "../trading-configuration/types.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { isResearchHash, parseResearchManifest, parseResearchSnapshot, researchAssert, researchHash, researchTime } from "./validation.js";
import type { ResearchSnapshot, InstrumentResearchSnapshotV2, ResearchConnection, ResearchBinding, ResearchBindingIdentity, ResearchCallReservation, ResearchDb, ResearchIdentity, ResearchManifest, ResearchPool, StoredResearchSnapshot, ValidatedResearchBinding } from "./types.js";

const iso = (v: unknown): string => v instanceof Date ? v.toISOString() : String(v);
export class ResearchStore {
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
        proposal.conid === review.conid && review.instrument_id === input.instrumentId && proposal.client_order_hash === input.clientOrderHash && proposal.instrument_id === input.instrumentId && proposal.strategy_configuration_hash === input.configHash && review.client_order_hash === input.clientOrderHash && review.status === "PENDING" && !review.decision_json && !proposal.execution_attempted_at, "RESEARCH_PROPOSAL_BINDING_INVALID");
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
