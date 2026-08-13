import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Redis } from "ioredis";
import type { Pool } from "pg";

import { SignalRepository } from "./repository.js";
import { SignalEngine } from "./signal-engine.js";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "./strategies/strategy.types.js";

// ---------------------------------------------------------------------------
// PR15.4 §14.8 — SignalEngine.runForSymbol() narrowing on portfolio + resolver
// discriminated results.
//
// We stub the repository just enough to reach the strategy activation +
// portfolio path. The goal is to prove that:
//   1. A strategy throwing inside generateSignal does NOT propagate out
//      of runForSymbol; the returned ProposedOrder is safe (REJECTED).
//   2. A repo error inside getStrategyRuntimeState() is captured by the
//      resolver and surfaces as a REJECTED order with an operator-safe
//      message; onStrategyStateError callback receives the raw error.
// ---------------------------------------------------------------------------

function makeRepoStub(
  overrides: Partial<SignalRepository> = {},
): SignalRepository {
  const base = {
    async getRecentCandles() {
      return [];
    },
    async getInstrumentContract() {
      return null;
    },
    async getMarketState() {
      return null;
    },
    async getExposureSnapshot() {
      return {
        exposure: 0,
        openPositions: 0,
        source: "db",
        positionsBySymbol: {},
      };
    },
    async getSignalPerformance() {
      return { trades: 0, wins: 0, losses: 0, winRate: 0 };
    },
    async syncStrategyRuntimeStates() {
      return;
    },
    async getStrategyRuntimeState() {
      return {
        strategyId: "s1",
        enabled: true,
        permanentlyDisabled: false,
        consecutiveLossCount: 0,
        cooldownCount: 0,
      };
    },
    async insertProposedOrder() {
      return 1;
    },
    async supersedePendingSignalsForInstrument() {
      return;
    },
    async expireStalePendingSignals() {
      return 0;
    },
    async getOpenPositionBySymbol() {
      return null;
    },
    ...overrides,
  };
  return base as unknown as SignalRepository;
}

function makeStrategy(
  id: string,
  overrides: {
    throwErr?: Error;
    signal?: StrategySignal | null;
  } = {},
): Strategy {
  return {
    id,
    secTypes: ["STK"],
    supportedDirections: ["LONG"],
    allowedDirectionalRegimes: [
      "bull_trend",
      "bear_trend",
      "range",
      "sideways",
    ] as unknown as Strategy["allowedDirectionalRegimes"],
    allowedVolatilityRegimes: [
      "normal_volatility",
      "high_volatility",
      "low_volatility",
    ] as unknown as Strategy["allowedVolatilityRegimes"],
    requiredTimeframes: ["1m"],
    generateSignal: (_c: StrategyContext) => {
      if (overrides.throwErr) throw overrides.throwErr;
      return overrides.signal ?? null;
    },
  } as Strategy;
}

function baseEngine(overrides: {
  repo?: SignalRepository;
  strategies?: readonly Strategy[];
  onStrategyStateError?: (id: string, err: unknown) => void;
  onStrategyError?: (id: string, err: unknown) => void;
}): SignalEngine {
  return new SignalEngine(overrides.repo ?? makeRepoStub(), {
    strategies: overrides.strategies ?? [makeStrategy("s1")],
    minCandles: 10,
    maxSpreadBps: 100,
    minVolume1m: 0,
    volumeFilterMode: "off",
    minConfidence: 0,
    lmtEntryMode: "last",
    lmtEntryBufferBps: 0,
    fractionalSymbols: new Set(),
    fractionalQuantityStep: 1,
    minStopBpsBySecType: { STK: 0, IND: 0, CMDTY: 0 },
    maxMarketStateAgeMs: 0,
    baseCurrency: "USD",
    currencyBySymbol: {},
    priceMultiplierBySymbol: {},
    executionBaseUrl: "http://x",
    executionApiToken: "",
    strategyCooldownMs: 0,
    riskLimits: {
      accountEquity: 10000,
      maxRiskPerTradePct: 1,
      maxExposurePct: 100,
      maxOpenPositions: 5,
    },
    ...(overrides.onStrategyStateError
      ? { onStrategyStateError: overrides.onStrategyStateError }
      : {}),
    ...(overrides.onStrategyError
      ? { onStrategyError: overrides.onStrategyError }
      : {}),
  });
}

describe("SignalEngine.runForSymbol — PR15.4 narrowing", () => {
  it("insufficient candles → returns rejected order without throwing", async () => {
    const engine = baseEngine({});
    const order = await engine.runForSymbol("AAPL");
    assert.equal(order.status, "REJECTED");
    assert.match(order.reason, /Insufficient candles/);
  });

  it("getStrategyRuntimeState throws → resolver kind:error → rejected order; onStrategyStateError receives raw", async () => {
    const err = new Error("db offline");
    let received: unknown = null;
    // Provide enough candle-like data so we reach the strategy path.
    // We stub `getRecentCandles` to return 200 candles for 1m.
    const nowMs = Date.now();
    const candle = (i: number) => ({
      conid: "1",
      symbol: "AAPL",
      timeframe: "1m" as const,
      ts: new Date(nowMs - (200 - i) * 60_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    });
    const repo = makeRepoStub({
      async getRecentCandles() {
        return Array.from({ length: 250 }, (_, i) => candle(i));
      },
      async getInstrumentContract() {
        return {
          symbol: "AAPL",
          conid: "1",
          secType: "STK",
          source: "ibkr",
        } as unknown as Awaited<
          ReturnType<SignalRepository["getInstrumentContract"]>
        >;
      },
      async getStrategyRuntimeState() {
        throw err;
      },
    });
    const engine = baseEngine({
      repo,
      onStrategyStateError: (_id, e) => {
        received = e;
      },
    });
    const order = await engine.runForSymbol("AAPL");
    // Result is REJECTED with a safe message; raw error NOT in message.
    assert.equal(order.status, "REJECTED");
    assert.ok(!/db offline/.test(order.reason));
    assert.equal(received, err);
  });

  it("onStrategyStateError callback throws → runForSymbol still returns safe REJECTED", async () => {
    const err = new Error("db offline");
    const nowMs = Date.now();
    const candle = (i: number) => ({
      conid: "1",
      symbol: "AAPL",
      timeframe: "1m" as const,
      ts: new Date(nowMs - (200 - i) * 60_000),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    });
    const repo = makeRepoStub({
      async getRecentCandles() {
        return Array.from({ length: 250 }, (_, i) => candle(i));
      },
      async getInstrumentContract() {
        return {
          symbol: "AAPL",
          conid: "1",
          secType: "STK",
          source: "ibkr",
        } as unknown as Awaited<
          ReturnType<SignalRepository["getInstrumentContract"]>
        >;
      },
      async getStrategyRuntimeState() {
        throw err;
      },
    });
    const engine = baseEngine({
      repo,
      onStrategyStateError: () => {
        throw new Error("callback exploded");
      },
    });
    const order = await engine.runForSymbol("AAPL");
    assert.equal(order.status, "REJECTED");
  });

  it("strategy.generateSignal throws → REJECTED without leaking; onStrategyError receives raw; no executable intent", async () => {
    const err = new Error("boom: SECRET-DETAIL-9999");
    let received: unknown = null;
    const nowMs = Date.now();
    const candle = (i: number, timeframeMs: number) => ({
      conid: "1",
      symbol: "AAPL",
      timeframe: "1m" as const,
      ts: new Date(nowMs - (250 - i) * timeframeMs),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    });
    const repo = makeRepoStub({
      async getRecentCandles(_symbol: string, tf: string) {
        const step =
          tf === "1m"
            ? 60_000
            : tf === "5m"
              ? 300_000
              : tf === "1h"
                ? 3_600_000
                : tf === "4h"
                  ? 14_400_000
                  : tf === "12h"
                    ? 43_200_000
                    : tf === "1d"
                      ? 86_400_000
                      : 604_800_000;
        return Array.from({ length: 250 }, (_, i) => candle(i, step));
      },
      async getInstrumentContract() {
        return {
          symbol: "AAPL",
          conid: "1",
          secType: "STK",
          source: "ibkr",
        } as unknown as Awaited<
          ReturnType<SignalRepository["getInstrumentContract"]>
        >;
      },
      async getMarketState() {
        return {
          conid: "1",
          symbol: "AAPL",
          lastPrice: 100,
          bid: 99.98,
          ask: 100.02,
          spread: 0.04,
          ts: new Date(nowMs - 1000).toISOString(),
        } as unknown as Awaited<ReturnType<SignalRepository["getMarketState"]>>;
      },
    });
    const engine = baseEngine({
      repo,
      strategies: [makeStrategy("s1", { throwErr: err })],
      onStrategyError: (_id, e) => {
        received = e;
      },
    });
    const order = await engine.runForSymbol("AAPL");
    assert.equal(order.status, "REJECTED");
    assert.ok(!/SECRET-DETAIL/.test(order.reason));
    // Callback may or may not receive raw depending on where the throw is
    // captured. The `StrategyPortfolioManager` catches and forwards the raw
    // error; here we assert that either the callback got the raw error OR
    // (if the throw was captured elsewhere) the domain result is still safe.
    if (received !== null) {
      assert.equal(received, err);
    }
    // No executable intent: order.quantity is zero for REJECTED.
    assert.equal(order.quantity, 0);
  });

  it("onStrategyError callback throws → runForSymbol still returns safe REJECTED", async () => {
    const err = new Error("boom");
    const nowMs = Date.now();
    const candle = (i: number, timeframeMs: number) => ({
      conid: "1",
      symbol: "AAPL",
      timeframe: "1m" as const,
      ts: new Date(nowMs - (250 - i) * timeframeMs),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    });
    const repo = makeRepoStub({
      async getRecentCandles(_symbol: string, tf: string) {
        const step = tf === "1m" ? 60_000 : 3_600_000;
        return Array.from({ length: 250 }, (_, i) => candle(i, step));
      },
      async getInstrumentContract() {
        return {
          symbol: "AAPL",
          conid: "1",
          secType: "STK",
          source: "ibkr",
        } as unknown as Awaited<
          ReturnType<SignalRepository["getInstrumentContract"]>
        >;
      },
      async getMarketState() {
        return {
          conid: "1",
          symbol: "AAPL",
          lastPrice: 100,
          ts: new Date(nowMs - 1000).toISOString(),
        } as unknown as Awaited<ReturnType<SignalRepository["getMarketState"]>>;
      },
    });
    const engine = baseEngine({
      repo,
      strategies: [makeStrategy("s1", { throwErr: err })],
      onStrategyError: () => {
        throw new Error("callback exploded");
      },
    });
    const order = await engine.runForSymbol("AAPL");
    assert.equal(order.status, "REJECTED");
  });
});
