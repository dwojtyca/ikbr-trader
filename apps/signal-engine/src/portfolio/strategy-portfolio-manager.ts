import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "../strategies/strategy.types.js";

export interface StrategyPortfolioSelection {
  signal: StrategySignal;
  strategy: Strategy;
}

export interface StrategyPortfolioRunResult {
  selected: StrategyPortfolioSelection | null;
  rejectionReasons: string[];
}

export class StrategyPortfolioManager {
  constructor(private readonly strategies: readonly Strategy[]) {
    if (strategies.length === 0) {
      throw new Error("SignalEngine requires at least one strategy");
    }
  }

  get strategyIds(): string[] {
    return this.strategies.map((strategy) => strategy.id);
  }

  get primaryStrategyId(): string {
    return this.strategies[0].id;
  }

  run(
    context: StrategyContext,
    activeStrategyIds = new Set(this.strategyIds),
  ): StrategyPortfolioRunResult {
    const candidates: StrategyPortfolioSelection[] = [];
    const rejectionReasons: string[] = [];

    for (const strategy of this.strategies) {
      if (!activeStrategyIds.has(strategy.id)) continue;

      if (!strategy.secTypes.includes(context.secType)) {
        rejectionReasons.push(
          `${strategy.id}: unsupported secType=${context.secType}`,
        );
        continue;
      }
      if (!strategy.allowedDirectionalRegimes.includes(context.directionalRegime)) {
        rejectionReasons.push(
          `${strategy.id}: unsupported directionalRegime=${context.directionalRegime}`,
        );
        continue;
      }
      if (!strategy.allowedVolatilityRegimes.includes(context.volatilityRegime)) {
        rejectionReasons.push(
          `${strategy.id}: unsupported volatilityRegime=${context.volatilityRegime}`,
        );
        continue;
      }

      const signal = strategy.generateSignal(context);
      if (!signal) {
        rejectionReasons.push(
          `${strategy.id}: ${strategy.getLastRejectionReason?.() ?? "no signal"}`,
        );
        continue;
      }

      candidates.push({ signal, strategy });
    }

    candidates.sort(
      (a, b) =>
        (b.strategy.lanePriority ?? 0) - (a.strategy.lanePriority ?? 0) ||
        b.signal.confidenceScore - a.signal.confidenceScore ||
        a.strategy.id.localeCompare(b.strategy.id),
    );

    return {
      selected: candidates[0] ?? null,
      rejectionReasons,
    };
  }
}
