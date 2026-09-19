import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import {
  BacktestRepository,
  ensureBacktestDatabase,
} from "./repository.js";
import {
  RESEARCH_MECHANICAL_FIXTURE_SHA256,
  RESEARCH_MECHANICAL_STRATEGY_ID,
  buildResearchMechanicalCandles,
  contractLastTradeAt,
  loadResearchMechanicalManifest,
  researchMechanicalCandleRowsHash,
} from "./research-mechanical-fixture.js";
import {
  canonicalMechanicalResultHash,
  runResearchMechanicalScenario,
} from "./research-mechanical-runner.js";

const sourceUrl = process.env.TEST_POSTGRES_URL;
const skip = process.env.BACKTEST_UNIT_ONLY === "1" || !sourceUrl;
const dbName = `ikbr_trader_test_pr155e_${process.pid}_${Date.now()}`;
let adminUrl = "";
let targetUrl = "";
let repository: BacktestRepository;
let pool: Pool;

function databaseFingerprint(rows: Array<Record<string, string>>): string {
  return researchMechanicalCandleRowsHash(rows.map((row) => ({
    symbol: row.symbol, conid: row.conid, timeframe: "1m", ts: new Date(row.ts),
    open: Number(row.open), high: Number(row.high), low: Number(row.low),
    close: Number(row.close), volume: Number(row.volume),
  })));
}

async function seedFixture(
  repository: BacktestRepository,
  pool: Pool,
  manifest: Awaited<ReturnType<typeof loadResearchMechanicalManifest>>,
  candles: ReturnType<typeof buildResearchMechanicalCandles>,
) {
  const dataset = await repository.resetHistoricalData(candles[0].ts, candles.at(-1)!.ts, ["ES"]);
  await repository.insertCandles1m(candles);
  await pool.query(`ALTER TABLE backtest_futures_contracts
    ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`);
  for (const contract of manifest.contracts) {
    await repository.upsertFuturesContractMetadata({
      conid: contract.conId, symbol: "ES", localSymbol: contract.localSymbol,
      tradingClass: "ES", lastTradeAt: contractLastTradeAt(manifest, contract.lastTradeIndex),
    });
    await pool.query(`UPDATE backtest_futures_contracts SET valid_from=$1,valid_to=$2 WHERE conid=$3`, [
      candles[contract.firstIndex].ts, candles[contract.lastIndex].ts, contract.conId,
    ]);
  }
  await repository.finishDataset(dataset.id, "ready");
  return dataset;
}

describe("PR15.5E PostgreSQL mechanical E2E", { skip }, () => {
  before(async () => {
    const source = new URL(sourceUrl!);
    if (source.pathname.replace(/^\//, "") === "ikbr_trader_backtest")
      throw new Error("PR15.5E refuses the shared ikbr_trader_backtest database");
    source.pathname = "/postgres";
    adminUrl = source.toString();
    source.pathname = `/${dbName}`;
    targetUrl = source.toString();
    await ensureBacktestDatabase(adminUrl, targetUrl);
    repository = new BacktestRepository(targetUrl);
    await repository.init();
    pool = new Pool({ connectionString: targetUrl });
  });

  after(async () => {
    await repository?.close();
    await pool?.end();
    if (!adminUrl || !dbName.startsWith("ikbr_trader_test_pr155e_")) return;
    const admin = new Pool({ connectionString: adminUrl });
    try { await admin.query(`DROP DATABASE ${dbName}`); } finally { await admin.end(); }
  });

  it("persists exact primary, stress, and reproduced audit rows without mutating the fixture dataset", async () => {
    const manifest = await loadResearchMechanicalManifest();
    const candles = buildResearchMechanicalCandles(manifest);
    const dataset = await seedFixture(repository, pool, manifest, candles);

    const persistedCandles = async () => (await pool.query(`SELECT symbol,conid,
      ts::text,open::text,high::text,low::text,close::text,volume::text
      FROM backtest_candles_1m ORDER BY symbol,ts`)).rows;
    const fingerprintBefore = databaseFingerprint(await persistedCandles());
    assert.equal(fingerprintBefore, manifest.generatedCandlesSha256);
    const validateDurableOracle = async (db: Pool, runId: number, economics: "primary" | "stress") => {
      const audit = await db.query(`SELECT o.conid,o.side,o.order_type,o.quantity,o.status,o.risk_check_status,o.reason,
        f.entry_reference_price,f.entry_fill_price,f.exit_reference_price,f.exit_fill_price,
        f.gross_pnl,f.commission,f.net_pnl,f.slippage_cost,f.exit_reason,f.entry_conid,f.exit_conid
        FROM backtest_orders o LEFT JOIN backtest_fills f ON f.order_id=o.id AND f.run_id=o.run_id
        WHERE o.run_id=$1 ORDER BY o.id`, [runId]);
      assert.equal(audit.rows.length, manifest.expected.orders);
      assert.ok(audit.rows.every((row) => row.side === "BUY" && row.order_type === "MKT" &&
        Number(row.quantity) === 1 && row.status === "FILLED" && row.risk_check_status === "PASS" &&
        row.conid === row.entry_conid && row.conid === row.exit_conid));
      assert.deepEqual(audit.rows.map((row) => ({
        episode: String(row.reason).match(/PR15\.5E:([^,]+)/)?.[1], conId: row.entry_conid,
        quantity: Number(row.quantity), entryReferencePrice: Number(row.entry_reference_price),
        entryFillPrice: Number(row.entry_fill_price), exitReferencePrice: Number(row.exit_reference_price),
        exitFillPrice: Number(row.exit_fill_price), grossPnl: Number(row.gross_pnl),
        commission: Number(row.commission), netPnl: Number(row.net_pnl),
        slippageCost: Number(row.slippage_cost), exitReason: row.exit_reason,
      })), manifest.expected[economics].fills);
    };
    const actualByScenario = new Map<string, unknown>();

    for (const storedScenario of ["primary", "stress", "primary_reproduction"] as const) {
      const data = await repository.loadBacktestData(["ES"]);
      const result = await runResearchMechanicalScenario({
        repository,
        datasetId: dataset.id,
        experimentId: "pr15.5e-mechanical-e2e",
        datasetFingerprintBefore: fingerprintBefore,
        datasetFingerprintAfter: fingerprintBefore,
        reloadDatasetFingerprint: async () => databaseFingerprint(await persistedCandles()),
        manifest,
        data,
        storedScenario,
        validateDurableOracle: (runId, economics) => validateDurableOracle(pool, runId, economics),
      });
      assert.equal(result.metrics.invariantViolations.length, 0);
      assert.equal(result.metrics.closedTrades, manifest.expected.closedTrades);
      assert.equal(result.metrics.netPnl, manifest.expected[storedScenario === "stress" ? "stress" : "primary"].totalPnl);
      assert.equal(result.metrics.pendingOrders, 0);
      assert.equal(result.metrics.unclosedFills, 0);
      const expected = manifest.expected[storedScenario === "stress" ? "stress" : "primary"];
      assert.deepEqual({
        wins: result.metrics.wins,
        losses: result.metrics.losses,
        winRate: result.metrics.winRate,
        grossPnl: result.metrics.grossPnl,
        commissions: result.metrics.commissions,
        slippageCost: result.metrics.slippageCost,
        netPnl: result.metrics.netPnl,
        largestWinningTrade: result.metrics.largestWinningTrade,
        largestLosingTrade: result.metrics.largestLosingTrade,
        countsByContract: result.metrics.countsByContract,
        countsByExitReason: result.metrics.countsByExitReason,
        countsByDirectionalRegime: result.metrics.countsByDirectionalRegime,
        countsByVolatilityRegime: result.metrics.countsByVolatilityRegime,
        lifecycleExitCounts: result.metrics.lifecycleExitCounts,
      }, {
        wins: expected.wins,
        losses: 2,
        winRate: 4 / 6,
        grossPnl: expected.grossPnl,
        commissions: expected.commissions,
        slippageCost: expected.slippageCost,
        netPnl: expected.totalPnl,
        largestWinningTrade: storedScenario === "stress" ? 468 : 482.5,
        largestLosingTrade: storedScenario === "stress" ? -544.5 : -517.5,
        countsByContract: { "501": 4, "502": 1, "503": 1 },
        countsByExitReason: manifest.expected.exitReasons,
        countsByDirectionalRegime: { range: 6 },
        countsByVolatilityRegime: { normal_volatility: 6 },
        lifecycleExitCounts: { contract_roll: 1, dataset_end: 1, expiry: 1 },
      });
      const audit = await pool.query(`SELECT
          o.id AS order_id,o.conid,o.quantity,o.status,o.reason,
          f.entry_reference_price,f.entry_fill_price,f.exit_reference_price,f.exit_fill_price,
          f.gross_pnl,f.commission,f.net_pnl,f.slippage_cost,f.exit_reason,
          f.entry_conid,f.exit_conid,f.multiplier,f.tick_size,
          f.execution_model_version,f.calendar_version
        FROM backtest_orders o
        LEFT JOIN backtest_fills f ON f.order_id=o.id AND f.run_id=o.run_id
        WHERE o.run_id=$1 ORDER BY o.id`, [result.runId]);
      assert.equal(audit.rows.length, manifest.expected.orders);
      assert.ok(audit.rows.every((row) => Number(row.quantity) === 1 && row.status === "FILLED"));
      assert.ok(audit.rows.every((row) => row.entry_conid === row.exit_conid &&
        Number(row.multiplier) === 50 && Number(row.tick_size) === 0.25 &&
        row.execution_model_version === "pr15.5b-v1" &&
        row.calendar_version === "cme-equity-index-2024-2026-v1"));

      const economics = storedScenario === "stress" ? "stress" : "primary";
      const actual = {
        totalPnl: result.summary.totalPnl,
        grossPnl: audit.rows.reduce((sum, row) => sum + Number(row.gross_pnl), 0),
        commissions: audit.rows.reduce((sum, row) => sum + Number(row.commission), 0),
        slippageCost: audit.rows.reduce((sum, row) => sum + Number(row.slippage_cost), 0),
        wins: result.summary.wins,
        fills: audit.rows.map((row) => ({
          episode: String(row.reason).match(/PR15\.5E:([^,]+)/)?.[1],
          conId: row.entry_conid,
          quantity: Number(row.quantity),
          entryReferencePrice: Number(row.entry_reference_price),
          entryFillPrice: Number(row.entry_fill_price),
          exitReferencePrice: Number(row.exit_reference_price),
          exitFillPrice: Number(row.exit_fill_price),
          grossPnl: Number(row.gross_pnl),
          commission: Number(row.commission),
          netPnl: Number(row.net_pnl),
          slippageCost: Number(row.slippage_cost),
          exitReason: row.exit_reason,
        })),
      };
      assert.deepEqual(actual, manifest.expected[economics]);
      actualByScenario.set(storedScenario, actual);

      const lifecycle = Object.fromEntries((await pool.query(`SELECT exit_reason,COUNT(*)::int AS count
        FROM backtest_fills WHERE run_id=$1 GROUP BY exit_reason ORDER BY exit_reason`, [result.runId]))
        .rows.map((row) => [row.exit_reason, row.count]));
      assert.deepEqual(lifecycle, manifest.expected.exitReasons);
      const rejected = await pool.query(`SELECT SUM(samples)::int AS count
        FROM backtest_signal_diagnostics WHERE run_id=$1 AND stage='rejected' AND reason_group='sizing'`, [result.runId]);
      assert.equal(rejected.rows[0].count, 1);
      const terminal = await pool.query(`SELECT status,
        (SELECT COUNT(*)::int FROM backtest_orders WHERE run_id=$1 AND status='PROPOSED') AS pending,
        (SELECT COUNT(*)::int FROM backtest_orders o WHERE run_id=$1 AND status='FILLED'
          AND NOT EXISTS (SELECT 1 FROM backtest_fills f WHERE f.order_id=o.id)) AS unclosed
        FROM backtest_runs WHERE id=$1`, [result.runId]);
      assert.deepEqual(terminal.rows[0], { status: "completed", pending: 0, unclosed: 0 });
    }

    assert.deepEqual(actualByScenario.get("primary_reproduction"), actualByScenario.get("primary"));
    assert.equal(canonicalMechanicalResultHash(actualByScenario.get("primary_reproduction")),
      manifest.expected.primaryReproductionSha256);
    assert.equal(databaseFingerprint(await persistedCandles()), fingerprintBefore);

    const runState = await pool.query(`SELECT COUNT(*)::int AS count,
      COALESCE(BOOL_AND(permanently_disabled=false),false) AS enabled
      FROM backtest_strategy_state WHERE strategy_id=$1`, [RESEARCH_MECHANICAL_STRATEGY_ID]);
    assert.deepEqual(runState.rows[0], { count: 3, enabled: true });

    const freshName = `ikbr_trader_test_pr155e_repro_${process.pid}_${Date.now()}`;
    const freshUrl = new URL(targetUrl);
    freshUrl.pathname = `/${freshName}`;
    await ensureBacktestDatabase(adminUrl, freshUrl.toString());
    const freshRepository = new BacktestRepository(freshUrl.toString());
    const freshPool = new Pool({ connectionString: freshUrl.toString() });
    try {
      await freshRepository.init();
      const freshDataset = await seedFixture(freshRepository, freshPool, manifest, candles);
      const freshRows = async (db: Pool) => (await db.query(`SELECT o.reason,
        f.entry_reference_price,f.entry_fill_price,f.exit_reference_price,f.exit_fill_price,
        f.gross_pnl,f.commission,f.net_pnl,f.slippage_cost,f.exit_reason,
        f.entry_conid,f.exit_conid FROM backtest_orders o
        JOIN backtest_fills f ON f.order_id=o.id WHERE o.run_id=(
          SELECT id FROM backtest_runs WHERE config_json->>'experimentId'=$1
            AND config_json->>'scenario'='primary' ORDER BY id LIMIT 1) ORDER BY o.id`,
      ["pr15.5e-mechanical-e2e"])).rows;
      const freshFingerprint = databaseFingerprint(await (async () => (await freshPool.query(
        `SELECT symbol,conid,ts::text,open::text,high::text,low::text,close::text,volume::text
         FROM backtest_candles_1m ORDER BY symbol,ts`)).rows)());
      const freshPersistedFingerprint = async () => databaseFingerprint(await (async () => (await freshPool.query(
        `SELECT symbol,conid,ts::text,open::text,high::text,low::text,close::text,volume::text
         FROM backtest_candles_1m ORDER BY symbol,ts`)).rows)());
      const freshResult = await runResearchMechanicalScenario({
        repository: freshRepository,
        datasetId: freshDataset.id,
        experimentId: "pr15.5e-mechanical-e2e",
        datasetFingerprintBefore: freshFingerprint,
        datasetFingerprintAfter: freshFingerprint,
        reloadDatasetFingerprint: freshPersistedFingerprint,
        validateDurableOracle: (runId, economics) => validateDurableOracle(freshPool, runId, economics),
        manifest,
        data: await freshRepository.loadBacktestData(["ES"]),
        storedScenario: "primary",
      });
      assert.equal(freshResult.metrics.netPnl, manifest.expected.primary.totalPnl);
      assert.deepEqual(await freshRows(freshPool), await freshRows(pool));
    } finally {
      await freshRepository.close();
      await freshPool.end();
      const admin = new Pool({ connectionString: adminUrl });
      try { await admin.query(`DROP DATABASE ${freshName}`); } finally { await admin.end(); }
    }

    const originalInsertFill = repository.insertFill.bind(repository);
    const failureData = await repository.loadBacktestData(["ES"]);
    repository.insertFill = async () => { throw new Error("injected durable fill failure"); };
    try {
      await assert.rejects(() => runResearchMechanicalScenario({
        repository,
        datasetId: dataset.id,
        experimentId: "pr15.5e-mechanical-repository-failure",
        datasetFingerprintBefore: fingerprintBefore,
        datasetFingerprintAfter: fingerprintBefore,
        manifest,
        data: failureData,
        storedScenario: "primary",
      }), /injected durable fill failure/);
    } finally {
      repository.insertFill = originalInsertFill;
    }
    const failed = await pool.query(`SELECT r.status,
      (SELECT COUNT(*)::int FROM backtest_orders WHERE run_id=r.id) AS orders,
      (SELECT COUNT(*)::int FROM backtest_fills WHERE run_id=r.id) AS fills
      FROM backtest_runs r WHERE config_json->>'experimentId'=$1`,
    ["pr15.5e-mechanical-repository-failure"]);
    assert.deepEqual(failed.rows, [{ status: "failed", orders: 1, fills: 0 }]);
    assert.equal(databaseFingerprint(await persistedCandles()), fingerprintBefore);
  });
});
