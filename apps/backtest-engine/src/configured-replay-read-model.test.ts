import test from "node:test";
import assert from "node:assert/strict";
import { BacktestRepository } from "./repository.js";
const attribution = {version:1,implementationId:"momentum_breakout_long_v1",instanceId:"removed_instance",instanceRevision:3,instrumentId:"aapl_smart",instanceHash:"a".repeat(64),effectiveConfigHash:"b".repeat(64)};
test("persisted run metadata exposes original attribution and legacy absence", async()=>{
  const repo = new BacktestRepository("postgresql://fixture:fixture@localhost/pp2_read_model_fixture");
  const row = {id:1,dataset_id:2,mode:"isolated",status:"completed",started_at:new Date(0),config_json:{strategyAttribution:attribution}};
  (repo as unknown as {pool:{query:()=>Promise<unknown>}}).pool.query=async()=>({rows:[row,{...row,id:2,config_json:{}}]});
  const runs=await repo.listRuns();
  assert.deepEqual(runs[0].strategyAttribution,attribution);
  assert.equal(runs[1].strategyAttribution,undefined);
  row.config_json.strategyAttribution.instanceRevision=0;
  await assert.rejects(repo.listRuns(),/STRATEGY_ATTRIBUTION_INVALID/);
});
