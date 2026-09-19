import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Candle } from "@ikbr/shared";

export const RESEARCH_MECHANICAL_STRATEGY_ID = "pr15_5e_mechanical_v1";
export const RESEARCH_MECHANICAL_FIXTURE_SHA256 = "8101aefb61c7d4aea9584e1f1c59a43e118f9696e489f6479a8298a472021c6c";

const episodeSchema = z.enum([
  "take_profit", "stop_loss", "same_bar_collision", "contract_roll",
  "quantity_rejected", "expiry", "dataset_end",
]);
const expectedFillSchema = z.object({
  episode: z.string().min(1), conId: z.string().min(1), quantity: z.literal(1),
  entryReferencePrice: z.number(), entryFillPrice: z.number(),
  exitReferencePrice: z.number(), exitFillPrice: z.number(),
  grossPnl: z.number(), commission: z.number(), netPnl: z.number(),
  slippageCost: z.number(), exitReason: z.string().min(1),
}).strict();
const expectedScenarioSchema = z.object({
  totalPnl: z.number(), grossPnl: z.number(), commissions: z.number(),
  slippageCost: z.number(), wins: z.number().int().nonnegative(),
  fills: z.array(expectedFillSchema).length(6),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal("pr15.5e-mechanical-fixture-v1"),
  start: z.string().datetime(), candleCount: z.number().int().positive(),
  generatedCandlesSha256: z.string().regex(/^[a-f0-9]{64}$/),
  basePrice: z.number().positive(),
  contracts: z.array(z.object({ conId: z.string().min(1), localSymbol: z.string().min(1),
    firstIndex: z.number().int().nonnegative(), lastIndex: z.number().int().nonnegative(),
    lastTradeIndex: z.number().int().positive() }).strict()).length(3),
  signals: z.array(z.object({ episode: episodeSchema, index: z.number().int().nonnegative(),
    conId: z.string().min(1), stop: z.number().positive(), takeProfit: z.number().positive() }).strict()).length(7),
  economics: z.object({ multiplier: z.number().positive(), tickSize: z.number().positive(),
    primaryCommissionPerSide: z.number().nonnegative(), primarySlippageTicks: z.number().int().nonnegative(),
    stressCommissionPerSide: z.number().nonnegative(), stressSlippageTicks: z.number().int().nonnegative(),
    accountEquity: z.number().positive(), targetRiskPerTradePct: z.number().positive() }).strict(),
  expected: z.object({ orders: z.number().int().nonnegative(), fills: z.number().int().nonnegative(),
    closedTrades: z.number().int().nonnegative(), exitReasons: z.record(z.number().int().nonnegative()),
    primary: expectedScenarioSchema, stress: expectedScenarioSchema,
    primaryReproductionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();

export type ResearchMechanicalManifest = z.infer<typeof manifestSchema>;
export type ResearchMechanicalSignal = ResearchMechanicalManifest["signals"][number];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function loadResearchMechanicalManifest(
  url = new URL("./fixtures/PR15_5E_MECHANICAL_FIXTURE.json", import.meta.url),
): Promise<ResearchMechanicalManifest> {
  const raw = await readFile(url, "utf8");
  const manifest = manifestSchema.parse(JSON.parse(raw));
  const hash = createHash("sha256").update(canonical(manifest)).digest("hex");
  if (hash !== RESEARCH_MECHANICAL_FIXTURE_SHA256)
    throw new Error("PR15.5E mechanical fixture hash mismatch");
  const episodes = new Set(manifest.signals.map((signal) => signal.episode));
  if (episodes.size !== manifest.signals.length) throw new Error("PR15.5E fixture episodes must be unique");
  let previousLast = -1;
  for (const contract of manifest.contracts) {
    if (contract.firstIndex !== previousLast + 1 || contract.lastIndex < contract.firstIndex ||
      contract.lastTradeIndex <= contract.lastIndex)
      throw new Error("PR15.5E fixture contract ranges must be contiguous and pre-expiry");
    previousLast = contract.lastIndex;
  }
  if (previousLast !== manifest.candleCount - 1)
    throw new Error("PR15.5E fixture contracts must cover every candle");
  for (const signal of manifest.signals) {
    const contract = manifest.contracts.find((value) => value.conId === signal.conId);
    if (!contract || signal.index < contract.firstIndex || signal.index > contract.lastIndex)
      throw new Error(`PR15.5E signal ${signal.episode} is outside its contract range`);
    if (signal.stop >= manifest.basePrice || signal.takeProfit <= manifest.basePrice)
      throw new Error(`PR15.5E signal ${signal.episode} has invalid protection`);
  }
  if (researchMechanicalCandlesHash(manifest) !== manifest.generatedCandlesSha256)
    throw new Error("PR15.5E generated candle fingerprint mismatch");
  const tick = manifest.economics.tickSize;
  const onTick = (price: number) => Math.abs(price / tick - Math.round(price / tick)) < 1e-8;
  for (const [scenario, commissionPerSide] of [
    [manifest.expected.primary, manifest.economics.primaryCommissionPerSide],
    [manifest.expected.stress, manifest.economics.stressCommissionPerSide],
  ] as const) {
    for (const fill of scenario.fills) {
      if (![fill.entryReferencePrice, fill.entryFillPrice, fill.exitReferencePrice, fill.exitFillPrice].every(onTick))
        throw new Error("PR15.5E oracle contains an off-tick price");
      const gross = (fill.exitFillPrice - fill.entryFillPrice) * fill.quantity * manifest.economics.multiplier;
      const commission = 2 * commissionPerSide * fill.quantity;
      const slippage = (Math.abs(fill.entryFillPrice - fill.entryReferencePrice) +
        Math.abs(fill.exitFillPrice - fill.exitReferencePrice)) * fill.quantity * manifest.economics.multiplier;
      if (gross !== fill.grossPnl || commission !== fill.commission ||
        gross - commission !== fill.netPnl || slippage !== fill.slippageCost)
        throw new Error(`PR15.5E oracle arithmetic mismatch for ${fill.episode}`);
    }
    if (scenario.grossPnl !== scenario.fills.reduce((sum, fill) => sum + fill.grossPnl, 0) ||
      scenario.commissions !== scenario.fills.reduce((sum, fill) => sum + fill.commission, 0) ||
      scenario.slippageCost !== scenario.fills.reduce((sum, fill) => sum + fill.slippageCost, 0) ||
      scenario.totalPnl !== scenario.fills.reduce((sum, fill) => sum + fill.netPnl, 0) ||
      scenario.wins !== scenario.fills.filter((fill) => fill.netPnl > 0).length)
      throw new Error("PR15.5E oracle aggregate mismatch");
  }
  return Object.freeze(manifest);
}

export function researchMechanicalFixtureHash(manifest: ResearchMechanicalManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

export function buildResearchMechanicalCandles(manifest: ResearchMechanicalManifest): Candle[] {
  const start = new Date(manifest.start).getTime();
  const signalIndex = (episode: ResearchMechanicalSignal["episode"]) =>
    manifest.signals.find((signal) => signal.episode === episode)?.index;
  const candle = (index: number): Candle => {
    const contract = manifest.contracts.find((value) => index >= value.firstIndex && index <= value.lastIndex);
    if (!contract) throw new Error(`PR15.5E candle ${index} has no contract`);
    let open = manifest.basePrice; let high = open + 1; let low = open - 1; let close = open;
    if (index === Number(signalIndex("take_profit")) + 2) high = 6011;
    if (index === Number(signalIndex("stop_loss")) + 2) low = 5989;
    if (index === Number(signalIndex("same_bar_collision")) + 2) { high = 6011; low = 5989; }
    if (index === manifest.contracts[0].lastIndex) { open = 6002; high = 6003; low = 6001; close = 6002; }
    if (index === manifest.contracts[1].lastIndex) { open = 6003; high = 6004; low = 6002; close = 6003; }
    if (index === manifest.candleCount - 1) { open = 6004; high = 6005; low = 6003; close = 6004; }
    return { symbol: "ES", conid: contract.conId, timeframe: "1m",
      ts: new Date(start + index * 60_000), open, high, low, close, volume: 100 + index % 10 };
  };
  return Array.from({ length: manifest.candleCount }, (_, index) => candle(index));
}

export function researchMechanicalCandlesHash(manifest: ResearchMechanicalManifest): string {
  return researchMechanicalCandleRowsHash(buildResearchMechanicalCandles(manifest));
}

export function researchMechanicalCandleRowsHash(candles: readonly Candle[]): string {
  const rows = candles.map((candle) => ({
    symbol: candle.symbol, conid: candle.conid, timeframe: candle.timeframe,
    ts: candle.ts.toISOString(), open: candle.open, high: candle.high,
    low: candle.low, close: candle.close, volume: candle.volume,
  }));
  return createHash("sha256").update(canonical(rows)).digest("hex");
}

export function contractLastTradeAt(manifest: ResearchMechanicalManifest, index: number): Date {
  return new Date(new Date(manifest.start).getTime() + index * 60_000);
}
