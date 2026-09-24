import { defaultInstrumentRegistry } from './definitions.js';
import type { MomentumBreakoutProfile } from './types.js';
import { InstrumentRegistry } from './registry.js';

export function buildConfiguredInstrumentRegistry(env: Record<string, unknown>): InstrumentRegistry {
  const profile = env.GPW_MOMENTUM_PROFILE ?? 'default';
  if (!['default','pko_mild_v1','pko_moderate_v1'].includes(String(profile))) throw new Error('Invalid GPW_MOMENTUM_PROFILE');
  const flag = env.GPW_PROFILE_ENABLED ?? 'false';
  if (flag !== 'true' && flag !== 'false') throw new Error('GPW_PROFILE_ENABLED must be true or false');
  if (profile !== 'default' && flag !== 'true') throw new Error('GPW momentum profile requires explicit GPW opt-in');
  const aapl = env.AAPL_PROFILE_ENABLED ?? 'false';
  if (aapl !== 'true' && aapl !== 'false') throw new Error('AAPL_PROFILE_ENABLED must be true or false');
  if (aapl === 'true' && flag === 'true') throw new Error('AAPL and GPW profiles are mutually exclusive');
  if (flag === 'false' && aapl === 'false') return defaultInstrumentRegistry;
  if ((env.IBKR_ENVIRONMENT ?? 'paper') !== 'paper') throw new Error('Stock test profile requires paper environment');
  return new InstrumentRegistry(defaultInstrumentRegistry.listAll().map(instrument => instrument.id === (aapl === 'true' ? 'aapl_nasdaq' : 'pko_wse') ? {
    ...instrument,
    trading: { monitoringEnabled: true, signalGenerationEnabled: true, aiAnalysisEnabled: true, executionEnabled: true },
    executionPolicy: { momentumBreakoutProfile: profile as MomentumBreakoutProfile, strategyId: 'momentum_breakout_long_v1', expectedDirection: 'LONG', timeframe: '1m',
      quantity: 1, maxQuantity: 1, quantityUnit: 'shares', allowedOrderTypes: ['LMT'], defaultOrderType: 'LMT',
      timeInForce: 'DAY', outsideRth: false, transmit: true, priceTickSize: 0.01, priceRoundingMode: 'nearest',
      allowCrossContractExposure: false },
  } : instrument));
}
