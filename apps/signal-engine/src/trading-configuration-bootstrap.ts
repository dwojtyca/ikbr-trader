import { buildConfiguredInstrumentRegistry, buildInstrumentBindingAuthority, type InstrumentRegistry, type InstrumentBindingAuthority } from "@ikbr/shared";
import { loadTradingConfiguration, buildTradingConfigurationProjection, type LoadedTradingConfiguration } from "@ikbr/shared/trading-config";

export type ConfiguredAccountScope =
  | { readonly ok: true; readonly accountId: string; readonly environment: "paper" | "live" }
  | { readonly ok: false; readonly reason: string };

export function parseConfiguredAccountScope(env: Record<string, unknown>): ConfiguredAccountScope {
  const environment = env.IBKR_ENVIRONMENT;
  if (environment !== "paper" && environment !== "live") return { ok: false, reason: "PP2_ACCOUNT_ENVIRONMENT_UNAVAILABLE" };
  const accountId = env.IBKR_ACCOUNT_ID;
  if (typeof accountId !== "string" || !accountId.trim() || accountId !== accountId.trim()) return { ok: false, reason: "PP2_ACCOUNT_ID_UNAVAILABLE" };
  const raw = environment === "paper" ? env.ALLOWED_PAPER_ACCOUNTS : env.ALLOWED_LIVE_ACCOUNTS;
  const allowed = typeof raw === "string" ? raw.split(",").map(value => value.trim()).filter(Boolean) : [];
  if (!allowed.includes(accountId)) return { ok: false, reason: "PP2_ACCOUNT_NOT_ALLOWED" };
  return { ok: true, accountId, environment };
}

export interface ServiceTradingConfiguration {
  readonly loaded: LoadedTradingConfiguration;
  readonly configuredAccount?: ConfiguredAccountScope;
  readonly registry: InstrumentRegistry;
  readonly authority: InstrumentBindingAuthority;
}

export function loadServiceTradingConfiguration(env: Record<string, unknown>, deps: { readFile?: (path: string) => string } = {}): ServiceTradingConfiguration {
  const loaded = loadTradingConfiguration(env, deps);
  if (loaded.mode === "bundle") {
    const projection = buildTradingConfigurationProjection(loaded.configuration);
    return { loaded, registry: projection.registry, authority: projection.authority, configuredAccount: parseConfiguredAccountScope(env) };
  }
  const registry = buildConfiguredInstrumentRegistry(env);
  const bindings = buildInstrumentBindingAuthority(String(env.INSTRUMENT_BINDINGS_JSON ?? ""), registry);
  if (!bindings.ok) throw new Error("INSTRUMENT_BINDINGS_JSON_INVALID");
  return { loaded, registry, authority: bindings.authority };
}

export async function assertConfiguredEvaluationReady(input: {
  readonly account?: ConfiguredAccountScope;
  readonly admission: () => Promise<{ readonly reasons: readonly string[] }>;
}): Promise<void> {
  if (!input.account?.ok) throw new Error(input.account?.reason ?? "PP2_ACCOUNT_ID_UNAVAILABLE");
  const result = await input.admission();
  const blockers = result.reasons.filter(reason => reason !== "PP4_RESEARCH_UNAVAILABLE");
  if (blockers.length) throw new Error(blockers.join(","));
}
