import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStrategies } from "@ikbr/signal-engine/strategies/strategy-registry";
import { listAllStrategyProfiles } from "@ikbr/shared";
import type { BacktestRepository } from "./repository.js";
import {
  RESEARCH_MECHANICAL_FIXTURE_SHA256,
  RESEARCH_MECHANICAL_STRATEGY_ID,
  buildResearchMechanicalCandles,
  loadResearchMechanicalManifest,
  researchMechanicalFixtureHash,
} from "./research-mechanical-fixture.js";
import {
  canonicalMechanicalResultHash,
  researchMechanicalSimulatorOptions,
  runResearchMechanicalScenario,
} from "./research-mechanical-runner.js";
import { ResearchMechanicalStrategy } from "./research-mechanical-strategy.js";
import { BacktestSimulator } from "./simulator.js";
import type { BacktestFillRecord, BacktestOrderRecord, LoadedBacktestData } from "./types.js";

function loadedData(candles = [] as ReturnType<typeof buildResearchMechanicalCandles>): LoadedBacktestData {
  return {
    dataset: {
      id: 1,
      dateFrom: candles[0]?.ts.toISOString() ?? "2026-06-01T08:00:00.000Z",
      dateTo: candles.at(-1)?.ts.toISOString() ?? "2026-06-01T08:00:00.000Z",
      status: "ready",
      symbols: ["ES"],
      candlesCount: candles.length,
      startedAt: "2026-06-01T08:00:00.000Z",
    },
    candles1m: new Map([["ES", candles]]),
    candles5m: new Map(), candles1h: new Map(), candles4h: new Map(),
    candles12h: new Map(), candles1d: new Map(), candles1w: new Map(),
    candleCount1m: candles.length,
    fxRates: [],
  };
}

function captureRepository() {
  const orders: Array<BacktestOrderRecord & { id: number; statusReason?: string }> = [];
  const fills: BacktestFillRecord[] = [];
  const finished: Array<{ status: string; summary: unknown }> = [];
  const repository = {
    insertOrder: async (order: BacktestOrderRecord) => {
      const id = orders.length + 1;
      orders.push({ ...order, id });
      return id;
    },
    updateOrderStatus: async (id: number, status: BacktestOrderRecord["status"], statusReason?: string) => {
      const order = orders.find((value) => value.id === id);
      if (order) Object.assign(order, { status, statusReason });
    },
    insertFill: async (fill: BacktestFillRecord) => { fills.push(fill); },
    upsertStrategyStates: async () => undefined,
    upsertSignalDiagnostics: async () => undefined,
    createResearchScenarioRun: async () => ({ id: 9 }),
    finishRun: async (_id: number, status: string, summary: unknown) => { finished.push({ status, summary }); },
  } as unknown as BacktestRepository;
  return { repository, orders, fills, finished };
}

function actualScenario(fills: BacktestFillRecord[], totalPnl: number, wins: number) {
  const episodeOrder = ["take_profit", "stop_loss", "same_bar_collision", "contract_roll", "expiry", "dataset_end"];
  return {
    totalPnl,
    grossPnl: fills.reduce((sum, fill) => sum + fill.grossPnl, 0),
    commissions: fills.reduce((sum, fill) => sum + fill.commission, 0),
    slippageCost: fills.reduce((sum, fill) => sum + Number(fill.slippageCost), 0),
    wins,
    fills: fills.map((fill, index) => ({
      episode: episodeOrder[index],
      conId: fill.entryConid,
      quantity: fill.quantity,
      entryReferencePrice: fill.entryReferencePrice,
      entryFillPrice: fill.entryFillPrice,
      exitReferencePrice: fill.exitReferencePrice,
      exitFillPrice: fill.exitFillPrice,
      grossPnl: fill.grossPnl,
      commission: fill.commission,
      netPnl: fill.netPnl,
      slippageCost: fill.slippageCost,
      exitReason: fill.exitReason,
    })),
  };
}

describe("PR15.5E deterministic mechanical backtest", () => {
  it("loads only the frozen fixture and keeps the scripted strategy research-only", async () => {
    const manifest = await loadResearchMechanicalManifest();
    assert.equal(researchMechanicalFixtureHash(manifest), RESEARCH_MECHANICAL_FIXTURE_SHA256);
    assert.equal(manifest.candleCount, 720);
    assert.throws(() => createStrategies([RESEARCH_MECHANICAL_STRATEGY_ID]), /has no implementation/);
    assert.equal(listAllStrategyProfiles().some((profile) => profile.id === RESEARCH_MECHANICAL_STRATEGY_ID), false);

    const strategy = new ResearchMechanicalStrategy(manifest);
    const candles = buildResearchMechanicalCandles(manifest);
    const scripted = manifest.signals[0];
    const matching = candles[scripted.index];
    const context = { symbol: "ES", conid: scripted.conId, latestCandle: matching } as any;
    assert.equal(strategy.generateSignal(context)?.metadata?.mechanicalEpisode, scripted.episode);
    assert.equal(strategy.generateSignal({ ...context, conid: "wrong" }), null);
    assert.equal(strategy.generateSignal({ ...context, latestCandle: candles[scripted.index + 1] }), null);
  });

  it("matches the independent literal oracle for primary, stress, and reproduction", async () => {
    const manifest = await loadResearchMechanicalManifest();
    const data = loadedData(buildResearchMechanicalCandles(manifest));
    const results: Record<string, ReturnType<typeof actualScenario>> = {};

    for (const storedScenario of ["primary", "stress", "primary_reproduction"] as const) {
      const economics = storedScenario === "stress" ? "stress" : "primary";
      const captured = captureRepository();
      const summary = await new BacktestSimulator(
        captured.repository,
        1,
        data,
        researchMechanicalSimulatorOptions(manifest, economics),
      ).run();
      assert.equal(captured.orders.length, manifest.expected.orders);
      assert.equal(captured.fills.length, manifest.expected.fills);
      assert.ok(captured.orders.every((order) => order.quantity === 1 && order.status === "FILLED"));
      results[storedScenario] = actualScenario(captured.fills, summary.totalPnl, summary.wins);
      assert.deepEqual(results[storedScenario], manifest.expected[economics]);
    }

    assert.deepEqual(results.primary_reproduction, results.primary);
    assert.equal(canonicalMechanicalResultHash(results.primary_reproduction),
      manifest.expected.primaryReproductionSha256);
  });

  it("fails closed on retired, post-expiry, and overlapping futures data before any order write", async () => {
    const manifest = await loadResearchMechanicalManifest();
    const valid = buildResearchMechanicalCandles(manifest);
    const cases = [
      { candles: [...valid.slice(0, 500), { ...valid[500], conid: "501" }, ...valid.slice(501)], error: /Retired futures conId/ },
      { candles: valid.map((candle, index) => index >= 489 ? { ...candle, ts: new Date(candle.ts.getTime() + 120_000) } : candle), error: /at or after last trade/ },
      { candles: valid.map((candle, index) => index === 400 ? { ...candle, ts: valid[399].ts } : candle), error: /overlap or are not strictly ordered/ },
    ];
    for (const { candles, error } of cases) {
      const captured = captureRepository();
      await assert.rejects(() => new BacktestSimulator(
        captured.repository,
        1,
        loadedData(candles),
        researchMechanicalSimulatorOptions(manifest, "primary"),
      ).run(), error);
      assert.equal(captured.orders.length, 0);
      assert.equal(captured.fills.length, 0);
    }
  });

  it("marks a scenario failed when the simulator rejects its dataset", async () => {
    const manifest = await loadResearchMechanicalManifest();
    const captured = captureRepository();
    const candles = buildResearchMechanicalCandles(manifest);
    candles[400] = { ...candles[400], ts: candles[399].ts };
    await assert.rejects(() => runResearchMechanicalScenario({
      repository: captured.repository,
      datasetId: 1,
      experimentId: "pr15.5e-failure",
      datasetFingerprintBefore: RESEARCH_MECHANICAL_FIXTURE_SHA256,
      datasetFingerprintAfter: RESEARCH_MECHANICAL_FIXTURE_SHA256,
      manifest,
      data: loadedData(candles),
      storedScenario: "primary",
    }), /overlap or are not strictly ordered/);
    assert.equal(captured.finished.length, 1);
    assert.equal(captured.finished[0].status, "failed");
    assert.equal(captured.orders.length, 0);
  });
});
