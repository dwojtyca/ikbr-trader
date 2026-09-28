import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { SignalTicket } from "./index.js";
import { parseTradingConfiguration } from "./trading-configuration/parser.js";
import { buildStrategyAttribution, resolveStrategyAttributionSnapshot } from "./trading-configuration/attribution.js";
import { canonicaliseSignalTicket, computeClientOrderHash } from "./client-order-hash.js";
import { parseStrategyAttribution, parseStrategyTrigger } from "./strategy-attribution.js";

const parsed = parseTradingConfiguration(readFileSync(new URL("./trading-configuration/fixtures/valid-generic.json", import.meta.url), "utf8"));
if (!parsed.ok) throw new Error("fixture invalid");
const config = parsed.configuration;
const legacy: SignalTicket = { instrument:"QZXP",instrumentId:"xyz_nyse",conid:"987654",side:"BUY",orderType:"LMT",quantity:1,
  entry:100,stop:99,takeProfit:105,reason:"test",confidence:1,timestamp:"2026-09-28T12:00:00.000Z",riskCheckStatus:"PASS" };
const trigger = parseStrategyTrigger({version:1,source:"evaluation_bucket",timeframe:"1m",observedAt:legacy.timestamp,bucketStartMs:Date.parse(legacy.timestamp)});
const attribution = buildStrategyAttribution(config,"xyz_nyse","momentum_custom");

test("v1 canonical bytes/digest stay identical; v2 binds every attribution and trigger field",()=>{
  const golden="v1|instrument=QZXP|conid=987654|side=BUY|positionEffect=|orderType=LMT|quantity=1|entry=100|stop=99|takeProfit=105|trailingStopPct=|trailingStopActivationR=|partialTakeProfits=|riskCheckStatus=PASS";
  assert.equal(canonicaliseSignalTicket(legacy),golden);
  assert.equal(computeClientOrderHash(legacy),createHash("sha256").update(golden).digest("hex"));
  const ticket={...legacy,strategyAttribution:attribution,strategyTrigger:trigger,clientOrderHashVersion:2 as const};
  const hash=computeClientOrderHash(ticket);assert.notEqual(hash,computeClientOrderHash(legacy));
  for(const [key,value] of Object.entries({instanceId:"changed",instanceRevision:3,instanceHash:"b".repeat(64),effectiveConfigHash:"c".repeat(64)}))
    assert.notEqual(computeClientOrderHash({...ticket,strategyAttribution:{...attribution,[key]:value}}),hash,key);
  for(const key of Object.keys(attribution)) assert.throws(()=>{
    const value={...attribution} as Record<string,unknown>;delete value[key];computeClientOrderHash({...ticket,strategyAttribution:value as never});
  });
  assert.throws(()=>computeClientOrderHash({...ticket,strategyAttribution:undefined}));
  assert.throws(()=>computeClientOrderHash({...ticket,strategyTrigger:undefined}));
  assert.throws(()=>computeClientOrderHash({...legacy,clientOrderHashVersion:2}));
  assert.throws(()=>computeClientOrderHash({...ticket,clientOrderHashVersion:1}));
  assert.notEqual(computeClientOrderHash({...ticket,strategyTrigger:{...trigger,observedAt:"2026-09-28T12:00:01.000Z"}}),hash);
});

test("malformed identities and bucket evidence fail closed",()=>{
  for(const patch of [{version:2},{instanceRevision:0},{instanceId:"a:b"},{effectiveConfigHash:"A".repeat(64)},{unexpected:true}])
    assert.throws(()=>parseStrategyAttribution({...attribution,...patch}));
  for(const patch of [{source:"candle_close"},{timeframe:"5m"},{bucketStartMs:trigger.bucketStartMs+1},{observedAt:"2026-09-28T12:00:00Z"},{version:2}])
    assert.throws(()=>parseStrategyTrigger({...trigger,...patch}));
  assert.throws(()=>parseStrategyAttribution(Object.create(attribution)));
});

test("snapshot resolver requires original assignment and immutable content, never a current fallback",()=>{
  const resolved=resolveStrategyAttributionSnapshot(config,attribution,{requireEnabled:false});
  assert.equal(resolved.instance.parameters.dailyReturn20MinPct,12);
  assert.equal(resolved.executionPolicy.protection,"bracket");
  assert.throws(()=>resolveStrategyAttributionSnapshot(config,{...attribution,instanceId:"momentum_default"}),/ASSIGNMENT/);
  const changed={...config,strategyInstances:config.strategyInstances.map((instance,index)=>index===1?{...instance,enabled:false}:instance)};
  assert.throws(()=>resolveStrategyAttributionSnapshot(changed,attribution,{requireEnabled:false}),/CONFIGURATION/);
  assert.equal(resolveStrategyAttributionSnapshot(config,attribution,{requireEnabled:false}).instance.parameters.dailyReturn20MinPct,12);
});
