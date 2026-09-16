import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "@ikbr/shared";
import { FuturesFinalBarCoordinator } from "./futures-final-bar.js";

const provisional: Candle = { conid: "11", symbol: "ES", timeframe: "1m", ts: new Date("2026-06-01T22:00:00Z"), open: 1, high: 2, low: 1, close: 2, volume: 1 };
const future = { symbol: "ES", conid: "11", contract: { secType: "FUT" } };

describe("FUT native final-bar authority", () => {
  it("persists STK immediately without native confirmation", async () => {
    let confirms = 0; const saved: Candle[] = [];
    const coordinator = new FuturesFinalBarCoordinator(async () => { confirms += 1; return null; }, async (c) => { saved.push(c); }, { settlementDelayMs: 0, retryDelayMs: 0, maxAttempts: 1 });
    assert.equal(await coordinator.route({ ...provisional, symbol: "AAPL" }, { symbol: "AAPL", conid: "1", contract: { secType: "STK" } }), true);
    assert.equal(confirms, 0); assert.equal(saved.length, 1);
  });

  it("persists and triggers only the matching native FUT bar, once", async () => {
    const native = { ...provisional, open: 3, high: 4, close: 4 }; const saved: Candle[] = []; let confirms = 0;
    const coordinator = new FuturesFinalBarCoordinator(async () => { confirms += 1; return native; }, async (c) => { saved.push(c); }, { settlementDelayMs: 0, retryDelayMs: 0 });
    const [first, second] = await Promise.all([coordinator.route(provisional, future), coordinator.route(provisional, future)]);
    assert.equal(first, true); assert.equal(second, true); assert.equal(confirms, 1); assert.deepEqual(saved, [native]);
    assert.equal(await coordinator.route(provisional, future), false); assert.equal(saved.length, 1);
  });

  it("fails closed for absent, mismatched, and unsupported FUT confirmation", async () => {
    const saved: Candle[] = [];
    for (const result of [null, { ...provisional, conid: "99" }, { ...provisional, ts: new Date("2026-06-01T22:01:00Z") }]) {
      const coordinator = new FuturesFinalBarCoordinator(async () => result, async (c) => { saved.push(c); }, { settlementDelayMs: 0, retryDelayMs: 0, maxAttempts: 1 });
      assert.equal(await coordinator.route(provisional, future), false);
    }
    const coordinator = new FuturesFinalBarCoordinator(async () => provisional, async (c) => { saved.push(c); }, { settlementDelayMs: 0, retryDelayMs: 0 });
    assert.equal(await coordinator.route({ ...provisional, symbol: "NQ" }, { symbol: "NQ", conid: "12", contract: { secType: "FUT" } }), false);
    assert.equal(saved.length, 0);
  });

  it("retries a missing early response and rejects off-grid native OHLC", async () => {
    let attempts = 0; const saved: Candle[] = [];
    const coordinator = new FuturesFinalBarCoordinator(async () => {
      attempts += 1;
      return attempts === 1 ? null : { ...provisional, open: 1.25 };
    }, async (c) => { saved.push(c); }, { settlementDelayMs: 0, retryDelayMs: 0, maxAttempts: 3 });
    assert.equal(await coordinator.route(provisional, future), true);
    assert.equal(attempts, 2);
    const invalid = new FuturesFinalBarCoordinator(async () => ({ ...provisional, close: 1.1 }), async (c) => { saved.push(c); }, { settlementDelayMs: 0, retryDelayMs: 0, maxAttempts: 1 });
    assert.equal(await invalid.route(provisional, future), false);
  });

  it("does not retry a terminal no-data response", async () => {
    let attempts = 0;
    const terminal = Object.assign(new Error("no data"), { terminal: true });
    const coordinator = new FuturesFinalBarCoordinator(async () => { attempts += 1; throw terminal; }, async () => {}, {
      settlementDelayMs: 0, retryDelayMs: 0, maxAttempts: 3,
      isTerminalError: (error) => (error as { terminal?: boolean }).terminal === true,
    });
    assert.equal(await coordinator.route(provisional, future), false);
    assert.equal(attempts, 1);
  });
});
