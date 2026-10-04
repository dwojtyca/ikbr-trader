import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Pool } from 'pg';
import { BoundReviewRepository } from './bound-review-repository.js';
import { BoundReviewWorker } from './bound-review-worker.js';
import { createAaplIdentityResolver } from './aapl-identity.js';
const connection=process.env.TEST_POSTGRES_URL;
const env={IBKR_ENVIRONMENT:'paper',AAPL_PROFILE_ENABLED:'true',INSTRUMENT_BINDINGS_JSON:JSON.stringify([{instrumentId:'aapl_nasdaq',conId:265598,localSymbol:'AAPL',tradingClass:'NMS',exchange:'SMART',currency:'USD',minTick:.01}])};
const indicators={ema20:99,ema50:98,rsi14:55,strategyPriceEvidence:{raw:{entry:100,stop:99,takeProfit:102},final:{entry:100,stop:99,takeProfit:102}}};
describe('AAPL identity through production PostgreSQL repository and bound worker',{skip:!connection},()=>{
 let admin:Pool,pool:Pool,repo:BoundReviewRepository;
 const db=`aapl_ai_${randomUUID().replaceAll('-','')}`;
 beforeEach(async()=>{
  const url=new URL(connection!);url.pathname='/postgres';admin=new Pool({connectionString:url.toString()});await admin.query(`CREATE DATABASE ${db}`);
  url.pathname=`/${db}`;pool=new Pool({connectionString:url.toString()});
  const dir=new URL('../../../infra/sql/migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(x=>x.endsWith('.sql')).sort())await pool.query(readFileSync(new URL(file,dir),'utf8'));
  repo=new BoundReviewRepository(pool);
 });
 afterEach(async()=>{await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS ${db}`);await admin.end();}});
 beforeEach(async()=>{
  await pool.query(`INSERT INTO instrument_contracts(symbol,conid,sec_type,exchange,primary_exchange,currency,local_symbol,trading_class,min_tick,source,resolved_at)
    VALUES('AAPL','265598','STK','SMART','NASDAQ','USD','AAPL','NMS',.01,'ibkr','2026-09-01T12:00:00Z')`);
 });
 async function seed(){
  const row=await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,client_order_hash,side,position_effect,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,strategy,indicator_snapshot,partial_take_profits,trailing_stop_pct,trailing_stop_activation_r)
   VALUES('AAPL','aapl_nasdaq','265598','hash','BUY','OPEN_OR_ADD','LMT',1,100,99,102,'test',.8,'PASS','momentum_breakout_long_v1',$1,$2,.5,1) RETURNING id`,[JSON.stringify(indicators),JSON.stringify([{rMultiple:2,fraction:.5}])]);
  const id=Number(row.rows[0].id);
  await pool.query(`INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,expires_at) VALUES($1,'hash','aapl_nasdaq','265598','DU1','session',clock_timestamp()+interval '120 seconds')`,[id]);return id;
 }
 it('legacy AAPL metadata cannot bypass missing PP4 research',async()=>{
  const id=await seed();let deliveries=0;
  const worker=new BoundReviewWorker({repository:repo,execution:{executeBoundProposed:async()=>{deliveries++;return'SUBMITTED';}},model:'fixture',promptVersion:'pp4-research-v1'});
  await worker.pollOnce();assert.equal(await worker.pollOnce(),false);
  const stored=(await pool.query('SELECT * FROM proposal_ai_reviews WHERE proposed_order_id=$1',[id])).rows[0];
  assert.equal(stored.status,'REJECTED');assert.equal(stored.decision_json.reason,'RESEARCH_UNAVAILABLE');assert.equal(deliveries,0);
 });
 for(const source of ['override_fallback','unknown'])it(`raw ${source} provenance cannot become ibkr evidence`,async()=>{
  await seed();await pool.query('UPDATE instrument_contracts SET source=$1',[source]);const claim=(await repo.claim())!;
  const result=await createAaplIdentityResolver({pool,env})(claim);assert.deepEqual(result,{ok:false,reason:'AAPL_IDENTITY_PROVENANCE_INVALID'});
 });
});
