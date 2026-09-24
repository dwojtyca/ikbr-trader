/**
 * PR15.3 hostile-review Finding 2 — seed-catalogue invariants after
 * the activation rollback.
 *
 * The initial PR15.3 draft flipped `es_front.executionEnabled=true`
 * and attached a full `executionPolicy` naming
 * `momentum_breakout_long_v1`. Hostile review surfaced that the
 * Phase 2 runtime does NOT execute
 * `MomentumBreakoutLongStrategy` (nor any other named strategy) —
 * the pipeline is a generic Decision + Risk composition that can
 * emit LONG or SHORT decisions under any policy label. Activating
 * the seed without wiring the real strategy would let a generic
 * decision claim the strategy's identity. See
 * PR15_3_PLAN.md r2 §11 for the mandatory integration step.
 *
 * Until r2 lands:
 *   - every seed MUST ship `executionEnabled=false`;
 *   - no seed MUST carry an `executionPolicy`;
 *   - `defaultInstrumentRegistry.listExecutionEnabled()` MUST return
 *     an empty array.
 *
 * If any of these invariants breaks, revert the offending change.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INSTRUMENT_DEFINITIONS,
  defaultInstrumentRegistry,
} from "./definitions.js";

const EXPECTED_IDS: readonly string[] = [
  "si_front",
  "gc_front",
  "pl_front",
  "hg_front",
  "es_front",
  "nq_front",
  "pko_wse",
  "aapl_nasdaq",
];

describe("Instrument seed catalogue — PR15.3 r2 invariants (activation rolled back)", () => {
  it("all original futures and disabled stock seeds are present", () => {
    const actual = INSTRUMENT_DEFINITIONS.map((i) => i.id).sort();
    assert.deepEqual(actual, EXPECTED_IDS.slice().sort());
  });

  it("every seed still ships with trading.executionEnabled=false", () => {
    for (const inst of INSTRUMENT_DEFINITIONS) {
      assert.equal(
        inst.trading.executionEnabled,
        false,
        `seed "${inst.id}" must stay executionEnabled=false until PR15.3 r2 lands`,
      );
    }
  });

  it("defaultInstrumentRegistry.listExecutionEnabled() is empty", () => {
    assert.equal(
      defaultInstrumentRegistry.listExecutionEnabled().length,
      0,
      "no shipped seed may be execution-enabled until real strategy integration lands (PR15.3 r2)",
    );
  });

  it("NO seed carries an executionPolicy (post-Finding 2 rollback)", () => {
    for (const inst of INSTRUMENT_DEFINITIONS) {
      assert.equal(
        inst.executionPolicy,
        undefined,
        `seed "${inst.id}" MUST NOT ship an executionPolicy — the` +
          ` runtime cannot authenticate its strategyId yet`,
      );
    }
  });

  it("es_front specifically is disabled and has NO executionPolicy", () => {
    const es = INSTRUMENT_DEFINITIONS.find((i) => i.id === "es_front");
    assert.ok(es, "es_front must remain in the catalogue");
    assert.equal(es!.trading.executionEnabled, false);
    assert.equal(es!.executionPolicy, undefined);
  });
});

 it("PKO is pinned, entirely inactive and conservatively sized", () => {
   const pko = defaultInstrumentRegistry.getInstrument("pko_wse")!;
   assert.equal(pko.assetClass, "stock");
   assert.equal(pko.conId, 35146360);
   assert.equal(pko.localSymbol, "PKO");
   assert.equal(pko.exchange, "WSE");
   assert.equal(pko.currency, "PLN");
   assert.ok(Object.values(pko.trading).every(value => value === false));
   assert.deepEqual(pko.risk, { maxQuantity: 1, quantityUnit: "shares", maxLeverage: 1,
     allowOvernight: false, maxSpread: 0.05, maxSlippage: 0.05 });
   assert.deepEqual(pko.session, { useRegularTradingHours: true, timezone: "Europe/Warsaw", sessionTemplate: "wse_stock_rth" });
   assert.equal(pko.roll, undefined);
   assert.equal(pko.executionPolicy, undefined);
 });
