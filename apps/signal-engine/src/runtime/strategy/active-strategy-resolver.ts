/**
 * PR15.4 — Active-strategy resolver.
 *
 * Deterministic activation logic shared by `SignalEngine.runForSymbol()`
 * and `TradingLoopService`. Extracted here so there is exactly one
 * implementation of the "which strategies may run for this symbol
 * right now?" decision.
 *
 * Fail-closed contract:
 *   - Any exception from `getStrategyRuntimeState(strategyId)`
 *     causes the resolver to return `kind:"error"` immediately.
 *     Partial activation results are discarded.
 *   - The raw exception is NEVER stored in the returned result.
 *     Callers may log it via the optional `onStateError` callback;
 *     callback exceptions are silenced and do not change the
 *     domain result.
 */

import type { StrategyProfile } from "@ikbr/shared";

/**
 * Read-only slice of the runtime-state repository used by the
 * resolver. Kept structurally minimal — the resolver never
 * touches sync / write-side responsibilities.
 */
export interface StrategyRuntimeStateReader {
  getStrategyRuntimeState(id: string): Promise<{
    enabled: boolean;
    permanentlyDisabled: boolean;
    cooldownUntil?: Date;
  }>;
}

export type ActiveStrategyResolution =
  | {
      readonly kind: "ok";
      readonly activeIds: readonly string[];
      readonly disabledReasons: readonly string[];
    }
  | {
      readonly kind: "error";
      readonly code: "STRATEGY_STATE_UNAVAILABLE";
      readonly strategyId: string;
      readonly message: string;
    };

export interface ActiveStrategyResolverOptions {
  /** Deterministic wall clock. Default: `() => new Date()`. */
  clock?: () => Date;
  /**
   * Invoked with the raw error before the resolver returns
   * `kind:"error"`. Best-effort: callback exceptions are
   * silenced and the domain result is unchanged.
   */
  onStateError?: (strategyId: string, error: unknown) => void;
}

export async function resolveActiveStrategyIds(
  brokerSymbol: string,
  allStrategyIds: readonly string[],
  profileLookup: (id: string) => StrategyProfile | undefined,
  repo: StrategyRuntimeStateReader,
  options: ActiveStrategyResolverOptions = {},
): Promise<ActiveStrategyResolution> {
  const clock = options.clock ?? (() => new Date());
  const evaluatedAt = clock().getTime();
  const symbolUpper = brokerSymbol.toUpperCase();

  const activeIds: string[] = [];
  const disabledReasons: string[] = [];

  for (const strategyId of allStrategyIds) {
    const profile = profileLookup(strategyId);
    if (
      profile?.excludedSymbols?.some(
        (excluded) => excluded.toUpperCase() === symbolUpper,
      )
    ) {
      disabledReasons.push(`${strategyId} excluded for ${symbolUpper}`);
      continue;
    }
    if (
      profile?.includedSymbols &&
      profile.includedSymbols.length > 0 &&
      !profile.includedSymbols.some(
        (included) => included.toUpperCase() === symbolUpper,
      )
    ) {
      disabledReasons.push(
        `${strategyId} not in includedSymbols for ${symbolUpper}`,
      );
      continue;
    }

    let runtimeState;
    try {
      runtimeState = await repo.getStrategyRuntimeState(strategyId);
    } catch (err) {
      try {
        options.onStateError?.(strategyId, err);
      } catch {
        // callback exceptions are silenced; domain result unchanged
      }
      return {
        kind: "error",
        code: "STRATEGY_STATE_UNAVAILABLE",
        strategyId,
        message: "strategy runtime state unavailable; check logs",
      };
    }

    if (!runtimeState.enabled) {
      disabledReasons.push(`${strategyId} is disabled`);
      continue;
    }
    if (runtimeState.permanentlyDisabled) {
      disabledReasons.push(`${strategyId} is permanently disabled`);
      continue;
    }
    if (
      runtimeState.cooldownUntil &&
      runtimeState.cooldownUntil.getTime() > evaluatedAt
    ) {
      disabledReasons.push(`${strategyId} is in cooldown`);
      continue;
    }

    activeIds.push(strategyId);
  }

  return { kind: "ok", activeIds, disabledReasons };
}
