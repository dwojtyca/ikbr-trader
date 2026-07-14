import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TradingLoopIdempotencyKeyBuilder } from "./idempotency-key.js";

const STRAT = "momentum_breakout_long_v1";
const TRIG1 = "evaluation.1m.1784030400000";
const TRIG2 = "evaluation.1m.1784030460000";

function build(
  instrumentId: string,
  strategyId: string,
  triggerId: string,
  version?: string,
): string {
  const builder = new TradingLoopIdempotencyKeyBuilder({
    ...(version !== undefined ? { version } : {}),
  });
  return builder.build({ instrumentId, strategyId, triggerId });
}

describe("TradingLoopIdempotencyKeyBuilder — v4 determinism", () => {
  it("same (instrument, strategy, trigger) → same key", () => {
    assert.equal(build("AAPL", STRAT, TRIG1), build("AAPL", STRAT, TRIG1));
  });

  it("format: loop:v4:<id>:<strategy>:<trigger>  (no intent-hash suffix)", () => {
    const k = build("AAPL", STRAT, TRIG1);
    const parts = k.split(":");
    assert.equal(parts.length, 5);
    assert.equal(parts[0], "loop");
    assert.equal(parts[1], "v4");
    assert.equal(parts[2], "AAPL");
    assert.equal(parts[3], STRAT);
    assert.equal(parts[4], TRIG1);
  });
});

describe("TradingLoopIdempotencyKeyBuilder — clientOrderId is trigger-only (round-5 blocker)", () => {
  it("same trigger + ANY payload → same clientOrderId (payload lives in clientOrderHash)", () => {
    // The whole point of round 5: the loop MUST NOT bake payload
    // into the clientOrderId. Two evaluations of the same trigger
    // that emit different tickets get the SAME clientOrderId so
    // execution-engine's UNIQUE(client_order_id) surfaces a
    // legitimate CONFLICT on the mismatched hash.
    assert.equal(build("AAPL", STRAT, TRIG1), build("AAPL", STRAT, TRIG1));
  });

  it("new trigger → new clientOrderId (even with an identical downstream ticket)", () => {
    assert.notEqual(build("AAPL", STRAT, TRIG1), build("AAPL", STRAT, TRIG2));
  });

  it("different strategies emitting on the same trigger window → different ids", () => {
    assert.notEqual(
      build("AAPL", "strategy_a", TRIG1),
      build("AAPL", "strategy_b", TRIG1),
    );
  });

  it("different instruments → different ids", () => {
    assert.notEqual(build("AAPL", STRAT, TRIG1), build("MSFT", STRAT, TRIG1));
  });

  it("process restart evaluating the same trigger → identical clientOrderId", () => {
    const before = build("AAPL", STRAT, TRIG1);
    const rebuilt = new TradingLoopIdempotencyKeyBuilder().build({
      instrumentId: "AAPL",
      strategyId: STRAT,
      triggerId: TRIG1,
    });
    assert.equal(before, rebuilt);
  });
});

describe("TradingLoopIdempotencyKeyBuilder — versioning", () => {
  it("explicit version prefix is honoured", () => {
    const k = build("AAPL", STRAT, TRIG1, "v5");
    assert.equal(k.startsWith("loop:v5:AAPL:"), true);
  });

  it("v3 → v4 bump changes every key (invalidates persisted state)", () => {
    const v3 = build("AAPL", STRAT, TRIG1, "v3");
    const v4 = build("AAPL", STRAT, TRIG1, "v4");
    assert.notEqual(v3, v4);
  });
});

describe("TradingLoopIdempotencyKeyBuilder — validation", () => {
  for (const field of ["instrumentId", "strategyId", "triggerId"] as const) {
    it(`empty ${field} → throws`, () => {
      const input = {
        instrumentId: "AAPL",
        strategyId: STRAT,
        triggerId: TRIG1,
      } as { [k: string]: string };
      input[field] = "";
      assert.throws(
        () => new TradingLoopIdempotencyKeyBuilder().build(input as never),
        new RegExp(`${field} must be non-empty`),
      );
    });
  }

  it("triggerId with reserved ':' separator → throws (would break parsing)", () => {
    assert.throws(
      () =>
        new TradingLoopIdempotencyKeyBuilder().build({
          instrumentId: "AAPL",
          strategyId: STRAT,
          triggerId: "candle:1m:0",
        }),
      /triggerId must match/,
    );
  });
});
