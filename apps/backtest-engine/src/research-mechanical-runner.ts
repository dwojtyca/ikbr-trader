import { createHash } from "node:crypto";
import { withBuiltInResearchCalendar } from "./cme-equity-index-calendar.js";
import type { BacktestRepository } from "./repository.js";
import {
  RESEARCH_MECHANICAL_STRATEGY_ID,
  contractLastTradeAt,
  type ResearchMechanicalManifest,
} from "./research-mechanical-fixture.js";
import { ResearchMechanicalStrategy } from "./research-mechanical-strategy.js";
import { BacktestSimulator, type SimulatorOptions } from "./simulator.js";
import type { LoadedBacktestData } from "./types.js";

export type ResearchMechanicalStoredScenario = "primary" | "stress" | "primary_reproduction";
export type ResearchMechanicalEconomicsScenario = "primary" | "stress";

export function researchMechanicalSimulatorOptions(
  manifest: ResearchMechanicalManifest,
  scenario: ResearchMechanicalEconomicsScenario,
): SimulatorOptions {
  const commissionPerContractPerSide = scenario === "stress"
    ? manifest.economics.stressCommissionPerSide
    : manifest.economics.primaryCommissionPerSide;
  const slippageTicks = scenario === "stress"
    ? manifest.economics.stressSlippageTicks
    : manifest.economics.primarySlippageTicks;
  const calendarVersion = "cme-equity-index-2024-2026-v1";
  const futuresContracts = new Map(manifest.contracts.map((contract) => [contract.conId, {
    conid: contract.conId,
    symbol: "ES",
    localSymbol: contract.localSymbol,
    tradingClass: "ES",
    lastTradeAt: contractLastTradeAt(manifest, contract.lastTradeIndex),
  }]));

  return {
    minCandles: 200,
    maxSpreadBps: 100,
    minVolume1m: 0,
    minConfidence: 0,
    lmtEntryMode: "touch",
    lmtEntryBufferBps: 0,
    fractionalSymbols: new Set(),
    fractionalQuantityStep: 1,
    minStopBpsBySecType: { FUT: 0 },
    baseCurrency: "USD",
    currencyBySymbol: { ES: "USD" },
    secTypeBySymbol: { ES: "FUT" },
    priceMultiplierBySymbol: { ES: manifest.economics.multiplier },
    strategyCooldownMs: 1,
    commissionBps: 0,
    commissionPerShare: 0,
    commissionMinPerSide: 0,
    commissionPassthroughBps: 0,
    syntheticSpreadBps: 0,
    orderTtlCandles: 1,
    futuresSpecs: new Map([["ES", {
      tradingClass: "ES",
      secType: "FUT",
      currency: "USD",
      multiplier: manifest.economics.multiplier,
      tickSize: manifest.economics.tickSize,
      commissionPerContractPerSide,
      slippageTicks,
      sessionTemplate: "cme_equity_index",
      timezone: "America/Chicago",
      calendarVersion,
    }]]),
    futuresContracts,
    futuresCalendars: withBuiltInResearchCalendar(new Map()),
    strategyIds: [RESEARCH_MECHANICAL_STRATEGY_ID],
    strategyFactory: () => [new ResearchMechanicalStrategy(manifest)],
    riskLimits: {
      accountEquity: manifest.economics.accountEquity,
      targetRiskPerTradePct: manifest.economics.targetRiskPerTradePct,
      maxRiskPerTradePct: manifest.economics.targetRiskPerTradePct,
      maxExposurePct: 400,
      maxNotionalPerTradePct: 400,
      maxOpenPositions: 1,
    },
  };
}

export async function runResearchMechanicalScenario(input: {
  repository: BacktestRepository;
  datasetId: number;
  experimentId: string;
  datasetFingerprintBefore: string;
  datasetFingerprintAfter: string;
  reloadDatasetFingerprint?: () => Promise<string>;
  validateDurableOracle?: (runId: number, scenario: ResearchMechanicalEconomicsScenario) => Promise<void>;
  manifest: ResearchMechanicalManifest;
  data: LoadedBacktestData;
  storedScenario: ResearchMechanicalStoredScenario;
}) {
  const economicsScenario = input.storedScenario === "stress" ? "stress" : "primary";
  const run = await input.repository.createResearchScenarioRun(input.datasetId, {
    experimentId: input.experimentId,
    scenario: input.storedScenario,
    strategyId: RESEARCH_MECHANICAL_STRATEGY_ID,
    fixtureSha256: input.datasetFingerprintBefore,
  });
  try {
    const summary = await new BacktestSimulator(
      input.repository,
      run.id,
      input.data,
      researchMechanicalSimulatorOptions(input.manifest, economicsScenario),
    ).run();
    const observedFingerprintAfter = input.reloadDatasetFingerprint
      ? await input.reloadDatasetFingerprint() : input.datasetFingerprintAfter;
    if (observedFingerprintAfter !== input.datasetFingerprintBefore)
      throw new Error("PR15.5E dataset fingerprint changed during scenario");
    const metrics = await input.repository.getResearchScenarioMetrics(
      run.id,
      economicsScenario,
      input.datasetFingerprintBefore,
      observedFingerprintAfter,
      {
        strategyId: RESEARCH_MECHANICAL_STRATEGY_ID,
        executionModelVersion: "pr15.5b-v1",
        calendarVersion: "cme-equity-index-2024-2026-v1",
        multiplier: input.manifest.economics.multiplier,
        tickSize: input.manifest.economics.tickSize,
      },
    );
    const expected = input.manifest.expected[input.storedScenario === "stress" ? "stress" : "primary"];
    if (summary.trades !== input.manifest.expected.closedTrades ||
      metrics.closedTrades !== input.manifest.expected.closedTrades ||
      metrics.netPnl !== expected.totalPnl || metrics.pendingOrders !== 0 ||
      metrics.unclosedFills !== 0 || metrics.invariantViolations.length !== 0 ||
      metrics.wins !== expected.wins || metrics.losses !== 2 ||
      metrics.grossPnl !== expected.grossPnl || metrics.commissions !== expected.commissions ||
      metrics.slippageCost !== expected.slippageCost ||
      JSON.stringify(Object.entries(metrics.countsByContract).sort()) !==
      JSON.stringify(Object.entries({ "501": 4, "502": 1, "503": 1 }).sort()) ||
      JSON.stringify(Object.entries(metrics.countsByExitReason).sort()) !==
      JSON.stringify(Object.entries(input.manifest.expected.exitReasons).sort()))
      throw new Error(`PR15.5E mechanical scenario did not satisfy its durable oracle: ${JSON.stringify({
        summary, metrics: { closedTrades: metrics.closedTrades, netPnl: metrics.netPnl,
          pendingOrders: metrics.pendingOrders, unclosedFills: metrics.unclosedFills,
          invariantViolations: metrics.invariantViolations, countsByExitReason: metrics.countsByExitReason },
      })}`);
    await input.validateDurableOracle?.(run.id, economicsScenario);
    await input.repository.finishRun(run.id, "completed", summary);
    return { runId: run.id, summary, metrics };
  } catch (error) {
    await input.repository.finishRun(run.id, "failed", { error: (error as Error).message });
    throw error;
  }
}

export function canonicalMechanicalResultHash(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") return `{${Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
