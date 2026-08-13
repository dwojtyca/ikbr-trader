import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { IndicatorSnapshot, SecType } from "@ikbr/shared";

import { MarketRegimeDetector } from "../../regime/market-regime-detector.js";
import { detectRegimeForContext } from "./regime.js";

// ---------------------------------------------------------------------------
// PR15.4 §14.10 — regime equivalence: the extracted helper is a thin adapter
// over `MarketRegimeDetector.detectDetailed`; verify field-by-field parity.
// ---------------------------------------------------------------------------

function baseIndicators(): IndicatorSnapshot {
  return {
    ema20: 100,
    ema50: 99,
    ema200: 95,
    sma200: 96,
    rsi14: 60,
    atr14: 1.2,
    adx14: 25,
    macdLine: 0.5,
    macdSignal: 0.4,
    macdHist: 0.1,
    bbUpper: 102,
    bbMiddle: 100,
    bbLower: 98,
    bbWidthPct: 4,
    dcUpper20: 103,
    dcLower20: 97,
    trendFilterValue: 99,
    trendFilterSource: "EMA50_1h",
    secType: "STK" as SecType,
  } as unknown as IndicatorSnapshot;
}

describe("detectRegimeForContext — §14.10 equivalence", () => {
  it("produces the same RegimeAnalysis as MarketRegimeDetector.detectDetailed", () => {
    const price = 100.5;
    const indicators = baseIndicators();
    const legacy = new MarketRegimeDetector().detectDetailed(
      "STK",
      price,
      indicators,
    );
    const extracted = detectRegimeForContext("STK", price, indicators);
    assert.deepEqual(extracted, legacy);
  });

  it("respects an injected detector instance", () => {
    const detector = new MarketRegimeDetector();
    const price = 100.5;
    const indicators = baseIndicators();
    const a = detector.detectDetailed("STK", price, indicators);
    const b = detectRegimeForContext("STK", price, indicators, detector);
    assert.deepEqual(a, b);
  });
});
