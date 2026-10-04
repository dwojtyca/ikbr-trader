import {test} from 'node:test';
import assert from 'node:assert/strict';
import {researchHash} from '@ikbr/shared/instrument-research';
import {sanitizeDiagnosticReport,redactDiagnosticExport,type DiagnosticReport} from '@ikbr/shared/diagnostics';
import {appendDiagnosticTimeline} from './read-model-timeline.js';
const now='2026-10-04T10:00:00Z';
const report=():DiagnosticReport=>({schemaVersion:1,mode:'timeline',generatedAt:now,interval:{from:now,to:now},coverage:[],sections:[],events:[],counters:[],truncated:false,omissions:[]});
test('trace uses scoped stored model/research fields only and never includes raw request/provider body',async()=>{
 const snapshot={instrumentId:'test',configHash:'hash',evidence:[{ref:'annual',sourceId:'issuer',documentId:'2025',url:'https://example.test/report?secret=abc',published:{precision:'date',date:'2026-03-12',timeZone:'Europe/Warsaw'}}]};
 const row={instrument_id:'test',config_hash:'hash',snapshot_hash:researchHash(snapshot),snapshot_json:JSON.stringify(snapshot),snapshot_id:'snapshot-one',
  review_status:'REJECTED',decision_json:{decision:'REJECT',reason:'\u001b[2JDU1234567 token=secret',riskFlags:['stale'],evidenceRefs:['annual']},request_json:{password:'never-selected'},model:'recorded-model',
  risk_evidence:{assessedAtMs:Date.parse(now),validUntilMs:Date.parse(now)+10000,instrumentId:'test',conid:'123',sessionId:'old-risk-session',accountId:'DU1234567',quoteCurrency:'PLN',quoteNotional:100}};
 const result=report();
 await appendDiagnosticTimeline({pool:{query:async(sql:unknown,values:unknown)=>{assert.match(String(sql),/p.id=\$1 AND/);assert.deepEqual(values,['42','DU1234567']);assert.doesNotMatch(String(sql),/request_json|providerRequest/);return {rows:[row]};}} as never,
 currentAccountId:()=> 'DU1234567',currentSessionId:()=> 'process',configuration:()=>({configHash:'hash',instruments:[]})},
 {mode:'timeline',proposalId:'42',from:now,to:now,limit:100},result);
 const safe=sanitizeDiagnosticReport(result,{accountIds:['DU1234567']});
 assert.ok(safe.sections.some(s=>s.fields.some(f=>f.key==='rationale')));assert.ok(safe.sections.some(s=>s.fields.some(f=>f.key==='documentId'&&f.value==='2025')));
 assert.equal(safe.sections[0].fields.find(f=>f.key==='riskAssessedAt')?.value,'2026-10-04T10:00:00.000Z');
 assert.equal(safe.sections[0].fields.find(f=>f.key==='riskValidUntil')?.value,'2026-10-04T10:00:10.000Z');
 assert.equal(safe.sections[0].fields.find(f=>f.key==='executionRiskStatus'),undefined);
 assert.doesNotMatch(JSON.stringify(safe),/never-selected|token=secret|DU1234567|secret=abc/);
 assert.doesNotMatch(JSON.stringify(redactDiagnosticExport(safe)),/execution\/orders\/42|snapshot-one/);
});
test('no link or denied account does not invent proposal correlation',async()=>{
 const r=report();await appendDiagnosticTimeline({pool:{query:async()=>{throw Error('should not read');}} as never,currentAccountId:()=>null,currentSessionId:()=>'',configuration:()=>({configHash:null,instruments:[]})},
 {mode:'timeline',evaluationId:'eval',from:now,to:now,limit:10},r);assert.equal(r.sections.length,0);
});
