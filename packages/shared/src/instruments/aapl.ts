import type { BoundInstrument } from './bindings.js';

export function isAaplBound(bound: BoundInstrument): boolean {
  return bound.instrumentId === 'aapl_nasdaq' && bound.conId === 265598 && bound.brokerSymbol === 'AAPL'
    && bound.currency === 'USD' && bound.exchange === 'SMART' && bound.instrument.id === 'aapl_nasdaq'
    && bound.instrument.assetClass === 'stock' && bound.instrument.brokerSymbol === 'AAPL'
    && bound.instrument.currency === 'USD' && bound.instrument.exchange === 'SMART';
}
