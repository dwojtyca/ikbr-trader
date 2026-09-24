import { buildInstrumentSessionIdentity, sessionNativeSource } from '@ikbr/shared';
import { fixtureSessionSchedule, fixtureSessionCandles, SESSION_TIMEFRAMES } from './session-native.fixture.js';
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
      timeframe: Object.entries(TIMEFRAME_MS).find(([, ms]) => ms === timeframeMs)?.[0] as CandleTimeframe,
      source: sessionNativeSource(buildInstrumentSessionIdentity(INSTRUMENT, BOUND)),
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
  return fixtureSessionCandles(BOUND, NOW);
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
    getSessionScheduleEvidence: async (identity: import("@ikbr/shared").InstrumentSessionIdentity) => fixtureSessionSchedule(identity, NOW),
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
        "1m": [makeCandles(1, TIMEFRAME_MS["1m"], NOW_MS + 60_000)[0]],
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
    "1d",
    "1w",
  ];
  for (const tf of HIGHER_TFS) {
    it(`${tf}: 49 candles → STRATEGY_CONTEXT_UNAVAILABLE`, async () => {
      const repo = makeRepo({
        candles: {
          ...fullCandleSets(),
          [tf]: fullCandleSets()[tf]!.slice(-49),
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
          [tf]: fullCandleSets()[tf]!.slice(-50),
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


describe('instrument-independent native session readiness', () => {
  const cases = [
    ['pko_wse','PKO',35146360,'WSE','PLN','Europe/Warsaw',540,1020,'2026-09-24T07:01:00Z'],
    ['aapl_nasdaq','AAPL',265598,'SMART','USD','America/New_York',570,960,'2026-09-24T13:31:00Z'],
    ['msft','MSFT',272093,'SMART','USD','America/New_York',570,960,'2026-09-24T13:31:00Z'],
    ['london_other','OTHER',123456,'LSE','GBP','Europe/London',480,990,'2026-09-24T07:01:00Z'],
    ['arbitrary_asia','XYZ',67890,'NSE','INR','Asia/Kolkata',555,930,'2026-09-24T03:46:00Z'],
    ['overnight_future','FUTURE',98765,'CME','USD','America/Chicago',-360,1020,'2026-09-23T23:01:00Z'],
    ['fx_other','EUR',12087792,'IDEALPRO','USD','UTC',0,1440,'2026-09-24T00:01:00Z'],
  ] as const;
  async function setup(row: typeof cases[number], patch: { now?: Date; mode?: boolean } = {}) {
    const [id,symbol,conId,exchange,currency,timezone,open,close,instant] = row;
    const now = patch.now ?? new Date(instant);
    const instrument: Instrument = { ...INSTRUMENT, id, brokerSymbol:symbol, exchange, currency, assetClass: id==='overnight_future'?'future':id==='fx_other'?'forex':'stock',
      session: { ...INSTRUMENT.session, timezone, useRegularTradingHours: patch.mode ?? (id!=='fx_other') } };
    const bound: BoundInstrument = {...BOUND,instrument,instrumentId:id,brokerSymbol:symbol,conId,exchange,currency,localSymbol:symbol,tradingClass:symbol};
    const identity = buildInstrumentSessionIdentity(instrument,bound);
    const evidence = fixtureSessionSchedule(identity,now,open,close);
    const candles = fixtureSessionCandles(bound,now,open,close);
    const repo: StrategyContextLoaderRepo = {
      getSessionScheduleEvidence:async()=>evidence,
      getRecentCandlesForContract:async(s,c,tf,_limit,wseOnly,source)=>{
        assert.equal(s,symbol);assert.equal(c,String(conId));assert.equal(wseOnly,false);assert.equal(source,sessionNativeSource(identity));
        return candles[tf as keyof typeof candles] ?? [];
      },
      getInstrumentContractByConId:async()=>makeContract({symbol,conid:String(conId),exchange,primaryExchange:exchange,currency,localSymbol:symbol,tradingClass:symbol,secType:identity.secType}),
      getMarketState:async()=>makeMarketState({symbol,conid:String(conId),ts:now.toISOString()}),
    };
    const load = (timeframes: readonly CandleTimeframe[] = SESSION_TIMEFRAMES, clock = ()=>now) => new StrategyContextLoader({repo,clock,maxMarketStateAgeMs:60000}).load({instrument,bound,positionQuantity:0,timeframes});
    return {load,repo,candles,evidence,now,instrument,bound};
  }
  for (const row of cases) it(`${row[1]} first closed minute uses previous-session higher bars and calendar strategy hours`, async()=>{
    const {load,now,candles} = await setup(row);
    const result = await load();assert.equal(result.kind,'ok',JSON.stringify(result));if(result.kind!=='ok')return;
    assert.equal(result.context.latestCandle.ts.getTime(),now.getTime()-60000);
    assert.ok(candles['4h'].at(-1)!.ts.getTime()<now.getTime()-(['overnight_future','fx_other'].includes(row[0])?1:12)*3600000);
    const evaluation=evaluateMomentumBreakoutLong({...result.context,directionalRegime:'bull_trend',volatilityRegime:'normal_volatility'});
    assert.notEqual(evaluation.rejectionReason,'outside_strategy_session');
    const indicators=computeIndicatorsForContext({secType:result.context.secType,candlesByTimeframe:candles,verifiedSession:result.context.verifiedSession})!;
    const regime=detectRegimeForContext(result.context.secType,result.context.latestCandle.close,indicators);
    assert.equal(result.context.indicators.regimeScore,regime.score);
    assert.equal(result.context.indicators.intraday?.minutesSinceSessionOpen,0);
  });
  it('explicit 12h requirement fails rather than silently being omitted',async()=>{
    const {load}=await setup(cases[0]);const result=await load(['1m','12h']);assert.equal(result.kind,'error');if(result.kind==='error')assert.match(result.message,/unsupported_native_timeframe:12h/);
  });
  for(const mutation of ['missing','generation','mode','duplicate','source','quote_future'] as const)it(`${mutation} fails closed for arbitrary instrument`,async()=>{
    const state=await setup(cases[4]);let reads=0;
    if(mutation==='missing')state.repo.getSessionScheduleEvidence=async()=>null;
    if(mutation==='generation')state.repo.getSessionScheduleEvidence=async()=>({...state.evidence,generation:1+reads++});
    if(mutation==='mode')state.evidence.schedule!.identity.useRTH=false;
    if(mutation==='duplicate')state.candles['1m'].push({...state.candles['1m'].at(-1)!});
    if(mutation==='source')state.candles['1m'][0].source='ibkr_wse_native_v1';
    if(mutation==='quote_future')state.repo.getMarketState=async()=>makeMarketState({symbol:state.bound.brokerSymbol,conid:String(state.bound.conId),ts:new Date(state.now.getTime()+1000).toISOString()});
    const result=await state.load();assert.equal(result.kind,'error',JSON.stringify(result));
  });
  it('unknown MIDPOINT volume preserves FX price context without fabricating volume indicators',async()=>{
    const state=await setup(cases[6]);
    for(const rows of Object.values(state.candles))for(const candle of rows)candle.volume=-1;
    const result=await state.load();assert.equal(result.kind,'ok',JSON.stringify(result));if(result.kind!=='ok')return;
    assert.equal(result.context.latestCandle.volume,-1);assert.ok(result.context.indicators.ema20);
    for(const value of [result.context.indicators.cmf20,result.context.indicators.mfi14,result.context.indicators.obvSlope,result.context.indicators.timeframes?.['1h']?.cmf20,result.context.indicators.intraday?.vwap,result.context.indicators.intraday?.sessionVolume])assert.equal(value,undefined);
    assert.equal(evaluateMomentumBreakoutLong(result.context).rejectionReason,'volume_evidence_unavailable');
  });
  it('quote arriving after context start is checked against post-fetch clock',async()=>{
    const state=await setup(cases[0]);let current=state.now.getTime();
    state.repo.getMarketState=async()=>{current+=100;return makeMarketState({symbol:state.bound.brokerSymbol,conid:String(state.bound.conId),ts:new Date(current).toISOString()});};
    const result=await state.load(SESSION_TIMEFRAMES,()=>new Date(current));assert.equal(result.kind,'ok',JSON.stringify(result));
  });
  it('before first minute closes prior-session minute cannot satisfy readiness',async()=>{
    const state=await setup(cases[0],{now:new Date('2026-09-24T07:00:59Z')});const result=await state.load();assert.equal(result.kind,'error');if(result.kind==='error')assert.match(result.message,/current_interval_minute_missing/);
  });
});
