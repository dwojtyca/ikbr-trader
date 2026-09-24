import { GapFadeShortStrategy } from './gap-fade-short.strategy.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isWithinStrategySession } from './session-filter.js';
import type { StrategyContext } from './strategy.types.js';
const context = {
  symbol:'OTHER',conid:'777',secType:'STK', candlesByTimeframe:{}, latestCandle:{ts:new Date('2026-09-24T03:45:00Z')},
  verifiedSession:{generation:1,referenceDate:'2026-09-24',start:'2026-09-24T03:45:00Z',end:'2026-09-24T10:00:00Z',sessionStart:'2026-09-24T03:45:00Z',intervals:[],
    identity:{instrumentId:'other',conId:777,symbol:'OTHER',secType:'STK',exchange:'NSE',currency:'INR',useRTH:true,timeZone:'Asia/Kolkata'}}
} as unknown as StrategyContext;
test('calendar interval permits early market session independently from UTC strategy defaults',()=>assert.equal(isWithinStrategySession(context,8,20),true));
test('offline contexts preserve historical UTC filter',()=>assert.equal(isWithinStrategySession({...context,verifiedSession:undefined},8,20),false));
for(const patch of [{start:'2026-09-24T03:46:00Z'},{end:'2026-09-24T03:45:59Z'},{generation:0},{identity:{...context.verifiedSession!.identity,conId:123}}])test(`malformed or mismatched interval ${JSON.stringify(patch)} rejected`,()=>assert.equal(isWithinStrategySession({...context,verifiedSession:{...context.verifiedSession!,...patch}},8,20),false));

test('calendar eligibility preserves the intentional gap-fade opening wait',()=>{
 const strategy=new GapFadeShortStrategy();
 strategy.generateSignal({...context,indicators:{rsi14:60,atr14:1,intraday:{sessionOpen:102,prevSessionClose:100,gapPct:2,minutesSinceSessionOpen:0,vwap:101,distanceFromVwapBps:100}}});
 assert.equal(strategy.getLastRejectionReason(),'too_early_in_session');
});
