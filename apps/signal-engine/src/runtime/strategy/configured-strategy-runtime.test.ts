import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Fastify from "fastify";
import { parseTradingConfiguration, computeTradingConfigurationHash, buildTradingConfigurationProjection } from "@ikbr/shared/trading-config";
import type { Strategy,StrategyContext } from "../../strategies/strategy.types.js";
import { ConfiguredStrategyRuntime } from "./configured-strategy-runtime.js";
import { configuredStrategyRoutes } from "./configured-strategy-routes.js";
const now=new Date("2026-09-28T12:00:30.000Z");
function setup(options:{priority?:boolean;disabled?:boolean;exception?:boolean;directionConflict?:boolean}={}){
 const raw=JSON.parse(readFileSync(new URL("../../../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json",import.meta.url),"utf8"));
 raw.instruments[0].entryEnabled=true;raw.instruments[0].monitoringEnabled=true;
 const first=raw.strategyInstances[0].id;
 raw.strategyInstances[0].enabled=!options.disabled;
 if(options.priority){raw.strategyInstances.push({...raw.strategyInstances[0],id:"second"});raw.instruments[0].strategySelection={mode:"priority",instanceIds:[first,"second"],priorities:{[first]:10,second:20}};}
 const parsed=parseTradingConfiguration(raw);assert.ok(parsed.ok);if(!parsed.ok)throw Error("fixture");
 const projection=buildTradingConfigurationProjection(parsed.configuration),calls:string[]=[],objects:Strategy[]=[];
 const row=parsed.configuration.instruments[0];
 const runtime=new ConfiguredStrategyRuntime({configuration:parsed.configuration,effectiveConfigHash:computeTradingConfigurationHash(parsed.configuration),accountId:"DU_TEST",authority:projection.authority,registry:projection.registry,
 state:{sync:async()=>({enabled:true,permanentlyDisabled:false})},assertEvaluationAllowed:async()=>{},clock:()=>now,
 contextLoader:{load:async(input)=>{assert.ok(!input.timeframes.includes("12h"));return {kind:"ok",context:{symbol:input.instrument.brokerSymbol,secType:"STK",directionalRegime:"bull_trend",volatilityRegime:"normal_volatility",marketState:{lastPrice:10,ts:now}} as StrategyContext};}},
 factory:(instance)=>{const strategy:Strategy={id:instance.implementationId,secTypes:["STK"],supportedDirections:["LONG","SHORT"],allowedDirectionalRegimes:["bull_trend"],allowedVolatilityRegimes:["normal_volatility"],requiredTimeframes:["1m"],generateSignal:(context)=>{
 calls.push(instance.id);if(options.exception&&instance.id==="second")throw Error("private exception");const short=options.directionConflict&&instance.id==="second";
 return {strategyId:instance.implementationId,symbol:context.symbol,direction:short?"SHORT":"LONG",side:short?"SELL":"BUY",confidenceScore:instance.id==="second"?0.1:1,entryReason:"fixture"};}};objects.push(strategy);return strategy;}});
 return {runtime,row,calls,objects};
}
test("priority ignores confidence and emits immutable assignment plus trusted trigger",async()=>{const f=setup({priority:true}),r=await f.runtime.evaluate(f.row.id);assert.equal(r.kind,"signal");assert.equal(r.strategyAttribution?.instanceId,"second");assert.equal(f.calls.length,2);assert.equal(r.entryAllowed,false);assert.equal(r.strategyTrigger?.bucketStartMs,Date.parse("2026-09-28T12:00:00Z"));});
test("disabled assignment does not call strategy",async()=>{const f=setup({disabled:true});assert.equal((await f.runtime.evaluate(f.row.id)).kind,"disabled");assert.equal(f.calls.length,0);});
test("any strategy exception discards previous candidates",async()=>{const f=setup({priority:true,exception:true});const r=await f.runtime.evaluate(f.row.id);assert.equal(r.kind,"error");assert.equal(r.signal,undefined);assert.deepEqual(r.reasons,["STRATEGY_EVALUATION_EXCEPTION"]);});
test("opposite directions block even with explicit higher priority",async()=>{const f=setup({priority:true,directionConflict:true});assert.deepEqual((await f.runtime.evaluate(f.row.id)).reasons,["STRATEGY_CONFLICT"]);});
test("real route calls configured evaluator and rejects caller parameters",async()=>{const f=setup({priority:true}),app=Fastify();await app.register(configuredStrategyRoutes,{runtime:f.runtime});const r=await app.inject({method:"POST",url:"/runtime/strategy-evaluation",payload:{instrumentId:f.row.id}});assert.equal(r.statusCode,200);assert.equal(r.json().strategyAttribution.instanceId,"second");assert.equal((await app.inject({method:"POST",url:"/runtime/strategy-evaluation",payload:{instrumentId:f.row.id,parameters:{}}})).statusCode,400);await app.close();});

test("native loader and real configured factory evaluate three configured contracts without executable policy",async()=>{
 const { StrategyContextLoader }=await import("./strategy-context-loader.js");
 const { fixtureSessionSchedule,fixtureSessionCandles }=await import("./session-native.fixture.js");
 const { buildInstrumentSessionIdentity }=await import("@ikbr/shared");
 const raw=JSON.parse(readFileSync(new URL("../../../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json",import.meta.url),"utf8"));
 const parsed=parseTradingConfiguration(raw);assert.ok(parsed.ok);if(!parsed.ok)return;
 const projection=buildTradingConfigurationProjection(parsed.configuration),cache=new Map<string,ReturnType<typeof fixtureSessionCandles>>();
 const loader=new StrategyContextLoader({clock:()=>now,maxMarketStateAgeMs:90_000,repo:{
  getSessionScheduleEvidence:async identity=>fixtureSessionSchedule(identity,now,0,1440,800),
  getInstrumentContractByConId:async conid=>{const row=parsed.configuration.instruments.find(r=>String(r.contract.conId)===conid)!;return {...row.contract,conid,secType:"STK",source:"ibkr"};},
  getRecentCandlesForContract:async(_symbol,conid,timeframe)=>{if(!cache.has(conid)){const bound=projection.authority.listBoundInstruments().find(b=>String(b.conId)===conid)!;cache.set(conid,fixtureSessionCandles(bound,now));}return cache.get(conid)![timeframe as keyof ReturnType<typeof fixtureSessionCandles>]??[];},
  getMarketState:async conid=>{const row=parsed.configuration.instruments.find(r=>String(r.contract.conId)===conid)!;return {conid,symbol:row.contract.symbol,lastPrice:150.3,bid:150.29,ask:150.31,ts:now.toISOString()};},
 }});
 const runtime=new ConfiguredStrategyRuntime({configuration:parsed.configuration,effectiveConfigHash:computeTradingConfigurationHash(parsed.configuration),accountId:"DU_TEST",authority:projection.authority,registry:projection.registry,contextLoader:loader,state:{sync:async()=>({enabled:true,permanentlyDisabled:false})},assertEvaluationAllowed:async()=>{},clock:()=>now});
 for(const row of parsed.configuration.instruments.slice(0,3)){const bound=projection.authority.getBoundInstrument(row.id)!;assert.ok(buildInstrumentSessionIdentity(bound.instrument,bound));const result=await runtime.evaluate(row.id);assert.equal(result.kind,"no_signal",JSON.stringify(result));assert.equal(result.entryAllowed,false);}
});

test("same reusable instance on two instruments receives distinct objects and attribution",async()=>{
 const f=setup();const first=await f.runtime.evaluate(f.row.id);const secondId=f.runtime.listInstrumentIds()[1];const second=await f.runtime.evaluate(secondId);
 assert.equal(first.kind,"signal");assert.equal(second.kind,"signal");assert.equal(first.strategyAttribution?.instanceId,second.strategyAttribution?.instanceId);
 assert.notEqual(first.strategyAttribution?.instrumentId,second.strategyAttribution?.instrumentId);assert.equal(f.objects.length,2);assert.notEqual(f.objects[0],f.objects[1]);
});
