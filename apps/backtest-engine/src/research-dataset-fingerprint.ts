import { createHash } from "node:crypto";
import type {
  ResearchDatasetCandle,
  ResearchDatasetContract,
  ResearchDatasetManifest,
} from "./research-dataset-schema.js";

export const FINGERPRINT_HEADER = "IKBR-TRADER-ES-DATASET-FINGERPRINT-V1\n";

export class ResearchDatasetFingerprintBuilder {
  private readonly hash = createHash("sha256");
  private digested = false;

  constructor(manifest: ResearchDatasetManifest) {
    this.hash.update(FINGERPRINT_HEADER);
    this.hash.update(`${canonicalDatasetRecord(manifest)}\n`);
    const contracts = [...manifest.contracts].sort((a, b) =>
      BigInt(a.conId) < BigInt(b.conId) ? -1 : BigInt(a.conId) > BigInt(b.conId) ? 1 : 0,
    );
    for (const contract of contracts) this.hash.update(`${canonicalContractRecord(contract)}\n`);
  }

  updateCandle(candle: ResearchDatasetCandle): void {
    if (this.digested) throw new Error("Fingerprint builder is already finalized");
    this.hash.update(`${canonicalCandleRecord(candle)}\n`);
  }

  digest(): string {
    if (this.digested) throw new Error("Fingerprint builder is already finalized");
    this.digested = true;
    return this.hash.digest("hex");
  }
}

export function canonicalDatasetRecord(manifest: ResearchDatasetManifest): string {
  return JSON.stringify({
    type: "dataset",
    schemaVersion: manifest.schemaVersion,
    provenanceId: manifest.provenanceId,
    instrument: manifest.instrument,
    timeframe: manifest.timeframe,
    dateFrom: manifest.dateFrom,
    dateTo: manifest.dateTo,
    sourceProvider: manifest.source.provider,
    sourceArtifactId: manifest.source.artifactId,
    sourceVersion: manifest.source.version,
    sourceCandlesSha256: manifest.source.candlesSha256,
    aggregationAlgorithmVersion: manifest.aggregationAlgorithmVersion,
    rollPolicyVersion: manifest.rollPolicy.version,
    sessionTemplate: manifest.sessionPolicy.template,
    sessionTimezone: manifest.sessionPolicy.timezone,
    calendarVersion: manifest.sessionPolicy.calendarVersion,
  });
}

export function canonicalContractRecord(contract: ResearchDatasetContract): string {
  return JSON.stringify({
    type: "contract",
    conId: contract.conId,
    localSymbol: contract.localSymbol,
    symbol: contract.symbol,
    tradingClass: contract.tradingClass,
    exchange: contract.exchange,
    currency: contract.currency,
    expiry: contract.expiry,
    lastTradeAt: contract.lastTradeAt,
    validFrom: contract.validFrom,
    validTo: contract.validTo,
    rollAt: contract.rollAt,
    multiplier: contract.multiplier,
    minTick: contract.minTick,
  });
}

export function canonicalCandleRecord(candle: ResearchDatasetCandle): string {
  return JSON.stringify({
    type: "candle",
    symbol: candle.symbol,
    conId: candle.conId,
    ts: candle.ts,
    openTicks: candle.openTicks,
    highTicks: candle.highTicks,
    lowTicks: candle.lowTicks,
    closeTicks: candle.closeTicks,
    volume: candle.volume,
  });
}

export function canonicalFingerprintBytes(
  manifest: ResearchDatasetManifest,
  candles: readonly ResearchDatasetCandle[],
): Buffer {
  const contracts = [...manifest.contracts].sort((a, b) =>
    BigInt(a.conId) < BigInt(b.conId) ? -1 : BigInt(a.conId) > BigInt(b.conId) ? 1 : 0,
  );
  const records = [
    FINGERPRINT_HEADER.slice(0, -1),
    canonicalDatasetRecord(manifest),
    ...contracts.map(canonicalContractRecord),
    ...candles.map(canonicalCandleRecord),
  ];
  return Buffer.from(`${records.join("\n")}\n`, "utf8");
}

export function fingerprintResearchDataset(
  manifest: ResearchDatasetManifest,
  candles: readonly ResearchDatasetCandle[],
): string {
  const builder = new ResearchDatasetFingerprintBuilder(manifest);
  for (const candle of candles) builder.updateCandle(candle);
  return builder.digest();
}

export function ticksToPrice(ticks: string, minTick: string): number {
  const [whole, fraction = ""] = minTick.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const tickUnits = BigInt(whole) * scale + BigInt(fraction || "0");
  return Number(BigInt(ticks) * tickUnits) / Number(scale);
}
