import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultInstrumentRegistry } from "@ikbr/shared";
import { legacyProducerOwnsSymbol } from "./legacy-producer-scope.js";

const seed = defaultInstrumentRegistry.listAll()[0];
const bound = { ...seed, brokerSymbol: "TEST", trading: { ...seed.trading, executionEnabled: true } };

test("legacy producer suppresses a symbol owned by execution-enabled runtime case-insensitively", () => {
  assert.equal(legacyProducerOwnsSymbol([bound], "TEST"), false);
  assert.equal(legacyProducerOwnsSymbol([bound], "test"), false);
  assert.equal(legacyProducerOwnsSymbol([{ ...bound, brokerSymbol: "test" }], "TeSt"), false);
});
test("disabled execution and unrelated symbols remain available to legacy producer", () => {
  const disabled = { ...bound, trading: { ...bound.trading, executionEnabled: false } };
  assert.equal(legacyProducerOwnsSymbol([disabled], "TEST"), true);
  assert.equal(legacyProducerOwnsSymbol([bound], "OTHER"), true);
  assert.equal(legacyProducerOwnsSymbol([], "TEST"), true);
  assert.equal(legacyProducerOwnsSymbol([disabled, bound], "TEST"), false);
});
