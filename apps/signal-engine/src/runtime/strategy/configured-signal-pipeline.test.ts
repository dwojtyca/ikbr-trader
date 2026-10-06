import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeStockStrategyLevels, type ExecutionTicketPolicy, type StockMarketMetadata } from '@ikbr/shared';
import { parseTradingConfiguration, buildTradingConfigurationProjection, buildStrategyAttribution } from '@ikbr/shared/trading-config';
import { MarketDataRuntime } from '../runtime.js';
import { PriceContextProvider } from '../price-provider.js';
import { BrokerStateContextProvider } from '../broker-state-provider.js';
import { createRuntimeEngines } from '../engines.js';
import { ExecutionRuntime } from '../execution/execution-runtime.js';
import { PaperGuard } from '../execution/paper-guard.js';
import { fixtureSessionSchedule } from './session-native.fixture.js';
import { buildInstrumentSessionIdentity } from '@ikbr/shared';
import type { StrategySignal } from '../../strategies/strategy.types.js';
const now = new Date('2026-10-05T14:00:30.000Z');
function fixture(index = 1) {
  const parsed = parseTradingConfiguration(JSON.parse(readFileSync(new URL('../../../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json',import.meta.url),'utf8')));
  assert.ok(parsed.ok); if (!parsed.ok) throw Error('fixture');
  const {registry,authority} = buildTradingConfigurationProjection(parsed.configuration);
  const row = parsed.configuration.instruments[index], bound = authority.getBoundInstrument(row.id)!;
  const attribution = buildStrategyAttribution(parsed.configuration,row.id,row.strategySelection.instanceIds[0]);
  const trigger = {version:1,source:'evaluation_bucket',timeframe:'1m',observedAt:now.toISOString(),bucketStartMs:Math.floor(now.getTime()/60000)*60000} as const;
  const signal: StrategySignal = {strategyId:attribution.implementationId,symbol:row.contract.symbol,direction:'LONG',side:'BUY',confidenceScore:.67,
    entryReason:'selected configured strategy evidence',suggestedEntry:100.019,stopLoss:99.013,takeProfit:103.001,strategyAttribution:attribution,strategyTrigger:trigger};
  const state = {ready:true,exposure:false,priceAt:now,priceAvailable:true,genericCalls:0};
  const probe = {probeReady:async()=>({kind:'ok' as const,ready:state.ready,environment:'paper' as const,accountMatchesEnvironment:true,tradingEnabled:true})};
  const exposure = {readExposure:async()=>({hasOpenPosition:state.exposure,hasActiveOrder:false,hasAmbiguousSubmission:false,hasPendingProposal:false,quantity:0})};
  const metadata: StockMarketMetadata = {accountId:'DU_FIXTURE',instrumentId:row.id,conId:bound.conId,symbol:bound.brokerSymbol,
    localSymbol:bound.localSymbol!,tradingClass:bound.tradingClass!,exchange:row.contract.exchange,primaryExchange:row.contract.primaryExchange,
    currency:row.contract.currency,secType:'STK',minTick:bound.minTick,marketRuleId:1,priceIncrements:[{lowEdge:0,increment:.01}],
    requestStartedAtMs:now.getTime()-1,receivedAtMs:now.getTime(),sessionEvidence:fixtureSessionSchedule(buildInstrumentSessionIdentity(bound.instrument,bound),now)};
  const prices=normalizeStockStrategyLevels(metadata,bound,'DU_FIXTURE',{entry:signal.suggestedEntry!,stopLoss:signal.stopLoss!,takeProfit:signal.takeProfit!},now.getTime());
  const policy: ExecutionTicketPolicy = {quantity:1,orderType:'LMT',timeInForce:'DAY',outsideRth:false,transmit:true,priceTickSize:bound.minTick,priceRoundingMode:'nearest',strategyPrices:prices.final};
  const generic=createRuntimeEngines({registry,now:()=>now}).pipeline;
  const genericRun=generic.run.bind(generic);generic.run=(...args)=>{state.genericCalls++;return genericRun(...args);};
  const runtime=new MarketDataRuntime({registry,now:()=>now,pipeline:generic,providers:[
    new PriceContextProvider({freshnessTtlMs:10000,reader:{readMarketState:async()=>state.priceAvailable?{instrumentId:row.id,lastPrice:101,bid:100.99,ask:101.01,observedAt:state.priceAt,source:'fixture'}:null}}),
    new BrokerStateContextProvider({probe,exposure,now:()=>now}),
  ]});
  return {runtime,signal,policy,row,state,probe,bound,authority,prices,metadata,prepare:()=>runtime.prepareConfiguredSignal({instrumentId:row.id,signal,policy})};
}
for(const index of [0,1,2]) test(`configured signal preserves selected levels/identity without generic reevaluation stock ${index}`,async()=>{
  const f=fixture(index), result=await f.prepare();assert.equal(result.pipeline.outcome,'SUCCESS',JSON.stringify(result.pipeline));
  assert.equal(f.state.genericCalls,0);
  if(result.pipeline.outcome!=='SUCCESS')return;
  assert.equal(result.pipeline.ticket.order.limitPrice,100.01);assert.equal(result.pipeline.ticket.protection.stopLoss,99.01);assert.equal(result.pipeline.ticket.protection.takeProfit,103.01);
  assert.deepEqual(result.pipeline.ticket.strategyAttribution,f.signal.strategyAttribution);assert.deepEqual(result.pipeline.ticket.strategyTrigger,f.signal.strategyTrigger);
  assert.equal(result.pipeline.signal.decision?.confidence,67);assert.equal(result.pipeline.signal.risk?.approved,true);
  const sent: unknown[]=[];
  const execution=new ExecutionRuntime({dryRun:f.runtime,paperGuard:new PaperGuard({probe:f.probe,expectedEnvironment:'paper'}),bindingAuthority:f.authority,
    submitter:{submit:async input=>{sent.push(input);assert.equal(input.ticket.confidence,.67);assert.equal(input.ticket.reason,f.signal.entryReason);assert.deepEqual(input.ticket.indicators?.stockStrategyPriceEvidence,f.prices);return{kind:'awaiting_ai',response:{outcome:'AWAITING_AI',order:{id:17}}};}}});
  assert.equal((await execution.executePrepared({dryRunResult:result,idempotencyKey:'fixture',bound:f.bound,strategyId:f.signal.strategyId,strategySignal:f.signal,indicators:{stockStrategyPriceEvidence:f.prices}})).outcome,'AWAITING_AI');
  assert.equal(sent.length,1);
});
test('configured signal keeps real confidence risk rejection',async()=>{const f=fixture();f.signal.confidenceScore=.2;const r=await f.prepare();assert.equal(r.pipeline.outcome,'FAILURE');assert.equal(r.pipeline.signal?.risk?.approved,false);assert.ok(r.pipeline.signal?.risk?.blockers.some(b=>b.code==='LOW_CONFIDENCE'));});
for(const kind of ['ready','exposure','stale','missing'] as const) test(`configured signal fails closed on ${kind}`,async()=>{
  const f=fixture();if(kind==='ready')f.state.ready=false;if(kind==='exposure')f.state.exposure=true;
  if(kind==='stale')f.state.priceAt=new Date(now.getTime()-11000);if(kind==='missing')f.state.priceAvailable=false;
  if(kind==='stale'||kind==='missing')await assert.rejects(f.prepare());else assert.equal((await f.prepare()).pipeline.outcome,'FAILURE');
});
for(const change of [
  (s:StrategySignal)=>{s.symbol='WRONG';},(s:StrategySignal)=>{s.direction='SHORT';},(s:StrategySignal)=>{s.trailingStopPct=1;},
  (s:StrategySignal)=>{s.partialTakeProfits=[{price:102,fraction:.5}];},(s:StrategySignal)=>{s.confidenceScore=NaN;},
  (s:StrategySignal)=>{s.stopLoss=200;},(s:StrategySignal)=>{s.strategyTrigger={...s.strategyTrigger!,observedAt:new Date(now.getTime()+1000).toISOString()};},
]) test('configured selected-signal boundary refuses unsupported or changed evidence',async()=>{const f=fixture();change(f.signal);await assert.rejects(f.prepare());});
test('price normalization validates broker identity, bands and session before use',()=>{
  const f=fixture();assert.throws(()=>normalizeStockStrategyLevels({...f.metadata,conId:999},f.bound,'DU_FIXTURE',f.prices.raw,now.getTime()),/identity/);
  assert.throws(()=>normalizeStockStrategyLevels({...f.metadata,requestStartedAtMs:now.getTime()-60000},f.bound,'DU_FIXTURE',f.prices.raw,now.getTime()),/stale/);
  assert.throws(()=>normalizeStockStrategyLevels({...f.metadata,priceIncrements:[{lowEdge:0,increment:NaN}]},f.bound,'DU_FIXTURE',f.prices.raw,now.getTime()),/rule/);
});
