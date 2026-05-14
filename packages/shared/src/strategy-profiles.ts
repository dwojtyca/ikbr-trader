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
  /**
   * Optional per-strategy symbol blacklist. Symbols listed here are skipped
   * by the SignalEngine for this strategy (case-insensitive).
   */
  excludedSymbols?: string[];
}

const PROFILES: StrategyProfile[] = [
  {
    id: "momentum_breakout_long_v1",
    secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
    directionalRegimes: ["bull_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.58,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    // Stage 8: bumped from 1.2 — strategy carries the portfolio (PF 1.86, +1617$ net).
    quantityFactor: 1.4,
    spreadFactor: 1,
    requireVolume: true,
    // Stage 9 (Plan A): drop chronically losing symbols on this strategy.
    // ALE: 14 trades, PF 0.52, -46$. PZU: 21 trades, PF 0.93, -8$ (run #92).
    excludedSymbols: ["ALE", "PZU"],
  },
  {
    id: "momentum_breakdown_short_v1",
    secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
    directionalRegimes: ["bear_trend"],
    // Stage 7: drop normal_volatility — historically only 13% of trades and PF 1.16
    // (vs 1.47 for high_vol); commission drag erases the edge.
    volatilityRegimes: ["high_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.58,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    // Stage 9: now that quantityFactor is actually consumed, scale up cautiously.
    quantityFactor: 1.2,
    spreadFactor: 1,
    requireVolume: true,
    // Stage 9: MSFT short consistently negative (run #93: 9 trades, PF 0.77, -29$).
    excludedSymbols: ["MSFT"],
  },
  {
    id: "range_reversal_v1",
    secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
    directionalRegimes: ["range"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "reversion",
    // Temporarily disabled in bot: net negative across all tuning iterations (#87..#89).
    // Kept enabled in strategy lab for further offline research.
    enabledInBot: false,
    entryScore: 0.6,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 0.5,
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
