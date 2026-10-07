import { canonicalJson, canonicalizeTradingConfiguration, decodeTradingConfigurationSnapshot, sha256 } from "./identity.js";
import { decodeLegacyManagementSnapshot } from "./management.js";
import type { LoadedTradingConfiguration } from "./loader.js";
import type { TradingConfigurationPool } from "./store.js";
import { capturePP2Conversion } from "./strategy-conversion.js";

export interface RetainedStateRecoveryInput {
  loaded: LoadedTradingConfiguration;
  environment: string;
  tradingEnabled: boolean;
  entriesPaused: boolean;
  tradingLoopEnabled: boolean;
  aiWorkerEnabled: boolean;
  accountId: string;
  allowedPaperAccounts: readonly string[];
  legacyEvidence: { schemaVersion: 1; sourceHash: string; canonical: string };
}
export interface RetainedStateInspection {
  schemaVersion: 1;
  eligible: boolean;
  reasons: string[];
  sourceHash: string;
  legacyAuthorityHash: string;
  accountHash: string;
  stateDigest: string;
  stateCount: number;
  historyDigest: string;
  historyCount: number;
  inspectionDigest: string;
}
export interface RetainedStateRecoveryReceipt {
  sourceHash: string;
  legacyAuthorityHash: string;
  inspectionDigest: string;
  stateDigest: string;
  historyDigest: string;
  historyCount: number;
  capturedAt: string;
  notBeforeBucketMs: number;
  captureSemantics: "present_legacy_state_not_historical_ownership_v1";
}
const fail = (reason: string): never => { throw new Error(`RETAINED_RECOVERY_${reason}`); };
function validate(input: RetainedStateRecoveryInput) {
  if (input.environment !== "paper" || input.tradingEnabled !== false || input.entriesPaused !== true ||
    input.tradingLoopEnabled !== false || input.aiWorkerEnabled !== false) fail("DISABLED_PAPER_REQUIRED");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.accountId) || !input.allowedPaperAccounts.includes(input.accountId)) fail("ACCOUNT_INVALID");
  if (input.loaded.mode !== "bundle" || input.loaded.legacySourceHash || input.loaded.migrationPrepare) fail("CONFIG_INVALID");
  const loaded = input.loaded as Extract<LoadedTradingConfiguration, { mode: "bundle" }>;
  decodeTradingConfigurationSnapshot(canonicalizeTradingConfiguration(loaded.configuration), loaded.effectiveHash);
  const e = input.legacyEvidence;
  if (!e || e.schemaVersion !== 1 || typeof e.canonical !== "string" || Buffer.byteLength(e.canonical) > 1024 * 1024) fail("LEGACY_EVIDENCE_INVALID");
  try {
    const legacy = decodeLegacyManagementSnapshot(e.canonical, e.sourceHash);
    if (legacy.listBoundInstruments().length === 0) fail("LEGACY_EVIDENCE_INVALID");
  } catch { fail("LEGACY_EVIDENCE_INVALID"); }
  return { loaded, sourceHash: loaded.effectiveHash, legacyAuthorityHash: e.sourceHash, accountHash: sha256(input.accountId) };
}
const reason = (error: unknown): string => error instanceof Error && /^RETAINED_RECOVERY_[A-Z_]+$/.test(error.message)
  ? error.message : "RETAINED_RECOVERY_INSPECTION_FAILED";

export async function retainedStateRecovery(pool: TradingConfigurationPool, input: RetainedStateRecoveryInput,
  reviewed?: RetainedStateInspection): Promise<RetainedStateInspection | RetainedStateRecoveryReceipt> {
  const identity = validate(input), db = await pool.connect();
  let committed = false;
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    await db.query("SELECT lock_retained_strategy_recovery()");
    const previous = (await db.query(`SELECT r.*,c.v2_not_before_bucket_ms FROM strategy_retained_state_recoveries r
      LEFT JOIN strategy_runtime_conversion c ON c.source_hash=r.source_hash WHERE r.source_hash=$1`, [identity.sourceHash])).rows[0];
    if (previous) {
      const priorBody = { schemaVersion: 1 as const, sourceHash: identity.sourceHash, legacyAuthorityHash: identity.legacyAuthorityHash,
        accountHash: identity.accountHash, stateDigest: String(previous.state_digest), stateCount: (previous.state_capture as unknown[]).length,
        historyDigest: String(previous.history_digest), historyCount: Number(previous.history_count) };
      const priorInspection = { ...priorBody, eligible: true, reasons: [], inspectionDigest: sha256(canonicalJson(priorBody)) };
      if (!reviewed || canonicalJson(reviewed) !== canonicalJson(priorInspection) || reviewed.inspectionDigest !== previous.inspection_digest
        || previous.legacy_authority_hash !== identity.legacyAuthorityHash || previous.account_hash !== identity.accountHash
        || previous.v2_not_before_bucket_ms == null) fail("REPEAT_CONFLICT");
      return receipt(previous);
    }
    await db.query("SELECT assert_retained_strategy_recovery($1,$2)", [identity.sourceHash, identity.accountHash]);
    const inventory = (await db.query("SELECT retained_strategy_recovery_inventory() AS inventory")).rows[0].inventory as {
      stateCapture: Record<string, unknown>[]; stateDigest: string; historyCount: number; historyDigest: string;
    };
    const body = { schemaVersion: 1 as const, sourceHash: identity.sourceHash, legacyAuthorityHash: identity.legacyAuthorityHash,
      accountHash: identity.accountHash, stateDigest: inventory.stateDigest, stateCount: inventory.stateCapture.length,
      historyDigest: inventory.historyDigest, historyCount: Number(inventory.historyCount) };
    const inspection: RetainedStateInspection = { ...body, eligible: true, reasons: [], inspectionDigest: sha256(canonicalJson(body)) };
    if (!reviewed) return inspection;
    if (canonicalJson(reviewed) !== canonicalJson(inspection)) fail("EVIDENCE_CHANGED");
    await db.query(`INSERT INTO strategy_retained_state_recoveries(source_hash,legacy_authority_hash,legacy_authority_canonical,account_hash,
      state_capture,state_digest,history_count,history_digest,inspection_digest,capture_semantics)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'present_legacy_state_not_historical_ownership_v1')`,
    [identity.sourceHash,identity.legacyAuthorityHash,input.legacyEvidence.canonical,identity.accountHash,JSON.stringify(inventory.stateCapture),
      inventory.stateDigest,inventory.historyCount,inventory.historyDigest,inspection.inspectionDigest]);
    await capturePP2Conversion(db, identity.sourceHash);
    const saved = (await db.query(`SELECT r.*,c.v2_not_before_bucket_ms FROM strategy_retained_state_recoveries r
      JOIN strategy_runtime_conversion c ON c.source_hash=r.source_hash WHERE r.source_hash=$1`, [identity.sourceHash])).rows[0];
    await db.query("COMMIT"); committed = true;
    return receipt(saved);
  } catch (error) {
    if (reviewed) throw error;
    return { schemaVersion: 1, eligible: false, reasons: [reason(error)], sourceHash: identity.sourceHash,
      legacyAuthorityHash: identity.legacyAuthorityHash, accountHash: identity.accountHash, stateDigest: "", stateCount: 0,
      historyDigest: "", historyCount: 0, inspectionDigest: "" };
  } finally {
    if (!committed) await db.query("ROLLBACK");
    db.release();
  }
}
function receipt(row: Record<string, unknown>): RetainedStateRecoveryReceipt {
  return { sourceHash: String(row.source_hash), legacyAuthorityHash: String(row.legacy_authority_hash),
    inspectionDigest: String(row.inspection_digest), stateDigest: String(row.state_digest), historyDigest: String(row.history_digest),
    historyCount: Number(row.history_count), capturedAt: row.captured_at instanceof Date ? row.captured_at.toISOString() : String(row.captured_at),
    notBeforeBucketMs: Number(row.v2_not_before_bucket_ms), captureSemantics: "present_legacy_state_not_historical_ownership_v1" };
}
