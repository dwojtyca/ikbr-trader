import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { Pool } from "pg";
import { ResearchStore, researchHash, wshRequestDates, type ResearchCallReservation, type ResearchBindingIdentity, type WshAcquisition, type WshEndpointLease, type InstrumentResearchSnapshotV2 } from "@ikbr/shared/instrument-research";
import { buildStrategyAttribution, canonicalizeTradingConfiguration } from "@ikbr/shared/trading-config";
import { wshSnapshotFixture } from "@ikbr/shared/instrument-research-testfixture";
import { runMigrations } from "./migrations.js";

const url = process.env.TEST_POSTGRES_URL;
const suite = url ? describe : describe.skip;
async function isolated(run: (pool: Pool) => Promise<void>) {
  const name = `pp7_wsh_${randomUUID().replaceAll("-", "")}`, target = new URL(url!);
  target.pathname = "/postgres"; const admin = new Pool({ connectionString: target.toString() });
  await admin.query(`CREATE DATABASE ${name}`); target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.toString() });
  try { await runMigrations(pool); await run(pool); }
  finally { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
}
async function seed(pool: Pool) {
  const fixture = wshSnapshotFixture(), store = new ResearchStore(pool);
  await pool.query("INSERT INTO trading_configuration_snapshots(effective_hash,schema_version,canonical_version,canonical_json) VALUES($1,1,1,$2)", [fixture.configHash,canonicalizeTradingConfiguration(fixture.config)]);
  await store.registerManifest({ manifest:fixture.manifest,configuration:fixture.config,tradingEnabled:false,adopt:true });
  for(const service of ["execution-engine","llm-agent"] as const) await store.observe({ configHash:fixture.configHash,manifestHash:fixture.manifestHash,service,processId:service,tradingEnabled:false });
  return {...fixture,store};
}
type Fixture = Awaited<ReturnType<typeof seed>>;
function reservation(f: Fixture, key: string, requestHash = "c".repeat(64)): ResearchCallReservation {
  return { configHash:f.configHash,manifestHash:f.manifestHash,accountId:"DU_TEST",provider:"ibkr-wsh",kind:"source",callKey:key,requestHash,reservedCostMicros:0,maxRequestsPerDay:100,maxCostMicrosPerDay:0,deadlineAt:new Date(Date.now()+9000).toISOString() };
}
async function begin(f: Fixture, lease: WshEndpointLease, key = randomUUID()) {
  const meta = reservation(f,`${key}:metadata`);
  const acquisition = await f.store.beginWshAcquisition(lease,{configHash:f.configHash,manifestHash:f.manifestHash,instrumentId:f.policy.instrumentId,sourceId:f.source.id,sessionId:"fixture-session",reservation:meta});
  await f.store.recordCallOutcome(meta.callKey,"SUCCEEDED");
  const snapshot=structuredClone(f.snapshot), coverage=snapshot.coverage[2];
  assert.ok("wshAcquisition" in coverage);coverage.wshAcquisition.acquisitionId=acquisition.id;coverage.wshAcquisition.generation=acquisition.generation;
  const stamp=new Date().toISOString(),dates=wshRequestDates(f.wshConfig,stamp);snapshot.createdAt=stamp;
  coverage.checkedAt=stamp;coverage.windowStart=stamp;coverage.windowEnd=stamp;coverage.wshAcquisition.requestAsOf=stamp;coverage.wshAcquisition.requestStartDate=dates.startDate;coverage.wshAcquisition.requestEndDate=dates.endDate;
  const requestHash=researchHash({endpointId:lease.endpointId,sessionId:acquisition.sessionId,requestId:2,method:"reqWshEventData",request:{conId:f.policy.listing.conId,filter:"",fillWatchlist:false,fillPortfolio:false,fillCompetitors:false,...dates,totalLimit:100}});
  coverage.wshAcquisition.requestHash=requestHash;
  for(const evidence of snapshot.evidence)if(evidence.published===null){evidence.receiptAt=stamp;evidence.locator.requestHash=requestHash;}
  await f.store.reserveWshCall(lease,acquisition,reservation(f,`${key}:events`,requestHash));
  return { acquisition,snapshot,key };
}
function negative(snapshot: InstrumentResearchSnapshotV2): InstrumentResearchSnapshotV2 {
  const copy=structuredClone(snapshot), refs=new Set(copy.evidence.filter(e=>e.published===null).map(e=>e.ref));
  copy.evidence=copy.evidence.filter(e=>e.published!==null);copy.events=copy.events.filter(e=>!refs.has(e.evidenceRef));
  const old=copy.coverage[2];copy.coverage[2]={sourceId:old.sourceId,role:"calendar",status:"ERROR",checkedAt:new Date().toISOString(),windowStart:old.windowStart,windowEnd:old.windowEnd,complete:false,evidenceRefs:[],reason:"fixture read failed"};copy.createdAt=new Date().toISOString();return copy;
}
async function proposal(pool: Pool, f: Fixture): Promise<ResearchBindingIdentity> {
  const hash="b".repeat(64),listing=f.policy.listing,attribution=buildStrategyAttribution(f.config,f.policy.instrumentId,"momentum_default"),stamp=new Date().toISOString();
  const trigger={version:1,source:"evaluation_bucket",timeframe:"1m",observedAt:stamp,bucketStartMs:Math.floor(Date.parse(stamp)/60000)*60000};
  const row=(await pool.query(`INSERT INTO proposed_orders(instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,client_order_hash,client_order_hash_version,strategy_attribution,strategy_trigger)
    VALUES($1,$2,$3,'BUY','LMT',1,100,99,102,'fixture',1,'PASS',$4,2,$5,$6) RETURNING id`,[listing.symbol,f.policy.instrumentId,String(listing.conId),hash,attribution,trigger])).rows[0];
  await pool.query("INSERT INTO proposal_ai_reviews(proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,client_order_hash_version,strategy_attribution,strategy_trigger) VALUES($1,$2,$3,$4,'DU_TEST','fixture',2,$5,$6)",[row.id,hash,f.policy.instrumentId,String(listing.conId),attribution,trigger]);
  return {proposalId:Number(row.id),clientOrderHash:hash,configHash:f.configHash,manifestHash:f.manifestHash,instrumentId:f.policy.instrumentId};
}
suite("WSH prospective first observation, publication fencing and immutable calls",()=>{
  test("success publishes DB first observation atomically; failed persistence leaves pending acquisition and no observations",async()=>isolated(async pool=>{
    const f=await seed(pool);
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const {acquisition,snapshot}=await begin(f,lease);
      const bad=structuredClone(snapshot);bad.mappingHash="f".repeat(64);
      await assert.rejects(f.store.publishWshSnapshot(lease,acquisition,bad),/MAPPING/);
      assert.equal((await pool.query("SELECT 1 FROM research_wsh_first_observations")).rows.length,0);
      assert.equal((await f.store.readWshAcquisition(acquisition.id))!.state,"PENDING");
      const stored=await f.store.publishWshSnapshot(lease,acquisition,snapshot,"fixture-success");
      const evidence=stored.snapshot.evidence.find(e=>e.published===null);assert.ok(evidence?.published===null);
      assert.notEqual(evidence.firstObservedAt,snapshot.createdAt);assert.equal(evidence.published,null);
      const row=(await pool.query("SELECT first_observed_at FROM research_wsh_first_observations")).rows[0];assert.equal(evidence.firstObservedAt,row.first_observed_at.toISOString());
      assert.equal((await f.store.readWshAcquisition(acquisition.id))!.snapshot_id,stored.id);
      assert.equal((await pool.query("SELECT outcome FROM research_call_outcomes")).rows.every(r=>r.outcome==="SUCCEEDED"),true);
      await assert.rejects(pool.query("UPDATE research_wsh_first_observations SET first_observed_at=clock_timestamp()"),/IMMUTABLE/);
      const edited=structuredClone(stored.snapshot);edited.coverage[2].checkedAt=new Date().toISOString();edited.createdAt=new Date().toISOString();
      await assert.rejects(f.store.storeSnapshot(edited),/IMMUTABLE|MISMATCH/);
      await assert.rejects(f.store.publishWshSnapshot(lease,acquisition,snapshot),/RETIRED/);
    });
  }));
  test("timeout retires generation, preserves metadata success and spent event UNKNOWN, prevents immediate replay",async()=>isolated(async pool=>{
    const f=await seed(pool);let old:WshAcquisition|undefined;
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const {acquisition,snapshot,key}=await begin(f,lease);old=acquisition;
      const newer=structuredClone(f.manifest);newer.model.model="next";
      await assert.rejects(f.store.registerManifest({manifest:newer,configuration:f.config,tradingEnabled:false,adopt:true}),/ACTIVE_OR_UNKNOWN/);
      await f.store.finishWshFailure(lease,acquisition,negative(snapshot),"UNKNOWN");
      assert.equal((await pool.query("SELECT outcome FROM research_call_outcomes WHERE call_key=$1",[`${key}:metadata`])).rows[0].outcome,"SUCCEEDED");
      assert.equal((await pool.query("SELECT outcome FROM research_call_outcomes WHERE call_key=$1",[`${key}:events`])).rows[0].outcome,"UNKNOWN");
      await assert.rejects(f.store.publishWshSnapshot(lease,acquisition,snapshot),/RETIRED/);
      await assert.rejects(begin(f,lease),/SLOT_TOO_EARLY/);
      assert.equal((await pool.query("SELECT 1 FROM research_call_reservations")).rows.length,2);
    });
    // Fixture time passage changes only the acquisition start, never first observation or outcomes.
    await pool.query("UPDATE research_wsh_acquisitions SET started_at=started_at-interval '16 minutes' WHERE id=$1",[old!.id]);
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const {acquisition,snapshot}=await begin(f,lease);assert.ok(acquisition.generation>old!.generation);
      const stored=await f.store.publishWshSnapshot(lease,acquisition,snapshot);assert.equal(stored.sequence,2);
    });
    assert.equal((await pool.query("SELECT 1 FROM research_call_outcomes WHERE outcome='UNKNOWN'")).rows.length,1);
  }));
  test("endpoint lock is global and restart retires abandoned pending generation without refund",async()=>isolated(async pool=>{
    const f=await seed(pool);let acquisition:WshAcquisition|undefined;
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      acquisition=(await begin(f,lease)).acquisition;
      assert.equal(await new ResearchStore(pool).withWshEndpointLock(f.wshConfig.endpointId,async()=>{throw new Error("must not enter");}),false);
    });
    const restarted=new ResearchStore(pool);
    await restarted.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const pending=await restarted.pendingWshAcquisition(lease);assert.equal(pending!.id,acquisition!.id);
      await assert.rejects(begin({...f,store:restarted},lease),/RECOVERY/);
      await restarted.retireWshAcquisition(lease,pending!,"UNKNOWN");
      assert.equal(await restarted.pendingWshAcquisition(lease),null);
    });
    assert.equal((await pool.query("SELECT 1 FROM research_call_reservations")).rows.length,2);
  }));
  test("source and endpoint rename reuse first observation without any event hold",async()=>isolated(async pool=>{
    const f=await seed(pool);let firstObserved:string|undefined;
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const {acquisition,snapshot}=await begin(f,lease);const stored=await f.store.publishWshSnapshot(lease,acquisition,snapshot);
      const e=stored.snapshot.evidence.find(e=>e.published===null);assert.ok(e?.published===null);firstObserved=e.firstObservedAt;
    });
    await pool.query("UPDATE research_wsh_acquisitions SET started_at=started_at-interval '16 minutes'");
    const source=f.source;source.id="renamed";source.parserConfig.endpointId="renamed-endpoint";
    f.manifestHash=researchHash(f.manifest);f.snapshot.manifestHash=f.manifestHash;f.snapshot.mappingHash=researchHash(f.policy);
    for(const e of f.snapshot.evidence)if(e.published===null){e.sourceId=source.id;e.locator.endpointId="renamed-endpoint";}
    f.snapshot.coverage[2].sourceId=source.id;
    await pool.query("UPDATE research_observations SET expires_at=expires_at-interval '60 seconds',observed_at=observed_at-interval '60 seconds'");
    await f.store.registerManifest({manifest:f.manifest,configuration:f.config,tradingEnabled:false,adopt:true});
    for(const service of ["execution-engine","llm-agent"] as const)await f.store.observe({configHash:f.configHash,manifestHash:f.manifestHash,service,processId:`${service}:renamed`,tradingEnabled:false});
    await f.store.withWshEndpointLock("renamed-endpoint",async lease=>{
      const {acquisition,snapshot}=await begin(f,lease);const stored=await f.store.publishWshSnapshot(lease,acquisition,snapshot);
      const e=stored.snapshot.evidence.find(e=>e.published===null);assert.ok(e?.published===null);assert.equal(e.firstObservedAt,firstObserved);
    });
    assert.equal((await pool.query("SELECT 1 FROM research_wsh_first_observations")).rows.length,1);
  }));
  test("dispatch-first holds head through synchronous send; publication-first denies old binding; refresh start alone keeps last-good valid",async()=>isolated(async pool=>{
    const f=await seed(pool);
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{const {acquisition,snapshot}=await begin(f,lease);await f.store.publishWshSnapshot(lease,acquisition,snapshot);});
    const identity=await proposal(pool,f);await f.store.bind(identity);
    await pool.query("UPDATE research_wsh_acquisitions SET started_at=started_at-interval '16 minutes'");
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const {acquisition,snapshot}=await begin(f,lease);
      await f.store.validateBinding(identity); // A read in progress is not an entry barrier.
      const db=await pool.connect();await db.query("BEGIN");let sent=0;
      try{
        await f.store.validateBinding(identity,db);
        const waiting=f.store.finishWshFailure(lease,acquisition,negative(snapshot),"FAILED");let published=false;
        void waiting.then(()=>{published=true;});
        await new Promise(resolve=>setTimeout(resolve,50));assert.equal(published,false);
        sent++; // Synchronous broker send happens while the head lock remains held.
        await db.query("COMMIT");await waiting;assert.equal(sent,1);
      }finally{await db.query("ROLLBACK");db.release();}
      let laterSends=0;await assert.rejects(async()=>{await f.store.validateBinding(identity);laterSends++;},/SUPERSEDED/);assert.equal(laterSends,0);
    });
  }));
  test("unknown publication COMMIT resolves by exact durable acquisition identity without duplicate publication",async()=>isolated(async pool=>{
    const f=await seed(pool);let loseCommit=false;
    const uncertainStore=new ResearchStore({query:(sql,values)=>pool.query(sql,values),connect:async()=>{
      const db=await pool.connect();return {release:()=>db.release(),query:async(sql:string,values?:unknown[])=>{
        const result=await db.query(sql,values);if(sql==="COMMIT"&&loseCommit){loseCommit=false;throw new Error("fixture commit receipt lost");}return result;
      }};
    }});
    await uncertainStore.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const {acquisition,snapshot}=await begin({...f,store:uncertainStore},lease);loseCommit=true;
      await assert.rejects(uncertainStore.publishWshSnapshot(lease,acquisition,snapshot),/commit receipt lost/);
      const committed=await uncertainStore.readWshAcquisition(acquisition.id);assert.equal(committed!.state,"PUBLISHED");
      assert.equal(typeof committed!.snapshot_id,"string");assert.ok(await uncertainStore.readSnapshot(String(committed!.snapshot_id)));
      await assert.rejects(uncertainStore.publishWshSnapshot(lease,acquisition,snapshot),/RETIRED/);
      assert.equal((await pool.query("SELECT 1 FROM research_snapshots")).rows.length,1);
      assert.equal((await pool.query("SELECT 1 FROM research_wsh_first_observations")).rows.length,1);
    });
  }));
  test("negative persistence failure does not extend last-good expiry or consume a second publication",async()=>isolated(async pool=>{
    const f=await seed(pool);let originalId:string|undefined;
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{const {acquisition,snapshot}=await begin(f,lease);originalId=(await f.store.publishWshSnapshot(lease,acquisition,snapshot)).id;});
    const identity=await proposal(pool,f),original=await f.store.bind(identity),expiry=original.eligibility.expiresAt;
    await pool.query("UPDATE research_wsh_acquisitions SET started_at=started_at-interval '16 minutes'");
    await f.store.withWshEndpointLock(f.wshConfig.endpointId,async lease=>{
      const {acquisition,snapshot}=await begin(f,lease),bad=negative(snapshot);bad.mappingHash="f".repeat(64);
      await assert.rejects(f.store.finishWshFailure(lease,acquisition,bad,"UNKNOWN"),/MAPPING/);
      assert.equal((await f.store.readWshAcquisition(acquisition.id))!.state,"PENDING");
      const unchanged=await f.store.validateBinding(identity);assert.equal(unchanged.stored.id,originalId);assert.equal(unchanged.eligibility.expiresAt,expiry);
      await f.store.retireWshAcquisition(lease,acquisition,"UNKNOWN");
      const retired=await f.store.validateBinding(identity);assert.equal(retired.eligibility.expiresAt,expiry);
      assert.equal((await pool.query("SELECT 1 FROM research_snapshots")).rows.length,1);
    });
  }));

});
