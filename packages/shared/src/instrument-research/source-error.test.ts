import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureResearchSourceError, formatResearchSourceError, isResearchSourceError, ResearchSourceFailure } from './source-error.js';
import { researchFixture } from './research.fixture.js';
import { parseResearchSnapshot, researchHash } from './validation.js';
test('native originals survive multiple wrappers and privacy boundaries',()=>{
 const native=Object.assign(new Error('The operation was aborted; api_token=private token https://u:p@api.example/?key=private\n\u001b'),{name:'AbortError',code:'ABORT_ERR',cause:Object.assign(new Error('This operation was aborted'),{code:20})});
 const first=new ResearchSourceFailure('RESEARCH_SOURCE_TIMEOUT',native,{secrets:['private']});
 const second=new ResearchSourceFailure('RESEARCH_MARKETAUX_ACQUISITION_FAILED',first);
 assert.equal(second.sourceError.name,'AbortError');assert.equal(second.sourceError.code,'ABORT_ERR');assert.deepEqual(second.sourceError,first.sourceError);
 assert.ok(!JSON.stringify(second).includes('private'));assert.ok(!JSON.stringify(second).includes('https://'));
 assert.ok(isResearchSourceError(second.sourceError));assert.ok(!JSON.stringify(second.cause).includes('private'));
});
test('HTTP detail preserves original status/provider text and no fictitious native name',()=>{
 const error=new ResearchSourceFailure('RESEARCH_SOURCE_HTTP_401',null,{secrets:['secret']},{httpStatus:401,httpStatusMessage:'Unauthorized',providerCode:'invalid_api_token',providerMessage:'secret invalid'});
 assert.equal(error.sourceError.name,null);assert.equal(error.sourceError.message,'Unauthorized');assert.equal(error.sourceError.providerMessage,'[UKRYTO] invalid');assert.match(formatResearchSourceError(error.sourceError),/HTTP: 401 Unauthorized/);
});
test('internal codes, missing originals, unsupported objects and invalid shapes stay truthful',()=>{
 assert.equal(captureResearchSourceError(new Error('RESEARCH_SOURCE_TIMEOUT')).name,null);
 assert.match(captureResearchSourceError({toString(){throw Error('must not stringify');}}).message,/niedostępny/);
 for(const value of [{name:'Error',code:null,message:'fine',stack:'secret'},{name:'Error',code:{},message:'fine'},{name:'Error',code:null,message:'bad\n'},{name:'Error',code:null,message:'fine',httpStatus:600}])assert.equal(isResearchSourceError(value),false);
});
test('encoded explicit secrets are removed from diagnostic primitives',()=>{
 const secret='a/b+c';const e=Object.assign(new Error(encodeURIComponent(secret)),{code:encodeURIComponent(secret)});
 assert.equal(captureResearchSourceError(e,{secrets:[secret]}).message,'[UKRYTO]');
});
test('optional HTTP source diagnostics preserve old hashes and reject successful/foreign attachment',()=>{
 const f=researchFixture(),oldHash=researchHash(f.snapshot);parseResearchSnapshot(f.snapshot,f.manifest);assert.equal(researchHash(f.snapshot),oldHash);
 const coverage=f.snapshot.coverage[0];coverage.status='ERROR';coverage.complete=false;coverage.sourceError={name:'Error',code:'ECONNRESET',message:'socket hang up'};
 parseResearchSnapshot(f.snapshot,f.manifest);coverage.status='AVAILABLE';coverage.complete=true;
 assert.throws(()=>parseResearchSnapshot(f.snapshot,f.manifest),/RESEARCH_SOURCE_ERROR_INVALID/);
});

test('mixed-case percent triplets do not reveal a case-sensitive secret',()=>{
 const result=captureResearchSourceError(Object.assign(new Error('AbC%2fx%3fz'),{code:'AbC%2Fx%3fz'}),{secrets:['AbC/x?z']});
 assert.equal(result.message,'[UKRYTO]');assert.equal(result.code,'[UKRYTO]');
});
