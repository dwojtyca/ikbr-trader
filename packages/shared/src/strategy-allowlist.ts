import type { Side } from "./index.js";

export interface StrategyAllowlistEntry {
  strategyId: string;
  symbol: string;
  side: Exclude<Side, "HOLD">;
  reason?: string;
}

export const STRATEGY_ALLOWLIST: StrategyAllowlistEntry[] = [];

export function strategyAllowlistKey(
  strategyId: string,
  symbol: string,
  side: Exclude<Side, "HOLD">,
): string {
  return `${strategyId.trim()}|${symbol.trim().toUpperCase()}|${side}`;
}

export function listStrategyAllowlist(): StrategyAllowlistEntry[] {
  return STRATEGY_ALLOWLIST.map((entry) => ({
    ...entry,
    symbol: entry.symbol.toUpperCase(),
  }));
}

export function isStrategyAllowed(
  strategyId: string,
  symbol: string,
  side: Exclude<Side, "HOLD">,
): boolean {
  const key = strategyAllowlistKey(strategyId, symbol, side);
  return STRATEGY_ALLOWLIST.some(
    (entry) =>
      strategyAllowlistKey(entry.strategyId, entry.symbol, entry.side) === key,
  );
}

export function allowedStrategiesForSymbolSide(
  symbol: string,
  side: Exclude<Side, "HOLD">,
): string[] {
  const normalizedSymbol = symbol.trim().toUpperCase();
  return STRATEGY_ALLOWLIST.filter(
    (entry) =>
      entry.symbol.toUpperCase() === normalizedSymbol && entry.side === side,
  ).map((entry) => entry.strategyId);
}

export function allowedStrategiesForSymbol(symbol: string): string[] {
  const normalizedSymbol = symbol.trim().toUpperCase();
  return Array.from(
    new Set(
      STRATEGY_ALLOWLIST.filter(
        (entry) => entry.symbol.toUpperCase() === normalizedSymbol,
      ).map((entry) => entry.strategyId),
    ),
  );
}
