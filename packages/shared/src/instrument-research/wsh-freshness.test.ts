import test from 'node:test';
import assert from 'node:assert/strict';
import {wshSnapshotFixture} from './research.fixture.js';
import {parseResearchManifest,researchHash,parseResearchSnapshot} from './validation.js';
import {evaluateResearchEligibility} from './eligibility.js';
import {inspectResearch} from './repair.js';
const start=Date.parse('2026-10-14T12:00:00Z');
function fixture(age:900000|86400000){
  const f=wshSnapshotFixture(start);f.source.parserConfig.maxAgeMs=age;
  const expires=new Date(start+3*86400000).toISOString();
  (f.source.parserConfig.qualification as Record<string,unknown>).expiresAt=expires;
  (f.source.parserConfig.entitlement as Record<string,unknown>).expiresAt=expires;
  const c=f.snapshot.coverage.find(c=>'wshAcquisition' in c)!;
  if('wshAcquisition' in c){c.wshAcquisition.qualificationExpiresAt=expires;c.wshAcquisition.entitlementExpiresAt=expires;}
  f.snapshot.manifestHash=researchHash(f.manifest);f.snapshot.mappingHash=researchHash(f.policy);
  return f;
}
for(const age of [900000,86400000] as const)test(`WSH ${age} expiry exact boundary and preparation agree`,()=>{
  const f=fixture(age),checked=Date.parse(f.snapshot.createdAt);
  for(const delta of [age-1,age]){
    const now=checked+delta,s=structuredClone(f.snapshot);s.createdAt=new Date(now).toISOString();
    for(const c of s.coverage.filter(c=>c.role!=='calendar')){c.checkedAt=s.createdAt;c.windowEnd=s.createdAt;c.windowStart=new Date(now-86400000).toISOString();}
    const result=evaluateResearchEligibility(s,f.manifest,now);
    assert.equal(result.eligible,delta<age,result.reasons.join(','));
    const state=inspectResearch(f.manifest,s.instrumentId,{id:'fixture',hash:researchHash(s),sequence:1,snapshot:s},now);
    assert.equal(state.sources.find(s=>s.role==='calendar')?.state,delta<age?'READY':'WAITING');
  }
});
test('WSH legacy bytes retained; only the two maxAge choices and fixed regular interval accepted',()=>{
  const f=fixture(900000),before=JSON.stringify(f.manifest),snapshot=JSON.stringify(f.snapshot);
  assert.equal(JSON.stringify(parseResearchManifest(f.manifest,f.config,f.configHash)),before);
  assert.equal(JSON.stringify(parseResearchSnapshot(f.snapshot,f.manifest)),snapshot);
  for(const age of [0,900001,86400001,Infinity,'86400000']){const c=structuredClone(f.manifest);c.instruments.find(p=>p.instrumentId===f.policy.instrumentId)!.sources.find(s=>s.id===f.source.id)!.parserConfig.maxAgeMs=age;assert.throws(()=>parseResearchManifest(c,f.config,f.configHash));}
  f.source.parserConfig.refreshIntervalMs=86400000;assert.throws(()=>parseResearchManifest(f.manifest,f.config,f.configHash));
});
test('24h validity is capped by qualification and rejects future receipt',()=>{
  const f=fixture(86400000);const now=start+10000;
  (f.source.parserConfig.qualification as Record<string,unknown>).expiresAt=new Date(now).toISOString();
  const c=f.snapshot.coverage.find(c=>'wshAcquisition' in c)!;if('wshAcquisition' in c)c.wshAcquisition.qualificationExpiresAt=new Date(now).toISOString();
  f.snapshot.manifestHash=researchHash(f.manifest);f.snapshot.mappingHash=researchHash(f.policy);
  assert.ok(evaluateResearchEligibility(f.snapshot,f.manifest,now).reasons.includes('RESEARCH_WSH_QUALIFICATION_UNAVAILABLE'));
  assert.equal(evaluateResearchEligibility(f.snapshot,f.manifest,start-2000).eligible,false);
});
