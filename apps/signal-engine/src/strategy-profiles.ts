import { AssetClass, MarketRegime } from '@ikbr/shared';

export type ProfileStyle = 'trend' | 'range' | 'breakout';

export interface StrategyProfile {
  id: string;
  assetClass: AssetClass;
  regime: MarketRegime;
  style: ProfileStyle;
  entryScore: number;
  decisionEdge: number;
  minConfidenceMultiplier: number;
  atrStopMultFactor: number;
  atrTpMultFactor: number;
  quantityFactor: number;
  spreadFactor: number;
  requireVolume: boolean;
}

const PROFILES: StrategyProfile[] = [
  {
    id: 'stocks_trend_v1',
    assetClass: 'stock',
    regime: 'trend',
    style: 'trend',
    entryScore: 0.74,
    decisionEdge: 0.16,
    minConfidenceMultiplier: 1.15,
    atrStopMultFactor: 1,
    atrTpMultFactor: 1.35,
    quantityFactor: 0.55,
    spreadFactor: 0.82,
    requireVolume: true
  },
  {
    id: 'stocks_trend_pullback_v1',
    assetClass: 'stock',
    regime: 'trend',
    style: 'trend',
    entryScore: 0.78,
    decisionEdge: 0.18,
    minConfidenceMultiplier: 1.18,
    atrStopMultFactor: 1.15,
    atrTpMultFactor: 1.55,
    quantityFactor: 0.45,
    spreadFactor: 0.78,
    requireVolume: true
  },
  {
    id: 'stocks_trend_breakout_v1',
    assetClass: 'stock',
    regime: 'trend',
    style: 'breakout',
    entryScore: 0.82,
    decisionEdge: 0.2,
    minConfidenceMultiplier: 1.2,
    atrStopMultFactor: 1.2,
    atrTpMultFactor: 1.8,
    quantityFactor: 0.35,
    spreadFactor: 0.74,
    requireVolume: true
  },
  {
    id: 'stocks_range_v1',
    assetClass: 'stock',
    regime: 'range',
    style: 'range',
    entryScore: 0.9,
    decisionEdge: 0.24,
    minConfidenceMultiplier: 1.25,
    atrStopMultFactor: 1.05,
    atrTpMultFactor: 1.25,
    quantityFactor: 0.24,
    spreadFactor: 0.62,
    requireVolume: true
  },
  {
    id: 'stocks_range_reversal_v2',
    assetClass: 'stock',
    regime: 'range',
    style: 'range',
    entryScore: 0.92,
    decisionEdge: 0.26,
    minConfidenceMultiplier: 1.28,
    atrStopMultFactor: 1.15,
    atrTpMultFactor: 1.45,
    quantityFactor: 0.2,
    spreadFactor: 0.58,
    requireVolume: true
  },
  {
    id: 'stocks_high_vol_v1',
    assetClass: 'stock',
    regime: 'high_volatility',
    style: 'trend',
    entryScore: 0.88,
    decisionEdge: 0.24,
    minConfidenceMultiplier: 1.32,
    atrStopMultFactor: 1.65,
    atrTpMultFactor: 2,
    quantityFactor: 0.22,
    spreadFactor: 0.5,
    requireVolume: true
  },
  {
    id: 'stocks_high_vol_compression_v1',
    assetClass: 'stock',
    regime: 'high_volatility',
    style: 'breakout',
    entryScore: 0.9,
    decisionEdge: 0.26,
    minConfidenceMultiplier: 1.35,
    atrStopMultFactor: 1.75,
    atrTpMultFactor: 2.25,
    quantityFactor: 0.18,
    spreadFactor: 0.46,
    requireVolume: true
  },
  {
    id: 'stocks_high_vol_mean_reversion_v1',
    assetClass: 'stock',
    regime: 'high_volatility',
    style: 'range',
    entryScore: 0.9,
    decisionEdge: 0.25,
    minConfidenceMultiplier: 1.34,
    atrStopMultFactor: 1.45,
    atrTpMultFactor: 1.7,
    quantityFactor: 0.18,
    spreadFactor: 0.48,
    requireVolume: true
  },
  {
    id: 'commodities_trend_v1',
    assetClass: 'commodity',
    regime: 'trend',
    style: 'breakout',
    entryScore: 0.64,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1.02,
    atrStopMultFactor: 1.2,
    atrTpMultFactor: 1.35,
    quantityFactor: 0.9,
    spreadFactor: 1,
    requireVolume: false
  },
  {
    id: 'commodities_breakout_v1',
    assetClass: 'commodity',
    regime: 'trend',
    style: 'breakout',
    entryScore: 0.72,
    decisionEdge: 0.14,
    minConfidenceMultiplier: 1.08,
    atrStopMultFactor: 1.35,
    atrTpMultFactor: 1.8,
    quantityFactor: 0.65,
    spreadFactor: 0.88,
    requireVolume: false
  },
  {
    id: 'commodities_range_v1',
    assetClass: 'commodity',
    regime: 'range',
    style: 'range',
    entryScore: 0.74,
    decisionEdge: 0.14,
    minConfidenceMultiplier: 1.1,
    atrStopMultFactor: 1.1,
    atrTpMultFactor: 1,
    quantityFactor: 0.65,
    spreadFactor: 0.74,
    requireVolume: false
  },
  {
    id: 'commodities_range_conservative_v1',
    assetClass: 'commodity',
    regime: 'range',
    style: 'range',
    entryScore: 0.82,
    decisionEdge: 0.18,
    minConfidenceMultiplier: 1.18,
    atrStopMultFactor: 1.25,
    atrTpMultFactor: 1.3,
    quantityFactor: 0.42,
    spreadFactor: 0.66,
    requireVolume: false
  },
  {
    id: 'commodities_high_vol_v1',
    assetClass: 'commodity',
    regime: 'high_volatility',
    style: 'breakout',
    entryScore: 0.82,
    decisionEdge: 0.18,
    minConfidenceMultiplier: 1.22,
    atrStopMultFactor: 1.6,
    atrTpMultFactor: 1.6,
    quantityFactor: 0.38,
    spreadFactor: 0.56,
    requireVolume: false
  },
  {
    id: 'indices_trend_v1',
    assetClass: 'index',
    regime: 'trend',
    style: 'trend',
    entryScore: 0.64,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1,
    atrStopMultFactor: 0.95,
    atrTpMultFactor: 1.1,
    quantityFactor: 0.95,
    spreadFactor: 0.95,
    requireVolume: false
  },
  {
    id: 'indices_trend_pullback_v1',
    assetClass: 'index',
    regime: 'trend',
    style: 'trend',
    entryScore: 0.7,
    decisionEdge: 0.14,
    minConfidenceMultiplier: 1.08,
    atrStopMultFactor: 1.05,
    atrTpMultFactor: 1.35,
    quantityFactor: 0.62,
    spreadFactor: 0.86,
    requireVolume: false
  },
  {
    id: 'indices_breakout_v1',
    assetClass: 'index',
    regime: 'trend',
    style: 'breakout',
    entryScore: 0.76,
    decisionEdge: 0.16,
    minConfidenceMultiplier: 1.12,
    atrStopMultFactor: 1.1,
    atrTpMultFactor: 1.55,
    quantityFactor: 0.55,
    spreadFactor: 0.82,
    requireVolume: false
  },
  {
    id: 'indices_range_v1',
    assetClass: 'index',
    regime: 'range',
    style: 'range',
    entryScore: 0.72,
    decisionEdge: 0.14,
    minConfidenceMultiplier: 1.08,
    atrStopMultFactor: 0.95,
    atrTpMultFactor: 0.95,
    quantityFactor: 0.72,
    spreadFactor: 0.76,
    requireVolume: false
  },
  {
    id: 'indices_range_reversion_v2',
    assetClass: 'index',
    regime: 'range',
    style: 'range',
    entryScore: 0.8,
    decisionEdge: 0.18,
    minConfidenceMultiplier: 1.16,
    atrStopMultFactor: 1.05,
    atrTpMultFactor: 1.25,
    quantityFactor: 0.45,
    spreadFactor: 0.7,
    requireVolume: false
  },
  {
    id: 'indices_high_vol_v1',
    assetClass: 'index',
    regime: 'high_volatility',
    style: 'trend',
    entryScore: 0.8,
    decisionEdge: 0.18,
    minConfidenceMultiplier: 1.18,
    atrStopMultFactor: 1.25,
    atrTpMultFactor: 1.2,
    quantityFactor: 0.42,
    spreadFactor: 0.58,
    requireVolume: false
  },
  {
    id: 'indices_high_vol_defensive_v1',
    assetClass: 'index',
    regime: 'high_volatility',
    style: 'range',
    entryScore: 0.86,
    decisionEdge: 0.22,
    minConfidenceMultiplier: 1.28,
    atrStopMultFactor: 1.4,
    atrTpMultFactor: 1.55,
    quantityFactor: 0.22,
    spreadFactor: 0.52,
    requireVolume: false
  }
];

const INDEX_SYMBOLS = new Set(['SPX', 'NDX', 'DJI', 'RUT', 'VIX', 'SPY', 'QQQ', 'IWM', 'DIA', 'ES', 'NQ', 'YM', 'RTY']);
const COMMODITY_SYMBOLS = new Set(['CL', 'NG', 'GC', 'SI', 'HG', 'PA', 'PL', 'ZC', 'ZW', 'ZS', 'KC', 'SB', 'CT']);

export function inferAssetClass(symbol: string): AssetClass {
  const normalized = symbol.toUpperCase().trim();
  if (normalized.startsWith('^') || INDEX_SYMBOLS.has(normalized)) return 'index';
  if (COMMODITY_SYMBOLS.has(normalized) || normalized.endsWith('=F')) return 'commodity';
  return 'stock';
}

export function pickStrategyProfile(assetClass: AssetClass, regime: MarketRegime): StrategyProfile {
  const found = PROFILES.find((profile) => profile.assetClass === assetClass && profile.regime === regime);
  if (found) return found;
  return PROFILES[0];
}

export function pickStrategyProfiles(assetClass: AssetClass, regime: MarketRegime): StrategyProfile[] {
  return PROFILES.filter((profile) => profile.assetClass === assetClass && profile.regime === regime);
}

export function listStrategyProfiles(): StrategyProfile[] {
  return [...PROFILES];
}
