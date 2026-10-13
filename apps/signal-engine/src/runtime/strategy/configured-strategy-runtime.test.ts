import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Fastify from "fastify";
import { parseTradingConfiguration, computeTradingConfigurationHash, buildTradingConfigurationProjection } from "@ikbr/shared/trading-config";
import type { Strategy,StrategyContext } from "../../strategies/strategy.types.js";
import { ConfiguredStrategyRuntime, type ConfiguredStrategyRuntimeOptions } from "./configured-strategy-runtime.js";
import { configuredStrategyRoutes } from "./configured-strategy-routes.js";
const now=new Date("2026-09-28T12:00:30.000Z");
function setup(options:{priority?:boolean;disabled?:boolean;exception?:boolean;directionConflict?:boolean;checkSession?:ConfiguredStrategyRuntimeOptions["contextLoader"]["checkSession"];loadError?:string}={}){
 const raw=JSON.parse(readFileSync(new URL("../../../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json",import.meta.url),"utf8"));
 raw.instruments[0].entryEnabled=true;raw.instruments[0].monitoringEnabled=true;
 const first=raw.strategyInstances[0].id;
 raw.strategyInstances[0].enabled=!options.disabled;
 if(options.priority){raw.strategyInstances.push({...raw.strategyInstances[0],id:"second"});raw.instruments[0].strategySelection={mode:"priority",instanceIds:[first,"second"],priorities:{[first]:10,second:20}};}
 const parsed=parseTradingConfiguration(raw);assert.ok(parsed.ok);if(!parsed.ok)throw Error("fixture");
 const projection=buildTradingConfigurationProjection(parsed.configuration),calls:string[]=[],objects:Strategy[]=[];
 const row=parsed.configuration.instruments[0];
 const counts={state:0,load:0};
 const runtime=new ConfiguredStrategyRuntime({configuration:parsed.configuration,effectiveConfigHash:computeTradingConfigurationHash(parsed.configuration),accountId:"DU_TEST",authority:projection.authority,registry:projection.registry,
 state:{sync:async()=>{counts.state++;return {enabled:true,permanentlyDisabled:false};}},assertEvaluationAllowed:async()=>{},clock:()=>now,
 contextLoader:{checkSession:options.checkSession??(async()=>({kind:"OPEN",reason:"MARKET_SESSION_OPEN",evidenceKey:"fixture",checkedAt:100,activeIntervalEnd:200})),load:async(input)=>{counts.load++;if(options.loadError)return {kind:"error",code:"STRATEGY_CONTEXT_UNAVAILABLE",message:options.loadError};assert.ok(!input.timeframes.includes("12h"));return {kind:"ok",context:{symbol:input.instrument.brokerSymbol,secType:"STK",directionalRegime:"bull_trend",volatilityRegime:"normal_volatility",marketState:{lastPrice:10,ts:now}} as StrategyContext};}},
 factory:(instance)=>{const strategy:Strategy={id:instance.implementationId,secTypes:["STK"],supportedDirections:["LONG","SHORT"],allowedDirectionalRegimes:["bull_trend"],allowedVolatilityRegimes:["normal_volatility"],requiredTimeframes:["1m"],generateSignal:(context)=>{
 calls.push(instance.id);if(options.exception&&instance.id==="second")throw Error("private exception");const short=options.directionConflict&&instance.id==="second";
 return {strategyId:instance.implementationId,symbol:context.symbol,direction:short?"SHORT":"LONG",side:short?"SELL":"BUY",confidenceScore:instance.id==="second"?0.1:1,entryReason:"fixture"};}};objects.push(strategy);return strategy;}});
 return {runtime,row,calls,objects,counts};
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

test("closed instruments skip all state, strategy creation, context and signal work",async()=>{
 const f=setup({checkSession:async()=>({kind:"CLOSED",reason:"MARKET_SESSION_CLOSED",evidenceKey:"stable"})});
 const result=await f.runtime.evaluate(f.row.id);
 assert.equal(result.kind,"skipped");assert.deepEqual(result.reasons,["MARKET_SESSION_CLOSED"]);
 assert.deepEqual(f.counts,{state:0,load:0});assert.equal(f.objects.length,0);assert.equal(f.calls.length,0);
 assert.equal(result.signal,undefined);assert.equal(result.strategyTrigger,undefined);assert.equal(result.strategyAttribution,undefined);assert.equal(result.entryAllowed,false);
});
test("missing session evidence remains a real error before strategy work",async()=>{
 const f=setup({checkSession:async()=>({kind:"UNKNOWN",reason:"STRATEGY_CONTEXT_UNAVAILABLE"})});
 assert.equal((await f.runtime.evaluate(f.row.id)).kind,"error");assert.deepEqual(f.counts,{state:0,load:0});assert.equal(f.objects.length,0);
});
test("closed instruments do not suppress an independently open instrument or next opening tick",async()=>{
 let closed=true;
 const f=setup({checkSession:async input=>({kind:closed&&input.instrument.id==='pko_wse'?"CLOSED":"OPEN",reason:"fixture",evidenceKey:"stable",checkedAt:100,activeIntervalEnd:200})});
 assert.equal(f.row.id,'pko_wse');assert.equal((await f.runtime.evaluate(f.row.id)).kind,"skipped");
 assert.equal((await f.runtime.evaluate(f.runtime.listInstrumentIds()[1])).kind,"signal");
 closed=false;assert.equal((await f.runtime.evaluate(f.row.id)).kind,"signal");
});
for(const loadError of [undefined,"session_closed","session_interval_closed","1m: session_closed","session_schedule_coverage_missing","market state stale during context load"]){
 for(const changed of [false,true])test(`close race preserves generation/error evidence: ${loadError} changed=${changed}`,async()=>{
  let reads=0;
  const f=setup({loadError,checkSession:async()=>({kind:reads++===0?"OPEN":"CLOSED",reason:"fixture",historyReady:true,evidenceKey:changed&&reads>1?"changed":"stable",checkedAt:reads===1?100:200,activeIntervalEnd:200})});
  const result=await f.runtime.evaluate(f.row.id);
  assert.equal(result.kind,changed||loadError?.startsWith("market state")?"error":"skipped");
  assert.equal(result.signal,undefined);assert.equal(f.calls.length,0);
 });
}
test("current OPEN hours cannot turn initially incomplete historical coverage into closed skip",async()=>{
 let reads=0;
 const f=setup({loadError:"session_schedule_coverage_missing",checkSession:async()=>({kind:reads++===0?"OPEN":"CLOSED",reason:"fixture",historyReady:false,evidenceKey:"stable",checkedAt:reads===1?100:200,activeIntervalEnd:200})});
 assert.equal((await f.runtime.evaluate(f.row.id)).kind,"error");assert.equal(f.calls.length,0);
});
test("close during synchronous strategy evaluation discards generated signal",async()=>{
 let reads=0;
 const f=setup({checkSession:async()=>({kind:++reads>=3?"CLOSED":"OPEN",reason:"fixture",evidenceKey:"stable",checkedAt:reads>=3?200:100,activeIntervalEnd:200})});
 const result=await f.runtime.evaluate(f.row.id);assert.equal(result.kind,"skipped");assert.equal(result.signal,undefined);assert.equal(f.calls.length,1);assert.deepEqual(result.reasons,["MARKET_SESSION_CLOSED_AFTER_EVALUATION"]);assert.deepEqual(result.entryBlockers,[]);
});

for (const later of [90,150]) test(`same-evidence CLOSED without a forward close boundary remains error: ${later}`, async()=>{
 let reads=0;
 const f=setup({loadError:"session_closed",checkSession:async()=>({kind:reads++===0?"OPEN":"CLOSED",reason:"fixture",evidenceKey:"stable",checkedAt:reads===1?100:later,activeIntervalEnd:200})});
 const result=await f.runtime.evaluate(f.row.id);assert.equal(result.kind,"error");assert.equal(f.calls.length,0);assert.equal(result.signal,undefined);
});
test("same broker evidence and backwards clock into preopen is not a close race",async()=>{
 const {classifySessionAvailability,parseBrokerContractSessionHours,buildInstrumentSessionIdentity}=await import("@ikbr/shared");
 const {fixtureSessionSchedule}=await import("./session-native.fixture.js");
 let reads=0;
 const f=setup({loadError:"session_closed",checkSession:async({instrument,bound})=>{
  const identity=buildInstrumentSessionIdentity(instrument,bound), stamp=new Date("2026-09-28T06:00:00.000Z");
  const evidence=fixtureSessionSchedule(identity,stamp);
  evidence.schedule!.currentHours=parseBrokerContractSessionHours({timeZoneId:identity.timeZone,liquidHours:'20260928:0900-1705'},identity,evidence.schedule!.requestedAt,evidence.schedule!.receivedAt);
  return classifySessionAvailability(evidence,identity,Date.parse(reads++===0?"2026-09-28T08:00:00Z":"2026-09-28T06:30:00Z"));
 }});
 const result=await f.runtime.evaluate(f.row.id);assert.equal(result.kind,"error");assert.equal(f.calls.length,0);
});
