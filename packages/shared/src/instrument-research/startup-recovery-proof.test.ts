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
