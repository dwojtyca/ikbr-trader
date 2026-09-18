import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Candle } from "@ikbr/shared";
import type { BacktestRepository } from "./repository.js";
import { BacktestSimulator, type SimulatorOptions } from "./simulator.js";
import type { BacktestFillRecord, LoadedBacktestData } from "./types.js";
import { CME_EQUITY_INDEX_2024_2026 } from "./cme-equity-index-calendar.js";

const candle = (conid: string, iso: string, values: Partial<Candle> = {}): Candle => ({
  symbol: "ES", conid, timeframe: "1m", ts: new Date(iso),
  open: 100, high: 106, low: 94, close: 101, volume: 100, ...values,
});

const options = (patch: Partial<SimulatorOptions> = {}): SimulatorOptions => ({
  minCandles: 1, maxSpreadBps: 100, minVolume1m: 0, minConfidence: 0,
  lmtEntryMode: "touch", lmtEntryBufferBps: 0, fractionalSymbols: new Set(),
  fractionalQuantityStep: 1, minStopBpsBySecType: { STK: 0, FUT: 0 },
  baseCurrency: "USD", currencyBySymbol: { ES: "USD" }, secTypeBySymbol: { ES: "STK" },
  priceMultiplierBySymbol: {}, strategyCooldownMs: 1, commissionBps: 0,
  commissionPerShare: 0, commissionMinPerSide: 0, commissionPassthroughBps: 0,
  syntheticSpreadBps: 0, orderTtlCandles: 1, strategyIds: [],
  futuresSpecs: new Map(), futuresContracts: new Map(), futuresCalendars: new Map(),
  riskLimits: { accountEquity: 100_000, maxRiskPerTradePct: 1,
    maxExposurePct: 100, maxNotionalPerTradePct: 100, maxOpenPositions: 10 },
  ...patch,
});

const data = (candles1m: Candle[], candles1h: Candle[] = []): LoadedBacktestData => ({
  dataset: { id: 1, dateFrom: "2026-01-01T00:00:00.000Z", dateTo: "2026-12-31T00:00:00.000Z",
    status: "ready", symbols: ["ES"], candlesCount: candles1m.length, startedAt: "2026-01-01T00:00:00.000Z" },
  candles1m: new Map([["ES", candles1m]]), candles5m: new Map(),
  candles1h: new Map([["ES", candles1h]]), candles4h: new Map(), candles12h: new Map(),
  candles1d: new Map(), candles1w: new Map(), candleCount1m: candles1m.length, fxRates: [],
});

type SimulatorLookupInternals = {
  candles1mBySymbol: Map<string, Candle[]>;
  candlesByTimeframe: Record<Candle["timeframe"], Map<string, Candle[]>>;
  currentIndexBySymbol: Map<string, number>;
  futuresCalendarBySymbol: Map<string, { completedAt(ts: Date, timeframe: Candle["timeframe"]): Date }>;
  currentTime?: Date;
  currentCandle?: Candle;
  options: SimulatorOptions;
};

function referenceRecentCandles(
  simulator: BacktestSimulator,
  symbol: string,
  timeframe: Candle["timeframe"],
  limit: number,
): Candle[] {
  const state = simulator as unknown as SimulatorLookupInternals;
  const key = symbol.toUpperCase();
  if (timeframe === "1m") {
    const rows = state.candles1mBySymbol.get(key) ?? [];
    const index = state.currentIndexBySymbol.get(key) ?? -1;
    if (index < 0) return [];
    const currentConid = state.currentCandle?.symbol.toUpperCase() === key
      ? state.currentCandle.conid : rows[index]?.conid;
    return rows.slice(0, index + 1).filter((row) => row.conid === currentConid).slice(-limit);
  }
  const rows = state.candlesByTimeframe[timeframe].get(key) ?? [];
  const evaluationTime = state.currentTime ?? new Date(0);
  const durationMs = {
    "5m": 5 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000,
    "12h": 12 * 60 * 60_000, "1d": 24 * 60 * 60_000, "1w": 7 * 24 * 60 * 60_000,
  }[timeframe];
  const currentConid = state.currentCandle?.symbol.toUpperCase() === key
    ? state.currentCandle.conid : undefined;
  const calendar = state.futuresCalendarBySymbol.get(key);
  return rows.filter((row) =>
    (calendar && (state.options.deriveAllFuturesTimeframesFrom1m ||
      timeframe === "1h" || timeframe === "4h" || timeframe === "1d")
      ? calendar.completedAt(row.ts, timeframe).getTime()
      : row.ts.getTime() + durationMs) <= evaluationTime.getTime() &&
    (!currentConid || row.conid === currentConid),
  ).slice(-limit);
}

describe("BacktestSimulator futures safety", () => {
  it("keeps indexed lookups byte-for-byte equivalent across timeframes, rolls, symbols, limits, and backward time", async () => {
    const es1m = [
      candle("1", "2026-06-01T10:00:00Z", { close: 100 }),
      candle("1", "2026-06-01T10:01:00Z", { close: 101 }),
      candle("2", "2026-06-01T10:02:00Z", { close: 200 }),
      candle("2", "2026-06-01T10:03:00Z", { close: 201 }),
    ];
    const nq1m = es1m.map((row, index) => ({
      ...row, symbol: "NQ", conid: index < 2 ? "10" : "20", close: row.close + 1000,
    }));
    const timeframes = ["5m", "1h", "4h", "12h", "1d", "1w"] as const;
    const loaded = data(es1m);
    loaded.dataset.symbols = ["ES", "NQ"];
    loaded.candles1m = new Map([["ES", es1m], ["NQ", nq1m]]);
    loaded.candleCount1m = es1m.length + nq1m.length;
    for (const [offset, timeframe] of timeframes.entries()) {
      const rows = [
        candle("1", "2026-05-20T00:00:00Z", { timeframe, close: 10 + offset }),
        candle("1", "2026-05-21T00:00:00Z", { timeframe, close: 20 + offset }),
        candle("2", "2026-05-22T00:00:00Z", { timeframe, close: 30 + offset }),
        candle("2", "2026-05-23T00:00:00Z", { timeframe, close: 40 + offset }),
      ];
      loaded[`candles${timeframe}` as keyof LoadedBacktestData] = new Map([
        ["ES", rows],
        ["NQ", rows.map((row) => ({ ...row, symbol: "NQ", conid: `${row.conid}0` }))],
      ]) as never;
    }
    const simulator = new BacktestSimulator({} as BacktestRepository, 1, loaded, options({
      currencyBySymbol: { ES: "USD", NQ: "USD" },
      secTypeBySymbol: { ES: "STK", NQ: "STK" },
    }));
    const state = simulator as unknown as SimulatorLookupInternals;
    state.currentIndexBySymbol.set("ES", 3);
    state.currentIndexBySymbol.set("NQ", 2);
    state.currentCandle = es1m[3];

    for (const iso of ["2026-06-01T10:03:00Z", "2026-05-22T12:00:00Z", "2026-06-01T10:03:00Z"]) {
      state.currentTime = new Date(iso);
      for (const symbol of ["ES", "NQ"]) {
        for (const timeframe of ["1m", ...timeframes] as const) {
          for (const limit of [0, 1, 99]) {
            assert.deepEqual(
              await simulator.getRecentCandles(symbol, timeframe, limit),
              referenceRecentCandles(simulator, symbol, timeframe, limit),
              `${symbol} ${timeframe} limit=${limit} at ${iso}`,
            );
          }
        }
      }
    }
  });

  it("keeps indexed CME completion parity across DST, closure, early close, weekly completion, and roll", async () => {
    const rows = [
      candle("1", "2025-12-31T20:59:00Z", { close: 98 }),
      candle("1", "2026-01-02T00:00:00Z", { close: 99 }),
      candle("1", "2026-03-06T22:59:00Z", { close: 100 }),
      candle("1", "2026-03-08T22:00:00Z", { close: 101 }),
      candle("1", "2026-03-09T20:59:00Z", { close: 102 }),
      candle("1", "2026-06-18T22:00:00Z", { close: 103 }),
      candle("1", "2026-06-19T16:59:00Z", { close: 104 }),
      candle("1", "2026-06-30T20:59:00Z", { close: 105 }),
      candle("2", "2026-07-01T22:00:00Z", { close: 200 }),
      candle("2", "2026-07-02T20:59:00Z", { close: 201 }),
    ];
    const spec = { tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1, slippageTicks: 1,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago",
      calendarVersion: CME_EQUITY_INDEX_2024_2026.version } as const;
    const metadata = new Map(["1", "2"].map((conid) => [conid, { conid, symbol: "ES",
      localSymbol: `ES${conid}`, tradingClass: "ES", lastTradeAt: new Date("2026-12-18T16:00:00Z") }]));
    const simulator = new BacktestSimulator({} as BacktestRepository, 1, data(rows), options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: metadata, deriveAllFuturesTimeframesFrom1m: true,
      futuresCalendars: new Map([[CME_EQUITY_INDEX_2024_2026.version, CME_EQUITY_INDEX_2024_2026]]),
    }));
    const state = simulator as unknown as SimulatorLookupInternals;
    const calendar = state.futuresCalendarBySymbol.get("ES")!;
    state.currentIndexBySymbol.set("ES", rows.length - 1);

    for (const timeframe of ["5m", "1h", "4h", "12h", "1d", "1w"] as const) {
      const aggregated = state.candlesByTimeframe[timeframe].get("ES") ?? [];
      assert.equal(aggregated.length > 0, true, `${timeframe} fixture must aggregate`);
      for (const row of aggregated) {
        state.currentCandle = [...rows].reverse().find((candidate) => candidate.conid === row.conid)!;
        const completedAt = calendar.completedAt(row.ts, timeframe).getTime();
        for (const at of [completedAt - 1, completedAt, completedAt + 1, completedAt - 1]) {
          state.currentTime = new Date(at);
          for (const limit of [0, 1, 99])
            assert.deepEqual(
              await simulator.getRecentCandles("ES", timeframe, limit),
              referenceRecentCandles(simulator, "ES", timeframe, limit),
              `${timeframe} ${row.conid} ${new Date(at).toISOString()} limit=${limit}`,
            );
        }
      }
    }

    state.currentCandle = rows.at(-1);
    state.currentTime = new Date("2026-01-01T18:00:00Z");
    for (const timeframe of ["5m", "1h", "4h", "12h", "1d", "1w"] as const)
      assert.deepEqual(
        await simulator.getRecentCandles("ES", timeframe, 99),
        referenceRecentCandles(simulator, "ES", timeframe, 99),
        `${timeframe} full closure parity`,
      );
  });

  it("research mode rebuilds all six higher timeframes from projected 1m per conId", () => {
    const projected = [
      candle("1", "2026-06-01T22:01:00Z", { open: 100, high: 101, low: 99, close: 100, volume: 2 }),
      candle("1", "2026-06-01T22:04:00Z", { open: 100, high: 102, low: 98, close: 101, volume: 3 }),
      candle("2", "2026-06-01T22:05:00Z", { open: 900, high: 901, low: 899, close: 900, volume: 7 }),
    ];
    const stale = candle("stale", "2026-06-01T22:00:00Z", { timeframe: "1h", close: 9999 });
    const input = data(projected, [stale]);
    for (const key of ["candles5m", "candles4h", "candles12h", "candles1d", "candles1w"] as const)
      input[key] = new Map([["ES", [stale]]]);
    const spec = { tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1, slippageTicks: 1,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "fixture" } as const;
    const metadata = new Map(["1", "2"].map((conid) => [conid, { conid, symbol: "ES",
      localSymbol: `ES${conid}`, tradingClass: "ES", lastTradeAt: new Date("2026-12-18T16:00:00Z") }]));
    const simulator = new BacktestSimulator({} as BacktestRepository, 1, input, options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: metadata, deriveAllFuturesTimeframesFrom1m: true,
      futuresCalendars: new Map([["fixture", { version: "fixture", coverageStart: "2026-01-01",
        coverageEnd: "2026-12-31", fullClosures: [], earlyCloses: {} }]]),
    }));
    const maps = (simulator as unknown as { candlesByTimeframe: Record<string, Map<string, Candle[]>> }).candlesByTimeframe;
    for (const timeframe of ["5m", "1h", "4h", "12h", "1d", "1w"])
      assert.deepEqual(maps[timeframe].get("ES")?.map((row) => row.conid), ["1", "2"]);
    assert.equal(maps["5m"].get("ES")?.[0]?.close, 101);
    assert.equal(maps["5m"].get("ES")?.[0]?.volume, 5);
    assert.equal(maps["5m"].get("ES")?.some((row) => row.close === 9999), false);
  });

  it("fails futures preflight before writing when contract metadata is absent", async () => {
    let writes = 0;
    const repo = new Proxy({}, { get: () => async () => { writes += 1; } }) as BacktestRepository;
    const simulator = new BacktestSimulator(repo, 1, data([candle("missing", "2026-06-01T22:00:00Z")]),
      options({ secTypeBySymbol: { ES: "FUT" } }));
    await assert.rejects(() => simulator.run(), /Missing futures contract metadata/);
    assert.equal(writes, 0);
  });

  it("hides incomplete higher-timeframe candles and isolates conIds", async () => {
    const now = candle("2", "2026-06-01T12:30:00Z");
    const higher = [
      candle("1", "2026-06-01T10:00:00Z", { timeframe: "1h", close: 9999 }),
      candle("2", "2026-06-01T11:00:00Z", { timeframe: "1h", close: 101 }),
      candle("2", "2026-06-01T12:00:00Z", { timeframe: "1h", close: 7777 }),
    ];
    const simulator = new BacktestSimulator({} as BacktestRepository, 1, data([now], higher), options());
    const internals = simulator as unknown as { currentTime: Date; currentCandle: Candle };
    internals.currentTime = now.ts;
    internals.currentCandle = now;
    const visible = await simulator.getRecentCandles("ES", "1h", 10);
    assert.deepEqual(visible.map((row) => row.close), [101]);
  });

  it("lets the stop win a same-bar stop/target collision and suppresses a favorable-only target", async () => {
    const fills: BacktestFillRecord[] = [];
    const repo = { insertFill: async (fill: BacktestFillRecord) => { fills.push(fill); } } as BacktestRepository;
    const bar = candle("1", "2026-06-01T12:00:00Z");
    const simulator = new BacktestSimulator(repo, 1, data([bar]), options());
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      processBracketExit(value: Candle): Promise<void>;
    };
    const position = {
      symbol: "ES", conid: "1", quantity: 1, originalQuantityAbs: 1,
      averageCost: 100, stop: 95, initialStop: 95, takeProfit: 105,
      entryAt: bar.ts, orderId: 1, strategy: "test", runtimeKey: "test|ES|BUY",
      confidence: 1, directionalRegime: "trend", volatilityRegime: "normal",
      side: "BUY", priceMultiplier: 1, fxToBaseAtEntry: 1,
      entryReferencePrice: 100, entrySlippage: 0,
    };
    internals.positions.set("ES", position);
    await internals.processBracketExit(bar);
    assert.equal(fills[0]?.exitReason, "stop");

    fills.length = 0;
    internals.positions.set("ES", { ...position, stop: 90, initialStop: 90 });
    await internals.processBracketExit({ ...bar, low: 99, high: 106 });
    assert.equal(fills.length, 0);

    internals.positions.set("ES", {
      ...position, quantity: -10, originalQuantityAbs: 10, side: "SELL",
      stop: 105, initialStop: 105, takeProfit: 95,
      pendingPartials: [{ fraction: 0.5, price: 97, executed: false }],
      entryAt: new Date("2026-06-01T11:59:00Z"),
    });
    await internals.processBracketExit(bar);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].exitReason, "stop");
    assert.equal(fills[0].quantity, 10, "short stop must win before a touched partial");

    fills.length = 0;
    internals.positions.set("ES", {
      ...position, quantity: 10, originalQuantityAbs: 10,
      pendingPartials: [{ fraction: 0.5, price: 103, executed: false }],
      entryAt: new Date("2026-06-01T11:59:00Z"),
    });
    await internals.processBracketExit(bar);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].exitReason, "stop");
    assert.equal(fills[0].quantity, 10, "long stop must win before a touched partial");
  });

  it("liquidates the outgoing contract with adverse slippage and cancels its pending intent", async () => {
    const fills: BacktestFillRecord[] = [];
    const cancelled: number[] = [];
    const repo = {
      insertFill: async (fill: BacktestFillRecord) => { fills.push(fill); },
      updateOrderStatus: async (id: number) => { cancelled.push(id); },
    } as unknown as BacktestRepository;
    const spec = {
      tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1.25, slippageTicks: 1,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "fixture-v1",
    } as const;
    const metadata = new Map([
      ["1", { conid: "1", symbol: "ES", localSymbol: "ESU6", tradingClass: "ES", lastTradeAt: new Date("2026-09-18T16:00:00Z") }],
      ["2", { conid: "2", symbol: "ES", localSymbol: "ESZ6", tradingClass: "ES", lastTradeAt: new Date("2026-12-18T16:00:00Z") }],
    ]);
    const simulator = new BacktestSimulator(repo, 1, data([]), options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: metadata, futuresCalendars: new Map(),
    }));
    const previous = candle("1", "2026-06-01T22:00:00Z", { close: 100 });
    const incoming = candle("2", "2026-06-01T22:01:00Z", { close: 110 });
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      pendingOrders: Array<Record<string, unknown>>;
      lastCandleBySymbol: Map<string, Candle>;
      processContractTransition(value: Candle): Promise<void>;
    };
    internals.positions.set("ES", {
      symbol: "ES", conid: "1", quantity: 1, originalQuantityAbs: 1,
      averageCost: 99, entryAt: new Date("2026-06-01T21:00:00Z"), orderId: 7,
      strategy: "test", runtimeKey: "test|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 50, fxToBaseAtEntry: 1, entryReferencePrice: 98.75,
      entrySlippage: 0.25, futuresSpec: spec,
    });
    internals.pendingOrders.push({ id: 8, order: { instrument: "ES" } });
    internals.lastCandleBySymbol.set("ES", previous);
    await internals.processContractTransition(incoming);
    assert.equal(fills[0].exitReason, "contract_roll");
    assert.equal(fills[0].exitPrice, 99.75);
    assert.equal(fills[0].exitConid, "1");
    assert.deepEqual(cancelled, [8]);
    assert.equal(internals.positions.has("ES"), false);

    fills.length = 0;
    const expiredMetadata = new Map(metadata);
    expiredMetadata.set("1", {
      ...metadata.get("1")!,
      lastTradeAt: incoming.ts,
    });
    const expirySimulator = new BacktestSimulator(repo, 1, data([]), options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: expiredMetadata, futuresCalendars: new Map(),
    }));
    const expiryInternals = expirySimulator as unknown as typeof internals;
    expiryInternals.positions.set("ES", {
      symbol: "ES", conid: "1", quantity: 1, originalQuantityAbs: 1,
      averageCost: 99, entryAt: new Date("2026-06-01T21:00:00Z"), orderId: 7,
      strategy: "test", runtimeKey: "test|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 50, fxToBaseAtEntry: 1, entryReferencePrice: 98.75,
      entrySlippage: 0.25, futuresSpec: spec,
    });
    expiryInternals.lastCandleBySymbol.set("ES", previous);
    await expiryInternals.processContractTransition(incoming);
    assert.equal(fills[0].exitReason, "expiry");
  });

  it("fails closed on a retired conId reappearing and on post-expiry data", () => {
    const spec = {
      tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1, slippageTicks: 0,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "fixture",
    } as const;
    const contracts = new Map([
      ["1", { conid: "1", symbol: "ES", localSymbol: "ESU6", tradingClass: "ES", lastTradeAt: new Date("2026-09-18T16:00:00Z") }],
      ["2", { conid: "2", symbol: "ES", localSymbol: "ESZ6", tradingClass: "ES", lastTradeAt: new Date("2026-12-18T16:00:00Z") }],
    ]);
    const calendars = new Map([["fixture", {
      version: "fixture", coverageStart: "2026-01-01", coverageEnd: "2026-12-31",
      fullClosures: [], earlyCloses: {},
    }]]);
    const futuresOptions = options({ secTypeBySymbol: { ES: "FUT" },
      futuresSpecs: new Map([["ES", spec]]), futuresContracts: contracts,
      futuresCalendars: calendars });
    const retired = new BacktestSimulator({} as BacktestRepository, 1, data([
      candle("1", "2026-06-01T22:00:00Z", { open: 100, high: 100.25, low: 99.75, close: 100 }),
      candle("2", "2026-06-01T22:01:00Z", { open: 101, high: 101.25, low: 100.75, close: 101 }),
      candle("1", "2026-06-01T22:02:00Z", { open: 100, high: 100.25, low: 99.75, close: 100 }),
    ]), futuresOptions) as unknown as { validateFuturesDataset(): void };
    assert.throws(() => retired.validateFuturesDataset(), /Retired futures conId/);

    const expiredContracts = new Map(contracts);
    expiredContracts.set("1", { ...contracts.get("1")!, lastTradeAt: new Date("2026-06-01T22:00:00Z") });
    const expired = new BacktestSimulator({} as BacktestRepository, 1,
      data([candle("1", "2026-06-01T22:00:00Z", { open: 100, high: 100.25, low: 99.75, close: 100 })]),
      { ...futuresOptions, futuresContracts: expiredContracts }) as unknown as { validateFuturesDataset(): void };
    assert.throws(() => expired.validateFuturesDataset(), /at or after last trade/);

    const overlap = new BacktestSimulator({} as BacktestRepository, 1, data([
      candle("1", "2026-06-01T22:00:00Z", { open: 100, high: 100.25, low: 99.75, close: 100 }),
      candle("2", "2026-06-01T22:00:00Z", { open: 101, high: 101.25, low: 100.75, close: 101 }),
    ]), futuresOptions) as unknown as { validateFuturesDataset(): void };
    assert.throws(() => overlap.validateFuturesDataset(), /overlap or are not strictly ordered/);

    const missingExpiry = new Map(contracts);
    missingExpiry.set("1", { ...contracts.get("1")!, lastTradeAt: new Date("bad") });
    const noExpiry = new BacktestSimulator({} as BacktestRepository, 1,
      data([candle("1", "2026-06-01T22:00:00Z")]),
      { ...futuresOptions, futuresContracts: missingExpiry }) as unknown as { validateFuturesDataset(): void };
    assert.throws(() => noExpiry.validateFuturesDataset(), /lastTradeAt is required/);
  });

  it("applies a trailing ratchet only after the candle survives", async () => {
    const fills: BacktestFillRecord[] = [];
    const repo = { insertFill: async (fill: BacktestFillRecord) => { fills.push(fill); } } as BacktestRepository;
    const simulator = new BacktestSimulator(repo, 1, data([]), options());
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      processBracketExit(value: Candle): Promise<void>;
    };
    internals.positions.set("ES", {
      symbol: "ES", conid: "1", quantity: 10, originalQuantityAbs: 10,
      averageCost: 100, stop: 90, initialStop: 90, trailingStopPct: 1,
      trailActivated: true, peakPrice: 100, entryAt: new Date("2026-06-01T21:00:00Z"),
      orderId: 1, strategy: "test", runtimeKey: "test|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 1, fxToBaseAtEntry: 1, entryReferencePrice: 100, entrySlippage: 0,
    });
    await internals.processBracketExit(candle("1", "2026-06-01T22:00:00Z", {
      open: 100, high: 110, low: 95, close: 109,
    }));
    assert.equal(fills.length, 0, "newly ratcheted stop must not execute on the same candle");
    await internals.processBracketExit(candle("1", "2026-06-01T22:01:00Z", {
      open: 109, high: 109.5, low: 108, close: 108.5,
    }));
    assert.equal(fills[0].exitReason, "stop");
    assert.equal(fills[0].exitPrice, 108.9);
  });

  it("preserves the stock commission model", async () => {
    const fills: BacktestFillRecord[] = [];
    const repo = { insertFill: async (fill: BacktestFillRecord) => { fills.push(fill); } } as BacktestRepository;
    const simulator = new BacktestSimulator(repo, 1, data([]), options({ commissionPerShare: 0.01 }));
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      closePosition(position: Record<string, unknown>, price: number, at: Date, reason: string, orderId: number): Promise<void>;
    };
    const position = {
      symbol: "ES", conid: "stk", quantity: 10, originalQuantityAbs: 10,
      averageCost: 100, entryAt: new Date("2026-06-01T21:00:00Z"), orderId: 1,
      strategy: "test", runtimeKey: "test|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 1, fxToBaseAtEntry: 1, entryReferencePrice: 100, entrySlippage: 0,
    };
    internals.positions.set("ES", position);
    await internals.closePosition(position, 101, new Date("2026-06-01T22:00:00Z"), "dataset_end", 1);
    assert.equal(fills[0].grossPnl, 10);
    assert.equal(fills[0].commission, 0.2);
    assert.equal(fills[0].netPnl, 9.8);
    assert.equal(fills[0].executionModelVersion, undefined);

    let statusWrites = 0;
    const fillRepo = { updateOrderStatus: async () => { statusWrites += 1; } } as unknown as BacktestRepository;
    const fillSimulator = new BacktestSimulator(fillRepo, 1, data([]), options());
    const fillInternals = fillSimulator as unknown as {
      positions: Map<string, { averageCost: number }>;
      fillOrder(pending: Record<string, unknown>, value: Candle): Promise<void>;
    };
    await fillInternals.fillOrder({ id: 2, order: {
      instrument: "ES", conid: "stk", side: "BUY", quantity: 1,
      orderType: "MKT", entry: 99, positionEffect: "OPEN_OR_ADD",
      confidence: 1, strategy: "test",
    } }, candle("stk", "2026-06-01T22:01:00Z", {
      open: 100, high: 101, low: 98, close: 100,
    }));
    assert.equal(fillInternals.positions.get("ES")?.averageCost, 99,
      "legacy STK MKT behavior continues to use an explicit order.entry");
    assert.equal(statusWrites, 1);
  });

  it("moves breakeven only for the next candle", async () => {
    const fills: BacktestFillRecord[] = [];
    const repo = { insertFill: async (fill: BacktestFillRecord) => { fills.push(fill); } } as BacktestRepository;
    const simulator = new BacktestSimulator(repo, 1, data([]), options());
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      processBracketExit(value: Candle): Promise<void>;
    };
    internals.positions.set("ES", {
      symbol: "ES", conid: "1", quantity: -1, originalQuantityAbs: 1,
      averageCost: 100, stop: 110, initialStop: 110,
      entryAt: new Date("2026-06-01T21:00:00Z"), orderId: 1,
      strategy: "momentum_breakdown_short_v1", runtimeKey: "be", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "SELL",
      priceMultiplier: 1, fxToBaseAtEntry: 1, entryReferencePrice: 100, entrySlippage: 0,
    });
    await internals.processBracketExit(candle("1", "2026-06-01T22:00:00Z", {
      open: 100, high: 105, low: 89, close: 91,
    }));
    assert.equal(fills.length, 0);
    await internals.processBracketExit(candle("1", "2026-06-01T22:01:00Z", {
      open: 99, high: 101, low: 98, close: 100,
    }));
    assert.equal(fills[0].exitReason, "stop");
    assert.equal(fills[0].exitPrice, 100);
  });

  it("fills futures limit at normalized limit and MKT/STP from the next bar with adverse slippage", async () => {
    const spec = {
      tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1, slippageTicks: 1,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "fixture",
    } as const;
    const metadata = new Map([["1", {
      conid: "1", symbol: "ES", localSymbol: "ESZ6", tradingClass: "ES",
      lastTradeAt: new Date("2026-12-18T16:00:00Z"),
    }]]);
    const repo = { updateOrderStatus: async () => undefined } as unknown as BacktestRepository;
    const makeSimulator = () => new BacktestSimulator(repo, 1, data([]), options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: metadata,
    }));
    const fill = async (orderType: "LMT" | "MKT" | "STP", entry: number | undefined, open: number) => {
      const simulator = makeSimulator();
      const internals = simulator as unknown as {
        positions: Map<string, { averageCost: number; entryReferencePrice: number }>;
        fillOrder(pending: Record<string, unknown>, value: Candle): Promise<void>;
      };
      await internals.fillOrder({ id: 1, order: {
        instrument: "ES", conid: "1", side: "BUY", quantity: 1, orderType,
        entry, positionEffect: "OPEN_OR_ADD", confidence: 1, strategy: "test",
      } }, candle("1", "2026-06-01T22:01:00Z", {
        open, high: open + 2, low: open - 2, close: open,
      }));
      return internals.positions.get("ES")!;
    };
    const limit = await fill("LMT", 100.13, 99);
    assert.equal(limit.averageCost, 100);
    assert.equal(limit.entryReferencePrice, 100);
    assert.equal((await fill("MKT", 95, 100)).averageCost, 100.25);
    const stop = await fill("STP", 100, 101);
    assert.equal(stop.entryReferencePrice, 101);
    assert.equal(stop.averageCost, 101.25);

    const fills: BacktestFillRecord[] = [];
    const exitRepo = {
      updateOrderStatus: async () => undefined,
      insertFill: async (record: BacktestFillRecord) => { fills.push(record); },
    } as unknown as BacktestRepository;
    const exitSimulator = new BacktestSimulator(exitRepo, 1, data([]), options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: metadata,
    }));
    const exitInternals = exitSimulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      fillOrder(pending: Record<string, unknown>, value: Candle): Promise<void>;
    };
    exitInternals.positions.set("ES", {
      symbol: "ES", conid: "1", quantity: 1, originalQuantityAbs: 1,
      averageCost: 100, entryAt: new Date("2026-06-01T22:00:00Z"), orderId: 1,
      strategy: "test", runtimeKey: "test|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 50, fxToBaseAtEntry: 1, entryReferencePrice: 99.75,
      entrySlippage: 0.25, futuresSpec: spec,
    });
    await exitInternals.fillOrder({ id: 2, order: {
      instrument: "ES", conid: "1", side: "SELL", quantity: 1,
      orderType: "MKT", entry: 100, positionEffect: "CLOSE_OR_REDUCE",
      confidence: 1, strategy: "test",
    } }, candle("1", "2026-06-01T22:01:00Z", {
      open: 101, high: 101.25, low: 100.5, close: 101,
    }));
    assert.equal(fills[0].exitReferencePrice, 101);
    assert.equal(fills[0].exitFillPrice, 100.75);
    assert.equal(fills[0].exitSlippage, 0.25);
  });

  it("rejects futures pyramiding before marking the second order filled", async () => {
    let statusWrites = 0;
    const repo = { updateOrderStatus: async () => { statusWrites += 1; } } as unknown as BacktestRepository;
    const spec = {
      tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1, slippageTicks: 1,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "fixture",
    } as const;
    const simulator = new BacktestSimulator(repo, 1, data([]), options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: new Map([["1", { conid: "1", symbol: "ES", localSymbol: "ESZ6",
        tradingClass: "ES", lastTradeAt: new Date("2026-12-18T16:00:00Z") }]]),
    }));
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      fillOrder(pending: Record<string, unknown>, value: Candle): Promise<void>;
    };
    internals.positions.set("ES", {
      symbol: "ES", conid: "1", quantity: 1, originalQuantityAbs: 1,
      averageCost: 100, entryAt: new Date("2026-06-01T22:00:00Z"), orderId: 1,
      strategy: "test", runtimeKey: "test|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 50, fxToBaseAtEntry: 1, entryReferencePrice: 99.75,
      entrySlippage: 0.25, futuresSpec: spec,
    });
    await assert.rejects(() => internals.fillOrder({ id: 2, order: {
      instrument: "ES", conid: "1", side: "BUY", quantity: 1, orderType: "MKT",
      positionEffect: "OPEN_OR_ADD", confidence: 1, strategy: "test",
    } }, candle("1", "2026-06-01T22:01:00Z")), /pyramiding is not supported/);
    assert.equal(statusWrites, 0);
  });

  it("closes an unexpired futures position at dataset end as an adverse market exit", async () => {
    const fills: BacktestFillRecord[] = [];
    const repo = { insertFill: async (fill: BacktestFillRecord) => { fills.push(fill); } } as BacktestRepository;
    const spec = {
      tradingClass: "ES", secType: "FUT", currency: "USD", multiplier: 50,
      tickSize: 0.25, commissionPerContractPerSide: 1, slippageTicks: 1,
      sessionTemplate: "cme_equity_index", timezone: "America/Chicago", calendarVersion: "fixture",
    } as const;
    const last = candle("1", "2026-06-01T22:00:00Z", {
      open: 100, high: 100.25, low: 99.75, close: 100,
    });
    const simulator = new BacktestSimulator(repo, 1, data([last]), options({
      secTypeBySymbol: { ES: "FUT" }, futuresSpecs: new Map([["ES", spec]]),
      futuresContracts: new Map([["1", { conid: "1", symbol: "ES", localSymbol: "ESZ7",
        tradingClass: "ES", lastTradeAt: new Date("2027-12-17T16:00:00Z") }]]),
    }));
    const internals = simulator as unknown as {
      positions: Map<string, Record<string, unknown>>;
      closeOpenPositionsAtDatasetEnd(): Promise<void>;
    };
    internals.positions.set("ES", {
      symbol: "ES", conid: "1", quantity: 1, originalQuantityAbs: 1,
      averageCost: 99, entryAt: new Date("2026-06-01T21:00:00Z"), orderId: 1,
      strategy: "test", runtimeKey: "test|ES|BUY", confidence: 1,
      directionalRegime: "trend", volatilityRegime: "normal", side: "BUY",
      priceMultiplier: 50, fxToBaseAtEntry: 1, entryReferencePrice: 98.75,
      entrySlippage: 0.25, futuresSpec: spec,
    });
    await internals.closeOpenPositionsAtDatasetEnd();
    assert.equal(fills[0].exitReason, "dataset_end");
    assert.equal(fills[0].exitReferencePrice, 100);
    assert.equal(fills[0].exitFillPrice, 99.75);
  });
});
