import type { StrategyInstanceAttributionV1, TradingConfigurationV1 } from "@ikbr/shared";
import { buildStrategyAttribution } from "@ikbr/shared/trading-config";
import { createConfiguredStrategy } from "@ikbr/signal-engine/strategies/strategy-registry";
import type { StrategySignal } from "@ikbr/signal-engine/strategies/strategy.types";
import { BacktestSimulator, type SimulatorOptions } from "./simulator.js";
import type { BacktestRepository } from "./repository.js";
import type { BacktestFillRecord, BacktestOrderRecord, LoadedBacktestData } from "./types.js";

export interface ConfiguredReplayResult {
  readonly runId: number;
  readonly strategyAttribution: StrategyInstanceAttributionV1;
  readonly interpretation: "independent_binding_replay";
  readonly signals: readonly StrategySignal[];
  readonly orders: readonly (BacktestOrderRecord & { strategyAttribution: StrategyInstanceAttributionV1 })[];
  readonly fills: readonly (BacktestFillRecord & { strategyAttribution: StrategyInstanceAttributionV1 })[];
  readonly metrics: { totalPnl: number; trades: number; wins: number; winRate: number };
}

export async function replayConfiguredBindings(input: {
  configuration: TradingConfigurationV1;
  instrumentId: string;
  data: LoadedBacktestData;
  options: SimulatorOptions;
  repository: BacktestRepository;
}): Promise<readonly ConfiguredReplayResult[]> {
  const instrument = input.configuration.instruments.find(row => row.id === input.instrumentId);
  if (!instrument || !instrument.entryEnabled || !instrument.monitoringEnabled) throw new Error("REPLAY_ASSIGNMENT_DISABLED");
  const symbol = instrument.contract.symbol;
  if (input.configuration.instruments.filter(row => row.contract.symbol === symbol).length !== 1) throw new Error("REPLAY_SYMBOL_AMBIGUOUS");
  const timeframes = ["candles1m", "candles5m", "candles1h", "candles4h", "candles12h", "candles1d", "candles1w"] as const;
  const data = { ...input.data, dataset: { ...input.data.dataset, symbols: [symbol] } };
  for (const key of timeframes) {
    const candles = input.data[key].get(symbol) ?? [];
    if (candles.some(row => row.symbol !== symbol || row.conid !== String(instrument.contract.conId))) throw new Error("REPLAY_CONTRACT_MISMATCH");
    data[key] = new Map([[symbol, candles]]);
  }
  if (!data.candles1m.get(symbol)?.length) throw new Error("REPLAY_DATA_UNAVAILABLE");
  data.candleCount1m = data.candles1m.get(symbol)!.length;
  const results: ConfiguredReplayResult[] = [];
  for (const instanceId of instrument.strategySelection.instanceIds) {
    const attribution = buildStrategyAttribution(input.configuration, instrument.id, instanceId);
    const instance = input.configuration.strategyInstances.find(row => row.id === instanceId)!;
    const run = await input.repository.createRun(data.dataset.id, {
      interpretation: "independent_binding_replay", strategyAttribution: attribution,
      selectionMode: instrument.strategySelection.mode,
      strategyInstance: instance, contract: instrument.contract,
      strategyIds: [instance.implementationId],
    }, "isolated");
    const runId = run.id;
    const signals: StrategySignal[] = [];
    const orders: ConfiguredReplayResult["orders"][number][] = [];
    const fills: ConfiguredReplayResult["fills"][number][] = [];
    const repository = new Proxy(input.repository, {
      get(target, key) {
        if (key === "insertOrder") return async (order: BacktestOrderRecord) => {
          orders.push({ ...order, strategyAttribution: attribution });
          return target.insertOrder(order);
        };
        if (key === "insertFill") return async (fill: BacktestFillRecord) => {
          fills.push({ ...fill, strategyAttribution: attribution });
          return target.insertFill(fill);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const simulator = new BacktestSimulator(repository, runId, data, {
      ...input.options, strategyIds: [instance.implementationId],
      strategyFactory: () => {
        const strategy = createConfiguredStrategy(instance);
        return [new Proxy(strategy, {
          get(target, key) {
            if (key === "generateSignal") return (...args: Parameters<typeof strategy.generateSignal>) => {
              const signal = target.generateSignal(...args);
              if (signal) signals.push({ ...signal, strategyAttribution: attribution });
              return signal;
            };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })];
      },
    });
    try {
      const metrics = await simulator.run();
      await input.repository.finishRun(runId, "completed", metrics);
      results.push({ runId, strategyAttribution: attribution, interpretation: "independent_binding_replay", signals, orders, fills, metrics });
    } catch (error) {
      await input.repository.finishRun(runId, "failed", { error: error instanceof Error ? error.message : "REPLAY_FAILED" });
      throw error;
    }
  }
  return results;
}
