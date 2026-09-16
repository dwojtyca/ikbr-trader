import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import type { CmeCalendarDefinition } from "./cme-session-calendar.js";
import { ResearchDatasetFingerprintBuilder, ticksToPrice } from "./research-dataset-fingerprint.js";
import {
  assertResearchDatabaseUrl,
  RESEARCH_DATABASE_NAME,
  parseResearchManifest,
  ResearchCandleSequenceValidator,
  type ResearchDatasetCandle,
  type ResearchDatasetManifest,
} from "./research-dataset-schema.js";
import { BacktestRepository, ensureBacktestDatabase } from "./repository.js";

export interface ResearchDatasetImportResult {
  datasetId: number;
  provenanceId: string;
  fingerprint: string;
  candlesCount: number;
}

async function assertServerIdentity(targetUrl: string): Promise<void> {
  const pool = new Pool({
    connectionString: targetUrl,
    max: 1,
    options: "-c search_path=public",
  });
  try {
    const result = await pool.query(`SELECT current_database() AS database,
      current_schema() AS schema, current_schemas(false) AS schemas`);
    const row = result.rows[0];
    const schemas = Array.isArray(row?.schemas)
      ? row.schemas.map(String)
      : String(row?.schemas) === "{public}" ? ["public"] : [];
    if (row?.database !== RESEARCH_DATABASE_NAME || row?.schema !== "public" ||
      schemas.length !== 1 || schemas[0] !== "public")
      throw new Error("PostgreSQL server identity or search_path is not the protected research database public schema");
  } finally { await pool.end(); }
}

async function loadResearchManifest(
  directory: string,
  calendars: ReadonlyMap<string, CmeCalendarDefinition>,
): Promise<ResearchDatasetManifest> {
  const files = (await readdir(directory)).sort();
  if (files.length !== 2 || files[0] !== "candles-1m.ndjson" || files[1] !== "manifest.json")
    throw new Error("Research bundle must contain exactly manifest.json and candles-1m.ndjson");
  const manifestRaw = await readFile(`${directory}/manifest.json`, "utf8");
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    throw new Error("manifest.json must contain valid JSON");
  }
  return parseResearchManifest(manifestJson, calendars);
}

async function scanCandleFile(
  path: string,
  manifest: ResearchDatasetManifest,
  calendars: ReadonlyMap<string, CmeCalendarDefinition>,
  onBatch?: (candles: readonly ResearchDatasetCandle[]) => Promise<void>,
): Promise<{ fingerprint: string; candlesCount: number }> {
  const sourceHash = createHash("sha256");
  const fingerprint = new ResearchDatasetFingerprintBuilder(manifest);
  const validator = new ResearchCandleSequenceValidator(manifest, calendars);
  let carry = Buffer.alloc(0);
  let lineNumber = 0;
  let lastByte: number | undefined;
  let batch: ResearchDatasetCandle[] = [];
  for await (const value of createReadStream(path)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    sourceHash.update(chunk);
    lastByte = chunk.at(-1);
    const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
    let start = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) continue;
      const bytes = data.subarray(start, index);
      lineNumber += 1;
      if (bytes.includes(0x0d)) throw new Error("candles-1m.ndjson must use LF line endings");
      if (lineNumber === 1 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        throw new Error("candles-1m.ndjson must not contain a BOM");
      const line = bytes.toString("utf8");
      if (Buffer.from(line, "utf8").compare(bytes) !== 0)
        throw new Error(`Invalid UTF-8 at candle line ${lineNumber}`);
      const candle = validator.parseLine(line, lineNumber);
      fingerprint.updateCandle(candle);
      if (onBatch) {
        batch.push(candle);
        if (batch.length === 500) {
          await onBatch(batch);
          batch = [];
        }
      }
      start = index + 1;
    }
    carry = data.subarray(start);
    if (carry.length > 64 * 1024) throw new Error("Candle line exceeds 64 KiB");
  }
  if (lineNumber === 0 || lastByte !== 0x0a || carry.length !== 0)
    throw new Error("candles-1m.ndjson must be non-empty and LF-terminated");
  if (batch.length > 0 && onBatch) await onBatch(batch);
  const actualSourceHash = sourceHash.digest("hex");
  if (actualSourceHash !== manifest.source.candlesSha256)
    throw new Error("candles-1m.ndjson checksum does not match manifest");
  return { fingerprint: fingerprint.digest(), candlesCount: lineNumber };
}

async function initializeResearchSchema(client: PoolClient): Promise<void> {
  for (const statement of [
    `ALTER TABLE backtest_datasets ADD COLUMN IF NOT EXISTS provenance_id TEXT`,
    `ALTER TABLE backtest_datasets ADD COLUMN IF NOT EXISTS fingerprint TEXT`,
    `ALTER TABLE backtest_datasets ADD COLUMN IF NOT EXISTS schema_version TEXT`,
    `ALTER TABLE backtest_datasets ADD COLUMN IF NOT EXISTS manifest_json JSONB`,
    `ALTER TABLE backtest_datasets ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`,
    `ALTER TABLE backtest_candles_1m ADD COLUMN IF NOT EXISTS open_ticks TEXT`,
    `ALTER TABLE backtest_candles_1m ADD COLUMN IF NOT EXISTS high_ticks TEXT`,
    `ALTER TABLE backtest_candles_1m ADD COLUMN IF NOT EXISTS low_ticks TEXT`,
    `ALTER TABLE backtest_candles_1m ADD COLUMN IF NOT EXISTS close_ticks TEXT`,
    `ALTER TABLE backtest_candles_1m ADD COLUMN IF NOT EXISTS volume_units TEXT`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS exchange TEXT`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS currency TEXT`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS expiry TIMESTAMPTZ`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS roll_at TIMESTAMPTZ`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS multiplier TEXT`,
    `ALTER TABLE backtest_futures_contracts ADD COLUMN IF NOT EXISTS min_tick TEXT`,
  ]) await client.query(statement);

  for (const table of ["backtest_candles_1m", "backtest_candles_5m", "backtest_candles_1h", "backtest_candles_4h", "backtest_candles_12h", "backtest_candles_1d", "backtest_candles_1w"]) {
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
    await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (symbol, conid, ts)`);
  }
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS backtest_datasets_provenance_idx ON backtest_datasets (provenance_id) WHERE provenance_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS backtest_datasets_fingerprint_idx ON backtest_datasets (fingerprint) WHERE fingerprint IS NOT NULL`);
}

async function assertEmptyResearchContent(client: PoolClient): Promise<void> {
  for (const table of ["backtest_datasets", "backtest_candles_1m", "backtest_candles_5m", "backtest_candles_1h", "backtest_candles_4h", "backtest_candles_12h", "backtest_candles_1d", "backtest_candles_1w", "backtest_fx_rates", "backtest_instrument_contracts", "backtest_futures_contracts"]) {
    const result = await client.query(`SELECT EXISTS (SELECT 1 FROM ${table}) AS populated`);
    if (result.rows[0]?.populated) throw new Error(`Research database is not empty: ${table}`);
  }
}

async function insertCandles(
  client: PoolClient,
  manifest: ResearchDatasetManifest,
  candles: readonly ResearchDatasetCandle[],
): Promise<void> {
  const minTickByConId = new Map(manifest.contracts.map((contract) => [contract.conId, contract.minTick]));
  for (let offset = 0; offset < candles.length; offset += 500) {
    const chunk = candles.slice(offset, offset + 500);
    const values: unknown[] = [];
    const placeholders = chunk.map((candle, index) => {
      const base = index * 13;
      const minTick = minTickByConId.get(candle.conId);
      if (!minTick) throw new Error(`Missing minTick for ${candle.conId}`);
      values.push(candle.symbol, candle.conId, candle.ts,
        ticksToPrice(candle.openTicks, minTick), ticksToPrice(candle.highTicks, minTick),
        ticksToPrice(candle.lowTicks, minTick), ticksToPrice(candle.closeTicks, minTick),
        Number(candle.volume), candle.openTicks, candle.highTicks, candle.lowTicks,
        candle.closeTicks, candle.volume);
      return `(${Array.from({ length: 13 }, (_, valueIndex) => `$${base + valueIndex + 1}`).join(",")})`;
    });
    await client.query(`INSERT INTO backtest_candles_1m
      (symbol,conid,ts,open,high,low,close,volume,open_ticks,high_ticks,low_ticks,close_ticks,volume_units)
      VALUES ${placeholders.join(",")}`, values);
  }
}

async function rebuildResearchAggregates(client: PoolClient): Promise<void> {
  const targets = [
    ["backtest_candles_5m", 300, false], ["backtest_candles_1h", 3600, false],
    ["backtest_candles_4h", 14400, false], ["backtest_candles_12h", 43200, false],
    ["backtest_candles_1d", 0, false], ["backtest_candles_1w", 0, true],
  ] as const;
  for (const [table, seconds, weekly] of targets) {
    const bucket = weekly
      ? `((date_trunc('week', trade_date::timestamp) - interval '1 day' + interval '17 hours') AT TIME ZONE 'America/Chicago')`
      : seconds === 0
        ? "session_open"
        : `session_open + floor(extract(epoch FROM (ts - session_open)) / ${seconds}) * interval '1 second'`;
    await client.query(`INSERT INTO ${table} (symbol,conid,ts,open,high,low,close,volume)
      WITH localized AS (
        SELECT *, ts AT TIME ZONE 'America/Chicago' AS local_ts
        FROM backtest_candles_1m
      ), sessions AS (
        SELECT *, CASE WHEN local_ts::time >= time '17:00'
          THEN local_ts::date + 1 ELSE local_ts::date END AS trade_date
        FROM localized
      ), anchored AS (
        SELECT *, ((trade_date - 1 + time '17:00') AT TIME ZONE 'America/Chicago') AS session_open
        FROM sessions
      ), bucketed AS (
        SELECT *, ${bucket} AS bucket FROM anchored
      )
      SELECT symbol,conid,bucket,
        (array_agg(open ORDER BY ts ASC))[1], MAX(high), MIN(low),
        (array_agg(close ORDER BY ts DESC))[1], SUM(volume)
      FROM bucketed GROUP BY symbol,conid,bucket`);
  }
}

async function installImmutabilityGuards(client: PoolClient): Promise<void> {
  await client.query(`CREATE OR REPLACE FUNCTION reject_finalized_research_dataset_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM backtest_datasets WHERE finalized_at IS NOT NULL) THEN
        RAISE EXCEPTION 'finalized research dataset is immutable';
      END IF;
      RETURN NULL;
    END $$`);
  for (const table of ["backtest_datasets", "backtest_candles_1m", "backtest_candles_5m", "backtest_candles_1h", "backtest_candles_4h", "backtest_candles_12h", "backtest_candles_1d", "backtest_candles_1w", "backtest_fx_rates", "backtest_instrument_contracts", "backtest_futures_contracts"]) {
    await client.query(`DROP TRIGGER IF EXISTS ${table}_immutable_rows ON ${table}`);
    await client.query(`CREATE TRIGGER ${table}_immutable_rows BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_finalized_research_dataset_mutation()`);
    await client.query(`DROP TRIGGER IF EXISTS ${table}_immutable_truncate ON ${table}`);
    await client.query(`CREATE TRIGGER ${table}_immutable_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION reject_finalized_research_dataset_mutation()`);
  }
}

async function fingerprintReadBackDataset(client: PoolClient): Promise<string> {
  const datasetResult = await client.query(`SELECT manifest_json FROM backtest_datasets LIMIT 1`);
  const stored = datasetResult.rows[0]?.manifest_json as ResearchDatasetManifest | undefined;
  if (!stored) throw new Error("Imported manifest missing during read-back");
  const contractResult = await client.query(`SELECT conid,local_symbol,symbol,trading_class,last_trade_at,
    exchange,currency,expiry,valid_from,valid_to,roll_at,multiplier,min_tick
    FROM backtest_futures_contracts ORDER BY conid::numeric ASC`);
  const contracts = contractResult.rows.map((row) => ({
    conId: String(row.conid), localSymbol: String(row.local_symbol), symbol: String(row.symbol) as "ES",
    tradingClass: String(row.trading_class) as "ES", exchange: String(row.exchange) as "CME",
    currency: String(row.currency) as "USD",
    expiry: new Date(row.expiry).toISOString(), lastTradeAt: new Date(row.last_trade_at).toISOString(),
    validFrom: new Date(row.valid_from).toISOString(), validTo: new Date(row.valid_to).toISOString(),
    rollAt: row.roll_at ? new Date(row.roll_at).toISOString() : null,
    multiplier: String(row.multiplier) as "50", minTick: String(row.min_tick) as "0.25",
  }));
  const manifest = { ...stored, contracts };
  const builder = new ResearchDatasetFingerprintBuilder(manifest);
  await client.query(`DECLARE research_fingerprint_candles NO SCROLL CURSOR FOR
    SELECT symbol,conid,ts,open_ticks,high_ticks,low_ticks,close_ticks,volume_units
    FROM backtest_candles_1m ORDER BY ts ASC, conid::numeric ASC`);
  try {
    for (;;) {
      const rows: Array<Record<string, unknown>> =
        (await client.query("FETCH FORWARD 10000 FROM research_fingerprint_candles")).rows;
      if (rows.length === 0) break;
      for (const row of rows) {
        builder.updateCandle({
          symbol: String(row.symbol) as "ES", conId: String(row.conid),
          ts: new Date(String(row.ts)).toISOString(),
          openTicks: String(row.open_ticks), highTicks: String(row.high_ticks),
          lowTicks: String(row.low_ticks), closeTicks: String(row.close_ticks),
          volume: String(row.volume_units),
        });
      }
    }
  } finally {
    await client.query("CLOSE research_fingerprint_candles");
  }
  return builder.digest();
}

export async function importResearchDataset(
  targetUrl: string,
  adminUrl: string,
  bundleDirectory: string,
  calendars: ReadonlyMap<string, CmeCalendarDefinition>,
): Promise<ResearchDatasetImportResult> {
  assertResearchDatabaseUrl(targetUrl);
  const manifest = await loadResearchManifest(bundleDirectory, calendars);
  const candlePath = `${bundleDirectory}/candles-1m.ndjson`;
  const preflight = await scanCandleFile(candlePath, manifest, calendars);
  await ensureBacktestDatabase(adminUrl, targetUrl);
  await assertServerIdentity(targetUrl);
  const baseRepository = new BacktestRepository(targetUrl);
  try {
    await baseRepository.init();
  } finally {
    await baseRepository.close();
  }

  const pool = new Pool({ connectionString: targetUrl, max: 1, options: "-c search_path=public" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(15503)");
    await client.query(`LOCK TABLE backtest_datasets, backtest_candles_1m,
      backtest_candles_5m, backtest_candles_1h, backtest_candles_4h,
      backtest_candles_12h, backtest_candles_1d, backtest_candles_1w,
      backtest_fx_rates, backtest_instrument_contracts,
      backtest_futures_contracts IN ACCESS EXCLUSIVE MODE`);
    await assertEmptyResearchContent(client);
    await initializeResearchSchema(client);
    const datasetResult = await client.query(`INSERT INTO backtest_datasets
      (date_from,date_to,status,symbols,candles_count,provenance_id,schema_version,manifest_json)
      VALUES ($1,$2,'importing',ARRAY['ES'],0,$3,$4,$5) RETURNING id`,
      [manifest.dateFrom, manifest.dateTo, manifest.provenanceId, manifest.schemaVersion, manifest]);
    const datasetId = Number(datasetResult.rows[0].id);
    for (const contract of manifest.contracts) {
      await client.query(`INSERT INTO backtest_futures_contracts
        (conid,symbol,local_symbol,trading_class,last_trade_at,exchange,currency,expiry,
         valid_from,valid_to,roll_at,multiplier,min_tick)
        VALUES ($1,'ES',$2,'ES',$3,'CME','USD',$4,$5,$6,$7,'50','0.25')`,
        [contract.conId, contract.localSymbol, contract.lastTradeAt, contract.expiry,
          contract.validFrom, contract.validTo, contract.rollAt]);
    }
    const firstContract = manifest.contracts[0];
    await client.query(`INSERT INTO backtest_instrument_contracts
      (symbol,conid,sec_type,exchange,currency,local_symbol,trading_class,min_tick,source)
      VALUES ('ES',$1,'FUT','CME','USD',$2,'ES',0.25,'research-manifest')`,
      [firstContract.conId, firstContract.localSymbol]);
    const imported = await scanCandleFile(candlePath, manifest, calendars, (batch) =>
      insertCandles(client, manifest, batch));
    if (imported.fingerprint !== preflight.fingerprint || imported.candlesCount !== preflight.candlesCount)
      throw new Error("Research source changed after preflight");
    await rebuildResearchAggregates(client);
    const actualFingerprint = await fingerprintReadBackDataset(client);
    if (actualFingerprint !== preflight.fingerprint)
      throw new Error("PostgreSQL read-back fingerprint mismatch");
    await installImmutabilityGuards(client);
    await client.query(`UPDATE backtest_datasets SET status='ready', candles_count=$2,
      fingerprint=$3, finished_at=NOW(), finalized_at=NOW() WHERE id=$1`,
      [datasetId, preflight.candlesCount, preflight.fingerprint]);
    await client.query("COMMIT");
    return { datasetId, provenanceId: manifest.provenanceId, fingerprint: preflight.fingerprint, candlesCount: preflight.candlesCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
