import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseTradingConfiguration, buildStrategyAttribution } from "@ikbr/shared/trading-config";
import type { Candle, TradingConfigurationV1 } from "@ikbr/shared";
import { createStrategy } from "@ikbr/signal-engine/strategies/strategy-registry";
import { replayConfiguredBindings } from "./configured-replay.js";
import { BacktestSimulator, type SimulatorOptions } from "./simulator.js";
import type { BacktestRepository } from "./repository.js";
import type { LoadedBacktestData } from "./types.js";

const fixture = parseTradingConfiguration(readFileSync(new URL("../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8"));
if (!fixture.ok) throw Error("invalid fixture");
const configuration = fixture.configuration;
const symbol = "AAPL", conid = "265598", end = Date.parse("2026-06-01T12:00:00Z");
function candles(timeframe: Candle["timeframe"], count: number, duration: number, rate: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 80 * (1 + rate) ** i;
    return { symbol, conid, timeframe, ts: new Date(end - (count-i)*duration), open: close-0.1, high: close+0.2, low: close-0.2, close, volume: 10000 };
  });
}
function data(): LoadedBacktestData {
  const minute = candles("1m", 250, 60000, 0.0002);
  const flat = minute[224].close;
  for (let i=225;i<249;i++) Object.assign(minute[i], { open: flat-0.05, high: flat+0.16, low:flat-0.16, close:flat+Math.sin(i)*0.12 });
  Object.assign(minute[249], { open:flat+0.02, high:flat+0.25, low:flat, close:flat+0.23, volume:15000 });
  minute.push({ ...minute[249], ts:new Date(end), open:flat+0.23, low:flat+0.2, high:flat+4, close:flat+3 });
  return { dataset:{id:1,dateFrom:new Date(minute[0].ts).toISOString(),dateTo:new Date(end).toISOString(),status:"ready",symbols:[symbol],candlesCount:minute.length,startedAt:new Date(0).toISOString()},
    candles1m:new Map([[symbol,minute]]),candles5m:new Map([[symbol,candles("5m",160,300000,0.0004)]]),candles1h:new Map([[symbol,candles("1h",160,3600000,0.003)]]),
    candles4h:new Map([[symbol,candles("4h",120,14400000,0.003)]]),candles12h:new Map(),candles1d:new Map([[symbol,candles("1d",260,86400000,0.01)]]),candles1w:new Map(),candleCount1m:minute.length,fxRates:[] };
}
const options: SimulatorOptions = {
  minCandles:220,maxSpreadBps:100,minVolume1m:0,minConfidence:0,lmtEntryMode:"touch",lmtEntryBufferBps:0,fractionalSymbols:new Set(),fractionalQuantityStep:1,minStopBpsBySecType:{STK:0},baseCurrency:"USD",currencyBySymbol:{AAPL:"USD"},secTypeBySymbol:{AAPL:"STK"},priceMultiplierBySymbol:{},strategyCooldownMs:43200000,
  commissionBps:0,commissionPerShare:0.0035,commissionMinPerSide:0.35,commissionPassthroughBps:0,syntheticSpreadBps:0,orderTtlCandles:2,futuresSpecs:new Map(),futuresContracts:new Map(),futuresCalendars:new Map(),riskLimits:{accountEquity:100000,maxRiskPerTradePct:1,maxExposurePct:100,maxNotionalPerTradePct:100,maxOpenPositions:1},
};
function repository() {
  const orders: unknown[] = [], fills:unknown[] = [], configs:unknown[]=[];
  let id=0;
  const repo = { createRun:async(_datasetId:number,config:unknown)=>{configs.push(config);return{id:++id};}, finishRun:async()=>({}), insertOrder:async(order:unknown)=>{orders.push(order);return orders.length;},insertFill:async(fill:unknown)=>{fills.push(fill);return 1;},updateOrderStatus:async()=>{},upsertStrategyStates:async()=>{},upsertSignalDiagnostics:async()=>{} } as unknown as BacktestRepository;
  return { repo, orders, fills, configs };
}
const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key,v)=>key==="strategyAttribution" ? undefined:v));
test("configured default replay retains full legacy signals, orders, fills and P&L", async()=>{
  const configured = repository(), legacy = repository();
  const result = await replayConfiguredBindings({configuration,instrumentId:"aapl_smart",data:data(),options,repository:configured.repo});
  const signals:unknown[]=[];
  const metrics = await new BacktestSimulator(legacy.repo,1,data(),{...options,strategyIds:["momentum_breakout_long_v1"],strategyFactory:()=>{
    const strategy=createStrategy("momentum_breakout_long_v1");
    const original=strategy.generateSignal.bind(strategy);
    strategy.generateSignal=(ctx)=>{const signal=original(ctx);if(signal)signals.push(signal);return signal;};return[strategy];
  }}).run();
  assert.deepEqual(strip(result[0].signals),strip(signals));
  assert.deepEqual(strip(result[0].orders),strip(legacy.orders));
  assert.deepEqual(strip(result[0].fills),strip(legacy.fills));
  assert.deepEqual(result[0].metrics,metrics);
  assert.ok(result[0].signals.length > 0);
  assert.ok(result[0].orders.length > 0);
  assert.ok(result[0].fills.length > 0);
  assert.deepEqual((configured.configs[0] as any).strategyAttribution,buildStrategyAttribution(configuration,"aapl_smart","momentum_default"));
});
test("separate parameter instances stay independently attributed", async()=>{
  const custom:TradingConfigurationV1={...configuration,strategyInstances:[...configuration.strategyInstances,{...configuration.strategyInstances[0],id:"strict_daily",parameters:{...configuration.strategyInstances[0].parameters,dailyReturn20MinPct:40}}],instruments:configuration.instruments.map(row=>row.id==="aapl_smart"?{...row,strategySelection:{mode:"priority",instanceIds:["momentum_default","strict_daily"],priorities:{momentum_default:1,strict_daily:2}}}:row)};
  const tracked=repository();
  const result=await replayConfiguredBindings({configuration:custom,instrumentId:"aapl_smart",data:data(),options,repository:tracked.repo});
  assert.deepEqual(result.map(row=>row.strategyAttribution.instanceId),["momentum_default","strict_daily"]);
  assert.equal(result[1].signals.length,0);
  assert.ok(result[0].signals.length>0,"boundary fixture must emit default signal");
  assert.equal(tracked.configs.length,2);
});
test("symbol and contract ambiguity fail before creating a run",async()=>{
  const tracked=repository(), loaded=data();loaded.candles1m.get(symbol)![0].conid="other";
  await assert.rejects(replayConfiguredBindings({configuration,instrumentId:"aapl_smart",data:loaded,options,repository:tracked.repo}),/REPLAY_CONTRACT_MISMATCH/);
  assert.equal(tracked.configs.length,0);
  const ambiguous = {...configuration,instruments:[...configuration.instruments,{...configuration.instruments[1],id:"other_listing"}]};
  await assert.rejects(replayConfiguredBindings({configuration:ambiguous,instrumentId:"aapl_smart",data:data(),options,repository:tracked.repo}),/REPLAY_SYMBOL_AMBIGUOUS/);
  assert.equal(tracked.configs.length,0);
});
