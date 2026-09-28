import { createHash } from "node:crypto";
import { MOMENTUM_CONFIGURATION_DEFAULTS_V1 } from "./defaults.js";
import { parseTradingConfiguration } from "./parser.js";
import type { TradingConfigurationV1, TradingStrategyInstanceV1 } from "./types.js";

export const TRADING_CONFIGURATION_CANONICAL_VERSION = 1 as const;
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize((input as Record<string, unknown>)[key])]));
    if (typeof input === "number" && (!Number.isFinite(input) || Object.is(input, -0))) throw new Error("CONFIG_CANONICAL_NUMBER_INVALID");
    if (input === undefined || typeof input === "function" || typeof input === "symbol" || typeof input === "bigint") throw new Error("CONFIG_CANONICAL_VALUE_INVALID");
    return input;
  };
  return JSON.stringify(normalize(value));
}
export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export function canonicalizeTradingConfiguration(configuration: TradingConfigurationV1): string {
  const normalized = Object.fromEntries(Object.entries(configuration).map(([key, value]) => [key,
    Array.isArray(value) ? [...value].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(row => key === "instruments"
      ? { ...row, strategySelection: { ...row.strategySelection, instanceIds: [...row.strategySelection.instanceIds].sort() } } : row) : value]));
  return canonicalJson({ canonicalVersion: 1, configuration: normalized });
}
export function computeTradingConfigurationHash(configuration: TradingConfigurationV1): string {
  return sha256(canonicalizeTradingConfiguration(configuration));
}
export function computeStrategyInstanceHash(instance: TradingStrategyInstanceV1): string {
  return sha256(canonicalJson({ canonicalVersion: 1, implementationId: instance.implementationId, revision: instance.revision, parameters: instance.parameters }));
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const adjustable = new Set(["dailyReturn20MinPct", "h1Return4MinPct", "return60MinPct"]);
export function decodeTradingConfigurationSnapshot(canonical: string, expectedHash: string): TradingConfigurationV1 {
  const fail = (): never => { throw new Error("CONFIG_SNAPSHOT_INVALID"); };
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || sha256(canonical) !== expectedHash) fail();
  let envelope: unknown;
  try { envelope = JSON.parse(canonical); } catch { return fail(); }
  if (!record(envelope) || Object.keys(envelope).sort().join(",") !== "canonicalVersion,configuration" || envelope.canonicalVersion !== 1 || !record(envelope.configuration)) return fail();
  const raw = structuredClone(envelope.configuration);
  if (!Array.isArray(raw.strategyInstances)) return fail();
  for (const instance of raw.strategyInstances) {
    if (!record(instance) || !record(instance.parameters)) return fail();
    const keys = Object.keys(instance.parameters).sort();
    if (keys.join(",") !== Object.keys(MOMENTUM_CONFIGURATION_DEFAULTS_V1).sort().join(",")) return fail();
    for (const key of keys) {
      if (adjustable.has(key)) continue;
      if (instance.parameters[key] !== MOMENTUM_CONFIGURATION_DEFAULTS_V1[key as keyof typeof MOMENTUM_CONFIGURATION_DEFAULTS_V1]) return fail();
      delete instance.parameters[key];
    }
  }
  const result = parseTradingConfiguration(raw);
  if (!result.ok || canonicalizeTradingConfiguration(result.configuration) !== canonical) return fail();
  return result.configuration;
}
