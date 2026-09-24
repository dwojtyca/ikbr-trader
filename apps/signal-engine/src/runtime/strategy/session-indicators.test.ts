import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Candle} from '@ikbr/shared';
import {computeIndicatorsForContext} from './indicators.js';
import type {VerifiedStrategySession} from '../../strategies/strategy.types.js';
const interval=(start:string,end:string)=>({date:'2026-09-24',start,end});
const session:VerifiedStrategySession={generation:1,referenceDate:'2026-09-24',start:'2026-09-24T07:00:00Z',end:'2026-09-24T10:00:00Z',sessionStart:'2026-09-24T01:00:00Z',previousSessionCloseTs:'2026-09-23T09:59:00Z',intervals:[interval('2026-09-24T01:00:00Z','2026-09-24T06:00:00Z'),interval('2026-09-24T07:00:00Z','2026-09-24T10:00:00Z')],identity:{instrumentId:'split',conId:77,symbol:'SPLIT',secType:'STK',exchange:'X',currency:'JPY',useRTH:true,timeZone:'Asia/Tokyo'}};
const candle=(ts:string):Candle=>({conid:'77',symbol:'SPLIT',timeframe:'1m',ts:new Date(ts),open:100,high:101,low:99,close:100,volume:10});
test('lunch reopening does not reset the reference-session opening range and elapsed time',()=>{
 const bars=[candle('2026-09-23T09:59:00Z'),...Array.from({length:300},(_,i)=>candle(new Date(Date.parse(session.sessionStart)+i*60000).toISOString())),candle('2026-09-24T07:00:00Z')];
 const out=computeIndicatorsForContext({secType:'STK',candlesByTimeframe:{'1m':bars},verifiedSession:session})!;
 assert.equal(out.intraday?.minutesSinceSessionOpen,360);assert.equal(new Date(out.intraday!.sessionOpenTs!).toISOString(),new Date(session.sessionStart).toISOString());
});
test('truncated minute history never invents a session open for gap/opening-range strategies',()=>{
 const bars=['2026-09-24T05:59:00Z','2026-09-24T07:00:00Z'].map(candle);
 assert.equal(computeIndicatorsForContext({secType:'STK',candlesByTimeframe:{'1m':bars},verifiedSession:session})!.intraday,undefined);
});

for(const missing of ['previous_close','opening_minute','middle_minute'])test(`${missing} cannot fabricate complete gap/opening-range/VWAP data`,()=>{
 const bars=[candle('2026-09-23T09:59:00Z'),...Array.from({length:300},(_,i)=>candle(new Date(Date.parse(session.sessionStart)+i*60000).toISOString())),candle('2026-09-24T07:00:00Z')];
 if(missing==='previous_close')bars[0].ts=new Date('2026-09-23T09:58:00Z');
 else bars.splice(missing==='opening_minute'?1:10,1);
 assert.equal(computeIndicatorsForContext({secType:'STK',candlesByTimeframe:{'1m':bars},verifiedSession:session})!.intraday,undefined);
});
