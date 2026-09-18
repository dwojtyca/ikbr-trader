import { evaluateMomentumBreakoutLong } from "@ikbr/signal-engine/strategies/momentum-breakout-long.strategy";
import type { Candle } from "@ikbr/shared";
import { getHeapStatistics } from "node:v8";
import { readFile } from "node:fs/promises";
import { loadResearchActiveContractProjection } from "./research-active-contract-projector.js";
import { loadRegisteredResearchDataset } from "./research-dataset-loader.js";
import { researchEsV2SimulatorOptions } from "./research-es-v2-experiment.js";
import { BacktestRepository } from "./repository.js";
import { BacktestSimulator } from "./simulator.js";
import {
  REGISTERED_ES_V2_PROJECTION,
} from "./research-v2-run-request.js";
import {
  RESEARCH_ES_DATASET_FINGERPRINT,
  RESEARCH_ES_PROVENANCE_ID,
} from "./research-run-request.js";

const EVENTS = 423_300;
const MAX_ORDERS_AND_FILLS = EVENTS;
const MAX_DIAGNOSTIC_ROWS = EVENTS * 3;
type Checkpoint = (current: number) => void;
const iteration = process.env.BENCHMARK_ITERATION ?? "";
if (!["warmup", "measured-1", "measured-2", "measured-3"].includes(iteration))
  throw new Error("BENCHMARK_ITERATION must be warmup or measured-1..3");

class NoOrderBenchmarkStrategy {
  readonly id = "momentum_breakout_long_v1";
  readonly secTypes = ["FUT"] as const;
  readonly supportedDirections = ["LONG"] as const;
  readonly allowedDirectionalRegimes = ["bull_trend", "bear_trend", "range"] as const;
  readonly allowedVolatilityRegimes = ["low_volatility", "normal_volatility", "high_volatility"] as const;
  readonly requiredTimeframes = ["1m", "1h", "4h", "1d"] as const;
  readonly lanePriority = 10;
  generateSignal(): null { return null; }
  getLastRejectionReason(): string { return "benchmark_no_order"; }
}

function syntheticEvaluatorContext() {
  const candles = Array.from({ length: 21 }, (_, index): Candle => ({
    symbol: "ES", conid: "benchmark", timeframe: "1m",
    ts: new Date(Date.UTC(2026, 5, 1, 14, index)),
    open: 6000 + index * 0.25, high: 6001 + index * 0.25,
    low: 5999.75 + index * 0.25, close: 6000.75 + index * 0.25,
    volume: 1_000 + index,
  }));
  candles[20] = {
    ...candles[20], open: 6005, high: 6010.25, low: 6004.75, close: 6010,
    volume: 2_000,
  };
  return {
    symbol: "ES", conid: "benchmark", secType: "FUT",
    directionalRegime: "bull_trend", volatilityRegime: "normal_volatility",
    latestCandle: candles.at(-1), candlesByTimeframe: { "1m": candles },
    indicators: {
      ema20: 6002, ema50: 6000, ema200: 5900, rsi14: 60, rsi14Prev: 59,
      atr14: 4, dcUpper20: 6004, regimeScore: 9, return20mPct: 0.2,
      return60mPct: 0.5, bbWidthPct: 0.05,
      timeframes: {
        "1h": { trend: "bullish", return4Pct: 1.5 },
        "4h": { trend: "bullish" }, "1d": { trend: "bullish", return20Pct: 9 },
      },
    },
  } as any;
}

async function measured(component: string, work: (checkpoint: Checkpoint) => Promise<void>): Promise<void> {
  const implementationCommitSha = process.env.BENCHMARK_IMPLEMENTATION_SHA ?? "";
  const imageDigest = process.env.BENCHMARK_IMAGE_DIGEST ?? "";
  if (!/^[a-f0-9]{40}$/.test(implementationCommitSha))
    throw new Error("BENCHMARK_IMPLEMENTATION_SHA must be an exact 40-character commit SHA");
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest))
    throw new Error("BENCHMARK_IMAGE_DIGEST must be an immutable sha256 digest");
  let peakRss = process.memoryUsage().rss;
  const checkpoints: Array<{ current: number; elapsedMs: number }> = [];
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 25);
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const checkpoint = (current: number) => {
    if (current > 0 && (current % 10_000 === 0 || current === EVENTS))
      checkpoints.push({ current, elapsedMs: performance.now() - wallStart });
  };
  try { await work(checkpoint); } finally {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    clearInterval(sampler);
  }
  const cpu = process.cpuUsage(cpuStart);
  const wallMs = performance.now() - wallStart;
  const readCgroup = async (path: string) => {
    try { return (await readFile(path, "utf8")).trim(); } catch { return "unavailable"; }
  };
  process.stdout.write(`${JSON.stringify({
    component,
    iteration,
    events: EVENTS,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    peakRssBytes: peakRss,
    eventsPerSecond: EVENTS / (wallMs / 1000),
    checkpoints,
    implementationCommitSha,
    imageDigest,
    nodeVersion: process.version,
    nodeHeapLimitBytes: getHeapStatistics().heap_size_limit,
    containerMemoryLimit: await readCgroup("/sys/fs/cgroup/memory.max"),
    containerCpuLimit: await readCgroup("/sys/fs/cgroup/cpu.max"),
    containerMemoryPeakBytes: await readCgroup("/sys/fs/cgroup/memory.peak"),
    containerMemoryCurrentBytes: await readCgroup("/sys/fs/cgroup/memory.current"),
    containerSwapCurrentBytes: await readCgroup("/sys/fs/cgroup/memory.swap.current"),
    containerSwapPeakBytes: await readCgroup("/sys/fs/cgroup/memory.swap.peak"),
    containerMemoryEvents: await readCgroup("/sys/fs/cgroup/memory.events"),
    containerMemoryPressure: await readCgroup("/sys/fs/cgroup/memory.pressure"),
  })}\n`);
}

async function loadRealProjection(connectionString: string) {
  const identity = await loadRegisteredResearchDataset(connectionString, {
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
  });
  const projection = await loadResearchActiveContractProjection(
    connectionString, identity, REGISTERED_ES_V2_PROJECTION,
  );
  return { identity, projection };
}

async function runIdentityBoundary(connectionString: string): Promise<void> {
  const first = await loadRegisteredResearchDataset(connectionString, {
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
  });
  const second = await loadRegisteredResearchDataset(connectionString, {
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
  });
  const third = await loadRegisteredResearchDataset(connectionString, {
    provenanceId: RESEARCH_ES_PROVENANCE_ID,
    datasetFingerprint: RESEARCH_ES_DATASET_FINGERPRINT,
  });
  if (first.fingerprint !== second.fingerprint || first.fingerprint !== third.fingerprint)
    throw new Error("Benchmark identity boundary changed between reloads");
  const projection = await loadResearchActiveContractProjection(
    connectionString, third, REGISTERED_ES_V2_PROJECTION,
  );
  if (projection.evidence.activeSeriesSha256 !== REGISTERED_ES_V2_PROJECTION.activeSeriesSha256)
    throw new Error("Benchmark projection differs from the registered identity boundary");
}

async function runNoOrder(
  repository: BacktestRepository,
  connectionString: string,
  checkpoint: Checkpoint,
): Promise<BacktestSimulator> {
  const { identity, projection } = await loadRealProjection(connectionString);
  const run = await repository.createRun(identity.datasetId, {
    benchmark: "pr15.5d2", component: "no_order_full",
    iteration,
  }, "isolated");
  const simulator = new BacktestSimulator(repository, run.id, projection.data, {
    ...researchEsV2SimulatorOptions(identity, "primary"),
    strategyFactory: () => [new NoOrderBenchmarkStrategy()],
  });
  const summary = await simulator.run({
    total: EVENTS, label: "PR15.5D.2 no-order benchmark",
    onProgress: async (progress) => {
      checkpoint(progress.current);
      await repository.updateRunProgress(run.id, progress);
    },
  });
  await repository.finishRun(run.id, "completed", summary);
  return simulator;
}

async function runEvaluator(checkpoint: Checkpoint): Promise<void> {
  const context = syntheticEvaluatorContext();
  const deepest = evaluateMomentumBreakoutLong(context, ["FUT"]);
  if (!deepest.signal) throw new Error(`Evaluator fixture no longer reaches signal construction: ${deepest.rejectionReason}`);
  context.latestCandle.volume = 1;
  const lateRejection = evaluateMomentumBreakoutLong(context, ["FUT"]);
  if (lateRejection.signal || lateRejection.rejectionReason !== "volume_not_confirmed")
    throw new Error(`Evaluator fixture no longer reaches the frozen late rejection: ${lateRejection.rejectionReason}`);
  for (let index = 0; index < EVENTS; index += 1) {
    context.latestCandle.volume = index % 2 === 0 ? 2_000 : 1;
    const result = evaluateMomentumBreakoutLong(context, ["FUT"]);
    if ((index % 2 === 0) !== Boolean(result.signal))
      throw new Error(`Evaluator benchmark path changed at event ${index}`);
    checkpoint(index + 1);
  }
}

async function runHighWrite(
  repository: BacktestRepository,
  connectionString: string,
  checkpoint: Checkpoint,
  retainedSimulator?: BacktestSimulator,
): Promise<void> {
  const { identity, projection } = await loadRealProjection(connectionString);
  const initializedSimulator = retainedSimulator ?? new BacktestSimulator(
    repository, -1, projection.data, {
      ...researchEsV2SimulatorOptions(identity, "primary"),
      strategyFactory: () => [new NoOrderBenchmarkStrategy()],
    },
  );
  const run = await repository.createRun(identity.datasetId, {
    benchmark: "pr15.5d2", component: "high_write_full",
    iteration,
    orderAndFillCount: MAX_ORDERS_AND_FILLS,
    diagnosticRows: MAX_DIAGNOSTIC_ROWS,
  }, "isolated");
  const at = new Date("2026-06-01T14:30:00.000Z");
  for (let index = 0; index < MAX_ORDERS_AND_FILLS; index += 1) {
    const orderId = await repository.insertOrder({
      runId: run.id, instrument: "ES", conid: "637533641", side: "BUY",
      positionEffect: "OPEN_OR_ADD", orderType: "MKT", quantity: 1, reason: "benchmark",
      entry: 6000, stop: 5990, takeProfit: 6020,
      confidence: 1, riskCheckStatus: "PASS", status: "PROPOSED",
      strategy: "momentum_breakout_long_v1", createdAt: at, generatedFromCandleTs: at,
      indicatorSnapshot: {
        ema20: 6002, ema50: 6000, ema200: 5900, rsi14: 60, atr14: 4,
        dcUpper20: 6004, regimeScore: 1, return20mPct: 0.2, return60mPct: 0.5,
        timeframes: { "1h": { trend: "bullish" }, "4h": { trend: "bullish" }, "1d": { trend: "bullish" } },
      },
      trailingStopPct: 1, trailingStopActivationR: 1,
    });
    await repository.updateOrderStatus(orderId, "FILLED", "benchmark_fill");
    await repository.insertFill({
      runId: run.id, orderId, instrument: "ES", conid: "637533641",
      strategy: "momentum_breakout_long_v1", side: "BUY",
      directionalRegime: "bull_trend", volatilityRegime: "normal_volatility",
      confidence: 1, quantity: 1, entryPrice: 6000, exitPrice: 6001,
      entryAt: at, exitAt: at, grossPnl: 50, commission: 5,
      netPnl: 45, pnlPct: 0.015, exitReason: "benchmark",
      entryReferencePrice: 6000, entryFillPrice: 6000.25,
      exitReferencePrice: 6001, exitFillPrice: 6000.75,
      multiplier: 50, tickSize: 0.25, entrySlippage: 0.25,
      exitSlippage: 0.25, slippageCost: 25,
      commissionPerContractSide: 2.5, entryConid: "637533641",
      exitConid: "637533641", executionModelVersion: "pr15.5b-v1",
      calendarVersion: "cme-equity-index-2024-2026-v1",
    });
    checkpoint(index + 1);
  }
  await repository.upsertSignalDiagnostics(Array.from({ length: MAX_DIAGNOSTIC_ROWS }, (_, index) => ({
    runId: run.id, strategy: "momentum_breakout_long_v1", instrument: "ES",
    side: "HOLD", stage: ["analyzed", "rejected", "rejected_detail"][index % 3],
    reasonGroup: `benchmark_${index}`, samples: 1,
  })));
  await repository.upsertStrategyStates(run.id, [{
    strategyId: "momentum_breakout_long_v1", enabled: true, permanentlyDisabled: false,
  }]);
  await repository.finishRun(run.id, "completed", { totalPnl: 0, trades: 0, winRate: 0 });
  void initializedSimulator;
}

async function runArtifact(repository: BacktestRepository): Promise<void> {
  const experimentId = `pr15.5d2-benchmark-artifact-${iteration}`;
  const claimed = await repository.claimResearchExperiment(experimentId, {
    benchmark: "pr15.5d2", implementationCommitSha: process.env.BENCHMARK_IMPLEMENTATION_SHA,
  });
  if (!claimed) throw new Error(`Benchmark artifact identity already exists: ${experimentId}`);
  await repository.saveResearchExperimentArtifact(experimentId, {
    schemaVersion: "pr15.5d2-benchmark-artifact-v1", verdict: "INCONCLUSIVE",
    evidenceErrors: ["benchmark_only"],
  }, "0".repeat(64));
}

const component = process.env.BENCHMARK_COMPONENT;
const connectionString = process.env.BACKTEST_BENCHMARK_POSTGRES_URL;
if (!component || !connectionString) throw new Error("BENCHMARK_COMPONENT and BACKTEST_BENCHMARK_POSTGRES_URL are required");
const repository = new BacktestRepository(connectionString);
await repository.init();
try {
  if (component === "preflight")
    await measured(component, async () => { await loadRealProjection(connectionString); });
  else if (component === "identity_reload")
    await measured(component, async () => { await runIdentityBoundary(connectionString); });
  else if (component === "artifact")
    await measured(component, () => runArtifact(repository));
  else if (component === "no_order_full")
    await measured(component, (checkpoint) => runNoOrder(repository, connectionString, checkpoint).then(() => undefined));
  else if (component === "exact_evaluator")
    await measured(component, runEvaluator);
  else if (component === "high_write_full")
    await measured(component, (checkpoint) => runHighWrite(repository, connectionString, checkpoint));
  else if (component === "composed")
    await measured(component, async (checkpoint) => {
      const retainedSimulator = await runNoOrder(repository, connectionString, checkpoint);
      await runEvaluator(() => undefined);
      await runHighWrite(repository, connectionString, () => undefined, retainedSimulator);
      void retainedSimulator;
    });
  else throw new Error(`Unknown BENCHMARK_COMPONENT: ${component}`);
} finally {
  await repository.close();
}
