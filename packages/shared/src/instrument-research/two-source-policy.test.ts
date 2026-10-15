import test from 'node:test';
import assert from 'node:assert/strict';
import { researchFixture, twoSourceResearchFixture, wshSnapshotFixture } from './research.fixture.js';
import { validateResearchManifest, parseResearchSnapshot, researchHash } from './validation.js';
import { evaluateResearchEligibility } from './eligibility.js';
import { researchRefreshInterval, inspectResearch } from './repair.js';
import { marketauxWindow, marketauxCallIdentity, marketauxQualificationDeadline } from './marketaux.js';
import { isTwoSourceResearch, researchRequiredRoles } from './policy.js';
import { researchPromptContract, validateResearchAiRequest, researchWireRequest } from './ai-contract.js';
const now = Date.parse('2026-10-15T12:31:45.000Z');

test('new policy has exactly truthful news/calendar shapes and rejects partial or downgraded modes', () => {
 const f=twoSourceResearchFixture(now);assert.ok(isTwoSourceResearch(validateResearchManifest(f.manifest)));
 assert.deepEqual(researchRequiredRoles(f.manifest),['news','calendar']);
 assert.equal('reports' in parseResearchSnapshot(f.snapshot,f.manifest),false);
 for (const mutate of [(m:any)=>delete m.researchPolicy,(m:any)=>m.schemaVersion=1,(m:any)=>m.researchPolicy='UNKNOWN',(m:any)=>m.refreshEnabled=false,
  (m:any)=>m.instruments[0].annual={},(m:any)=>m.instruments[0].sources.pop(),(m:any)=>m.instruments[0].sources.push(m.instruments[0].sources[0]),
  (m:any)=>m.instruments[0].sources[0].roles=['reports'],(m:any)=>m.instruments[0].sources[0].parserConfig.refreshIntervalMs=900000]) {
  const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>validateResearchManifest(m));
 }
 for (const patch of [{reports:[]},{facts:[]},{researchPolicy:undefined},{researchPolicy:'UNKNOWN'}]) assert.throws(()=>parseResearchSnapshot({...f.snapshot,...patch},f.manifest));
 assert.equal(researchRefreshInterval(f.source,'news'),3600000);
});

test('legacy canonical manifest/snapshot output remains byte-identical and report/30m checks remain', () => {
 for (const f of [researchFixture(now),wshSnapshotFixture(now)]) {
  const before=JSON.stringify(f.manifest), snapshot=JSON.stringify(f.snapshot);
  assert.equal(JSON.stringify(validateResearchManifest(f.manifest)),before);assert.equal(JSON.stringify(parseResearchSnapshot(f.snapshot,f.manifest)),snapshot);
  assert.equal(researchHash(validateResearchManifest(f.manifest)),f.manifestHash);
  const bad=structuredClone(f.snapshot);bad.reports=[];bad.facts=[];
  assert.equal(evaluateResearchEligibility(bad,f.manifest,now).eligible,false);
 }
 const legacy=researchFixture(now);assert.ok(evaluateResearchEligibility(legacy.snapshot,legacy.manifest,now+1800000).reasons.includes('RESEARCH_SOURCE_STALE_OR_FUTURE'));
});

test('hourly query cutoff is distinct from actual completion; original24h expiry is finite and not reset', () => {
 const f=twoSourceResearchFixture(now), c=f.snapshot.coverage.find(c=>c.role==='news')!;
 assert.notEqual(c.checkedAt,c.windowEnd);assert.deepEqual(marketauxWindow(f.slot,f.newsConfig),f.window);
 const expiry=Date.parse(f.snapshot.coverage.find(c=>c.role==='calendar')!.checkedAt)+86400000;
 assert.equal(evaluateResearchEligibility(f.snapshot,f.manifest,expiry-1).eligible,true);
 assert.equal(evaluateResearchEligibility(f.snapshot,f.manifest,expiry).eligible,false);
 const changed=structuredClone(f.snapshot);changed.createdAt=new Date(now+3600000).toISOString();
 assert.equal(evaluateResearchEligibility(changed,f.manifest,now+3600000).expiresAt,evaluateResearchEligibility(f.snapshot,f.manifest,now).expiresAt);
 assert.equal(inspectResearch(f.manifest,f.policy.instrumentId,{id:'fixture',hash:researchHash(f.snapshot),sequence:1,snapshot:f.snapshot},now).state,'READY');
});

test('hourly receipt rejects forged identity/completion/query/pages and preserves completed-time qualification', () => {
 const f=twoSourceResearchFixture(now);
 for (const mutate of [(a:any)=>a.attemptId='bad',(a:any)=>a.sourceHash='f'.repeat(64),(a:any)=>a.slot++,
  (a:any)=>a.completedAt=new Date(now+1).toISOString(),(a:any)=>a.startedAt=new Date(now-120001).toISOString(),
  (a:any)=>a.pages.pop(),(a:any)=>a.pages[0].fetchedAt=new Date(now+1).toISOString(),(a:any)=>a.queryStart=a.queryEnd]) {
  const s=structuredClone(f.snapshot);mutate(s.coverage.find(c=>'acquisition' in c)!.acquisition);assert.throws(()=>parseResearchSnapshot(s,f.manifest));
 }
 const req={kind:'marketaux-news-v2' as const,attemptId:f.acquisition.attemptId,slot:f.slot,sourceUrl:f.source.urls[0],...f.window,pass:1 as const,page:1};
 assert.notEqual(marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,req).callKey,marketauxCallIdentity(f.manifestHash,f.policy.instrumentId,f.source,{...req,attemptId:'00000000-0000-4000-8000-000000000099'}).callKey);
 assert.throws(()=>marketauxQualificationDeadline(f.newsConfig,now+3*86400000));
});

test('two-source exact AI wire contract cannot downgrade to report prompt or choose policy from payload', () => {
 const f=twoSourceResearchFixture(now), contract=researchPromptContract(f.manifest);
 assert.match(contract.systemPrompt,/Audited financial reports.*not supplied or required/);
 assert.doesNotMatch(contract.systemPrompt,/For banks use the configured banking metrics/);
 const request:any={schemaVersion:contract.requestVersion,promptVersion:contract.promptVersion,outputSchemaVersion:f.manifest.model.outputSchemaVersion,model:f.manifest.model.model,maxOutputTokens:f.manifest.model.maxOutputTokens,systemPrompt:contract.systemPrompt,context:{fixture:true}};
 request.providerRequest=researchWireRequest(request);
 validateResearchAiRequest(request,f.manifest.model,f.manifest);
 assert.throws(()=>validateResearchAiRequest(request,f.manifest.model));
 assert.throws(()=>validateResearchAiRequest({...request,promptVersion:'pp7-research-context-v2'},f.manifest.model,f.manifest));
 assert.throws(()=>researchPromptContract({...f.manifest,model:{...f.manifest.model,promptVersion:'pp7-research-context-v2'}}));
});
