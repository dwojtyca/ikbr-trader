import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { ProposedOrder } from '@ikbr/shared';
import type { ResearchStore } from '@ikbr/shared/instrument-research';
import { createResearchEntryValidator } from './research-entry-guard.js';

const base = { db: {} as PoolClient, order: { id:1,instrumentId:'fixture' } as ProposedOrder, clientOrderHash:'a'.repeat(64),accountId:'DU_TEST',sessionId:'session' };
test('missing local research configuration denies before database or research access',async()=>{
  let calls=0;
  const validate=createResearchEntryValidator({store:{assertAuthority:async()=>{calls++;throw new Error('must-not-read');},validateBinding:async()=>{calls++;throw new Error('must-not-read');}} as Pick<ResearchStore,'validateBinding'|'assertAuthority'>,loadedIdentity:()=>null});
  await assert.rejects(validate(base),/RESEARCH_ENTRY_IDENTITY_UNAVAILABLE/);assert.equal(calls,0);
});
test('unattributed legacy proposal cannot gain a new entry approval from configured research',async()=>{
  let calls=0;
  const validate=createResearchEntryValidator({store:{assertAuthority:async()=>{calls++;throw new Error('must-not-read');},validateBinding:async()=>{calls++;throw new Error('must-not-read');}} as Pick<ResearchStore,'validateBinding'|'assertAuthority'>,
    loadedIdentity:()=>({configHash:'b'.repeat(64),manifestHash:'c'.repeat(64)})});
  await assert.rejects(validate(base),/RESEARCH_ENTRY_IDENTITY_UNAVAILABLE/);assert.equal(calls,0);
});

test('repository final-send seam defaults to denied even for an old unbound entry',async()=>{
  const { ExecutionRepository } = await import('./repository.js');
  const { computeClientOrderHash } = await import('@ikbr/shared/client-order-hash');
  const order: ProposedOrder={id:1,instrument:'SYN',conid:'123',side:'BUY',orderType:'LMT',quantity:1,entry:100,stop:99,takeProfit:102,
    confidence:1,reason:'fixture',timestamp:new Date().toISOString(),riskCheckStatus:'PASS',status:'PROPOSED',strategy:'fixture'};
  const row={id:1,instrument:'SYN',instrument_id:null,conid:'123',side:'BUY',order_type:'LMT',quantity:1,entry:100,stop:99,take_profit:102,
    confidence:1,reason:'fixture',created_at:new Date(order.timestamp),risk_check_status:'PASS',status:'PROPOSED',strategy:'fixture',
    client_order_hash:computeClientOrderHash(order)};
  let sends=0,rollbacks=0;
  const client={query:async(sql:string)=>{if(sql==='ROLLBACK')rollbacks++;return {rows:sql.includes('SELECT * FROM proposed_orders')?[row]:[]};},release:()=>{}};
  const pool={connect:async()=>client} as unknown as import('pg').Pool;
  const repo=new ExecutionRepository(pool,undefined,undefined,async()=>({ok:true,generation:1,endsAtMs:Date.now()+10_000}));
  await assert.rejects(repo.withEntryDispatchPermit(order,'DU_TEST',()=>{sends++;}),/RESEARCH_ENTRY_VALIDATOR_UNAVAILABLE/);
  assert.equal(sends,0);assert.equal(rollbacks,1);
});
