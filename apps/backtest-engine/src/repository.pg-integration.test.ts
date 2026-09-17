import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  BacktestRepository,
  backtestDatabaseExists,
  ensureBacktestDatabase,
} from "./repository.js";
import { BacktestSimulator, type SimulatorOptions } from "./simulator.js";
import type { LoadedBacktestData } from "./types.js";

const sourceUrl = process.env.TEST_POSTGRES_URL;
const skip = process.env.BACKTEST_UNIT_ONLY === "1" || !sourceUrl;
const dbName = `ikbr_trader_test_${process.pid}_${Date.now()}`;
let adminUrl = "";
let targetUrl = "";
let repo: BacktestRepository;

describe("BacktestRepository PostgreSQL integration", { skip }, () => {
  before(async () => {
    const source = new URL(sourceUrl!);
    if (source.pathname.replace(/^\//, "") === "ikbr_trader_backtest")
      throw new Error("Integration tests refuse the shared ikbr_trader_backtest database");
    source.pathname = "/postgres";
    adminUrl = source.toString();
    source.pathname = `/${dbName}`;
    targetUrl = source.toString();
    await ensureBacktestDatabase(adminUrl, targetUrl);
    repo = new BacktestRepository(targetUrl);
  });

  after(async () => {
    await repo?.close();
    if (!adminUrl || !dbName.startsWith("ikbr_trader_test_")) return;
    const admin = new Pool({ connectionString: adminUrl });
    try { await admin.query(`DROP DATABASE ${dbName}`); } finally { await admin.end(); }
  });

  it("checks database presence without creating an absent research database", async () => {
    const missing = new URL(targetUrl);
    missing.pathname = `/${dbName}_missing`;
    assert.equal(await backtestDatabaseExists(adminUrl, missing.toString()), false);
    assert.equal(await backtestDatabaseExists(adminUrl, targetUrl), true);
    const admin = new Pool({ connectionString: adminUrl });
    try {
      const result = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
        `${dbName}_missing`,
      ]);
      assert.equal(result.rowCount, 0);
    } finally { await admin.end(); }
  });

  it("initializes additively and round-trips the futures audit model", async () => {
    await repo.init();
    await repo.init();
    const dataset = await repo.resetHistoricalData(new Date("2026-06-01"), new Date("2026-06-02"), ["ES"]);
    const run = await repo.createRun(dataset.id, { model: "pr15.5b-v1" });
    const orderId = await repo.insertOrder({
      runId: run.id, instrument: "ES", conid: "123", side: "BUY", orderType: "LMT",
      quantity: 2, entry: 5000, stop: 4995, takeProfit: 5010, reason: "fixture",
      confidence: 1, riskCheckStatus: "PASS", status: "FILLED", strategy: "fixture",
      createdAt: new Date("2026-06-01T22:00:00Z"),
    });
    const spec = {
      tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1.25, slippageTicks: 1,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "fixture-v1",
    } as const;
    const baseOptions: SimulatorOptions = {
      minCandles: 1, maxSpreadBps: 100, minVolume1m: 0, minConfidence: 0,
      lmtEntryMode: "touch", lmtEntryBufferBps: 0, fractionalSymbols: new Set(),
      fractionalQuantityStep: 1, minStopBpsBySecType: { FUT: 0 }, baseCurrency: "USD",
      currencyBySymbol: { ES: "USD" }, secTypeBySymbol: { ES: "FUT" },
      priceMultiplierBySymbol: { ES: 50 }, strategyCooldownMs: 1,
      commissionBps: 0, commissionPerShare: 0, commissionMinPerSide: 0,
      commissionPassthroughBps: 0, syntheticSpreadBps: 0, orderTtlCandles: 1,
      strategyIds: [], futuresSpecs: new Map([["ES", spec]]), futuresContracts: new Map(),
      futuresCalendars: new Map(), riskLimits: { accountEquity: 100_000,
        maxRiskPerTradePct: 1, maxExposurePct: 100, maxNotionalPerTradePct: 100,
        maxOpenPositions: 10 },
    };
    const emptyData: LoadedBacktestData = {
      dataset: { ...dataset, status: "ready" }, candles1m: new Map(), candles5m: new Map(),
      candles1h: new Map(), candles4h: new Map(), candles12h: new Map(),
      candles1d: new Map(), candles1w: new Map(), candleCount1m: 0, fxRates: [],
    };
    const simulator = new BacktestSimulator(repo, run.id, emptyData, baseOptions);
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      closePosition(position: Record<string, unknown>, price: number, at: Date,
        reason: string, orderId: number, reference: number, exitConid: string): Promise<void>;
    };
    const position = {
      symbol: "ES", conid: "123", quantity: 2, originalQuantityAbs: 2,
      averageCost: 5000.25, entryAt: new Date("2026-06-01T22:00:00Z"), orderId,
      strategy: "fixture", runtimeKey: "fixture|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 50, fxToBaseAtEntry: 1, entryReferencePrice: 5000,
      entrySlippage: 0.25, futuresSpec: spec,
    };
    internals.positions.set("ES", position);
    await internals.closePosition(position, 5001.75, new Date("2026-06-01T23:00:00Z"),
      "dataset_end", orderId, 5002, "123");
    const pool = new Pool({ connectionString: targetUrl });
    try {
      const result = await pool.query("SELECT * FROM backtest_fills WHERE order_id=$1", [orderId]);
      const row = result.rows[0];
      assert.equal(Number(row.gross_pnl), 150);
      assert.equal(Number(row.commission), 5);
      assert.equal(Number(row.net_pnl), 145);
      assert.equal(Number(row.slippage_cost), 50);
      assert.equal(Number(row.entry_reference_price), 5000);
      assert.equal(Number(row.entry_fill_price), 5000.25);
      assert.equal(Number(row.exit_reference_price), 5002);
      assert.equal(Number(row.exit_fill_price), 5001.75);
      assert.equal(Number(row.multiplier), 50);
      assert.equal(Number(row.tick_size), 0.25);
      assert.equal(Number(row.entry_slippage), 0.25);
      assert.equal(Number(row.exit_slippage), 0.25);
      assert.equal(Number(row.commission_per_contract_side), 1.25);
      assert.equal(row.entry_conid, "123");
      assert.equal(row.exit_conid, "123");
      assert.equal(row.execution_model_version, "pr15.5b-v1");
      assert.equal(row.calendar_version, "fixture-v1");

      const invalidData: LoadedBacktestData = {
        ...emptyData,
        candles1m: new Map([["ES", [{ symbol: "ES", conid: "missing", timeframe: "1m",
          ts: new Date("2026-06-01T22:00:00Z"), open: 5000, high: 5000.25,
          low: 4999.75, close: 5000, volume: 1 }]]]),
        candleCount1m: 1,
      };
      await assert.rejects(
        () => new BacktestSimulator(repo, run.id, invalidData, baseOptions).run(),
        /Missing futures contract metadata/,
      );
      const counts = await pool.query(
        "SELECT (SELECT COUNT(*) FROM backtest_orders) AS orders, (SELECT COUNT(*) FROM backtest_fills) AS fills",
      );
      assert.equal(Number(counts.rows[0].orders), 1);
      assert.equal(Number(counts.rows[0].fills), 1);
    } finally { await pool.end(); }
  });

  it("atomically claims across repository instances and recovers an abandoned claim", async () => {
    const owner = new BacktestRepository(targetUrl);
    const contender = new BacktestRepository(targetUrl);
    const recovery = new BacktestRepository(targetUrl);
    await Promise.all([owner.init(), contender.init(), recovery.init()]);
    const recoveredArtifact = () => ({
      result: { verdict: "INCONCLUSIVE" }, resultSha256: "b".repeat(64),
    });
    try {
      assert.equal(await owner.claimResearchExperiment("restart-fixture", {
        experimentId: "restart-fixture",
      }), true);
      assert.equal(await contender.claimResearchExperiment("restart-fixture", {
        experimentId: "restart-fixture",
      }), false);
      assert.equal(await recovery.recoverAbandonedResearchExperiment(
        "restart-fixture", recoveredArtifact,
      ), false, "a live owner's session lock must prevent false recovery");
      const pool = new Pool({ connectionString: targetUrl });
      const dataset = await pool.query("SELECT id FROM backtest_datasets ORDER BY id DESC LIMIT 1");
      await owner.createResearchScenarioRun(Number(dataset.rows[0].id), {
        experimentId: "restart-fixture", scenario: "primary",
      });
      await owner.close();
      await pool.query(`CREATE OR REPLACE FUNCTION fail_research_recovery() RETURNS trigger
        LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''fixture recovery failure''; END'`);
      await pool.query(`CREATE TRIGGER fail_research_recovery_trigger BEFORE UPDATE ON backtest_runs
        FOR EACH ROW WHEN (OLD.status='running' AND NEW.status='failed')
        EXECUTE FUNCTION fail_research_recovery()`);
      await assert.rejects(() => recovery.recoverAbandonedResearchExperiment(
        "restart-fixture", recoveredArtifact,
      ), /fixture recovery failure/);
      const rolledBack = await pool.query(`SELECT
        (SELECT status FROM backtest_research_experiments WHERE experiment_id='restart-fixture') AS experiment_status,
        (SELECT status FROM backtest_runs WHERE config_json->>'experimentId'='restart-fixture') AS run_status`);
      assert.deepEqual(rolledBack.rows[0], {
        experiment_status: "running", run_status: "running",
      });
      await pool.query("DROP TRIGGER fail_research_recovery_trigger ON backtest_runs");
      await pool.query("DROP FUNCTION fail_research_recovery()");
      assert.equal(await recovery.recoverAbandonedResearchExperiment(
        "restart-fixture", recoveredArtifact,
      ), true);
      assert.deepEqual(await recovery.getResearchExperimentResult("restart-fixture"), {
        result: { verdict: "INCONCLUSIVE" }, resultSha256: "b".repeat(64),
      });
      const recoveredRun = await pool.query(`SELECT status FROM backtest_runs
        WHERE config_json->>'experimentId'='restart-fixture'`);
      assert.equal(recoveredRun.rows[0].status, "failed");
      await pool.end();
    } finally {
      await contender.close();
      await recovery.close();
    }
  });

  it("persists one research experiment and derives canonical audit metrics", async () => {
    const dataset = await repo.resetHistoricalData(
      new Date("2026-06-01T22:00:00Z"),
      new Date("2026-06-02T20:59:00Z"),
      ["ES"],
    );
    const pool = new Pool({ connectionString: targetUrl });
    try {
      assert.equal(await repo.claimResearchExperiment("fixture-experiment", {
        experimentId: "fixture-experiment",
      }), true);
      await pool.query(`ALTER TABLE backtest_futures_contracts
        ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`);
      await repo.upsertFuturesContractMetadata({
        conid: "123", symbol: "ES", localSymbol: "ESM6", tradingClass: "ES",
        lastTradeAt: new Date("2026-06-18T13:30:00Z"),
      });
      await pool.query(`UPDATE backtest_futures_contracts
        SET valid_from='2026-06-01T22:00:00Z',valid_to='2026-06-02T20:59:00Z'
        WHERE conid='123'`);
      const run = await repo.createResearchScenarioRun(dataset.id, {
        experimentId: "fixture-experiment", scenario: "primary",
      });
      await assert.rejects(() => repo.createResearchScenarioRun(dataset.id, {
        experimentId: "fixture-experiment", scenario: "primary",
      }), /already exists/);
      const orderId = await repo.insertOrder({
        runId: run.id, instrument: "ES", conid: "123", side: "BUY", orderType: "LMT",
        quantity: 1, entry: 5000, stop: 4995, takeProfit: 5010, reason: "fixture",
        confidence: 1, riskCheckStatus: "PASS", status: "FILLED",
        strategy: "momentum_breakout_long_v1", createdAt: new Date("2026-06-01T22:00:00Z"),
      });
      await repo.insertFill({
        runId: run.id, orderId, instrument: "ES", conid: "123",
        strategy: "momentum_breakout_long_v1", side: "BUY",
        directionalRegime: "bull_trend", volatilityRegime: "normal_volatility",
        confidence: 1, quantity: 1, entryPrice: 5000.25, exitPrice: 5001.75,
        entryAt: new Date("2026-06-01T22:00:00Z"), exitAt: new Date("2026-06-01T23:00:00Z"),
        grossPnl: 75, commission: 5, netPnl: 70, pnlPct: 0.014,
        exitReason: "dataset_end", entryReferencePrice: 5000, entryFillPrice: 5000.25,
        exitReferencePrice: 5002, exitFillPrice: 5001.75, multiplier: 50, tickSize: 0.25,
        entrySlippage: 0.25, exitSlippage: 0.25, slippageCost: 25,
        commissionPerContractSide: 2.5, entryConid: "123", exitConid: "123",
        executionModelVersion: "pr15.5b-v1", calendarVersion: "cme-equity-index-2024-2026-v1",
      });
      await repo.upsertStrategyStates(run.id, [{
        strategyId: "momentum_breakout_long_v1", enabled: true,
        permanentlyDisabled: false,
      }]);
      await repo.upsertSignalDiagnostics([{
        runId: run.id, strategy: "momentum_breakout_long_v1", instrument: "ES",
        side: "HOLD", stage: "rejected", reasonGroup: "no_signal", samples: 3,
      }]);
      const metrics = await repo.getResearchScenarioMetrics(
        run.id, "primary", "f".repeat(64), "f".repeat(64),
      );
      assert.equal(metrics.closedTrades, 1);
      assert.equal(metrics.netPnl, 70);
      assert.deepEqual(metrics.invariantViolations, []);
      assert.equal(metrics.countsByContract["123"], 1);
      assert.equal(metrics.signalRejections["rejected:no_signal"], 3);
      await repo.createResearchScenarioRun(dataset.id, {
        experimentId: "fixture-experiment", scenario: "stress",
      });
      await repo.saveResearchExperimentArtifact(
        "fixture-experiment", { verdict: "REJECTED_FOR_ES" }, "a".repeat(64),
      );
      assert.equal(await repo.researchExperimentExists("fixture-experiment"), true);
      assert.deepEqual(await repo.getResearchExperimentResult("fixture-experiment"), {
        result: { verdict: "REJECTED_FOR_ES" }, resultSha256: "a".repeat(64),
      });
      const concurrent = await Promise.allSettled([
        repo.createResearchScenarioRun(dataset.id, {
          experimentId: "concurrent-fixture", scenario: "primary",
        }),
        repo.createResearchScenarioRun(dataset.id, {
          experimentId: "concurrent-fixture", scenario: "primary",
        }),
      ]);
      assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
      assert.equal(concurrent.filter((entry) => entry.status === "rejected").length, 1);
    } finally {
      await pool.end();
    }
  });
});
