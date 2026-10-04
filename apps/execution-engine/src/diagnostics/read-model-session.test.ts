import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DiagnosticReport} from '@ikbr/shared/diagnostics';
import {appendDiagnosticSessionEconomics} from './read-model-session.js';
import type {RoundTripReport} from '../lifecycle/round-trip-evidence.js';
const now='2026-10-04T10:00:00Z';
const make=():DiagnosticReport=>({schemaVersion:1,mode:'session',generatedAt:now,interval:{from:now,to:now},coverage:[],events:[],sections:[],counters:[],truncated:false,omissions:[]});
const closed=(currency:'PLN'|'USD',amount:number):RoundTripReport=>({status:'COMPLETED',accounting:'COMPLETE',quoteCurrency:currency,netPnl:{currency,amount},grossPnl:{currency,amount:amount+1}} as RoundTripReport);
test('session sums existing completed economics by currency without converting missing fees into zero',async()=>{
 const report=make();const values=[closed('PLN',2),closed('USD',3),{...closed('USD',4),accounting:'PENDING_FEES',netPnl:null} as RoundTripReport];
 await appendDiagnosticSessionEconomics({pool:{query:async()=>({rows:[{id:1,currency:'PLN'},{id:2,currency:'USD'},{id:3,currency:'USD'}]})} as never,
 currentAccountId:()=> 'fixture',currentSessionId:()=> 'process',configuration:()=>({configHash:null,instruments:[]}),roundTrip:async id=>values[id-1]},
 {mode:'session',from:now,to:now,limit:20},report);
 assert.equal(report.sections.find(s=>s.id.endsWith('PLN'))?.fields.find(f=>f.key==='net')?.value,2);
 assert.equal(report.sections.find(s=>s.id.endsWith('USD'))?.fields.find(f=>f.key==='net')?.value,null);
 assert.equal(report.coverage[0].status,'PARTIAL');
});
test('empty exit observation never asserts zero P&L',async()=>{
 const report=make();await appendDiagnosticSessionEconomics({pool:{query:async()=>({rows:[]})} as never,currentAccountId:()=> 'fixture',currentSessionId:()=> 'process',
 configuration:()=>({configHash:null,instruments:[]}),roundTrip:async()=>null},{mode:'session',from:now,to:now,limit:20},report);
 assert.equal(report.sections.length,0);assert.ok(report.coverage[0].reasons.includes('NO_STORED_EXITS_NOT_PROOF_OF_ZERO_PNL'));
});
