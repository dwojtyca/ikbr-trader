import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StrategyPortfolioManager } from "./strategy-portfolio-manager.js";
import type {
  Strategy,
  StrategyContext,
  StrategySignal,
} from "../strategies/strategy.types.js";

function makeStrategy(
  id: string,
  overrides: {
    signal?: StrategySignal | null;
    lanePriority?: number;
    supportedDirections?: readonly ("LONG" | "SHORT")[];
    throwErr?: Error;
  } = {},
): Strategy {
  return {
    id,
    secTypes: ["STK"],
    supportedDirections: overrides.supportedDirections ?? ["LONG"],
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
    ...(overrides.lanePriority !== undefined
      ? { lanePriority: overrides.lanePriority }
      : {}),
    generateSignal: () => {
      if (overrides.throwErr) throw overrides.throwErr;
      return overrides.signal ?? null;
    },
  } as Strategy;
}

function makeSignal(
  strategyId: string,
  overrides: Partial<StrategySignal> = {},
): StrategySignal {
  return {
    strategyId,
    symbol: "AAPL",
    side: overrides.side ?? "BUY",
    direction: overrides.direction ?? "LONG",
    confidenceScore: overrides.confidenceScore ?? 0.7,
    entryReason: "test",
  } as StrategySignal;
}

function makeContext(): StrategyContext {
  return {
    symbol: "AAPL",
    conid: "1",
    secType: "STK",
    directionalRegime: "bull_trend",
    volatilityRegime: "normal_volatility",
    latestCandle: { close: 100 } as StrategyContext["latestCandle"],
    indicators: {} as StrategyContext["indicators"],
    candlesByTimeframe: {},
  } as StrategyContext;
}

describe("StrategyPortfolioManager — PR15.4 discriminated result", () => {
  it("kind:'ok' with selected + candidates + rejectionReasons", () => {
    const s = makeStrategy("a", { signal: makeSignal("a") });
    const mgr = new StrategyPortfolioManager([s]);
    const result = mgr.run(makeContext());
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.selected?.strategy.id, "a");
    assert.equal(result.candidates.length, 1);
  });

  it("throws inside generateSignal → kind:'error' with STRATEGY_EVALUATION_EXCEPTION; onStrategyError receives raw", () => {
    const err = new Error("boom");
    let received: unknown = null;
    const s = makeStrategy("a", { throwErr: err });
    const mgr = new StrategyPortfolioManager([s], {
      onStrategyError: (_id, e) => {
        received = e;
      },
    });
    const result = mgr.run(makeContext());
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.errorCode, "STRATEGY_EVALUATION_EXCEPTION");
    assert.equal(result.strategyId, "a");
    assert.ok(!/boom/.test(result.message));
    assert.equal(received, err);
  });

  it("onStrategyError throws → still returns kind:'error'", () => {
    const s = makeStrategy("a", { throwErr: new Error("x") });
    const mgr = new StrategyPortfolioManager([s], {
      onStrategyError: () => {
        throw new Error("callback exploded");
      },
    });
    const result = mgr.run(makeContext());
    assert.equal(result.kind, "error");
  });

  it("candidates lists all strategies that produced a signal", () => {
    const mgr = new StrategyPortfolioManager([
      makeStrategy("a", { signal: makeSignal("a") }),
      makeStrategy("b", { signal: makeSignal("b") }),
    ]);
    const result = mgr.run(makeContext());
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.candidates.length, 2);
  });

  it("deterministic sort: lanePriority DESC, then confidenceScore DESC, then id ASC", () => {
    const mgr = new StrategyPortfolioManager([
      makeStrategy("b", {
        signal: makeSignal("b", { confidenceScore: 0.9 }),
        lanePriority: 0,
      }),
      makeStrategy("a", {
        signal: makeSignal("a", { confidenceScore: 0.5 }),
        lanePriority: 10,
      }),
      makeStrategy("c", {
        signal: makeSignal("c", { confidenceScore: 0.5 }),
        lanePriority: 10,
      }),
    ]);
    const result = mgr.run(makeContext());
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.selected?.strategy.id, "a");
    assert.equal(result.candidates[0].strategy.id, "a");
    assert.equal(result.candidates[1].strategy.id, "c");
    assert.equal(result.candidates[2].strategy.id, "b");
  });

  it("selected === candidates[0] when non-empty", () => {
    const mgr = new StrategyPortfolioManager([
      makeStrategy("a", { signal: makeSignal("a") }),
    ]);
    const result = mgr.run(makeContext());
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.selected, result.candidates[0]);
  });
});
