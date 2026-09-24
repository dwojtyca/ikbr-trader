import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpwWindow, isPkoIdentity } from './gpw-window.js';
const config={GPW_RUN_ID:'test',GPW_RUN_ACCOUNT:'PAPER',GPW_RUN_START:'2026-09-24T10:00:00Z',GPW_RUN_END:'2026-09-24T10:30:00Z'};
test('window is absent by default and explicit valid Warsaw window is immutable',()=>{
 assert.equal(parseGpwWindow({}),undefined);
 assert.equal(parseGpwWindow(config)!.tradeDate,'2026-09-24');
 assert.ok(Object.isFrozen(parseGpwWindow(config)));
});
for(const [name,patch] of Object.entries({partial:{GPW_RUN_END:''},invalidCalendar:{GPW_RUN_START:"2026-02-30T10:00:00Z",GPW_RUN_END:"2026-02-30T10:30:00Z"},fractionalCutoff:{GPW_RUN_START:"2026-09-24T14:30:00Z",GPW_RUN_END:"2026-09-24T14:45:00.001Z"},tooLong:{GPW_RUN_END:'2026-09-24T11:01:00Z'},inverted:{GPW_RUN_END:'2026-09-24T09:59:00Z'},bare:{GPW_RUN_START:'2026-09-24T10:00:00'},weekend:{GPW_RUN_START:'2026-09-26T10:00:00Z',GPW_RUN_END:'2026-09-26T10:30:00Z'},early:{GPW_RUN_START:'2026-09-24T06:59:00Z',GPW_RUN_END:'2026-09-24T07:30:00Z'},late:{GPW_RUN_START:'2026-09-24T14:30:00Z',GPW_RUN_END:'2026-09-24T14:46:00Z'}})) test(`window refuses ${name}`,()=>assert.throws(()=>parseGpwWindow({...config,...patch})));
test('all known PKO identities select the budget',()=>{
 for(const order of [{instrument:'PKO'},{instrumentId:'pko_wse'},{conid:'35146360'}]) assert.ok(isPkoIdentity(order));
 assert.equal(isPkoIdentity({instrument:'AAPL',conid:'123'}),false);
});
