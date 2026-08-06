import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INSTRUMENT_DEFINITIONS,
  defaultInstrumentRegistry,
} from "./definitions.js";
import { InstrumentRegistry } from "./registry.js";
import type { Instrument, InstrumentRoll } from "./types.js";

function makeFuture(overrides: Partial<Instrument> = {}): Instrument {
  const base: Instrument = {
    id: "test_fut",
    displayName: "Test Future",
    assetClass: "future",
    broker: "ibkr",
    brokerSymbol: "TF",
    exchange: "CME",
    currency: "USD",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    },
    risk: {
      maxQuantity: 1,
      quantityUnit: "contracts",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.25,
      maxSlippage: 0.5,
    },
    session: {
      useRegularTradingHours: false,
      timezone: "America/Chicago",
      sessionTemplate: "cme_equity_index",
    },
    roll: {
      rollStrategy: "calendar",
      rollDaysBeforeExpiry: 7,
    },
    metadata: { tags: [] },
  };
  return { ...base, ...overrides };
}

function makeStock(overrides: Partial<Instrument> = {}): Instrument {
  const base: Instrument = {
    id: "test_stk",
    displayName: "Test Stock",
    assetClass: "stock",
    broker: "ibkr",
    brokerSymbol: "AAPL",
    exchange: "SMART",
    primaryExchange: "NASDAQ",
    currency: "USD",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: false,
      aiAnalysisEnabled: false,
      monitoringEnabled: false,
    },
    risk: {
      maxQuantity: 100,
      quantityUnit: "shares",
      maxLeverage: 1,
      allowOvernight: true,
      maxSpread: 0.05,
      maxSlippage: 0.1,
    },
    session: {
      useRegularTradingHours: true,
      timezone: "America/New_York",
      sessionTemplate: "us_stock_rth",
    },
    metadata: { tags: [] },
  };
  return { ...base, ...overrides };
}

describe("InstrumentRegistry — constructor invariants", () => {
  it("accepts a valid mixed catalogue", () => {
    const reg = new InstrumentRegistry([makeFuture(), makeStock()]);
    assert.equal(reg.listAll().length, 2);
  });

  it("throws on duplicate instrument id", () => {
    assert.throws(
      () =>
        new InstrumentRegistry([
          makeFuture({ id: "dup", localSymbol: "TF_A" }),
          makeFuture({ id: "dup", localSymbol: "TF_B" }),
        ]),
      /duplicate instrument id "dup"/,
    );
  });

  it("throws on duplicate broker contract key (same tuple)", () => {
    assert.throws(
      () =>
        new InstrumentRegistry([
          makeFuture({ id: "a", brokerSymbol: "X" }),
          makeFuture({ id: "b", brokerSymbol: "X" }),
        ]),
      /duplicate broker contract key/,
    );
  });

  it("allows multiple futures with the same brokerSymbol but different localSymbol", () => {
    const front = makeFuture({
      id: "si_front",
      brokerSymbol: "SI",
      exchange: "COMEX",
      localSymbol: "SIZ26",
    });
    const back = makeFuture({
      id: "si_back",
      brokerSymbol: "SI",
      exchange: "COMEX",
      localSymbol: "SIH27",
    });
    const reg = new InstrumentRegistry([front, back]);
    assert.equal(reg.listAll().length, 2);
  });

  it("allows multiple futures with the same brokerSymbol but different conId", () => {
    const front = makeFuture({
      id: "es_front",
      brokerSymbol: "ES",
      exchange: "CME",
      conId: 111,
    });
    const back = makeFuture({
      id: "es_back",
      brokerSymbol: "ES",
      exchange: "CME",
      conId: 222,
    });
    const reg = new InstrumentRegistry([front, back]);
    assert.equal(reg.listAll().length, 2);
  });

  it("throws when a future has no roll section", () => {
    const bad: Instrument = { ...makeFuture(), roll: undefined };
    assert.throws(
      () => new InstrumentRegistry([bad]),
      /is a future but has no roll section/,
    );
  });

  it("throws when a non-future defines a roll section", () => {
    const bad: Instrument = {
      ...makeStock(),
      roll: { rollStrategy: "calendar", rollDaysBeforeExpiry: 7 },
    };
    assert.throws(
      () => new InstrumentRegistry([bad]),
      /is not a future .* but defines a roll section/,
    );
  });

  it("snapshots the input array so external mutations are ignored", () => {
    const arr: Instrument[] = [makeFuture()];
    const reg = new InstrumentRegistry(arr);
    arr.push(makeStock({ id: "extra" }));
    assert.equal(reg.listAll().length, 1);
    assert.equal(reg.getInstrument("extra"), undefined);
  });

  it("defensively clones so post-construction mutation of the source literal cannot poison the registry", () => {
    const mutableTrading = {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: true,
      monitoringEnabled: true,
    };
    const source: Instrument = { ...makeFuture(), trading: mutableTrading };
    const reg = new InstrumentRegistry([source]);
    mutableTrading.executionEnabled = true;
    assert.equal(
      reg.getInstrumentOrThrow("test_fut").trading.executionEnabled,
      false,
    );
  });
});

describe("InstrumentRegistry — lookups", () => {
  const reg = new InstrumentRegistry([
    makeFuture({ id: "a", brokerSymbol: "AA" }),
    makeStock({ id: "b", brokerSymbol: "BB" }),
  ]);

  it("getInstrument returns the instrument by id", () => {
    assert.equal(reg.getInstrument("a")?.id, "a");
  });

  it("getInstrument returns undefined for unknown id", () => {
    assert.equal(reg.getInstrument("missing"), undefined);
  });

  it("getInstrumentOrThrow throws for unknown id", () => {
    assert.throws(
      () => reg.getInstrumentOrThrow("missing"),
      /unknown instrument id "missing"/,
    );
  });

  it("getInstrumentOrThrow returns the instrument for known id", () => {
    assert.equal(reg.getInstrumentOrThrow("a").id, "a");
  });

  it("getByBrokerSymbol returns a frozen list of matches", () => {
    const matches = reg.getByBrokerSymbol("ibkr", "AA");
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, "a");
    assert.throws(() => {
      (matches as Instrument[]).push(matches[0]);
    });
  });

  it("getByBrokerSymbol returns an empty frozen list for unknown symbol", () => {
    const matches = reg.getByBrokerSymbol("ibkr", "ZZ");
    assert.equal(matches.length, 0);
    assert.throws(() => {
      (matches as Instrument[]).push(reg.listAll()[0]);
    });
  });

  it("getByBrokerSymbol is case-sensitive", () => {
    assert.equal(reg.getByBrokerSymbol("ibkr", "aa").length, 0);
  });
});

describe("InstrumentRegistry — multi-contract by brokerSymbol", () => {
  const siFront = makeFuture({
    id: "si_front",
    brokerSymbol: "SI",
    exchange: "COMEX",
    currency: "USD",
    localSymbol: "SIZ26",
    conId: 651111111,
  });
  const siBack = makeFuture({
    id: "si_back",
    brokerSymbol: "SI",
    exchange: "COMEX",
    currency: "USD",
    localSymbol: "SIH27",
    conId: 651222222,
  });
  const reg = new InstrumentRegistry([siFront, siBack]);

  it("getByBrokerSymbol returns every SI contract", () => {
    const matches = reg.getByBrokerSymbol("ibkr", "SI");
    assert.deepEqual(
      matches.map((i) => i.id),
      ["si_front", "si_back"],
    );
  });

  it("getByBrokerContract disambiguates by localSymbol", () => {
    const front = reg.getByBrokerContract({
      broker: "ibkr",
      brokerSymbol: "SI",
      exchange: "COMEX",
      currency: "USD",
      localSymbol: "SIZ26",
      conId: 651111111,
    });
    assert.equal(front?.id, "si_front");

    const back = reg.getByBrokerContract({
      broker: "ibkr",
      brokerSymbol: "SI",
      exchange: "COMEX",
      currency: "USD",
      localSymbol: "SIH27",
      conId: 651222222,
    });
    assert.equal(back?.id, "si_back");
  });

  it("getByBrokerContract returns undefined when disambiguators do not match", () => {
    const miss = reg.getByBrokerContract({
      broker: "ibkr",
      brokerSymbol: "SI",
      exchange: "COMEX",
      currency: "USD",
      localSymbol: "SIU28",
    });
    assert.equal(miss, undefined);
  });

  it("getByBrokerContract matches when both key and definition omit disambiguators", () => {
    const front = makeFuture({
      id: "front_only",
      brokerSymbol: "GC",
      exchange: "COMEX",
    });
    const registry = new InstrumentRegistry([front]);
    const found = registry.getByBrokerContract({
      broker: "ibkr",
      brokerSymbol: "GC",
      exchange: "COMEX",
      currency: "USD",
    });
    assert.equal(found?.id, "front_only");
  });
});

describe("InstrumentRegistry — runtime immutability (deep freeze)", () => {
  const reg = new InstrumentRegistry([
    makeFuture({ id: "frozen", brokerSymbol: "FZ" }),
  ]);
  const instrument = reg.getInstrumentOrThrow("frozen");

  it("top-level instrument object is frozen", () => {
    assert.equal(Object.isFrozen(instrument), true);
    assert.throws(() => {
      (instrument as { id: string }).id = "changed";
    });
  });

  it("trading section is frozen", () => {
    assert.equal(Object.isFrozen(instrument.trading), true);
    assert.throws(() => {
      (instrument.trading as { executionEnabled: boolean }).executionEnabled =
        true;
    });
  });

  it("risk section is frozen", () => {
    assert.equal(Object.isFrozen(instrument.risk), true);
    assert.throws(() => {
      (instrument.risk as { maxQuantity: number }).maxQuantity = 999;
    });
  });

  it("session section is frozen", () => {
    assert.equal(Object.isFrozen(instrument.session), true);
    assert.throws(() => {
      (instrument.session as { timezone: string }).timezone = "UTC";
    });
  });

  it("roll section is frozen when present", () => {
    assert.ok(instrument.roll);
    assert.equal(Object.isFrozen(instrument.roll), true);
    assert.throws(() => {
      (instrument.roll as InstrumentRoll as {
        rollDaysBeforeExpiry: number;
      }).rollDaysBeforeExpiry = 1;
    });
  });

  it("metadata section is frozen", () => {
    assert.equal(Object.isFrozen(instrument.metadata), true);
    assert.throws(() => {
      (instrument.metadata as { sector?: string }).sector = "override";
    });
  });

  it("metadata.tags array is frozen (no push / pop / splice)", () => {
    const withTags = new InstrumentRegistry([
      makeFuture({
        id: "tagged",
        brokerSymbol: "TG",
        metadata: { tags: ["a", "b"] },
      }),
    ]).getInstrumentOrThrow("tagged");

    assert.equal(Object.isFrozen(withTags.metadata.tags), true);
    assert.throws(() => {
      (withTags.metadata.tags as string[]).push("c");
    });
    assert.throws(() => {
      (withTags.metadata.tags as string[]).pop();
    });
  });
});

describe("InstrumentRegistry — list filters", () => {
  const execOnly = makeFuture({
    id: "exec",
    brokerSymbol: "EX",
    trading: {
      executionEnabled: true,
      signalGenerationEnabled: false,
      aiAnalysisEnabled: false,
      monitoringEnabled: false,
    },
  });
  const signalOnly = makeFuture({
    id: "sig",
    brokerSymbol: "SG",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: true,
      aiAnalysisEnabled: false,
      monitoringEnabled: false,
    },
  });
  const aiOnly = makeFuture({
    id: "ai",
    brokerSymbol: "AI",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: false,
      aiAnalysisEnabled: true,
      monitoringEnabled: false,
    },
  });
  const monitorOnly = makeFuture({
    id: "mon",
    brokerSymbol: "MO",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: false,
      aiAnalysisEnabled: false,
      monitoringEnabled: true,
    },
  });
  const disabled = makeFuture({
    id: "off",
    brokerSymbol: "OF",
    trading: {
      executionEnabled: false,
      signalGenerationEnabled: false,
      aiAnalysisEnabled: false,
      monitoringEnabled: false,
    },
  });
  const reg = new InstrumentRegistry([
    execOnly,
    signalOnly,
    aiOnly,
    monitorOnly,
    disabled,
  ]);

  it("listExecutionEnabled returns only executionEnabled instruments", () => {
    assert.deepEqual(
      reg.listExecutionEnabled().map((i) => i.id),
      ["exec"],
    );
  });

  it("listSignalEnabled returns only signalGenerationEnabled instruments", () => {
    assert.deepEqual(
      reg.listSignalEnabled().map((i) => i.id),
      ["sig"],
    );
  });

  it("listAiEnabled returns only aiAnalysisEnabled instruments", () => {
    assert.deepEqual(
      reg.listAiEnabled().map((i) => i.id),
      ["ai"],
    );
  });

  it("listMonitoringEnabled returns only monitoringEnabled instruments", () => {
    assert.deepEqual(
      reg.listMonitoringEnabled().map((i) => i.id),
      ["mon"],
    );
  });

  it("listAll returns every instrument in registration order", () => {
    assert.deepEqual(
      reg.listAll().map((i) => i.id),
      ["exec", "sig", "ai", "mon", "off"],
    );
  });

  it("list snapshots are frozen (cannot mutate registry state)", () => {
    const snapshot = reg.listExecutionEnabled();
    assert.throws(() => {
      (snapshot as Instrument[]).push(disabled);
    });
  });
});

describe("defaultInstrumentRegistry — Phase 1 seed catalogue", () => {
  it("contains all six seed instruments", () => {
    const ids = defaultInstrumentRegistry.listAll().map((i) => i.id);
    assert.deepEqual(ids, [
      "si_front",
      "gc_front",
      "pl_front",
      "hg_front",
      "es_front",
      "nq_front",
    ]);
  });

  it("exposes each seed via getByBrokerSymbol('ibkr', ...)", () => {
    for (const symbol of ["SI", "GC", "PL", "HG", "ES", "NQ"]) {
      const matches = defaultInstrumentRegistry.getByBrokerSymbol(
        "ibkr",
        symbol,
      );
      assert.equal(matches.length, 1, `expected exactly one ${symbol} entry`);
      assert.equal(matches[0].brokerSymbol, symbol);
    }
  });

  it("ships with executionEnabled=false on every seed (opt-in)", () => {
    // PR15.3 hostile-review Finding 2 — activation ROLLED BACK.
    // Real strategy-registry integration is required before any
    // seed may ship execution-enabled (see PR15_3_PLAN.md r2 §11).
    for (const instrument of defaultInstrumentRegistry.listAll()) {
      assert.equal(
        instrument.trading.executionEnabled,
        false,
        `${instrument.id} must ship with executionEnabled=false`,
      );
    }
    assert.equal(defaultInstrumentRegistry.listExecutionEnabled().length, 0);
  });

  it("classifies every seed as a future with a roll policy", () => {
    for (const instrument of defaultInstrumentRegistry.listAll()) {
      assert.equal(instrument.assetClass, "future");
      assert.ok(
        instrument.roll,
        `${instrument.id} must define a roll section`,
      );
      assert.equal(instrument.roll?.rollStrategy, "calendar");
      assert.equal(instrument.roll?.rollDaysBeforeExpiry, 7);
    }
  });

  it("sizes every seed in contracts (integer counts, not notional)", () => {
    for (const instrument of defaultInstrumentRegistry.listAll()) {
      assert.equal(instrument.risk.quantityUnit, "contracts");
      assert.ok(
        Number.isInteger(instrument.risk.maxQuantity),
        `${instrument.id}.risk.maxQuantity must be an integer`,
      );
      assert.ok(
        instrument.risk.maxQuantity > 0,
        `${instrument.id}.risk.maxQuantity must be positive`,
      );
    }
  });

  it("enables signal + AI + monitoring by default (execution stays off)", () => {
    for (const instrument of defaultInstrumentRegistry.listAll()) {
      assert.equal(instrument.trading.signalGenerationEnabled, true);
      assert.equal(instrument.trading.aiAnalysisEnabled, true);
      assert.equal(instrument.trading.monitoringEnabled, true);
    }
  });

  it("uses cme_metals template for metals and cme_equity_index for indices", () => {
    const templates = new Map(
      defaultInstrumentRegistry
        .listAll()
        .map((i) => [i.id, i.session.sessionTemplate]),
    );
    assert.equal(templates.get("si_front"), "cme_metals");
    assert.equal(templates.get("gc_front"), "cme_metals");
    assert.equal(templates.get("pl_front"), "cme_metals");
    assert.equal(templates.get("hg_front"), "cme_metals");
    assert.equal(templates.get("es_front"), "cme_equity_index");
    assert.equal(templates.get("nq_front"), "cme_equity_index");
  });

  it("re-exports the raw definitions in the same order", () => {
    assert.deepEqual(
      INSTRUMENT_DEFINITIONS.map((i) => i.id),
      defaultInstrumentRegistry.listAll().map((i) => i.id),
    );
  });
});
