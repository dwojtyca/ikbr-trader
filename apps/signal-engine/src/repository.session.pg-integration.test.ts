import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {Redis} from 'ioredis';
import {sessionNativeSource,type InstrumentSessionIdentity} from '@ikbr/shared';
import {SignalRepository} from './repository.js';
import {fixtureSessionSchedule} from './runtime/strategy/session-native.fixture.js';
test('generic schedule identity/mode isolation and source filtering happen before SQL limit',{skip:!process.env.TEST_POSTGRES_URL},async()=>{
 const schema=`session_${randomUUID().replaceAll('-','')}`;
 const admin=new Pool({connectionString:process.env.TEST_POSTGRES_URL});
 const pool=new Pool({connectionString:process.env.TEST_POSTGRES_URL,options:`-c search_path=${schema}`});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE instrument_session_schedules(instrument_id text,conid text,use_rth boolean,generation bigint,status text,evidence jsonb,updated_at timestamptz,PRIMARY KEY(instrument_id,conid,use_rth))`);
  await pool.query(`CREATE TABLE candles_1m(conid text,symbol text,ts timestamptz,open numeric,high numeric,low numeric,close numeric,volume numeric,source text)`);
  const identity:InstrumentSessionIdentity={instrumentId:'arbitrary',conId:777,symbol:'XYZ',secType:'STK',exchange:'X',currency:'PLN',useRTH:true,timeZone:'Europe/Warsaw'};
  const evidence=fixtureSessionSchedule(identity,new Date('2026-09-24T12:00:00Z'));
  const repo=new SignalRepository(pool,{} as Redis);
  assert.equal(await repo.getSessionScheduleEvidence(identity),null);
  await pool.query(`INSERT INTO instrument_session_schedules VALUES($1,$2,$3,$4,$5,$6,$7)`,[identity.instrumentId,String(identity.conId),identity.useRTH,evidence.generation,evidence.status,evidence.schedule,evidence.updatedAt]);
  assert.deepEqual(await repo.getSessionScheduleEvidence(identity),evidence);
  for(const patch of [{instrumentId:'other'},{conId:778},{useRTH:false}])assert.equal(await repo.getSessionScheduleEvidence({...identity,...patch}),null);
  await pool.query(`CREATE TABLE instrument_contracts(conid text PRIMARY KEY,symbol text,sec_type text,exchange text,primary_exchange text,currency text,local_symbol text,trading_class text,min_tick numeric,display_name text,contract_json jsonb,details_json jsonb,source text,resolved_at timestamptz)`);
  await pool.query(`INSERT INTO instrument_contracts(conid,symbol,sec_type,source) VALUES('100','FUT','FUT','ibkr'),('101','FUT','FUT','ibkr'),('102','OTHER','STK','ibkr')`);
  assert.equal(await repo.getInstrumentContract('FUT'),null);
  assert.equal((await repo.getInstrumentContract('FUT','101'))?.conid,'101');
  assert.equal(await repo.getInstrumentContract('FUT','102'),null);
  assert.equal(await repo.getInstrumentContract('FUT','999'),null);
  assert.equal((await repo.getInstrumentContract('OTHER'))?.conid,'102');
  const source=sessionNativeSource(identity);
  for(const [conid,symbol,tag,instant] of [['777','XYZ',source,'2026-09-24T11:59:00Z'],['777','XYZ','legacy','2026-09-24T12:00:00Z'],['777','XYZ',sessionNativeSource({useRTH:false}),'2026-09-24T12:01:00Z'],['778','XYZ',source,'2026-09-24T12:02:00Z'],['777','OTHER',source,'2026-09-24T12:03:00Z']])await pool.query(`INSERT INTO candles_1m VALUES($1,$2,$3,100,101,99,100,1,$4)`,[conid,symbol,instant,tag]);
  const rows=await repo.getRecentCandlesForContract('XYZ','777','1m',1,false,source);
  assert.equal(rows.length,1);assert.equal(rows[0].ts.toISOString(),'2026-09-24T11:59:00.000Z');assert.equal(rows[0].source,source);
 }finally{await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
