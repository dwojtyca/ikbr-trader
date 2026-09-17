import {
  MomentumBreakoutLongStrategy,
  evaluateMomentumBreakoutLong,
} from "@ikbr/signal-engine/strategies/momentum-breakout-long.strategy";
import type { SecType } from "@ikbr/shared";

type GenerateContext = Parameters<typeof evaluateMomentumBreakoutLong>[0];
type StrategySignal = NonNullable<ReturnType<typeof evaluateMomentumBreakoutLong>["signal"]>;

export const RESEARCH_ES_STRATEGY_ADAPTER_VERSION = "momentum-breakout-long-fut-research-v1";

export class ResearchEsMomentumBreakoutLongStrategy {
  readonly id = "momentum_breakout_long_v1";
  readonly secTypes = ["FUT"] as readonly SecType[];
  readonly supportedDirections = ["LONG"] as const;
  readonly allowedDirectionalRegimes = ["bull_trend"] as const;
  readonly allowedVolatilityRegimes = ["normal_volatility", "high_volatility"] as const;
  readonly requiredTimeframes = ["1m", "1h", "4h", "1d"] as const;
  readonly lanePriority = 10;
  private rejectionReason?: string;
  private readonly productionDelegate = new MomentumBreakoutLongStrategy();

  generateSignal(context: GenerateContext): StrategySignal | null {
    const evaluation = evaluateMomentumBreakoutLong(context, this.secTypes);
    this.rejectionReason = evaluation.rejectionReason;
    return evaluation.signal;
  }

  shouldExit(context: Parameters<MomentumBreakoutLongStrategy["shouldExit"]>[0]) {
    return this.productionDelegate.shouldExit(context);
  }

  getLastRejectionReason(): string | undefined {
    return this.rejectionReason;
  }
}

export function createResearchEsStrategies(): readonly object[] {
  return [new ResearchEsMomentumBreakoutLongStrategy()];
}
