import { randomUUID } from "node:crypto";
import type { InstrumentBindingAuthority, BoundInstrument } from "../instruments/bindings.js";
import type { LoadedTradingConfiguration } from "./loader.js";
import { assessTradingConfigurationAdmission, type TradingConfigurationAdmission, type TradingConfigurationService } from "./admission.js";
import { TradingConfigurationStore, type TradingConfigurationRegistrationResult } from "./store.js";
import { buildManagementMonitoringAuthority } from "./management.js";
import { buildTradingConfigurationProjection } from "./projection.js";
import type { TradingConfigurationBrokerEvidence } from "./broker-evidence.js";

export interface TradingConfigurationRuntimeOptions {
  readonly service: TradingConfigurationService; readonly loaded: LoadedTradingConfiguration; readonly store: TradingConfigurationStore;
  readonly legacyAuthority?: InstrumentBindingAuthority; readonly tradingEnabled: boolean; readonly processId?: string;
}
export class TradingConfigurationRuntime {
  readonly processId: string;
  private state: TradingConfigurationRegistrationResult | null = null;
  private lastFailure: string | null = "CONFIG_NOT_INITIALIZED";
  private lastAdmission: TradingConfigurationAdmission = Object.freeze({ allowed: false, reasons: ["CONFIG_NOT_INITIALIZED"] });
  private timer: ReturnType<typeof setInterval> | undefined;
  private registration: Promise<void> | null = null;
  private strategyConversion: "not_prepared" | "prepared" | "blocked" = "not_prepared";
  constructor(readonly options: TradingConfigurationRuntimeOptions) { this.processId = options.processId ?? randomUUID(); }
  async initialize(): Promise<void> {
    if (this.registration) return this.registration;
    this.registration = this.register();
    try { await this.registration; } finally { this.registration = null; }
  }
  private async register(): Promise<void> {
    try {
      this.state = await this.options.store.register({ ...this.options, processId: this.processId });
      if (this.options.loaded.migrationPrepare && !this.state.preparationPending) {
        try {
          await this.options.store.prepareStrategyRuntime(this.options.loaded, this.options.tradingEnabled);
          this.strategyConversion = "prepared";
        } catch { this.strategyConversion = "blocked"; }
      }
      this.lastFailure = null;
      await this.admission();
    } catch (error) {
      this.lastFailure = "CONFIG_STORE_UNAVAILABLE";
      this.lastAdmission = Object.freeze({ allowed: false, reasons: Object.freeze([this.lastFailure]) });
      throw error;
    }
  }
  async heartbeat(): Promise<void> { return this.initialize(); }
  startHeartbeat(onError: (error: unknown) => void = () => {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.heartbeat().catch(onError); }, 10_000);
    this.timer.unref();
  }
  stopHeartbeat(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async admission(): Promise<TradingConfigurationAdmission> {
    if (!this.state || this.lastFailure) return this.lastAdmission;
    try { this.lastAdmission = assessTradingConfigurationAdmission(this.options.loaded, await this.options.store.readAdmissionState()); }
    catch { this.lastAdmission = assessTradingConfigurationAdmission(this.options.loaded, null); }
    return this.lastAdmission;
  }
  async assertEntryAllowed(): Promise<void> {
    const result = await this.admission();
    if (!result.allowed) throw new Error(result.reasons.join(","));
  }
  resolveManagementInstrument(instrumentId: string): BoundInstrument | undefined {
    if (!this.state || this.lastFailure) return undefined;
    if (this.state.managementAuthority) return this.state.managementAuthority.getBoundInstrument(instrumentId);
    return this.options.loaded.mode === "legacy" ? this.options.legacyAuthority?.getBoundInstrument(instrumentId) : undefined;
  }
  monitoringAuthority(base: InstrumentBindingAuthority): InstrumentBindingAuthority {
    if (!this.state || this.lastFailure) throw new Error("CONFIG_NOT_INITIALIZED");
    return buildManagementMonitoringAuthority(base, this.state.managementAuthority, this.state.ownership);
  }
  diagnostics(evidence?: ReadonlyMap<string, TradingConfigurationBrokerEvidence>) {
    const loaded = this.options.loaded;
    return Object.freeze({ service: this.options.service, processId: this.processId, mode: loaded.mode,
      schemaVersion: loaded.mode === "bundle" ? loaded.schemaVersion : null,
      canonicalVersion: loaded.mode === "bundle" ? loaded.canonicalVersion : null,
      effectiveHash: loaded.mode === "bundle" ? loaded.effectiveHash : null,
      migrationPrepared: loaded.migrationPrepare, preparationPending: this.state?.preparationPending ?? false,
      legacySourceHash: this.state?.legacySourceHash ?? null, initialized: this.state !== null && this.lastFailure === null,
      admission: this.lastAdmission, diagnostics: loaded.diagnostics,
      instruments: loaded.mode === "bundle" ? buildTradingConfigurationProjection(loaded.configuration, evidence).readiness : [],
      retainedManagementInstrumentIds: Object.freeze([...new Set(this.state?.ownership.map(row => row.instrumentId) ?? [])]),
      strategyConversion: this.strategyConversion,
      retainedManagementConIds: Object.freeze([...new Set(this.state?.ownership.map(row => row.conId) ?? [])]) });
  }
}
export function createTradingConfigurationRuntime(options: TradingConfigurationRuntimeOptions): TradingConfigurationRuntime { return new TradingConfigurationRuntime(options); }
