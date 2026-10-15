import test from 'node:test';
import assert from 'node:assert/strict';
import {wshResearchFixture} from './research.fixture.js';
import {parseWshConfig,wshRefreshIntervalMs} from './wsh.js';
import {researchRefreshInterval,researchRefreshSlot} from './repair.js';
import {researchHash} from './validation.js';
test('WSH supports exact legacy cadence/age and hourly24h without rewriting old hashes',()=>{
 const f=wshResearchFixture(),hash=researchHash(f.manifest);
 assert.equal(parseWshConfig(f.source,f.policy).refreshIntervalMs,900000);assert.equal(researchHash(f.manifest),hash);
 for(const age of [900000,86400000]){f.source.parserConfig.maxAgeMs=age;assert.equal(parseWshConfig(f.source,f.policy).maxAgeMs,age);}
 f.source.parserConfig.refreshIntervalMs=3600000;assert.equal(parseWshConfig(f.source,f.policy).refreshIntervalMs,3600000);
 assert.equal(wshRefreshIntervalMs(f.source),3600000);assert.equal(researchRefreshInterval(f.source,'calendar'),3600000);
 assert.equal(researchRefreshSlot(f.source,'calendar',3599999),0);assert.equal(researchRefreshSlot(f.source,'calendar',3600000),1);
 f.source.parserConfig.maxAgeMs=900000;assert.throws(()=>parseWshConfig(f.source,f.policy),/BOUNDS/);
});
test('WSH malformed intervals fail closed while news/report cadence remains unchanged',()=>{
 const f=wshResearchFixture();for(const interval of [undefined,'3600000',3600000.5,1800000,0,null]){f.source.parserConfig.refreshIntervalMs=interval;assert.throws(()=>parseWshConfig(f.source,f.policy));assert.throws(()=>wshRefreshIntervalMs(f.source));}
 const news=f.policy.sources.find(s=>s.roles.includes('news'))!;assert.equal(researchRefreshInterval(news,'news'),900000);assert.equal(researchRefreshInterval(news,'reports'),86400000);
});
