import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayPkoProfiles,selectProfile,type SessionEvidence } from './pko-profile-replay.js';
const points=Array.from({length:196},(_,i)=>795+i);
const session=(date:string,eligibleMinutes=points):SessionEvidence=>({date,eligibleMinutes,signals:{default:0,pko_mild_v1:1,pko_moderate_v1:2}});
test('sparse or current dates cannot qualify even with many signals',()=>{
 const sparse=['20','21','22','23'].map(d=>session('2026-09-'+d,[795,900,990]));
 assert.equal(selectProfile(sparse,'2026-09-24T12:00:00Z').status,'INSUFFICIENT_EVIDENCE');
 assert.equal(selectProfile([...sparse.slice(0,3),session('2026-09-24')],'2026-09-24T16:00:00Z').selected,null);
});
test('chronological holdout and least relaxed selection never borrow development signals',()=>{
 const s=['23','20','22','21'].map(d=>session('2026-09-'+d));
 const selected=selectProfile(s,'2026-09-24T12:00:00Z');assert.equal(selected.selected,'pko_mild_v1');
 assert.deepEqual(selected.development,['2026-09-20','2026-09-21']);assert.deepEqual(selected.holdout,['2026-09-22','2026-09-23']);
 for(const row of s.filter(x=>x.date>='2026-09-22'))row.signals.pko_mild_v1=0;
 assert.equal(selectProfile(s,'2026-09-24T12:00:00Z').selected,'pko_moderate_v1');
 for(const row of s)row.signals.pko_moderate_v1=0;
 assert.equal(selectProfile(s,'2026-09-24T12:00:00Z').status,'NO_CANDIDATE');
});
test('missing endpoints and gaps over five minutes exclude windows',()=>{
 const s=['20','21','22','23'].map(d=>session('2026-09-'+d));s[0].eligibleMinutes=points.filter(m=>m<850||m>856);
 s[1].eligibleMinutes=points.slice(1);assert.equal(selectProfile(s,'2026-09-24T12:00:00Z').status,'INSUFFICIENT_EVIDENCE');
});
function fixture(){
 const end=Date.parse('2026-09-23T12:00:00Z');
 const make=(tf:string,ms:number,count:number)=>Array.from({length:count},(_,i)=>({conid:'35146360',symbol:'PKO',timeframe:tf,ts:new Date(end-(count-i)*ms).toISOString(),open:100+i*.01,high:101+i*.01,low:99+i*.01,close:100+i*.01,volume:1000,source:'ibkr_wse_native_v1'}));
 return {instrumentId:'pko_wse',conid:'35146360',symbol:'PKO',exportedAt:'2026-09-23T12:00:00Z',candles:{'1m':make('1m',60000,240),'5m':make('5m',300000,100),'1h':make('1h',3600000,100),'4h':make('4h',14400000,100),'1d':make('1d',86400000,100),'1w':make('1w',604800000,100)}};
}
test('offline historical replay is deterministic and excludes unfinished higher candles',async()=>{
 const data=fixture();data.candles['4h'].push({...data.candles['4h'][0],ts:'2026-09-23T11:00:00Z'});
 const a=await replayPkoProfiles(JSON.stringify(data));assert.ok(a.eligibleContexts>0);
 for(const profile of ['default','pko_mild_v1','pko_moderate_v1'] as const){
  const totals:Record<string,number>={};for(const session of a.sessions)for(const [reason,count] of Object.entries(session.rejections[profile]))totals[reason]=(totals[reason]??0)+count;
  assert.deepEqual(totals,a.rejected[profile]);assert.equal(a.sessions.reduce((n,s)=>n+s.allSignals[profile],0),a.signalCounts[profile]);
  for(const session of a.sessions)assert.equal(Object.values(session.selectionRejections[profile]).reduce((n,c)=>n+c,0)+session.signals[profile],session.eligibleMinutes.length);
 }
 assert.deepEqual(a,await replayPkoProfiles(JSON.stringify(data)));
 Object.assign(data.candles['4h'].at(-1)!,{open:9999,high:10000,low:9998,close:9999});
 const b=await replayPkoProfiles(JSON.stringify(data));assert.deepEqual(a.rejected,b.rejected);assert.deepEqual(a.signalCounts,b.signalCounts);assert.equal(a.eligibleContexts,b.eligibleContexts);
 assert.equal(a.selection.status,'INSUFFICIENT_EVIDENCE');
});
test('dataset duplicates, wrong identity/source and invalid OHLC fail before replay',async()=>{
 for(const mode of ['duplicate','identity','source','ohlc']){
  const data=fixture();if(mode==='duplicate')data.candles['1m'].push(data.candles['1m'][0]);
  if(mode==='identity')data.candles['1m'][0].conid='123';if(mode==='source')data.candles['1m'][0].source='synthetic';if(mode==='ohlc')data.candles['1m'][0].low=200;
  await assert.rejects(replayPkoProfiles(JSON.stringify(data)));
 }
});

test('qualifying default has priority; partial/default evidence never qualifies',()=>{
 const s=['20','21','22','23'].map(d=>session('2026-09-'+d));for(const row of s)row.signals.default=1;
 assert.equal(selectProfile(s,'2026-09-24T12:00:00Z').selected,'default');
 for(const row of s.filter(x=>x.date>='2026-09-22'))row.signals.default=0;
 assert.equal(selectProfile(s,'2026-09-24T12:00:00Z').selected,'pko_mild_v1');
 assert.equal(selectProfile(s.slice(0,2),'2026-09-24T12:00:00Z').status,'INSUFFICIENT_EVIDENCE');
});
