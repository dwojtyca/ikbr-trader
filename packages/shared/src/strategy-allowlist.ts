import type { Side } from "./index.js";

export interface StrategyAllowlistEntry {
  strategyId: string;
  symbol: string;
  side: Exclude<Side, "HOLD">;
  reason?: string;
}

export const STRATEGY_ALLOWLIST: StrategyAllowlistEntry[] = [
  {
    strategyId: "indices_breakout_v1",
    symbol: "ETFDAX",
    side: "BUY",
    reason: "Backtest promoted from historical run",
  },
  {
    strategyId: "indices_breakout_v1",
    symbol: "ETFSP500",
    side: "BUY",
    reason: "Backtest promoted from historical run",
  },
  {
    strategyId: "indices_trend_pullback_v1",
    symbol: "ETFBSPXPL",
    side: "BUY",
    reason: "Backtest promoted from historical run",
  },
  {
    strategyId: "indices_trend_v1",
    symbol: "ETFBSPXPL",
    side: "BUY",
    reason: "Backtest promoted from historical run",
  },
  {
    strategyId: "stocks_trend_breakout_v1",
    symbol: "TSLA",
    side: "SELL",
    reason: "Backtest promoted from historical run",
  },
];

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
