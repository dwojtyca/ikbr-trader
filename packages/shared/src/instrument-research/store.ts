import { randomUUID } from "node:crypto";
import { canonicalJson, decodeTradingConfigurationSnapshot } from "../trading-configuration/identity.js";
import type { TradingConfigurationV1 } from "../trading-configuration/types.js";
import { evaluateResearchEligibility } from "./eligibility.js";
import { isResearchHash, parseResearchManifest, parseResearchSnapshot, researchAssert, researchHash, researchTime } from "./validation.js";
import type { InstrumentResearchSnapshotV1, ResearchBinding, ResearchBindingIdentity, ResearchCallReservation, ResearchDb, ResearchIdentity, ResearchManifestV1, ResearchPool, StoredResearchSnapshot, ValidatedResearchBinding } from "./types.js";

const iso = (v: unknown): string => v instanceof Date ? v.toISOString() : String(v);
export class ResearchStore {
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
  async registerManifest(input: { manifest: ResearchManifestV1; configuration: TradingConfigurationV1; tradingEnabled: boolean; adopt: boolean }): Promise<{ hash: string }> {
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
            WHERE r.kind='model' AND (o.call_key IS NULL OR o.outcome='UNKNOWN'))`);
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
  private async readManifest(identity: ResearchIdentity, db: ResearchDb): Promise<ResearchManifestV1> {
    const row = (await db.query(`SELECT r.canonical_json,c.canonical_json AS config_json FROM research_manifests r
      JOIN trading_configuration_snapshots c ON c.effective_hash=r.config_hash WHERE r.manifest_hash=$1 AND r.config_hash=$2`, [identity.manifestHash, identity.configHash])).rows[0];
    researchAssert(row && typeof row.canonical_json === "string" && typeof row.config_json === "string", "RESEARCH_MANIFEST_MISSING");
    const manifest = parseResearchManifest(JSON.parse(row.canonical_json), decodeTradingConfigurationSnapshot(row.config_json, identity.configHash), identity.configHash);
    researchAssert(researchHash(manifest) === identity.manifestHash && canonicalJson(manifest) === row.canonical_json, "RESEARCH_MANIFEST_CORRUPT"); return manifest;
  }
  private decode(row: Record<string, unknown>, manifest: ResearchManifestV1): StoredResearchSnapshot {
    researchAssert(typeof row.canonical_json === "string" && typeof row.id === "string");
    const snapshot = parseResearchSnapshot(JSON.parse(row.canonical_json), manifest), hash = researchHash(snapshot), sequence = Number(row.sequence);
    researchAssert(hash === row.snapshot_hash && canonicalJson(snapshot) === row.canonical_json && Number.isSafeInteger(sequence) && sequence > 0, "RESEARCH_SNAPSHOT_CORRUPT");
    return { id: row.id, hash, sequence, snapshot };
  }
  async storeSnapshot(input: InstrumentResearchSnapshotV1, refreshSlot?: string): Promise<StoredResearchSnapshot> {
    return this.transaction(async db => {
      await this.assertAuthority(input, db); const manifest = await this.readManifest(input, db), snapshot = parseResearchSnapshot(input, manifest);
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
      await db.query("INSERT INTO research_snapshots(id,snapshot_hash,config_hash,manifest_hash,instrument_id,sequence,canonical_json) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, hash, ...key, sequence, canonicalJson(snapshot)]);
      await db.query("UPDATE research_snapshot_heads SET snapshot_id=$4,sequence=$5 WHERE config_hash=$1 AND manifest_hash=$2 AND instrument_id=$3", [...key, id, sequence]);
      if (refreshSlot !== undefined) {
        researchAssert(refreshSlot.length > 0 && refreshSlot.length <= 1000, "RESEARCH_REFRESH_SLOT_INVALID");
        await db.query("INSERT INTO research_refresh_slots(slot_key,snapshot_id) VALUES($1,$2)", [refreshSlot, id]);
      }
      return { id, hash, sequence, snapshot };
    });
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
  async recordCallOutcome(callKey: string, outcome: "SUCCESS" | "SUCCEEDED" | "FAILED" | "UNKNOWN", existing?: ResearchDb): Promise<void> {
    const normalized = outcome === "SUCCESS" ? "SUCCEEDED" : outcome, db = existing ?? this.pool;
    await db.query("INSERT INTO research_call_outcomes(call_key,outcome) VALUES($1,$2) ON CONFLICT DO NOTHING", [callKey, normalized]);
    researchAssert((await db.query("SELECT outcome FROM research_call_outcomes WHERE call_key=$1", [callKey])).rows[0]?.outcome === normalized, "RESEARCH_CALL_OUTCOME_IMMUTABLE");
  }
}
