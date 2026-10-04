export const TRADING_CONFIGURATION_SERVICES = Object.freeze(["ingestion", "signal-engine", "execution-engine", "llm-agent"] as const);
export type TradingConfigurationService = typeof TRADING_CONFIGURATION_SERVICES[number];
export interface TradingConfigurationObservation {
  readonly service: TradingConfigurationService; readonly processId: string; readonly mode: "legacy" | "bundle";
  readonly schemaVersion: number | null; readonly canonicalVersion: number | null; readonly effectiveHash: string | null;
  readonly migrationPrepared: boolean; readonly legacySourceHash: string | null;
  readonly observedAt: string; readonly expiresAt: string;
}
export interface TradingConfigurationAdmissionState { readonly latched: boolean; readonly observations: readonly TradingConfigurationObservation[]; readonly nowMs: number }
export interface TradingConfigurationAdmission { readonly allowed: boolean; readonly reasons: readonly string[] }
export function assessTradingConfigurationAdmission(local: { mode: "legacy" | "bundle"; migrationPrepare: boolean; effectiveHash?: string }, state: TradingConfigurationAdmissionState | null): TradingConfigurationAdmission {
  const reasons: string[] = [];
  if (!state || !Number.isFinite(state.nowMs)) reasons.push("CONFIG_STORE_UNAVAILABLE");
  if (local.migrationPrepare) reasons.push("CONFIG_MIGRATION_PREPARATION");
  if (state) {
    const active = state.observations.filter(row => {
      const observed = Date.parse(row.observedAt), expires = Date.parse(row.expiresAt);
      return Number.isFinite(observed) && Number.isFinite(expires) && observed <= state.nowMs && expires > state.nowMs && expires > observed && expires - observed <= 30_000 && state.nowMs - observed < 30_000;
    });
    if (local.mode === "legacy") {
      if (active.some(row => row.migrationPrepared)) reasons.push("CONFIG_MIGRATION_PREPARATION");
      if (state.latched || active.some(row => row.mode === "bundle")) reasons.push("CONFIG_DRIFT");
    } else {
      for (const service of TRADING_CONFIGURATION_SERVICES) {
        const rows = active.filter(row => row.service === service);
        if (!rows.length) reasons.push("CONFIG_SERVICE_UNAVAILABLE");
        if (rows.some(row => row.mode !== "bundle" || row.schemaVersion !== 1 || row.canonicalVersion !== 1 || row.effectiveHash !== local.effectiveHash)) reasons.push("CONFIG_DRIFT");
      }
    }
  }
  return Object.freeze({ allowed: reasons.length === 0, reasons: Object.freeze([...new Set(reasons)]) });
}
