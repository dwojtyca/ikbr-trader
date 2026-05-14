import { listStrategyProfiles } from "@ikbr/shared";
import { FailedBounceShortStrategy } from "./failed-bounce-short.strategy.js";
import { MomentumBreakdownShortStrategy } from "./momentum-breakdown-short.strategy.js";
import { MomentumBreakoutLongStrategy } from "./momentum-breakout-long.strategy.js";
import { RangeReversalStrategy } from "./range-reversal.strategy.js";
import type { Strategy } from "./strategy.types.js";

const STRATEGY_FACTORIES = {
  momentum_breakout_long_v1: () => new MomentumBreakoutLongStrategy(),
  momentum_breakdown_short_v1: () => new MomentumBreakdownShortStrategy(),
  range_reversal_v1: () => new RangeReversalStrategy(),
  failed_bounce_short_v1: () => new FailedBounceShortStrategy(),
} satisfies Record<string, () => Strategy>;

export type ImplementedStrategyId = keyof typeof STRATEGY_FACTORIES;

export function listImplementedStrategyIds(): ImplementedStrategyId[] {
  return Object.keys(STRATEGY_FACTORIES) as ImplementedStrategyId[];
}

export function createStrategy(strategyId: string): Strategy {
  const factory = STRATEGY_FACTORIES[strategyId as ImplementedStrategyId];
  if (!factory) {
    throw new Error(`Strategy profile ${strategyId} has no implementation`);
  }
  return factory();
}

export function createStrategies(
  strategyIds = listStrategyProfiles().map((profile) => profile.id),
): Strategy[] {
  return strategyIds.map((strategyId) => createStrategy(strategyId));
}
