import test from "node:test";
import assert from "node:assert/strict";
import { formatStrategyAttribution } from "./strategy-attribution.js";

test("historical absence stays visibly legacy without current-instance inference", () => {
  assert.equal(formatStrategyAttribution(), "Legacy · attribution unavailable");
  assert.equal(formatStrategyAttribution(null), "Legacy · attribution unavailable");
});
test("attributed details retain original algorithm, instance, revision and hashes", () => {
  assert.equal(formatStrategyAttribution({ version: 1, implementationId: "momentum_breakout_long_v1",
    instanceId: "old_removed_instance", instanceRevision: 4, instrumentId: "aapl_smart",
    instanceHash: "a".repeat(64), effectiveConfigHash: "b".repeat(64) }),
  "momentum_breakout_long_v1 · old_removed_instance · revision 4 · aaaaaaaaaaaa · config bbbbbbbbbbbb");
});
