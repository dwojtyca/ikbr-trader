import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseTradingConfiguration,buildStrategyAttribution,canonicalizeTradingConfiguration } from "@ikbr/shared/trading-config";
import { resolveOriginalStrategy } from "./original-strategy.js";
import type { ExitContext } from "../../strategies/strategy.types.js";
test("original strategy resolves immutable original snapshot after current assignment removal",async()=>{
 const raw=JSON.parse(readFileSync(new URL("../../../../../packages/shared/src/trading-configuration/fixtures/valid-generic.json",import.meta.url),"utf8"));
 const parsed=parseTradingConfiguration(raw);assert.ok(parsed.ok);if(!parsed.ok)return;
 const row=parsed.configuration.instruments[0],attr=buildStrategyAttribution(parsed.configuration,row.id,row.strategySelection.instanceIds[0]);
 raw.strategyInstances=[];raw.instruments=[];
 const original=await resolveOriginalStrategy({query:async()=>({rows:[{canonical_json:canonicalizeTradingConfiguration(parsed.configuration),instance_hash:attr.instanceHash}]})},attr);
 const candle={open:100,high:101,low:99,close:100,volume:100};
 const exit=original.shouldExit!({symbol:row.contract.symbol,secType:"STK",directionalRegime:"bear_trend",volatilityRegime:"normal_volatility",positionQuantity:1,latestCandle:candle,indicators:{ema20:100,ema50:100,ema200:100},candlesByTimeframe:{"1m":[candle,candle]}} as ExitContext);
 assert.equal(exit?.strategyId,attr.implementationId);assert.equal(exit?.side,"SELL");
 await assert.rejects(resolveOriginalStrategy({query:async()=>({rows:[]})},attr),/SNAPSHOT_UNAVAILABLE/);
});
