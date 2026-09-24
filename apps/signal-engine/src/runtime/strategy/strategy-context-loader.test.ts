import { AAPL_NATIVE_SOURCE, aaplCandleEnd } from '@ikbr/shared';
import { AAPL_FIXTURE_NOW, nativeAaplFixture, nativeAaplSchedule } from './aapl-native.fixture.js';
import { computeIndicatorsForContext } from './indicators.js';
import { detectRegimeForContext } from './regime.js';
import { evaluateMomentumBreakoutLong } from '../../strategies/momentum-breakout-long.strategy.js';
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  BoundInstrument,
  Candle,
  CandleTimeframe,
  Instrument,
  InstrumentContract,
} from "@ikbr/shared";

import {
  StrategyContextLoader,
  type StrategyContextLoaderRepo,
} from "./strategy-context-loader.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-12T12:00:00.000Z");
const NOW_MS = NOW.getTime();

const INSTRUMENT: Instrument = {
  id: "aapl",
  displayName: "Apple",
  assetClass: "stock",
  broker: "ibkr",
  brokerSymbol: "AAPL",
  exchange: "NASDAQ",
  currency: "USD",
  trading: {
    executionEnabled: true,
    signalGenerationEnabled: true,
    monitoringEnabled: true,
    aiAnalysisEnabled: false,
  },
  risk: {
    maxQuantity: 100,
    quantityUnit: "shares",
    maxLeverage: 1,
    allowOvernight: true,
    maxSpread: 0.5,
    maxSlippage: 1,
  },
  session: {
    useRegularTradingHours: true,
    timezone: "America/New_York",
    sessionTemplate: "us_stock_rth",
  },
  metadata: { tags: [] },
} as Instrument;

const BOUND: BoundInstrument = {
  instrumentId: "aapl",
  instrument: INSTRUMENT,
  broker: "ibkr",
  brokerSymbol: "AAPL",
  conId: 265598,
  localSymbol: "AAPL",
  tradingClass: "NMS",
  exchange: "NASDAQ",
  currency: "USD",
  minTick: 0.01,
};

function makeContract(
  overrides: Partial<InstrumentContract> = {},
): InstrumentContract {
  return {
    symbol: "AAPL",
    conid: "265598",
    secType: "STK",
    exchange: "NASDAQ",
    primaryExchange: "NASDAQ",
    currency: "USD",
    localSymbol: "AAPL",
    tradingClass: "NMS",
    source: "ibkr",
    ...overrides,
  };
}

interface MarketStateOverrides {
  readonly conid?: string;
  readonly symbol?: string;
  readonly lastPrice?: unknown;
  readonly bid?: unknown;
  readonly ask?: unknown;
  readonly spread?: unknown;
  readonly ts?: string;
}

function makeMarketState(
  overrides: MarketStateOverrides = {},
): NonNullable<
  Awaited<ReturnType<StrategyContextLoaderRepo["getMarketState"]>>
> {
  return {
    conid: overrides.conid ?? "265598",
    symbol: overrides.symbol ?? "AAPL",
    lastPrice: (overrides.lastPrice ?? 150.25) as number,
    ...(overrides.bid !== undefined
      ? { bid: overrides.bid as number }
      : { bid: 150.24 }),
    ...(overrides.ask !== undefined
      ? { ask: overrides.ask as number }
      : { ask: 150.26 }),
    ...(overrides.spread !== undefined
      ? { spread: overrides.spread as number }
      : { spread: 0.02 }),
    ts: overrides.ts ?? new Date(NOW_MS - 1_000).toISOString(),
  };
}

function makeCandles(
  count: number,
  timeframeMs: number,
  endTs: number = NOW_MS - 60_000,
  conid: string = "265598",
  symbol: string = "AAPL",
): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    const ts = new Date(endTs - (count - 1 - i) * timeframeMs);
    out.push({
      conid,
      symbol,
      timeframe: "1m",
      ts,
      open: 100 + i * 0.01,
      high: 100 + i * 0.01 + 0.05,
      low: 100 + i * 0.01 - 0.05,
      close: 100 + i * 0.01,
      volume: 1000 + i,
    } as Candle);
  }
  return out;
}

const TIMEFRAME_MS: Record<CandleTimeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};

function fullCandleSets(): Partial<Record<CandleTimeframe, Candle[]>> {
  return {
    "1m": makeCandles(300, TIMEFRAME_MS["1m"], NOW_MS - 60_000),
    "5m": makeCandles(60, TIMEFRAME_MS["5m"], NOW_MS - 300_000),
    "1h": makeCandles(60, TIMEFRAME_MS["1h"], NOW_MS - 3_600_000),
    "4h": makeCandles(60, TIMEFRAME_MS["4h"], NOW_MS - 14_400_000),
    "12h": makeCandles(60, TIMEFRAME_MS["12h"], NOW_MS - 43_200_000),
    "1d": makeCandles(60, TIMEFRAME_MS["1d"], NOW_MS - 86_400_000),
    "1w": makeCandles(60, TIMEFRAME_MS["1w"], NOW_MS - 604_800_000),
  };
}

interface RepoOverrides {
  readonly contract?: InstrumentContract | null;
  readonly candles?: Partial<Record<CandleTimeframe, Candle[]>>;
  readonly marketState?: ReturnType<typeof makeMarketState> | null;
  readonly getRecentCandlesForContract?: StrategyContextLoaderRepo["getRecentCandlesForContract"];
  readonly getInstrumentContractByConId?: StrategyContextLoaderRepo["getInstrumentContractByConId"];
  readonly getMarketState?: StrategyContextLoaderRepo["getMarketState"];
}

function makeRepo(o: RepoOverrides = {}): StrategyContextLoaderRepo & {
  candleCalls: Array<{
    symbol: string;
    conId: string;
    timeframe: CandleTimeframe;
    limit: number;
  }>;
  contractCalls: string[];
  marketStateCalls: string[];
} {
  const candles = o.candles ?? fullCandleSets();
  const spy = {
    candleCalls: [] as Array<{
      symbol: string;
      conId: string;
      timeframe: CandleTimeframe;
      limit: number;
    }>,
    contractCalls: [] as string[],
    marketStateCalls: [] as string[],
    async getInstrumentContractByConId(conId: string) {
      spy.contractCalls.push(conId);
      if (o.getInstrumentContractByConId)
        return o.getInstrumentContractByConId(conId);
      return o.contract === undefined ? makeContract() : o.contract;
    },
    async getRecentCandlesForContract(
      symbol: string,
      conId: string,
      timeframe: CandleTimeframe,
      limit: number,
    ) {
      spy.candleCalls.push({ symbol, conId, timeframe, limit });
      if (o.getRecentCandlesForContract) {
        return o.getRecentCandlesForContract(symbol, conId, timeframe, limit);
      }
      return candles[timeframe] ?? [];
    },
    async getMarketState(conid: string) {
      spy.marketStateCalls.push(conid);
      if (o.getMarketState) return o.getMarketState(conid);
      return o.marketState === undefined ? makeMarketState() : o.marketState;
    },
  };
  return spy as unknown as StrategyContextLoaderRepo & {
    candleCalls: typeof spy.candleCalls;
    contractCalls: typeof spy.contractCalls;
    marketStateCalls: typeof spy.marketStateCalls;
  };
}

function makeLoader(
  repo: StrategyContextLoaderRepo,
  maxMarketStateAgeMs = 300_000,
): StrategyContextLoader {
  return new StrategyContextLoader({
    repo,
    clock: () => NOW,
    maxMarketStateAgeMs,
  });
}

const ALL_TIMEFRAMES: readonly CandleTimeframe[] = [
  "1m",
  "5m",
  "1h",
  "4h",
  "12h",
  "1d",
  "1w",
];

async function loadDefault(
  loader: StrategyContextLoader,
  overrides: {
    positionQuantity?: number;
    timeframes?: readonly CandleTimeframe[];
  } = {},
) {
  return loader.load({
    instrument: INSTRUMENT,
    bound: BOUND,
    positionQuantity: overrides.positionQuantity ?? 0,
    timeframes: overrides.timeframes ?? ALL_TIMEFRAMES,
  });
}

// ---------------------------------------------------------------------------
// Tests — §14.5 plus market-state fail-closed extensions
// ---------------------------------------------------------------------------

describe("StrategyContextLoader — happy path", () => {
  it("valid data → kind:'ok' with populated StrategyContext", async () => {
    const repo = makeRepo();
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.context.symbol, "AAPL");
    assert.equal(result.context.conid, "265598");
    assert.equal(result.context.secType, "STK");
    assert.equal(result.context.latestCandle.close > 0, true);
    assert.equal(result.context.marketState?.lastPrice, 150.25);
    assert.equal(result.context.currentPosition?.quantity, 0);
    assert.deepEqual(repo.candleCalls.map((c) => c.timeframe).sort(), [
      "12h",
      "1d",
      "1h",
      "1m",
      "1w",
      "4h",
      "5m",
    ]);
    for (const call of repo.candleCalls) {
      assert.equal(call.conId, "265598");
      assert.equal(call.symbol, "AAPL");
    }
    assert.deepEqual(repo.contractCalls, ["265598"]);
    assert.deepEqual(repo.marketStateCalls, ["265598"]);
  });
});

describe("StrategyContextLoader — candle failures", () => {
  it("no 1m candles → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({ candles: { ...fullCandleSets(), "1m": [] } });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
    assert.deepEqual(repo.contractCalls, []);
    assert.deepEqual(repo.marketStateCalls, []);
  });

  it("1m candle count below minimum → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      candles: {
        ...fullCandleSets(),
        "1m": makeCandles(200, TIMEFRAME_MS["1m"], NOW_MS - 60_000),
      },
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("stale latest 1m candle → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      candles: {
        ...fullCandleSets(),
        "1m": makeCandles(300, TIMEFRAME_MS["1m"], NOW_MS - 10 * 60_000),
      },
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("future-timestamped latest 1m candle → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      candles: {
        ...fullCandleSets(),
        "1m": makeCandles(300, TIMEFRAME_MS["1m"], NOW_MS + 60_000),
      },
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("non-1m timeframe below minimum → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      candles: {
        ...fullCandleSets(),
        "5m": makeCandles(10, TIMEFRAME_MS["5m"], NOW_MS - 300_000),
      },
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  // PR15.4 §6.3 — effective minimum boundary: EMA50 requires 50 bars
  // on every higher timeframe used by MarketRegimeDetector.
  const HIGHER_TFS: readonly Exclude<CandleTimeframe, "1m">[] = [
    "5m",
    "1h",
    "4h",
    "12h",
    "1d",
    "1w",
  ];
  for (const tf of HIGHER_TFS) {
    it(`${tf}: 49 candles → STRATEGY_CONTEXT_UNAVAILABLE`, async () => {
      const repo = makeRepo({
        candles: {
          ...fullCandleSets(),
          [tf]: makeCandles(49, TIMEFRAME_MS[tf], NOW_MS - TIMEFRAME_MS[tf]),
        },
      });
      const loader = makeLoader(repo);
      const result = await loadDefault(loader);
      assert.equal(result.kind, "error");
      if (result.kind !== "error") return;
      assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
    });

    it(`${tf}: exactly 50 candles → accepted`, async () => {
      const repo = makeRepo({
        candles: {
          ...fullCandleSets(),
          [tf]: makeCandles(50, TIMEFRAME_MS[tf], NOW_MS - TIMEFRAME_MS[tf]),
        },
      });
      const loader = makeLoader(repo);
      const result = await loadDefault(loader);
      assert.equal(result.kind, "ok");
    });
  }

  it("1m: 219 candles → STRATEGY_CONTEXT_UNAVAILABLE (minimum stays 220)", async () => {
    const repo = makeRepo({
      candles: {
        ...fullCandleSets(),
        "1m": makeCandles(219, TIMEFRAME_MS["1m"], NOW_MS - 60_000),
      },
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("1m: exactly 220 candles → accepted (minimum boundary)", async () => {
    const repo = makeRepo({
      candles: {
        ...fullCandleSets(),
        "1m": makeCandles(220, TIMEFRAME_MS["1m"], NOW_MS - 60_000),
      },
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "ok");
  });
});

describe("StrategyContextLoader — contract failures", () => {
  it("no contract row → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({ contract: null });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
    assert.deepEqual(repo.marketStateCalls, []);
  });

  it("contract.symbol mismatch → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({ contract: makeContract({ symbol: "MSFT" }) });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
  });

  it("contract.conid mismatch → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({ contract: makeContract({ conid: "999999" }) });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
  });

  it("contract.exchange + primaryExchange both mismatch → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({
      contract: makeContract({ exchange: "ISLAND", primaryExchange: "ARCA" }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
  });

  it("primaryExchange matches when exchange does not → accepted", async () => {
    const repo = makeRepo({
      contract: makeContract({ exchange: "ISLAND", primaryExchange: "NASDAQ" }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "ok");
  });

  it("null currency → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({ contract: makeContract({ currency: undefined }) });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
  });

  it("null localSymbol → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({
      contract: makeContract({ localSymbol: undefined }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
  });

  it("null tradingClass → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({
      contract: makeContract({ tradingClass: undefined }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
  });

  it("secType mismatch → STRATEGY_CONTRACT_MISMATCH", async () => {
    const repo = makeRepo({ contract: makeContract({ secType: "FUT" }) });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTRACT_MISMATCH");
  });
});

describe("StrategyContextLoader — market state failures", () => {
  it("no market state row → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({ marketState: null });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state conid mismatch → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({ conid: "999999" }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state symbol mismatch → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({ marketState: makeMarketState({ symbol: "MSFT" }) });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state lastPrice NaN → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({ lastPrice: Number.NaN }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state lastPrice Infinity → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({ lastPrice: Number.POSITIVE_INFINITY }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state lastPrice non-numeric → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({ lastPrice: "150" }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state bid NaN → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({ bid: Number.NaN }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state ask non-numeric → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({ marketState: makeMarketState({ ask: "150" }) });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state spread Infinity → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({ spread: Number.POSITIVE_INFINITY }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state timestamp in future → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({
        ts: new Date(NOW_MS + 60_000).toISOString(),
      }),
    });
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });

  it("market state age exceeds maxMarketStateAgeMs → STRATEGY_CONTEXT_UNAVAILABLE", async () => {
    const repo = makeRepo({
      marketState: makeMarketState({
        ts: new Date(NOW_MS - 10 * 60_000).toISOString(),
      }),
    });
    const loader = makeLoader(repo, 60_000);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    assert.equal(result.code, "STRATEGY_CONTEXT_UNAVAILABLE");
  });
});

describe("StrategyContextLoader — cross-conId query safety", () => {
  it("candles are fetched with exact bound.conId, never symbol-only", async () => {
    const repo = makeRepo();
    const loader = makeLoader(repo);
    const result = await loadDefault(loader);
    assert.equal(result.kind, "ok");
    for (const call of repo.candleCalls) {
      assert.equal(call.conId, "265598");
    }
    assert.deepEqual(repo.contractCalls, ["265598"]);
  });
});

describe("GPW3 WSE native warmup", () => {
  it("omits unsupported 12h, demands native closed bars and exposes exact missing TF", async () => {
    const instrument: Instrument = { ...INSTRUMENT, id: "pko_wse", brokerSymbol: "PKO", exchange: "WSE", currency: "PLN" };
    const bound: BoundInstrument = { ...BOUND, instrument, instrumentId: instrument.id, brokerSymbol: "PKO", conId: 35146360,
      localSymbol: "PKO", tradingClass: "PKO", exchange: "WSE", currency: "PLN" };
    const requested: string[] = [];
    const loader = new StrategyContextLoader({ clock: () => NOW, maxMarketStateAgeMs: 60000, repo: {
      getInstrumentContractByConId: async () => makeContract({ symbol: "PKO", conid: "35146360", exchange: "WSE", primaryExchange: "WSE", currency: "PLN", localSymbol: "PKO", tradingClass: "PKO" }),
      getMarketState: async () => ({ conid: "35146360", symbol: "PKO", lastPrice: 60, ts: NOW.toISOString() }),
      getRecentCandlesForContract: async (_symbol, _conid, tf, _limit, nativeOnly) => {
        assert.equal(nativeOnly, true); requested.push(tf);
        return Array.from({ length: tf === "1m" ? 220 : 1 }, (_, i) => ({ conid: "35146360", symbol: "PKO", timeframe: tf,
          ts: new Date(NOW_MS - (220 - i) * 60000), open: 60, high: 61, low: 59, close: 60, volume: 100, source: "ibkr_wse_native_v1" }));
      },
    } });
    const result = await loader.load({ instrument, bound, positionQuantity: 0, timeframes: ["1m", "12h", "1h"] });
    assert.deepEqual(requested, ["1m", "1h"]);
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.match(result.message, /insufficient 1h candles/);
  });
});

describe("GPW3 native WSE freshness measured from conservative close", () => {
  async function evaluate(tf: "1h" | "4h", ageSinceEnd: number, wse = true) {
    const instrument: Instrument = wse ? { ...INSTRUMENT, id: "pko_wse", brokerSymbol: "PKO", exchange: "WSE", currency: "PLN" } : INSTRUMENT;
    const bound: BoundInstrument = wse ? { ...BOUND, instrument, instrumentId: instrument.id, brokerSymbol: "PKO", conId: 35146360,
      localSymbol: "PKO", tradingClass: "PKO", exchange: "WSE", currency: "PLN" } : BOUND;
    const selected = makeCandles(50, TIMEFRAME_MS[tf], NOW_MS - TIMEFRAME_MS[tf] - ageSinceEnd, String(bound.conId), bound.brokerSymbol)
      .map(c => ({ ...c, timeframe: tf, source: "ibkr_wse_native_v1" }));
    const repo = makeRepo({
      contract: makeContract({ symbol: bound.brokerSymbol, conid: String(bound.conId), exchange: bound.exchange, primaryExchange: bound.exchange, currency: bound.currency, localSymbol: bound.localSymbol, tradingClass: bound.tradingClass }),
      candles: { "1m": makeCandles(220, 60000, NOW_MS - 60000, String(bound.conId), bound.brokerSymbol).map(c => ({ ...c, source: "ibkr_wse_native_v1" })), [tf]: selected },
      marketState: makeMarketState({ symbol: bound.brokerSymbol, conid: String(bound.conId) }),
    });
    return makeLoader(repo).load({ instrument, bound, positionQuantity: 0, timeframes: ["1m", tf] });
  }
  for (const [tf, ceiling] of [["1h", 5400000], ["4h", 21600000]] as const) {
    it(`${tf} exact end+ceiling passes; next millisecond and overnight fail`, async () => {
      assert.equal((await evaluate(tf, ceiling)).kind, "ok");
      const beyond = await evaluate(tf, ceiling + 1);
      assert.equal(beyond.kind, "error");
      if (beyond.kind === "error") assert.match(beyond.message, /stale/);
      assert.equal((await evaluate(tf, 24 * 3600000)).kind, "error");
    });
    it(`${tf} unfinished latest bar cannot supply the 50th required native candle`, async () => {
      const unfinished = await evaluate(tf, -1);
      assert.equal(unfinished.kind, "error");
      if (unfinished.kind === "error") assert.match(unfinished.message, /insufficient/);
    });
    it(`${tf} USD retains start-based freshness`, async () => {
      const legacy = await evaluate(tf, ceiling, false);
      assert.equal(legacy.kind, "error");
      if (legacy.kind === "error") assert.match(legacy.message, /stale/);
    });
  }
});

it('PKO profile flows through loader only for exact bound stock WSE PLN identity',async()=>{
  const instrument:Instrument={...INSTRUMENT,id:'pko_wse',brokerSymbol:'PKO',exchange:'WSE',currency:'PLN',assetClass:'stock',
    executionPolicy:{...INSTRUMENT.executionPolicy!,momentumBreakoutProfile:'pko_mild_v1'}};
  const bound:BoundInstrument={...BOUND,instrument,instrumentId:'pko_wse',brokerSymbol:'PKO',conId:35146360,localSymbol:'PKO',tradingClass:'PKO',exchange:'WSE',currency:'PLN'};
  const repo=makeRepo({contract:makeContract({symbol:'PKO',conid:'35146360',exchange:'WSE',primaryExchange:'WSE',currency:'PLN',localSymbol:'PKO',tradingClass:'PKO'}),
    candles:{'1m':makeCandles(220,60000,NOW_MS-60000,'35146360','PKO').map(c=>({...c,source:'ibkr_wse_native_v1'}))},
    marketState:makeMarketState({symbol:'PKO',conid:'35146360'})});
  const loader=makeLoader(repo);const result=await loader.load({instrument,bound,positionQuantity:0,timeframes:['1m']});
  assert.equal(result.kind,'ok');if(result.kind==='ok')assert.equal(result.context.momentumBreakoutProfile,'pko_mild_v1');
  for(const patch of [{currency:'USD'},{exchange:'SMART'},{conId:123},{brokerSymbol:'OTHER'}]){
    const bad=await loader.load({instrument,bound:{...bound,...patch},positionQuantity:0,timeframes:['1m']});assert.equal(bad.kind,'error');
  }
});

describe('AAPL native context and deterministic six-timeframe replay', () => {
  const instrument: Instrument = { ...INSTRUMENT, id: 'aapl_nasdaq', exchange: 'SMART' };
  const bound: BoundInstrument = { ...BOUND, instrument, instrumentId: instrument.id, exchange: 'SMART' };
  const original = nativeAaplFixture();
  const timeframes: CandleTimeframe[] = ['1m','5m','1h','4h','12h','1d','1w'];
  async function evaluate(candles = original, now = AAPL_FIXTURE_NOW, evidence = nativeAaplSchedule(now), changeGeneration = false) {
    const requested: CandleTimeframe[] = [];
    let reads = 0;
    const loader = new StrategyContextLoader({ clock: () => now, maxMarketStateAgeMs: 60000, repo: {
      getAaplScheduleEvidence: async () => ({ ...evidence, generation: evidence.generation + (changeGeneration ? reads++ : 0) }),
      getInstrumentContractByConId: async () => makeContract({ exchange: 'SMART' }),
      getMarketState: async () => makeMarketState({ ts: now.toISOString() }),
      getRecentCandlesForContract: async (symbol, conid, tf, _limit, wseOnly, source) => {
        assert.equal(symbol, 'AAPL'); assert.equal(conid, '265598');
        assert.equal(wseOnly, false); assert.equal(source, AAPL_NATIVE_SOURCE);
        requested.push(tf); return candles[tf as keyof typeof candles] ?? [];
      },
    } });
    return { result: await loader.load({ instrument, bound, positionQuantity: 0, timeframes }), requested };
  }
  it('production loader matches direct closed native context and strategy result on frozen replay', async () => {
    const { result, requested } = await evaluate();
    assert.equal(result.kind, 'ok', JSON.stringify(result)); if (result.kind !== 'ok') return;
    assert.deepEqual(requested, ['1m','5m','1h','4h','1d','1w']);
    assert.deepEqual(result.context.candlesByTimeframe, original);
    const indicators = computeIndicatorsForContext({ secType: 'STK', candlesByTimeframe: original })!;
    const regime = detectRegimeForContext('STK', original['1m'].at(-1)!.close, indicators);
    Object.assign(indicators, { directionalRegime: regime.directionalRegime, volatilityRegime: regime.volatilityRegime,
      regimeScore: regime.score, regimeConfidence: regime.confidence, regimeReasons: regime.reasons,
      timeframeTrendScores: regime.timeframeTrendScores, timeframeTrendVotes: regime.timeframeTrendVotes });
    assert.deepEqual(result.context.indicators, indicators);
    const direct = { ...result.context, indicators, candlesByTimeframe: original, latestCandle: original['1m'].at(-1)!,
      directionalRegime: regime.directionalRegime, volatilityRegime: regime.volatilityRegime };
    assert.deepEqual(evaluateMomentumBreakoutLong(result.context), evaluateMomentumBreakoutLong(direct));
    assert.equal(evaluateMomentumBreakoutLong(result.context).signal, null);
    assert.equal(result.context.momentumBreakoutProfile, 'default');
  });
  for (const tf of ['1m','5m','1h','4h','1d','1w'] as const) {
    for (const bad of ['source','unfinished','foreign','ohlc'] as const) it(`${tf}: ${bad} cannot supply minimum history`, async () => {
      const count = tf === '1m' ? 220 : 50;
      const selected = original[tf].slice(-count).map(c => ({ ...c }));
      const last = selected.at(-1)!;
      if (bad === 'source') last.source = 'legacy';
      if (bad === 'unfinished') last.ts = AAPL_FIXTURE_NOW;
      if (bad === 'foreign') last.conid = '123';
      if (bad === 'ohlc') last.low = last.high + 1;
      const { result } = await evaluate({ ...original, [tf]: selected });
      assert.equal(result.kind, 'error'); if (result.kind === 'error') assert.match(result.message, /insufficient|aapl_/);
    });
  }
  for (const instant of ['2026-09-24T13:31:00Z', '2026-09-28T13:31:00Z', '2026-09-08T13:31:00Z', '2026-11-02T14:31:00Z', '2026-11-27T14:31:00Z', '2026-11-30T14:31:00Z', '2026-03-09T13:31:00Z']) {
    it(`morning replay ${instant} uses previous closed higher bars with first current minute`, async () => {
      const now = new Date(instant), candles = nativeAaplFixture(now);
      const { result } = await evaluate(candles, now);
      assert.equal(result.kind, 'ok', JSON.stringify(result));
      if (result.kind !== 'ok') return;
      assert.equal(result.context.latestCandle.ts.getTime(), now.getTime() - 60000);
      assert.ok(result.context.candlesByTimeframe['4h']!.at(-1)!.ts.getTime() < now.getTime() - 12 * 3600000);
      // The former wall-time freshness rule rejected every morning in this replay.
      assert.ok(now.getTime() - aaplCandleEnd(candles['4h'].at(-1)!.ts, '4h') > 21600000);
      const indicators = computeIndicatorsForContext({ secType: 'STK', candlesByTimeframe: candles })!;
      const regime = detectRegimeForContext('STK', candles['1m'].at(-1)!.close, indicators);
      Object.assign(indicators, { directionalRegime: regime.directionalRegime, volatilityRegime: regime.volatilityRegime,
        regimeScore: regime.score, regimeConfidence: regime.confidence, regimeReasons: regime.reasons,
        timeframeTrendScores: regime.timeframeTrendScores, timeframeTrendVotes: regime.timeframeTrendVotes });
      assert.deepEqual(result.context.indicators, indicators);
      assert.equal(evaluateMomentumBreakoutLong(result.context).signal, null);
    });
  }
  it('09:30 has no closed current-session minute', async () => {
    const now = new Date('2026-09-24T13:30:00Z');
    const { result } = await evaluate(nativeAaplFixture(now), now);
    assert.equal(result.kind, 'error'); if (result.kind === 'error') assert.match(result.message, /current_session_minute/);
  });
  it('a refreshed generation during asynchronous load cannot publish old context', async () => {
    const { result } = await evaluate(original, AAPL_FIXTURE_NOW, nativeAaplSchedule(), true);
    assert.equal(result.kind, 'error'); if (result.kind === 'error') assert.match(result.message, /changed_during_context/);
  });
  for (const status of ['REFRESHING', 'FAILED'] as const) it(`${status} schedule blocks context`, async () => {
    const { result } = await evaluate(original, AAPL_FIXTURE_NOW, { ...nativeAaplSchedule(), status });
    assert.equal(result.kind, 'error'); if (result.kind === 'error') assert.match(result.message, /schedule_unavailable/);
  });
  it('missing new 4h bucket is rejected once boundary publication grace expires', async () => {
    const before = new Date('2026-09-24T15:59:00Z'), now = new Date('2026-09-24T16:01:31Z');
    const history = nativeAaplFixture(now); history['4h'] = nativeAaplFixture(before)['4h'];
    const { result } = await evaluate(history, now);
    assert.equal(result.kind, 'error'); if (result.kind === 'error') assert.match(result.message, /4h: aapl_expected_candle_missing/);
  });
});
