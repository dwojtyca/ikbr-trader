import test from 'node:test';
import assert from 'node:assert/strict';
import {wshSnapshotFixture} from './research.fixture.js';
import {parseWshConfig,wshQualificationDeadline,wshReceiptPolicy} from './wsh.js';
import {parseResearchManifest,parseResearchSnapshot,researchHash} from './validation.js';
import {evaluateResearchEligibility} from './eligibility.js';
import {inspectResearch} from './repair.js';
const now=Date.parse('2026-10-15T12:00:00Z');
const validity={mode:'OPERATOR_CONFIRMED_ONGOING',confirmedAt:new Date(now-2000).toISOString(),confirmationRef:'owner-paid-access-2026-10-15',confirmationHash:'a'.repeat(64)};
function fixture(){const f=wshSnapshotFixture(now);f.source.parserConfig.maxAgeMs=86400000;f.source.parserConfig.refreshIntervalMs=3600000;
 for(const name of ['qualification','entitlement']){const r=f.source.parserConfig[name] as Record<string,unknown>;r.expiresAt=null;r.validity=structuredClone(validity);}
 const config=parseWshConfig(f.source,f.policy),c=f.snapshot.coverage.find(c=>'wshAcquisition'in c)!;if('wshAcquisition'in c)c.wshAcquisition={...c.wshAcquisition,...wshReceiptPolicy(config)};
 f.snapshot.manifestHash=researchHash(f.manifest);f.snapshot.mappingHash=researchHash(f.policy);return f;}
test('explicit ongoing has no access deadline, exact v2 hashes and finite24h calendar validity',()=>{
 const f=fixture(),config=parseWshConfig(f.source,f.policy);assert.equal(wshQualificationDeadline(config,now),null);
 const policy=wshReceiptPolicy(config);assert.equal(policy.contractVersion,'ibkr-wsh-v2');if(policy.contractVersion==='ibkr-wsh-v2'){assert.equal(policy.qualificationHash,researchHash(config.qualification));assert.equal(policy.entitlementHash,researchHash(config.entitlement));}
 assert.doesNotThrow(()=>parseResearchManifest(f.manifest,f.config,f.configHash));assert.doesNotThrow(()=>parseResearchSnapshot(f.snapshot,f.manifest));
 const checked=Date.parse(f.snapshot.createdAt);
 for(const delta of [86400000-1,86400000]){const at=checked+delta,s=structuredClone(f.snapshot);s.createdAt=new Date(at).toISOString();for(const c of s.coverage.filter(c=>c.role!=='calendar')){c.checkedAt=s.createdAt;c.windowEnd=s.createdAt;c.windowStart=new Date(at-86400000).toISOString();}
 const result=evaluateResearchEligibility(s,f.manifest,at);assert.equal(result.eligible,delta<86400000,result.reasons.join(','));assert.ok(result.expiresAt&&Number.isFinite(Date.parse(result.expiresAt)));assert.equal(result.expiresAt,new Date(checked+86400000).toISOString());
 const prep=inspectResearch(f.manifest,s.instrumentId,{id:'fixture',hash:researchHash(s),sequence:1,snapshot:s},at);assert.equal(prep.sources.find(r=>r.role==='calendar')?.state,delta<86400000?'READY':'WAITING');}
});
test('legacy finite hashes/receipt shape stay unchanged, mixed policy remains capped at finite expiry',()=>{
 const finite=wshSnapshotFixture(now),before=researchHash(finite.manifest),receipt=finite.snapshot.coverage.find(c=>'wshAcquisition'in c)!;
 assert.equal(parseWshConfig(finite.source,finite.policy).qualification.expiresAt,finite.wshConfig.qualification.expiresAt);assert.equal(researchHash(parseResearchManifest(finite.manifest,finite.config,finite.configHash)),before);
 assert.equal(wshReceiptPolicy(finite.wshConfig).contractVersion,'ibkr-wsh-v1');assert.ok('wshAcquisition'in receipt&&!('qualificationHash'in receipt.wshAcquisition));
 const f=fixture(),r=f.source.parserConfig.entitlement as Record<string,unknown>;delete r.validity;r.expiresAt=new Date(now+5000).toISOString();const config=parseWshConfig(f.source,f.policy);assert.equal(wshQualificationDeadline(config,now),now+5000);assert.throws(()=>wshQualificationDeadline(config,now+5000),/QUALIFICATION_UNAVAILABLE/);
});
test('null cannot silently mean ongoing and malformed confirmation shapes reject',()=>{
 const mutations=[(r:any)=>delete r.validity,(r:any)=>r.expiresAt='null',(r:any)=>r.expiresAt=new Date(now+10000).toISOString(),(r:any)=>delete r.expiresAt,(r:any)=>r.validity.mode='FINITE',(r:any)=>r.validity.confirmationHash='x',(r:any)=>r.validity.confirmationRef='token?secret=x',(r:any)=>r.validity.extra=true,(r:any)=>r.validity.confirmedAt='invalid',(r:any)=>r.validity.confirmedAt=new Date(now-2*86400000).toISOString(),(r:any)=>r.validity=undefined];
 for(const mutate of mutations){const f=fixture();mutate(f.source.parserConfig.qualification);assert.throws(()=>parseWshConfig(f.source,f.policy));}
 const f=fixture();(f.source.parserConfig.qualification as any).validity.confirmedAt=new Date(now+1).toISOString();assert.throws(()=>wshQualificationDeadline(parseWshConfig(f.source,f.policy),now),/QUALIFICATION_UNAVAILABLE/);
});
test('ongoing WSH receipts reject downgrade, hash mismatch and capture before confirmation',()=>{
 for(const mutate of [(c:any)=>c.wshAcquisition.contractVersion='ibkr-wsh-v1',(c:any)=>delete c.wshAcquisition.qualificationHash,(c:any)=>c.wshAcquisition.entitlementHash='f'.repeat(64),(c:any)=>c.wshAcquisition.qualificationExpiresAt=new Date(now+1000).toISOString()]){const f=fixture();mutate(f.snapshot.coverage.find(c=>'wshAcquisition'in c));assert.throws(()=>parseResearchSnapshot(f.snapshot,f.manifest));}
 const f=fixture();(f.source.parserConfig.qualification as any).validity.confirmedAt=new Date(now-500).toISOString();const config=parseWshConfig(f.source,f.policy),c=f.snapshot.coverage.find(c=>'wshAcquisition'in c)!;if('wshAcquisition'in c)c.wshAcquisition={...c.wshAcquisition,...wshReceiptPolicy(config)};f.snapshot.manifestHash=researchHash(f.manifest);f.snapshot.mappingHash=researchHash(f.policy);assert.throws(()=>parseResearchSnapshot(f.snapshot,f.manifest),/QUALIFICATION_UNAVAILABLE/);
});
test('finite canonical hashes equal the pre-change HEAD fixture baseline',()=>{
 const f=wshSnapshotFixture(now);
 assert.equal(researchHash(f.manifest),'882b9e60ca5ab759a93908ff2f8f13a29ecbe48f90afc5d76213dcd10da5361f');
 assert.equal(researchHash(f.snapshot),'14d55a4d6d12a7d561bbb84a3ca418b3db89c74dada10b6efc2a0c092b3b8f99');
 assert.equal(researchHash(f.source),'642a778ce6473d3c23b7d963670117558c38653efe2d4a788a27b69e98d771e3');
});
