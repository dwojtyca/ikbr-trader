import type { StrategyInstanceAttributionV1 } from '../strategy-attribution.js';
import type { BoundInstrument } from '../instruments/bindings.js';
import { getSupportedStockCapability, type StockMarketMetadata } from '../stock-execution.js';
import { readStrategyAttributionSnapshot } from './attribution.js';
import { projectTradingConfigurationInstrument } from './projection.js';
import { configurationMarketRuleId, type TradingConfigurationBrokerObservation } from './broker-evidence.js';

export async function readOriginalStockManagementInstrument(db: Parameters<typeof readStrategyAttributionSnapshot>[0], attribution: StrategyInstanceAttributionV1): Promise<BoundInstrument> {
  const original = await readStrategyAttributionSnapshot(db, attribution, { requireEnabled: false });
  const c = original.instrument.contract;
  const bound: BoundInstrument = { instrumentId: original.instrument.id, broker: c.broker, brokerSymbol: c.symbol, conId: c.conId,
    localSymbol: c.localSymbol, tradingClass: c.tradingClass, exchange: c.exchange, currency: c.currency, minTick: c.expectedMinTick,
    instrument: projectTradingConfigurationInstrument(original.instrument, original.executionPolicy, original.riskPolicy, original.instance.implementationId, { management: true }) };
  if (!getSupportedStockCapability(bound)) throw new Error('ORIGINAL_STOCK_CAPABILITY_UNAVAILABLE');
  return bound;
}
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export function stockMetadataFromObservation(bound: BoundInstrument, accountId: string, observation: TradingConfigurationBrokerObservation): StockMarketMetadata {
  const capability = getSupportedStockCapability(bound);
  const fail = (): never => { throw new Error('stock_metadata_observation_invalid'); };
  if (!capability || !accountId || observation.unavailableReason || !Array.isArray(observation.candidates) || observation.candidates.length !== 1 || !observation.sessionEvidence) return fail();
  const detail = record(observation.candidates[0]), contract = record(detail?.contract), rule = record(observation.marketRule);
  if (!detail || !contract || !rule || !Array.isArray(rule.bands) || rule.id !== configurationMarketRuleId(detail, bound.exchange)) return fail();
  const primary = contract.primaryExchange ?? contract.primaryExch;
  if (contract.primaryExchange !== undefined && contract.primaryExch !== undefined && contract.primaryExchange !== contract.primaryExch) return fail();
  const expected = { conId: bound.conId, symbol: bound.brokerSymbol, localSymbol: bound.localSymbol, tradingClass: bound.tradingClass, exchange: bound.exchange, currency: bound.currency, secType: 'STK' };
  if (Object.entries(expected).some(([key, value]) => contract[key] !== value) || primary !== capability.primaryExchange) return fail();
  const started = Date.parse(observation.requestStartedAt), received = Date.parse(observation.observedAt);
  if (!Number.isFinite(started) || !Number.isFinite(received) || new Date(started).toISOString() !== observation.requestStartedAt || new Date(received).toISOString() !== observation.observedAt) return fail();
  return { accountId, instrumentId: bound.instrumentId, ...expected, exchange: capability.exchange, currency: capability.quoteCurrency,
    primaryExchange: capability.primaryExchange, secType: 'STK', minTick: detail.minTick as number,
    marketRuleId: rule.id as number, priceIncrements: rule.bands as StockMarketMetadata['priceIncrements'],
    requestStartedAtMs: started, receivedAtMs: received, sessionEvidence: observation.sessionEvidence };
}
