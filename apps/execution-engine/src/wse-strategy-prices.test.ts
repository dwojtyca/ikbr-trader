import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWseStrategyLevels } from "@ikbr/shared";
import { wseTestBound, wseMetadataFixture } from "./wse-market-rules.fixture.js";
const now = Date.parse("2026-09-24T10:00:00Z");
function metadata() { return { ...wseMetadataFixture(wseTestBound, "DU-TEST", now), priceIncrements: [{ lowEdge: 0, increment: 0.01 }, { lowEdge: 100, increment: 0.05 }] }; }
test("strategy entry stop and target use their own bands before AI", () => {
  const raw = { entry: 100.039, stopLoss: 99.997, takeProfit: 100.051 };
  const result = normalizeWseStrategyLevels(metadata(), wseTestBound, "DU-TEST", raw, now);
  assert.deepEqual(result.final, { entry: 100, stopLoss: 99.99, takeProfit: 100.1 });
  assert.deepEqual(result.raw, raw);
  assert.ok(Object.isFrozen(result.metadata));
});
test("upward crossing selects first valid price in next band", () => {
  const result = normalizeWseStrategyLevels(metadata(), wseTestBound, "DU-TEST", { entry: 99.98, stopLoss: 99.9, takeProfit: 99.999 }, now);
  assert.equal(result.final.takeProfit, 100);
});
for (const kind of ["missing", "collapse", "stale", "account", "contract", "closed", "bands"] as const) test(`strategy levels reject ${kind}`, () => {
  const m = metadata(); let raw = { entry: 100.039, stopLoss: 99.997, takeProfit: 100.051 };
  if (kind === "missing") raw.entry = NaN;
  if (kind === "collapse") raw = { entry: 100.02, stopLoss: 100.01, takeProfit: 101 };
  if (kind === "stale") m.requestStartedAtMs = now - 60000;
  if (kind === "account") m.accountId = "FOREIGN";
  if (kind === "contract") m.conId = 1;
  if (kind === "closed") m.liquidHours = "20260924:CLOSED";
  if (kind === "bands") m.priceIncrements.reverse();
  assert.throws(() => normalizeWseStrategyLevels(m, wseTestBound, "DU-TEST", raw, now));
});
