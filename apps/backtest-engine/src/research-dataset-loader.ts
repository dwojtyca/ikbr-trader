import { Pool, type PoolClient, type QueryResult } from "pg";
import { withBuiltInResearchCalendar } from "./cme-equity-index-calendar.js";
import { ResearchDatasetFingerprintBuilder } from "./research-dataset-fingerprint.js";
import {
  assertResearchDatabaseUrl,
  parseResearchManifest,
  RESEARCH_DATABASE_NAME,
  type ResearchDatasetManifest,
} from "./research-dataset-schema.js";
import { REGISTERED_ES_EXPERIMENT_SPEC } from "./research-run-request.js";

export interface ResearchDatasetIdentityRequest {
  provenanceId: string;
  datasetFingerprint: string;
}

export interface ResearchDatasetQueryPort {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  readBackFingerprint?(manifest: ResearchDatasetManifest): Promise<{
    fingerprint: string;
    candlesCount: number;
  }>;
}

export interface LoadedResearchDatasetIdentity {
  datasetId: number;
  provenanceId: string;
  fingerprint: string;
  candlesCount: number;
  manifest: ReturnType<typeof parseResearchManifest>;
}

async function readBackFingerprint(
  client: PoolClient,
  storedManifest: ResearchDatasetManifest,
): Promise<{ fingerprint: string; candlesCount: number }> {
  const contractResult = await client.query(`SELECT conid,local_symbol,symbol,trading_class,last_trade_at,
    exchange,currency,expiry,valid_from,valid_to,roll_at,multiplier,min_tick
    FROM backtest_futures_contracts ORDER BY conid::numeric ASC`);
  const contracts = contractResult.rows.map((row) => ({
    conId: String(row.conid), localSymbol: String(row.local_symbol), symbol: String(row.symbol) as "ES",
    tradingClass: String(row.trading_class) as "ES", exchange: String(row.exchange) as "CME",
    currency: String(row.currency) as "USD", expiry: new Date(row.expiry).toISOString(),
    lastTradeAt: new Date(row.last_trade_at).toISOString(), validFrom: new Date(row.valid_from).toISOString(),
    validTo: new Date(row.valid_to).toISOString(), rollAt: row.roll_at ? new Date(row.roll_at).toISOString() : null,
    multiplier: String(row.multiplier) as "50", minTick: String(row.min_tick) as "0.25",
  }));
  const manifest = parseResearchManifest(
    { ...storedManifest, contracts },
    withBuiltInResearchCalendar(new Map()),
  );
  const builder = new ResearchDatasetFingerprintBuilder(manifest);
  let candlesCount = 0;
  await client.query("BEGIN READ ONLY");
  try {
    await client.query(`DECLARE research_experiment_fingerprint NO SCROLL CURSOR FOR
      SELECT symbol,conid,ts,open_ticks,high_ticks,low_ticks,close_ticks,volume_units
      FROM backtest_candles_1m ORDER BY ts ASC,conid::numeric ASC`);
    for (;;) {
      const rows = (await client.query("FETCH FORWARD 10000 FROM research_experiment_fingerprint")).rows;
      if (rows.length === 0) break;
      candlesCount += rows.length;
      for (const row of rows) builder.updateCandle({
        symbol: String(row.symbol) as "ES", conId: String(row.conid),
        ts: new Date(row.ts).toISOString(), openTicks: String(row.open_ticks),
        highTicks: String(row.high_ticks), lowTicks: String(row.low_ticks),
        closeTicks: String(row.close_ticks), volume: String(row.volume_units),
      });
    }
    await client.query("CLOSE research_experiment_fingerprint");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { fingerprint: builder.digest(), candlesCount };
}

export async function loadRegisteredResearchDataset(
  connectionString: string,
  request: ResearchDatasetIdentityRequest,
  injectedPort?: ResearchDatasetQueryPort,
): Promise<LoadedResearchDatasetIdentity> {
  assertResearchDatabaseUrl(connectionString);
  const pool = injectedPort ? undefined : new Pool({ connectionString, max: 1, options: "-c search_path=public" });
  const port = injectedPort ?? pool!;
  try {
    const identity = await port.query(`SELECT current_database() AS database,
      current_schema() AS schema,
      array_to_json(current_schemas(false)) AS schemas`);
    const server = identity.rows[0];
    const schemas = Array.isArray(server?.schemas) ? server.schemas.map(String) : [];
    if (server?.database !== RESEARCH_DATABASE_NAME || server?.schema !== "public" ||
      schemas.length !== 1 || schemas[0] !== "public")
      throw new Error("Research database server identity or search_path mismatch");

    const result = await port.query(`SELECT id,status,finalized_at,provenance_id,fingerprint,
      candles_count,manifest_json FROM backtest_datasets`);
    if (result.rowCount !== 1)
      throw new Error(`Expected exactly one finalized research dataset; received ${result.rowCount ?? 0}`);
    const row = result.rows[0];
    if (row.status !== "ready" || !row.finalized_at)
      throw new Error("Research dataset is not finalized and ready");
    if (row.provenance_id !== request.provenanceId || row.fingerprint !== request.datasetFingerprint)
      throw new Error("Research dataset durable identity mismatch");

    const calendars = withBuiltInResearchCalendar(new Map());
    const manifest = parseResearchManifest(row.manifest_json, calendars);
    const registered = REGISTERED_ES_EXPERIMENT_SPEC.dataset;
    if (manifest.provenanceId !== registered.provenanceId ||
      manifest.source.candlesSha256 !== registered.candlesSha256 ||
      manifest.dateFrom !== registered.dateFrom || manifest.dateTo !== registered.dateTo ||
      manifest.instrument !== registered.symbol)
      throw new Error("Research dataset manifest does not match the registered experiment");
    if (manifest.rollPolicy.version !== registered.rollPolicyVersion ||
      manifest.sessionPolicy.calendarVersion !== registered.calendarVersion)
      throw new Error("Research dataset roll policy mismatch");
    const contractIdentity = manifest.contracts.map((contract) => ({
      conId: contract.conId,
      localSymbol: contract.localSymbol,
      validFrom: contract.validFrom,
      validTo: contract.validTo,
      rollAt: contract.rollAt,
      lastTradeAt: contract.lastTradeAt,
    }));
    if (JSON.stringify(contractIdentity) !== JSON.stringify(registered.contracts))
      throw new Error("Research dataset contract identity mismatch");

    let readBack: { fingerprint: string; candlesCount: number };
    if (injectedPort?.readBackFingerprint) {
      readBack = await injectedPort.readBackFingerprint(manifest);
    } else if (injectedPort) {
      readBack = { fingerprint: String(row.fingerprint), candlesCount: Number(row.candles_count) };
    } else {
      const client = await pool!.connect();
      try { readBack = await readBackFingerprint(client, manifest); }
      finally { client.release(); }
    }
    if (readBack.fingerprint !== request.datasetFingerprint ||
      readBack.fingerprint !== row.fingerprint ||
      readBack.candlesCount !== Number(row.candles_count))
      throw new Error("Research dataset PostgreSQL read-back fingerprint mismatch");

    return {
      datasetId: Number(row.id),
      provenanceId: String(row.provenance_id),
      fingerprint: String(row.fingerprint),
      candlesCount: Number(row.candles_count),
      manifest,
    };
  } finally {
    await pool?.end();
  }
}
