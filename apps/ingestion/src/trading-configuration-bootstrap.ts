import { buildConfiguredInstrumentRegistry, buildInstrumentBindingAuthority, type InstrumentRegistry, type InstrumentBindingAuthority } from "@ikbr/shared";
import { loadTradingConfiguration, buildTradingConfigurationProjection, type LoadedTradingConfiguration } from "@ikbr/shared/trading-config";

export interface ServiceTradingConfiguration {
  readonly loaded: LoadedTradingConfiguration;
  readonly registry: InstrumentRegistry;
  readonly authority: InstrumentBindingAuthority;
}

export function loadServiceTradingConfiguration(env: Record<string, unknown>, deps: { readFile?: (path: string) => string } = {}): ServiceTradingConfiguration {
  const loaded = loadTradingConfiguration(env, deps);
  if (loaded.mode === "bundle") {
    const projection = buildTradingConfigurationProjection(loaded.configuration);
    return { loaded, registry: projection.registry, authority: projection.authority };
  }
  const registry = buildConfiguredInstrumentRegistry(env);
  const bindings = buildInstrumentBindingAuthority(String(env.INSTRUMENT_BINDINGS_JSON ?? ""), registry);
  if (!bindings.ok) throw new Error("INSTRUMENT_BINDINGS_JSON_INVALID");
  return { loaded, registry, authority: bindings.authority };
}
