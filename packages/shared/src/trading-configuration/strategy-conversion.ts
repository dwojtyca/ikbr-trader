import { TRADING_CONFIGURATION_SERVICES } from "./admission.js";
import type { LoadedTradingConfiguration } from "./loader.js";
import type { TradingConfigurationDb, TradingConfigurationPool } from "./store.js";

export async function preparePP2Conversion(pool: TradingConfigurationPool, input: {
  tradingEnabled: boolean; loaded: LoadedTradingConfiguration;
}): Promise<{ sourceHash: string; notBeforeBucketMs: number }> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('trading_configuration_v1')::bigint)");
    const existing = await db.query("SELECT source_hash,v2_not_before_bucket_ms FROM strategy_runtime_conversion WHERE singleton=TRUE");
    if (existing.rows.length === 1) {
      await db.query("COMMIT");
      return { sourceHash: String(existing.rows[0].source_hash), notBeforeBucketMs: Number(existing.rows[0].v2_not_before_bucket_ms) };
    }
    if (input.tradingEnabled) throw new Error("PP2_CONVERSION_REQUIRES_DISABLED_WRITES");
    const rollout = (await db.query("SELECT * FROM trading_configuration_rollout WHERE singleton=TRUE FOR UPDATE")).rows[0];
    if (!rollout) throw new Error("PP2_CONVERSION_ROLLOUT_UNAVAILABLE");
    const peers = (await db.query(`SELECT * FROM trading_configuration_observations
      WHERE observed_at<=clock_timestamp() AND expires_at>clock_timestamp()
        AND expires_at-observed_at<=interval '30 seconds' AND observed_at>clock_timestamp()-interval '30 seconds'`)).rows;
    const loaded = input.loaded;
    let sourceHash: string;
    if (loaded.mode === "legacy") {
      if (!loaded.migrationPrepare || rollout.bundle_latched === true) throw new Error("PP2_CONVERSION_PREPARATION_REQUIRED");
      const sources = new Set(peers.map(peer => peer.legacy_source_hash));
      if (sources.size !== 1 || typeof peers[0]?.legacy_source_hash !== "string") throw new Error("PP2_CONVERSION_PEER_MISMATCH");
      sourceHash = peers[0].legacy_source_hash;
      if (!TRADING_CONFIGURATION_SERVICES.every(service => peers.some(peer => peer.service === service)) ||
          peers.some(peer => peer.mode !== "legacy" || peer.migration_prepared !== true || peer.legacy_source_hash !== sourceHash))
        throw new Error("PP2_CONVERSION_PREPARATION_REQUIRED");
    } else {
      if (rollout.bundle_latched !== true || !TRADING_CONFIGURATION_SERVICES.every(service => peers.some(peer => peer.service === service)) ||
          peers.some(peer => peer.mode !== "bundle" || peer.effective_hash !== loaded.effectiveHash || peer.schema_version !== 1 || peer.canonical_version !== 1))
        throw new Error("PP2_CONVERSION_PEER_MISMATCH");
      sourceHash = typeof rollout.legacy_source_hash === "string" ? rollout.legacy_source_hash : loaded.effectiveHash;
    }
    // Exclude both mutations and SELECT FOR UPDATE before acquiring the review lock.
    await db.query("LOCK TABLE proposed_orders IN EXCLUSIVE MODE");
    await db.query("LOCK TABLE proposal_ai_reviews IN EXCLUSIVE MODE");
    await db.query("LOCK TABLE broker_order_links, lifecycle_close_operations, broker_execution_fills IN SHARE MODE");
    if ((await db.query("SELECT 1 FROM proposed_orders WHERE client_order_hash_version<>1 LIMIT 1")).rows.length)
      throw new Error("PP2_CONVERSION_V2_HISTORY_CONFLICT");
    const unresolved = await db.query(`SELECT 1 FROM proposed_orders p LEFT JOIN proposal_ai_reviews r ON r.proposed_order_id=p.id
      WHERE p.status IN ('UNKNOWN','SUBMITTED') OR r.delivery_started_at IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM lifecycle_close_operations c WHERE c.original_proposal_id=p.id AND c.state='COMPLETED')
      OR (p.execution_attempted_at IS NOT NULL OR p.broker_order_id IS NOT NULL OR EXISTS(
        SELECT 1 FROM broker_order_links l WHERE l.proposed_order_id=p.id)) AND NOT EXISTS(
        SELECT 1 FROM lifecycle_close_operations c WHERE (c.original_proposal_id=p.id OR c.close_proposal_id=p.id) AND c.state='COMPLETED')
      OR r.claim_until>clock_timestamp() OR EXISTS(SELECT 1 FROM lifecycle_close_operations c
        WHERE (c.original_proposal_id=p.id OR c.close_proposal_id=p.id) AND c.state<>'COMPLETED') LIMIT 1`);
    if (unresolved.rows.length) throw new Error("PP2_CONVERSION_UNRESOLVED_OWNERSHIP");
    const cutoff = Number((await db.query("SELECT (floor(extract(epoch FROM clock_timestamp())/60)+1)*60000 AS cutoff")).rows[0].cutoff);
    const keys = await db.query("SELECT client_order_id FROM proposed_orders WHERE client_order_id LIKE 'loop:v4:%'");
    for (const row of keys.rows) {
      const match = typeof row.client_order_id === "string" && /^loop:v4:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:evaluation\.1m\.(\d+)$/.exec(row.client_order_id);
      if (match && Number(match[1]) >= cutoff) throw new Error("PP2_CONVERSION_TRIGGER_CONFLICT");
    }
    const drained = await db.query(`UPDATE proposed_orders p SET status='EXPIRED',last_error='configuration_revision_invalidated'
      WHERE p.status='PROPOSED' AND p.execution_attempted_at IS NULL AND p.broker_order_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM broker_order_links l WHERE l.proposed_order_id=p.id)
        AND NOT EXISTS(SELECT 1 FROM lifecycle_close_operations c WHERE c.original_proposal_id=p.id OR c.close_proposal_id=p.id)
        AND NOT EXISTS(SELECT 1 FROM proposal_ai_reviews r WHERE r.proposed_order_id=p.id
          AND (r.delivery_started_at IS NOT NULL OR r.claim_until>clock_timestamp())) RETURNING p.id`);
    for (const row of drained.rows) await db.query(`UPDATE proposal_ai_reviews SET status='EXPIRED'
      WHERE proposed_order_id=$1 AND status IN ('PENDING','APPROVED')`, [row.id]);
    await capturePP2Conversion(db, sourceHash, cutoff);
    await db.query("COMMIT");
    return { sourceHash, notBeforeBucketMs: cutoff };
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

export async function capturePP2Conversion(db: TradingConfigurationDb, sourceHash: string, notBeforeBucketMs?: number): Promise<void> {
  const cutoff = notBeforeBucketMs ?? Number((await db.query("SELECT (floor(extract(epoch FROM clock_timestamp())/60)+1)*60000 AS cutoff")).rows[0].cutoff);
  await db.query("SELECT capture_strategy_binding_inheritance($1)", [sourceHash]);
  await db.query("INSERT INTO strategy_runtime_conversion(singleton,source_hash,v2_not_before_bucket_ms) VALUES(TRUE,$1,$2)", [sourceHash, cutoff]);
}
