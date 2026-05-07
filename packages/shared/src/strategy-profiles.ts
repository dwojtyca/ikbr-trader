import type { AssetClass, MarketRegime } from "./index.js";

export type ProfileStyle = "trend" | "range" | "breakout";

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
    id: "stocks_trend_v1",
    assetClass: "stock",
    regime: "trend",
    style: "trend",
    entryScore: 0.68,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1.05,
    atrStopMultFactor: 1,
    atrTpMultFactor: 1.55,
    quantityFactor: 0.55,
    spreadFactor: 0.88,
    requireVolume: true,
  },
  {
    id: "stocks_trend_pullback_v1",
    assetClass: "stock",
    regime: "trend",
    style: "trend",
    entryScore: 0.7,
    decisionEdge: 0.11,
    minConfidenceMultiplier: 1.06,
    atrStopMultFactor: 1.15,
    atrTpMultFactor: 1.75,
    quantityFactor: 0.45,
    spreadFactor: 0.86,
    requireVolume: true,
  },
  {
    id: "stocks_trend_breakout_v1",
    assetClass: "stock",
    regime: "trend",
    style: "breakout",
    entryScore: 0.7,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1.06,
    atrStopMultFactor: 1.2,
    atrTpMultFactor: 2,
    quantityFactor: 0.35,
    spreadFactor: 0.82,
    requireVolume: true,
  },
  {
    id: "stocks_range_v1",
    assetClass: "stock",
    regime: "range",
    style: "range",
    entryScore: 0.68,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 0.98,
    atrStopMultFactor: 1.12,
    atrTpMultFactor: 1.45,
    quantityFactor: 0.18,
    spreadFactor: 0.9,
    requireVolume: true,
  },
  {
    id: "stocks_range_reversal_v2",
    assetClass: "stock",
    regime: "range",
    style: "range",
    entryScore: 0.72,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1.02,
    atrStopMultFactor: 1.2,
    atrTpMultFactor: 1.65,
    quantityFactor: 0.16,
    spreadFactor: 0.85,
    requireVolume: true,
  },
  {
    id: "stocks_high_vol_v1",
    assetClass: "stock",
    regime: "high_volatility",
    style: "trend",
    entryScore: 0.7,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1.05,
    atrStopMultFactor: 1.45,
    atrTpMultFactor: 1.9,
    quantityFactor: 0.14,
    spreadFactor: 0.75,
    requireVolume: true,
  },
  {
    id: "stocks_high_vol_mean_reversion_v1",
    assetClass: "stock",
    regime: "high_volatility",
    style: "range",
    entryScore: 0.7,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1.06,
    atrStopMultFactor: 1.35,
    atrTpMultFactor: 1.65,
    quantityFactor: 0.12,
    spreadFactor: 0.72,
    requireVolume: true,
  },
  {
    id: "indices_trend_v1",
    assetClass: "index",
    regime: "trend",
    style: "trend",
    entryScore: 0.6,
    decisionEdge: 0.07,
    minConfidenceMultiplier: 0.95,
    atrStopMultFactor: 0.95,
    atrTpMultFactor: 1.3,
    quantityFactor: 0.7,
    spreadFactor: 0.95,
    requireVolume: false,
  },
  {
    id: "indices_trend_pullback_v1",
    assetClass: "index",
    regime: "trend",
    style: "trend",
    entryScore: 0.64,
    decisionEdge: 0.09,
    minConfidenceMultiplier: 1,
    atrStopMultFactor: 1.05,
    atrTpMultFactor: 1.5,
    quantityFactor: 0.5,
    spreadFactor: 0.9,
    requireVolume: false,
  },
  {
    id: "indices_breakout_v1",
    assetClass: "index",
    regime: "trend",
    style: "breakout",
    entryScore: 0.66,
    decisionEdge: 0.09,
    minConfidenceMultiplier: 1.02,
    atrStopMultFactor: 1.1,
    atrTpMultFactor: 1.75,
    quantityFactor: 0.42,
    spreadFactor: 0.86,
    requireVolume: false,
  },
  {
    id: "indices_high_vol_v1",
    assetClass: "index",
    regime: "high_volatility",
    style: "trend",
    entryScore: 0.66,
    decisionEdge: 0.09,
    minConfidenceMultiplier: 1,
    atrStopMultFactor: 1.15,
    atrTpMultFactor: 1.45,
    quantityFactor: 0.3,
    spreadFactor: 0.8,
    requireVolume: false,
  },
  {
    id: "indices_high_vol_defensive_v1",
    assetClass: "index",
    regime: "high_volatility",
    style: "range",
    entryScore: 0.68,
    decisionEdge: 0.1,
    minConfidenceMultiplier: 1.02,
    atrStopMultFactor: 1.25,
    atrTpMultFactor: 1.6,
    quantityFactor: 0.22,
    spreadFactor: 0.78,
    requireVolume: false,
  },
];

const INDEX_SYMBOLS = new Set([
  "SPX",
  "NDX",
  "DJI",
  "RUT",
  "VIX",
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "ES",
  "NQ",
  "YM",
  "RTY",
]);
const COMMODITY_SYMBOLS = new Set([
  "CL",
  "NG",
  "GC",
  "SI",
  "HG",
  "PA",
  "PL",
  "ZC",
  "ZW",
  "ZS",
  "KC",
  "SB",
  "CT",
]);

export function inferAssetClass(symbol: string): AssetClass {
  const normalized = symbol.toUpperCase().trim();
  if (normalized.startsWith("^") || INDEX_SYMBOLS.has(normalized))
    return "index";
  if (COMMODITY_SYMBOLS.has(normalized) || normalized.endsWith("=F"))
    return "commodity";
  return "stock";
}

export function pickStrategyProfile(
  assetClass: AssetClass,
  regime: MarketRegime,
): StrategyProfile {
  const found = PROFILES.find(
    (profile) => profile.assetClass === assetClass && profile.regime === regime,
  );
  if (found) return found;
  return PROFILES[0];
}

export function pickStrategyProfiles(
  assetClass: AssetClass,
  regime: MarketRegime,
): StrategyProfile[] {
  return PROFILES.filter(
    (profile) => profile.assetClass === assetClass && profile.regime === regime,
  );
}

export function listStrategyProfiles(): StrategyProfile[] {
  return [...PROFILES];
}
