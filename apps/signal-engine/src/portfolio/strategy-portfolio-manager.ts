import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "../strategies/strategy.types.js";

export interface StrategyPortfolioSelection {
  signal: StrategySignal;
  strategy: Strategy;
}

/**
 * PR15.4 — discriminated result. `kind:"ok"` carries the winner
 * (or `null` when no strategy produced a signal); `kind:"error"`
 * carries a strategy-scoped exception without leaking raw
 * exception text.
 */
export type StrategyPortfolioRunResult =
  | {
      readonly kind: "ok";
      readonly selected: StrategyPortfolioSelection | null;
      readonly candidates: readonly StrategyPortfolioSelection[];
      readonly rejectionReasons: readonly string[];
    }
  | {
      readonly kind: "error";
      readonly strategyId: string;
      readonly errorCode: "STRATEGY_EVALUATION_EXCEPTION";
      readonly message: string;
    };

export interface StrategyPortfolioManagerOptions {
  /**
   * PR15.4 — invoked with the raw error object when a strategy's
   * `generateSignal()` throws. Best-effort: callback exceptions
   * are silenced and the manager still returns `kind:"error"`.
   */
  onStrategyError?: (strategyId: string, error: unknown) => void;
}

export class StrategyPortfolioManager {
  private readonly options: StrategyPortfolioManagerOptions;

  constructor(
    private readonly strategies: readonly Strategy[],
    options: StrategyPortfolioManagerOptions = {},
  ) {
    if (strategies.length === 0) {
      throw new Error("SignalEngine requires at least one strategy");
    }
    this.options = options;
  }

  get strategyIds(): string[] {
    return this.strategies.map((strategy) => strategy.id);
  }

  get primaryStrategyId(): string {
    return this.strategies[0].id;
  }

  getStrategy(id: string): Strategy | undefined {
    return this.strategies.find((s) => s.id === id);
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
      if (
        !strategy.allowedDirectionalRegimes.includes(context.directionalRegime)
      ) {
        rejectionReasons.push(
          `${strategy.id}: unsupported directionalRegime=${context.directionalRegime}`,
        );
        continue;
      }
      if (
        !strategy.allowedVolatilityRegimes.includes(context.volatilityRegime)
      ) {
        rejectionReasons.push(
          `${strategy.id}: unsupported volatilityRegime=${context.volatilityRegime}`,
        );
        continue;
      }

      let signal: StrategySignal | null;
      try {
        signal = strategy.generateSignal(context);
      } catch (err) {
        try {
          this.options.onStrategyError?.(strategy.id, err);
        } catch {
          // callback exceptions are silenced; domain result unchanged
        }
        return {
          kind: "error",
          strategyId: strategy.id,
          errorCode: "STRATEGY_EVALUATION_EXCEPTION",
          message: "strategy evaluation failed; check logs",
        };
      }
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
      kind: "ok",
      selected: candidates[0] ?? null,
      candidates,
      rejectionReasons,
    };
  }
}
