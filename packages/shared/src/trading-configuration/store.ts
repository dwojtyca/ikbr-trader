import type { LoadedTradingConfiguration } from "./loader.js";
import { canonicalizeTradingConfiguration, computeStrategyInstanceHash, decodeTradingConfigurationSnapshot } from "./identity.js";
import { createLegacyManagementSnapshot, decodeLegacyManagementSnapshot, validateRetainedOwnership, assertManagementCompatibility, type RetainedOwnershipIdentity } from "./management.js";
import { buildTradingConfigurationProjection } from "./projection.js";
import { TRADING_CONFIGURATION_SERVICES, type TradingConfigurationAdmissionState, type TradingConfigurationObservation, type TradingConfigurationService } from "./admission.js";
import type { InstrumentBindingAuthority } from "../instruments/bindings.js";

export interface TradingConfigurationDb { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface TradingConfigurationConnection extends TradingConfigurationDb { release(): void }
export interface TradingConfigurationPool extends TradingConfigurationDb { connect(): Promise<TradingConfigurationConnection> }
export interface TradingConfigurationRegistration {
  readonly service: TradingConfigurationService; readonly processId: string; readonly loaded: LoadedTradingConfiguration;
  readonly tradingEnabled: boolean; readonly legacyAuthority?: InstrumentBindingAuthority;
}
export interface TradingConfigurationRegistrationResult {
  readonly preparationPending: boolean; readonly managementAuthority: InstrumentBindingAuthority | null;
  readonly ownership: readonly RetainedOwnershipIdentity[]; readonly legacySourceHash: string | null;
}
const iso = (v: unknown): string => v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";
export class TradingConfigurationStore {
  constructor(private readonly pool: TradingConfigurationPool) {}
  private async transaction<T>(fn: (db: TradingConfigurationDb) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext('trading_configuration_v1')::bigint)");
      const value = await fn(db);
      await db.query("COMMIT");
      return value;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }
  private async ownership(db: TradingConfigurationDb): Promise<RetainedOwnershipIdentity[]> {
    const result = await db.query(`SELECT DISTINCT po.instrument_id, po.conid, po.instrument, po.strategy, po.client_order_hash
      FROM proposed_orders po LEFT JOIN lifecycle_close_operations close_op ON close_op.original_proposal_id=po.id
      WHERE (po.execution_attempted_at IS NOT NULL OR EXISTS(SELECT 1 FROM broker_order_links l WHERE l.proposed_order_id=po.id)
        OR (close_op.id IS NOT NULL AND close_op.state<>'COMPLETED'))
        AND COALESCE(po.position_effect,'OPEN_OR_ADD')<>'CLOSE_OR_REDUCE'
        AND (close_op.id IS NULL OR close_op.state<>'COMPLETED')`);
    return result.rows.map(row => ({ instrumentId: typeof row.instrument_id === "string" ? row.instrument_id : "", conId: typeof row.conid === "string" ? row.conid : "",
      symbol: typeof row.instrument === "string" ? row.instrument : "", strategy: typeof row.strategy === "string" ? row.strategy : null, clientOrderHash: typeof row.client_order_hash === "string" ? row.client_order_hash : null }));
  }
  private async observe(db: TradingConfigurationDb, input: TradingConfigurationRegistration, sourceHash: string | null): Promise<void> {
    const loaded = input.loaded;
    await db.query(`WITH stamp AS (SELECT clock_timestamp() AS now)
      INSERT INTO trading_configuration_observations(process_id,service,mode,schema_version,canonical_version,effective_hash,migration_prepared,legacy_source_hash,observed_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,now,now+interval '30 seconds' FROM stamp
      ON CONFLICT(process_id) DO UPDATE SET observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at
      WHERE trading_configuration_observations.service=EXCLUDED.service AND trading_configuration_observations.mode=EXCLUDED.mode
        AND trading_configuration_observations.schema_version IS NOT DISTINCT FROM EXCLUDED.schema_version
        AND trading_configuration_observations.canonical_version IS NOT DISTINCT FROM EXCLUDED.canonical_version
        AND trading_configuration_observations.effective_hash IS NOT DISTINCT FROM EXCLUDED.effective_hash
        AND trading_configuration_observations.migration_prepared=EXCLUDED.migration_prepared
        AND trading_configuration_observations.legacy_source_hash IS NOT DISTINCT FROM EXCLUDED.legacy_source_hash
      RETURNING process_id`, [input.processId, input.service, loaded.mode, loaded.mode === "bundle" ? 1 : null,
      loaded.mode === "bundle" ? 1 : null, loaded.mode === "bundle" ? loaded.effectiveHash : null, loaded.migrationPrepare, sourceHash]).then(result => {
      if (result.rows.length !== 1) throw new Error("CONFIG_PROCESS_IDENTITY_CHANGED");
    });
  }
  private async prepared(db: TradingConfigurationDb, hash: string): Promise<boolean> {
    const result = await db.query(`SELECT service,mode,migration_prepared,legacy_source_hash FROM trading_configuration_observations
      WHERE expires_at>clock_timestamp() AND observed_at<=clock_timestamp()`);
    return TRADING_CONFIGURATION_SERVICES.every(service => {
      const rows = result.rows.filter(row => row.service === service);
      return rows.length > 0 && rows.every(row => row.mode === "legacy" && row.migration_prepared === true && row.legacy_source_hash === hash);
    });
  }
  private async readManagement(db: TradingConfigurationDb, hash: string): Promise<InstrumentBindingAuthority> {
    const result = await db.query("SELECT canonical_json FROM trading_configuration_management_snapshots WHERE source_hash=$1 AND entries_disabled=TRUE", [hash]);
    if (result.rows.length !== 1 || typeof result.rows[0].canonical_json !== "string") throw new Error("LEGACY_MANAGEMENT_SNAPSHOT_REQUIRED");
    return decodeLegacyManagementSnapshot(result.rows[0].canonical_json, hash);
  }
  async register(input: TradingConfigurationRegistration): Promise<TradingConfigurationRegistrationResult> {
    return this.transaction(async db => {
      const rolloutRows = await db.query("SELECT * FROM trading_configuration_rollout WHERE singleton=TRUE FOR UPDATE");
      if (rolloutRows.rows.length !== 1) throw new Error("CONFIG_ROLLOUT_STATE_UNAVAILABLE");
      const rollout = rolloutRows.rows[0], loaded = input.loaded;
      if (rollout.bundle_latched !== true && rollout.bundle_latched !== false) throw new Error("CONFIG_ROLLOUT_STATE_INVALID");
      if (loaded.mode === "legacy") {
        if (loaded.migrationPrepare && (input.tradingEnabled || !input.legacyAuthority)) throw new Error("CONFIG_PREPARATION_REQUIRES_DISABLED_WRITES");
        const snapshot = input.legacyAuthority ? createLegacyManagementSnapshot(input.legacyAuthority) : null;
        await this.observe(db, input, loaded.migrationPrepare ? snapshot!.sourceHash : null);
        let pending = false;
        if (loaded.migrationPrepare) {
          if (rollout.bundle_latched) throw new Error("CONFIG_PREPARATION_AFTER_ROLLOUT");
          pending = !(await this.prepared(db, snapshot!.sourceHash));
          if (!pending) {
            await db.query(`INSERT INTO trading_configuration_management_snapshots(source_hash,canonical_json,entries_disabled) VALUES($1,$2,TRUE) ON CONFLICT DO NOTHING`, [snapshot!.sourceHash, snapshot!.canonical]);
            const authority = await this.readManagement(db, snapshot!.sourceHash);
            if (createLegacyManagementSnapshot(authority).canonical !== snapshot!.canonical) throw new Error("CONFIG_MANAGEMENT_SNAPSHOT_CONFLICT");
            validateRetainedOwnership(authority, await this.ownership(db));
            await db.query("INSERT INTO trading_configuration_transitions(kind,old_hash,new_hash,entries_disabled) VALUES('LEGACY_PREPARED',NULL,$1,TRUE) ON CONFLICT DO NOTHING", [snapshot!.sourceHash]);
          }
        }
        const sourceHash = typeof rollout.legacy_source_hash === "string" ? rollout.legacy_source_hash : null;
        const retained = sourceHash ? await this.readManagement(db, sourceHash) : null;
        const ownership = rollout.bundle_latched ? await this.ownership(db) : [];
        if (retained) {
          if (!input.legacyAuthority) throw new Error("LEGACY_MANAGEMENT_SNAPSHOT_REQUIRED");
          assertManagementCompatibility(input.legacyAuthority, retained);
          validateRetainedOwnership(retained, ownership);
        }
        return { preparationPending: pending, managementAuthority: retained, ownership, legacySourceHash: loaded.migrationPrepare ? snapshot!.sourceHash : sourceHash };
      }
      const canonical = canonicalizeTradingConfiguration(loaded.configuration);
      decodeTradingConfigurationSnapshot(canonical, loaded.effectiveHash);
      await db.query("INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2) ON CONFLICT DO NOTHING", [loaded.effectiveHash, canonical]);
      const saved = await db.query("SELECT canonical_json,schema_version,canonical_version FROM trading_configuration_snapshots WHERE effective_hash=$1", [loaded.effectiveHash]);
      if (saved.rows[0]?.canonical_json !== canonical || saved.rows[0]?.schema_version !== 1 || saved.rows[0]?.canonical_version !== 1) throw new Error("CONFIG_SNAPSHOT_CONFLICT");
      for (const instance of loaded.configuration.strategyInstances) {
        const hash = computeStrategyInstanceHash(instance);
        await db.query("INSERT INTO trading_configuration_instance_revisions(instance_id,revision,instance_hash,first_effective_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [instance.id, instance.revision, hash, loaded.effectiveHash]);
        const result = await db.query("SELECT instance_hash FROM trading_configuration_instance_revisions WHERE instance_id=$1 AND revision=$2", [instance.id, instance.revision]);
        if (result.rows[0]?.instance_hash !== hash) throw new Error("INSTANCE_REVISION_REUSED");
      }
      const ownership = await this.ownership(db);
      const storedSource = typeof rollout.legacy_source_hash === "string" ? rollout.legacy_source_hash : undefined;
      if (rollout.bundle_latched && loaded.legacySourceHash !== storedSource) throw new Error("CONFIG_LEGACY_SOURCE_CHANGED");
      const sourceHash = loaded.legacySourceHash;
      if (!sourceHash) {
        const history = await db.query(`SELECT 1 FROM proposed_orders po WHERE po.execution_attempted_at IS NOT NULL
          OR EXISTS(SELECT 1 FROM broker_order_links links WHERE links.proposed_order_id=po.id)
          OR EXISTS(SELECT 1 FROM lifecycle_close_operations close_op WHERE close_op.original_proposal_id=po.id OR close_op.close_proposal_id=po.id) LIMIT 1`);
        if (history.rows.length) throw new Error("LEGACY_MANAGEMENT_SNAPSHOT_REQUIRED");
      }
      const retained = sourceHash ? await this.readManagement(db, sourceHash) : null;
      validateRetainedOwnership(retained, ownership);
      if (retained) assertManagementCompatibility(buildTradingConfigurationProjection(loaded.configuration).authority, retained);
      if (!rollout.bundle_latched) {
        if (input.tradingEnabled) throw new Error("CONFIG_CONVERSION_REQUIRES_DISABLED_WRITES");
        if (sourceHash && !(await this.prepared(db, sourceHash))) throw new Error("CONFIG_PREPARATION_INCOMPLETE");
        if (!sourceHash) {
          const old = await db.query("SELECT 1 FROM trading_configuration_observations WHERE mode='legacy' AND expires_at>clock_timestamp() LIMIT 1");
          if (old.rows.length) throw new Error("CONFIG_PREPARATION_INCOMPLETE");
        }
        await db.query("UPDATE trading_configuration_rollout SET bundle_latched=TRUE,legacy_source_hash=$1,first_effective_hash=$2,latched_at=clock_timestamp() WHERE singleton=TRUE", [sourceHash ?? null, loaded.effectiveHash]);
        await db.query("INSERT INTO trading_configuration_transitions(kind,old_hash,new_hash,entries_disabled) VALUES('BUNDLE_ACTIVATED',$1,$2,TRUE)", [sourceHash ?? null, loaded.effectiveHash]);
      }
      await this.observe(db, input, sourceHash ?? null);
      return { preparationPending: false, managementAuthority: retained, ownership, legacySourceHash: sourceHash ?? null };
    });
  }
  async readAdmissionState(): Promise<TradingConfigurationAdmissionState> {
    const result = await this.pool.query(`SELECT r.bundle_latched,clock_timestamp() AS now,
      COALESCE((SELECT json_agg(o) FROM trading_configuration_observations o),'[]'::json) AS observations
      FROM trading_configuration_rollout r WHERE singleton=TRUE`);
    const row = result.rows[0];
    if (!row || typeof row.bundle_latched !== "boolean" || !Array.isArray(row.observations)) throw new Error("CONFIG_STORE_STATE_INVALID");
    const observations: TradingConfigurationObservation[] = row.observations.map((o: Record<string, unknown>) => ({
      service: o.service as TradingConfigurationService, processId: String(o.process_id), mode: o.mode as "legacy" | "bundle",
      schemaVersion: typeof o.schema_version === "number" ? o.schema_version : null, canonicalVersion: typeof o.canonical_version === "number" ? o.canonical_version : null,
      effectiveHash: typeof o.effective_hash === "string" ? o.effective_hash : null, migrationPrepared: o.migration_prepared === true,
      legacySourceHash: typeof o.legacy_source_hash === "string" ? o.legacy_source_hash : null, observedAt: iso(o.observed_at), expiresAt: iso(o.expires_at) }));
    return { latched: row.bundle_latched, observations, nowMs: Date.parse(iso(row.now)) };
  }
}
