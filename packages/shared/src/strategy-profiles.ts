import type { AssetClass, MarketRegime } from "./index.js";

export type ProfileStyle = "trend" | "range" | "breakout" | "reversion";

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
    id: "momentum_breakout_long_v1",
    assetClass: "stock",
    regime: "bull_trend",
    style: "breakout",
    entryScore: 0.58,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    atrStopMultFactor: 1,
    atrTpMultFactor: 1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: true,
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

export function findStrategyProfile(
  strategyId: string,
): StrategyProfile | undefined {
  return PROFILES.find((profile) => profile.id === strategyId);
}
