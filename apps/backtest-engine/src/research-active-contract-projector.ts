import { createHash } from "node:crypto";
import type { Candle } from "@ikbr/shared";
import { Pool } from "pg";
import {
  aggregateCmeFuturesCandles,
  CmeSessionCalendar,
  type CmeAggregateTimeframe,
} from "./cme-session-calendar.js";
import { withBuiltInResearchCalendar } from "./cme-equity-index-calendar.js";
import type { LoadedResearchDatasetIdentity } from "./research-dataset-loader.js";
import { assertResearchDatabaseUrl } from "./research-dataset-schema.js";
import type { LoadedBacktestData } from "./types.js";

const TIMEFRAMES = ["5m", "1h", "4h", "12h", "1d", "1w"] as const;

export interface ProjectionContractEvidence {
  conId: string;
  count: number;
  firstTs: string;
  lastTs: string;
}

export interface HigherTimeframeContractEvidence {
  conId: string;
  count: number;
  firstBucketStart: string;
  firstCompletedAt: string;
  lastBucketStart: string;
  lastCompletedAt: string;
}

export interface HigherTimeframeEvidence {
  timeframe: CmeAggregateTimeframe;
  count: number;
  sha256: string;
  contracts: readonly HigherTimeframeContractEvidence[];
}

export interface ResearchActiveProjectionEvidence {
  algorithmVersion: "research-active-contract-projection-v1";
  rawRows: number;
  expectedActiveMinutes: number;
  selectedRows: number;
  missingActiveMinutes: number;
  maximumConsecutiveGap: number;
  entirelyMissingSessions: number;
  inactiveOnlyRawTimestamps: readonly string[];
  activeSeriesSha256: string;
  contracts: readonly ProjectionContractEvidence[];
  higherTimeframes: readonly HigherTimeframeEvidence[];
}

export interface ResearchActiveProjection {
  data: LoadedBacktestData;
  evidence: ResearchActiveProjectionEvidence;
}

function iso(value: Date): string {
  return value.toISOString();
}

function canonicalActiveLine(row: {
  symbol: string;
  conId: string;
  ts: string;
  openTicks: string;
  highTicks: string;
  lowTicks: string;
  closeTicks: string;
  volumeUnits: string;
}): string {
  return [row.symbol, row.conId, row.ts, row.openTicks, row.highTicks,
    row.lowTicks, row.closeTicks, row.volumeUnits].join("\t") + "\n";
}

function canonicalHigherLine(
  timeframe: CmeAggregateTimeframe,
  candle: Candle,
  completedAt: Date,
  tickSize: number,
): string {
  const ticks = (value: number) => String(Math.round(value / tickSize));
  return [timeframe, candle.symbol, candle.conid, iso(candle.ts), iso(completedAt),
    ticks(candle.open), ticks(candle.high), ticks(candle.low), ticks(candle.close),
    String(candle.volume)].join("\t") + "\n";
}

function evidenceMismatch(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) !== JSON.stringify(expected);
}

export function assertResearchActiveProjectionEvidence(
  actual: ResearchActiveProjectionEvidence,
  expected: ResearchActiveProjectionEvidence,
): void {
  if (evidenceMismatch(actual, expected))
    throw new Error("Research active-contract projection identity mismatch");
}

export async function loadResearchActiveContractProjection(
  connectionString: string,
  identity: LoadedResearchDatasetIdentity,
  expected?: ResearchActiveProjectionEvidence,
): Promise<ResearchActiveProjection> {
  assertResearchDatabaseUrl(connectionString);
  const pool = new Pool({ connectionString, max: 1, options: "-c search_path=public" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const datasetResult = await client.query(`SELECT id,status,date_from,date_to,symbols,candles_count,
      started_at,finished_at,error,fingerprint FROM backtest_datasets WHERE id=$1`, [identity.datasetId]);
    const datasetRow = datasetResult.rows[0];
    if (datasetResult.rowCount !== 1 || datasetRow.status !== "ready" ||
      datasetRow.fingerprint !== identity.fingerprint)
      throw new Error("Research dataset changed before active-contract projection");

    const rawResult = await client.query("SELECT COUNT(*) AS count FROM backtest_candles_1m WHERE symbol='ES'");
    const rawRows = Number(rawResult.rows[0]?.count ?? 0);
    const contracts = identity.manifest.contracts;
    const contractById = new Map(contracts.map((contract) => [contract.conId, contract]));
    const tickSizeById = new Map(contracts.map((contract) => [contract.conId, Number(contract.minTick)]));
    const activeHasher = createHash("sha256");
    const candles: Candle[] = [];
    const activeTimestampSet = new Set<number>();
    const stats = new Map<string, { count: number; firstTs: string; lastTs: string }>();
    let previousTs = -Infinity;
    let previousConId: string | undefined;
    const seenContracts = new Set<string>();

    await client.query(`DECLARE research_active_projection NO SCROLL CURSOR FOR
      SELECT c.symbol,c.conid,c.ts,c.open_ticks,c.high_ticks,c.low_ticks,c.close_ticks,c.volume_units
      FROM backtest_candles_1m c
      JOIN backtest_futures_contracts f ON f.conid=c.conid
       AND c.ts >= f.valid_from AND c.ts <= f.valid_to
      WHERE c.symbol='ES'
      ORDER BY c.ts ASC,c.conid::numeric ASC`);
    for (;;) {
      const page = await client.query("FETCH FORWARD 10000 FROM research_active_projection");
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        const conId = String(row.conid);
        const contract = contractById.get(conId);
        const tickSize = tickSizeById.get(conId);
        if (!contract || !tickSize) throw new Error(`Unknown projected futures conId ${conId}`);
        const ts = new Date(row.ts);
        const tsMs = ts.getTime();
        if (tsMs <= previousTs) throw new Error("Projected futures timestamps are not strictly increasing");
        if (ts < new Date(contract.validFrom) || ts > new Date(contract.validTo))
          throw new Error(`Projected candle is outside validity for conId ${conId}`);
        if (ts >= new Date(contract.lastTradeAt))
          throw new Error(`Projected candle is at or after last trade for conId ${conId}`);
        if (previousConId !== conId) {
          if (seenContracts.has(conId)) throw new Error(`Projected retired conId ${conId} reappeared`);
          const expectedContract = contracts[seenContracts.size];
          if (expectedContract?.conId !== conId)
            throw new Error(`Unexpected projected contract transition to ${conId}`);
          if (iso(ts) !== expectedContract.validFrom)
            throw new Error(`Projected contract ${conId} did not start at registered validFrom`);
          seenContracts.add(conId);
          previousConId = conId;
        }
        previousTs = tsMs;
        activeTimestampSet.add(tsMs);
        const openTicks = String(row.open_ticks);
        const highTicks = String(row.high_ticks);
        const lowTicks = String(row.low_ticks);
        const closeTicks = String(row.close_ticks);
        const volumeUnits = String(row.volume_units);
        if (BigInt(lowTicks) > BigInt(openTicks) || BigInt(lowTicks) > BigInt(closeTicks) ||
          BigInt(highTicks) < BigInt(openTicks) || BigInt(highTicks) < BigInt(closeTicks))
          throw new Error(`Projected candle violates OHLC for conId ${conId}`);
        const rowIso = iso(ts);
        activeHasher.update(canonicalActiveLine({
          symbol: String(row.symbol), conId, ts: rowIso, openTicks, highTicks,
          lowTicks, closeTicks, volumeUnits,
        }));
        candles.push({
          symbol: String(row.symbol), conid: conId, timeframe: "1m", ts,
          open: Number(openTicks) * tickSize, high: Number(highTicks) * tickSize,
          low: Number(lowTicks) * tickSize, close: Number(closeTicks) * tickSize,
          volume: Number(volumeUnits),
        });
        const stat = stats.get(conId) ?? { count: 0, firstTs: rowIso, lastTs: rowIso };
        stat.count += 1;
        stat.lastTs = rowIso;
        stats.set(conId, stat);
      }
    }
    await client.query("CLOSE research_active_projection");
    if (seenContracts.size !== contracts.length)
      throw new Error("Projected series does not contain every registered contract");

    const calendars = withBuiltInResearchCalendar(new Map());
    const definition = calendars.get(identity.manifest.sessionPolicy.calendarVersion);
    if (!definition) throw new Error("Registered CME calendar is unavailable");
    const calendar = new CmeSessionCalendar(definition);
    let expectedActiveMinutes = 0;
    let missingActiveMinutes = 0;
    let currentGap = 0;
    let maximumConsecutiveGap = 0;
    const sessionExpected = new Map<string, number>();
    const sessionActual = new Map<string, number>();
    const from = new Date(identity.manifest.dateFrom).getTime();
    const to = new Date(identity.manifest.dateTo).getTime();
    for (let time = from; time <= to; time += 60_000) {
      const session = calendar.sessionFor(new Date(time));
      if (!session) { currentGap = 0; continue; }
      expectedActiveMinutes += 1;
      sessionExpected.set(session.id, (sessionExpected.get(session.id) ?? 0) + 1);
      if (activeTimestampSet.has(time)) {
        currentGap = 0;
        sessionActual.set(session.id, (sessionActual.get(session.id) ?? 0) + 1);
      } else {
        missingActiveMinutes += 1;
        currentGap += 1;
        maximumConsecutiveGap = Math.max(maximumConsecutiveGap, currentGap);
      }
    }
    const entirelyMissingSessions = [...sessionExpected]
      .filter(([id, count]) => count > 0 && (sessionActual.get(id) ?? 0) === 0).length;

    const inactiveOnly = await client.query(`WITH raw_ts AS (
        SELECT DISTINCT ts FROM backtest_candles_1m WHERE symbol='ES'
      ), active_ts AS (
        SELECT DISTINCT c.ts FROM backtest_candles_1m c
        JOIN backtest_futures_contracts f ON f.conid=c.conid
          AND c.ts >= f.valid_from AND c.ts <= f.valid_to
        WHERE c.symbol='ES'
      )
      SELECT raw_ts.ts FROM raw_ts LEFT JOIN active_ts USING(ts)
      WHERE active_ts.ts IS NULL ORDER BY raw_ts.ts`);
    const inactiveOnlyRawTimestamps = inactiveOnly.rows.map((row) => iso(new Date(row.ts)));

    const higherMaps = new Map<CmeAggregateTimeframe, Candle[]>();
    const higherTimeframes: HigherTimeframeEvidence[] = [];
    for (const timeframe of TIMEFRAMES) {
      const rows = aggregateCmeFuturesCandles(candles, timeframe, calendar);
      higherMaps.set(timeframe, rows);
      const hasher = createHash("sha256");
      const byContract = new Map<string, {
        count: number;
        firstBucketStart: string;
        firstCompletedAt: string;
        lastBucketStart: string;
        lastCompletedAt: string;
      }>();
      for (const candle of rows) {
        const completedAt = calendar.completedAt(candle.ts, timeframe);
        const tickSize = tickSizeById.get(candle.conid);
        if (!tickSize) throw new Error(`Missing tick size for projected conId ${candle.conid}`);
        hasher.update(canonicalHigherLine(timeframe, candle, completedAt, tickSize));
        const bucketStart = iso(candle.ts);
        const completed = iso(completedAt);
        const stat = byContract.get(candle.conid) ?? {
          count: 0, firstBucketStart: bucketStart, firstCompletedAt: completed,
          lastBucketStart: bucketStart, lastCompletedAt: completed,
        };
        stat.count += 1;
        stat.lastBucketStart = bucketStart;
        stat.lastCompletedAt = completed;
        byContract.set(candle.conid, stat);
      }
      higherTimeframes.push({
        timeframe,
        count: rows.length,
        sha256: hasher.digest("hex"),
        contracts: contracts.map((contract) => ({
          conId: contract.conId,
          ...(byContract.get(contract.conId) ?? (() => {
            throw new Error(`No ${timeframe} projection for conId ${contract.conId}`);
          })()),
        })),
      });
    }

    const evidence: ResearchActiveProjectionEvidence = {
      algorithmVersion: "research-active-contract-projection-v1",
      rawRows,
      expectedActiveMinutes,
      selectedRows: candles.length,
      missingActiveMinutes,
      maximumConsecutiveGap,
      entirelyMissingSessions,
      inactiveOnlyRawTimestamps,
      activeSeriesSha256: activeHasher.digest("hex"),
      contracts: contracts.map((contract) => ({
        conId: contract.conId,
        ...(stats.get(contract.conId) ?? (() => {
          throw new Error(`No active projection rows for conId ${contract.conId}`);
        })()),
      })),
      higherTimeframes,
    };
    if (expected) assertResearchActiveProjectionEvidence(evidence, expected);

    const mapFor = (timeframe: CmeAggregateTimeframe) =>
      new Map([["ES", higherMaps.get(timeframe) ?? []]]);
    const data: LoadedBacktestData = {
      dataset: {
        id: Number(datasetRow.id), dateFrom: new Date(datasetRow.date_from).toISOString(),
        dateTo: new Date(datasetRow.date_to).toISOString(), status: String(datasetRow.status),
        symbols: Array.isArray(datasetRow.symbols) ? datasetRow.symbols.map(String) : ["ES"],
        candlesCount: candles.length, startedAt: new Date(datasetRow.started_at).toISOString(),
        finishedAt: datasetRow.finished_at ? new Date(datasetRow.finished_at).toISOString() : undefined,
        error: datasetRow.error ?? undefined,
      },
      candles1m: new Map([["ES", candles]]),
      candles5m: mapFor("5m"), candles1h: mapFor("1h"), candles4h: mapFor("4h"),
      candles12h: mapFor("12h"), candles1d: mapFor("1d"), candles1w: mapFor("1w"),
      candleCount1m: candles.length,
      fxRates: [],
    };
    await client.query("COMMIT");
    return { data, evidence };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
