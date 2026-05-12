import { parentPort, workerData } from 'node:worker_threads';
import { BacktestRepository } from './repository.js';
import { BacktestSimulator, type SimulatorOptions } from './simulator.js';

type WorkerData = {
  postgresUrl: string;
  runId: number;
  strategyId: string;
  strategyIndex: number;
  strategyTotal: number;
  symbols: string[];
  options: SimulatorOptions;
};

const input = workerData as WorkerData;

const repo = new BacktestRepository(input.postgresUrl);

try {
  const data = await repo.loadBacktestData(input.symbols);
  const simulator = new BacktestSimulator(repo, input.runId, data, {
    ...input.options
  });
  const label = `${input.strategyIndex + 1}/${input.strategyTotal} ${input.strategyId}`;
  const metrics = await simulator.run({
    total: data.candles1m.length,
    label,
    onProgress: (progress) => {
      parentPort?.postMessage({
        type: 'progress',
        strategyId: input.strategyId,
        current: progress.current,
        total: progress.total
      });
    }
  });

  parentPort?.postMessage({
    type: 'completed',
    strategyId: input.strategyId,
    metrics
  });
} finally {
  await repo.close();
}
