import { defaultInstrumentRegistry } from './definitions.js';
import { InstrumentRegistry } from './registry.js';

export function buildConfiguredInstrumentRegistry(env: Record<string, unknown>): InstrumentRegistry {
  const flag = env.GPW_PROFILE_ENABLED ?? 'false';
  if (flag !== 'true' && flag !== 'false') throw new Error('GPW_PROFILE_ENABLED must be true or false');
  if (flag === 'false') return defaultInstrumentRegistry;
  if ((env.IBKR_ENVIRONMENT ?? 'paper') !== 'paper') throw new Error('GPW profile requires paper environment');
  return new InstrumentRegistry(defaultInstrumentRegistry.listAll().map(instrument => instrument.id === 'pko_wse' ? {
    ...instrument,
    trading: { monitoringEnabled: true, signalGenerationEnabled: true, aiAnalysisEnabled: true, executionEnabled: true },
    executionPolicy: { strategyId: 'momentum_breakout_long_v1', expectedDirection: 'LONG', timeframe: '1m',
      quantity: 1, maxQuantity: 1, quantityUnit: 'shares', allowedOrderTypes: ['LMT'], defaultOrderType: 'LMT',
      timeInForce: 'DAY', outsideRth: false, transmit: true, priceTickSize: 0.01, priceRoundingMode: 'nearest',
      allowCrossContractExposure: false },
  } : instrument));
}
