import { AssetClass, MarketRegime } from '@ikbr/shared';

export type ProfileStyle = 'trend' | 'range' | 'breakout';

export interface StrategyProfile {
  id: string;
  assetClass: AssetClass;
  regime: MarketRegime;
  style: ProfileStyle;
  entryScore: number;
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
    entryScore: 0.6,
    minConfidenceMultiplier: 1,
    atrStopMultFactor: 1,
    atrTpMultFactor: 1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: true
  },
  {
    id: 'stocks_range_v1',
    assetClass: 'stock',
    regime: 'range',
    style: 'range',
    entryScore: 0.64,
    minConfidenceMultiplier: 1.03,
    atrStopMultFactor: 0.95,
    atrTpMultFactor: 0.9,
    quantityFactor: 0.85,
    spreadFactor: 0.85,
    requireVolume: true
  },
  {
    id: 'stocks_high_vol_v1',
    assetClass: 'stock',
    regime: 'high_volatility',
    style: 'trend',
    entryScore: 0.7,
    minConfidenceMultiplier: 1.1,
    atrStopMultFactor: 1.35,
    atrTpMultFactor: 1.3,
    quantityFactor: 0.6,
    spreadFactor: 0.75,
    requireVolume: true
  },
  {
    id: 'commodities_trend_v1',
    assetClass: 'commodity',
    regime: 'trend',
    style: 'breakout',
    entryScore: 0.58,
    minConfidenceMultiplier: 0.98,
    atrStopMultFactor: 1.2,
    atrTpMultFactor: 1.35,
    quantityFactor: 1,
    spreadFactor: 1.05,
    requireVolume: false
  },
  {
    id: 'commodities_range_v1',
    assetClass: 'commodity',
    regime: 'range',
    style: 'range',
    entryScore: 0.66,
    minConfidenceMultiplier: 1.06,
    atrStopMultFactor: 1.1,
    atrTpMultFactor: 1,
    quantityFactor: 0.75,
    spreadFactor: 0.8,
    requireVolume: false
  },
  {
    id: 'commodities_high_vol_v1',
    assetClass: 'commodity',
    regime: 'high_volatility',
    style: 'breakout',
    entryScore: 0.72,
    minConfidenceMultiplier: 1.12,
    atrStopMultFactor: 1.6,
    atrTpMultFactor: 1.6,
    quantityFactor: 0.55,
    spreadFactor: 0.72,
    requireVolume: false
  },
  {
    id: 'indices_trend_v1',
    assetClass: 'index',
    regime: 'trend',
    style: 'trend',
    entryScore: 0.58,
    minConfidenceMultiplier: 0.97,
    atrStopMultFactor: 0.95,
    atrTpMultFactor: 1.1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: false
  },
  {
    id: 'indices_range_v1',
    assetClass: 'index',
    regime: 'range',
    style: 'range',
    entryScore: 0.64,
    minConfidenceMultiplier: 1.05,
    atrStopMultFactor: 0.95,
    atrTpMultFactor: 0.95,
    quantityFactor: 0.85,
    spreadFactor: 0.82,
    requireVolume: false
  },
  {
    id: 'indices_high_vol_v1',
    assetClass: 'index',
    regime: 'high_volatility',
    style: 'trend',
    entryScore: 0.7,
    minConfidenceMultiplier: 1.1,
    atrStopMultFactor: 1.25,
    atrTpMultFactor: 1.2,
    quantityFactor: 0.6,
    spreadFactor: 0.72,
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
