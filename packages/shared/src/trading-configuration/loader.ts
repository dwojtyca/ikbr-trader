import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseTradingConfiguration } from "./parser.js";
import { computeTradingConfigurationHash } from "./identity.js";
import type { TradingConfigurationV1 } from "./types.js";

interface LoadedBase { readonly migrationPrepare: boolean; readonly legacySourceHash?: string; readonly diagnostics: readonly string[] }
export type LoadedTradingConfiguration =
  | (LoadedBase & { readonly mode: "legacy" })
  | (LoadedBase & { readonly mode: "bundle"; readonly configuration: TradingConfigurationV1; readonly effectiveHash: string; readonly canonicalVersion: 1; readonly schemaVersion: 1 });
const nonblank = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== "";
export function loadTradingConfiguration(env: Record<string, unknown>, deps: { readFile?: (path: string) => string } = {}): LoadedTradingConfiguration {
  const mode = env.TRADING_CONFIG_MODE ?? "legacy";
  if (mode !== "legacy" && mode !== "bundle") throw new Error("CONFIG_MODE_INVALID");
  const prepare = env.TRADING_CONFIG_MIGRATION_PREPARE ?? "false";
  if (prepare !== "true" && prepare !== "false") throw new Error("CONFIG_PREPARATION_INVALID");
  const migrationPrepare = prepare === "true";
  if (migrationPrepare && (mode !== "legacy" || env.TRADING_ENABLED !== "false")) throw new Error("CONFIG_PREPARATION_REQUIRES_DISABLED_WRITES");
  const legacySourceHash = nonblank(env.TRADING_CONFIG_LEGACY_SOURCE_HASH) ? String(env.TRADING_CONFIG_LEGACY_SOURCE_HASH) : undefined;
  if (legacySourceHash && !/^[0-9a-f]{64}$/.test(legacySourceHash)) throw new Error("CONFIG_LEGACY_SOURCE_HASH_INVALID");
  if (mode === "legacy") {
    if (nonblank(env.TRADING_CONFIG_PATH) || nonblank(env.TRADING_CONFIG_EXPECTED_HASH) || legacySourceHash) throw new Error("CONFIG_AUTHORITY_CONFLICT");
    return Object.freeze({ mode, migrationPrepare, diagnostics: Object.freeze([env.TRADING_CONFIG_MODE === undefined ? "LEGACY_CONFIGURATION_UNVERSIONED" : "LEGACY_CONFIGURATION_DEPRECATED"]) });
  }
  for (const key of ["INSTRUMENT_BINDINGS_JSON", "WATCHLIST_SYMBOLS", "WATCHLIST_CONTRACT_OVERRIDES", "SIGNAL_PRICE_MULTIPLIER_OVERRIDES", "SIGNAL_FRACTIONAL_SYMBOLS", "TRADING_LOOP_INSTRUMENT_IDS"])
    if (nonblank(env[key])) throw new Error("CONFIG_AUTHORITY_CONFLICT");
  for (const key of ["GPW_PROFILE_ENABLED", "AAPL_PROFILE_ENABLED"])
    if (nonblank(env[key]) && env[key] !== "false") throw new Error("CONFIG_AUTHORITY_CONFLICT");
  if (nonblank(env.GPW_MOMENTUM_PROFILE) && env.GPW_MOMENTUM_PROFILE !== "default") throw new Error("CONFIG_AUTHORITY_CONFLICT");
  const path = env.TRADING_CONFIG_PATH, expected = env.TRADING_CONFIG_EXPECTED_HASH;
  if (typeof path !== "string" || !isAbsolute(path) || path.trim() !== path) throw new Error("CONFIG_PATH_REQUIRED");
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) throw new Error("CONFIG_EXPECTED_HASH_REQUIRED");
  let text: string;
  try { text = (deps.readFile ?? (file => readFileSync(file, "utf8")))(path); } catch { throw new Error("CONFIG_FILE_UNAVAILABLE"); }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("CONFIG_FILE_TOO_LARGE");
  const result = parseTradingConfiguration(text);
  if (!result.ok) throw new Error(`CONFIG_VALIDATION_FAILED:${result.issues.map(issue => `${issue.path}:${issue.code}`).join(";")}`);
  const effectiveHash = computeTradingConfigurationHash(result.configuration);
  if (effectiveHash !== expected) throw new Error("CONFIG_HASH_MISMATCH");
  return Object.freeze({ mode, configuration: result.configuration, effectiveHash, canonicalVersion: 1, schemaVersion: 1, migrationPrepare, ...(legacySourceHash ? { legacySourceHash } : {}), diagnostics: Object.freeze([]) });
}
