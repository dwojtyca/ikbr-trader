import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Pool } from "pg";
import Fastify from "fastify";
import { BacktestRepository, ensureBacktestDatabase } from "./repository.js";
import { importResearchDataset } from "./research-dataset-importer.js";
import { RESEARCH_DATABASE_NAME } from "./research-dataset-schema.js";
import { researchFixture } from "./research-dataset.test-fixture.js";
import { installProtectedResearchRouteGuard, PROTECTED_RESEARCH_ROUTES } from "./research-route-guard.js";

const sourceUrl = process.env.TEST_POSTGRES_URL;
const skip = process.env.BACKTEST_UNIT_ONLY === "1" || !sourceUrl;
let adminUrl = "";
let databaseUrl = "";
let ownsDatabase = false;
let tempRoot = "";

async function databaseExists(): Promise<boolean> {
  const admin = new Pool({ connectionString: adminUrl });
  try {
    const result = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [RESEARCH_DATABASE_NAME]);
    return result.rowCount !== 0;
  } finally { await admin.end(); }
}

async function freshDatabase(): Promise<void> {
  if (!ownsDatabase) throw new Error("Refusing to reset a research database not created by this test process");
  const admin = new Pool({ connectionString: adminUrl });
  try { await admin.query(`DROP DATABASE IF EXISTS ${RESEARCH_DATABASE_NAME}`); } finally { await admin.end(); }
  await ensureBacktestDatabase(adminUrl, databaseUrl);
}

async function writeBundle(
  label: string,
  mutateRows?: (rows: Array<Record<string, string>>) => void,
  mutateManifest?: (manifest: ReturnType<typeof researchFixture>["manifest"]) => void,
) {
  const fixture = researchFixture();
  const rows = fixture.rows.map((row) => ({ ...row })) as Array<Record<string, string>>;
  mutateRows?.(rows);
  const raw = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const manifest = {
    ...structuredClone(fixture.manifest),
    source: { ...fixture.manifest.source, candlesSha256: createHash("sha256").update(raw).digest("hex") },
  };
  mutateManifest?.(manifest);
  const directory = join(tempRoot, label);
  await mkdir(directory);
  await Promise.all([
    writeFile(join(directory, "manifest.json"), JSON.stringify(manifest)),
    writeFile(join(directory, "candles-1m.ndjson"), raw),
  ]);
  return { directory, calendars: fixture.calendars };
}

describe("PR15.5C research dataset PostgreSQL integration", { skip }, () => {
  before(async () => {
    const source = new URL(sourceUrl!);
    source.pathname = "/postgres";
    source.search = "";
    source.hash = "";
    adminUrl = source.toString();
    source.pathname = `/${RESEARCH_DATABASE_NAME}`;
    databaseUrl = source.toString();
    if (await databaseExists())
      throw new Error(`Integration test refuses existing ${RESEARCH_DATABASE_NAME}; use an isolated PostgreSQL instance`);
    await ensureBacktestDatabase(adminUrl, databaseUrl);
    ownsDatabase = true;
    tempRoot = await mkdtemp(join(tmpdir(), "ikbr-pr155c-"));
  });

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    if (ownsDatabase) {
      const admin = new Pool({ connectionString: adminUrl });
      try { await admin.query(`DROP DATABASE IF EXISTS ${RESEARCH_DATABASE_NAME}`); } finally { await admin.end(); }
    }
  });

  it("rejects shared and option-overridden URLs before dataset mutation", async () => {
    const bundle = await writeBundle("url-rejection");
    const shared = new URL(databaseUrl);
    shared.pathname = "/ikbr_trader_backtest";
    await assert.rejects(() => importResearchDataset(shared.toString(), adminUrl, bundle.directory, bundle.calendars), /must be exactly/);
    const overridden = new URL(databaseUrl);
    overridden.searchParams.set("options", "-csearch_path=other");
    await assert.rejects(() => importResearchDataset(overridden.toString(), adminUrl, bundle.directory, bundle.calendars), /must not override/);
  });

  it("rejects actual Fastify history routes before their write handlers run", async () => {
    const app = Fastify();
    let writes = 0;
    installProtectedResearchRouteGuard(app, databaseUrl);
    for (const route of PROTECTED_RESEARCH_ROUTES)
      app.post(route, async () => { writes += 1; return { ok: true }; });
    try {
      for (const route of PROTECTED_RESEARCH_ROUTES) {
        const response = await app.inject({ method: "POST", url: route, payload: {} });
        assert.equal(response.statusCode, 423);
        assert.equal(response.json().error, "research_dataset_immutable");
      }
      assert.equal(writes, 0);
    } finally { await app.close(); }
  });

  it("imports atomically, fingerprints read-back, and permanently protects dataset content", async () => {
    await freshDatabase();
    const bundle = await writeBundle("primary");
    const imported = await importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars);
    assert.equal(imported.candlesCount, 4);
    assert.equal(imported.provenanceId, "synthetic-es-fixture-v1");
    assert.match(imported.fingerprint, /^[a-f0-9]{64}$/);

    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const dataset = await pool.query("SELECT status,finalized_at,fingerprint,candles_count FROM backtest_datasets");
      assert.equal(dataset.rows[0].status, "ready");
      assert.ok(dataset.rows[0].finalized_at);
      assert.equal(dataset.rows[0].fingerprint, imported.fingerprint);
      assert.equal(Number(dataset.rows[0].candles_count), 4);
      const collision = await pool.query("SELECT COUNT(*) AS count FROM backtest_candles_1m WHERE ts='2026-06-01T22:00:00.000Z'");
      assert.equal(Number(collision.rows[0].count), 2);
      for (const table of ["backtest_candles_1h", "backtest_candles_4h", "backtest_candles_1d"]) {
        const buckets = await pool.query(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM ${table}`);
        assert.equal(new Date(buckets.rows[0].first).toISOString(), "2026-06-01T22:00:00.000Z");
        assert.equal(new Date(buckets.rows[0].last).toISOString(), "2026-06-01T22:00:00.000Z");
      }

      const protectedTables = ["backtest_datasets", "backtest_candles_1m", "backtest_candles_5m", "backtest_candles_1h", "backtest_candles_4h", "backtest_candles_12h", "backtest_candles_1d", "backtest_candles_1w", "backtest_fx_rates", "backtest_instrument_contracts", "backtest_futures_contracts"];
      for (const table of protectedTables) {
        const column = table === "backtest_datasets" ? "status"
          : table === "backtest_fx_rates" || table === "backtest_instrument_contracts" ? "source"
          : "symbol";
        await assert.rejects(() => pool.query(`INSERT INTO ${table} DEFAULT VALUES`), /immutable/);
        await assert.rejects(() => pool.query(`UPDATE ${table} SET ${column}=${column} WHERE FALSE`), /immutable/);
        await assert.rejects(() => pool.query(`DELETE FROM ${table} WHERE FALSE`), /immutable/);
        await assert.rejects(() => pool.query(`TRUNCATE ${table} CASCADE`), /immutable/);
      }
      await pool.query(`INSERT INTO backtest_runs (dataset_id,mode,status,config_json)
        VALUES ($1,'isolated','running','{}')`, [imported.datasetId]);
    } finally { await pool.end(); }

    const legacy = new BacktestRepository(databaseUrl);
    try {
      await assert.rejects(() => legacy.resetHistoricalData(new Date(), new Date(), ["ES"]), /forbidden/);
      await assert.rejects(() => legacy.insertCandles1m([]), /forbidden/);
      await assert.rejects(() => legacy.rebuildAggregates(), /forbidden/);
    } finally { await legacy.close(); }
    await assert.rejects(() => importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars), /not empty/);
    const changed = await writeBundle("modified-reimport", (rows) => { rows[0].closeTicks = "24002"; });
    await assert.rejects(() => importResearchDataset(databaseUrl, adminUrl, changed.directory, changed.calendars), /not empty/);
    const unchanged = new Pool({ connectionString: databaseUrl });
    try {
      const state = await unchanged.query("SELECT COUNT(*) AS count, MIN(fingerprint) AS fingerprint FROM backtest_datasets");
      assert.equal(Number(state.rows[0].count), 1);
      assert.equal(state.rows[0].fingerprint, imported.fingerprint);
    } finally { await unchanged.end(); }
  });

  it("guards every legacy repository dataset mutation method", async () => {
    const repository = new BacktestRepository(databaseUrl);
    const calls = [
      () => repository.resetHistoricalData(new Date(), new Date(), ["ES"]),
      () => repository.finishDataset(1, "ready"),
      () => repository.resumeDataset(1),
      () => repository.upsertInstrumentContract({} as never),
      () => repository.upsertFuturesContractMetadata({} as never),
      () => repository.insertCandles1m([]),
      () => repository.insertFxRates([]),
      () => repository.rebuildAggregates(),
      () => repository.appendDatasetSymbols(1, ["ES"]),
      () => repository.refreshDatasetCandlesCount(1),
    ];
    try {
      for (const call of calls) await assert.rejects(call, /forbidden/);
    } finally { await repository.close(); }
  });

  it("rejects malformed bundles before creating partial database content", async () => {
    await freshDatabase();
    const bad = await writeBundle("bad", (rows) => { rows[0].highTicks = "1"; });
    await assert.rejects(() => importResearchDataset(databaseUrl, adminUrl, bad.directory, bad.calendars), /OHLC/);
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const table = await pool.query("SELECT to_regclass('backtest_datasets') AS name");
      assert.equal(table.rows[0].name, null);
    } finally { await pool.end(); }
  });

  it("rolls back all dataset rows after a failure inside the import transaction", async () => {
    await freshDatabase();
    const repository = new BacktestRepository(databaseUrl);
    try { await repository.init(); } finally { await repository.close(); }
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query(`CREATE FUNCTION fail_research_candle_insert() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'injected candle failure'; END $$`);
      await pool.query(`CREATE TRIGGER injected_failure BEFORE INSERT ON backtest_candles_1m
        FOR EACH STATEMENT EXECUTE FUNCTION fail_research_candle_insert()`);
    } finally { await pool.end(); }
    const bundle = await writeBundle("transaction-failure");
    await assert.rejects(
      () => importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars),
      /injected candle failure/,
    );
    const inspect = new Pool({ connectionString: databaseUrl });
    try {
      for (const table of ["backtest_datasets", "backtest_futures_contracts", "backtest_instrument_contracts", "backtest_candles_1m"])
        assert.equal(Number((await inspect.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count), 0);
    } finally { await inspect.end(); }
  });

  it("reproduces fingerprints in clean databases and changes them with content", async () => {
    const bundle = await writeBundle("reproducible");
    await freshDatabase();
    const first = await importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars);
    await freshDatabase();
    const second = await importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars);
    assert.equal(first.fingerprint, second.fingerprint);

    const changed = await writeBundle("changed", (rows) => { rows[0].closeTicks = "24002"; });
    await freshDatabase();
    const changedResult = await importResearchDataset(databaseUrl, adminUrl, changed.directory, changed.calendars);
    assert.notEqual(changedResult.fingerprint, first.fingerprint);

    const changedContract = await writeBundle("changed-contract", undefined, (manifest) => {
      manifest.contracts[1].expiry = "2026-09-18T16:01:00.000Z";
    });
    await freshDatabase();
    const changedContractResult = await importResearchDataset(
      databaseUrl,
      adminUrl,
      changedContract.directory,
      changedContract.calendars,
    );
    assert.notEqual(changedContractResult.fingerprint, first.fingerprint);
  });

  it("serializes concurrent imports and permits exactly one finalization", async () => {
    await freshDatabase();
    const bundle = await writeBundle("race");
    const results = await Promise.allSettled([
      importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars),
      importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const count = await pool.query("SELECT COUNT(*) AS count FROM backtest_datasets WHERE finalized_at IS NOT NULL");
      assert.equal(Number(count.rows[0].count), 1);
    } finally { await pool.end(); }
  });

  it("forces public schema despite inherited PGOPTIONS", async () => {
    await freshDatabase();
    const bundle = await writeBundle("pgoptions");
    const previous = process.env.PGOPTIONS;
    process.env.PGOPTIONS = "-c search_path=pg_catalog";
    try {
      const result = await importResearchDataset(databaseUrl, adminUrl, bundle.directory, bundle.calendars);
      assert.equal(result.candlesCount, 4);
    } finally {
      if (previous === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previous;
    }
  });
});
