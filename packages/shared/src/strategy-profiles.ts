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
  /**
   * Optional per-strategy symbol whitelist. When set and non-empty, only
   * symbols listed here are eligible for this strategy (case-insensitive).
   * Used to scope thematic/thin-liquidity strategies (e.g. small-caps)
   * to a curated universe without polluting the main watchlist plumbing.
   * `includedSymbols` is intersected with `excludedSymbols` — a symbol must
   * be in `includedSymbols` AND not in `excludedSymbols` to pass.
   */
  includedSymbols?: string[];
  /**
   * Whether to evaluate shouldExit() hook for early position closes on this strategy.
   * Defaults to false. When true, the strategy's shouldExit implementation may
   * emit exit signals for active positions before TP/SL is hit.
   */
  earlyExitEnabled?: boolean;
}

/**
 * Curated universe of thin-liquidity / thematic small-cap names that the
 * generic intraday strategies should skip (their volume/spread assumptions
 * break on these names) and which the dedicated `smallcap_*` strategies
 * exclusively target. Themes: space, drones/UAV, uranium, SMR nuclear.
 */
export const SMALL_CAP_UNIVERSE: string[] = [
  // US drones / UAV / eVTOL
  "AVAV",
  "KTOS",
  "RCAT",
  "ONDS",
  "EH",
  "JOBY",
  // US space / satcom
  "RKLB",
  "ASTS",
  "RDW",
  "PL",
  "LUNR",
  "IRDM",
  // US uranium
  "UEC",
  "UUUU",
  "DNN",
  "NXE",
  // US SMR / enrichment / nuclear
  "OKLO",
  "SMR",
  "LEU",
  "BWXT",
];

const PROFILES: StrategyProfile[] = [
  {
    id: "momentum_breakout_long_v1",
    secType: ["STK", "IND"],
    directionalRegimes: ["bull_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    // entryScore: 0.58,
    // 2026-05-29: tightened 0.4 -> 0.5 alongside GPW watchlist expansion
    // to keep signal volume bounded as new symbols come online.
    entryScore: 0.5,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1.1,
    quantityFactor: 1.4,
    spreadFactor: 1,
    requireVolume: true,
    earlyExitEnabled: true,
    // 2026-05-29: skip thin-liquidity / thematic small-caps; they are handled
    // by the dedicated smallcap_donchian_* strategies on 4h timeframe.
    excludedSymbols: SMALL_CAP_UNIVERSE,
  },
  {
    id: "momentum_breakdown_short_v1",
    secType: ["STK", "IND"],
    directionalRegimes: ["bear_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    // entryScore: 0.58,
    // 2026-05-29: tightened 0.4 -> 0.5 alongside GPW watchlist expansion.
    entryScore: 0.5,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1.1,
    quantityFactor: 1.2,
    spreadFactor: 1,
    requireVolume: true,
    earlyExitEnabled: true,
    // 2026-05-29: skip thin-liquidity / thematic small-caps; they are handled
    // by the dedicated smallcap_donchian_* strategies on 4h timeframe.
    excludedSymbols: SMALL_CAP_UNIVERSE,
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
    // entryScore: 0.6,
    entryScore: 0.4,
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
    // entryScore: 0.6,
    // 2026-05-29: tightened 0.4 -> 0.5 alongside GPW watchlist expansion.
    entryScore: 0.5,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1.1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: true,
    // 2026-05-29: skip thin-liquidity / thematic small-caps; handled by
    // dedicated smallcap_donchian_* strategies.
    excludedSymbols: SMALL_CAP_UNIVERSE,
  },
  {
    // Daily-timeframe Donchian-50 breakout. Lane-separated from
    // momentum_breakout_long_v1 by timeframe (D1 close vs 1m intraday breakout)
    // and by a confidence anchor of 0.88 so the daily setup wins ties.
    id: "trend_following_long_v1",
    secType: ["STK", "IND"],
    directionalRegimes: ["bull_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "trend",
    // Disabled: only 5 fills in 6-month backtest (run #40), 3 didn't close
    // before dataset end and 2 hit stop for -$514 combined. Strategy also
    // blocks intraday slots that momentum_breakout_long_v1 would use,
    // costing ~$200 vs the $2576 baseline. Re-evaluate after extending the
    // historical dataset to 2+ years (Etap 6).
    enabledInBot: false,
    entryScore: 0.6,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: true,
  },
  {
    // 4h Donchian breakout long, scoped to the SMALL_CAP_UNIVERSE thematic
    // universe (space, drones, uranium, SMR). Lane-separated from
    // momentum_breakout_long_v1 by symbol scope and by 4h vs 1m trigger TF.
    id: "smallcap_donchian_breakout_long_v1",
    secType: ["STK"],
    directionalRegimes: ["bull_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.5,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    // Thinner names — smaller per-trade notional.
    quantityFactor: 0.6,
    // Wider acceptable spread (small caps trade with bigger spreads).
    spreadFactor: 1.8,
    requireVolume: false,
    earlyExitEnabled: true,
    includedSymbols: SMALL_CAP_UNIVERSE,
  },
  {
    // 4h Donchian breakdown short, mirror of smallcap_donchian_breakout_long_v1.
    // Note: shorting GPW small-caps (CRI/CRQ/LBW) is typically rejected by
    // the broker; those names will get filtered out at the execution layer.
    id: "smallcap_donchian_breakdown_short_v1",
    secType: ["STK"],
    directionalRegimes: ["bear_trend"],
    volatilityRegimes: ["normal_volatility", "high_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.5,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 0.5,
    spreadFactor: 1.8,
    requireVolume: false,
    earlyExitEnabled: true,
    includedSymbols: SMALL_CAP_UNIVERSE,
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
