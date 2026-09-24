import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerGpwRoutes} from './gpw-routes.js';
import {wseTestBound,wseMetadataFixture} from './wse-market-rules.fixture.js';
for(const mode of ['valid','no account','foreign account','account changed','provider failure','unknown instrument']) test(`read-only GPW metadata route ${mode}`,async()=>{
 const app=Fastify();let account:string|null=mode==='no account'?null:'PAPER';let reads=0;
 registerGpwRoutes(app,{currentAccountId:()=>account,boundInstrument:()=>mode==='unknown instrument'?null:wseTestBound,
  assertAccountAllowed:()=>{if(mode==='foreign account')throw new Error('not allowed');},
  loadMetadata:async()=>{reads++;if(mode==='provider failure')throw new Error('provider failed');if(mode==='account changed')account='OTHER';return wseMetadataFixture(wseTestBound,'PAPER',Date.now());},
  windowStatus:async()=>({configured:false,ok:false,reason:'gpw_window_unconfigured'})});
 try {const response=await app.inject({method:'GET',url:'/execution/instruments/pko_wse/market-rules'});
  assert.equal(response.statusCode,mode==='valid'?200:mode==='unknown instrument'?404:503);
  if(mode==='valid')assert.equal(response.json().accountId,response.json().metadata.accountId);
  if(['no account','foreign account','unknown instrument'].includes(mode))assert.equal(reads,0);
  const status=await app.inject({method:'GET',url:'/execution/gpw-window'});assert.equal(status.json().configured,false);
 }finally{await app.close();}
});
