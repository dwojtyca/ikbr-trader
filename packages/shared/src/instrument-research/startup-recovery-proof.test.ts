import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseRecoveryEvidence} from './startup-recovery.js';
import {researchHash} from './validation.js';
function proof(){
 const stamp=(n:number)=>new Date(Date.UTC(2026,9,19,12,0,n)).toISOString(),sessionId=randomUUID(),endpointId='fixture-endpoint',host='localhost',port=4002,clientId=19;
 return {version:'local-research-recovery-v1',kind:'WSH_ENDPOINT_RESET',challengeId:randomUUID(),challengeHash:'a'.repeat(64),nonce:randomUUID(),hostIdHash:'b'.repeat(64),platform:'darwin',collectorStartedAt:stamp(0),producerCheckedAt:stamp(1),producerRecheckedAt:stamp(10),deploymentHash:'c'.repeat(64),producers:[{containerId:'a'.repeat(64),imageId:'sha256:'+'b'.repeat(64),project:'fixture',service:'llm-agent',startedAt:stamp(-20),finishedAt:stamp(-1),state:'exited'}],runningProducerIds:[],endpointId,host,port,clientId,endpointSettingsHash:researchHash({endpointId,host,port,clientId}),before:{observedAt:stamp(2),process:{pid:100,startIdentity:'old',executableHash:'a'.repeat(64)}},stopped:{observedAt:stamp(3),processAbsent:true,listenerAbsent:true},after:{observedAt:stamp(4),process:{pid:101,startIdentity:'new',executableHash:'a'.repeat(64)}},reconnect:{startedAt:stamp(5),completedAt:stamp(6),sessionId,accountId:'DU_TEST',serverVersion:180,sdkVersion:'1.6.10',cleanup:{sessionId,state:'CONFIRMED',verifiedLocalClosure:true,completedAt:stamp(9),cancellationAttemptedAt:stamp(6),disconnectRequestedAt:stamp(7),localClosedAt:stamp(8)}}};
}
test('cleanup belongs to the new reconnect lifetime and follows disconnect request',()=>{
 const p=proof();assert.equal(parseRecoveryEvidence(p).kind,'WSH_ENDPOINT_RESET');
 for(const field of ['cancellationAttemptedAt','disconnectRequestedAt','localClosedAt'] as const){const changed=structuredClone(p);changed.reconnect.cleanup[field]=p.before.observedAt;assert.throws(()=>parseRecoveryEvidence(changed),/EVIDENCE_INVALID/);}
 const changed=structuredClone(p);changed.reconnect.cleanup.localClosedAt=changed.reconnect.cleanup.cancellationAttemptedAt;assert.throws(()=>parseRecoveryEvidence(changed),/EVIDENCE_INVALID/);
});
test('sparse, accessor and extra-key producer arrays reject without executing accessors',()=>{
 const p=proof();for(const producers of [new Array(1),Object.assign([p.producers[0]],{rawPayload:'secret'})])assert.throws(()=>parseRecoveryEvidence({...p,producers}),/EVIDENCE_INVALID/);
 let called=false;const producers=[p.producers[0]];Object.defineProperty(producers,'0',{get(){called=true;return p.producers[0];}});
 assert.throws(()=>parseRecoveryEvidence({...p,producers}),/EVIDENCE_INVALID/);assert.equal(called,false);
 const runningProducerIds=[];Object.defineProperty(runningProducerIds,Symbol('hidden'),{value:'secret'});assert.throws(()=>parseRecoveryEvidence({...p,runningProducerIds}),/EVIDENCE_INVALID/);
});

function createdProof() {
 const p=proof();
 return {...p,producers:[{...p.producers[0],state:'created',createdAt:'2026-10-19T11:00:00.123Z',startedAt:null,finishedAt:null}]};
}
test('created producer evidence preserves actual canonical creation and null lifecycle across all proof kinds',()=>{
 for(const kind of ['MARKETAUX_PRODUCER_QUIESCENCE','WSH_ENDPOINT_RESET','PRODUCER_QUIESCENCE']) {
  const full={...createdProof(),kind};
  const {endpointId,endpointSettingsHash,host,port,clientId,before,stopped,after,reconnect,...base}=full;
  const p=kind==='WSH_ENDPOINT_RESET'?{...base,endpointId,endpointSettingsHash,host,port,clientId,before,stopped,after,reconnect}:base;
  assert.deepEqual(parseRecoveryEvidence(p,true),p);
  assert.equal(researchHash(parseRecoveryEvidence(p,true)),researchHash(p));
 }
 for(const state of ['exited','dead']) {
  const p=proof();p.producers[0].state=state;
  assert.deepEqual(parseRecoveryEvidence(p),p);
  assert.equal(JSON.stringify(parseRecoveryEvidence(p)),JSON.stringify(p));
 }
});
test('created producer rejects noncanonical creation, lifecycle fabrication and unexpected shape',()=>{
 const p=createdProof();
 for(const change of [
  ...[undefined,null,0,'invalid','2026-02-30T00:00:00.000Z','2026-10-19T24:00:00.000Z','2026-10-19T12:00:02.000Z',
   '2026-10-19T11:00:00Z','2026-10-19T11:00:00.123456Z','2026-10-19T11:00:00.123+00:00'].map(createdAt=>({createdAt})),
  {startedAt:p.collectorStartedAt},{finishedAt:p.collectorStartedAt},{startedAt:undefined},{finishedAt:undefined},
  {extra:true},{state:'exited'},{state:'dead'},{state:'running'},{state:null},{state:{toString:()=> 'created'}},
 ]) assert.throws(()=>parseRecoveryEvidence({...p,producers:[{...p.producers[0],...change}]}),/EVIDENCE_INVALID/);
 const {createdAt,...missing}=p.producers[0];assert.ok(createdAt);
 assert.throws(()=>parseRecoveryEvidence({...p,producers:[missing]}),/EVIDENCE_INVALID/);
});
test('producer discriminators and creation accessors reject without executing code',()=>{
 for(const key of ['state','createdAt','startedAt','finishedAt']) {
  const p=createdProof();let called=false;
  Object.defineProperty(p.producers[0],key,{enumerable:true,get(){called=true;throw new Error('getter executed');}});
  assert.throws(()=>parseRecoveryEvidence(p),/EVIDENCE_INVALID/);assert.equal(called,false);
 }
 let called=false;const p=createdProof();
 const state={toString(){called=true;return 'created';}};
 assert.throws(()=>parseRecoveryEvidence({...p,producers:[{...p.producers[0],state}]}),/EVIDENCE_INVALID/);assert.equal(called,false);
});
