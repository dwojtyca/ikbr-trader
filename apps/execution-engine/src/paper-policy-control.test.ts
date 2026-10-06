import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerPaperPolicyControl } from './paper-policy-control.js';
import type { PaperPolicyAuthority } from './paper-policy-authority.js';
import { registerExecutionAuth, AuthFailureBurstTracker } from './auth.js';
import { assertActiveAccountAllowed, assertEnvironmentAllowsWrite } from './env-guard.js';
import { isWriteGuardExempt } from './write-guard-exemptions.js';

test('policy controls retain exact method/path exemption, bearer/account guards and strict request schema', async () => {
  const app=Fastify(), token='pp7-isolated-fixture-token'.repeat(3);
  let account: string|null='DU_TEST', calls=0;
  const config={environment:'paper' as const,tradingEnabled:false,allowedPaperAccounts:['DU_TEST'],allowedLiveAccounts:[]};
  registerExecutionAuth(app,{token,publicPaths:new Set(),writeAudit:()=>{},burstTracker:new AuthFailureBurstTracker(()=>{}),logger:app.log});
  app.addHook('preHandler',async request=>{
    if(request.method!=='POST')return;
    if(isWriteGuardExempt(request.method,request.routeOptions.url))assertActiveAccountAllowed(config,account,{requireKnownAccount:true});
    else assertEnvironmentAllowsWrite(config,account);
  });
  const authority={read:async()=>({authority:null}),change:async()=>{calls++;return{revision:1};}} as unknown as PaperPolicyAuthority;
  registerPaperPolicyControl(app,{authority,account:()=>{assertActiveAccountAllowed(config,account,{requireKnownAccount:true});return account!;}});
  try {
    const payload={requestId:randomUUID(),expectedRevision:0,manifestHash:'a'.repeat(64),priorManifestHash:'b'.repeat(64),reason:'fixture'};
    const request={method:'POST' as const,url:'/execution/paper-policy/schedule',payload};
    assert.equal((await app.inject(request)).statusCode,401);
    const headers={authorization:`Bearer ${token}`};
    assert.equal((await app.inject({...request,headers})).statusCode,200);
    for(const patch of [{expectedRevision:'0'},{requestId:'bad'},{extra:true},{priorManifestHash:undefined}])
      assert.equal((await app.inject({...request,headers,payload:{...payload,...patch}})).statusCode,400);
    assert.equal((await app.inject({...request,headers,url:'/execution/paper-policy/adopt'})).statusCode,400);
    assert.equal(isWriteGuardExempt('POST','/execution/paper-policy/schedule/other'),false);
    assert.equal(isWriteGuardExempt('DELETE','/execution/paper-policy/schedule'),false);
    account='DU_FOREIGN';assert.equal((await app.inject({...request,headers})).statusCode,423);
    account=null;assert.equal((await app.inject({...request,headers})).statusCode,423);
    assert.equal(calls,1);
  } finally {await app.close();}
});
