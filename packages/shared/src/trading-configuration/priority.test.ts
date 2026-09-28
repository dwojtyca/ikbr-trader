import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseTradingConfiguration } from "./parser.js";
import { canonicalizeTradingConfiguration, computeTradingConfigurationHash, decodeTradingConfigurationSnapshot } from "./identity.js";
const raw=()=>JSON.parse(readFileSync(new URL("./fixtures/valid-generic.json",import.meta.url),"utf8"));
test("priority assignment normalizes independently of ordering and roundtrips immutable snapshot",()=>{
 const a=raw();a.strategyInstances.push({...a.strategyInstances[0],id:"other",parameters:{dailyReturn20MinPct:9}});
 const id=a.strategyInstances[0].id;a.instruments[0].strategySelection={mode:"priority",instanceIds:[id,"other"],priorities:{[id]:10,other:20}};
 const b=structuredClone(a);b.instruments[0].strategySelection.instanceIds.reverse();b.instruments[0].strategySelection.priorities={other:20,[id]:10};
 const pa=parseTradingConfiguration(a),pb=parseTradingConfiguration(b);assert.ok(pa.ok&&pb.ok);if(!pa.ok||!pb.ok)return;
 assert.equal(computeTradingConfigurationHash(pa.configuration),computeTradingConfigurationHash(pb.configuration));
 assert.equal(canonicalizeTradingConfiguration(decodeTradingConfigurationSnapshot(canonicalizeTradingConfiguration(pa.configuration),computeTradingConfigurationHash(pa.configuration))),canonicalizeTradingConfiguration(pa.configuration));
});
for(const mutation of ["tie","missing","extra","fraction","negative","single_priority"])test(`priority rejects ${mutation}`,()=>{
 const a=raw(),id=a.strategyInstances[0].id;a.strategyInstances.push({...a.strategyInstances[0],id:"other"});
 a.instruments[0].strategySelection={mode:"priority",instanceIds:[id,"other"],priorities:{[id]:10,other:20}};
 const sel=a.instruments[0].strategySelection;
 if(mutation==="tie")sel.priorities.other=10;
 if(mutation==="missing")delete sel.priorities.other;
 if(mutation==="extra")sel.priorities.foreign=30;
 if(mutation==="fraction")sel.priorities.other=1.1;
 if(mutation==="negative")sel.priorities.other=-1;
 if(mutation==="single_priority"){sel.mode="single";sel.instanceIds=[id];}
 assert.equal(parseTradingConfiguration(a).ok,false);
});
test("single-mode canonical bytes retain baseline golden digest",()=>{
 const p=parseTradingConfiguration(raw());assert.ok(p.ok);if(!p.ok)return;
 assert.equal(computeTradingConfigurationHash(p.configuration),"4243bbdbb0f526896474d3f1268ca8209d75d090b7ecf33a109f8e12142fb9ad");
});
