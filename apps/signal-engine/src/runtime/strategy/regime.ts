/**
 * PR15.4 — Regime detection wrapper for `StrategyContext`.
 *
 * Thin adapter over the existing `MarketRegimeDetector` so both
 * the legacy `SignalEngine.runForSymbol()` inline computation
 * and the new `StrategyContextLoader` route through the same
 * detector instance semantics. The equivalence is exercised by
 * `regime.test.ts` (§14.10).
 */

import type { IndicatorSnapshot, RegimeAnalysis, SecType } from "@ikbr/shared";
import { MarketRegimeDetector } from "../../regime/market-regime-detector.js";

const DEFAULT_DETECTOR = new MarketRegimeDetector();

export function detectRegimeForContext(
  secType: SecType,
  price: number,
  indicators: IndicatorSnapshot,
  detector: MarketRegimeDetector = DEFAULT_DETECTOR,
): RegimeAnalysis {
  return detector.detectDetailed(secType, price, indicators);
}
