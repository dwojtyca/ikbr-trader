/**
 * PR15.2 — shared `InstrumentBindingAuthority` unit tests.
 *
 * Covers: parser + authority invariants, malformed JSON,
 * unknown / duplicate ids, duplicate conIds, tuple mismatches
 * with the registry, runtime immutability, and the base
 * registry staying untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InstrumentBindingAuthority,
  buildInstrumentBindingAuthority,
  parseInstrumentBindings,
} from "./bindings.js";
import { defaultInstrumentRegistry } from "./definitions.js";

// A representative binding for `es_front`. NOT a real IBKR
// contract — a synthetic conId chosen to avoid ever pointing at a
// live front-month during test replays.
const VALID_ES_BINDING = {
  instrumentId: "es_front",
  conId: 1_000_000_001,
  localSymbol: "ESU6",
  tradingClass: "ES",
  exchange: "CME",
  currency: "USD",
  minTick: 0.25,
};

const VALID_GC_BINDING = {
  instrumentId: "gc_front",
  conId: 1_000_000_002,
  localSymbol: "GCZ6",
  tradingClass: "GC",
  exchange: "COMEX",
  currency: "USD",
  minTick: 0.1,
};

describe("parseInstrumentBindings — happy paths", () => {
  it("empty string → empty binding list", () => {
    const r = parseInstrumentBindings("", defaultInstrumentRegistry);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.bindings.length, 0);
  });

  it("undefined / null / empty array → empty binding list", () => {
    for (const value of [undefined, null, "[]", []] as const) {
      const r = parseInstrumentBindings(value, defaultInstrumentRegistry);
      assert.equal(r.ok, true, `input=${JSON.stringify(value)}`);
      if (r.ok) assert.equal(r.bindings.length, 0);
    }
  });

  it("single valid entry parses", () => {
    const r = parseInstrumentBindings(
      JSON.stringify([VALID_ES_BINDING]),
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.bindings.length, 1);
      const b = r.bindings[0];
      assert.equal(b.instrumentId, "es_front");
      assert.equal(b.conId, 1_000_000_001);
      assert.equal(b.localSymbol, "ESU6");
      assert.equal(b.exchange, "CME");
      assert.equal(b.currency, "USD");
      assert.equal(b.tradingClass, "ES");
      assert.equal(b.broker, "ibkr");
      assert.equal(b.minTick, 0.25);
    }
  });

  it("pre-decoded object (not a JSON string) also parses", () => {
    const r = parseInstrumentBindings(
      [VALID_ES_BINDING],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, true);
  });

  it("currency is upper-cased to canonical form", () => {
    const r = parseInstrumentBindings(
      [{ ...VALID_ES_BINDING, currency: "usd" }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.bindings[0].currency, "USD");
  });
});

describe("parseInstrumentBindings — malformed / hostile input", () => {
  it("malformed JSON → single error, empty bindings", () => {
    const r = parseInstrumentBindings("[{", defaultInstrumentRegistry);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0].message, /malformed JSON/i);
    }
  });

  it("top-level non-array → rejected", () => {
    const r = parseInstrumentBindings("{}", defaultInstrumentRegistry);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.errors[0].message, /must decode to an array/i);
    }
  });

  it("entry is not an object → rejected with index", () => {
    const r = parseInstrumentBindings("[1]", defaultInstrumentRegistry);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors[0].index, 0);
      assert.match(r.errors[0].message, /entry must be an object/i);
    }
  });

  it("unknown instrumentId → rejected", () => {
    const r = parseInstrumentBindings(
      [{ ...VALID_ES_BINDING, instrumentId: "not_a_real_id" }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.errors[0].message, /not registered/i);
    }
  });

  it("non-positive / non-integer conId → rejected", () => {
    for (const conId of [0, -1, 1.5, Number.NaN, "123" as unknown as number]) {
      const r = parseInstrumentBindings(
        [{ ...VALID_ES_BINDING, conId }],
        defaultInstrumentRegistry,
      );
      assert.equal(r.ok, false, `conId=${String(conId)}`);
      if (!r.ok) assert.match(r.errors[0].message, /positive safe integer/i);
    }
  });

  it("blank string / whitespace fields → rejected", () => {
    for (const key of [
      "localSymbol",
      "tradingClass",
      "exchange",
      "currency",
    ] as const) {
      const r = parseInstrumentBindings(
        [{ ...VALID_ES_BINDING, [key]: "   " }],
        defaultInstrumentRegistry,
      );
      assert.equal(r.ok, false, `blank ${key}`);
    }
  });

  it("tuple mismatch: wrong exchange → rejected", () => {
    const r = parseInstrumentBindings(
      [{ ...VALID_ES_BINDING, exchange: "NYSE" }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0].message, /exchange/);
  });

  it("tuple mismatch: wrong currency → rejected", () => {
    const r = parseInstrumentBindings(
      [{ ...VALID_ES_BINDING, currency: "EUR" }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0].message, /currency/);
  });

  it("tuple mismatch: wrong tradingClass → rejected", () => {
    const r = parseInstrumentBindings(
      [{ ...VALID_ES_BINDING, tradingClass: "MES" }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0].message, /tradingClass/);
  });

  it("tuple mismatch: unknown broker → rejected", () => {
    const r = parseInstrumentBindings(
      [{ ...VALID_ES_BINDING, broker: "not-a-broker" }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0].message, /broker/i);
  });

  it("duplicate instrumentId across bindings → rejected", () => {
    const r = parseInstrumentBindings(
      [VALID_ES_BINDING, { ...VALID_ES_BINDING, conId: 2_000_000_001 }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0].message, /duplicate instrumentId/i);
  });

  it("duplicate conId across bindings → rejected", () => {
    const r = parseInstrumentBindings(
      [VALID_ES_BINDING, { ...VALID_GC_BINDING, conId: VALID_ES_BINDING.conId }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0].message, /duplicate conId/);
  });

  it("errors do not leak raw payload — only index + reason", () => {
    const r = parseInstrumentBindings(
      "SECRET_TOKEN_" + "x".repeat(64),
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      const serialised = JSON.stringify(r.errors);
      assert.equal(
        serialised.includes("SECRET_TOKEN_"),
        false,
        "parser errors must not echo the raw configuration payload",
      );
    }
  });
});

describe("InstrumentBindingAuthority — construction + lookup", () => {
  it("valid bindings → deterministic lookup by id", () => {
    const parsed = parseInstrumentBindings(
      [VALID_ES_BINDING, VALID_GC_BINDING],
      defaultInstrumentRegistry,
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("unreachable");
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      parsed.bindings,
    );
    const bound = authority.getBoundInstrument("es_front");
    assert.ok(bound);
    assert.equal(bound!.conId, VALID_ES_BINDING.conId);
    assert.equal(bound!.brokerSymbol, "ES");
    assert.equal(authority.hasBinding("gc_front"), true);
    assert.equal(authority.hasBinding("si_front"), false);
    assert.deepEqual(
      [...authority.listBoundInstrumentIds()].sort(),
      ["es_front", "gc_front"],
    );
  });

  it("lookup by conId returns the same bound view", () => {
    const parsed = parseInstrumentBindings(
      [VALID_ES_BINDING],
      defaultInstrumentRegistry,
    );
    if (!parsed.ok) throw new Error("parse failed");
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      parsed.bindings,
    );
    const byId = authority.getBoundInstrument("es_front");
    const byConId = authority.getBoundInstrumentByConId(VALID_ES_BINDING.conId);
    assert.equal(byId, byConId);
  });

  it("returned BoundInstrument is deep-frozen", () => {
    const parsed = parseInstrumentBindings(
      [VALID_ES_BINDING],
      defaultInstrumentRegistry,
    );
    if (!parsed.ok) throw new Error("parse failed");
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      parsed.bindings,
    );
    const bound = authority.getBoundInstrument("es_front")!;
    assert.equal(Object.isFrozen(bound), true);
    assert.throws(
      () => {
        (bound as unknown as { conId: number }).conId = 999;
      },
      TypeError,
      "mutating conId must throw in strict mode",
    );
  });

  it("no symbol fallback — unknown id returns undefined even when brokerSymbol matches a registry entry", () => {
    const parsed = parseInstrumentBindings(
      [VALID_ES_BINDING],
      defaultInstrumentRegistry,
    );
    if (!parsed.ok) throw new Error("parse failed");
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      parsed.bindings,
    );
    // `si_front` is a known registry id but was not bound.
    assert.equal(authority.getBoundInstrument("si_front"), undefined);
  });

  it("construction rejects direct duplicate id from callers bypassing the parser", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          {
            instrumentId: "es_front",
            conId: 100,
            localSymbol: "ESU6",
            tradingClass: "ES",
            exchange: "CME",
            currency: "USD",
            minTick: 0.25,
          },
          {
            instrumentId: "es_front",
            conId: 101,
            localSymbol: "ESZ6",
            tradingClass: "ES",
            exchange: "CME",
            currency: "USD",
            minTick: 0.25,
          },
        ]),
      /duplicate instrumentId/i,
    );
  });

  it("construction rejects direct duplicate conId from callers bypassing the parser", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          {
            instrumentId: "es_front",
            conId: 200,
            localSymbol: "ESU6",
            tradingClass: "ES",
            exchange: "CME",
            currency: "USD",
            minTick: 0.25,
          },
          {
            instrumentId: "gc_front",
            conId: 200,
            localSymbol: "GCZ6",
            tradingClass: "GC",
            exchange: "COMEX",
            currency: "USD",
            minTick: 0.1,
          },
        ]),
      /duplicate conId/i,
    );
  });

  it("base registry stays untouched (structural equality of listAll() snapshot)", () => {
    const before = defaultInstrumentRegistry.listAll();
    const parsed = parseInstrumentBindings(
      [VALID_ES_BINDING],
      defaultInstrumentRegistry,
    );
    if (!parsed.ok) throw new Error("parse failed");
    const _authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      parsed.bindings,
    );
    void _authority;
    const after = defaultInstrumentRegistry.listAll();
    assert.equal(before, after, "listAll() must return the same frozen snapshot");
    // Also: instruments themselves are still frozen.
    for (const inst of after) {
      assert.equal(Object.isFrozen(inst), true);
    }
  });

  it("toDiagnostics() exposes only ids + count (no raw config)", () => {
    const parsed = parseInstrumentBindings(
      [VALID_ES_BINDING],
      defaultInstrumentRegistry,
    );
    if (!parsed.ok) throw new Error("parse failed");
    const authority = new InstrumentBindingAuthority(
      defaultInstrumentRegistry,
      parsed.bindings,
    );
    const diag = authority.toDiagnostics();
    assert.deepEqual(Object.keys(diag).sort(), ["boundCount", "ids"]);
    assert.equal(diag.boundCount, 1);
    assert.deepEqual(diag.ids, ["es_front"]);
  });
});

describe("buildInstrumentBindingAuthority — one-shot factory", () => {
  it("returns { ok: true, authority } on valid input", () => {
    const r = buildInstrumentBindingAuthority(
      [VALID_ES_BINDING],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(r.authority.getBoundInstrument("es_front"));
    }
  });

  it("returns { ok: false, errors } on parse failure", () => {
    const r = buildInstrumentBindingAuthority(
      "[{",
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors.length, 1);
  });
});

describe("parseInstrumentBindings — minTick validation (PR15.2 hostile review)", () => {
  it("missing minTick → rejected", () => {
    const { minTick: _unused, ...withoutMinTick } = VALID_ES_BINDING;
    void _unused;
    const r = parseInstrumentBindings(
      [withoutMinTick],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0].message, /minTick/);
  });

  it("non-positive / non-finite minTick → rejected", () => {
    for (const minTick of [0, -0.25, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = parseInstrumentBindings(
        [{ ...VALID_ES_BINDING, minTick }],
        defaultInstrumentRegistry,
      );
      assert.equal(r.ok, false, `minTick=${minTick}`);
      if (!r.ok) assert.match(r.errors[0].message, /minTick/);
    }
  });

  it("string minTick (even if numeric) → rejected", () => {
    const r = parseInstrumentBindings(
      [{ ...VALID_ES_BINDING, minTick: "0.25" as unknown as number }],
      defaultInstrumentRegistry,
    );
    assert.equal(r.ok, false);
  });
});

describe("InstrumentBindingAuthority — constructor hardening (PR15.2 hostile review)", () => {
  it("rejects non-positive conId even when parser is bypassed", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, conId: -1 },
        ]),
      /positive safe integer/i,
    );
  });

  it("rejects non-integer conId", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, conId: 1.5 },
        ]),
      /positive safe integer/i,
    );
  });

  it("rejects non-positive minTick", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, minTick: 0 },
        ]),
      /minTick/i,
    );
  });

  it("rejects non-finite minTick", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, minTick: Number.NaN },
        ]),
      /minTick/i,
    );
  });

  it("rejects empty canonical fields", () => {
    for (const key of [
      "localSymbol",
      "tradingClass",
      "exchange",
      "currency",
    ] as const) {
      assert.throws(
        () =>
          new InstrumentBindingAuthority(defaultInstrumentRegistry, [
            { ...VALID_ES_BINDING, [key]: "   " },
          ]),
        new RegExp(`${key}`, "i"),
      );
    }
  });

  it("rejects registry mismatch (exchange)", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, exchange: "NYSE" },
        ]),
      /exchange/i,
    );
  });

  it("rejects registry mismatch (currency)", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, currency: "EUR" },
        ]),
      /currency/i,
    );
  });

  it("rejects registry mismatch (tradingClass)", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, tradingClass: "MES" },
        ]),
      /tradingClass/i,
    );
  });

  it("rejects unknown instrumentId", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(defaultInstrumentRegistry, [
          { ...VALID_ES_BINDING, instrumentId: "not_registered" },
        ]),
      /not registered/i,
    );
  });

  it("rejects non-array input", () => {
    assert.throws(
      () =>
        new InstrumentBindingAuthority(
          defaultInstrumentRegistry,
          {} as unknown as ReadonlyArray<Parameters<
            typeof parseInstrumentBindings
          >[0] extends readonly (infer T)[]
            ? T
            : never>,
        ),
      /must be an array/i,
    );
  });
});

describe("mapAssetClassToIbkrSecType (PR15.2 hostile-review round-3)", () => {
  it("future → FUT", async () => {
    const { mapAssetClassToIbkrSecType } = await import("./bindings.js");
    assert.equal(mapAssetClassToIbkrSecType("future"), "FUT");
  });

  it("stock and etf → STK", async () => {
    const { mapAssetClassToIbkrSecType } = await import("./bindings.js");
    assert.equal(mapAssetClassToIbkrSecType("stock"), "STK");
    assert.equal(mapAssetClassToIbkrSecType("etf"), "STK");
  });

  it("index → IND", async () => {
    const { mapAssetClassToIbkrSecType } = await import("./bindings.js");
    assert.equal(mapAssetClassToIbkrSecType("index"), "IND");
  });

  it("forex → CASH", async () => {
    const { mapAssetClassToIbkrSecType } = await import("./bindings.js");
    assert.equal(mapAssetClassToIbkrSecType("forex"), "CASH");
  });

  it("option → OPT", async () => {
    const { mapAssetClassToIbkrSecType } = await import("./bindings.js");
    assert.equal(mapAssetClassToIbkrSecType("option"), "OPT");
  });

  it("crypto → CRYPTO", async () => {
    const { mapAssetClassToIbkrSecType } = await import("./bindings.js");
    assert.equal(mapAssetClassToIbkrSecType("crypto"), "CRYPTO");
  });

  it("exhaustive over the union — every seed asset class is covered", async () => {
    const { mapAssetClassToIbkrSecType } = await import("./bindings.js");
    const seedClasses = new Set(
      defaultInstrumentRegistry.listAll().map((i) => i.assetClass),
    );
    for (const cls of seedClasses) {
      assert.ok(
        mapAssetClassToIbkrSecType(cls),
        `assetClass ${cls} must map to a non-empty secType`,
      );
    }
  });
});

const PINNED_PKO_BINDING = { instrumentId: "pko_wse", conId: 35146360,
  localSymbol: "PKO", tradingClass: "PKO", exchange: "WSE", currency: "PLN", minTick: 0.0001 };

describe("pinned stock registry identity", () => {
  it("accepts exact identity without activating the stock", () => {
    const result = buildInstrumentBindingAuthority([PINNED_PKO_BINDING], defaultInstrumentRegistry);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.authority.getBoundInstrument("pko_wse")?.instrument.trading.executionEnabled, false);
  });
  for (const [field, value] of [["conId", 35146361], ["localSymbol", "OTHER"]] as const) {
    it(`parser and direct authority reject replacement ${field}`, () => {
      const binding = { ...PINNED_PKO_BINDING, [field]: value };
      const parsed = parseInstrumentBindings([binding], defaultInstrumentRegistry);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.match(parsed.errors[0].message, new RegExp(`${field} does not match pinned`));
      assert.throws(() => new InstrumentBindingAuthority(defaultInstrumentRegistry, [binding]), new RegExp(`${field} does not match pinned`));
    });
  }
});
