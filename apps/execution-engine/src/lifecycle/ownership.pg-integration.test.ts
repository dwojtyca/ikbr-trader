import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { InstrumentBindingAuthority, InstrumentRegistry, type Instrument, type SignalTicket } from "@ikbr/shared";
import { computeClientOrderHash } from "@ikbr/shared/client-order-hash";
import { runMigrations } from "../migrations.js";
import { ExecutionRepository } from "../repository.js";
import { ReconciliationRepository } from "../reconciliation/repository.js";
import type { BrokerReconciliationSnapshot } from "../reconciliation/broker-adapter.js";
import { IbBrokerReconciliationAdapter } from "../reconciliation/ib-broker-adapter.js";
import { TwsExecutionClient } from "../tws-execution-client.js";
import { registerLifecycleRoutes } from "./routes.js";
import { evaluateLifecycleOwnership } from "./ownership.js";
const connection = process.env.TEST_POSTGRES_URL;
const accountId = "DU-LIFECYCLE";
const sessionId = "current-session";
function instrument(id = "test", symbol = "TEST"): Instrument {
  return { id, displayName: "Synthetic integration fixture", broker: "ibkr", brokerSymbol: symbol, exchange: "SMART",
    assetClass: "stock", currency: "USD", metadata: { tags: [] },
    session: { useRegularTradingHours: true, timezone: "America/New_York", sessionTemplate: "us_stock_rth" },
    trading: { executionEnabled: true, signalGenerationEnabled: true, aiAnalysisEnabled: true, monitoringEnabled: true },
    risk: { maxLeverage: 1, allowOvernight: false, quantityUnit: "shares", maxQuantity: 1, maxSpread: 1, maxSlippage: 1 },
    executionPolicy: { strategyId: "test_strategy", expectedDirection: "LONG", timeframe: "1m", quantity: 1,
      maxQuantity: 1, quantityUnit: "shares", allowedOrderTypes: ["LMT"], defaultOrderType: "LMT",
      timeInForce: "DAY", outsideRth: false, transmit: true, priceTickSize: 0.01, priceRoundingMode: "nearest" } };
}
function ticket(overrides: Partial<SignalTicket> = {}): SignalTicket {
  return { instrument: "TEST", instrumentId: "test", conid: "123", side: "BUY", orderType: "LMT",
    quantity: 1, entry: 100, stop: 99, takeProfit: 102, confidence: 0.8, reason: "strategy proposal",
    timestamp: new Date().toISOString(), riskCheckStatus: "PASS", ...overrides };
}

async function fixture() {
  const database = `ikbr_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(connection!); url.pathname = "/postgres";
  const admin = new Pool({ connectionString: url.toString() });
  await admin.query(`CREATE DATABASE ${database}`);
  url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: url.toString() });
  await runMigrations(pool);
  const repo = new ExecutionRepository(pool);
  const reconciliation = new ReconciliationRepository(pool);
  const authority = new InstrumentBindingAuthority(new InstrumentRegistry([instrument()]), [
    { instrumentId: "test", conId: 123, localSymbol: "TEST", tradingClass: "TEST", exchange: "SMART", currency: "USD", minTick: 0.01 },
  ]);
  const bound = authority.getBoundInstrument("test")!;
  const attempt = new Date(Date.now() - 2000);
  const value = ticket();
  const hash = computeClientOrderHash(value);
  const inserted = await pool.query(`INSERT INTO proposed_orders
    (instrument,instrument_id,conid,side,order_type,quantity,entry,stop,take_profit,reason,confidence,risk_check_status,
      status,strategy,execution_account_id,execution_attempted_at,client_order_hash,client_order_id)
    VALUES ('TEST','test','123','BUY','LMT',1,100,99,102,'strategy proposal',0.8,'PASS','SUBMITTED','test_strategy',$1,$2,$3,'lifecycle-test') RETURNING id`,
    [accountId,attempt,hash]);
  const id = Number(inserted.rows[0].id);
  await pool.query(`INSERT INTO proposal_ai_reviews (proposed_order_id,client_order_hash,instrument_id,conid,account_id,session_id,
    status,expires_at,decision_json,decided_at,delivery_started_at)
    VALUES ($1,$2,'test','123',$3,'prior-session','APPROVED',$4,$5,$6,$6)`,
    [id,hash,accountId,new Date(attempt.getTime()+120000),JSON.stringify({decision:"EXECUTE",reason:"test evidence",confidence:0.8,model:"test",promptVersion:"v1"}),new Date(attempt.getTime()-100)]);
  for (const [i, role] of ["PARENT","TP","SL"].entries()) {
    await pool.query(`INSERT INTO broker_order_links (proposed_order_id,account_id,role,role_ordinal,broker_order_id,order_ref)
      VALUES ($1,$2,$3,$4,$5,$6)`,[id,accountId,role,i===0?0:1,String(101+i),`test-${role}`]);
  }
  const state = { account: accountId as string|null, session: sessionId };
  const app = Fastify();
  registerLifecycleRoutes(app,{repository:repo,currentAccountId:()=>state.account,currentSessionId:()=>state.session,
    boundInstrument:key=>authority.getBoundInstrument(key)??null});
  const publish = async (mode: "owned"|"pending"|"flat" = "owned", overrides: {
    account?: string; session?: string; failed?: boolean; snapshot?: BrokerReconciliationSnapshot;
  } = {}) => {
    const account = overrides.account??accountId, session = overrides.session??sessionId;
    const client = await pool.connect();
    try {
      const {runId} = await reconciliation.publishRunning(client,{accountId:account,sessionId:session,runTimeoutMs:1000});
      const capture = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
      const openOrders = (mode==="flat"?[]:mode==="owned"?["TP","SL"]:["PARENT","TP","SL"]).map(role=>({
        accountId:account,brokerOrderId:String(101+["PARENT","TP","SL"].indexOf(role)),orderRef:`test-${role}`,
        conId:"123",symbol:"TEST",status:"Submitted",action:role==="PARENT"?"BUY":"SELL",filled:0,remaining:1,observedAt:capture,
      }));
      const executions = (mode==="pending"?[]:mode==="owned"?["PARENT"]:["PARENT","TP"]).map(role=>({
        accountId:account,brokerOrderId:String(role==="PARENT"?101:102),orderRef:`test-${role}`,execId:`fill-${role}`,
        conId:"123",symbol:"TEST",side:role==="PARENT"?"BOT":"SLD",shares:1,price:100,executedAt:new Date(attempt.getTime()+10),
      }));
      const positions = mode==="owned"?[{accountId:account,conId:"123",symbol:"TEST",position:1}]:[];
      const source = (count:number)=>({available:true,boundedWindow:true,timedOut:false,count});
      const snapshot: BrokerReconciliationSnapshot = overrides.snapshot??{accountId:account,sessionId:session,capturedAt:capture,
        exposureComplete:true,recoveryComplete:false,positions,openOrders,executions,completedOrders:[],sourceCoverage:{
          positions:source(positions.length),openOrders:source(openOrders.length),session:source(1),
          completedOrders:{...source(0),available:false,boundedWindow:false},
          executions:{available:true,timedOut:false,count:executions.length,window:{from:attempt.toISOString(),to:capture.toISOString(),exposureWindowComplete:true,recoveryWindowComplete:true}},
        }};
      await reconciliation.publishResult(client,{runId,accountId:account,finalStatus:overrides.failed?"FAILED":"CLEAN",snapshot:overrides.failed?null:snapshot,
        matches:1,mismatchesCount:0,expectedPositionsCount:positions.length,brokerPositionsCount:positions.length,report:{},error:overrides.failed?"test_failure":null,holdInserts:[],holdResolves:[]});
      return {runId,snapshot};
    } finally {client.release();}
  };
  const report = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    const response = await app.inject({method:"GET",url:`/execution/lifecycle/${id}`});
    assert.equal(response.statusCode,200); const body=response.json();
    assert.equal(body.readOnly,true);assert.equal(body.canSubmitClose,false);return body;
  };
  return {pool,repo,reconciliation,id,bound,attempt,state,app,publish,report,
    close:async()=>{await app.close();await pool.end();await admin.query(`DROP DATABASE ${database}`);await admin.end();}};
}

describe("lifecycle ownership through migrated PostgreSQL, real publication and public route",{skip:!connection},()=>{
  it("publishes exact snapshots and reports owned, pending and flat without a close permit",async()=>{
    const f=await fixture();try {
      for (const [mode,status] of [["owned","OWNED_POSITION"],["pending","PENDING_ENTRY"],["flat","FLAT_OBSERVED"]] as const) {
        const published=await f.publish(mode);
        const evidence=await f.repo.getLifecycleEvidence(f.id,accountId);assert.ok(evidence);
        assert.deepEqual(evidence.run?.broker_snapshot,JSON.parse(JSON.stringify(published.snapshot)));
        const report=await f.report();assert.equal(report.status,status,JSON.stringify(report));
        assert.equal(evaluateLifecycleOwnership(evidence,{accountId,sessionId,nowMs:Date.now(),bound:f.bound}).status,status);
      }
      assert.equal((await f.app.inject({method:"GET",url:"/execution/lifecycle/99999"})).statusCode,404);
    }finally{await f.close();}
  });
  it("old NULL evidence, latest failed/running runs and old process session cannot reuse a clean run",async()=>{
    const f=await fixture();try {
      const first=await f.publish();
      await f.pool.query("UPDATE reconciliation_runs SET broker_snapshot=NULL WHERE id=$1",[first.runId]);
      assert.equal((await f.report()).status,"BLOCKED");
      await f.publish();assert.equal((await f.report()).status,"OWNED_POSITION");
      await f.publish("owned",{failed:true});assert.deepEqual((await f.report()).reasons,["latest_run_unusable"]);
      await f.publish();f.state.session="restart";assert.equal((await f.report()).status,"BLOCKED");
      await f.publish("owned",{session:"restart"});assert.equal((await f.report()).status,"OWNED_POSITION");
      const client=await f.pool.connect();try {await f.reconciliation.publishRunning(client,{accountId,sessionId:"restart",runTimeoutMs:1000});}finally{client.release();}
      assert.deepEqual((await f.report()).reasons,["latest_run_unusable"]);
    }finally{await f.close();}
  });
  it("latest runs and holds are isolated by broker account",async()=>{
    const f=await fixture();try {
      await f.publish();const other=await f.publish("owned",{account:"OTHER",failed:true});
      await f.pool.query(`INSERT INTO reconciliation_holds (account_id,instrument,identity_key,reason,severity,payload,reconciliation_run_id)
        VALUES ('OTHER','TEST','other','position_mismatch','BLOCK','{}',$1)`,[other.runId]);
      assert.equal((await f.report()).status,"OWNED_POSITION");
      f.state.account="OTHER";assert.equal((await f.report()).status,"BLOCKED");
      f.state.account=null;assert.deepEqual((await f.report()).reasons,["current_identity_missing"]);
    }finally{await f.close();}
  });
  for (const missingAccount of [false, true]) {
  it(`production adapter incomplete completed-orders support: ${missingAccount ? "missing account blocks" : "positive ownership survives publication"}`,async()=>{
    const f=await fixture();try {
      const base=(await f.publish()).snapshot;
      const fake = {isConnected:()=>true,getManagedAccounts:async()=>[accountId],
        reqPositionsSnapshot:async()=>({ok:true,endObserved:true,rows:base.positions}),
        reqAllOpenOrdersSnapshot:async()=>({ok:true,endObserved:true,rows:base.openOrders.map(row=>({...row,accountId:missingAccount?undefined:row.accountId}))}),
        reqExecutionsSnapshot:async()=>({ok:true,endObserved:true,rows:base.executions}),
      } as unknown as TwsExecutionClient;
      const client=await f.pool.connect();try {
        const {runId}=await f.reconciliation.publishRunning(client,{accountId,sessionId,runTimeoutMs:1000});
        await new Promise(resolve=>setTimeout(resolve,10));
        const snapshot=await new IbBrokerReconciliationAdapter(fake).capture({accountId,sessionId,sessionStartedAt:f.attempt,
          safetyMarginMs:1,sourceTimeoutMs:100,abortSignal:new AbortController().signal});
        await new Promise(resolve=>setTimeout(resolve,10));
        await f.reconciliation.publishResult(client,{runId,accountId,finalStatus:"INCOMPLETE",snapshot,matches:1,mismatchesCount:0,
          expectedPositionsCount:1,brokerPositionsCount:1,report:{},error:null,holdInserts:[],holdResolves:[]});
      }finally{client.release();}
      const report=await f.report();
      assert.equal(report.status,missingAccount?"BLOCKED":"OWNED_POSITION",JSON.stringify(report));
      assert.deepEqual(report.reasons,missingAccount?["openOrders_account_missing"]:[]);
      const stored=await f.repo.getLifecycleEvidence(f.id,accountId);
      assert.equal(stored?.run?.status,"INCOMPLETE");
    }finally{await f.close();}
  });
  }
  it("raw malformed execution timestamp survives adapter and persistence as unknown and blocks",async()=>{
    const f=await fixture();try {
      const base=(await f.publish()).snapshot;
      const ib = new EventEmitter() as EventEmitter & {connect():void; reqExecutions(id:number):void};
      ib.connect=()=>{queueMicrotask(()=>ib.emit("nextValidId",1));};
      ib.reqExecutions=id=>{
        ib.emit("execDetails",id,{symbol:"TEST",conId:123},{execId:"fill-PARENT",orderId:101,orderRef:"test-PARENT",
          acctNumber:accountId,shares:1,side:"BOT",price:100,time:"20260230 12:00:00 UTC"});
        ib.emit("execDetailsEnd",id);
      };
      const tws=new TwsExecutionClient({host:"unused",port:0,clientId:1,securityType:"STK",exchange:"SMART",currency:"USD",orderTimeoutMs:100},
        ()=>{},undefined,undefined,undefined,{ib});
      await tws.connect();
      tws.getManagedAccounts=async()=>[accountId];
      tws.reqPositionsSnapshot=async()=>({ok:true,endObserved:true,rows:base.positions.map(row=>({accountId:row.accountId,symbol:row.symbol,position:row.position,conId:"123"}))});
      tws.reqAllOpenOrdersSnapshot=async()=>({ok:true,endObserved:true,rows:base.openOrders.map(row=>({
        brokerOrderId:row.brokerOrderId,accountId:accountId,conId:"123",orderRef:row.orderRef!,status:row.status,
        action:row.action!,filled:row.filled!,remaining:row.remaining!,
      }))});
      const client=await f.pool.connect();try {
        const {runId}=await f.reconciliation.publishRunning(client,{accountId,sessionId,runTimeoutMs:1000});
        await new Promise(resolve=>setTimeout(resolve,10));
        const snapshot=await new IbBrokerReconciliationAdapter(tws).capture({accountId,sessionId,sessionStartedAt:f.attempt,
          safetyMarginMs:1,sourceTimeoutMs:100,abortSignal:new AbortController().signal});
        assert.ok(Number.isNaN(snapshot.executions[0].executedAt.getTime()));
        await new Promise(resolve=>setTimeout(resolve,10));
        await f.reconciliation.publishResult(client,{runId,accountId,finalStatus:"INCOMPLETE",snapshot,matches:1,mismatchesCount:0,
          expectedPositionsCount:1,brokerPositionsCount:1,report:{},error:null,holdInserts:[],holdResolves:[]});
      }finally{client.release();}
      assert.deepEqual((await f.report()).reasons,["execution_invalid"]);
      const stored=(await f.repo.getLifecycleEvidence(f.id,accountId))!.run!.broker_snapshot as {executions:{executedAt:unknown}[]};
      assert.equal(stored.executions[0].executedAt,null);
    }finally{await f.close();}
  });
  it("actual broker INACTIVE and PendingCancel updates do not fabricate cancellation",async()=>{
    const f=await fixture();try {
      await f.pool.query("UPDATE proposed_orders SET broker_order_id='101' WHERE id=$1",[f.id]);
      for (const status of ["INACTIVE","PENDINGCANCEL"]) {
        await f.repo.applyBrokerStatusUpdate({brokerOrderId:"101",status,message:"broker event"});
        assert.equal((await f.repo.getProposedOrderById(f.id))?.status,"SUBMITTED");
      }
      await f.repo.applyBrokerStatusUpdate({brokerOrderId:"101",status:"APICANCELLED",message:"confirmed"});
      assert.equal((await f.repo.getProposedOrderById(f.id))?.status,"CANCELLED");
    }finally{await f.close();}
  });

});
