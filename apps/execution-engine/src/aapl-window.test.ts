import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAaplWindow, isAaplIdentity } from './aapl-window.js';
const config={AAPL_RUN_ID:'test',AAPL_RUN_ACCOUNT:'PAPER',AAPL_RUN_START:'2026-09-24T14:00:00Z',AAPL_RUN_END:'2026-09-24T14:30:00Z'};
test('window is absent by default and explicit valid New York window is immutable',()=>{
 assert.equal(parseAaplWindow({}),undefined);
 assert.equal(parseAaplWindow(config)!.tradeDate,'2026-09-24');
 assert.ok(Object.isFrozen(parseAaplWindow(config)));
});
for(const [name,patch] of Object.entries({partial:{AAPL_RUN_END:''},invalidCalendar:{AAPL_RUN_START:"2026-02-30T14:00:00Z",AAPL_RUN_END:"2026-02-30T14:30:00Z"},fractionalCutoff:{AAPL_RUN_START:"2026-09-24T19:30:00Z",AAPL_RUN_END:"2026-09-24T19:45:00.001Z"},tooLong:{AAPL_RUN_END:'2026-09-24T15:01:00Z'},inverted:{AAPL_RUN_END:'2026-09-24T13:59:00Z'},bare:{AAPL_RUN_START:'2026-09-24T14:00:00'},weekend:{AAPL_RUN_START:'2026-09-26T14:00:00Z',AAPL_RUN_END:'2026-09-26T14:30:00Z'},early:{AAPL_RUN_START:'2026-09-24T13:34:00Z',AAPL_RUN_END:'2026-09-24T14:00:00Z'},late:{AAPL_RUN_START:'2026-09-24T19:30:00Z',AAPL_RUN_END:'2026-09-24T19:46:00Z'}})) test(`window refuses ${name}`,()=>assert.throws(()=>parseAaplWindow({...config,...patch})));
test('all known AAPL identities select the budget',()=>{
 for(const order of [{instrument:'AAPL'},{instrumentId:'aapl_nasdaq'},{conid:'265598'}]) assert.ok(isAaplIdentity(order));
 assert.equal(isAaplIdentity({instrument:'OTHER',conid:'123'}),false);
});

test('New York daylight saving offsets and exact session bounds',()=>{
 for (const [start,end] of [['2026-09-24T13:35:00Z','2026-09-24T14:35:00Z'],['2026-09-24T19:00:00Z','2026-09-24T19:45:00Z'],['2026-01-22T14:35:00Z','2026-01-22T15:00:00Z']])
  assert.ok(parseAaplWindow({...config,AAPL_RUN_START:start,AAPL_RUN_END:end}));
 for (const [start,end] of [['2026-01-22T13:35:00Z','2026-01-22T14:00:00Z'],['2026-09-24T19:30:00Z','2026-09-25T13:35:00Z']])
  assert.throws(()=>parseAaplWindow({...config,AAPL_RUN_START:start,AAPL_RUN_END:end}));
});
