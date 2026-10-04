import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EMPTY_DIAGNOSTIC_IDENTITY,type DiagnosticEvent,type DiagnosticReport} from '@ikbr/shared/diagnostics';
import {OperatorFollowState} from './operator-follow.js';
import {renderBoundedExport} from './operator-cli.js';
const now='2026-10-04T10:00:00.000Z';
const event=(id:string,overrides:Partial<DiagnosticEvent>={}):DiagnosticEvent=>({...EMPTY_DIAGNOSTIC_IDENTITY,schemaVersion:1,id,code:'NO_SIGNAL',reason:'NO_SIGNAL',severity:'INFO',service:'signal-engine',occurredAt:now,recordedAt:now,message:'Brak sygnału.',impact:'Brak wejścia.',action:'Poczekaj.',fields:[],auditRef:null,...overrides});
const report=(events:DiagnosticEvent[]=[]):DiagnosticReport=>({schemaVersion:1,mode:'events',generatedAt:now,interval:{from:now,to:now},coverage:[],events,sections:[],counters:[],truncated:false,omissions:[]});
test('follow emits source outage, gap/restart/retention transitions on successful responses',()=>{
 const state=new OperatorFollowState(report());assert.equal(state.observe(report()).coverageChanged,false);
 const outage={...report(),coverage:[{source:'broker',status:'UNAVAILABLE' as const,observedAt:null,earliestAvailableAt:null,reasons:['SOURCE_READ_FAILED']}]};
 assert.equal(state.observe(outage).coverageChanged,true);assert.equal(state.observe(outage).coverageChanged,false);
 assert.equal(state.observe({...outage,omissions:['PROCESS_CHANGE','PRUNED_INTERVAL']}).coverageChanged,true);
 assert.equal(state.observe(report()).coverageChanged,true);
});
test('follow retains modified same-ID versions and all distinct lifecycle/correlation events',()=>{
 const a=event('a'),state=new OperatorFollowState(report([a]));
 assert.equal(state.observe(report([a])).events.length,0);
 assert.equal(state.observe(report([{...a,action:'Zmieniony stan'}])).events.length,1);
 assert.equal(state.compact(event('1'),100000).length,1);
 assert.equal(state.compact(event('2'),100001).length,0);
 for(const changed of [event('3',{proposalId:'42'}),event('4',{conId:'123'}),event('5',{code:'FAULT_RESOLVED'}),event('6',{severity:'CRITICAL'})])
  assert.ok(state.compact(changed,100005).some(e=>e.id===changed.id));
});
test('large exports are bounded in rendered text and pretty JSON with explicit omissions',()=>{
 const big=report(Array.from({length:1000},(_,i)=>event(String(i),{message:'x'.repeat(2000),fields:Array.from({length:15},(_,j)=>({key:String(j),label:'Pole',value:'y'.repeat(100)}))})));
 for(const json of [false,true]) {const output=renderBoundedExport(big,json,'Europe/Warsaw');assert.ok(Buffer.byteLength(output)<=1024*1024);assert.match(output,/SIZE_LIMIT/);}
});
test('follow does not turn unchanged current proposal observations into new critical transitions',()=>{
 const current=event('proposal:42:UNKNOWN',{code:'CURRENT_PROPOSAL_SNAPSHOT',severity:'CRITICAL',proposalId:'42',reason:'UNKNOWN'});
 const state=new OperatorFollowState(report([current]));
 assert.equal(state.observe(report([{...current,occurredAt:'2026-10-04T10:00:05.000Z',recordedAt:'2026-10-04T10:00:05.000Z'}])).events.length,0);
 assert.equal(state.observe(report([{...current,id:'proposal:42:FILLED',reason:'FILLED',severity:'INFO'}])).events.length,1);
});
