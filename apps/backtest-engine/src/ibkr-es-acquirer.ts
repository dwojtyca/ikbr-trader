import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertExactIbkrEsContract,
  buildExactIbkrEsHistoricalContract,
  IBKR_ES_BAR_REQUEST,
  IBKR_ES_BAR_SOURCE_VERSION,
  type Candle,
} from "@ikbr/shared";
import { chicagoWallToUtc, CmeSessionCalendar, type CmeCalendarDefinition } from "./cme-session-calendar.js";
import type {
  ExactIbkrEsContractInventory,
  InstrumentSubscription,
} from "./historical-client.js";
import {
  IBKR_ES_ACQUISITION_SPEC_VERSION,
  IBKR_ES_CALENDAR_VERSION,
  IBKR_ES_LOCAL_SYMBOLS,
  IBKR_ES_ROLL_POLICY_VERSION,
  IBKR_ES_TARGET_FROM,
  IBKR_ES_TARGET_TO,
  acquisitionSpecSha256,
  estimateHistoricalRequests,
  parseIbkrEsAcquisitionSpec,
  type IbkrEsAcquisitionContract,
  type IbkrEsAcquisitionSpec,
} from "./ibkr-es-acquisition-spec.js";
import {
  parseResearchCandles,
  parseResearchManifest,
  RESEARCH_DATASET_SCHEMA_VERSION,
  type ResearchDatasetManifest,
} from "./research-dataset-schema.js";

export interface IbkrEsInventoryPort {
  resolveExactExpiredEsContract(localSymbol: string): Promise<ExactIbkrEsContractInventory>;
  getServerVersion(): number;
}

export interface IbkrHistoricalChunkPort {
  fetchExactHistorical1mChunk(
    sub: InstrumentSubscription,
    end: Date,
    durationStr: string,
  ): Promise<Candle[]>;
}

export interface ResearchCandleRow {
  symbol: "ES";
  conId: string;
  ts: string;
  openTicks: string;
  highTicks: string;
  lowTicks: string;
  closeTicks: string;
  volume: string;
}

export interface AcquisitionChunkPlan {
  readonly index: number;
  readonly conId: number;
  readonly localSymbol: string;
  readonly from: string;
  readonly to: string;
  readonly endDateTime: string;
  readonly durationStr: string;
}

export interface IbkrEsAcquisitionResult {
  readonly bundleDirectory: string;
  readonly provenanceId: string;
  readonly candlesCount: number;
  readonly candlesSha256: string;
  readonly completeness: number;
  readonly rollTransitions: readonly string[];
}

function dateId(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function lastTradeAt(inventory: ExactIbkrEsContractInventory): string {
  return chicagoWallToUtc(dateId(inventory.expiryDate), "08:30").toISOString();
}

export async function buildIbkrEsInventorySpec(
  port: IbkrEsInventoryPort,
  now = new Date(),
): Promise<IbkrEsAcquisitionSpec> {
  const inventory: ExactIbkrEsContractInventory[] = [];
  for (const localSymbol of IBKR_ES_LOCAL_SYMBOLS) {
    const result = await port.resolveExactExpiredEsContract(localSymbol);
    assertExactIbkrEsContract(result, localSymbol);
    inventory.push(result);
  }
  const contracts: IbkrEsAcquisitionContract[] = inventory.map((item, index) => {
    const previous = inventory[index - 1];
    const overlapFrom = previous
      ? new Date(lastTradeAt(previous)).getTime() - 15 * 86_400_000
      : new Date(IBKR_ES_TARGET_FROM).getTime();
    const from = new Date(Math.max(new Date(IBKR_ES_TARGET_FROM).getTime(), overlapFrom)).toISOString();
    const to = new Date(Math.min(new Date(IBKR_ES_TARGET_TO).getTime(), new Date(lastTradeAt(item)).getTime())).toISOString();
    return {
      conId: item.conId,
      localSymbol: item.localSymbol as IbkrEsAcquisitionContract["localSymbol"],
      symbol: "ES",
      secType: "FUT",
      tradingClass: "ES",
      exchange: "CME",
      currency: "USD",
      multiplier: "50",
      minTick: 0.25,
      lastTradeDateOrContractMonth: item.lastTradeDateOrContractMonth,
      expiryDate: item.expiryDate,
      expiryDateSource: item.expiryDateSource,
      lastTradeRuleVersion: "cme-es-quarterly-termination-0830-ct-v1",
      lastTradeAt: lastTradeAt(item),
      fetchFrom: from,
      fetchTo: to,
    };
  });
  return parseIbkrEsAcquisitionSpec({
    schemaVersion: IBKR_ES_ACQUISITION_SPEC_VERSION,
    sourceVersion: IBKR_ES_BAR_SOURCE_VERSION,
    createdAt: now.toISOString(),
    target: { dateFrom: IBKR_ES_TARGET_FROM, dateTo: IBKR_ES_TARGET_TO },
    request: { ...IBKR_ES_BAR_REQUEST },
    rollPolicyVersion: IBKR_ES_ROLL_POLICY_VERSION,
    calendarVersion: IBKR_ES_CALENDAR_VERSION,
    pacing: { requestsPer10Minutes: 50, maxConcurrency: 2 },
    contracts,
    estimatedHistoricalRequests: estimateHistoricalRequests(contracts),
    ibApiServerVersion: port.getServerVersion(),
  });
}

function decimalParts(value: number): { numerator: bigint; scale: bigint } {
  if (!Number.isFinite(value)) throw new Error("Price must be finite");
  const raw = value.toString().toLowerCase();
  const [coefficient, exponentRaw] = raw.split("e");
  const exponent = exponentRaw ? Number(exponentRaw) : 0;
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole, fraction = ""] = unsigned.split(".");
  let numerator = BigInt(`${whole}${fraction}` || "0");
  let scale = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) scale *= 10n ** BigInt(-exponent);
  return { numerator: negative ? -numerator : numerator, scale };
}

export function priceToQuarterTicks(value: number): string {
  const { numerator, scale } = decimalParts(value);
  const scaled = numerator * 4n;
  if (scaled % scale !== 0n) throw new Error(`Price ${value} is off the ES 0.25 tick grid`);
  const ticks = scaled / scale;
  if (ticks > BigInt(Number.MAX_SAFE_INTEGER) || ticks < BigInt(Number.MIN_SAFE_INTEGER))
    throw new Error("Price ticks exceed exact storage range");
  return ticks.toString();
}

export function candleToResearchRow(candle: Candle): ResearchCandleRow {
  if (candle.symbol !== "ES" || !/^[1-9]\d*$/.test(candle.conid))
    throw new Error("Candle does not belong to an exact ES contract");
  if (candle.ts.getTime() % 60_000 !== 0) throw new Error("Candle timestamp is off the minute grid");
  if (!Number.isSafeInteger(candle.volume) || candle.volume < 0)
    throw new Error("Candle volume must be a non-negative safe integer");
  return {
    symbol: "ES", conId: candle.conid, ts: candle.ts.toISOString(),
    openTicks: priceToQuarterTicks(candle.open), highTicks: priceToQuarterTicks(candle.high),
    lowTicks: priceToQuarterTicks(candle.low), closeTicks: priceToQuarterTicks(candle.close),
    volume: String(candle.volume),
  };
}

export function mergeExactResearchRows(rows: readonly ResearchCandleRow[]): ResearchCandleRow[] {
  const found = new Map<string, ResearchCandleRow>();
  for (const row of rows) {
    const key = `${row.ts}|${row.conId}`;
    const previous = found.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      throw new Error(`Conflicting duplicate IBKR bar ${key}`);
    found.set(key, row);
  }
  return [...found.values()].sort((a, b) => a.ts.localeCompare(b.ts) || (BigInt(a.conId) < BigInt(b.conId) ? -1 : 1));
}

export function canonicalChunkChecksum(requestIdentity: unknown, rows: readonly ResearchCandleRow[]): string {
  const body = `${JSON.stringify({ request: requestIdentity })}\n${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  return createHash("sha256").update(body).digest("hex");
}

export function planAcquisitionChunks(
  contract: IbkrEsAcquisitionContract,
): AcquisitionChunkPlan[] {
  const dayMs = 86_400_000;
  const chunkMs = 5 * dayMs;
  const lower = new Date(contract.fetchFrom).getTime();
  let end = new Date(contract.fetchTo).getTime();
  const descending: AcquisitionChunkPlan[] = [];
  let index = 0;
  while (end >= lower) {
    const start = Math.max(lower, end - chunkMs + 60_000);
    const durationDays = Math.max(1, Math.ceil((end - start + 60_000) / dayMs));
    descending.push({
      index,
      conId: contract.conId,
      localSymbol: contract.localSymbol,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      endDateTime: new Date(end).toISOString(),
      durationStr: `${durationDays} D`,
    });
    index += 1;
    end = start - 60_000;
  }
  return descending;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
}

function nextSessionOpen(calendar: CmeSessionCalendar, after: Date): Date {
  for (let value = after.getTime(); value <= after.getTime() + 7 * 86_400_000; value += 60_000) {
    const candidate = new Date(value);
    const session = calendar.sessionFor(candidate);
    if (session && session.openAt.getTime() === value) return candidate;
  }
  throw new Error(`INCONCLUSIVE: no next CME session after ${after.toISOString()}`);
}

export function deriveVolumeRollContracts(
  spec: IbkrEsAcquisitionSpec,
  rows: readonly ResearchCandleRow[],
  calendar: CmeSessionCalendar,
): { contracts: ResearchDatasetManifest["contracts"]; transitions: string[] } {
  const volumes = new Map<string, Map<string, bigint>>();
  const sessions = new Map<string, { openAt: Date; closeAt: Date }>();
  for (const row of rows) {
    const session = calendar.sessionFor(new Date(row.ts));
    if (!session) throw new Error(`IBKR returned a closed-session bar ${row.ts}`);
    sessions.set(session.id, session);
    const bySession = volumes.get(row.conId) ?? new Map<string, bigint>();
    bySession.set(session.id, (bySession.get(session.id) ?? 0n) + BigInt(row.volume));
    volumes.set(row.conId, bySession);
  }

  const rollAt: Array<string | null> = [];
  const transitions: string[] = [];
  for (let index = 0; index < spec.contracts.length - 1; index += 1) {
    const outgoing = spec.contracts[index];
    const incoming = spec.contracts[index + 1];
    const outgoingVolumes = volumes.get(String(outgoing.conId));
    const incomingVolumes = volumes.get(String(incoming.conId));
    if (!outgoingVolumes || !incomingVolumes)
      throw new Error(`INCONCLUSIVE: missing volume history for ${outgoing.localSymbol}/${incoming.localSymbol}`);
    const windowStart = new Date(outgoing.lastTradeAt).getTime() - 15 * 86_400_000;
    const eligible = [...sessions.entries()]
      .filter(([, session]) => session.openAt.getTime() >= windowStart && session.closeAt.getTime() <= new Date(outgoing.lastTradeAt).getTime())
      .sort((a, b) => a[1].openAt.getTime() - b[1].openAt.getTime());
    if (eligible.length === 0)
      throw new Error(`INCONCLUSIVE: no completed sessions before ${outgoing.localSymbol} expiry`);
    const crossover = eligible.find(([id, session]) =>
      session.closeAt <= new Date(outgoing.lastTradeAt) && outgoingVolumes.has(id) && incomingVolumes.has(id) &&
      incomingVolumes.get(id)! > outgoingVolumes.get(id)!);
    if (!crossover)
      throw new Error(`INCONCLUSIVE: no timely volume crossover ${outgoing.localSymbol}->${incoming.localSymbol}`);
    const nextOpen = nextSessionOpen(calendar, crossover[1].closeAt).toISOString();
    rollAt.push(nextOpen);
    transitions.push(`${outgoing.localSymbol}->${incoming.localSymbol}@${nextOpen}`);
  }
  rollAt.push(null);

  const contracts = spec.contracts.map((contract, index) => {
    const validFrom = index === 0 ? spec.target.dateFrom : rollAt[index - 1]!;
    const validTo = index === spec.contracts.length - 1
      ? spec.target.dateTo
      : new Date(new Date(rollAt[index]!).getTime() - 60_000).toISOString();
    return {
      conId: String(contract.conId), localSymbol: contract.localSymbol,
      symbol: "ES" as const, tradingClass: "ES" as const,
      exchange: "CME" as const, currency: "USD" as const,
      expiry: contract.lastTradeAt, lastTradeAt: contract.lastTradeAt,
      validFrom, validTo, rollAt: rollAt[index],
      multiplier: "50" as const, minTick: "0.25" as const,
    };
  });
  return { contracts, transitions };
}

function assertCoverage(
  spec: IbkrEsAcquisitionSpec,
  rows: readonly ResearchCandleRow[],
  contracts: ResearchDatasetManifest["contracts"],
  calendar: CmeSessionCalendar,
): number {
  const present = new Set(rows.map((row) => `${row.conId}|${row.ts}`));
  const sessionExpected = new Map<string, number>();
  const sessionActual = new Map<string, number>();
  let expected = 0;
  let actual = 0;
  let missingRun = 0;
  let maxMissingRun = 0;
  let contractIndex = 0;
  for (let time = new Date(spec.target.dateFrom).getTime(); time <= new Date(spec.target.dateTo).getTime(); time += 60_000) {
    const timestamp = new Date(time);
    const session = calendar.sessionFor(timestamp);
    if (!session) { missingRun = 0; continue; }
    while (contractIndex < contracts.length - 1 && timestamp.toISOString() > contracts[contractIndex].validTo)
      contractIndex += 1;
    const contract = contracts[contractIndex];
    expected += 1;
    sessionExpected.set(session.id, (sessionExpected.get(session.id) ?? 0) + 1);
    if (present.has(`${contract.conId}|${timestamp.toISOString()}`)) {
      actual += 1;
      sessionActual.set(session.id, (sessionActual.get(session.id) ?? 0) + 1);
      missingRun = 0;
    } else {
      missingRun += 1;
      maxMissingRun = Math.max(maxMissingRun, missingRun);
    }
  }
  for (const [id, count] of sessionExpected) {
    if (count > 0 && (sessionActual.get(id) ?? 0) === 0)
      throw new Error(`INCONCLUSIVE: entirely missing selected-contract CME session ${id}`);
  }
  const completeness = expected === 0 ? 0 : actual / expected;
  if (completeness < 0.999)
    throw new Error(`INCONCLUSIVE: selected-contract completeness ${(completeness * 100).toFixed(4)}% is below 99.9%`);
  if (maxMissingRun > 5)
    throw new Error(`INCONCLUSIVE: unexplained gap of ${maxMissingRun} consecutive open minutes`);
  return completeness;
}

export async function acquireApprovedIbkrEsDataset(
  spec: IbkrEsAcquisitionSpec,
  approvedSpecSha256: string,
  client: IbkrHistoricalChunkPort,
  calendarDefinition: CmeCalendarDefinition,
  workspaceDirectory: string,
  finalDirectory: string,
): Promise<IbkrEsAcquisitionResult> {
  const actualSpecSha256 = acquisitionSpecSha256(spec);
  if (approvedSpecSha256 !== actualSpecSha256)
    throw new Error("Approved specification SHA-256 mismatch");
  if (calendarDefinition.version !== spec.calendarVersion)
    throw new Error("Acquisition calendar does not match approved specification");
  if (await exists(finalDirectory)) throw new Error(`Refusing to overwrite finalized bundle ${finalDirectory}`);
  const work = path.join(workspaceDirectory, actualSpecSha256);
  const chunksDirectory = path.join(work, "chunks");
  await mkdir(chunksDirectory, { recursive: true });
  const allPlans = spec.contracts.flatMap(planAcquisitionChunks);
  if (allPlans.length !== spec.estimatedHistoricalRequests)
    throw new Error(`Planned ${allPlans.length} requests but approved specification requires ${spec.estimatedHistoricalRequests}`);

  const collected: ResearchCandleRow[] = [];
  let completed = 0;
  for (const contract of spec.contracts) {
    const subscription: InstrumentSubscription = {
      symbol: "ES",
      conid: String(contract.conId),
      contract: buildExactIbkrEsHistoricalContract({
        conId: contract.conId, localSymbol: contract.localSymbol,
        lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth,
        minTick: contract.minTick, symbol: contract.symbol, secType: contract.secType,
        tradingClass: contract.tradingClass, exchange: contract.exchange,
        currency: contract.currency, multiplier: contract.multiplier,
      }),
    };
    for (const plan of planAcquisitionChunks(contract)) {
      const identity = {
        specificationSha256: actualSpecSha256,
        conId: plan.conId,
        localSymbol: plan.localSymbol,
        from: plan.from,
        to: plan.to,
        endDateTime: plan.endDateTime,
        durationStr: plan.durationStr,
        request: spec.request,
      };
      const chunkPath = path.join(chunksDirectory, `${plan.conId}-${String(plan.index).padStart(3, "0")}.json`);
      let rows: ResearchCandleRow[];
      if (await exists(chunkPath)) {
        const saved = JSON.parse(await readFile(chunkPath, "utf8")) as {
          identity?: unknown; checksum?: unknown; rows?: unknown;
        };
        if (!sameJson(saved.identity, identity) || !Array.isArray(saved.rows) ||
            saved.checksum !== canonicalChunkChecksum(identity, saved.rows as ResearchCandleRow[]))
          throw new Error(`Invalid resumable chunk ${path.basename(chunkPath)}`);
        rows = mergeExactResearchRows(saved.rows as ResearchCandleRow[]);
      } else {
        const candles = await client.fetchExactHistorical1mChunk(
          subscription,
          new Date(plan.endDateTime),
          plan.durationStr,
        );
        rows = mergeExactResearchRows(candles
          .filter((candle) => candle.ts.toISOString() >= plan.from && candle.ts.toISOString() <= plan.to)
          .map(candleToResearchRow));
        const checksum = canonicalChunkChecksum(identity, rows);
        await writeAtomic(chunkPath, `${JSON.stringify({ identity, checksum, rows })}\n`);
      }
      collected.push(...rows);
      completed += 1;
      process.stdout.write(`Stage B chunk ${completed}/${allPlans.length} ${contract.localSymbol} ${plan.to} rows=${rows.length}\n`);
    }
  }

  const rows = mergeExactResearchRows(collected);
  const calendar = new CmeSessionCalendar(calendarDefinition);
  const { contracts, transitions } = deriveVolumeRollContracts(spec, rows, calendar);
  const completeness = assertCoverage(spec, rows, contracts, calendar);
  const candleBytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const candlesSha256 = createHash("sha256").update(candleBytes).digest("hex");
  const provenanceId = `ibkr-es-${spec.target.dateFrom.slice(0, 10).replaceAll("-", "")}-${spec.target.dateTo.slice(0, 10).replaceAll("-", "")}-${actualSpecSha256.slice(0, 12)}`;
  const manifest: ResearchDatasetManifest = {
    schemaVersion: RESEARCH_DATASET_SCHEMA_VERSION,
    provenanceId,
    instrument: "ES",
    timeframe: "1m",
    dateFrom: spec.target.dateFrom,
    dateTo: spec.target.dateTo,
    source: {
      provider: spec.request.provider,
      artifactId: actualSpecSha256,
      version: spec.sourceVersion,
      candlesSha256,
    },
    aggregationAlgorithmVersion: "research-cme-aggregate-v1",
    rollPolicy: {
      version: spec.rollPolicyVersion,
      contractOrder: contracts.map((contract) => contract.conId),
    },
    sessionPolicy: {
      template: "cme_equity_index",
      timezone: "America/Chicago",
      calendarVersion: spec.calendarVersion,
    },
    contracts,
  };
  const calendars = new Map([[calendarDefinition.version, calendarDefinition]]);
  parseResearchManifest(manifest, calendars);
  parseResearchCandles(candleBytes, manifest, calendars);

  await mkdir(path.dirname(finalDirectory), { recursive: true });
  const temporaryBundle = `${finalDirectory}.tmp-${process.pid}`;
  if (await exists(temporaryBundle)) throw new Error(`Temporary bundle already exists ${temporaryBundle}`);
  await mkdir(temporaryBundle);
  await writeFile(path.join(temporaryBundle, "candles-1m.ndjson"), candleBytes, { flag: "wx" });
  await writeFile(path.join(temporaryBundle, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryBundle, finalDirectory);
  return {
    bundleDirectory: finalDirectory,
    provenanceId,
    candlesCount: rows.length,
    candlesSha256,
    completeness,
    rollTransitions: transitions,
  };
}
