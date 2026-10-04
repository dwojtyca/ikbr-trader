import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EMPTY_DIAGNOSTIC_IDENTITY,type DiagnosticReport} from './types.js';
import {parseDiagnosticQuery} from './query.js';
import {safeDiagnosticText,safeDiagnosticUrl,redactDiagnosticExport,parseDiagnosticReport,boundDiagnosticReport} from './privacy.js';
const now='2026-10-04T10:00:00.000Z';
const sample=():DiagnosticReport=>({schemaVersion:1,mode:'events',generatedAt:now,interval:{from:now,to:now},coverage:[{source:'broker',status:'UNAVAILABLE',observedAt:null,earliestAvailableAt:null,reasons:['BROKER_STATE_UNKNOWN']}],sections:[],counters:[{key:'fills',label:'Realizacje',value:null}],truncated:false,omissions:[],events:[{...EMPTY_DIAGNOSTIC_IDENTITY,schemaVersion:1,id:'event-12345',proposalId:'42',configHash:'a'.repeat(64),traceId:'evaluation-12345',service:'execution-engine',code:'SUBMISSION_UNKNOWN',severity:'CRITICAL',occurredAt:now,recordedAt:now,reason:'SUBMISSION_UNKNOWN',message:'Wynik nieznany.',impact:'HOLD',action:'Nie ponawiaj.',auditRef:'/execution/lifecycle/42',fields:[{key:'amount',label:'Kwota',value:192,sensitivity:'financial'},{key:'rationale',label:'Zapis AI',value:'private rationale',sensitivity:'untrusted'},{key:'proposal',label:'Propozycja',value:'42',sensitivity:'identifier'}]}]});
test('privacy removes exact secrets/account identifiers, credential patterns and terminal control injections',()=>{
 const text=safeDiagnosticText('DU1234567\n\u001b[2J\u202e Bearer abc token=pass sk-abcdefghijkl SECRET DU_TEST',{secrets:['SECRET'],accountIds:['DU_TEST']});
 assert.doesNotMatch(text,/DU1234567|SECRET|DU_TEST|abc|pass|abcdefghijkl|[\u001b\u202e\n]/);
 assert.match(text,/\\u001b/); assert.equal(safeDiagnosticUrl('https://user:pass@test.test/x'),null);
 assert.equal(safeDiagnosticUrl('https://test.test/x?token=secret#private'),'https://test.test/x');
 assert.equal(safeDiagnosticUrl('javascript:alert(1)'),null);
});
test('exports consistently pseudonymize correlations and omit financial/untrusted data and exact audit links',()=>{
 const a=redactDiagnosticExport(sample()),b=redactDiagnosticExport(sample());
 assert.equal(a.events[0].proposalId,a.events[0].fields[2].value);
 assert.notEqual(a.events[0].proposalId,b.events[0].proposalId);
 assert.equal(a.events[0].auditRef,null);assert.equal(a.events[0].configHash,'a'.repeat(64));
 assert.doesNotMatch(JSON.stringify(a),/private rationale|evaluation-12345|event-12345|:192|lifecycle\/42/);
 assert.equal(a.counters[0].value,null);
});
test('schema rejects malformed evidence and unknown schema; size truncation is visible without false zero',()=>{
 const input=sample();assert.deepEqual(parseDiagnosticReport(input),input);
 assert.throws(()=>parseDiagnosticReport({...input,schemaVersion:2}));
 assert.throws(()=>parseDiagnosticReport({...input,counters:[{key:'x',label:'x',value:NaN}]}));
 const truncated=boundDiagnosticReport({...input,events:Array.from({length:30},()=>input.events[0])},2000);
 assert.equal(truncated.truncated,true);assert.ok(truncated.omissions.includes('RESPONSE_SIZE_LIMIT'));
 assert.equal(truncated.counters[0].value,null);assert.equal(truncated.coverage[0].status,'UNAVAILABLE');
});
test('exports redact short and long correlations in free text, labels and reasons without changing dates or config hashes',()=>{
 const report=sample(),event=report.events[0];
 event.reason='error for proposal 42 and evaluation-12345';
 event.message=`Proposal 42 at ${now}, configuration ${event.configHash}`;
 event.fields.push({key:'proposal-42',label:'Propozycja 42',value:'failure evaluation-12345'});
 report.sections.push({id:'proposal:42',title:'Propozycja 42',instrumentId:'pko_wse',fields:[]});
 const redacted=redactDiagnosticExport(report),text=JSON.stringify(redacted);
 assert.doesNotMatch(text,/proposal 42|Propozycja 42|proposal-42|evaluation-12345/);
 assert.ok(redacted.events[0].reason.includes(redacted.events[0].proposalId!));
 assert.ok(redacted.events[0].message.includes(now));
 assert.equal(redacted.events[0].configHash,event.configHash);
});
test('filters reject unbounded ranges, arbitrary inputs, wrong trace keys and invalid limits',()=>{
 assert.equal(parseDiagnosticQuery({},Date.parse(now)).limit,200);
 for(const query of [{limit:1001},{limit:-1},{sql:'select'},{mode:'timeline'},{mode:'timeline',proposalId:'1',evaluationId:'x'},
  {from:'2020-01-01T00:00:00Z',to:now},{from:'2026-09-31T00:00:00Z',to:now},{instrumentId:'x\nsecret'},{proposalId:'1 OR true'}]) assert.throws(()=>parseDiagnosticQuery(query,Date.parse(now)));
});
test('bounded server arrays are accepted by the client with coverage failures retained first',()=>{
 const report=sample();
 report.coverage=[...Array.from({length:105},(_,index)=>({source:`source-${index}`,status:'COMPLETE' as const,observedAt:now,earliestAvailableAt:null,reasons:[]})),...report.coverage];
 report.sections=[{id:'large',title:'Pola',instrumentId:null,fields:Array.from({length:230},(_,index)=>({key:String(index),label:'Pole',value:null}))}];
 const bounded=boundDiagnosticReport(report);
 assert.equal(bounded.truncated,true);assert.equal(bounded.coverage[0].status,'UNAVAILABLE');
 assert.equal(bounded.coverage.length,100);assert.equal(bounded.sections[0].fields.length,200);
 assert.deepEqual(parseDiagnosticReport(bounded),bounded);
});
