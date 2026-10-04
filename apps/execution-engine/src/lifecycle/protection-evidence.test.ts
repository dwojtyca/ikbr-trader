import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './close-test-fixture.js';
import {evaluateLifecycleOwnership} from './ownership.js';
import {protectionFailure} from './protection-evidence.js';
function setup(){const f=fixture();f.snapshot.openOrders.forEach((r,i)=>Object.assign(r,{orderType:i===0?'LMT':'STP',limitPrice:102,stopPrice:99,totalQuantity:1,parentId:'100',ocaGroup:'owned',ocaType:2,tif:'DAY'}));return f;}
test('exact bracket shape is independently observed',()=>{const f=setup();assert.equal(protectionFailure(f.evidence,evaluateLifecycleOwnership(f.evidence,f.context)),null);});
for(const patch of [{orderType:'MKT'},{totalQuantity:2},{parentId:'999'},{ocaGroup:''},{ocaType:1},{limitPrice:103},{tif:'GTC'},{remaining:.5}])test(`incorrect protective shape blocks: ${JSON.stringify(patch)}`,()=>{const f=setup();Object.assign(f.snapshot.openOrders[0],patch);assert.notEqual(protectionFailure(f.evidence,evaluateLifecycleOwnership(f.evidence,f.context)),null);});
test('missing child and mismatched OCA cannot appear protected',()=>{const f=setup();Object.assign(f.snapshot.openOrders[1],{ocaGroup:'other'});assert.notEqual(protectionFailure(f.evidence,evaluateLifecycleOwnership(f.evidence,f.context)),null);f.snapshot.openOrders.pop();assert.notEqual(protectionFailure(f.evidence,evaluateLifecycleOwnership(f.evidence,f.context)),null);});
