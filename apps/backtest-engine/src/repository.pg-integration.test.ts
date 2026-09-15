import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import { BacktestRepository, ensureBacktestDatabase } from "./repository.js";
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
});
