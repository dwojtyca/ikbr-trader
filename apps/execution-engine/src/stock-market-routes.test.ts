import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { buildTradingConfigurationProjection } from '@ikbr/shared/trading-config';
import type { StockMarketMetadata } from '@ikbr/shared';
import { paperPolicyFixture } from './paper-run-policy.fixture.js';
import { registerStockMarketRoutes } from './stock-market-routes.js';
import { AuthFailureBurstTracker, registerExecutionAuth } from './auth.js';
for (const mode of ['valid','no account','foreign account','account changed','provider failure','unknown instrument','no authentication']) test(`configured stock metadata route ${mode}`, async () => {
  const f=paperPolicyFixture(), bound=buildTradingConfigurationProjection(f.loaded.configuration).authority.getBoundInstrument('aapl_smart')!;
  const app=Fastify(); let account:string|null=mode==='no account'?null:'DU_FIXTURE', reads=0;
  registerExecutionAuth(app,{token:'fixture-token',publicPaths:new Set(['/health']),writeAudit:()=>{},burstTracker:new AuthFailureBurstTracker(()=>{}),logger:app.log});
  registerStockMarketRoutes(app,{currentAccountId:()=>account,boundInstrument:()=>mode==='unknown instrument'?null:bound,
    assertAccountAllowed:()=>{if(mode==='foreign account')throw Error('not allowed');},loadMetadata:async()=>{
      reads++;if(mode==='provider failure')throw Error('unavailable');if(mode==='account changed')account='OTHER';
      return {accountId:'DU_FIXTURE',instrumentId:bound.instrumentId} as StockMarketMetadata;
    }});
  try {
    const response=await app.inject({method:'GET',url:'/execution/instruments/aapl_smart/stock-market-rules',headers:mode==='no authentication'?{}:{authorization:'Bearer fixture-token'}});
    assert.equal(response.statusCode,mode==='valid'?200:mode==='unknown instrument'?404:mode==='no authentication'?401:503);
    if(['no account','foreign account','unknown instrument','no authentication'].includes(mode))assert.equal(reads,0);
    if(mode==='valid')assert.equal(response.json().metadata.instrumentId,'aapl_smart');
  }finally{await app.close();}
});
