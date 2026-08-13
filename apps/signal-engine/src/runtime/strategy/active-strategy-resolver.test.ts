import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { StrategyProfile } from "@ikbr/shared";

import {
  resolveActiveStrategyIds,
  type StrategyRuntimeStateReader,
} from "./active-strategy-resolver.js";

function profile(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    id: overrides.id ?? "s1",
    secType: ["STK"],
    directionalRegimes: ["bull_trend"],
    volatilityRegimes: ["normal_volatility"],
    style: "breakout",
    enabledInBot: true,
    entryScore: 0.5,
    decisionEdge: 0.08,
    minConfidenceMultiplier: 1,
    quantityFactor: 1,
    spreadFactor: 1,
    requireVolume: false,
    earlyExitEnabled: false,
    ...overrides,
  } as StrategyProfile;
}

function repo(
  states: Record<
    string,
    {
      enabled: boolean;
      permanentlyDisabled: boolean;
      cooldownUntil?: Date;
    } | Error
  >,
): StrategyRuntimeStateReader {
  return {
    async getStrategyRuntimeState(id) {
      const s = states[id];
      if (s instanceof Error) throw s;
      if (!s) return { enabled: true, permanentlyDisabled: false };
      return s;
    },
  };
}

describe("resolveActiveStrategyIds — PR15.4", () => {
  const clock = () => new Date("2026-08-12T12:00:00Z");

  it("all enabled → kind:ok with all IDs", async () => {
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a", "b"],
      () => profile(),
      repo({}),
      { clock },
    );
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.deepEqual([...res.activeIds], ["a", "b"]);
  });

  it("excludedSymbols → excluded", async () => {
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a"],
      () => profile({ excludedSymbols: ["AAPL"] }),
      repo({}),
      { clock },
    );
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.deepEqual([...res.activeIds], []);
    assert.equal(res.disabledReasons.length, 1);
  });

  it("includedSymbols does not match → excluded", async () => {
    const res = await resolveActiveStrategyIds(
      "MSFT",
      ["a"],
      () => profile({ includedSymbols: ["AAPL"] }),
      repo({}),
      { clock },
    );
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.deepEqual([...res.activeIds], []);
  });

  it("enabled=false → excluded", async () => {
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a"],
      () => profile(),
      repo({ a: { enabled: false, permanentlyDisabled: false } }),
      { clock },
    );
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.deepEqual([...res.activeIds], []);
  });

  it("permanentlyDisabled → excluded", async () => {
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a"],
      () => profile(),
      repo({ a: { enabled: true, permanentlyDisabled: true } }),
      { clock },
    );
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.deepEqual([...res.activeIds], []);
  });

  it("cooldownUntil in future → excluded", async () => {
    const cooldownUntil = new Date("2026-08-12T13:00:00Z");
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a"],
      () => profile(),
      repo({
        a: { enabled: true, permanentlyDisabled: false, cooldownUntil },
      }),
      { clock },
    );
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.deepEqual([...res.activeIds], []);
  });

  it("cooldownUntil in past → included", async () => {
    const cooldownUntil = new Date("2026-08-12T11:00:00Z");
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a"],
      () => profile(),
      repo({
        a: { enabled: true, permanentlyDisabled: false, cooldownUntil },
      }),
      { clock },
    );
    assert.equal(res.kind, "ok");
    if (res.kind !== "ok") return;
    assert.deepEqual([...res.activeIds], ["a"]);
  });

  it("getStrategyRuntimeState throws → kind:error, onStateError called with raw", async () => {
    const err = new Error("db down");
    let received: unknown = null;
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a", "b"],
      () => profile(),
      repo({ b: err }),
      {
        clock,
        onStateError: (_id, e) => {
          received = e;
        },
      },
    );
    assert.equal(res.kind, "error");
    if (res.kind !== "error") return;
    assert.equal(res.code, "STRATEGY_STATE_UNAVAILABLE");
    assert.equal(res.strategyId, "b");
    assert.ok(!/db down/.test(res.message));
    assert.equal(received, err);
  });

  it("onStateError throws → resolver still returns kind:error", async () => {
    const res = await resolveActiveStrategyIds(
      "AAPL",
      ["a"],
      () => profile(),
      repo({ a: new Error("x") }),
      {
        clock,
        onStateError: () => {
          throw new Error("callback exploded");
        },
      },
    );
    assert.equal(res.kind, "error");
  });
});
