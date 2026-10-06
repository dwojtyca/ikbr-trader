import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildTradingConfigurationProjection,
  computeTradingConfigurationHash,
  parseTradingConfiguration,
} from "@ikbr/shared/trading-config";

// The scheduler and configured strategy runtime belong to signal-engine. A
// variable URL lets this integration test run their source with tsx without
// pulling that package into execution-engine's independent TypeScript rootDir.
const signalSource = new URL("../../signal-engine/src/", import.meta.url);
const signalModule = (path: string) => import(new URL(path, signalSource).href);
const now = new Date("2026-09-28T12:00:30.000Z");

function configuration() {
  const source = readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8");
  const parsed = parseTradingConfiguration(JSON.parse(source));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw Error("fixture configuration invalid");
  return parsed.configuration;
}

function capturedTimers() {
  const callbacks: { startup?: () => void; tick?: () => void } = {};
  const setTimeoutFn = ((callback: () => void) => {
    callbacks.startup = callback;
    return { unref() {} } as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const setIntervalFn = ((callback: () => void) => {
    callbacks.tick = callback;
    return { unref() {} } as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  return { callbacks, setTimeoutFn, setIntervalFn };
}

async function waitForCycle(service: { status(): { cycleCount: number; lastOutcomes: Record<string, unknown> } }, count: number, reports: number) {
  for (let attempt = 0; attempt < 400 && (service.status().cycleCount < count || Object.keys(service.status().lastOutcomes).length < reports); attempt++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(service.status().cycleCount >= count, "captured scheduler callback did not complete");
  assert.ok(Object.keys(service.status().lastOutcomes).length >= reports, "configured evaluations did not complete");
}

test("PP7 scheduler uses configured native-history strategies and keeps no-signal/disabled cycles read-only", async () => {
  const [{ ConfiguredStrategyRuntime }, { StrategyContextLoader }, { fixtureSessionSchedule, fixtureSessionCandles }, { TradingLoopService }, { StrategyPortfolioManager }, { createStrategy }] = await Promise.all([
    signalModule("runtime/strategy/configured-strategy-runtime.ts"),
    signalModule("runtime/strategy/strategy-context-loader.ts"),
    signalModule("runtime/strategy/session-native.fixture.ts"),
    signalModule("runtime/trading-loop/trading-loop-service.ts"),
    signalModule("portfolio/strategy-portfolio-manager.ts"),
    signalModule("strategies/strategy-registry.ts"),
  ]);
  const config = configuration();
  const projection = buildTradingConfigurationProjection(config);
  const candleCache = new Map<string, Record<string, unknown>>();
  const loader = new StrategyContextLoader({
    clock: () => now,
    maxMarketStateAgeMs: 90_000,
    repo: {
      getSessionScheduleEvidence: async (identity: unknown) => fixtureSessionSchedule(identity, now, 0, 1440, 95),
      getInstrumentContractByConId: async (conId: string) => {
        const row = config.instruments.find(item => String(item.contract.conId) === conId);
        assert.ok(row);
        return { ...row.contract, conid: conId, secType: "STK", source: "ibkr" };
      },
      getRecentCandlesForContract: async (_symbol: string, conId: string, timeframe: string) => {
        const bound = projection.authority.listBoundInstruments().find(item => String(item.conId) === conId);
        assert.ok(bound);
        if (!candleCache.has(conId)) candleCache.set(conId, fixtureSessionCandles(bound, now));
        return candleCache.get(conId)![timeframe] ?? [];
      },
      getMarketState: async (conId: string) => {
        const row = config.instruments.find(item => String(item.contract.conId) === conId);
        assert.ok(row);
        return { conid: conId, symbol: row.contract.symbol, lastPrice: 150.3, bid: 150.29, ask: 150.31, ts: now.toISOString() };
      },
    },
  });
  const evaluated: string[] = [];
  const configured = new ConfiguredStrategyRuntime({
    configuration: config,
    effectiveConfigHash: computeTradingConfigurationHash(config),
    accountId: "DU_PP7_FIXTURE",
    authority: projection.authority,
    registry: projection.registry,
    contextLoader: loader,
    state: { sync: async () => ({ enabled: true, permanentlyDisabled: false }) },
    assertEvaluationAllowed: async () => {},
    clock: () => now,
  });
  const timers = capturedTimers();
  let submissions = 0;
  const loop = new TradingLoopService({
    config: { enabled: true, intervalMs: 30_000, startupDelayMs: 0, maxConcurrentInstruments: 4, instrumentIds: ["pko_wse", "aapl_smart", "xyz_nyse", "disabled_assignment"], shutdownTimeoutMs: 10_000, exposureTimeoutMs: 3_000 },
    configuredSubmissionEnabled: true,
    configuredStrategyRuntime: {
      listInstrumentIds: () => configured.listInstrumentIds(),
      evaluate: async (id: string) => { evaluated.push(id); return configured.evaluate(id); },
    },
    registry: projection.registry,
    bindingAuthority: projection.authority,
    marketDataRuntime: { prepareConfiguredSignal: async () => { submissions++; throw Error("no signal may be prepared"); } },
    executionRuntime: { executePrepared: async () => { submissions++; throw Error("no signal may be executed"); } },
    exposureReader: { readExposure: async () => { throw Error("no signal may read exposure"); } },
    portfolioManager: new StrategyPortfolioManager([createStrategy("momentum_breakout_long_v1")]),
    repo: {},
    strategyCooldownMs: 0,
    maxMarketStateAgeMs: 90_000,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    clock: () => now,
    setTimeoutFn: timers.setTimeoutFn,
    setIntervalFn: timers.setIntervalFn,
    clearTimeoutFn() {},
    clearIntervalFn() {},
  });
  loop.start();
  assert.ok(timers.callbacks.startup, "start() must register startup callback");
  timers.callbacks.startup();
  await waitForCycle(loop, 1, 3);
  assert.ok(timers.callbacks.tick, "startup must install recurring callback");
  assert.deepEqual(evaluated.slice(0, 3), ["pko_wse", "aapl_smart", "xyz_nyse"]);
  for (const id of ["pko_wse", "aapl_smart", "xyz_nyse"]) {
    const report = loop.status().lastOutcomes[id] as { outcome: { kind: string; evaluation: { kind: string; entryAllowed: boolean } } };
    assert.equal(report.outcome.kind, "CONFIGURED_EVALUATION");
    assert.equal(report.outcome.evaluation.kind, "no_signal");
    assert.equal(report.outcome.evaluation.entryAllowed, false);
  }
  assert.equal(loop.status().lastOutcomes.disabled_assignment.outcome.evaluation.kind, 'disabled');
  assert.equal(loop.status().lastOutcomes.monitor_only.outcome.reason, 'NOT_IN_SCOPE');
  assert.equal(submissions, 0);
  await loop.stop();
});

for (const cap of [1, 2]) test(`PP7 recurring configured cycles fairly evaluate three assignments with concurrency cap ${cap}`, async () => {
  const [{ TradingLoopService }, { StrategyPortfolioManager }, { createStrategy }] = await Promise.all([
    signalModule('runtime/trading-loop/trading-loop-service.ts'), signalModule('portfolio/strategy-portfolio-manager.ts'), signalModule('strategies/strategy-registry.ts'),
  ]);
  const projection = buildTradingConfigurationProjection(configuration());
  const ids = ['disabled_assignment', 'aapl_smart', 'xyz_nyse'];
  const timers = capturedTimers();
  const evaluated = new Set<string>();
  let active = 0, peak = 0;
  const loop = new TradingLoopService({
    config: { enabled: true, intervalMs: 30000, startupDelayMs: 0, maxConcurrentInstruments: cap, instrumentIds: ids, shutdownTimeoutMs: 10000, exposureTimeoutMs: 3000 },
    configuredSubmissionEnabled: true,
    configuredStrategyRuntime: { listInstrumentIds: () => ids, evaluate: async (instrumentId: string) => {
      active++; peak = Math.max(active, peak); evaluated.add(instrumentId);
      await new Promise<void>(resolve => setImmediate(resolve)); active--;
      return { kind: instrumentId === 'disabled_assignment' ? 'disabled' : 'no_signal', instrumentId, entryAllowed: false, entryBlockers: ['RESEARCH_PER_PROPOSAL_REQUIRED'], reasons: [] };
    } },
    registry: projection.registry, bindingAuthority: projection.authority,
    marketDataRuntime: { prepareConfiguredSignal: async () => assert.fail('no signal must not prepare') },
    executionRuntime: { executePrepared: async () => assert.fail('no signal must not execute') },
    exposureReader: { readExposure: async () => assert.fail('no signal must not read exposure') },
    portfolioManager: new StrategyPortfolioManager([createStrategy('momentum_breakout_long_v1')]), repo: {},
    strategyCooldownMs: 0, maxMarketStateAgeMs: 90000, logger: { info() {}, warn() {}, error() {}, debug() {} },
    clock: () => now, setTimeoutFn: timers.setTimeoutFn, setIntervalFn: timers.setIntervalFn, clearTimeoutFn() {}, clearIntervalFn() {},
  });
  try {
    loop.start(); timers.callbacks.startup!();
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (cycle > 1) timers.callbacks.tick!();
      for (let attempt = 0; attempt < 400 && (loop.status().cycleCount < cycle || loop.status().activeInstruments.length); attempt++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(loop.status().cycleCount, cycle); assert.equal(loop.status().activeInstruments.length, 0);
    }
    assert.deepEqual([...evaluated].sort(), [...ids].sort()); assert.ok(peak <= cap);
  } finally { await loop.stop(); }
});
