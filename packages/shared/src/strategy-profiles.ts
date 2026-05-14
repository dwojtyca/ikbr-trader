import type { DirectionalRegime, SecType, VolatilityRegime } from "./index.js";

export type ProfileStyle = "trend" | "range" | "breakout" | "reversion";

export interface StrategyProfile {
  id: string;
  secType: SecType[];
  directionalRegimes: DirectionalRegime[];
  volatilityRegimes: VolatilityRegime[];
  style: ProfileStyle;
  enabledInBot: boolean;
  entryScore: number;
  decisionEdge: number;
  minConfidenceMultiplier: number;
  quantityFactor: number;
  spreadFactor: number;
  requireVolume: boolean;
}

const PROFILES: StrategyProfile[] = [
  {
    id: "momentum_breakout_long_v1",
    secType: ["STK", "IND"],
    directionalRegimes: ["bull_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.58,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 1.2,
    spreadFactor: 1,
    requireVolume: true,
  },
  {
    id: "momentum_breakdown_short_v1",
    secType: ["STK", "IND"],
    directionalRegimes: ["bear_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.58,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: true,
  },
  {
    id: "range_reversal_v1",
    secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
    directionalRegimes: ["range"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "reversion",
    enabledInBot: true,
    entryScore: 0.6,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 0.8,
    spreadFactor: 0.85,
    requireVolume: true,
  },
  {
    id: "failed_bounce_short_v1",
    secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
    directionalRegimes: ["bear_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "reversion",
    enabledInBot: false,
    entryScore: 0.58,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: true,
  },
];

export function listStrategyProfiles(): StrategyProfile[] {
  return PROFILES.filter((profile) => profile.enabledInBot);
}

export function listAllStrategyProfiles(): StrategyProfile[] {
  return [...PROFILES];
}

export function findStrategyProfile(
  strategyId: string,
): StrategyProfile | undefined {
  return PROFILES.find((profile) => profile.id === strategyId);
}
