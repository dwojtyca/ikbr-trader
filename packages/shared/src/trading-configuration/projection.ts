import { InstrumentRegistry } from "../instruments/registry.js";
import { InstrumentBindingAuthority, type InstrumentBinding } from "../instruments/bindings.js";
import type { Instrument } from "../instruments/types.js";
import { computeStrategyInstanceHash } from "./identity.js";
import type { TradingConfigurationV1 } from "./types.js";
import type { TradingConfigurationBrokerEvidence } from "./broker-evidence.js";

export function buildTradingConfigurationProjection(configuration: TradingConfigurationV1, evidence: ReadonlyMap<string, TradingConfigurationBrokerEvidence> = new Map()) {
  const instances = Object.freeze(configuration.strategyInstances.map(instance => Object.freeze({ id: instance.id, revision: instance.revision, hash: computeStrategyInstanceHash(instance), enabled: instance.enabled })));
  const instruments: Instrument[] = configuration.instruments.map(row => {
    const risk = configuration.riskPolicies.find(policy => policy.id === row.riskPolicyId)!;
    return { id: row.id, displayName: row.contract.symbol, assetClass: "stock", broker: "ibkr", brokerSymbol: row.contract.symbol,
      exchange: row.contract.exchange, primaryExchange: row.contract.primaryExchange, currency: row.contract.currency,
      conId: row.contract.conId, localSymbol: row.contract.localSymbol, tradingClass: row.contract.tradingClass,
      trading: { executionEnabled: false, signalGenerationEnabled: false, aiAnalysisEnabled: false, monitoringEnabled: row.monitoringEnabled },
      risk: { maxQuantity: risk.maxPositionQuantity, quantityUnit: "shares", maxLeverage: 1, allowOvernight: false, maxSpread: risk.maxSpread, maxSlippage: risk.maxSlippage },
      session: { useRegularTradingHours: true, timezone: row.session.timeZone, sessionTemplate: row.contract.exchange === "WSE" ? "wse_stock_rth" : "us_stock_rth" }, metadata: { tags: [] } };
  });
  const registry = new InstrumentRegistry(instruments);
  const bindings: readonly InstrumentBinding[] = Object.freeze(configuration.instruments.map(row => Object.freeze({ instrumentId: row.id, broker: "ibkr" as const, conId: row.contract.conId,
    localSymbol: row.contract.localSymbol, tradingClass: row.contract.tradingClass, exchange: row.contract.exchange, currency: row.contract.currency, minTick: row.contract.expectedMinTick })));
  const authority = new InstrumentBindingAuthority(registry, bindings);
  const unknown = Object.freeze({ status: "unknown" as const, reason: "BROKER_EVIDENCE_UNKNOWN" });
  const readiness = Object.freeze(configuration.instruments.map(row => {
    const observed = evidence.get(row.id), assigned = Object.freeze(instances.filter(instance => row.strategySelection.instanceIds.includes(instance.id)));
    const reasons = ["PP3_EXECUTION_POLICY_UNAVAILABLE", "PP4_RESEARCH_UNAVAILABLE"];
    if (!row.entryEnabled) reasons.unshift("ENTRY_DISABLED");
    if (assigned.some(instance => !instance.enabled)) reasons.push("STRATEGY_INSTANCE_DISABLED");
    return Object.freeze({ instrumentId: row.id, monitoringEnabled: row.monitoringEnabled, entryRequested: row.entryEnabled, entryReady: false as const,
      instances: assigned, reasons: Object.freeze(reasons), brokerIdentity: observed?.identity ?? unknown, session: observed?.session ?? unknown,
      priceGrid: observed?.priceGrid ?? unknown, quote: observed?.quote ?? unknown, sessionOpen: observed?.sessionOpen ?? null,
      research: Object.freeze({ status: "unavailable" as const, reason: "PP4_RESEARCH_UNAVAILABLE" }) });
  }));
  return Object.freeze({ registry, bindings, authority, instances, readiness });
}
