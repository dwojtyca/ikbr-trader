import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildConfiguredInstrumentRegistry, buildInstrumentBindingAuthority, wseCandleEnd,
  type Candle, type CandleTimeframe, type MomentumBreakoutProfile } from '@ikbr/shared';
import { MIN_CANDLES_BY_TIMEFRAME, MAX_CANDLE_AGE_MS } from '../runtime/strategy/strategy-context-loader.js';
import { computeIndicatorsForContext } from '../runtime/strategy/indicators.js';
import { detectRegimeForContext } from '../runtime/strategy/regime.js';
import type { StrategyContext } from '../strategies/strategy.types.js';
import { StrategyPortfolioManager } from '../portfolio/strategy-portfolio-manager.js';
import { MomentumBreakoutLongStrategy } from '../strategies/momentum-breakout-long.strategy.js';

export const profiles = ['default','pko_mild_v1','pko_moderate_v1'] as const;
const timeframes = ['1m','5m','1h','4h','1d','1w'] as const;
const timestamp = z.string().datetime({ offset: true });
const bar = z.object({ conid:z.literal('35146360'),symbol:z.literal('PKO'),timeframe:z.enum(timeframes),ts:timestamp,
  open:z.number().finite().positive(),high:z.number().finite().positive(),low:z.number().finite().positive(),close:z.number().finite().positive(),
  volume:z.number().finite().nonnegative(),source:z.literal('ibkr_wse_native_v1') }).refine(x => x.high >= Math.max(x.open,x.close,x.low) && x.low <= Math.min(x.open,x.close));
const dataset = z.object({ exportedAt:timestamp,instrumentId:z.literal('pko_wse'),conid:z.literal('35146360'),symbol:z.literal('PKO'),
  candles:z.object({ '1m':z.array(bar),'5m':z.array(bar),'1h':z.array(bar),'4h':z.array(bar),'1d':z.array(bar),'1w':z.array(bar) }) });
const localParts = (ms:number) => Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(ms).map(x=>[x.type,x.value]));
const localDay = (ms:number) => {const p=localParts(ms);return `${p.year}-${p.month}-${p.day}`;};
const localMinute = (ms:number) => {const p=localParts(ms);return Number(p.hour)*60+Number(p.minute);};
export interface SessionEvidence { date:string; eligibleMinutes:number[]; signals:Record<MomentumBreakoutProfile,number> }
export function selectProfile(sessions:readonly SessionEvidence[],exportedAt:string) {
  const exportDay=localDay(Date.parse(exportedAt));
  const coverage=sessions.map(s=>{
    const points=[...new Set(s.eligibleMinutes.filter(m=>Number.isInteger(m)&&m>=795&&m<=990))].sort((a,b)=>a-b);
    const qualified=s.date<exportDay && points[0]===795 && points.at(-1)===990 && points.length>=Math.ceil(196*.9)
      && points.every((m,i)=>i===0||m-points[i-1]<=5);
    return {date:s.date,eligiblePoints:points.length,qualified};
  });
  const eligible=sessions.filter(s=>coverage.find(c=>c.date===s.date)?.qualified).sort((a,b)=>a.date.localeCompare(b.date));
  const split=Math.floor(eligible.length/2),development=eligible.slice(0,split),holdout=eligible.slice(split);
  const totals=(items:readonly SessionEvidence[],p:MomentumBreakoutProfile)=>items.reduce((sum,s)=>sum+s.signals[p],0);
  const selected=eligible.length>=4 ? profiles.find(p=>totals(development,p)>0&&totals(holdout,p)>0) : undefined;
  return {status:eligible.length<4?'INSUFFICIENT_EVIDENCE':selected?'CANDIDATE':'NO_CANDIDATE',selected:selected??null,coverage,
    development:development.map(s=>s.date),holdout:holdout.map(s=>s.date)};
}
export async function replayPkoProfiles(raw:string) {
  const data=dataset.parse(JSON.parse(raw));
  const cutoff=Date.parse(data.exportedAt);
  const candles:Partial<Record<CandleTimeframe,Candle[]>>={};
  for(const tf of timeframes){
    const seen=new Set<number>();
    candles[tf]=data.candles[tf].map(c=>{
      const ts=Date.parse(c.ts);
      if(c.timeframe!==tf||seen.has(ts)||!Number.isFinite(wseCandleEnd(new Date(c.ts),tf))||ts>cutoff)throw Error('invalid or duplicate candle identity/time');
      seen.add(ts);return {...c,ts:new Date(ts)};
    }).sort((a,b)=>a.ts.getTime()-b.ts.getTime());
  }
  const registry=buildConfiguredInstrumentRegistry({GPW_PROFILE_ENABLED:'true',IBKR_ENVIRONMENT:'paper'});
  const instrument=registry.getInstrumentOrThrow('pko_wse');
  const binding=buildInstrumentBindingAuthority(JSON.stringify([{instrumentId:'pko_wse',conId:35146360,localSymbol:'PKO',tradingClass:'PKO',exchange:'WSE',currency:'PLN',minTick:0.0001}]),registry);
  if(!binding.ok)throw Error('replay binding unavailable');
  const bound=binding.authority.getBoundInstrument('pko_wse')!;
  type SessionReport = SessionEvidence & { allSignals:Record<MomentumBreakoutProfile,number>; rejections:Record<string,Record<string,number>>; selectionRejections:Record<string,Record<string,number>> };
  const sessions=new Map<string,SessionReport>();
  const rejected:Record<string,Record<string,number>>=Object.fromEntries(profiles.map(p=>[p,{}]));
  const unavailable:Record<string,number>={};
  const signalCounts=Object.fromEntries(profiles.map(p=>[p,0]));
  let eligibleContexts=0;
  for(const minute of candles['1m']!){
    const now=wseCandleEnd(minute.ts,'1m');if(now>cutoff)continue;
    const date=localDay(now),m=localMinute(now);
    let session=sessions.get(date);if(!session){session={date,eligibleMinutes:[],signals:{default:0,pko_mild_v1:0,pko_moderate_v1:0},allSignals:{default:0,pko_mild_v1:0,pko_moderate_v1:0},rejections:Object.fromEntries(profiles.map(p=>[p,{}])),selectionRejections:Object.fromEntries(profiles.map(p=>[p,{}]))};sessions.set(date,session);}
    // Historical datasets retain their original WSE close rules and UTC strategy filters.
    // They cannot supply production calendar proof or authorize a broker proposal.
    const closed: Partial<Record<CandleTimeframe,Candle[]>> = {};
    let unavailableReason: string | undefined;
    for (const tf of timeframes) {
      const rows = (candles[tf]??[]).filter(c=>wseCandleEnd(c.ts,tf)<=now).slice(-(tf==='1m'?1000:tf==='5m'||tf==='1h'?160:tf==='4h'?120:tf==='1d'?260:104));
      if(rows.length<MIN_CANDLES_BY_TIMEFRAME[tf]) { unavailableReason=`insufficient ${tf} candles: ${rows.length} < ${MIN_CANDLES_BY_TIMEFRAME[tf]}`;break; }
      const age=now-wseCandleEnd(rows.at(-1)!.ts,tf);
      if(age>MAX_CANDLE_AGE_MS[tf]) { unavailableReason=`latest ${tf} candle is stale (age ${age}ms)`;break; }
      closed[tf]=rows;
    }
    if(unavailableReason){unavailable[unavailableReason]=(unavailable[unavailableReason]??0)+1;continue;}
    const indicators=computeIndicatorsForContext({secType:'STK',candlesByTimeframe:closed})!;
    const latestCandle=closed['1m']!.at(-1)!;
    const regime=detectRegimeForContext('STK',latestCandle.close,indicators);
    Object.assign(indicators,{directionalRegime:regime.directionalRegime,volatilityRegime:regime.volatilityRegime,regimeScore:regime.score,regimeConfidence:regime.confidence,regimeReasons:regime.reasons,timeframeTrendScores:regime.timeframeTrendScores,timeframeTrendVotes:regime.timeframeTrendVotes});
    const context:StrategyContext={symbol:instrument.brokerSymbol,conid:String(bound.conId),secType:'STK',directionalRegime:regime.directionalRegime,volatilityRegime:regime.volatilityRegime,
      latestCandle,indicators,candlesByTimeframe:closed,marketState:{lastPrice:minute.close,ts:new Date(now).toISOString()},currentPosition:{quantity:0}};
    eligibleContexts++;if(m>=795&&m<=990)session.eligibleMinutes.push(m);
    for(const profile of profiles){
      const strategy=new MomentumBreakoutLongStrategy();
      const result=new StrategyPortfolioManager([strategy]).run({...context,momentumBreakoutProfile:profile});
      if(result.kind==='error')throw Error('strategy evaluation failed');
      if(result.selected){signalCounts[profile]++;session.allSignals[profile]++;if(m>=795&&m<=990)session.signals[profile]++;}
      else {const reason=result.rejectionReasons.join('; ')||'no_signal';rejected[profile][reason]=(rejected[profile][reason]??0)+1;session.rejections[profile][reason]=(session.rejections[profile][reason]??0)+1;
        if(m>=795&&m<=990)session.selectionRejections[profile][reason]=(session.selectionRejections[profile][reason]??0)+1;}
    }
  }
  return {datasetHash:createHash('sha256').update(raw).digest('hex'),exportedAt:data.exportedAt,
    counts:Object.fromEntries(timeframes.map(tf=>[tf,candles[tf]!.length])),
    range:{from:candles['1m']![0]?.ts.toISOString()??null,to:candles['1m']!.at(-1)?.ts.toISOString()??null},
    interpretation:'Historical closed-candle signal observations; no broker BBO, fills, fees or profitability model. Overlapping signals are not independent trades.',
    selectionInterval:'13:15–16:30 Europe/Warsaw inclusive; sessions.signals and selectionRejections apply only to this interval; allSignals/rejections cover all eligible points.',
    eligibleContexts,unavailable,signalCounts,rejected,sessions:[...sessions.values()],selection:selectProfile([...sessions.values()],data.exportedAt)};
}
