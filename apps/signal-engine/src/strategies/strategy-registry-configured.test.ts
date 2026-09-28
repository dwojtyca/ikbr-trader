import assert from "node:assert/strict";
import test from "node:test";
import { MOMENTUM_CONFIGURATION_DEFAULTS_V1 } from "@ikbr/shared";
import { createConfiguredStrategy, createStrategy } from "./strategy-registry.js";
import { MomentumBreakoutLongStrategy } from "./momentum-breakout-long.strategy.js";

const instance = {
  id: "momentum_a",
  implementationId: "momentum_breakout_long_v1" as const,
  revision: 1,
  enabled: true,
  parameters: { ...MOMENTUM_CONFIGURATION_DEFAULTS_V1 },
};

test("configured factory returns fresh validated momentum instances", () => {
  const first = createConfiguredStrategy(instance);
  const second = createConfiguredStrategy(instance);
  assert.ok(first instanceof MomentumBreakoutLongStrategy);
  assert.notEqual(first, second);
  assert.throws(() => createConfiguredStrategy({ ...instance, parameters: { ...instance.parameters, rsiMax: 73 } }), /INVALID_MOMENTUM_PARAMETERS/);
});

test("configured factory rejects unsupported registered algorithms while legacy factory remains available", () => {
  for (const implementationId of ["momentum_breakdown_short_v1", "range_reversal_v1"] as const) {
    assert.ok(createStrategy(implementationId));
    assert.throws(() => createConfiguredStrategy({ ...instance, implementationId } as never), /UNSUPPORTED_IMPLEMENTATION/);
  }
});
