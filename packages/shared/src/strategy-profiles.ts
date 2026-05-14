import type { MarketRegime, SecType } from "./index.js";

export type ProfileStyle = "trend" | "range" | "breakout" | "reversion";

export interface StrategyProfile {
  id: string;
  secType: SecType[];
  regime: MarketRegime;
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
    regime: "bull_trend",
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
    regime: "bear_trend",
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
    id: "failed_bounce_short_v1",
    secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
    regime: "bear_trend",
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
