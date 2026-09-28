import { parseStrategyAttribution, type StrategyInstanceAttributionV1 } from "../strategy-attribution.js";
import { computeStrategyInstanceHash, computeTradingConfigurationHash, decodeTradingConfigurationSnapshot } from "./identity.js";
import type { TradingConfigurationV1 } from "./types.js";
import type { TradingConfigurationDb } from "./store.js";

export function buildStrategyAttribution(configuration: TradingConfigurationV1, instrumentId: string, instanceId: string): StrategyInstanceAttributionV1 {
  const instance = configuration.strategyInstances.find(row => row.id === instanceId);
  if (!instance) throw new Error("STRATEGY_INSTANCE_UNAVAILABLE");
  const attribution = parseStrategyAttribution({ version: 1, implementationId: instance.implementationId,
    instanceId, instanceRevision: instance.revision, instanceHash: computeStrategyInstanceHash(instance),
    effectiveConfigHash: computeTradingConfigurationHash(configuration), instrumentId });
  resolveStrategyAttributionSnapshot(configuration, attribution);
  return attribution;
}

export function resolveStrategyAttributionSnapshot(configuration: TradingConfigurationV1, input: StrategyInstanceAttributionV1,
  options: { requireEnabled?: boolean } = {}) {
  const attribution = parseStrategyAttribution(input);
  if (computeTradingConfigurationHash(configuration) !== attribution.effectiveConfigHash) throw new Error("STRATEGY_CONFIGURATION_MISMATCH");
  const instance = configuration.strategyInstances.find(row => row.id === attribution.instanceId);
  const instrument = configuration.instruments.find(row => row.id === attribution.instrumentId);
  if (!instance || !instrument || !instrument.strategySelection.instanceIds.includes(instance.id) ||
      instance.implementationId !== attribution.implementationId || instance.revision !== attribution.instanceRevision ||
      computeStrategyInstanceHash(instance) !== attribution.instanceHash) throw new Error("STRATEGY_ASSIGNMENT_MISMATCH");
  if (options.requireEnabled !== false && (!instrument.entryEnabled || !instance.enabled)) throw new Error("STRATEGY_ASSIGNMENT_DISABLED");
  const executionPolicy = configuration.executionPolicies.find(row => row.id === instrument.executionPolicyId);
  const riskPolicy = configuration.riskPolicies.find(row => row.id === instrument.riskPolicyId);
  if (!executionPolicy || !riskPolicy) throw new Error("STRATEGY_POLICY_UNAVAILABLE");
  return Object.freeze({ attribution, instance, instrument, executionPolicy, riskPolicy });
}

export async function readStrategyAttributionSnapshot(db: TradingConfigurationDb, input: StrategyInstanceAttributionV1,
  options: { requireEnabled?: boolean } = {}) {
  const attribution = parseStrategyAttribution(input);
  const result = await db.query(`SELECT s.canonical_json,r.instance_hash FROM trading_configuration_snapshots s
    JOIN trading_configuration_instance_revisions r ON r.instance_id=$2 AND r.revision=$3
    WHERE s.effective_hash=$1`, [attribution.effectiveConfigHash, attribution.instanceId, attribution.instanceRevision]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || typeof row?.canonical_json !== "string" || row.instance_hash !== attribution.instanceHash)
    throw new Error("STRATEGY_SNAPSHOT_UNAVAILABLE");
  return resolveStrategyAttributionSnapshot(decodeTradingConfigurationSnapshot(row.canonical_json, attribution.effectiveConfigHash), attribution, options);
}
