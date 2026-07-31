/**
 * PR15.2 — regression test: every shipped seed instrument
 * remains `trading.executionEnabled=false`.
 *
 * PR15.2 introduces the authoritative binding layer but does NOT
 * flip any seed's execution flag. Flipping is reserved for
 * PR15.3 (single Paper instrument) and can never happen as a
 * side-effect of a docs / config / test change. If this test
 * fails, someone likely turned a seed on — revert.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INSTRUMENT_DEFINITIONS,
  defaultInstrumentRegistry,
} from "./definitions.js";

describe("Instrument seed catalogue — executionEnabled invariant (PR15.2)", () => {
  it("every seed definition still has trading.executionEnabled = false", () => {
    for (const inst of INSTRUMENT_DEFINITIONS) {
      assert.equal(
        inst.trading.executionEnabled,
        false,
        `seed "${inst.id}" must ship with executionEnabled=false`,
      );
    }
  });

  it("defaultInstrumentRegistry.listExecutionEnabled() is empty", () => {
    assert.equal(
      defaultInstrumentRegistry.listExecutionEnabled().length,
      0,
      "no shipped seed may be execution-enabled by default",
    );
  });

  it("all six seed IDs are present (PR15.2 must not remove any)", () => {
    const expected = [
      "si_front",
      "gc_front",
      "pl_front",
      "hg_front",
      "es_front",
      "nq_front",
    ];
    const actual = INSTRUMENT_DEFINITIONS.map((i) => i.id).sort();
    assert.deepEqual(actual, expected.slice().sort());
  });
});
