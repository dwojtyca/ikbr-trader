import type { SecType } from "@ikbr/shared";
import type { Strategy, StrategyContext, StrategySignal } from "@ikbr/signal-engine/strategies/strategy.types";
import { RESEARCH_MECHANICAL_STRATEGY_ID, type ResearchMechanicalManifest } from "./research-mechanical-fixture.js";

export class ResearchMechanicalStrategy implements Strategy {
  readonly id = RESEARCH_MECHANICAL_STRATEGY_ID;
  readonly secTypes = ["FUT"] as readonly SecType[];
  readonly supportedDirections = ["LONG"] as const;
  readonly allowedDirectionalRegimes = ["bull_trend", "bear_trend", "range"] as const;
  readonly allowedVolatilityRegimes = ["low_volatility", "normal_volatility", "high_volatility"] as const;
  readonly requiredTimeframes = ["1m"] as const;
  readonly lanePriority = 100;
  private readonly signalsByTimestamp: Map<number, ResearchMechanicalManifest["signals"][number]>;

  constructor(manifest: ResearchMechanicalManifest) {
    const start = new Date(manifest.start).getTime();
    this.signalsByTimestamp = new Map(manifest.signals.map((signal) => [start + signal.index * 60_000, signal]));
  }

  generateSignal(context: StrategyContext): StrategySignal | null {
    const scripted = this.signalsByTimestamp.get(context.latestCandle.ts.getTime());
    if (!scripted || context.symbol !== "ES" || context.conid !== scripted.conId) return null;
    return {
      strategyId: this.id, symbol: "ES", side: "BUY", direction: "LONG",
      confidenceScore: 1, entryReason: `PR15.5E:${scripted.episode}`,
      entryOrderType: "MKT", suggestedEntry: context.latestCandle.close,
      invalidationLevel: scripted.stop, stopLoss: scripted.stop,
      takeProfit: scripted.takeProfit,
      metadata: { mechanicalEpisode: scripted.episode },
      generatedFromCandleTs: context.latestCandle.ts,
    };
  }
}
