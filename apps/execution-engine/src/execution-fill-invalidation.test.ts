import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import type { BrokerExecutionFill } from "./tws-execution-client.js";
import { shouldInvalidateExecutionFill } from "./execution-fill-invalidation.js";

const fill: BrokerExecutionFill = {execId:"exec-1",orderId:17,accountId:"PAPER",conid:"123",
  symbol:"TEST",side:"BUY",shares:1,price:100,executedAt:"20260923 12:00:00 UTC"};
const known = {exec_id:"exec-1",broker_order_id:"17",account_id:"PAPER",conid:"123",symbol:"TEST",side:"BUY",shares:"1",price:"100"};
function db(rows: unknown[]): Pick<Pool,"query"> {
  return {query:async (sql:string, values:unknown[])=>{
    assert.match(sql,/WHERE exec_id = \$1/);
    assert.deepEqual(values,[fill.execId]);
    return {rows};
  }} as unknown as Pick<Pool,"query">;
}

test("first fill invalidates before persistence; historical identical callback is still persisted without invalidation", async () => {
  let rows: unknown[]=[];
  const events:string[]=[];
  const database = {query:async()=>({rows})} as unknown as Pick<Pool,"query">;
  async function callback() {
    if (await shouldInvalidateExecutionFill(database,fill)) events.push("invalidate");
    events.push("upsert");
    rows=[known];
  }
  await callback();
  await callback();
  assert.deepEqual(events,["invalidate","upsert","upsert"]);
});

test("known exact persisted fill accepts PostgreSQL numeric representation", async () => {
  assert.equal(await shouldInvalidateExecutionFill(db([known]),fill),false);
  assert.equal(await shouldInvalidateExecutionFill(db([{...known,shares:1,price:100,side:"BOT"}]),fill),false);
});

for (const [field,value] of Object.entries({exec_id:"other",broker_order_id:"18",account_id:"OTHER",conid:"124",symbol:"OTHER",side:"SELL",shares:"0.5",price:"101"})) {
  test(`changed persisted ${field} invalidates`,async()=>{
    assert.equal(await shouldInvalidateExecutionFill(db([{...known,[field]:value}]),fill),true);
  });
}
for (const field of Object.keys(known)) {
  for (const value of [null,undefined,""]) {
    test(`missing persisted ${field}: ${String(value)} invalidates`,async()=>{
      assert.equal(await shouldInvalidateExecutionFill(db([{...known,[field]:value}]),fill),true);
    });
  }
}
for (const [field,value] of [
  ["accountId",undefined],["conid",undefined],["orderId",undefined],["symbol",""],["execId",""],
  ["orderId",NaN],["shares",NaN],["shares",Infinity],["shares",0],["shares",-1],["price",NaN],["price",0],["side","unknown"],
] as const) {
  test(`uncertain incoming ${field}=${String(value)} invalidates`,async()=>{
    assert.equal(await shouldInvalidateExecutionFill(db([known]),{...fill,[field]:value} as BrokerExecutionFill),true);
  });
}
for (const value of ["NaN","Infinity"," ","0","-1"]) {
  test(`malformed persisted quantity ${value} invalidates`,async()=>{
    assert.equal(await shouldInvalidateExecutionFill(db([{...known,shares:value}]),fill),true);
  });
}

test("database read error never grants duplicate exemption",async()=>{
  const database={query:async()=>{throw new Error("database unavailable");}} as unknown as Pick<Pool,"query">;
  assert.equal(await shouldInvalidateExecutionFill(database,fill),true);
});
