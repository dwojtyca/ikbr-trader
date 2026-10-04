import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerDiagnosticRoutes} from './routes.js';
import {EMPTY_DIAGNOSTIC_IDENTITY,type DiagnosticReport} from '@ikbr/shared/diagnostics';
const stamp='2026-10-04T10:00:00.000Z';
const report:DiagnosticReport={schemaVersion:1,mode:'events',generatedAt:stamp,interval:{from:stamp,to:stamp},coverage:[],sections:[],counters:[],truncated:false,omissions:[],events:[{...EMPTY_DIAGNOSTIC_IDENTITY,schemaVersion:1,id:'test',service:'execution-engine',code:'UNKNOWN',severity:'CRITICAL',occurredAt:stamp,recordedAt:stamp,reason:'UNKNOWN',message:'DU1234567 token=abc SECRET',impact:'hold',action:'observe',auditRef:null,fields:[]}]};
test('diagnostics require authentication even with read-only data; validate before DB and redact both fields and messages',async()=>{
 const app=Fastify();let reads=0;
 registerDiagnosticRoutes(app,{token:'private-fixture',read:async()=>{reads++;return report;},privacy:()=>({secrets:['SECRET'],accountIds:['DU1234567']}),now:()=>Date.parse(stamp)});
 try{
 assert.equal((await app.inject({url:'/execution/diagnostics'})).statusCode,401);
 assert.equal((await app.inject({url:'/execution/diagnostics',headers:{authorization:'Bearer wrong'}})).statusCode,401);
 assert.equal(reads,0);
 assert.equal((await app.inject({url:'/execution/diagnostics?limit=1001',headers:{authorization:'Bearer private-fixture'}})).statusCode,400);
 assert.equal((await app.inject({url:'/execution/diagnostics?sql=drop',headers:{authorization:'Bearer private-fixture'}})).statusCode,400);
 assert.equal(reads,0);
 const response=await app.inject({url:'/execution/diagnostics',headers:{authorization:'Bearer private-fixture'}});
 assert.equal(response.statusCode,200);assert.equal(reads,1);assert.doesNotMatch(response.body,/DU1234567|SECRET|token=abc/);
 assert.equal((await app.inject({method:'POST',url:'/execution/diagnostics',headers:{authorization:'Bearer private-fixture'}})).statusCode,404);
 }finally{await app.close();}
});
test('source failures do not expose exception secrets or imply empty healthy report',async()=>{
 const app=Fastify();registerDiagnosticRoutes(app,{token:'fixture',read:async()=>{throw Error('password=secret');},privacy:()=>({})});
 try{const r=await app.inject({url:'/execution/diagnostics',headers:{authorization:'Bearer fixture'}});assert.equal(r.statusCode,503);assert.deepEqual(r.json(),{error:'DIAGNOSTIC_SOURCE_UNAVAILABLE'});}finally{await app.close();}
});
