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
    quantityFactor: 1.4,
    spreadFactor: 1,
    requireVolume: true,
    // excludedSymbols: ["ALE", "PZU"],
  },
  {
    id: "momentum_breakdown_short_v1",
    secType: ["STK", "IND", "ETF", "CMDTY", "FUT"],
    directionalRegimes: ["bear_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.58,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 1.2,
    spreadFactor: 1,
    requireVolume: true,
    // excludedSymbols: ["MSFT"],
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
    id: "gap_fade_short_v1",
    secType: ["STK", "IND", "ETF"],
    // Run #7: bull_trend regime is toxic for gap fades (gaps continue, don't fade)
    // -139$ on 13 trades. Range and bear_trend break-even or better. Excluded bull.
    directionalRegimes: ["range", "bear_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "reversion",
    // Re-enabled after fixing tight-stop bug (run #5: stops were 0.12% wide
    // -> WR 3%). Now stopMinPct floor of 0.6% prevents micro-noise stopouts.
    enabledInBot: true,
    entryScore: 0.6,
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
