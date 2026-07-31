/**
 * PR15.2 — `BindingAwareContractResolver` unit tests.
 *
 * The wrapper is a pure branch: bound instruments resolve to the
 * exact operator-selected `conId`; unbound instruments fall
 * through to the inner resolver's Postgres lookup. There is NO
 * symbol-only fallback for a bound futures instrument — even
 * when the inner resolver would happily return a stale
 * `instrument_contracts` row.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InstrumentBindingAuthority,
  defaultInstrumentRegistry,
  type BoundInstrument,
  type Instrument,
} from "@ikbr/shared";

import {
  BindingAwareContractResolver,
  type ContractResolver,
} from "./market-data-reader.js";

const ES = defaultInstrumentRegistry.getInstrumentOrThrow("es_front");

function makeAuthority(conId = 424_242): InstrumentBindingAuthority {
  return new InstrumentBindingAuthority(defaultInstrumentRegistry, [
    {
      instrumentId: "es_front",
      conId,
      localSymbol: "ESU6",
      tradingClass: "ES",
      exchange: "CME",
      currency: "USD",
      minTick: 0.25,
    },
  ]);
}

function makeInnerResolver(returned: string | null): {
  calls: number;
  resolver: ContractResolver;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    resolver: {
      async resolveConid(instrument: Instrument) {
        calls += 1;
        void instrument;
        return returned;
      },
    },
  };
}

describe("BindingAwareContractResolver", () => {
  it("bound instrument → returns the bound conId (no inner call)", async () => {
    const authority = makeAuthority();
    const inner = makeInnerResolver("999");
    const wrapper = new BindingAwareContractResolver({
      resolveBound: (id) => authority.getBoundInstrument(id),
      inner: inner.resolver,
    });
    const result = await wrapper.resolveConid(ES);
    assert.equal(result, "424242");
    assert.equal(inner.calls, 0, "inner resolver must NOT be consulted for a bound instrument");
  });

  it("unbound instrument → delegates to inner resolver", async () => {
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      [],
    );
    const inner = makeInnerResolver("555");
    const wrapper = new BindingAwareContractResolver({
      resolveBound: (id) => authority.getBoundInstrument(id),
      inner: inner.resolver,
    });
    const gc = defaultInstrumentRegistry.getInstrumentOrThrow("gc_front");
    const result = await wrapper.resolveConid(gc);
    assert.equal(result, "555");
    assert.equal(inner.calls, 1);
  });

  it("binding change → resolver returns the new conId on the next call", async () => {
    const authorityBefore = makeAuthority(111);
    const authorityAfter = makeAuthority(222);
    let current: InstrumentBindingAuthority = authorityBefore;
    const inner = makeInnerResolver(null);
    const wrapper = new BindingAwareContractResolver({
      resolveBound: (id) => current.getBoundInstrument(id),
      inner: inner.resolver,
    });
    assert.equal(await wrapper.resolveConid(ES), "111");
    // Simulate an operator restart that swaps the authority.
    current = authorityAfter;
    assert.equal(await wrapper.resolveConid(ES), "222");
  });

  it("bound view remains frozen — resolver never mutates it", async () => {
    const authority = makeAuthority();
    const inner = makeInnerResolver(null);
    const wrapper = new BindingAwareContractResolver({
      resolveBound: (id) => authority.getBoundInstrument(id),
      inner: inner.resolver,
    });
    await wrapper.resolveConid(ES);
    const bound: BoundInstrument | undefined =
      authority.getBoundInstrument("es_front");
    assert.ok(bound);
    assert.equal(Object.isFrozen(bound), true);
  });
});
